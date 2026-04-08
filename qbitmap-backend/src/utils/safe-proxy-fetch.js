/**
 * SSRF-hardened proxy fetch helper.
 *
 * - Resolves the hostname ourselves (DNS rebinding protection): the IP we
 *   validate is the same IP we connect to. We pass the resolved IP literal
 *   to fetch and forward the original Host header so TLS/SNI/vhost still work
 *   for plain HTTP upstreams.
 * - Rejects any resolved address that is private/loopback/link-local.
 * - Per-upstream-host token bucket rate limit.
 */

const dns = require('dns').promises;
const net = require('net');
const { fetchWithTimeout } = require('./fetch-timeout');
const { isBlockedIP } = require('../services/mediamtx');

// Per-host rate limiter: max N requests per WINDOW_MS per hostname.
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 60;
const buckets = new Map(); // hostname -> { count, windowStart }

function checkRateLimit(hostname) {
  const now = Date.now();
  let b = buckets.get(hostname);
  if (!b || now - b.windowStart > WINDOW_MS) {
    b = { count: 0, windowStart: now };
    buckets.set(hostname, b);
  }
  b.count += 1;
  return b.count <= MAX_PER_WINDOW;
}

// Periodic cleanup so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [host, b] of buckets) {
    if (now - b.windowStart > WINDOW_MS * 2) buckets.delete(host);
  }
}, 60_000).unref();

class SafeProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolve and validate a target URL, then fetch it with the IP literal
 * substituted for the hostname (DNS-rebinding-safe).
 */
async function safeProxyFetch(targetUrl, options = {}, timeoutMs = 10000) {
  const url = new URL(targetUrl);
  const hostname = url.hostname;

  if (!checkRateLimit(hostname)) {
    throw new SafeProxyError(429, 'Upstream rate limit exceeded');
  }

  // Resolve hostname ourselves so the IP we validate == the IP we connect to.
  let resolvedIp;
  if (net.isIP(hostname)) {
    resolvedIp = hostname;
  } else {
    let addrs;
    try {
      addrs = await dns.lookup(hostname, { all: true });
    } catch (e) {
      throw new SafeProxyError(502, 'DNS resolution failed');
    }
    // Reject if ANY resolved address is private (defense in depth).
    for (const a of addrs) {
      if (isBlockedIP(a.address)) {
        throw new SafeProxyError(403, 'Resolved address is private/internal');
      }
    }
    resolvedIp = addrs[0].address;
  }

  if (isBlockedIP(resolvedIp)) {
    throw new SafeProxyError(403, 'Resolved address is private/internal');
  }

  // Build a new URL with the IP literal in place of the hostname.
  // IPv6 needs bracket form in URLs.
  const ipHost = net.isIPv6(resolvedIp) ? `[${resolvedIp}]` : resolvedIp;
  const ipUrl = new URL(url.toString());
  ipUrl.hostname = ipHost;

  // Forward original Host header so vhost-based upstreams still work.
  const headers = { ...(options.headers || {}) };
  headers['Host'] = url.port ? `${hostname}:${url.port}` : hostname;

  return fetchWithTimeout(ipUrl.toString(), { ...options, headers }, timeoutMs);
}

module.exports = { safeProxyFetch, SafeProxyError };
