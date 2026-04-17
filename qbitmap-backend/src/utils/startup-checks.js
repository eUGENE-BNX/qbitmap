/**
 * Non-blocking upstream reachability probes fired once at boot.
 *
 * requireEnv / requireEnvWithDevFallback in config.js already crash the
 * process if an env var is missing, and db.ensureReady() implicitly proves
 * MySQL is up by running migrations. Gap this module fills: H3 and MediaMTX
 * live on separate hosts — a misconfigured hostname or a dead upstream used
 * to surface only at the first user request. Now we log a warning line at
 * startup so the on-call sees the problem before traffic hits.
 *
 * Intentionally non-blocking: a slow or temporarily-down H3 should not
 * delay HTTP listen. Callers do NOT await runStartupChecks(); probes fire-
 * and-forget. Failures warn, they never exit.
 */
const { fetchWithTimeout } = require('./fetch-timeout');
const { services } = require('../config');
const logger = require('./logger').child({ module: 'startup-checks' });

const PROBE_TIMEOUT_MS = 3000;

async function probe(name, url) {
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' }, PROBE_TIMEOUT_MS);
    if (res.ok) {
      logger.info({ name, url, status: res.status }, 'upstream reachable');
    } else {
      logger.warn({ name, url, status: res.status }, 'upstream reachable but returned non-2xx');
    }
  } catch (err) {
    logger.warn({ name, url, err: err.message }, 'upstream unreachable (non-blocking)');
  }
}

function runStartupChecks() {
  const probes = [];

  if (process.env.H3_SERVICE_URL) {
    probes.push(probe('h3-service', `${process.env.H3_SERVICE_URL}/health`));
  } else {
    logger.info('H3_SERVICE_URL not set, skipping probe');
  }

  if (services.mediamtxApi) {
    // /v3/config/global/get is MediaMTX's stable config-read endpoint — any
    // 2xx here confirms the control API is up. Using /v3/paths/list also
    // works but returns a potentially large body.
    probes.push(probe('mediamtx', `${services.mediamtxApi}/v3/config/global/get`));
  }

  // Fire and forget: callers don't await, startup continues immediately.
  Promise.allSettled(probes).catch(() => { /* probe() already swallowed */ });
}

module.exports = { runStartupChecks };
