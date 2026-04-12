const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const db = require('../services/database');
const mediamtx = require('../services/mediamtx');
const wsService = require('../services/websocket');
const faceApi = require('../services/face-api');
const { authHook } = require('../utils/jwt');
const { generateThumbnail } = require('../utils/thumbnail');
const logger = require('../utils/logger').child({ module: 'broadcasts' });
const { services } = require('../config');

const MEDIAMTX_API = services.mediamtxApi;
const MEDIAMTX_PLAYBACK = services.mediamtxPlayback;
const MAX_BROADCAST_DURATION_MS = 600 * 1000; // 10 min (600 seconds)
const MAX_RECORDING_DURATION_MS = 600 * 1000; // 10 min
const MAX_RECORDINGS_PER_USER = 20;
const RECORDINGS_DIR = path.join(__dirname, '../../uploads/broadcast-recordings');
const broadcastRecordingTimers = new Map();
const broadcastAutoStopTimers = new Map();

// Ensure recordings directory exists
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

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

/**
 * Stop broadcast auto-stop timer
 */
function clearAutoStopTimer(broadcastId) {
  clearTimeout(broadcastAutoStopTimers.get(broadcastId));
  broadcastAutoStopTimers.delete(broadcastId);
}

// [ARCH-03] Inline generateThumbnail removed — now imported from
// utils/thumbnail.js which uses the absolute /usr/bin/ffmpeg path,
// graceful fallback on failure, and consistent format detection.

/**
 * Process and save a broadcast recording after broadcast stops.
 * Runs async (fire-and-forget from the stop response).
 */
