/**
 * Photo AI Analysis Queue (DB-backed)
 * Persistent queue — survives backend restarts
 */

const db = require('./database');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'photo-ai-queue' });
const { getVllmUrl, getVllmApiKey, getModelName, getBackendUrl } = require('../utils/ai-config');
const circuitBreaker = require('./ai-circuit-breaker');

const TIMEOUT = 60000; // 60s for photo analysis
const MAX_CONCURRENCY = 3;
const POLL_INTERVAL = 3000; // Check DB every 3s for new jobs

const PROMPT = 'You are analyzing a single image.\n\nYour task is to generate one fluent, user-facing paragraph in Turkish only. This paragraph will be displayed directly under the image in an app, and it will also be used as searchable semantic metadata. The goal is to help a person quickly understand the image and to make the image discoverable through text search later.\n\nFocus only on clearly visible, reliable, and visually verifiable details. Prefer concrete and discriminative details over generic wording. Include the most important visible elements such as the type of scene, main objects or products, people if present, readable brand names, labels, prices, packaging, visible text/OCR, spatial arrangement, colors, materials, store or environment clues, and any distinctive details that make this image different from similar images.\n\nMention only things you are visually confident about. Do not hallucinate, speculate, or infer unsupported identity, location, intent, backstory, or hidden context. If a detail is unclear, leave it out instead of guessing.\n\nWrite the result as a single natural paragraph of 300 to 350 tokens. Do not use headings, bullet points, labels, JSON, or list formatting. Do not write like a technical AI report. The final response must read like a polished image description for end users, while still being rich enough for indexing and retrieval.\n\nOutput language must be Turkish only. Do not use English in the final answer.';

let activeCount = 0;
let pollTimer = null;
let onComplete = null; // callback for WebSocket notification

function setOnComplete(cb) { onComplete = cb; }

async function enqueue(messageId, fileName) {
  await db.createAiJob(messageId, 'photo');
  logger.info({ messageId }, 'Photo enqueued for AI analysis (DB)');
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
  try {
    await analyzePhoto(job.message_id);
    await db.completeAiJob(job.message_id);
    circuitBreaker.onSuccess();
    if (onComplete) onComplete(job.message_id, 'photo');
  } catch (err) {
    logger.error({ messageId: job.message_id, err: err.message, retries: job.retries }, 'Photo AI analysis failed');
    circuitBreaker.onFailure(err.message);
    await db.failAiJob(job.message_id, err.message);
  }
  activeCount--;
  // Check for more work
  pollOnce();
}

async function analyzePhoto(messageId) {
  const vllmUrl = await getVllmUrl();
  const model = await getModelName();
  const apiKey = await getVllmApiKey();
  const backendUrl = await getBackendUrl();

  const imageUrl = `${backendUrl.replace(/\/$/, '')}/api/video-messages/${messageId}/video`;

  logger.info({ messageId, model, imageUrl }, 'Starting photo AI analysis');

  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: imageUrl } }
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
  logger.info({ messageId, response: JSON.stringify(data).substring(0, 500) }, 'vLLM raw response');

  let text = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new Error('Empty AI description');

  await db.updateVideoMessageAiDescription(messageId, text.substring(0, 1000));
  logger.info({ messageId, len: text.length }, 'Photo AI description saved');
}

function start() {
  // Recover stuck jobs from previous crash
  db.recoverStuckAiJobs(5).then(count => {
    if (count > 0) logger.info({ recovered: count }, 'Recovered stuck AI jobs');
  }).catch(() => {});

  // Start polling
  pollTimer = setInterval(pollOnce, POLL_INTERVAL);
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
