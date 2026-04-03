/**
 * TeslaCAM Routes — serve locally cached segments/frames
 * Data synced by teslacam-sync service from the car's Raspberry Pi
 */

const fs = require('fs');
const path = require('path');
const teslacamSync = require('../services/teslacam-sync');

async function teslacamRoutes(fastify) {

  // GET /api/teslacam/status
  // Watcher status + sync info (is the car online/driving?)
  fastify.get('/status', async (request, reply) => {
    return teslacamSync.getStatus();
  });

  // GET /api/teslacam/segments
  // List locally cached segments
  fastify.get('/segments', async (request, reply) => {
    const segments = teslacamSync.getSegments();
    return { count: segments.length, segments };
  });

  // GET /api/teslacam/segments/:id/manifest
  // Serve cached manifest JSON
  fastify.get('/segments/:id/manifest', async (request, reply) => {
    const { id } = request.params;
    const filePath = path.join(teslacamSync.getSegmentDir(id), 'manifest.json');

    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'Segment not found' });
    }

    reply.header('Cache-Control', 'public, max-age=3600');
    reply.type('application/json');
    return fs.createReadStream(filePath);
  });

  // GET /api/teslacam/segments/:id/frames/:num.jpg
  // Serve cached JPEG frame
  fastify.get('/segments/:id/frames/:num.jpg', async (request, reply) => {
    const { id, num } = request.params;
    const frameNum = parseInt(num);
    if (isNaN(frameNum) || frameNum < 1 || frameNum > 15) {
      return reply.code(400).send({ error: 'Frame number must be 1-15' });
    }

    const filePath = path.join(
      teslacamSync.getSegmentDir(id),
      'frame_' + String(frameNum).padStart(3, '0') + '.jpg'
    );

    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'Frame not found' });
    }

    reply.header('Cache-Control', 'public, max-age=86400'); // frames never change
    reply.type('image/jpeg');
    return fs.createReadStream(filePath);
  });

  // GET /api/teslacam/segments/:id/frames/:num.json
  // Serve cached frame metadata
  fastify.get('/segments/:id/frames/:num.json', async (request, reply) => {
    const { id, num } = request.params;
    const frameNum = parseInt(num);
    if (isNaN(frameNum) || frameNum < 1 || frameNum > 15) {
      return reply.code(400).send({ error: 'Frame number must be 1-15' });
    }

    const filePath = path.join(
      teslacamSync.getSegmentDir(id),
      'frame_' + String(frameNum).padStart(3, '0') + '.json'
    );

    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'Frame metadata not found' });
    }

    reply.header('Cache-Control', 'public, max-age=86400');
    reply.type('application/json');
    return fs.createReadStream(filePath);
  });
}

module.exports = teslacamRoutes;
