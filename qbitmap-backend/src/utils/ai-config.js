/**
 * Shared AI service configuration
 * Eliminates duplicate getVllmUrl/getModelName across ai.js, photo-ai-queue.js, video-ai-queue.js
 *
 * [PERF-02] Module-level cache + in-flight coalescing.
 *
 * Every AI job used to call getVllmUrl / getModelName / getVllmApiKey /
 * getBackendUrl sequentially, each one hitting `SELECT value FROM
 * system_settings WHERE key = ?`. Under the 3+2 photo/video concurrency
 * budget that's up to 20 settings queries per second during a backlog,
 * plus WS broadcasts and other queries competing for the same pool.
 *
 * Now: a single miss fires all four SELECTs in parallel (Promise.all),
 * stores the derived values for 60s, and coalesces concurrent misses
 * behind one in-flight Promise so bursts still only produce one DB
 * round-trip. Admin settings updates invalidate the cache explicitly
 * via clearAiConfigCache() wired into routes/admin.js.
 */

const db = require('../services/database');
const { services } = require('../config');

const CACHE_TTL_MS = 60_000;

let _cache = null;
let _cachedAt = 0;
let _inflight = null;

function buildConfig({ serviceUrl, apiKey, model, backendUrl }) {
  // [ARCH-09] AI service URL from config.js (was hardcoded IP fallback).
  const baseUrl = serviceUrl || services.aiServiceUrl;
  return {
    vllmUrl: `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`,
    apiKey: apiKey || process.env.AI_SERVICE_API_KEY || '',
    model: model || 'Qwen/Qwen3-VL-8B-Instruct-FP8',
    backendUrl: backendUrl || process.env.BACKEND_PUBLIC_URL || 'https://stream.qbitmap.com'
  };
}

async function loadFromDb() {
  const [serviceUrl, apiKey, model, backendUrl] = await Promise.all([
    db.getSystemSetting('ai_service_url'),
    db.getSystemSetting('ai_service_api_key'),
    db.getSystemSetting('ai_vision_model'),
    db.getSystemSetting('backend_public_url')
  ]);
  return buildConfig({ serviceUrl, apiKey, model, backendUrl });
}

/**
 * Get the full AI config object. Prefer this over the individual helpers
 * when a caller needs more than one field — you save N-1 cache lookups
 * and keep the four values consistent with one another.
 *
 * Shape: { vllmUrl, apiKey, model, backendUrl }
 */
async function getAiConfig() {
  if (_cache && Date.now() - _cachedAt < CACHE_TTL_MS) {
    return _cache;
  }
  // Coalesce concurrent misses — without this, a burst of 20 AI jobs after
  // cache expiry would each fire their own Promise.all.
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const cfg = await loadFromDb();
      _cache = cfg;
      _cachedAt = Date.now();
      return cfg;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/**
 * Drop the cached config. Called from routes/admin.js after a settings
 * update so an admin editing ai_service_url / ai_vision_model / etc.
 * doesn't have to wait out the 60s TTL for the change to take effect.
 */
function clearAiConfigCache() {
  _cache = null;
  _cachedAt = 0;
  // Intentionally not cancelling _inflight — if a fetch is in flight it
  // observed the pre-write state and the next call will reload cleanly.
}

// ---- Thin backward-compatible wrappers ----------------------------------
// Existing callers (routes/ai.js, services/ai-translate.js, health-checker)
// keep working untouched; each now resolves through the cached bundle.

async function getVllmUrl()    { return (await getAiConfig()).vllmUrl; }
async function getVllmApiKey() { return (await getAiConfig()).apiKey; }
async function getModelName()  { return (await getAiConfig()).model; }
async function getBackendUrl() { return (await getAiConfig()).backendUrl; }

module.exports = {
  getAiConfig,
  clearAiConfigCache,
  getVllmUrl,
  getVllmApiKey,
  getModelName,
  getBackendUrl
};
