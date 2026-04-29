/**
 * MediaMTX (RTCGateway) Service
 * Handles RTSP to WebRTC stream conversion via MediaMTX API
 */

const crypto = require('crypto');
const dns = require('dns').promises;
const logger = require('../utils/logger').child({ module: 'mediamtx' });
const { services } = require('../config');

const MEDIAMTX_API = services.mediamtxApi;
const MEDIAMTX_WHEP_BASE = services.mediamtxWhepBase;
const MEDIAMTX_HLS_BASE = services.mediamtxHlsBase;

// Private/reserved IP ranges for SSRF protection
const BLOCKED_IP_PATTERNS = [
  /^127\./,                              // Loopback (127.0.0.0/8)
  /^10\./,                               // Private Class A (10.0.0.0/8)
  /^192\.168\./,                         // Private Class C (192.168.0.0/16)
  /^172\.(1[6-9]|2[0-9]|3[01])\./,       // Private Class B (172.16.0.0/12)
  /^169\.254\./,                         // Link-local (169.254.0.0/16)
  /^0\./,                                // Current network
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // Shared address space (100.64.0.0/10)
  /^192\.0\.0\./,                        // IETF Protocol Assignments
  /^192\.0\.2\./,                        // TEST-NET-1
  /^198\.51\.100\./,                     // TEST-NET-2
  /^203\.0\.113\./,                      // TEST-NET-3
  /^224\./,                              // Multicast
  /^240\./,                              // Reserved
  /^255\./,                              // Broadcast
];

/**
 * Check if an IP address is private/reserved (SSRF protection)
 * @param {string} ip - IP address or hostname to check
 * @returns {boolean} True if IP is blocked (private/reserved)
 */
function isBlockedIP(ip) {
  // Block localhost variations
  if (ip === 'localhost' || ip === '::1') {
    return true;
  }

  // Check against blocked patterns
  return BLOCKED_IP_PATTERNS.some(pattern => pattern.test(ip));
}

/**
 * [SB-5] Check if a hostname resolves to a blocked IP (DNS rebinding protection)
 * Resolves the hostname first, then checks the resolved IP against blocked patterns.
 * @param {string} host - Hostname or IP to check
 * @returns {Promise<boolean>} True if host resolves to a blocked IP
 */
async function isBlockedHost(host) {
  // Direct IP check first
  if (isBlockedIP(host)) return true;

  // If it looks like a domain name, resolve it and check the IP
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    try {
      const { address } = await dns.lookup(host);
      if (isBlockedIP(address)) {
        logger.warn({ host, resolvedIP: address }, 'DNS rebinding blocked: domain resolves to private IP');
        return true;
      }
    } catch {
      // DNS resolution failed - block by default for safety
      logger.warn({ host }, 'DNS resolution failed, blocking host');
      return true;
    }
  }

  return false;
}

/**
 * Wrap a single MediaMTX HTTP call with retries on transient failures.
 * Retries network errors (timeout, ECONNREFUSED) and 5xx responses with
 * exponential backoff (1s, 5s, 10s). Does NOT retry 4xx — those are
 * client errors and would just fail again with the same payload. The
 * 10s per-request timeout is preserved on every attempt.
 */
