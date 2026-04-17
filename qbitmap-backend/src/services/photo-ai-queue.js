/**
 * Photo AI Analysis Queue (DB-backed)
 * Persistent queue — survives backend restarts
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const db = require('./database');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'photo-ai-queue' });
const { getVllmUrl, getVllmApiKey, getModelName } = require('../utils/ai-config');
const { resolveLanguageForCoords } = require('../utils/geo-language');
const circuitBreaker = require('./ai-circuit-breaker').photo;

const FFMPEG_PATH = '/usr/bin/ffmpeg';
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads/video-messages');
// Bound box for AI input: keep aspect, no crop, never upscale.
// Reduces token count so vLLM context limit (16384) isn't exceeded.
const AI_MAX_W = 1920;
const AI_MAX_H = 1080;

function downscaleForAi(srcPath) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `ai_${path.basename(srcPath)}.jpg`);
    const args = [
      '-i', srcPath,
      '-vf', `scale='min(${AI_MAX_W},iw)':'min(${AI_MAX_H},ih)':force_original_aspect_ratio=decrease`,
      '-q:v', '3',
      '-y',
      outPath
    ];
    execFile(FFMPEG_PATH, args, { timeout: 15000 }, (err) => {
      if (err) return reject(err);
      resolve(outPath);
    });
  });
}

const TIMEOUT = 60000; // 60s for photo analysis
const MAX_CONCURRENCY = 3;
const POLL_INTERVAL = 3000; // Check DB every 3s for new jobs

function buildPrompt(languageName) {
  return `You are analyzing a single image.\n\nYour task is to generate one fluent, user-facing paragraph in ${languageName} only. This paragraph will be displayed directly under the image in an app, and it will also be used as searchable semantic metadata. The goal is to help a person quickly understand the image and to make the image discoverable through text search later.\n\nFocus only on clearly visible, reliable, and visually verifiable details. Prefer concrete and discriminative details over generic wording. Include the most important visible elements such as the type of scene, main objects or products, people if present, readable brand names, labels, prices, packaging, visible text/OCR, spatial arrangement, colors, materials, store or environment clues, and any distinctive details that make this image different from similar images.\n\nMention only things you are visually confident about. Do not hallucinate, speculate, or infer unsupported identity, location, intent, backstory, or hidden context. If a detail is unclear, leave it out instead of guessing.\n\nWrite the result as a single natural paragraph of 300 to 350 tokens. Do not use headings, bullet points, labels, JSON, or list formatting. Do not write like a technical AI report. The final response must read like a polished image description for end users, while still being rich enough for indexing and retrieval.\n\nOutput language must be ${languageName} only. Do not use any other language in the final answer.`;
}

let activeCount = 0;
let pollTimer = null;
let onComplete = null; // callback for WebSocket notification

function setOnComplete(cb) { onComplete = cb; }

async function enqueue(messageId, fileName, photoIdx = 0) {
  await db.createAiJob(messageId, 'photo', photoIdx);
  logger.info({ messageId, photoIdx }, 'Photo enqueued for AI analysis (DB)');
  // Trigger immediate poll
  pollOnce();
}

async function pollOnce() {
  if (activeCount >= MAX_CONCURRENCY) return;
  if (!circuitBreaker.canRequest()) return;

  try {
    const slots = MAX_CONCURRENCY - activeCount;
    const jobs = await db.claimAiJobs('photo', slots);

    for (const job of jobs) {
      activeCount++;
      processJob(job);
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Poll error');
  }
}

async function processJob(job) {
  const subId = job.sub_id || 0;
  try {
    await analyzePhoto(job.message_id, subId);
    await db.completeAiJob(job.message_id, subId);
    circuitBreaker.onSuccess();
    if (onComplete) onComplete(job.message_id, 'photo', subId);
  } catch (err) {
    logger.error({ messageId: job.message_id, photoIdx: subId, err: err.message, retries: job.retries }, 'Photo AI analysis failed');
    circuitBreaker.onFailure(err.message);
    await db.failAiJob(job.message_id, subId, err.message);
  }
  activeCount--;
  // Check for more work
  pollOnce();
}

async function analyzePhoto(messageId, photoIdx = 0) {
  const vllmUrl = await getVllmUrl();
  const model = await getModelName();
  const apiKey = await getVllmApiKey();

  // Resolve message + per-photo file path
  const msg = await db.getVideoMessageById(messageId);
  if (!msg) throw new Error('Message not found');
  const photo = (msg.photos || []).find(p => p.idx === photoIdx);
  const filePath = photo?.file_path || (photoIdx === 0 ? msg.file_path : null);
  if (!filePath) throw new Error(`Photo idx ${photoIdx} not found for message ${messageId}`);

  const lang = await resolveLanguageForCoords(Number(msg.lat), Number(msg.lng));
  const PROMPT = buildPrompt(lang.name);
  const srcPath = path.resolve(__dirname, '../../', filePath);
  if (!srcPath.startsWith(UPLOADS_DIR + path.sep)) throw new Error('Invalid file path');
  if (!fs.existsSync(srcPath)) throw new Error(`Source image missing: ${srcPath}`);

  let resizedPath = null;
  let imageDataUrl;
  try {
    resizedPath = await downscaleForAi(srcPath);
    const buf = await fs.promises.readFile(resizedPath);
    imageDataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
    logger.info({ messageId, photoIdx, model, srcSize: (await fs.promises.stat(srcPath)).size, resizedSize: buf.length }, 'Starting photo AI analysis');
  } finally {
    if (resizedPath) fs.promises.unlink(resizedPath).catch(() => {});
  }

  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ]
    }],
    max_tokens: 512
  };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const resp = await fetchWithTimeout(vllmUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  }, TIMEOUT);

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => 'Unknown error');
    throw new Error(`vLLM ${resp.status}: ${errorText}`);
  }

  const data = await resp.json();
  logger.info({ messageId, photoIdx, response: JSON.stringify(data).substring(0, 500) }, 'vLLM raw response');

  let text = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new Error('Empty AI description');

  await db.updateVideoMessagePhotoAiDescription(messageId, photoIdx, text.substring(0, 1000), lang.code);
  logger.info({ messageId, photoIdx, len: text.length, lang: lang.code }, 'Photo AI description saved');
}

function start() {
  // Recover stuck jobs from previous crash
  db.recoverStuckAiJobs(5).then(count => {
    if (count > 0) logger.info({ recovered: count }, 'Recovered stuck AI jobs');
  }).catch(() => {});

  // Start polling. .unref() so the 3s poll tick can't block SIGTERM —
  // stop() still clearInterval's it explicitly, this is belt-and-suspenders.
  pollTimer = setInterval(pollOnce, POLL_INTERVAL);
  pollTimer.unref();
  logger.info({ pollInterval: POLL_INTERVAL, maxConcurrency: MAX_CONCURRENCY }, 'Photo AI queue started (DB-backed)');
  // Initial poll
  pollOnce();
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function getStats() {
  const counts = await db.getPendingAiJobCount();
  const photo = counts.find(c => c.job_type === 'photo');
  return { pending: photo?.cnt || 0, activeCount };
}

module.exports = { enqueue, start, stop, getStats, setOnComplete };
