const db = require('../services/database');
const logger = require('../utils/logger').child({ module: 'view-counts' });

const ALLOWED_ENTITY_TYPES = ['video_message', 'camera'];

async function viewCountRoutes(fastify, options) {

  // POST /:entityType/:entityId - Increment view count (no auth required)
  fastify.post('/:entityType/:entityId', async (request, reply) => {
    const { entityType, entityId } = request.params;

    if (!ALLOWED_ENTITY_TYPES.includes(entityType)) {
      return reply.code(400).send({ error: 'Invalid entity type' });
    }

    if (!entityId || entityId.length > 64) {
      return reply.code(400).send({ error: 'Invalid entity ID' });
    }

    try {
      await db.incrementViewCount(entityType, entityId);
      return { status: 'ok' };
    } catch (error) {
      logger.error({ err: error, entityType, entityId }, 'View count increment failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}

module.exports = viewCountRoutes;
