const db = require('../services/database');
const { authHook, optionalAuthHook } = require('../utils/jwt');
const logger = require('../utils/logger').child({ module: 'likes' });

const ALLOWED_ENTITY_TYPES = ['video_message'];

async function likeRoutes(fastify, options) {

  // POST /:entityType/:entityId - Toggle like (auth required)
  fastify.post('/:entityType/:entityId', { preHandler: authHook }, async (request, reply) => {
    const { entityType, entityId } = request.params;

    if (!ALLOWED_ENTITY_TYPES.includes(entityType)) {
      return reply.code(400).send({ error: 'Invalid entity type' });
    }

    if (!entityId || entityId.length > 64) {
      return reply.code(400).send({ error: 'Invalid entity ID' });
    }

    try {
      const result = await db.toggleLike(request.user.id, entityType, entityId);
      return result;
    } catch (error) {
      logger.error({ err: error, entityType, entityId }, 'Like toggle failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /:entityType/:entityId - Get like count + user status (optional auth)
  fastify.get('/:entityType/:entityId', { preHandler: optionalAuthHook }, async (request, reply) => {
    const { entityType, entityId } = request.params;

    if (!ALLOWED_ENTITY_TYPES.includes(entityType)) {
      return reply.code(400).send({ error: 'Invalid entity type' });
    }

    if (!entityId || entityId.length > 64) {
      return reply.code(400).send({ error: 'Invalid entity ID' });
    }

    try {
      const userId = request.user?.id || null;
      const result = await db.getLikeStatus(entityType, entityId, userId);
      return result;
    } catch (error) {
      logger.error({ err: error, entityType, entityId }, 'Like status fetch failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}

module.exports = likeRoutes;
