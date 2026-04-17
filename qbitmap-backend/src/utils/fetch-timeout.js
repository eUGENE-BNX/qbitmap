/**
 * Fetch with timeout using AbortController
 * Prevents hanging requests to external APIs.
 *
 * Also propagates the current request's X-Request-Id to downstream services
 * (H3, Tesla proxy, MediaMTX, AI queues) so a single correlation id threads
 * through the whole fan-out. If the caller already set an X-Request-Id in
 * options.headers, that wins.
 */

const { getRequestId } = require('./logger');

const DEFAULT_TIMEOUT = 10000; // 10 seconds

function hasHeaderCI(headers, name) {
  if (!headers) return false;
  const lower = name.toLowerCase();
  if (typeof headers[Symbol.iterator] === 'function' && typeof headers.has === 'function') {
    // Headers / Map-like
    return headers.has(name);
  }
  if (Array.isArray(headers)) {
    return headers.some(([k]) => String(k).toLowerCase() === lower);
  }
  return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

/**
 * Fetch with automatic timeout
 * @param {string} url - URL to fetch
 * @param {object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds (default: 10000)
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let finalOptions = options;
  const reqId = getRequestId();
  if (reqId && !hasHeaderCI(options.headers, 'x-request-id')) {
    finalOptions = {
      ...options,
      headers: { ...(options.headers || {}), 'X-Request-Id': reqId }
    };
  }

  try {
    const response = await fetch(url, {
      ...finalOptions,
      signal: controller.signal
    });
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchWithTimeout, DEFAULT_TIMEOUT };
