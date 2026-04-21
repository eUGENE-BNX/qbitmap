const cron = require('node-cron');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const db = require('./database');
const mediamtx = require('./mediamtx');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'cleanup' });

const UPLOADS_DIR = path.resolve(__dirname, '../../uploads/video-messages');
const ORIGINALS_DIR = path.resolve(UPLOADS_DIR, 'originals');
// Files younger than this are skipped — they may belong to an in-progress
// upload whose DB row has not been committed yet.
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000; // 1 hour
// Filename format: {pmsg|vmsg}_{userId}_{time36}[_thumb|_preview].{ext}
const MSG_ID_RE = /^((?:pmsg|vmsg)_\d+_[a-z0-9]+)(?:_thumb|_preview)?\./i;

// [PERF-05] Bound the MediaMTX probe so one slow/unresponsive check can't
// wedge the whole 15-second broadcast cleanup interval. 5s matches the
// other short MediaMTX timeouts used in status health checks.
const MEDIAMTX_PROBE_TIMEOUT_MS = 5000;

class CleanupService {
  constructor() {
    // Note: Frame DB storage has been disabled (only memory cache is used)
    // This service handles MySQL maintenance (ANALYZE, retention cleanup) and broadcast cleanup
  }

  start() {
    // Run maintenance every 6 hours
    cron.schedule('0 */6 * * *', () => {
      this.runMaintenance();
    });

    // Run stale broadcast cleanup every 15 seconds. .unref() both timers so
    // neither blocks SIGTERM; stop() still clearInterval's the stored handle.
    const bootstrapTimer = setTimeout(() => {
      this.broadcastCleanupInterval = setInterval(() => {
        this.cleanupStaleBroadcasts();
      }, 15 * 1000);
      this.broadcastCleanupInterval.unref();
    }, 5 * 1000);
    bootstrapTimer.unref();

    logger.info('Cleanup service started - maintenance every 6 hours, broadcast cleanup every 15s');
  }

  async runMaintenance() {
    logger.info('Starting database maintenance...');

    try {
      // Run ANALYZE on frequently queried tables for query optimizer
      await db.pool.query('ANALYZE TABLE cameras, users, alarms, onvif_events, face_detection_log');
      logger.info('Table analysis complete');

      // Get database size info
      const [rows] = await db.pool.query(`
        SELECT SUM(data_length + index_length) / 1024 / 1024 AS size_mb
        FROM information_schema.tables WHERE table_schema = ?
      `, [process.env.DB_NAME || 'qbitmap']);
      const dbSizeMB = Number(rows[0]?.size_mb || 0).toFixed(2);
      logger.info({ sizeMB: dbSizeMB }, 'Database size');

      // Cleanup old onvif_events (90 day retention)
      const [evtResult] = await db.pool.query(
        'DELETE FROM onvif_events WHERE `timestamp` < DATE_SUB(NOW(), INTERVAL 90 DAY)'
      );
      if (evtResult.affectedRows > 0) {
        logger.info({ count: evtResult.affectedRows }, 'Cleaned up old ONVIF events');
      }

      // Cleanup old face_detection_log (90 day retention)
      const [faceResult] = await db.pool.query(
        'DELETE FROM face_detection_log WHERE detected_at < DATE_SUB(NOW(), INTERVAL 90 DAY)'
      );
      if (faceResult.affectedRows > 0) {
        logger.info({ count: faceResult.affectedRows }, 'Cleaned up old face detection logs');
      }

      // Video-message uploads: reclaim files whose DB row is gone.
      // deleteVideoMessage uses fire-and-forget fs.unlink with a no-op
      // catch, so a crash / permissions blip leaves files behind. FK CASCADE
      // on translations handles rows; files are our last drift source.
      await this.cleanupOrphanUploads();

      // Inactive push subscriptions: 404/410 auto-prune only fires when
      // we actually try to deliver. Users who never receive a push stay
      // in the table forever — purge rows untouched for 90 days.
      try {
        const [result] = await db.pool.query(
          'DELETE FROM push_subscriptions WHERE last_seen_at < DATE_SUB(NOW(), INTERVAL 90 DAY)'
        );
        if (result.affectedRows > 0) {
          logger.info({ count: result.affectedRows }, 'Inactive push subscriptions reclaimed');
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'push_subscriptions cleanup failed');
      }

    } catch (error) {
      logger.error({ err: error }, 'Maintenance error');
    }
  }

