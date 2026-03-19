const Fastify = require('fastify');
const config = require('./config');
const captureManager = require('./capture-manager');
const frameStore = require('./frame-store');

async function createServer() {
  const fastify = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname'
        }
      }
    }
  });

  // Service key auth hook for state-changing endpoints
  const serviceKeyHook = async (request, reply) => {
    if (!config.serviceKey) return; // No key configured = skip auth (dev mode)
    const key = request.headers['x-service-key'];
    if (!key || key !== config.serviceKey) {
      return reply.code(403).send({ error: 'Forbidden: invalid service key' });
    }
  };

  // Health check (no auth)
  fastify.get('/health', async (request, reply) => {
    const stats = captureManager.getStats();
    return {
      status: 'ok',
      ...stats,
      uptime: process.uptime()
    };
  });

  // ==================== CAPTURE ROUTES ====================

  // Start capture
  fastify.post('/capture/start', { preHandler: serviceKeyHook }, async (request, reply) => {
    const { streamId, rtspUrl: providedUrl, interval } = request.body || {};

    if (!streamId) {
      return reply.code(400).send({
        error: 'Missing required field: streamId',
        required: ['streamId'],
        optional: ['rtspUrl', 'interval']
      });
    }

    // Use provided URL or construct from streamId
    const rtspUrl = providedUrl || `${config.capture.rtspBase}/${streamId}`;

    try {
      const result = captureManager.start(streamId, rtspUrl, interval);
      return result;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Stop capture
  fastify.post('/capture/stop', { preHandler: serviceKeyHook }, async (request, reply) => {
    const { streamId } = request.body || {};

    if (!streamId) {
      return reply.code(400).send({
        error: 'Missing required field: streamId'
      });
    }

    const result = captureManager.stop(streamId);

    if (result.status === 'not_found') {
      return reply.code(404).send(result);
    }

    return result;
  });

  // Update interval
  fastify.put('/capture/interval', { preHandler: serviceKeyHook }, async (request, reply) => {
    const { streamId, interval } = request.body || {};

    if (!streamId || !interval) {
      return reply.code(400).send({
        error: 'Missing required fields',
        required: ['streamId', 'interval']
      });
    }

    const result = captureManager.setInterval(streamId, interval);

    if (result.status === 'not_found') {
      return reply.code(404).send(result);
    }

    return result;
  });

  // ==================== STREAM ROUTES ====================

  // List all active captures
  fastify.get('/streams', async (request, reply) => {
    return {
      streams: captureManager.getAll()
    };
  });

  // Get capture info for a stream
  fastify.get('/streams/:streamId', async (request, reply) => {
    const { streamId } = request.params;
    const info = captureManager.getInfo(streamId);

    if (!info) {
      return reply.code(404).send({ error: 'Stream not found' });
    }

    return { stream: info };
  });

  // ==================== FRAME ROUTES ====================

  // Get latest frame as JPEG
  fastify.get('/frame/:streamId', async (request, reply) => {
    const { streamId } = request.params;
    const frame = frameStore.get(streamId);

    if (!frame) {
      return reply.code(404).send({ error: 'No frame available for this stream' });
    }

    reply.type('image/jpeg');
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    reply.header('X-Captured-At', frame.capturedAt.toISOString());
    return frame.buffer;
  });

  // Get latest frame as base64
  fastify.get('/frame/:streamId/base64', async (request, reply) => {
    const { streamId } = request.params;
    const frame = frameStore.getBase64(streamId);

    if (!frame) {
      return reply.code(404).send({ error: 'No frame available for this stream' });
    }

    return {
      streamId,
      base64: frame.base64,
      capturedAt: frame.capturedAt.toISOString(),
      size: frame.size
    };
  });

  return fastify;
}

async function startServer() {
  const server = await createServer();

  try {
    await server.listen({
      host: config.server.host,
      port: config.server.port
    });

    console.log(`[CAPTURE] RTSP Frame Capture Service running on port ${config.server.port}`);
    return server;
  } catch (error) {
    console.error('[CAPTURE] Failed to start server:', error);
    process.exit(1);
  }
}

module.exports = { createServer, startServer };
