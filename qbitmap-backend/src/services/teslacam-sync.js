/**
 * TeslaCAM Sync Service
 * Periodically syncs segments from teslacam.qbitmap.com (Raspberry Pi in Tesla)
 * Downloads frames + metadata to local disk for serving from qbitmap backend
 * Keeps last 10 segments, deletes older ones
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'teslacam-sync' });

const TESLACAM_API = 'https://teslacam.qbitmap.com';
const SYNC_INTERVAL = 30 * 1000;   // 30s poll
const MAX_SEGMENTS = 10;
const STORAGE_DIR = path.join(__dirname, '../../uploads/teslacam');

// In-memory state
let syncTimer = null;
let watcherStatus = { running: false, last_check: null, reachable: false };
let localSegments = [];  // ordered newest first: [{ id, manifest, synced_at }]
let syncing = false;

function start() {
  // Ensure storage directory exists
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  // Load existing segments from disk
  _loadLocalSegments();

  syncTimer = setInterval(tick, SYNC_INTERVAL);
  setTimeout(tick, 3000); // first check after 3s
  logger.info('TeslaCAM sync service started');
}

function stop() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  logger.info('TeslaCAM sync service stopped');
}

function getStatus() {
  return {
    ...watcherStatus,
    local_segments: localSegments.length,
    segment_ids: localSegments.map(s => s.id)
  };
}

function getSegments() {
  return localSegments.map(s => ({
    id: s.id,
    frame_count: 15,
    start_gps: s.start_gps || [null, null],
    end_gps: s.end_gps || [null, null],
    start_speed_mps: s.start_speed_mps || 0,
    end_speed_mps: s.end_speed_mps || 0
  }));
}

function getSegmentDir(segId) {
  return path.join(STORAGE_DIR, segId);
}

async function tick() {
  if (syncing) return;
  syncing = true;

  try {
    // 1. Check watcher status
    let watcher = null;
    try {
      const resp = await fetchWithTimeout(TESLACAM_API + '/api/watcher/status', {}, 8000);
      if (resp.ok) {
        watcher = await resp.json();
        watcherStatus = {
          running: watcher.running === true,
          processed_count: watcher.processed_count,
          current_segment: watcher.current_segment,
          last_check: new Date().toISOString(),
          reachable: true
        };
      } else {
        watcherStatus.reachable = false;
        watcherStatus.last_check = new Date().toISOString();
      }
    } catch (e) {
      watcherStatus.reachable = false;
      watcherStatus.running = false;
      watcherStatus.last_check = new Date().toISOString();
      logger.debug('TeslaCAM API unreachable');
      syncing = false;
      return;
    }

    // 2. Fetch remote segment list
    let remoteSegments = [];
    try {
      const resp = await fetchWithTimeout(TESLACAM_API + '/api/segments', {}, 8000);
      if (resp.ok) {
        const data = await resp.json();
        remoteSegments = data.segments || [];
      }
    } catch (e) {
      logger.warn('Failed to fetch remote segments');
      syncing = false;
      return;
    }

    // 3. Find new segments to download
    const localIds = new Set(localSegments.map(s => s.id));
    const newSegments = remoteSegments.filter(s => !localIds.has(s.id));

    if (newSegments.length > 0) {
      logger.info({ count: newSegments.length }, 'New TeslaCAM segments to sync');
    }

    // 4. Download new segments (newest first)
    for (const seg of newSegments) {
      try {
        await _downloadSegment(seg);
      } catch (e) {
        logger.error({ segId: seg.id, err: e.message }, 'Failed to download segment');
      }
    }

    // 5. Prune old segments (keep MAX_SEGMENTS)
    _pruneSegments();

  } catch (e) {
    logger.error({ err: e.message }, 'TeslaCAM sync tick error');
  } finally {
    syncing = false;
  }
}

async function _downloadSegment(segSummary) {
  const segId = segSummary.id;
  const segDir = path.join(STORAGE_DIR, segId);

  // Create directory
  fs.mkdirSync(segDir, { recursive: true });

  // Download all 15 frames (images + metadata) in parallel batches of 5
  const frameMetas = [];
  for (let batch = 0; batch < 3; batch++) {
    const promises = [];
    for (let i = 1; i <= 5; i++) {
      const num = batch * 5 + i;
      if (num > 15) break;

      // Download JPEG
      promises.push(
        _downloadFile(
          TESLACAM_API + '/api/segments/' + segId + '/frames/' + num + '.jpg',
          path.join(segDir, 'frame_' + String(num).padStart(3, '0') + '.jpg')
        )
      );

      // Download metadata JSON and collect for manifest
      promises.push(
        _downloadAndReturn(
          TESLACAM_API + '/api/segments/' + segId + '/frames/' + num + '.json',
          path.join(segDir, 'frame_' + String(num).padStart(3, '0') + '.json')
        ).then(data => { if (data) frameMetas[num - 1] = data; })
      );
    }
    await Promise.all(promises);
  }

  // Build manifest from frame metadata (since /manifest endpoint has a bug)
  const manifest = [];
  for (let i = 0; i < 15; i++) {
    const meta = frameMetas[i];
    if (meta) {
      manifest.push({
        frame_jpg: 'frame_' + String(i + 1).padStart(3, '0') + '.jpg',
        metadata_json: 'frame_' + String(i + 1).padStart(3, '0') + '.json',
        timestamp_sec: meta.timestamp_sec || (i + 1) * 4,
        latitude: meta.latitude_deg || null,
        longitude: meta.longitude_deg || null,
        speed_mps: meta.vehicle_speed_mps || 0,
        heading_deg: meta.heading_deg || 0
      });
    }
  }
  fs.writeFileSync(path.join(segDir, 'manifest.json'), JSON.stringify(manifest));

  // Add to local segments list
  localSegments.unshift({
    id: segId,
    start_gps: segSummary.start_gps,
    end_gps: segSummary.end_gps,
    start_speed_mps: segSummary.start_speed_mps,
    end_speed_mps: segSummary.end_speed_mps,
    synced_at: new Date().toISOString()
  });

  logger.info({ segId, frames: 15 }, 'Segment synced');
}

async function _downloadAndReturn(url, destPath) {
  try {
    const resp = await fetchWithTimeout(url, {}, 15000);
    if (!resp.ok) return null;
    const text = await resp.text();
    fs.writeFileSync(destPath, text);
    try { return JSON.parse(text); } catch (e) { return null; }
  } catch (e) {
    logger.debug({ url, err: e.message }, 'Failed to download file');
    return null;
  }
}

async function _downloadFile(url, destPath) {
  try {
    const resp = await fetchWithTimeout(url, {}, 15000);
    if (!resp.ok) return;
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
  } catch (e) {
    logger.debug({ url, err: e.message }, 'Failed to download file');
  }
}

function _pruneSegments() {
  while (localSegments.length > MAX_SEGMENTS) {
    const old = localSegments.pop();
    const oldDir = path.join(STORAGE_DIR, old.id);
    try {
      fs.rmSync(oldDir, { recursive: true, force: true });
      logger.info({ segId: old.id }, 'Pruned old segment');
    } catch (e) {
      logger.warn({ segId: old.id, err: e.message }, 'Failed to prune segment dir');
    }
  }
}

function _loadLocalSegments() {
  try {
    if (!fs.existsSync(STORAGE_DIR)) return;

    const dirs = fs.readdirSync(STORAGE_DIR)
      .filter(d => fs.statSync(path.join(STORAGE_DIR, d)).isDirectory())
      .sort()
      .reverse(); // newest first

    localSegments = [];
    for (const dir of dirs.slice(0, MAX_SEGMENTS)) {
      const manifestPath = path.join(STORAGE_DIR, dir, 'manifest.json');
      let start_gps = [null, null], end_gps = [null, null];
      let start_speed_mps = 0, end_speed_mps = 0;

      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest.length > 0) {
            const first = manifest[0];
            const last = manifest[manifest.length - 1];
            start_gps = [first.latitude || null, first.longitude || null];
            end_gps = [last.latitude || null, last.longitude || null];
            start_speed_mps = first.speed_mps || 0;
            end_speed_mps = last.speed_mps || 0;
          }
        } catch (e) { /* ignore parse errors */ }
      }

      localSegments.push({ id: dir, start_gps, end_gps, start_speed_mps, end_speed_mps });
    }

    // Prune extra dirs on disk
    for (const dir of dirs.slice(MAX_SEGMENTS)) {
      try {
        fs.rmSync(path.join(STORAGE_DIR, dir), { recursive: true, force: true });
      } catch (e) { /* ignore */ }
    }

    logger.info({ count: localSegments.length }, 'Loaded local TeslaCAM segments');
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to load local segments');
  }
}

module.exports = { start, stop, getStatus, getSegments, getSegmentDir };
