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

// Poll MediaMTX until the named path reports ready with at least one
// track, or the timeout elapses. Used for needs_remux paths where the
// recording-start PATCH swaps source: rtsp → publisher and the runOnInit
// ffmpeg child needs ~3-4s to spin up before WHEP can be served. Without
// this wait, the frontend's WHEP reconnect attempt fires before the
// publisher is up and 404s out.
async function waitForPathReady(pathName, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${MEDIAMTX_API}/v3/paths/get/${pathName}`, {
        signal: AbortSignal.timeout(2000)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.ready && Array.isArray(data.tracks) && data.tracks.length > 0) {
          return true;
        }
      }
    } catch {
      // ignore — MediaMTX briefly 404s the path during config reload
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

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
      const patchBody = { record: true, sourceOnDemand: false };

      // Cameras flagged needs_remux need an ffmpeg restream layer to
      // scrub broken NAL access units before MediaMTX's fmp4 muxer
      // touches them (e.g. Tapo C236 substream). Switch the path from
      // direct RTSP to a publisher-mode source fed by a local ffmpeg
      // child (-c copy + h264_mp4toannexb). On recording stop the path
      // is switched back to direct RTSP so the ffmpeg shuts down and
      // idle CPU returns to zero. WHEP live preview keeps working in
      // both states (Chrome WebRTC tolerates the broken NAL that the
      // MP4 demuxer can't).
      if (camera.needs_remux && camera.rtsp_source_url) {
        patchBody.source = 'publisher';
        patchBody.runOnInit = `ffmpeg -hide_banner -loglevel warning -rtsp_transport tcp -i ${camera.rtsp_source_url} -c:v copy -c:a copy -bsf:v h264_mp4toannexb -f rtsp rtsp://localhost:8554/${pathName}`;
        patchBody.runOnInitRestart = true;
        // sourceOnDemand stays at false (init value) — required since
        // source: publisher rejects sourceOnDemand: true.
      }

      const response = await fetch(`${MEDIAMTX_API}/v3/config/paths/patch/${pathName}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody),
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        logger.error({ status: response.status, errorText, pathName }, 'MediaMTX API error');
        throw new Error(`MediaMTX API error: ${response.status} - ${errorText}`);
      }

      // For needs_remux paths the PATCH above swaps source: rtsp →
      // publisher, which kicks any connected WHEP viewers and takes a
      // few seconds to come back up via the runOnInit ffmpeg. Wait for
      // the path to be ready before responding so the frontend's WHEP
      // reconnect lands on a ready stream instead of 404ing.
      if (camera.needs_remux) {
        await waitForPathReady(pathName, 8000);
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
  fastify.get('/:cameraId/get', {
    schema: {
      // Tight schema on the playback params: `start` must be an
      // RFC3339 timestamp (the same format MediaMTX returns from
      // /list), `duration` is a positive integer up to 4 hours, and
      // `download` / `format` are restricted to known values. Anything
      // else is rejected with 400 before the camera-access lookup runs.
      params: {
        type: 'object',
        required: ['cameraId'],
        // cameraId can be numeric ("1") or alphanumeric ("RTSP_MO8FJAOCLNIN").
        // Camera-system path slugs include letters, digits, underscores.
        properties: { cameraId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } }
      },
      querystring: {
        type: 'object',
        required: ['start'],
        properties: {
          start: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})$',
            maxLength: 40
          },
          duration: { type: 'string', pattern: '^\\d+(?:\\.\\d+)?s?$', maxLength: 16 },
          download: { type: 'string', enum: ['true', 'false'] },
          format: { type: 'string', enum: ['mp4', 'fmp4'] }
        }
      }
    }
  }, async (request, reply) => {
    const { cameraId } = request.params;
    const { start, duration } = request.query;
    const { valid, error, camera } = await checkCameraAccess(request.user.userId, cameraId);

    if (!valid) {
      return reply.code(403).send({ error });
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
   * Query params: start (RFC3339 timestamp)
   */
  fastify.delete('/:cameraId/delete', {
    schema: {
      params: {
        type: 'object',
        required: ['cameraId'],
        // cameraId can be numeric ("1") or alphanumeric ("RTSP_MO8FJAOCLNIN").
        // Camera-system path slugs include letters, digits, underscores.
        properties: { cameraId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } }
      },
      querystring: {
        type: 'object',
        required: ['start'],
        properties: {
          start: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})$',
            maxLength: 40
          }
        }
      }
    }
  }, async (request, reply) => {
    const { cameraId } = request.params;
    const { start } = request.query;
    const { valid, error, camera } = await checkCameraAccess(request.user.userId, cameraId);

    if (!valid) {
      return reply.code(403).send({ error });
    }

    const pathName = camera.whep_url?.match(/\/([^\/]+)\/whep/i)?.[1] || cameraId;

    try {
      const response = await fetch(
        `${MEDIAMTX_RECORDING_API}/v3/recordings/deletesegment?path=${encodeURIComponent(pathName)}&start=${encodeURIComponent(start)}`,
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
      const patchBody = { record: false, sourceOnDemand: true };

      // For needs_remux cameras: switch the path back from publisher
      // mode to direct RTSP so the ffmpeg child shuts down (idle CPU = 0).
      // Looking the camera up here so the helper stays callable from
      // the auto-stop timer where the camera object isn't in scope.
      const camera = await db.getCameraByDeviceId(cameraId);
      if (camera?.needs_remux && camera.rtsp_source_url) {
        patchBody.source = camera.rtsp_source_url;
        patchBody.sourceProtocol = 'tcp';
        patchBody.runOnInit = '';
        patchBody.runOnInitRestart = false;
      }

      await fetch(`${MEDIAMTX_API}/v3/config/paths/patch/${pathName}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody),
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
