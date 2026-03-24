const buildServer = require('./src/server');
const config = require('./src/config');
const { cleanupTokenCache } = require('./src/utils/jwt');
const dbPool = require('./src/services/db-pool');
const photoAiQueue = require('./src/services/photo-ai-queue');
const videoAiQueue = require('./src/services/video-ai-queue');
const wsService = require('./src/services/websocket');

let fastify;

async function start() {
  try {
    fastify = await buildServer();

    await fastify.listen({
      host: config.server.host,
      port: config.server.port
    });

    // Start DB-backed AI analysis queues with WebSocket notification
    const onAiComplete = (messageId, jobType) => {
      console.log(`[AI Queue] Completed ${jobType} analysis for ${messageId}, broadcasting WS event`);
      wsService.broadcast({
        type: 'ai_description_ready',
        payload: { messageId, jobType }
      });
    };
    photoAiQueue.setOnComplete(onAiComplete);
    videoAiQueue.setOnComplete(onAiComplete);
    photoAiQueue.start();
    videoAiQueue.start();

    console.log(`
╔═══════════════════════════════════════════════╗
║  QBitmap Backend Server                       ║
║  Running on: http://${config.server.host}:${config.server.port}     ║
╚═══════════════════════════════════════════════╝
    `);

  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
}

// Graceful shutdown handler
async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);

  // Stop AI queues
  photoAiQueue.stop();
  videoAiQueue.stop();

  // Cleanup token cache
  cleanupTokenCache();

  // Close Fastify server
  if (fastify) {
    await fastify.close();
  }

  // Close MySQL connection pool
  try {
    await dbPool.end();
    console.log('Database pool closed');
  } catch (err) {
    console.error('Error closing database pool:', err);
  }

  console.log('Server closed');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
