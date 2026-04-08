const { spawn } = require('child_process');
const config = require('./config');
const frameStore = require('./frame-store');

const MAX_CONCURRENT_CAPTURES = 50;

// Reject loopback, RFC1918, link-local, CGNAT, multicast, broadcast.
// rtsp-capture runs in the cloud and must never be tricked into probing
// internal services or co-located infrastructure (SSRF guard).
function isPrivateOrReservedHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  // Strip IPv6 brackets if present
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  // IPv4 dotted-quad?
  const m = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // loopback
    if (a === 169 && b === 254) return true;         // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true;                       // multicast/reserved
    if (a === 0) return true;                        // 0.0.0.0/8
    return false;
  }
  // IPv6 — block loopback, link-local (fe80::/10), ULA (fc00::/7)
  if (bare.includes(':')) {
    if (bare === '::1') return true;
    if (bare.startsWith('fe8') || bare.startsWith('fe9') || bare.startsWith('fea') || bare.startsWith('feb')) return true;
    if (bare.startsWith('fc') || bare.startsWith('fd')) return true;
    return false;
  }
  // Hostname (DNS) — allow; resolution happens in ffmpeg. Could still
  // resolve to a private IP, but DNS rebinding is out of scope here.
  return false;
}

function parseRtspUrl(rtspUrl) {
  if (!rtspUrl || typeof rtspUrl !== 'string' || rtspUrl.length > 500) {
    throw new Error('Invalid RTSP URL format');
  }
  let parsed;
  try {
    parsed = new URL(rtspUrl);
  } catch {
    throw new Error('Invalid RTSP URL format');
  }
  if (parsed.protocol !== 'rtsp:') {
    throw new Error('Invalid RTSP URL format: protocol must be rtsp');
  }
  if (!parsed.hostname) {
    throw new Error('Invalid RTSP URL format: missing host');
  }
  return parsed;
}

// SSRF guard for caller-provided URLs. Default rtspBase (loopback MediaMTX)
// is exempt because it is server-controlled, not user input.
function assertPublicRtspUrl(rtspUrl) {
  const parsed = parseRtspUrl(rtspUrl);
  if (isPrivateOrReservedHost(parsed.hostname)) {
    throw new Error('Invalid RTSP URL: private/reserved host not allowed');
  }
}

class CaptureManager {
  constructor() {
    // Map<streamId, { rtspUrl, interval, timer, capturing }>
    this.captures = new Map();
  }

  /**
   * Start capturing frames from an RTSP stream
   */
  start(streamId, rtspUrl, interval = config.capture.defaultInterval) {
    // Always parse + protocol/host check (server-controlled default ok)
    parseRtspUrl(rtspUrl);

    // Enforce concurrent capture limit
    if (!this.captures.has(streamId) && this.captures.size >= MAX_CONCURRENT_CAPTURES) {
      throw new Error(`Maximum concurrent captures (${MAX_CONCURRENT_CAPTURES}) reached`);
    }

    // Validate interval
    interval = Math.max(config.capture.minInterval, Math.min(config.capture.maxInterval, interval));

    if (this.captures.has(streamId)) {
      // Already capturing, update interval if different
      const existing = this.captures.get(streamId);
      if (existing.interval !== interval) {
        this.setInterval(streamId, interval);
      }
      return { status: 'already_running', streamId, interval: existing.interval };
    }

    const capture = {
      rtspUrl,
      interval,
      timer: null,
      capturing: false,
      lastCapture: null,
      frameCount: 0,
      errors: 0
    };

    this.captures.set(streamId, capture);

    console.log(`[CAPTURE] Starting capture for ${streamId} at ${interval}ms interval`);

    // Capture first frame immediately
    this.captureFrame(streamId);

    // Set up interval timer
    capture.timer = setInterval(() => {
      this.captureFrame(streamId);
    }, interval);

    return { status: 'started', streamId, interval };
  }

