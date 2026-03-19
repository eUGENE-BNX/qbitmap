const Fastify = require('fastify');
const cors = require('@fastify/cors');
const compress = require('@fastify/compress');
const rateLimit = require('@fastify/rate-limit');
const config = require('./config');

async function buildServer() {
  const fastify = Fastify({
    logger: process.env.NODE_ENV === 'production'
      ? { level: 'info' }
      : { level: 'info', transport: { target: 'pino-pretty' } }
  });

  await fastify.register(cors, {
    origin: config.cors.origin,
    credentials: config.cors.credentials,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
  });

  await fastify.register(compress, { threshold: 1024 });
  await fastify.register(rateLimit, { max: 200, timeWindow: '1 minute' });

  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'h3-grid',
    timestamp: new Date().toISOString()
  }));

  await fastify.register(require('./routes/hexagons'), { prefix: '/api/v1/hexagons' });
  await fastify.register(require('./routes/sync'), { prefix: '/api/v1/sync' });

  return fastify;
}

module.exports = buildServer;
