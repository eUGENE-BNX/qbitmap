/**
 * TeslaCAM Sync Service
 * Periodically syncs segments from teslacam.qbitmap.com (Raspberry Pi in Tesla)
 * Downloads video.mp4 + metadata.json per segment to local disk
 * Keeps last 10 segments, deletes older ones
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'teslacam-sync' });

const TESLACAM_API = 'https://teslacam.qbitmap.com';
const SYNC_INTERVAL = 30 * 1000;
const MAX_SEGMENTS = 10;
const VIDEO_TIMEOUT = 90 * 1000; // 90s for ~13MB video download
const STORAGE_DIR = path.join(__dirname, '../../uploads/teslacam');

let syncTimer = null;
let watcherStatus = { running: false, last_check: null, reachable: false };
let localSegments = [];
let syncing = false;

function start() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  _loadLocalSegments();
  syncTimer = setInterval(tick, SYNC_INTERVAL);
  setTimeout(tick, 3000);
  logger.info('TeslaCAM sync service started');
}

function stop() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
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
    points: s.points || 60,
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
    try {
      const resp = await fetchWithTimeout(TESLACAM_API + '/api/watcher/status', {}, 8000);
      if (resp.ok) {
        const watcher = await resp.json();
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

    // 3. Find new segments
    const localIds = new Set(localSegments.map(s => s.id));
    const newSegments = remoteSegments.filter(s => !localIds.has(s.id));

    if (newSegments.length > 0) {
      logger.info({ count: newSegments.length }, 'New TeslaCAM segments to sync');
    }

    // 4. Download new segments
    for (const seg of newSegments) {
      try {
        await _downloadSegment(seg);
      } catch (e) {
        logger.error({ segId: seg.id, err: e.message }, 'Failed to download segment');
      }
    }

    // 5. Prune old segments
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
  fs.mkdirSync(segDir, { recursive: true });

  // 1. Download metadata JSON
  const metaResp = await fetchWithTimeout(
    TESLACAM_API + '/api/segments/' + segId + '/metadata', {}, 15000
  );
  if (!metaResp.ok) throw new Error('Metadata fetch failed: ' + metaResp.status);
  const metadata = await metaResp.json();
  fs.writeFileSync(path.join(segDir, 'metadata.json'), JSON.stringify(metadata));

  // 2. Download video MP4
  const videoResp = await fetchWithTimeout(
    TESLACAM_API + '/api/segments/' + segId + '/video.mp4', {}, VIDEO_TIMEOUT
  );
  if (!videoResp.ok) throw new Error('Video fetch failed: ' + videoResp.status);
  const videoBuffer = Buffer.from(await videoResp.arrayBuffer());
  fs.writeFileSync(path.join(segDir, 'video.mp4'), videoBuffer);

  // 3. Extract GPS summary from metadata
  const first = metadata[0] || {};
  const last = metadata[metadata.length - 1] || {};

  localSegments.unshift({
    id: segId,
    points: metadata.length,
    start_gps: [first.latitude || null, first.longitude || null],
    end_gps: [last.latitude || null, last.longitude || null],
    start_speed_mps: first.speed_mps || 0,
    end_speed_mps: last.speed_mps || 0,
    synced_at: new Date().toISOString()
  });

  const videoMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
  logger.info({ segId, points: metadata.length, videoMB }, 'Segment synced');
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
      .reverse();

    localSegments = [];
    for (const dir of dirs.slice(0, MAX_SEGMENTS)) {
      const metaPath = path.join(STORAGE_DIR, dir, 'metadata.json');
      let start_gps = [null, null], end_gps = [null, null];
      let start_speed_mps = 0, end_speed_mps = 0, points = 60;

      if (fs.existsSync(metaPath)) {
        try {
          const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          points = metadata.length;
          if (metadata.length > 0) {
            const first = metadata[0];
            const last = metadata[metadata.length - 1];
            start_gps = [first.latitude || null, first.longitude || null];
            end_gps = [last.latitude || null, last.longitude || null];
            start_speed_mps = first.speed_mps || 0;
            end_speed_mps = last.speed_mps || 0;
          }
        } catch (e) { /* ignore */ }
      }

      // Only include if video exists
      if (fs.existsSync(path.join(STORAGE_DIR, dir, 'video.mp4'))) {
        localSegments.push({ id: dir, points, start_gps, end_gps, start_speed_mps, end_speed_mps });
      }
    }

    for (const dir of dirs.slice(MAX_SEGMENTS)) {
      try { fs.rmSync(path.join(STORAGE_DIR, dir), { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }

    logger.info({ count: localSegments.length }, 'Loaded local TeslaCAM segments');
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to load local segments');
  }
}

module.exports = { start, stop, getStatus, getSegments, getSegmentDir };
