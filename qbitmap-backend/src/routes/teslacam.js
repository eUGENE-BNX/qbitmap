/**
 * TeslaCAM Routes — serve locally cached video segments
 * Data synced by teslacam-sync service from the car's Raspberry Pi
 */

const fs = require('fs');
const path = require('path');
const teslacamSync = require('../services/teslacam-sync');

async function teslacamRoutes(fastify) {

  // GET /api/teslacam/status
  fastify.get('/status', async (request, reply) => {
    return teslacamSync.getStatus();
  });

  // GET /api/teslacam/segments
  fastify.get('/segments', async (request, reply) => {
    const segments = teslacamSync.getSegments();
    return { count: segments.length, segments };
  });

  // GET /api/teslacam/segments/:id/metadata
  fastify.get('/segments/:id/metadata', async (request, reply) => {
    const { id } = request.params;
    const filePath = path.join(teslacamSync.getSegmentDir(id), 'metadata.json');

    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'Segment metadata not found' });
    }

    reply.header('Cache-Control', 'public, max-age=86400');
    reply.type('application/json');
    return fs.createReadStream(filePath);
  });

  // GET /api/teslacam/segments/:id/video.mp4
  fastify.get('/segments/:id/video.mp4', async (request, reply) => {
    const { id } = request.params;
    const filePath = path.join(teslacamSync.getSegmentDir(id), 'video.mp4');

    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'Segment video not found' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = request.headers.range;

    if (range) {
      // Range request for video seeking
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Length', chunkSize);
      reply.header('Content-Type', 'video/mp4');
      reply.header('Cache-Control', 'public, max-age=86400');
      return fs.createReadStream(filePath, { start, end });
    }

    reply.header('Content-Length', fileSize);
    reply.header('Content-Type', 'video/mp4');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'public, max-age=86400');
    return fs.createReadStream(filePath);
  });
}

module.exports = teslacamRoutes;
