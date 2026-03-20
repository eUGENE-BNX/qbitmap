/**
 * Photo AI Analysis Queue
 * Processes photo messages sequentially through vLLM for content description
 */

const db = require('./database');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'photo-ai-queue' });
const { getVllmUrl, getModelName, getBackendUrl } = require('../utils/ai-config');

const MAX_RETRIES = 2;
const TIMEOUT = 60000; // 60s for photo analysis
const MAX_QUEUE_SIZE = 100;
const MAX_CONCURRENCY = 3; // Process up to 3 photos in parallel

const queue = [];
let activeCount = 0;

const PROMPT = 'Bu fotografi analiz et ve Turkce olarak 300-350 karakter arasinda bir icerik aciklamasi yaz. Fotograftaki onemli gorsel ogeleri, ortami ve dikkate deger detaylari acikla. Sadece aciklama metnini yaz, baska bir sey ekleme ve Fotografta gorunmeyen bir seyi varsayma.';

function enqueue(messageId, fileName) {
  if (queue.length >= MAX_QUEUE_SIZE) {
    logger.warn({ messageId, queueLength: queue.length }, 'Queue full, dropping item');
    return false;
  }
  queue.push({ messageId, fileName, retries: 0 });
  logger.info({ messageId, queueLength: queue.length }, 'Photo enqueued for AI analysis');
  drainQueue();
}

function drainQueue() {
  while (queue.length > 0 && activeCount < MAX_CONCURRENCY) {
    const item = queue.shift();
    activeCount++;
    processItem(item);
  }
}

async function processItem(item) {
  try {
    await analyzePhoto(item);
  } catch (err) {
    logger.error({ messageId: item.messageId, err: err.message, retries: item.retries }, 'Photo AI analysis failed');
    if (item.retries < MAX_RETRIES && queue.length < MAX_QUEUE_SIZE) {
      item.retries++;
      // Exponential backoff: 5s, 10s
      const delay = 5000 * item.retries;
      logger.info({ messageId: item.messageId, retry: item.retries, delayMs: delay }, 'Re-queued for retry with backoff');
      setTimeout(() => { queue.push(item); drainQueue(); }, delay);
      activeCount--;
      return;
    }
  }
  activeCount--;
  drainQueue();
}

async function analyzePhoto({ messageId, fileName }) {
  const vllmUrl = await getVllmUrl();
  const model = await getModelName();
  const backendUrl = await getBackendUrl();

  // Use the same /video endpoint which serves any media file by mime_type
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

  const resp = await fetchWithTimeout(vllmUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

function getStats() {
  return { queueLength: queue.length, activeCount, processing: activeCount > 0 };
}

module.exports = { enqueue, getStats };