  /**
   * Capture a single frame using ffmpeg
   */
  captureFrame(streamId) {
    const capture = this.captures.get(streamId);
    if (!capture) return;

    // Skip if already capturing (previous capture still running)
    if (capture.capturing) {
      console.log(`[CAPTURE] Skipping ${streamId} - previous capture still running`);
      return;
    }

    capture.capturing = true;

    const chunks = [];

    const ffmpeg = spawn('ffmpeg', [
      '-rtsp_transport', 'tcp',
      '-i', capture.rtspUrl,
      '-frames:v', '1',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '2',  // Quality (2 = high quality)
      '-'
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    ffmpeg.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });

    ffmpeg.stderr.on('data', (data) => {
      // ffmpeg outputs progress to stderr, ignore unless error
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        console.error(`[CAPTURE] ffmpeg error for ${streamId}: ${msg.substring(0, 100)}`);
      }
    });

    ffmpeg.on('close', (code) => {
      capture.capturing = false;

      if (code === 0 && chunks.length > 0) {
        const buffer = Buffer.concat(chunks);
        frameStore.set(streamId, buffer);
        capture.lastCapture = new Date();
        capture.frameCount++;
        console.log(`[CAPTURE] Frame captured for ${streamId} (${buffer.length} bytes)`);
      } else {
        capture.errors++;
        console.error(`[CAPTURE] Failed to capture frame for ${streamId} (exit code: ${code})`);
      }
    });

    ffmpeg.on('error', (err) => {
      capture.capturing = false;
      capture.errors++;
      console.error(`[CAPTURE] ffmpeg spawn error for ${streamId}:`, err.message);
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      if (capture.capturing) {
        ffmpeg.kill('SIGKILL');
        capture.capturing = false;
        console.error(`[CAPTURE] Timeout for ${streamId}`);
      }
    }, 10000);
  }

  /**
   * Stop capturing for a stream
   */
  stop(streamId) {
    const capture = this.captures.get(streamId);
    if (!capture) {
      return { status: 'not_found', streamId };
    }

    // Clear timer
    if (capture.timer) {
      clearInterval(capture.timer);
    }

    // Remove from captures
    this.captures.delete(streamId);

    // Remove stored frame
    frameStore.remove(streamId);

    console.log(`[CAPTURE] Stopped capture for ${streamId}`);

    return { status: 'stopped', streamId };
  }

  /**
   * Update capture interval
   */
  setInterval(streamId, newInterval) {
    const capture = this.captures.get(streamId);
    if (!capture) {
      return { status: 'not_found', streamId };
    }

    // Validate interval
    newInterval = Math.max(config.capture.minInterval, Math.min(config.capture.maxInterval, newInterval));

    // Clear old timer
    if (capture.timer) {
      clearInterval(capture.timer);
    }

    // Update interval
    capture.interval = newInterval;

    // Set new timer
    capture.timer = setInterval(() => {
      this.captureFrame(streamId);
    }, newInterval);

    console.log(`[CAPTURE] Updated interval for ${streamId} to ${newInterval}ms`);

    return { status: 'updated', streamId, interval: newInterval };
  }

  /**
   * Get capture info for a stream
   */
  getInfo(streamId) {
    const capture = this.captures.get(streamId);
    if (!capture) return null;

    return {
      streamId,
      rtspUrl: capture.rtspUrl,
      interval: capture.interval,
      lastCapture: capture.lastCapture,
      frameCount: capture.frameCount,
      errors: capture.errors,
      capturing: capture.capturing
    };
  }

  /**
   * Get all active captures
   */
  getAll() {
    const result = [];
    for (const [streamId, capture] of this.captures) {
      result.push({
        streamId,
        interval: capture.interval,
        lastCapture: capture.lastCapture,
        frameCount: capture.frameCount
      });
    }
    return result;
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      activeCaptures: this.captures.size
    };
  }
}

const instance = new CaptureManager();
instance.assertPublicRtspUrl = assertPublicRtspUrl;
module.exports = instance;
