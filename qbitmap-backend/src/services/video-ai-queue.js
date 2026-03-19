/**
 * Video AI Analysis Queue
 * Processes video messages sequentially through vLLM for content description
 */

const db = require('./database');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'video-ai-queue' });
const { getVllmUrl, getModelName, getBackendUrl } = require('../utils/ai-config');

const MAX_RETRIES = 2;
const TIMEOUT = 180000; // 180s for video analysis
const MAX_QUEUE_SIZE = 100;

const queue = [];
let processing = false;

const PROMPT = 'Bu videoyu analiz et ve Turkce olarak 300-350 karakter arasinda bir icerik aciklamasi yaz. Videodaki onemli gorsel ogeleri, olaylari, ortami ve dikkate deger detaylari acikla. Sadece aciklama metnini yaz, baska bir sey ekleme ve Videoda görünmeyen bir şeyi varsayma.';

function enqueue(messageId, fileName) {
  if (queue.length >= MAX_QUEUE_SIZE) {
    logger.warn({ messageId, queueLength: queue.length }, 'Queue full, dropping item');
    return false;
  }
  queue.push({ messageId, fileName, retries: 0 });
  logger.info({ messageId, queueLength: queue.length }, 'Video enqueued for AI analysis');
  if (!processing) processNext();
}

async function processNext() {
  if (queue.length === 0) {
    processing = false;
    return;
  }

  processing = true;
  const item = queue.shift();

  try {
    await analyzeVideo(item);
  } catch (err) {
    logger.error({ messageId: item.messageId, err: err.message, retries: item.retries }, 'Video AI analysis failed');
    if (item.retries < MAX_RETRIES) {
      item.retries++;
      queue.push(item);
      logger.info({ messageId: item.messageId, retry: item.retries }, 'Re-queued for retry');
    }
  }

  setImmediate(processNext);
}

async function analyzeVideo({ messageId, fileName }) {
  const vllmUrl = await getVllmUrl();
  const model = await getModelName();
  const backendUrl = await getBackendUrl();

  // Build public HTTP URL for the video file - vLLM will fetch it directly
  const videoUrl = `${backendUrl.replace(/\/$/, '')}/api/video-messages/${messageId}/video`;

  logger.info({ messageId, model, videoUrl }, 'Starting video AI analysis (HTTP URL)');

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
    mm_processor_kwargs: { fps: 2 }
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
  logger.info({ messageId, len: text.length }, 'AI description saved');
}

function getStats() {
  return { queueLength: queue.length, processing };
}

module.exports = { enqueue, getStats };
