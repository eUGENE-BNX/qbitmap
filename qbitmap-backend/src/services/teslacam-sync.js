/**
 * TeslaCAM Sync Service
 * Periodically syncs segments from teslacam.qbitmap.com (Raspberry Pi in Tesla)
 * Downloads video.mp4 + metadata.json per segment to local disk
 * Keeps last 10 segments, deletes older ones
 *
 * [PERF-11] All filesystem I/O is async (fs.promises + stream.pipeline).
 * The previous version used readFileSync/writeFileSync/statSync throughout,
 * blocking the event loop for 10-50ms per 13MB video write and stalling
 * every 30s tick with multiple sync stat/readdir/readFile calls.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
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
  // mkdirSync at boot is fine — happens once before server listens.
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

    // 3. Sort remote by ID descending (newest first) and take newest MAX
    remoteSegments.sort((a, b) => b.id.localeCompare(a.id));
    const targetSegments = remoteSegments.slice(0, MAX_SEGMENTS);

    // 4. Download missing segments
    const localIds = new Set(localSegments.map(s => s.id));
    const newSegments = targetSegments.filter(s => !localIds.has(s.id));

    if (newSegments.length > 0) {
      logger.info({ count: newSegments.length }, 'New TeslaCAM segments to sync');
    }

    for (const seg of newSegments) {
      try {
        await _downloadSegment(seg);
      } catch (e) {
        logger.error({ segId: seg.id, err: e.message }, 'Failed to download segment');
      }
    }

    // 5. Rebuild localSegments from disk (single source of truth)
    await _loadLocalSegments();

  } catch (e) {
    logger.error({ err: e.message }, 'TeslaCAM sync tick error');
  } finally {
    syncing = false;
  }
}

async function _downloadSegment(segSummary) {
  const segId = segSummary.id;
  const segDir = path.join(STORAGE_DIR, segId);
  await fsp.mkdir(segDir, { recursive: true });

  // 1. Download metadata JSON
  const metaResp = await fetchWithTimeout(
    TESLACAM_API + '/api/segments/' + segId + '/metadata', {}, 15000
  );
  if (!metaResp.ok) throw new Error('Metadata fetch failed: ' + metaResp.status);
  const metadata = await metaResp.json();
  await fsp.writeFile(path.join(segDir, 'metadata.json'), JSON.stringify(metadata));

  // 2. Download video MP4 — stream directly to disk instead of buffering
  // the entire ~13MB in memory then writeFileSync-blocking the event loop.
  const videoResp = await fetchWithTimeout(
    TESLACAM_API + '/api/segments/' + segId + '/video.mp4', {}, VIDEO_TIMEOUT
  );
  if (!videoResp.ok) throw new Error('Video fetch failed: ' + videoResp.status);

  const videoPath = path.join(segDir, 'video.mp4');
  await pipeline(
    Readable.fromWeb(videoResp.body),
    fs.createWriteStream(videoPath)
  );

  const stats = await fsp.stat(videoPath);
  const videoMB = (stats.size / 1024 / 1024).toFixed(1);
  logger.info({ segId, points: metadata.length, videoMB }, 'Segment synced');
}

async function _loadLocalSegments() {
  try {
    try { await fsp.access(STORAGE_DIR); } catch { return; }

    const entries = await fsp.readdir(STORAGE_DIR, { withFileTypes: true });
    const dirs = entries
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
      .reverse();

    const segments = [];
    for (const dir of dirs.slice(0, MAX_SEGMENTS)) {
      const metaPath = path.join(STORAGE_DIR, dir, 'metadata.json');
      const videoPath = path.join(STORAGE_DIR, dir, 'video.mp4');
      let start_gps = [null, null], end_gps = [null, null];
      let start_speed_mps = 0, end_speed_mps = 0, points = 60;

      // Only include if video exists
      try { await fsp.access(videoPath); } catch { continue; }

      try {
        const raw = await fsp.readFile(metaPath, 'utf8');
        const metadata = JSON.parse(raw);
        points = metadata.length;
        if (metadata.length > 0) {
          const first = metadata[0];
          const last = metadata[metadata.length - 1];
          start_gps = [first.latitude || null, first.longitude || null];
          end_gps = [last.latitude || null, last.longitude || null];
          start_speed_mps = first.speed_mps || 0;
          end_speed_mps = last.speed_mps || 0;
        }
      } catch { /* metadata missing or corrupt — use defaults */ }

      segments.push({ id: dir, points, start_gps, end_gps, start_speed_mps, end_speed_mps });
    }

    localSegments = segments;

    // Prune excess segments
    for (const dir of dirs.slice(MAX_SEGMENTS)) {
      try {
        await fsp.rm(path.join(STORAGE_DIR, dir), { recursive: true, force: true });
      } catch { /* ignore */ }
    }

    logger.info({ count: localSegments.length }, 'Loaded local TeslaCAM segments');
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to load local segments');
  }
}

module.exports = { start, stop, getStatus, getSegments, getSegmentDir };
