// Installs the shared keep-alive dispatcher as the global undici dispatcher.
// Required first so the side effect runs before any other module can
// trigger an outbound fetch at require-time.
require('./src/utils/http-agent');

const buildServer = require('./src/server');
const config = require('./src/config');
const { cleanupTokenCache } = require('./src/utils/jwt');
const dbPool = require('./src/services/db-pool');
const photoAiQueue = require('./src/services/photo-ai-queue');
const videoAiQueue = require('./src/services/video-ai-queue');
const wsService = require('./src/services/websocket');
const cleanupService = require('./src/services/cleanup');
const teslacamSync = require('./src/services/teslacam-sync');
const voiceCallService = require('./src/services/voice-call');
const db = require('./src/services/database');
const metrics = require('./src/services/metrics');
const { runStartupChecks } = require('./src/utils/startup-checks');
const logger = require('./src/utils/logger').child({ module: 'main' });

let fastify;

// Catch unhandled errors to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});

async function start() {
  try {
    fastify = await buildServer();

    await fastify.listen({
      host: config.server.host,
      port: config.server.port
    });

    // Start DB-backed AI analysis queues with WebSocket notification
    const onAiComplete = async (messageId, jobType, subId) => {
      console.log(`[AI Queue] Completed ${jobType}#${subId} for ${messageId}, broadcasting WS event`);
      let aiDescription = null, aiDescriptionLang = null;
      try {
        const msg = await db.getVideoMessageById(messageId);
        if (jobType === 'photo' && msg) {
          const photo = (msg.photos || []).find(p => p.idx === subId);
          aiDescription = photo?.ai_description || null;
          aiDescriptionLang = photo?.ai_description_lang || null;
        } else if (msg) {
          aiDescription = msg.ai_description || null;
          aiDescriptionLang = msg.ai_description_lang || null;
        }
      } catch (e) {
        // Non-fatal: client can refetch if payload lacks the text
      }
      wsService.broadcast({
        type: 'ai_description_ready',
        payload: {
          messageId,
          jobType,
          photoIdx: jobType === 'photo' ? subId : null,
          aiDescription,
          aiDescriptionLang
        }
      });
    };
    photoAiQueue.setOnComplete(onAiComplete);
    videoAiQueue.setOnComplete(onAiComplete);
    photoAiQueue.start();
    videoAiQueue.start();

    // Sample AI queue depth into prom-client gauges. Runs on a timer so each
    // Prometheus scrape reads cached values instead of round-tripping to DB.
    metrics.startAiQueueSampler();

    // Non-blocking upstream reachability probes. Logs warn if H3/MediaMTX
    // are unreachable so the on-call sees it in the boot log instead of
    // learning from the first user request.
    runStartupChecks();

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
  logger.info(`${signal} received, shutting down gracefully...`);

  // Stop AI queues
  photoAiQueue.stop();
  videoAiQueue.stop();

  // Stop metrics sampler so its interval doesn't keep sampling against a
  // closing DB pool.
  metrics.stopAiQueueSampler();

  // Stop periodic services
  cleanupService.stop();
  teslacamSync.stop();
  voiceCallService.shutdown();

  // Cleanup caches and timers
  cleanupTokenCache();
  if (db.accessCacheCleanupInterval) {
    clearInterval(db.accessCacheCleanupInterval);
    db.accessCacheCleanupInterval = null;
  }

  // Drain WebSocket connections BEFORE the HTTP server goes away.
  // shutdown() flips shuttingDown → notifies clients → waits up to 10s for
  // them to close → force-closes the rest with 1001. If we let fastify.close
  // tear down the server first, sockets would see reset-connection noise
  // instead of a clean "closing" frame.
  await wsService.shutdown();

  // Close Fastify server (also triggers onClose hook for mediamtx interval)
  if (fastify) {
    await fastify.close();
  }

  // Close MySQL connection pool
  try {
    await dbPool.end();
    logger.info('Database pool closed');
  } catch (err) {
    logger.error({ err }, 'Error closing database pool');
  }

  logger.info('Server closed');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
