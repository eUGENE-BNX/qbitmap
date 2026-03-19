const { spawn } = require('child_process');
const config = require('./config');
const frameStore = require('./frame-store');

const MAX_CONCURRENT_CAPTURES = 50;
const RTSP_URL_REGEX = /^rtsp:\/\/[\da-zA-Z.\-_:@/?=&%]+$/;

class CaptureManager {
  constructor() {
    // Map<streamId, { rtspUrl, interval, timer, capturing }>
    this.captures = new Map();
  }

  /**
   * Start capturing frames from an RTSP stream
   */
  start(streamId, rtspUrl, interval = config.capture.defaultInterval) {
    // Validate RTSP URL format
    if (!rtspUrl || !RTSP_URL_REGEX.test(rtspUrl)) {
      throw new Error(`Invalid RTSP URL format`);
    }

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

module.exports = new CaptureManager();
