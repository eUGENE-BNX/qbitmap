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

const PROMPT = 'Bu fotografi analiz et ve Turkce olarak 300-350 karakter arasinda bir icerik aciklamasi yaz. Fotograftaki onemli gorsel ogeleri, ortami ve dikkate deger detaylari acikla. Sadece aciklama metnini yaz, baska bir sey ekleme ve Fotografta gorunmeyen bir seyi varsayma.';

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
    max_tokens: 256
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
