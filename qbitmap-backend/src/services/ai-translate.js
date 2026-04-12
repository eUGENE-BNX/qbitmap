/**
 * On-demand text translation via the same vLLM model used for image/video AI.
 * Used by GET /api/video-messages/:id/description?lang=XX to translate the
 * cached ai_description without re-running vision inference.
 */

const { fetchWithTimeout } = require('../utils/fetch-timeout');
const { getVllmUrl, getVllmApiKey, getModelName } = require('../utils/ai-config');
const { languageDisplayName } = require('../utils/geo-language');
const circuitBreaker = require('./ai-circuit-breaker').translate;
const logger = require('../utils/logger').child({ module: 'ai-translate' });

const TIMEOUT = 30000;

async function translateText(text, sourceLang, targetLang) {
  if (!circuitBreaker.canRequest()) {
    throw new Error('AI service unavailable (circuit open)');
  }

  const vllmUrl = await getVllmUrl();
  const model = await getModelName();
  const apiKey = await getVllmApiKey();

  const sourceName = languageDisplayName(sourceLang);
  const targetName = languageDisplayName(targetLang);

  const prompt = `Translate the following user-facing image/video description from ${sourceName} to ${targetName}. Preserve meaning, tone and any factual details. Output only the translation as a single fluent paragraph, with no preface, no quotes, no labels, no notes.\n\n---\n${text}`;

  const body = {
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    max_tokens: 600,
    temperature: 0.3
  };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let resp;
  try {
    resp = await fetchWithTimeout(vllmUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }, TIMEOUT);
  } catch (err) {
    circuitBreaker.onFailure(err.message);
    throw err;
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    circuitBreaker.onFailure(`vLLM ${resp.status}`);
    throw new Error(`vLLM ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const data = await resp.json();
  circuitBreaker.onSuccess();

  let out = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Strip surrounding quotes if model wrapped output
  out = out.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!out) throw new Error('Empty translation');

  logger.info({ sourceLang, targetLang, srcLen: text.length, outLen: out.length }, 'Translation done');
  return out.substring(0, 1200);
}

module.exports = { translateText };
