/**
 * [ARCH-11] Central API client for all backend requests.
 *
 * Every fetch to the QBitmap backend should go through this module instead
 * of raw `fetch()`. Benefits:
 *   - credentials:'include' is always set (prevents silent 401 on auth
 *     endpoints where the caller forgot to add it)
 *   - Consistent timeout (default 30s, configurable per-call)
 *   - Single place to add future cross-cutting concerns (retry, auth
 *     refresh, request ID header, logging)
 *   - Smaller call sites: `api.post(url, body)` vs 5 lines of fetch options
 *
 * Usage:
 *   import { api } from '../services/api-client.js';
 *   const data = await api.get('/api/public/cameras');
 *   const result = await api.post('/api/ai/analyze', { prompt, images });
 *   const resp = await api.put(`/api/users/me/cameras/${id}`, body);
 *   await api.del(`/api/admin/messages/${id}`);
 *
 * For full Response access (headers, status):
 *   const resp = await api.fetch('/api/status/health');
 *   if (!resp.ok) throw new Error(resp.status);
 *   const data = await resp.json();
 */

import { QBitmapConfig } from '../config.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Core fetch wrapper. Adds credentials, timeout, and optional JSON body.
 * Returns the raw Response — callers can .json() / .text() / check .ok.
 *
 * @param {string} url — absolute URL or path relative to api.base
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {*}      [opts.body] — auto-JSON.stringify'd if object
 * @param {object} [opts.headers] — merged with defaults
 * @param {number} [opts.timeout] — ms, default 30s
 * @returns {Promise<Response>}
 */
async function apiFetch(url, opts = {}) {
  const { method = 'GET', body, headers = {}, timeout = DEFAULT_TIMEOUT_MS, ...rest } = opts;

  // Resolve relative paths against the API base
  const fullUrl = url.startsWith('http') ? url : `${QBitmapConfig.api.base}${url}`;

  const fetchOpts = {
    method,
    credentials: 'include',
    ...rest,
  };

  // Auto-set Content-Type + stringify for object bodies
  if (body !== undefined) {
    if (typeof body === 'object' && !(body instanceof FormData) && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
      fetchOpts.body = JSON.stringify(body);
      fetchOpts.headers = { 'Content-Type': 'application/json', ...headers };
    } else {
      fetchOpts.body = body;
      fetchOpts.headers = { ...headers };
    }
  } else if (Object.keys(headers).length > 0) {
    fetchOpts.headers = headers;
  }

  // Timeout via AbortController
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  fetchOpts.signal = controller.signal;

  try {
    return await fetch(fullUrl, fetchOpts);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convenience helpers that auto-parse JSON responses.
 * Throw on non-ok status with the structured error message.
 */
async function parseOrThrow(resp) {
  const data = await resp.json();
  if (!resp.ok) {
    const msg = data?.error?.message || data?.error || `HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

const api = {
  /** Raw fetch with credentials + timeout. Returns Response. */
  fetch: apiFetch,

  /** GET + auto-parse JSON. Throws on non-ok. */
  async get(url, opts) {
    return parseOrThrow(await apiFetch(url, { ...opts, method: 'GET' }));
  },

  /** POST + auto-parse JSON. Throws on non-ok. */
  async post(url, body, opts) {
    return parseOrThrow(await apiFetch(url, { ...opts, method: 'POST', body }));
  },

  /** PUT + auto-parse JSON. Throws on non-ok. */
  async put(url, body, opts) {
    return parseOrThrow(await apiFetch(url, { ...opts, method: 'PUT', body }));
  },

  /** PATCH + auto-parse JSON. Throws on non-ok. */
  async patch(url, body, opts) {
    return parseOrThrow(await apiFetch(url, { ...opts, method: 'PATCH', body }));
  },

  /** DELETE + auto-parse JSON. Throws on non-ok. */
  async del(url, opts) {
    return parseOrThrow(await apiFetch(url, { ...opts, method: 'DELETE' }));
  },
};

export { api };