async function _retryFetch(url, init, { attempts = 3, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, init);
      // 5xx — server temporarily unwell, retry. 4xx — client error,
      // hand back to caller (idempotent "already exists" handling
      // happens upstream).
      if (response.status >= 500 && response.status < 600 && i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(5, i); // 1s, 5s
        logger.warn({ url, status: response.status, attempt: i + 1, delay }, 'MediaMTX 5xx, retrying');
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return response;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(5, i);
        logger.warn({ url, err: err.message, attempt: i + 1, delay }, 'MediaMTX fetch failed, retrying');
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('All retries failed');
}

/**
 * Add a new path (camera stream) to MediaMTX
 * @param {string} pathName - Unique path name for the stream
 * @param {string} rtspUrl - Full RTSP URL with credentials
 * @param {object} options - Additional options
 * @returns {Promise<{success: boolean, error?: string, warning?: string}>}
 */
async function addPath(pathName, rtspUrl, options = {}) {
  try {
    const config = {
      source: rtspUrl,
      sourceProtocol: 'tcp',
      sourceOnDemand: true,
      sourceOnDemandStartTimeout: '10s',
      sourceOnDemandCloseAfter: '60s',
      // Recording options (disabled by default, can be enabled via API)
      record: false,
      recordPath: '/recordings/%path/%Y-%m-%d_%H-%M-%S-%f',
      recordFormat: 'fmp4',
      recordPartDuration: '1s',
      recordSegmentDuration: '1h',
      recordDeleteAfter: '360h',
      ...options
    };

    const response = await _retryFetch(`${MEDIAMTX_API}/v3/config/paths/add/${pathName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const errorText = await response.text();

      // Idempotent: a concurrent add or a leftover path is a success
      // case — the caller wanted the path to exist, and it does.
      if (response.status === 400 && errorText.includes('already exists')) {
        logger.info({ pathName }, 'MediaMTX path already exists (idempotent add)');
        return { success: true, warning: 'Path already exists' };
      }

      logger.error({ pathName, status: response.status, error: errorText }, 'Failed to add path to MediaMTX');
      return { success: false, error: `MediaMTX error: ${response.status}` };
    }

    logger.info({ pathName }, 'Path added to MediaMTX successfully');
    return { success: true };

  } catch (error) {
    logger.error({ err: error, pathName }, 'MediaMTX addPath error');
    return { success: false, error: error.message };
  }
}

/**
 * Add an RTMP path (for publish-based cameras like GoPro, OBS)
 * No source URL needed - the device will publish to this path
 * @param {string} pathName - Unique path name for the stream
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function addRtmpPath(pathName, options = {}) {
  try {
    const config = {
      // No source - this is a publish endpoint
      record: false,
      recordPath: '/recordings/%path/%Y-%m-%d_%H-%M-%S-%f',
      recordFormat: 'fmp4',
      recordPartDuration: '1s',
      recordSegmentDuration: '1h',
      recordDeleteAfter: '360h',
      ...options
    };

    const response = await _retryFetch(`${MEDIAMTX_API}/v3/config/paths/add/${pathName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const errorText = await response.text();

      if (response.status === 400 && errorText.includes('already exists')) {
        logger.info({ pathName }, 'MediaMTX RTMP path already exists (idempotent add)');
        return { success: true, warning: 'Path already exists' };
      }

      logger.error({ pathName, status: response.status, error: errorText }, 'Failed to add RTMP path to MediaMTX');
      return { success: false, error: `MediaMTX error: ${response.status}` };
    }

    logger.info({ pathName }, 'RTMP path added to MediaMTX successfully');
    return { success: true };

  } catch (error) {
    logger.error({ err: error, pathName }, 'MediaMTX addRtmpPath error');
    return { success: false, error: error.message };
  }
}

/**
 * Validate and sanitize an HLS URL for safe use in FFmpeg commands.
 * Prevents command injection via shell metacharacters.
 * @param {string} url - HLS URL to validate
 * @returns {string} Validated URL
 * @throws {Error} If URL is invalid or contains dangerous characters
 */
function validateHlsUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('HLS URL is required');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL must use HTTP or HTTPS protocol');
  }

  if (isBlockedIP(parsed.hostname)) {
    throw new Error('Blocked IP address');
  }

  // Reject shell metacharacters that could escape FFmpeg's -i argument
  if (/[`$\\;|&'"!\n\r]/.test(url)) {
    throw new Error('URL contains invalid characters');
  }

  return url;
}

/**
 * Add an HLS path (for city cameras and external HLS streams)
 * @param {string} pathName - Unique path name for the stream
 * @param {string} hlsUrl - Full HLS URL (e.g., https://example.com/stream.m3u8)
 * @param {object} options - Additional options
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function addHlsPath(pathName, hlsUrl, options = {}) {
  try {
    // [SB-1] Validate HLS URL to prevent command injection
    const safeUrl = validateHlsUrl(hlsUrl);

    // Transcode mode: re-encode to reduce bandwidth (~10Mbit → ~2Mbit)
    // Set CITY_CAM_TRANSCODE=false to revert to codec copy mode
    const transcode = process.env.CITY_CAM_TRANSCODE !== 'false';

    const videoParams = transcode
      ? `-map 0:v:0 -c:v libx264 -preset ultrafast -tune zerolatency ` +
        `-b:v 2M -maxrate 2.5M -bufsize 5M ` +
        `-vf "scale=-2:720" -g 30 -keyint_min 30`
      : `-map 0:v:0 -c:v copy -bsf:v dump_extra`;

    const ffmpegCmd = `ffmpeg -hide_banner -loglevel warning ` +
      `-reconnect 1 -reconnect_streamed 1 -reconnect_at_eof 1 -reconnect_delay_max 2 ` +
      `-rw_timeout 15000000 ` +
      `-re ` +
      `-i "${safeUrl}" ` +
      `${videoParams} ` +
      `-an -vsync passthrough ` +
      `-f rtsp -rtsp_transport tcp ` +
      `rtsp://127.0.0.1:8554/${pathName}`;

    const config = {
      // No source - FFmpeg will publish via runOnDemand (starts when viewer connects)
      runOnDemand: ffmpegCmd,
      runOnDemandRestart: true,  // Auto-restart FFmpeg on crash
      runOnDemandStartTimeout: '30s',  // Wait up to 30s for FFmpeg to start
      runOnDemandCloseAfter: '30s',    // Stop FFmpeg 30s after last viewer leaves
      // Recording disabled for city cameras
      record: false,
      recordPath: '/recordings/%path/%Y-%m-%d_%H-%M-%S-%f',
      recordFormat: 'fmp4',
      recordPartDuration: '1s',
      recordSegmentDuration: '1h',
      recordDeleteAfter: '360h',
      ...options
    };

    const response = await _retryFetch(`${MEDIAMTX_API}/v3/config/paths/add/${pathName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const errorText = await response.text();

      if (response.status === 400 && errorText.includes('already exists')) {
        logger.info({ pathName }, 'MediaMTX HLS path already exists (idempotent add)');
        return { success: true, warning: 'Path already exists' };
      }

      logger.error({ pathName, status: response.status, error: errorText }, 'Failed to add HLS path to MediaMTX');
      return { success: false, error: `MediaMTX error: ${response.status}` };
    }

    logger.info({ pathName, hlsUrl }, 'HLS path added to MediaMTX successfully');
    return { success: true };

  } catch (error) {
    logger.error({ err: error, pathName }, 'MediaMTX addHlsPath error');
    return { success: false, error: error.message };
  }
}

/**
 * Remove a path from MediaMTX
 * @param {string} pathName - Path name to remove
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function removePath(pathName) {
  try {
    const response = await fetch(`${MEDIAMTX_API}/v3/config/paths/delete/${pathName}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      // 404 means path doesn't exist, which is fine for cleanup
      if (response.status === 404) {
        logger.warn({ pathName }, 'Path not found in MediaMTX (already deleted?)');
        return { success: true, warning: 'Path not found' };
      }

      const errorText = await response.text();
      logger.error({ pathName, status: response.status, error: errorText }, 'Failed to remove path from MediaMTX');
      return { success: false, error: `MediaMTX error: ${response.status}` };
    }

    logger.info({ pathName }, 'Path removed from MediaMTX successfully');
    return { success: true };

  } catch (error) {
    logger.error({ err: error, pathName }, 'MediaMTX removePath error');
    return { success: false, error: error.message };
  }
}

/**
 * Check if a path exists in MediaMTX
 * @param {string} pathName - Path name to check
 * @returns {Promise<{exists: boolean, error?: string}>}
 */
async function pathExists(pathName) {
  try {
    const response = await fetch(`${MEDIAMTX_API}/v3/config/paths/get/${pathName}`, {
      signal: AbortSignal.timeout(10000)
    });

    if (response.status === 404) {
      return { exists: false };
    }

    if (!response.ok) {
      return { exists: false, error: `MediaMTX error: ${response.status}` };
    }

    return { exists: true };

  } catch (error) {
    logger.error({ err: error, pathName }, 'MediaMTX pathExists error');
    return { exists: false, error: error.message };
  }
}

/**
 * Get WHEP URL for a path
 * @param {string} pathName - Path name
 * @returns {string} WHEP URL
 */
function getWhepUrl(pathName) {
  return `${MEDIAMTX_WHEP_BASE}/${pathName}/whep`;
}

/**
 * Get HLS URL for a path (fMP4 streaming via Caddy)
 * @param {string} pathName - Path name
 * @returns {string} HLS URL
 */
function getHlsUrl(pathName) {
  return `${MEDIAMTX_HLS_BASE}/${pathName}/index.m3u8`;
}

/**
 * Get WHIP URL for a path (for browser WebRTC publish)
 * @param {string} pathName - Path name
 * @returns {string} WHIP URL
 */
function getWhipUrl(pathName) {
  return `${MEDIAMTX_WHEP_BASE}/${pathName}/whip`;
}

/**
 * Generate a unique path name for a camera (cryptographically secure)
 * @param {number} userId - User ID
 * @returns {string} Unique path name
 */
function generatePathName(userId) {
  const timestamp = Date.now().toString(36);
  const randomBytes = crypto.randomBytes(8).toString('hex');
  return `cam_${userId}_${timestamp}_${randomBytes}`;
}

/**
 * Generate a unique path name for a live broadcast
 * @param {number} userId - User ID
 * @returns {string} Unique broadcast path name
 */
function generateBroadcastPathName(userId) {
  const timestamp = Date.now().toString(36);
  const randomBytes = crypto.randomBytes(4).toString('hex');
  return `live_${userId}_${timestamp}_${randomBytes}`;
}

/**
 * Parse RTSP URL to extract components (with SSRF protection)
 * [SB-5] Now async - uses DNS resolution to block rebinding attacks
 * @param {string} rtspUrl - RTSP URL
 * @param {object} options - Options
 * @param {boolean} options.allowPrivateIPs - Allow private IPs (default: false)
 * @returns {Promise<{host: string, port: number, username: string, password: string, path: string} | null>}
 */
async function parseRtspUrl(rtspUrl, options = {}) {
  const { allowPrivateIPs = false } = options;

  try {
    if (!rtspUrl || !rtspUrl.startsWith('rtsp://')) {
      return null;
    }

    const withoutProtocol = rtspUrl.replace('rtsp://', '');
    const atIndex = withoutProtocol.indexOf('@');

    let credentials = { username: '', password: '' };
    let hostPart;

    if (atIndex !== -1) {
      const credPart = withoutProtocol.substring(0, atIndex);
      hostPart = withoutProtocol.substring(atIndex + 1);

      const colonIndex = credPart.indexOf(':');
      if (colonIndex !== -1) {
        credentials.username = credPart.substring(0, colonIndex);
        credentials.password = credPart.substring(colonIndex + 1);
      } else {
        credentials.username = credPart;
      }
    } else {
      hostPart = withoutProtocol;
    }

    // Extract host, port, and path
    const pathStart = hostPart.indexOf('/');
    const hostPortPart = pathStart !== -1 ? hostPart.substring(0, pathStart) : hostPart;
    const path = pathStart !== -1 ? hostPart.substring(pathStart) : '/';

    const portIndex = hostPortPart.lastIndexOf(':');
    let host, port;

    if (portIndex !== -1) {
      host = hostPortPart.substring(0, portIndex);
      port = parseInt(hostPortPart.substring(portIndex + 1), 10) || 554;
    } else {
      host = hostPortPart;
      port = 554;
    }

    // [SB-5] SSRF Protection: Block private/reserved IPs including DNS rebinding
    if (!allowPrivateIPs && await isBlockedHost(host)) {
      logger.warn({ host, rtspUrl: sanitizeRtspUrl(rtspUrl) }, 'SSRF attempt blocked: private/reserved IP address or DNS rebinding');
      return null;
    }

    return {
      host,
      port,
      username: credentials.username,
      password: credentials.password,
      path
    };

  } catch (error) {
    logger.error({ err: error }, 'Failed to parse RTSP URL');
    return null;
  }
}

/**
 * Sanitize RTSP URL for logging (mask credentials)
 * @param {string} rtspUrl - RTSP URL
 * @returns {string} Sanitized URL
 */
function sanitizeRtspUrl(rtspUrl) {
  if (!rtspUrl) return '[empty]';
  try {
    // Mask credentials in URL for safe logging
    return rtspUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://***:***@');
  } catch {
    return '[invalid URL]';
  }
}

/**
 * Get MediaMTX server health status
 * @returns {Promise<{healthy: boolean, error?: string}>}
 */
async function healthCheck() {
  try {
    const response = await fetch(`${MEDIAMTX_API}/v3/paths/list`, {
      signal: AbortSignal.timeout(5000)
    });

    return { healthy: response.ok };
  } catch (error) {
    return { healthy: false, error: error.message };
  }
}

module.exports = {
  addPath,
  addRtmpPath,
  addHlsPath,
  removePath,
  pathExists,
  getWhepUrl,
  getWhipUrl,
  getHlsUrl,
  generatePathName,
  generateBroadcastPathName,
  parseRtspUrl,
  sanitizeRtspUrl,
  validateHlsUrl,
  isBlockedIP,
  healthCheck,
  MEDIAMTX_API,
  MEDIAMTX_WHEP_BASE,
  MEDIAMTX_HLS_BASE
};
