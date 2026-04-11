const db = require('../services/database');
const mediamtx = require('../services/mediamtx');
const wsService = require('../services/websocket');
const faceApi = require('../services/face-api');
const { authHook } = require('../utils/jwt');
const logger = require('../utils/logger').child({ module: 'broadcasts' });
const { services } = require('../config');

const MEDIAMTX_API = services.mediamtxApi;
const MAX_RECORDING_DURATION_MS = 60 * 60 * 1000; // 60 min
const broadcastRecordingTimers = new Map();

async function stopBroadcastRecording(broadcastId, pathName) {
  clearTimeout(broadcastRecordingTimers.get(broadcastId));
  broadcastRecordingTimers.delete(broadcastId);
  await db.stopRecording(broadcastId);
  try {
    await fetch(`${MEDIAMTX_API}/v3/config/paths/patch/${pathName}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record: false })
    });
  } catch (e) {
    logger.warn({ broadcastId, pathName, err: e }, 'Failed to disable recording on MediaMTX');
  }
}

async function broadcastRoutes(fastify, options) {

  // GET /active - List all active broadcasts (public, no auth required)
  fastify.get('/active', async (request, reply) => {
    try {
      const broadcasts = await db.getActiveBroadcasts();
      return { broadcasts };
    } catch (error) {
      logger.error({ err: error }, 'Failed to get active broadcasts');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // POST /start - Start a live broadcast (requires auth)
  fastify.post('/start', { preHandler: authHook }, async (request, reply) => {
    const userId = request.user.userId;
    const { lng, lat, orientation, accuracy_radius_m, source } = request.body || {};

    // Validate coordinates
    if (!Number.isFinite(lng) || !Number.isFinite(lat) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return reply.code(400).send({ error: 'Valid lng and lat are required' });
    }

    // Only one active broadcast per user - auto-cleanup stale ones
    const existing = await db.getActiveBroadcastByUser(userId);
    if (existing) {
      // Check if the old broadcast is actually alive on MediaMTX
      let isStale = false;
      try {
        const res = await fetch(`${MEDIAMTX_API}/v3/paths/get/${existing.mediamtx_path}`);
        if (res.status === 404) {
          isStale = true;
        } else if (res.ok) {
          const data = await res.json();
          if (!data.source || data.source.type === '') isStale = true;
        }
      } catch (e) {
        isStale = true; // MediaMTX unreachable, treat as stale
      }

      if (isStale) {
        // Auto-cleanup the stale broadcast so user can start fresh
        try { await mediamtx.removePath(existing.mediamtx_path); } catch (e) {}
        await db.endLiveBroadcast(existing.broadcast_id, userId);
        wsService.broadcast({
          type: 'broadcast_ended',
          payload: { broadcastId: existing.broadcast_id, userId }
        });
        logger.info({ broadcastId: existing.broadcast_id }, 'Auto-cleaned stale broadcast on new start');
      } else {
        return reply.code(409).send({
          error: 'You already have an active broadcast',
          broadcast: existing
        });
      }
    }

    // Get user info for display on map
    const user = await db.getUserById(userId);
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    // Generate path and create on MediaMTX
    const pathName = mediamtx.generateBroadcastPathName(userId);
    const mediamtxResult = await mediamtx.addRtmpPath(pathName);
    if (!mediamtxResult.success && !mediamtxResult.warning) {
      logger.error({ userId, pathName, error: mediamtxResult.error }, 'Failed to create broadcast path');
      return reply.code(502).send({
        error: 'Failed to create broadcast path on streaming server'
      });
    }

    const broadcastId = `live_${userId}_${Date.now().toString(36)}`;
    const whepUrl = mediamtx.getWhepUrl(pathName);
    const whipUrl = mediamtx.getWhipUrl(pathName);

    const orient = orientation === 'portrait' ? 'portrait' : 'landscape';
    try {
      // Create DB record
      await db.createLiveBroadcast(userId, {
        broadcastId,
        displayName: user.display_name || 'User',
        avatarUrl: user.avatar_url,
        mediamtxPath: pathName,
        whepUrl,
        lng,
        lat,
        accuracyRadiusM: Number.isFinite(accuracy_radius_m) ? accuracy_radius_m : null,
        locationSource: typeof source === 'string' ? source.slice(0, 16) : null,
        orientation: orient
      });
    } catch (dbError) {
      // Rollback MediaMTX path on DB failure
      await mediamtx.removePath(pathName);
      logger.error({ err: dbError, userId, broadcastId }, 'DB error creating broadcast, rolled back MediaMTX path');
      return reply.code(500).send({ error: 'Failed to create broadcast' });
    }

    // Notify all clients via WebSocket
    wsService.broadcast({
      type: 'broadcast_started',
      payload: {
        broadcastId,
        userId,
        displayName: user.display_name || 'User',
        avatarUrl: user.avatar_url,
        lng,
        lat,
        whepUrl,
        orientation: orient,
        startedAt: new Date().toISOString()
      }
    });

    logger.info({ userId, broadcastId, pathName }, 'Live broadcast started');

    return {
      status: 'ok',
      broadcast: {
        broadcastId,
        mediamtxPath: pathName,
        whipUrl,
        whepUrl,
        lng,
        lat
      }
    };
  });

  // POST /stop - Stop a live broadcast (requires auth)
  fastify.post('/stop', { preHandler: authHook }, async (request, reply) => {
    const userId = request.user.userId;

    const broadcast = await db.getActiveBroadcastByUser(userId);
    if (!broadcast) {
      return reply.code(404).send({ error: 'No active broadcast found' });
    }

    // Stop recording if active
    const activeRec = await db.getActiveRecording(broadcast.broadcast_id);
    if (activeRec) {
      await stopBroadcastRecording(broadcast.broadcast_id, broadcast.mediamtx_path);
      logger.info({ broadcastId: broadcast.broadcast_id }, 'Auto-stopped recording on broadcast stop');
    }

    // Remove path from MediaMTX
    await mediamtx.removePath(broadcast.mediamtx_path);

    // End in database
    await db.endLiveBroadcast(broadcast.broadcast_id, userId);

    // Notify all clients via WebSocket
    wsService.broadcast({
      type: 'broadcast_ended',
      payload: {
        broadcastId: broadcast.broadcast_id,
        userId
      }
    });

    logger.info({ userId, broadcastId: broadcast.broadcast_id }, 'Live broadcast stopped');

    return { status: 'ok' };
  });

  // ==================== Recording Endpoints ====================

  // POST /recording/start - Start recording a broadcast
  fastify.post('/recording/start', { preHandler: authHook }, async (request, reply) => {
    const userId = request.user.userId;
    const broadcast = await db.getActiveBroadcastByUser(userId);
    if (!broadcast) {
      return reply.code(404).send({ error: 'No active broadcast found' });
    }

    const existing = await db.getActiveRecording(broadcast.broadcast_id);
    if (existing) {
      return reply.code(400).send({ error: 'Recording already in progress' });
    }

    // Enable recording on MediaMTX
    try {
      const res = await fetch(`${MEDIAMTX_API}/v3/config/paths/patch/${broadcast.mediamtx_path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: true })
      });
      if (!res.ok) {
        throw new Error(`MediaMTX responded with ${res.status}`);
      }
    } catch (e) {
      logger.error({ err: e, broadcastId: broadcast.broadcast_id }, 'Failed to enable recording');
      return reply.code(502).send({ error: 'Failed to start recording on streaming server' });
    }

    await db.startRecording(broadcast.broadcast_id, broadcast.mediamtx_path, userId, MAX_RECORDING_DURATION_MS);

    // Auto-stop timer
    const timer = setTimeout(async () => {
      broadcastRecordingTimers.delete(broadcast.broadcast_id);
      try {
        await stopBroadcastRecording(broadcast.broadcast_id, broadcast.mediamtx_path);
        logger.info({ broadcastId: broadcast.broadcast_id }, 'Recording auto-stopped (max duration)');
      } catch (e) {
        logger.error({ err: e }, 'Auto-stop recording error');
      }
    }, MAX_RECORDING_DURATION_MS);
    broadcastRecordingTimers.set(broadcast.broadcast_id, timer);

    logger.info({ userId, broadcastId: broadcast.broadcast_id }, 'Broadcast recording started');
    return { status: 'ok', maxDurationMs: MAX_RECORDING_DURATION_MS };
  });

  // POST /recording/stop - Stop recording a broadcast
  fastify.post('/recording/stop', { preHandler: authHook }, async (request, reply) => {
    const userId = request.user.userId;
    const broadcast = await db.getActiveBroadcastByUser(userId);
    if (!broadcast) {
      return reply.code(404).send({ error: 'No active broadcast found' });
    }

    const recording = await db.getActiveRecording(broadcast.broadcast_id);
    if (!recording) {
      return reply.code(404).send({ error: 'No active recording found' });
    }

    await stopBroadcastRecording(broadcast.broadcast_id, broadcast.mediamtx_path);
    logger.info({ userId, broadcastId: broadcast.broadcast_id }, 'Broadcast recording stopped');
    return { status: 'ok' };
  });

  // GET /recording/status - Get recording status
  fastify.get('/recording/status', { preHandler: authHook }, async (request, reply) => {
    const userId = request.user.userId;
    const broadcast = await db.getActiveBroadcastByUser(userId);
    if (!broadcast) {
      return { isRecording: false };
    }

    const recording = await db.getActiveRecording(broadcast.broadcast_id);
    if (!recording) {
      return { isRecording: false };
    }

    const elapsedMs = Date.now() - new Date(recording.started_at).getTime();
    return {
      isRecording: true,
      startTime: recording.started_at,
      elapsedMs,
      maxDurationMs: MAX_RECORDING_DURATION_MS
    };
  });

  // ==================== Face Recognition Endpoints ====================

  // POST /face-recognize - Recognize faces in an image (proxies to Face API)
  fastify.post('/face-recognize', { preHandler: authHook }, async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: 'No image uploaded' });
    }

    const chunks = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const result = await faceApi.recognizeFace(buffer, data.mimetype || 'image/jpeg');
    if (!result.ok) {
      return reply.code(result.status).send(result.data);
    }

    return result.data;
  });

  // GET /faces - Get all faces registered by the current user (across all cameras)
  fastify.get('/faces', { preHandler: authHook }, async (request, reply) => {
    const faces = await db.getUserFacesWithCameraNames(request.user.userId);

    return { faces };
  });
}

module.exports = broadcastRoutes;
