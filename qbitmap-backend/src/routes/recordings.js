const db = require('../services/database');
const { authHook } = require('../utils/jwt');
const { checkFeatureLimit } = require('../middleware/limits');
const logger = require('../utils/logger').child({ module: 'recordings' });
const { services } = require('../config');

const MEDIAMTX_API = services.mediamtxApi;
const MEDIAMTX_PLAYBACK = services.mediamtxPlayback;
const MEDIAMTX_RECORDING_API = services.mediamtxRecordingApi;

// Recording limits
const MAX_RECORDING_DURATION_MS = 60 * 60 * 1000; // 60 minutes
const MAX_DISK_USAGE_GB = 10;

// Auto-stop timers (in-memory, restored on startup from DB)
const autoStopTimers = new Map(); // cameraId -> timerId

async function recordingsRoutes(fastify, options) {
  // All routes require authentication
  fastify.addHook('preHandler', authHook);

  /**
   * Check if user has access to camera (owner or shared)
   */
  async function checkCameraAccess(userId, cameraId) {
    const camera = await db.getCameraByDeviceId(cameraId);
    if (!camera) return { valid: false, error: 'Camera not found' };

    // Check ownership or shared access
    const access = await db.hasAccessToCamera(userId, cameraId);
    if (!access.hasAccess) return { valid: false, error: 'Not authorized' };

    return { valid: true, camera, permission: access.permission };
  }

  /**
   * GET /api/recordings/:cameraId/status
   * Get recording status for a camera
   */
  fastify.get('/:cameraId/status', async (request, reply) => {
    const { cameraId } = request.params;
    const { valid, error } = await checkCameraAccess(request.user.userId, cameraId);

    if (!valid) {
      return reply.code(403).send({ error });
    }

    const activeRec = await db.getActiveRecording(cameraId);
    const startTime = activeRec ? new Date(activeRec.started_at).getTime() : null;

    return {
      isRecording: !!activeRec,
      startTime,
      elapsedMs: startTime ? Date.now() - startTime : 0,
      maxDurationMs: MAX_RECORDING_DURATION_MS
    };
  });

  /**
   * POST /api/recordings/:cameraId/start
   * Start recording for a camera
   */
  fastify.post('/:cameraId/start', {
    preHandler: checkFeatureLimit('recording')
  }, async (request, reply) => {
    const { cameraId } = request.params;
    const { valid, error, camera } = await checkCameraAccess(request.user.userId, cameraId);

    if (!valid) {
      return reply.code(403).send({ error });
    }

    // Check if already recording (from DB)
    if (await db.getActiveRecording(cameraId)) {
      return reply.code(400).send({ error: 'Already recording' });
    }

    // Get MediaMTX path name (e.g., cam1, cam2)
    // WHEP URL format: https://stream.qbitmap.com/{pathName}/whep
    const pathName = camera.whep_url?.match(/\/([^\/]+)\/whep/i)?.[1] || cameraId;

    logger.info({ cameraId, pathName, whepUrl: camera.whep_url }, 'Starting recording for path');

    try {
      // Enable recording via MediaMTX API
      // Disable sourceOnDemand to keep RTSP connection alive during recording
      const response = await fetch(`${MEDIAMTX_API}/v3/config/paths/patch/${pathName}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: true, sourceOnDemand: false }),
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        logger.error({ status: response.status, errorText, pathName }, 'MediaMTX API error');
        throw new Error(`MediaMTX API error: ${response.status} - ${errorText}`);
      }

      // Save to database (survives restart)
      await db.startRecording(cameraId, pathName, request.user.userId, MAX_RECORDING_DURATION_MS);

      // Set up auto-stop timer (in-memory)
      const timerId = setTimeout(() => {
        stopRecording(cameraId, pathName);
        logger.info({ cameraId }, 'Recording auto-stopped (max duration reached)');
      }, MAX_RECORDING_DURATION_MS);
      autoStopTimers.set(cameraId, timerId);

      logger.info({ cameraId, pathName, userId: request.user.userId }, 'Recording started');

      return {
        success: true,
        message: 'Recording started',
        maxDurationMs: MAX_RECORDING_DURATION_MS
      };

    } catch (err) {
      logger.error({ err, cameraId }, 'Failed to start recording');
      return reply.code(500).send({ error: 'Failed to start recording' });
    }
  });

  /**
   * POST /api/recordings/:cameraId/stop
   * Stop recording for a camera
   */
  fastify.post('/:cameraId/stop', async (request, reply) => {
    const { cameraId } = request.params;
    const { valid, error } = await checkCameraAccess(request.user.userId, cameraId);

    if (!valid) {
      return reply.code(403).send({ error });
    }

    const activeRec = await db.getActiveRecording(cameraId);
    if (!activeRec) {
      return reply.code(400).send({ error: 'Not recording' });
    }

    try {
      await stopRecording(cameraId, activeRec.path_name);

      const startTime = new Date(activeRec.started_at).getTime();
      const duration = Date.now() - startTime;
      logger.info({ cameraId, durationMs: duration }, 'Recording stopped');

      return {
        success: true,
        message: 'Recording stopped',
        durationMs: duration
      };

    } catch (err) {
      logger.error({ err, cameraId }, 'Failed to stop recording');
      return reply.code(500).send({ error: 'Failed to stop recording' });
    }
  });

  /**
   * GET /api/recordings/:cameraId/list
   * List recordings for a camera with pagination
   * Query params: page (default 1), limit (default 20)
   */
  fastify.get('/:cameraId/list', async (request, reply) => {
    const { cameraId } = request.params;
    const page = parseInt(request.query.page) || 1;
    const limit = parseInt(request.query.limit) || 20;
    const { valid, error, camera } = await checkCameraAccess(request.user.userId, cameraId);

    if (!valid) {
      return reply.code(403).send({ error });
    }

    const pathName = camera.whep_url?.match(/\/([^\/]+)\/whep/i)?.[1] || cameraId;

    try {
      // Get recordings from MediaMTX playback server
      const response = await fetch(`${MEDIAMTX_PLAYBACK}/list?path=${pathName}`, {
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        if (response.status === 404) {
          return { recordings: [], total: 0, page, limit, hasMore: false };
        }
        throw new Error(`Playback API error: ${response.status}`);
      }

      const data = await response.json();

      // Transform and sort the data (newest first)
      const allRecordings = (data || [])
        .map(segment => ({
          start: segment.start,
          duration: segment.duration,
          id: Buffer.from(segment.start).toString('base64url')
        }))
        .sort((a, b) => new Date(b.start) - new Date(a.start));

      // Pagination
      const total = allRecordings.length;
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      const recordings = allRecordings.slice(startIndex, endIndex);
      const hasMore = endIndex < total;

      return { recordings, total, page, limit, hasMore };

    } catch (err) {
      logger.error({ err, cameraId }, 'Failed to list recordings');
      return reply.code(500).send({ error: 'Failed to list recordings' });
    }
  });

  /**
   * GET /api/recordings/:cameraId/get
   * Stream/download a recording
   * Query params: start, duration, format (optional, default: fmp4)
   */
  fastify.get('/:cameraId/get', async (request, reply) => {
    const { cameraId } = request.params;
    const { start, duration } = request.query;
    const { valid, error, camera } = await checkCameraAccess(request.user.userId, cameraId);

    if (!valid) {
      return reply.code(403).send({ error });
    }

    if (!start) {
      return reply.code(400).send({ error: 'start parameter is required' });
    }

    const pathName = camera.whep_url?.match(/\/([^\/]+)\/whep/i)?.[1] || cameraId;

    try {
      // Build playback URL
      // MediaMTX requires URL-encoded start parameter (RFC3339 format with encoded colons)
      // Fastify auto-decodes query params, so we need to re-encode for MediaMTX
      let url = `${MEDIAMTX_PLAYBACK}/get?path=${pathName}&start=${encodeURIComponent(start)}`;
      if (duration) url += `&duration=${duration}`;
      url += `&format=mp4`;

      // Proxy the video stream
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`Playback error: ${response.status}`);
      }

      const contentLength = response.headers.get('content-length');

      // Set appropriate headers
      reply.header('Content-Type', 'video/mp4');
      reply.header('Cache-Control', 'private, max-age=3600');
      reply.header('Accept-Ranges', 'bytes');

      // Pass through content-length if available
      if (contentLength) {
        reply.header('Content-Length', contentLength);
      }

      // Add Content-Disposition for download
      if (request.query.download === 'true') {
        const filename = `recording_${cameraId}_${new Date(start).toISOString().replace(/[:.]/g, '-')}.mp4`;
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      }

      // Stream the response body
      return reply.send(response.body);

    } catch (err) {
      logger.error({ err, cameraId, start }, 'Failed to get recording');
      return reply.code(500).send({ error: 'Failed to get recording' });
    }
  });

  /**
   * DELETE /api/recordings/:cameraId/delete
   * Delete a specific recording
   * Query params: start (ISO timestamp)
   */
  fastify.delete('/:cameraId/delete', async (request, reply) => {
    const { cameraId } = request.params;
    const { start } = request.query;
    const { valid, error, camera } = await checkCameraAccess(request.user.userId, cameraId);

    if (!valid) {
      return reply.code(403).send({ error });
    }

    if (!start) {
      return reply.code(400).send({ error: 'start parameter is required' });
    }

    const pathName = camera.whep_url?.match(/\/([^\/]+)\/whep/i)?.[1] || cameraId;

    try {
      const response = await fetch(
        `${MEDIAMTX_RECORDING_API}/delete?path=${encodeURIComponent(pathName)}&start=${encodeURIComponent(start)}`,
        { method: 'DELETE', signal: AbortSignal.timeout(10000) }
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Delete failed: ${response.status}`);
      }

      logger.info({ cameraId, pathName, start }, 'Recording deleted');
      return { success: true };

    } catch (err) {
      logger.error({ err, cameraId, start }, 'Failed to delete recording');
      return reply.code(500).send({ error: 'Failed to delete recording' });
    }
  });

  /**
   * Helper: Stop recording for a camera
   */
  async function stopRecording(cameraId, pathName) {
    // Clear auto-stop timer if exists
    const timerId = autoStopTimers.get(cameraId);
    if (timerId) {
      clearTimeout(timerId);
      autoStopTimers.delete(cameraId);
    }

    // Remove from database
    await db.stopRecording(cameraId);

    // Disable recording and restore sourceOnDemand via MediaMTX API
    try {
      await fetch(`${MEDIAMTX_API}/v3/config/paths/patch/${pathName}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: false, sourceOnDemand: true }),
        signal: AbortSignal.timeout(10000)
      });
    } catch (err) {
      logger.error({ err, cameraId, pathName }, 'Failed to disable recording in MediaMTX');
    }
  }

  // ==================== STARTUP SYNC ====================
  // On server start, sync with MediaMTX to stop orphaned recordings

  fastify.addHook('onReady', async () => {
    await syncRecordingsOnStartup();
  });

  async function syncRecordingsOnStartup() {
    logger.info('Starting recordings sync...');

    try {
      // 1. Get all paths from MediaMTX that have recording enabled
      const response = await fetch(`${MEDIAMTX_API}/v3/config/paths/list`, {
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) {
        logger.warn('Could not fetch MediaMTX paths for sync');
        return;
      }

      const data = await response.json();
      const pathsWithRecording = (data.items || []).filter(p => p.record === true);

      if (pathsWithRecording.length === 0) {
        logger.info('No orphaned recordings found in MediaMTX');
        // Clear any stale DB entries
        await db.clearAllActiveRecordings();
        return;
      }

      logger.info({ count: pathsWithRecording.length }, 'Found paths with recording enabled');

      // 2. Disable recording for all orphaned paths
      for (const path of pathsWithRecording) {
        try {
          await fetch(`${MEDIAMTX_API}/v3/config/paths/patch/${path.name}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ record: false, sourceOnDemand: true }),
            signal: AbortSignal.timeout(10000)
          });
          logger.info({ pathName: path.name }, 'Disabled orphaned recording');
        } catch (err) {
          logger.error({ err, pathName: path.name }, 'Failed to disable orphaned recording');
        }
      }

      // 3. Clear all DB entries (they're now stopped)
      await db.clearAllActiveRecordings();

      logger.info({ count: pathsWithRecording.length }, 'Recordings sync complete - all orphaned recordings stopped');

    } catch (err) {
      logger.error({ err }, 'Recordings sync failed');
    }
  }
}

module.exports = recordingsRoutes;
