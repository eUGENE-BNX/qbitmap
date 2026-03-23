#!/usr/bin/env node
/**
 * City Camera Clip Scheduler
 *
 * Periodically captures 2-minute clips from city cameras,
 * transcodes to 720p/2.5Mbit HLS, and stores on filesystem.
 * Viewers get served static HLS files (loop playback).
 *
 * Config via environment variables:
 *   CLIP_DIR         - Output directory (default: /opt/city-clips)
 *   CLIP_DURATION    - Capture duration in seconds (default: 120)
 *   CYCLE_INTERVAL   - Minutes between full cycles (default: 20)
 *   MAX_CONCURRENT   - Max simultaneous FFmpeg jobs (default: 2)
 *   CAMERAS_API_URL  - Backend API URL for camera list
 *   CAMERAS_JSON     - Path to local JSON camera list (fallback)
 *   HTTP_PORT        - Static file server port (default: 8080)
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Configuration
const CLIP_DIR = process.env.CLIP_DIR || '/opt/city-clips';
const CLIP_DURATION = parseInt(process.env.CLIP_DURATION || '120', 10);
const CYCLE_INTERVAL_MIN = parseInt(process.env.CYCLE_INTERVAL || '20', 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2', 10);
// Use direct backend port (3000) to bypass Caddy and preserve source IP
const CAMERAS_API_URL = process.env.CAMERAS_API_URL || 'http://91.99.219.248:3000/api/public/city-cameras?internal=1';
const CAMERAS_JSON = process.env.CAMERAS_JSON || '';

// Ensure clip directory exists
fs.mkdirSync(CLIP_DIR, { recursive: true });

function log(msg, data) {
  const entry = { time: new Date().toISOString(), msg, ...data };
  console.log(JSON.stringify(entry));
}

/**
 * Fetch city camera list from backend API or local JSON file
 */
async function fetchCameras() {
  // Try local JSON first (if configured)
  if (CAMERAS_JSON && fs.existsSync(CAMERAS_JSON)) {
    try {
      const data = JSON.parse(fs.readFileSync(CAMERAS_JSON, 'utf8'));
      return data.cameras || data;
    } catch (err) {
      log('Failed to read local cameras JSON', { error: err.message });
    }
  }

  // Fetch from API
  try {
    const response = await fetch(CAMERAS_API_URL, {
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    return data.cameras || [];
  } catch (err) {
    log('Failed to fetch cameras from API', { error: err.message });
    return [];
  }
}

/**
 * Extract the source HLS URL for a city camera.
 * The API returns `hls_url` which points to our proxy.
 * We need the original source URL stored as `rtsp_source_url` in DB.
 * Since the public API strips it, we use a dedicated internal endpoint or config.
 */
function getSourceUrl(camera) {
  // If camera has source_url (from internal API or config), use it
  return camera.source_url || camera.rtsp_source_url || null;
}

/**
 * Capture a clip from an HLS source using FFmpeg
 * @returns {Promise<boolean>} true if successful
 */
function captureClip(sourceUrl, cameraPath) {
  return new Promise((resolve) => {
    const tmpDir = path.join(CLIP_DIR, `${cameraPath}_tmp`);
    const liveDir = path.join(CLIP_DIR, cameraPath);

    // Clean up any leftover tmp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    const segmentPattern = path.join(tmpDir, 'seg%03d.ts');
    const playlistPath = path.join(tmpDir, 'playlist.m3u8');

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '2',
      '-reconnect_on_network_error', '0',
      '-rw_timeout', '10000000',
      '-i', sourceUrl,
      '-t', String(CLIP_DURATION),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-b:v', '2.5M',
      '-maxrate', '3M',
      '-bufsize', '6M',
      '-vf', 'scale=-2:720',
      '-g', '60',
      '-keyint_min', '60',
      '-an',
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_list_size', '0',
      '-hls_segment_filename', segmentPattern,
      playlistPath
    ];

    const ffmpeg = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    // Timeout: clip duration + 30s buffer (quick fail for unreachable cameras)
    const timeout = setTimeout(() => {
      log('FFmpeg timeout, killing process', { cameraPath });
      ffmpeg.kill('SIGKILL');
    }, (CLIP_DURATION + 30) * 1000);

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        log('FFmpeg failed', { cameraPath, code, stderr: stderr.slice(-500) });
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve(false);
        return;
      }

      // Verify playlist was created
      if (!fs.existsSync(playlistPath)) {
        log('No playlist generated', { cameraPath });
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve(false);
        return;
      }

      // Atomic swap: remove live dir, rename tmp to live
      try {
        fs.rmSync(liveDir, { recursive: true, force: true });
        fs.renameSync(tmpDir, liveDir);
        log('Clip updated', { cameraPath });
        resolve(true);
      } catch (err) {
        log('Atomic swap failed', { cameraPath, error: err.message });
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve(false);
      }
    });

    ffmpeg.on('error', (err) => {
      clearTimeout(timeout);
      log('FFmpeg spawn error', { cameraPath, error: err.message });
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve(false);
    });
  });
}

