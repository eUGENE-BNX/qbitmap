/**
 * Video AI Analysis Queue
 * Processes video messages sequentially through vLLM for content description
 */

const db = require('./database');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'video-ai-queue' });
const { getVllmUrl, getVllmApiKey, getModelName, getBackendUrl } = require('../utils/ai-config');

const MAX_RETRIES = 2;
const TIMEOUT = 180000; // 180s for video analysis
const MAX_QUEUE_SIZE = 100;
const MAX_CONCURRENCY = 2; // Process up to 2 videos in parallel (video is heavier than photo)

const queue = [];
let activeCount = 0;

const PROMPT = 'Bu videoyu analiz et ve Turkce olarak 300-350 karakter arasinda bir icerik aciklamasi yaz. Videodaki onemli gorsel ogeleri, olaylari, ortami ve dikkate deger detaylari acikla. Sadece aciklama metnini yaz, baska bir sey ekleme ve Videoda görünmeyen bir şeyi varsayma.';

function enqueue(messageId, fileName) {
  if (queue.length >= MAX_QUEUE_SIZE) {
    logger.warn({ messageId, queueLength: queue.length }, 'Queue full, dropping item');
    return false;
  }
  queue.push({ messageId, fileName, retries: 0 });
  logger.info({ messageId, queueLength: queue.length }, 'Video enqueued for AI analysis');
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
    await analyzeVideo(item);
  } catch (err) {
    logger.error({ messageId: item.messageId, err: err.message, retries: item.retries }, 'Video AI analysis failed');
    if (item.retries < MAX_RETRIES && queue.length < MAX_QUEUE_SIZE) {
      item.retries++;
      // Exponential backoff: 10s, 20s (longer for video since vLLM may be overloaded)
      const delay = 10000 * item.retries;
      logger.info({ messageId: item.messageId, retry: item.retries, delayMs: delay }, 'Re-queued for retry with backoff');
      setTimeout(() => { queue.push(item); drainQueue(); }, delay);
      activeCount--;
      return;
    }
  }
  activeCount--;
  drainQueue();
}

async function analyzeVideo({ messageId, fileName }) {
  const vllmUrl = await getVllmUrl();
  const model = await getModelName();
  const apiKey = await getVllmApiKey();
  const backendUrl = await getBackendUrl();

  // Build public HTTP URL for the video file - vLLM will fetch it directly
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

function getStats() {
  return { queueLength: queue.length, activeCount, processing: activeCount > 0 };
}

module.exports = { enqueue, getStats };