async function processBroadcastRecording(broadcast, activeRec, userId) {
  const { broadcast_id: broadcastId, mediamtx_path: pathName, lng, lat, orientation, display_name, avatar_url } = broadcast;
  const startTime = new Date(activeRec.started_at);
  const durationMs = Date.now() - startTime.getTime();
  const durationSec = Math.ceil(durationMs / 1000);

  if (durationSec < 3) {
    logger.info({ broadcastId }, 'Recording too short (<3s), skipping save');
    return;
  }

  const recordingId = `brec_${userId}_${Date.now().toString(36)}`;
  const videoFile = path.join(RECORDINGS_DIR, `${recordingId}.mp4`);
  const thumbFile = path.join(RECORDINGS_DIR, `${recordingId}_thumb.jpg`);

  try {
    // Wait for MediaMTX to finalize the last fMP4 segment
    await new Promise(r => setTimeout(r, 2000));

    // Download from MediaMTX Playback API
    const playbackUrl = `${MEDIAMTX_PLAYBACK}/get?path=${pathName}&start=${encodeURIComponent(startTime.toISOString())}&duration=${durationSec}&format=mp4`;
    const response = await fetch(playbackUrl, { signal: AbortSignal.timeout(120000) });

    if (!response.ok) {
      throw new Error(`Playback API error: ${response.status}`);
    }

    // Stream to disk
    const writeStream = fs.createWriteStream(videoFile);
    await pipeline(response.body, writeStream);

    const stats = fs.statSync(videoFile);
    if (stats.size < 1024) {
      fs.unlinkSync(videoFile);
      logger.warn({ broadcastId }, 'Recording file too small, discarding');
      return;
    }

    // Generate thumbnail (utility returns false on failure instead of throwing)
    let thumbnailPath = null;
    const thumbOk = await generateThumbnail(videoFile, thumbFile);
    if (thumbOk) {
      thumbnailPath = `broadcast-recordings/${recordingId}_thumb.jpg`;
    }

    // Save to DB
    await db.createBroadcastRecording(userId, {
      recordingId,
      broadcastId,
      displayName: display_name,
      avatarUrl: avatar_url,
      filePath: `broadcast-recordings/${recordingId}.mp4`,
      fileSize: stats.size,
      durationMs: Math.min(durationMs, MAX_BROADCAST_DURATION_MS),
      thumbnailPath,
      lng,
      lat,
      orientation: orientation || 'landscape'
    });

    // Enforce quota: delete oldest if user has > MAX_RECORDINGS_PER_USER
    const count = await db.countBroadcastRecordingsByUser(userId);
    if (count > MAX_RECORDINGS_PER_USER) {
      const oldest = await db.getOldestBroadcastRecording(userId);
      if (oldest) {
        const oldFile = path.join(__dirname, '../../uploads', oldest.file_path);
        const oldThumb = oldest.thumbnail_path ? path.join(__dirname, '../../uploads', oldest.thumbnail_path) : null;
        try { fs.unlinkSync(oldFile); } catch (e) {}
        if (oldThumb) try { fs.unlinkSync(oldThumb); } catch (e) {}
        await db.deleteBroadcastRecording(oldest.recording_id, userId);
        logger.info({ userId, deletedRecordingId: oldest.recording_id }, 'Deleted oldest recording (quota exceeded)');
      }
    }

    // Notify user via WebSocket
    wsService.broadcast({
      type: 'recording_saved',
      payload: { userId, recordingId, broadcastId }
    });

    logger.info({ userId, recordingId, broadcastId, fileSize: stats.size }, 'Broadcast recording saved');
  } catch (err) {
    logger.error({ err, broadcastId, recordingId }, 'Failed to process broadcast recording');
    // Cleanup partial file
    try { fs.unlinkSync(videoFile); } catch (e) {}
    try { fs.unlinkSync(thumbFile); } catch (e) {}
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
    const { lng, lat, orientation, accuracy_radius_m, source, record } = request.body || {};

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
    const shouldRecord = record === true;
    const mediamtxResult = await mediamtx.addRtmpPath(pathName, shouldRecord ? { record: true } : {});
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

    // If recording requested, create active_recordings entry
    if (shouldRecord) {
      await db.startRecording(broadcastId, pathName, userId, MAX_RECORDING_DURATION_MS);
      logger.info({ userId, broadcastId }, 'Broadcast recording started from beginning');
    }

    // Auto-stop broadcast after MAX_BROADCAST_DURATION_MS
    const autoStopTimer = setTimeout(async () => {
      broadcastAutoStopTimers.delete(broadcastId);
      try {
        const bc = await db.getActiveBroadcastByUser(userId);
        if (!bc || bc.broadcast_id !== broadcastId) return;

        // Stop recording if active
        const activeRec = await db.getActiveRecording(broadcastId);
        if (activeRec) {
          await stopBroadcastRecording(broadcastId, pathName);
          // Process the recording async
          processBroadcastRecording(bc, activeRec, userId).catch(err => {
            logger.error({ err, broadcastId }, 'Failed to process recording on auto-stop');
          });
        }

        // Remove path from MediaMTX (delay if recording is being processed)
        setTimeout(async () => {
          await mediamtx.removePath(pathName);
        }, activeRec ? 5000 : 0);

        await db.endLiveBroadcast(broadcastId, userId);

        wsService.broadcast({
          type: 'broadcast_ended',
          payload: { broadcastId, userId, reason: 'timeout' }
        });

        logger.info({ userId, broadcastId }, 'Broadcast auto-stopped (600s limit)');
      } catch (e) {
        logger.error({ err: e, broadcastId }, 'Auto-stop broadcast error');
      }
    }, MAX_BROADCAST_DURATION_MS);
    broadcastAutoStopTimers.set(broadcastId, autoStopTimer);

    logger.info({ userId, broadcastId, pathName, recording: shouldRecord }, 'Live broadcast started');

    return {
      status: 'ok',
      broadcast: {
        broadcastId,
        mediamtxPath: pathName,
        whipUrl,
        whepUrl,
        lng,
        lat,
        recording: shouldRecord,
        maxDurationMs: MAX_BROADCAST_DURATION_MS
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

    // Clear broadcast auto-stop timer
    clearAutoStopTimer(broadcast.broadcast_id);

    // Stop recording if active and trigger async save
    const activeRec = await db.getActiveRecording(broadcast.broadcast_id);
    let recordingSaving = false;
    if (activeRec) {
      await stopBroadcastRecording(broadcast.broadcast_id, broadcast.mediamtx_path);
      recordingSaving = true;
      // Process the recording async (don't block the stop response)
      processBroadcastRecording(broadcast, activeRec, userId).catch(err => {
        logger.error({ err, broadcastId: broadcast.broadcast_id }, 'Failed to process recording on stop');
      });
      logger.info({ broadcastId: broadcast.broadcast_id }, 'Recording stopped, save in progress');
    }

    // Remove path from MediaMTX (delay if recording is being processed to allow download)
    setTimeout(async () => {
      await mediamtx.removePath(broadcast.mediamtx_path);
    }, recordingSaving ? 5000 : 0);

    // End in database
    await db.endLiveBroadcast(broadcast.broadcast_id, userId);

    // Notify all clients via WebSocket
    wsService.broadcast({
      type: 'broadcast_ended',
      payload: {
        broadcastId: broadcast.broadcast_id,
        userId,
        reason: 'manual'
      }
    });

    logger.info({ userId, broadcastId: broadcast.broadcast_id }, 'Live broadcast stopped');

    return { status: 'ok', recordingSaving };
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
module.exports.processBroadcastRecording = processBroadcastRecording;
