const push = require('../services/push');
const { authHook } = require('../utils/jwt');
const logger = require('../utils/logger').child({ module: 'push-routes' });

async function pushRoutes(fastify) {
  // Public — non-secret VAPID public key. Browser needs it before the
  // first subscribe() call; SWR-friendly so clients can safely cache.
  fastify.get('/vapid-public-key', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=3600');
    return { publicKey: push.getPublicKey() || null };
  });

  // Everything else requires the HttpOnly auth cookie.
  fastify.register(async (authScope) => {
    authScope.addHook('preHandler', authHook);

    authScope.post('/subscribe', async (request, reply) => {
      const body = request.body || {};
      const { endpoint, keys } = body;
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return reply.code(400).send({ error: 'endpoint + keys.p256dh + keys.auth required' });
      }
      try {
        await push.saveSubscription(
          request.user.userId,
          { endpoint, keys },
          String(request.headers['user-agent'] || '').slice(0, 256)
        );
      } catch (err) {
        logger.error({ err: err.message, userId: request.user.userId }, 'subscribe failed');
        return reply.code(500).send({ error: 'failed to save subscription' });
      }
      return { ok: true };
    });

    authScope.post('/unsubscribe', async (request, reply) => {
      const { endpoint } = request.body || {};
      if (!endpoint) return reply.code(400).send({ error: 'endpoint required' });
      try {
        await push.removeSubscription(request.user.userId, endpoint);
      } catch (err) {
        logger.error({ err: err.message, userId: request.user.userId }, 'unsubscribe failed');
        return reply.code(500).send({ error: 'failed to remove subscription' });
      }
      return { ok: true };
    });

    // Test endpoint — sends a no-op push to every subscription for the
    // current user. Useful from the UI ("send a test notification").
    authScope.post('/test', async (request, reply) => {
      const result = await push.sendToUser(request.user.userId, {
        title: 'QBitmap test',
        body: 'Bildirimler aktif. Her şey yolunda.',
        tag: 'push-test',
        urgency: 'normal',
        topic: 'push-test',
      });
      return { ok: true, ...result };
    });
  });
}

module.exports = pushRoutes;
