const buildServer = require('./src/server');

let fastify;

async function start() {
  try {
    fastify = await buildServer();
    await fastify.listen({ host: '0.0.0.0', port: process.env.PORT || 3100 });
    console.log(`H3 Grid Service running on port ${process.env.PORT || 3100}`);
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  if (fastify) await fastify.close();
  const pool = require('./src/services/db-pool');
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
