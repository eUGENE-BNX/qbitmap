/**
 * Admin API Routes
 * All routes require admin role
 */

const db = require('../../services/database');
const { authHook } = require('../../utils/jwt');

async function adminRoutes(fastify, options) {
  // First apply auth hook to all routes
  fastify.addHook('preHandler', authHook);

  // [ARCH-02] Admin role check — pure in-memory from JWT claim.
  // Old JWTs issued before the role claim was added won't have
  // request.user.role; for those we fall back to a one-time DB lookup
  // so existing admin sessions aren't locked out. The fallback is
  // self-expiring: once all pre-deploy tokens rotate (≤7 days) the DB
  // branch never fires again.
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user?.userId) {
      return reply.code(401).send({ error: 'Authentication required' });
    }

    let role = request.user.role;
    if (role === undefined) {
      // Transitional: JWT without role claim (issued before ARCH-02)
      const user = await db.getUserById(request.user.userId);
      role = user?.role;
    }
    if (role !== 'admin') {
      return reply.code(403).send({ error: 'Admin access required' });
    }
  });

  // Inject a default per-IP rate limit on every admin route. Cloudflare
  // already enforces 30/min on /api/admin/*, but a compromised CF token
  // or a future routing change could bypass the edge — keep this layer
  // here as defense in depth. Routes that need a different limit can
  // still override by setting their own `config.rateLimit`.
  fastify.addHook('onRoute', (routeOptions) => {
    if (!routeOptions.config) routeOptions.config = {};
    if (!routeOptions.config.rateLimit) {
      routeOptions.config.rateLimit = { max: 30, timeWindow: '1 minute' };
    }
  });

  // [ARCH-07] Register route groups
  await require('./users')(fastify);
  await require('./cameras')(fastify);
  await require('./settings')(fastify);
  await require('./content')(fastify);
}

module.exports = adminRoutes;
