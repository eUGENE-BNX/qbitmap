const Fastify = require('fastify');
const config = require('./config');
const cameraManager = require('./camera-manager');
const eventStore = require('./event-store');

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

  // Health check
  fastify.get('/health', async (request, reply) => {
    const stats = cameraManager.getStats();
    return {
      status: 'ok',
      cameras: stats.total,
      connected: stats.connected,
      uptime: process.uptime()
    };
  });

  // ==================== CAMERA ROUTES ====================

  // List all cameras
  fastify.get('/cameras', async (request, reply) => {
    return {
      cameras: cameraManager.getAll()
    };
  });

  // Add a new camera
  fastify.post('/cameras', async (request, reply) => {
    const { id, name, host, port, username, password } = request.body || {};

    // Validation
    if (!id || !host || !port || !username || !password) {
      return reply.code(400).send({
        error: 'Missing required fields',
        required: ['id', 'host', 'port', 'username', 'password'],
        optional: ['name']
      });
    }

    try {
      const camera = await cameraManager.add({
        id,
        name: name || id,
        host,
        port: parseInt(port),
        username,
        password
      });

      return {
        status: 'ok',
        message: `Camera ${id} added`,
        camera
      };
    } catch (error) {
      return reply.code(400).send({
        error: error.message
      });
    }
  });

  // Get camera info
  fastify.get('/cameras/:id', async (request, reply) => {
    const { id } = request.params;
    const camera = cameraManager.getInfo(id);

    if (!camera) {
      return reply.code(404).send({ error: 'Camera not found' });
    }

    return { camera };
  });

  // Remove a camera
  fastify.delete('/cameras/:id', async (request, reply) => {
    const { id } = request.params;

    try {
      cameraManager.remove(id);
      return {
        status: 'ok',
        message: `Camera ${id} removed`
      };
    } catch (error) {
      return reply.code(404).send({
        error: error.message
      });
    }
  });

  // ==================== EVENT ROUTES ====================

  // Get all events from all cameras
  fastify.get('/events', async (request, reply) => {
    return {
      events: eventStore.getAll()
    };
  });

  // Get events for a specific camera
  fastify.get('/events/:cameraId', async (request, reply) => {
    const { cameraId } = request.params;
    const events = eventStore.getByCamera(cameraId);

    return {
      cameraId,
      count: events.length,
      events
    };
  });

  // Get latest event for a specific camera
  fastify.get('/events/:cameraId/latest', async (request, reply) => {
    const { cameraId } = request.params;
    const latest = eventStore.getLatest(cameraId);

    if (!latest) {
      return reply.code(404).send({
        error: 'No events for this camera'
      });
    }

    return {
      cameraId,
      event: latest
    };
  });

  // Clear events for a camera
  fastify.delete('/events/:cameraId', async (request, reply) => {
    const { cameraId } = request.params;
    eventStore.clear(cameraId);

    return {
      status: 'ok',
      message: `Events cleared for camera ${cameraId}`
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

    console.log(`[ONVIF] Event listener running on port ${config.server.port}`);

    // Load cameras from file after server starts
    await cameraManager.loadFromFile();

    return server;
  } catch (error) {
    console.error('[ONVIF] Failed to start server:', error);
    process.exit(1);
  }
}

module.exports = { createServer, startServer };
