const cron = require('node-cron');
const db = require('./database');
const mediamtx = require('./mediamtx');
const logger = require('../utils/logger').child({ module: 'cleanup' });

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

    // Run stale broadcast cleanup every 15 seconds (offset by 5s to avoid collision with stream-cache cleanup)
    setTimeout(() => {
      this.broadcastCleanupInterval = setInterval(() => {
        this.cleanupStaleBroadcasts();
      }, 15 * 1000);
    }, 5 * 1000);

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
      const dbSizeMB = rows[0]?.size_mb?.toFixed(2) || '0';
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

    } catch (error) {
      logger.error({ err: error }, 'Maintenance error');
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

      for (const broadcast of activeBroadcasts) {
        const ageMs = Date.now() - new Date(broadcast.started_at).getTime();

        // Hard limit: 30 minutes max
        if (ageMs > 30 * 60 * 1000) {
          await this.endStaleBroadcast(broadcast, wsService);
          continue;
        }

        // Check MediaMTX for orphaned broadcasts (no publisher) after 20s
        if (ageMs > 20 * 1000) {
          try {
            const response = await fetch(`${mediamtx.MEDIAMTX_API}/v3/paths/get/${broadcast.mediamtx_path}`);
            if (response.status === 404) {
              await this.endStaleBroadcast(broadcast, wsService);
            } else if (response.ok) {
              const data = await response.json();
              if (!data.source || data.source.type === '') {
                await this.endStaleBroadcast(broadcast, wsService);
              }
            }
          } catch (e) {
            // MediaMTX unreachable, skip this round
          }
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Broadcast cleanup error');
    }
  }

  async endStaleBroadcast(broadcast, wsService) {
    // Stop recording if active before removing path
    try {
      await db.stopRecording(broadcast.broadcast_id);
    } catch (e) {
      // No active recording or already stopped
    }

    try {
      await mediamtx.removePath(broadcast.mediamtx_path);
    } catch (e) {
      // Path may already be gone
    }

    await db.endLiveBroadcast(broadcast.broadcast_id, broadcast.user_id);

    if (wsService) {
      wsService.broadcast({
        type: 'broadcast_ended',
        payload: {
          broadcastId: broadcast.broadcast_id,
          userId: broadcast.user_id
        }
      });
    }

    logger.info({ broadcastId: broadcast.broadcast_id, userId: broadcast.user_id }, 'Stale broadcast cleaned up');
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