  async cleanupOrphanUploads() {
    if (!fs.existsSync(UPLOADS_DIR)) return;
    const now = Date.now();
    const messageIdsSeen = new Set();
    const fileEntries = [];

    const scanDir = async (dir) => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) continue; // originals/ is scanned separately
        const match = entry.name.match(MSG_ID_RE);
        if (!match) continue;
        const filePath = path.join(dir, entry.name);
        const stat = await fsp.stat(filePath).catch(() => null);
        if (!stat) continue;
        if (now - stat.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
        messageIdsSeen.add(match[1]);
        fileEntries.push({ filePath, messageId: match[1] });
      }
    };

    await scanDir(UPLOADS_DIR);
    await scanDir(ORIGINALS_DIR);

    if (messageIdsSeen.size === 0) return;

    const ids = Array.from(messageIdsSeen);
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await db.pool.query(
      `SELECT message_id FROM video_messages WHERE message_id IN (${placeholders})`,
      ids
    );
    const alive = new Set(rows.map(r => r.message_id));

    let deleted = 0;
    for (const { filePath, messageId } of fileEntries) {
      if (alive.has(messageId)) continue;
      try {
        await fsp.unlink(filePath);
        deleted++;
      } catch (err) {
        logger.warn({ err: err.message, filePath }, 'Orphan upload unlink failed');
      }
    }
    if (deleted > 0) {
      logger.info({ deleted, scanned: fileEntries.length }, 'Orphan upload files reclaimed');
    }
  }

  async cleanupStaleBroadcasts() {
    try {
      const activeBroadcasts = await db.getActiveBroadcasts();
      if (activeBroadcasts.length === 0) return;

      let wsService;
      try {
        wsService = require('./websocket');
      } catch (e) {
        // WebSocket service not available yet
      }

      // [PERF-05] Fan out per-broadcast work onto parallel tasks and bound
      // each MediaMTX probe with a timeout. Previously this was a sequential
      // `for...of` with an untimed `fetch`, so a single slow MediaMTX probe
      // would block the whole interval and every subsequent broadcast in
      // the loop. Each map callback owns its own try/catch so one task's
      // failure cannot cancel the batch; a thrown error from one iteration
      // used to silently kill every remaining iteration via the outer
      // try/catch.
      const now = Date.now();
      await Promise.all(activeBroadcasts.map(async (broadcast) => {
        try {
          const ageMs = now - new Date(broadcast.started_at).getTime();

          // Hard limit: 15 minutes max (broadcast limit is 10 min + buffer)
          if (ageMs > 15 * 60 * 1000) {
            await this.endStaleBroadcast(broadcast, wsService);
            return;
          }

          // Check MediaMTX for orphaned broadcasts (no publisher) after 20s
          if (ageMs > 20 * 1000) {
            try {
              const response = await fetchWithTimeout(
                `${mediamtx.MEDIAMTX_API}/v3/paths/get/${broadcast.mediamtx_path}`,
                {},
                MEDIAMTX_PROBE_TIMEOUT_MS
              );
              if (response.status === 404) {
                await this.endStaleBroadcast(broadcast, wsService);
              } else if (response.ok) {
                const data = await response.json();
                if (!data.source || data.source.type === '') {
                  await this.endStaleBroadcast(broadcast, wsService);
                }
              }
            } catch (e) {
              // MediaMTX unreachable or probe timed out — skip this round.
              // Intentionally quiet: the next 15s tick will retry.
            }
          }
        } catch (err) {
          logger.warn({ err, broadcastId: broadcast.broadcast_id }, 'Broadcast cleanup task failed');
        }
      }));
    } catch (error) {
      logger.error({ err: error }, 'Broadcast cleanup error');
    }
  }

  async endStaleBroadcast(broadcast, wsService) {
    // Check for active recording before stopping
    let activeRec = null;
    try {
      activeRec = await db.getActiveRecording(broadcast.broadcast_id);
      if (activeRec) {
        await db.stopRecording(broadcast.broadcast_id);
        // Disable recording on MediaMTX
        try {
          await fetch(`${mediamtx.MEDIAMTX_API}/v3/config/paths/patch/${broadcast.mediamtx_path}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ record: false })
          });
        } catch (e) {
          logger.warn({ err: e.message, path: broadcast.mediamtx_path }, 'Failed to disable recording on MediaMTX path');
        }
      }
    } catch (e) {
      // No active recording or already stopped
    }

    // If recording was active, trigger async save before removing path
    if (activeRec) {
      try {
        const { processBroadcastRecording } = require('../routes/broadcasts');
        processBroadcastRecording(broadcast, activeRec, broadcast.user_id).catch(err => {
          logger.error({ err, broadcastId: broadcast.broadcast_id }, 'Failed to process recording on stale cleanup');
        });
      } catch (e) {
        logger.warn({ err: e }, 'Could not trigger recording save from cleanup');
      }
    }

    // Delay path removal if recording is being saved
    setTimeout(async () => {
      try {
        await mediamtx.removePath(broadcast.mediamtx_path);
      } catch (e) {
        // Path may already be gone
      }
    }, activeRec ? 5000 : 0);

    await db.endLiveBroadcast(broadcast.broadcast_id, broadcast.user_id);

    if (wsService) {
      wsService.broadcast({
        type: 'broadcast_ended',
        payload: {
          broadcastId: broadcast.broadcast_id,
          userId: broadcast.user_id,
          reason: 'stale'
        }
      });
    }

    logger.info({ broadcastId: broadcast.broadcast_id, userId: broadcast.user_id, hadRecording: !!activeRec }, 'Stale broadcast cleaned up');
  }

  /**
   * Stop cleanup service: clear intervals and cron jobs
   */
  stop() {
    if (this.broadcastCleanupInterval) {
      clearInterval(this.broadcastCleanupInterval);
      this.broadcastCleanupInterval = null;
    }
    logger.info('Cleanup service stopped');
  }

  // Manual trigger
  async manualCleanup() {
    await this.runMaintenance();
  }
}

module.exports = new CleanupService();
