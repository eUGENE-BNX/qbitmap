const buildServer = require('./src/server');
const config = require('./src/config');
const { cleanupTokenCache } = require('./src/utils/jwt');

let fastify;

async function start() {
  try {
    fastify = await buildServer();

    await fastify.listen({
      host: config.server.host,
      port: config.server.port
    });

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

  // Cleanup token cache
  cleanupTokenCache();

  // Close Fastify server
  if (fastify) {
    await fastify.close();
  }

  console.log('Server closed');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
