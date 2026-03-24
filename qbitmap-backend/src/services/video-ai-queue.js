/**
 * Video AI Analysis Queue (DB-backed)
 * Persistent queue — survives backend restarts
 */

const db = require('./database');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'video-ai-queue' });
const { getVllmUrl, getVllmApiKey, getModelName, getBackendUrl } = require('../utils/ai-config');
const circuitBreaker = require('./ai-circuit-breaker');

const TIMEOUT = 180000; // 180s for video analysis
const MAX_CONCURRENCY = 2;
const POLL_INTERVAL = 3000; // Check DB every 3s for new jobs

const PROMPT = 'Bu videoyu analiz et ve Turkce olarak 300-350 karakter arasinda bir icerik aciklamasi yaz. Videodaki onemli gorsel ogeleri, olaylari, ortami ve dikkate deger detaylari acikla. Sadece aciklama metnini yaz, baska bir sey ekleme ve Videoda görünmeyen bir şeyi varsayma.';

let activeCount = 0;
let pollTimer = null;
let onComplete = null; // callback for WebSocket notification

function setOnComplete(cb) { onComplete = cb; }

async function enqueue(messageId, fileName) {
  await db.createAiJob(messageId, 'video');
  logger.info({ messageId }, 'Video enqueued for AI analysis (DB)');
  pollOnce();
}

async function pollOnce() {
  if (activeCount >= MAX_CONCURRENCY) return;
  if (!circuitBreaker.canRequest()) return;

  try {
    const slots = MAX_CONCURRENCY - activeCount;
    const jobs = await db.claimAiJobs('video', slots);

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
    await analyzeVideo(job.message_id);
    await db.completeAiJob(job.message_id);
    circuitBreaker.onSuccess();
    if (onComplete) onComplete(job.message_id, 'video');
  } catch (err) {
    logger.error({ messageId: job.message_id, err: err.message, retries: job.retries }, 'Video AI analysis failed');
    circuitBreaker.onFailure(err.message);
    await db.failAiJob(job.message_id, err.message);
  }
  activeCount--;
  pollOnce();
}

async function analyzeVideo(messageId) {
  const vllmUrl = await getVllmUrl();
  const model = await getModelName();
  const apiKey = await getVllmApiKey();
  const backendUrl = await getBackendUrl();

  const videoUrl = `${backendUrl.replace(/\/$/, '')}/api/video-messages/${messageId}/video`;

  logger.info({ messageId, model, videoUrl }, 'Starting video AI analysis (HTTP URL)');

  // Max video duration is 30s, 2 fps = 60 frames
  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'video_url', video_url: { url: videoUrl } }
      ]
    }],
    max_tokens: 256,
    mm_processor_kwargs: { num_frames: 60, fps: 2 }
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

  await db.updateVideoMessageAiDescription(messageId, text.substring(0, 400));
  logger.info({ messageId, len: text.length }, 'AI description saved');
}

function start() {
  db.recoverStuckAiJobs(5).then(count => {
    if (count > 0) logger.info({ recovered: count }, 'Recovered stuck AI jobs');
  }).catch(() => {});

  pollTimer = setInterval(pollOnce, POLL_INTERVAL);
  logger.info({ pollInterval: POLL_INTERVAL, maxConcurrency: MAX_CONCURRENCY }, 'Video AI queue started (DB-backed)');
  pollOnce();
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function getStats() {
  const counts = await db.getPendingAiJobCount();
  const video = counts.find(c => c.job_type === 'video');
  return { pending: video?.cnt || 0, activeCount };
}

module.exports = { enqueue, start, stop, getStats, setOnComplete };
