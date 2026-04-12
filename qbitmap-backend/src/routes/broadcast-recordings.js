const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const db = require('../services/database');
const { authHook } = require('../utils/jwt');
const logger = require('../utils/logger').child({ module: 'broadcast-recordings' });

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

async function broadcastRecordingsRoutes(fastify, options) {

  // GET /my - Get current user's broadcast recordings
  fastify.get('/my', { preHandler: authHook }, async (request, reply) => {
    const recordings = await db.getBroadcastRecordingsByUser(request.user.userId, 20);
    return { recordings };
  });

  // GET /public-map - Get all public recordings for map layer (no auth)
  fastify.get('/public-map', async (request, reply) => {
    const recordings = await db.getPublicMapRecordings();
    return { recordings };
  });

  // GET /:recordingId/video - Serve recording video with Range support
  fastify.get('/:recordingId/video', async (request, reply) => {
    const { recordingId } = request.params;
    const recording = await db.getBroadcastRecordingById(recordingId);

    if (!recording) {
      return reply.code(404).send({ error: 'Recording not found' });
    }

    const filePath = path.join(UPLOADS_DIR, recording.file_path);
    let stat;
    try { stat = await fsp.stat(filePath); } catch {
      return reply.code(404).send({ error: 'Video file not found' });
    }
    const fileSize = stat.size;

    const range = request.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = Math.max(0, parseInt(parts[0], 10) || 0);
      const end = Math.min(parts[1] ? parseInt(parts[1], 10) : fileSize - 1, fileSize - 1);

      if (start >= fileSize || start > end) {
        reply.header('Content-Range', `bytes */${fileSize}`);
        return reply.code(416).send({ error: 'Range not satisfiable' });
      }

      const chunkSize = end - start + 1;
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Length', chunkSize);
      reply.header('Content-Type', 'video/mp4');
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(fs.createReadStream(filePath, { start, end }));
    }

    reply.header('Content-Length', fileSize);
    reply.header('Content-Type', 'video/mp4');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(filePath));
  });

  // GET /:recordingId/thumbnail - Serve thumbnail
  fastify.get('/:recordingId/thumbnail', async (request, reply) => {
    const { recordingId } = request.params;
    const recording = await db.getBroadcastRecordingById(recordingId);

    if (!recording || !recording.thumbnail_path) {
      return reply.code(404).send({ error: 'Thumbnail not found' });
    }

    const filePath = path.join(UPLOADS_DIR, recording.thumbnail_path);
    try { await fsp.access(filePath); } catch {
      return reply.code(404).send({ error: 'Thumbnail file not found' });
    }

    const ext = recording.thumbnail_path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    reply.header('Content-Type', ext);
    reply.header('Cache-Control', 'public, max-age=604800');
    return reply.send(fs.createReadStream(filePath));
  });

  // PATCH /:recordingId/visibility - Toggle map visibility
  fastify.patch('/:recordingId/visibility', { preHandler: authHook }, async (request, reply) => {
    const { recordingId } = request.params;
    const { showOnMap, isPublic } = request.body || {};
    const userId = request.user.userId;

    const result = await db.updateRecordingVisibility(recordingId, userId, {
      showOnMap: showOnMap === true,
      isPublic: isPublic === true
    });

    if (!result.success) {
      return reply.code(result.error === 'Not authorized' ? 403 : 404).send({ error: result.error });
    }

    return { status: 'ok' };
  });

  // DELETE /:recordingId - Delete a recording
  fastify.delete('/:recordingId', { preHandler: authHook }, async (request, reply) => {
    const { recordingId } = request.params;
    const userId = request.user.userId;

    const result = await db.deleteBroadcastRecording(recordingId, userId);

    if (!result.success) {
      return reply.code(result.error === 'Not authorized' ? 403 : 404).send({ error: result.error });
    }

    // Delete files
    const { recording } = result;
    if (recording.file_path) {
      fsp.unlink(path.join(UPLOADS_DIR, recording.file_path)).catch(() => {});
    }
    if (recording.thumbnail_path) {
      fsp.unlink(path.join(UPLOADS_DIR, recording.thumbnail_path)).catch(() => {});
    }

    logger.info({ userId, recordingId }, 'Broadcast recording deleted');
    return { status: 'ok' };
  });
}

module.exports = broadcastRecordingsRoutes;