/**
 * Process camera queue with concurrency limit
 */
async function processQueue(cameras) {
  const queue = [...cameras];
  let active = 0;
  let completed = 0;
  let failed = 0;

  return new Promise((resolve) => {
    function next() {
      while (active < MAX_CONCURRENT && queue.length > 0) {
        const camera = queue.shift();
        const sourceUrl = getSourceUrl(camera);

        if (!sourceUrl) {
          log('No source URL, skipping', { name: camera.name, id: camera.device_id });
          failed++;
          checkDone();
          continue;
        }

        // Use mediamtx_path or device_id as directory name
        const cameraPath = camera.mediamtx_path || camera.device_id;
        if (!cameraPath) {
          failed++;
          checkDone();
          continue;
        }

        active++;
        log('Starting capture', { name: camera.name, cameraPath });

        captureClip(sourceUrl, cameraPath).then((success) => {
          active--;
          if (success) completed++;
          else failed++;
          checkDone();
          next();
        });
      }
    }

    function checkDone() {
      if (active === 0 && queue.length === 0) {
        resolve({ completed, failed, total: cameras.length });
      }
    }

    next();
  });
}

/**
 * Clean up clip directories for cameras that no longer exist
 */
function cleanupStaleClips(cameras) {
  const activePaths = new Set(
    cameras.map(c => c.mediamtx_path || c.device_id).filter(Boolean)
  );

  try {
    const dirs = fs.readdirSync(CLIP_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      // Skip tmp dirs (in-progress captures)
      if (dir.name.endsWith('_tmp')) continue;
      if (!activePaths.has(dir.name)) {
        const fullPath = path.join(CLIP_DIR, dir.name);
        fs.rmSync(fullPath, { recursive: true, force: true });
        log('Removed stale clip directory', { dir: dir.name });
      }
    }
  } catch (err) {
    log('Cleanup error', { error: err.message });
  }
}

/**
 * Run one full cycle: fetch cameras, capture clips
 */
async function runCycle() {
  log('Starting clip cycle');
  const startTime = Date.now();

  const cameras = await fetchCameras();
  if (cameras.length === 0) {
    log('No cameras found, skipping cycle');
    return;
  }

  // Remove clips for deleted cameras
  cleanupStaleClips(cameras);

  log('Cameras loaded', { count: cameras.length });
  const result = await processQueue(cameras);
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  log('Cycle complete', { ...result, elapsedSeconds: elapsed });
}

/**
 * Static HTTP file server for serving clips
 */
function startHttpServer() {
  const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);
  const MIME_TYPES = {
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t',
    '.mp4': 'video/mp4',
    '.m4s': 'video/iso.segment',
  };

  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }

    // Sanitize path to prevent directory traversal
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath.includes('..')) {
      res.writeHead(403);
      res.end();
      return;
    }

    const filePath = path.join(CLIP_DIR, urlPath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext];

    if (!mimeType) {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const stat = fs.statSync(filePath);
      const cacheControl = ext === '.m3u8'
        ? 'public, max-age=60'   // Playlists: 1 min cache
        : 'public, max-age=1200'; // Segments: 20 min cache

      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': stat.size,
        'Cache-Control': cacheControl,
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      fs.createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(HTTP_PORT, () => {
    log('HTTP file server started', { port: HTTP_PORT, root: CLIP_DIR });
  });
}

/**
 * Main loop
 */
async function main() {
  log('City Clip Scheduler starting', {
    clipDir: CLIP_DIR,
    clipDuration: CLIP_DURATION,
    cycleInterval: CYCLE_INTERVAL_MIN,
    maxConcurrent: MAX_CONCURRENT,
    camerasApi: CAMERAS_API_URL
  });

  // Start static file server for serving clips
  startHttpServer();

  // Run first cycle immediately
  await runCycle();

  // Schedule subsequent cycles
  setInterval(async () => {
    try {
      await runCycle();
    } catch (err) {
      log('Cycle error', { error: err.message });
    }
  }, CYCLE_INTERVAL_MIN * 60 * 1000);
}

main().catch((err) => {
  log('Fatal error', { error: err.message });
  process.exit(1);
});
