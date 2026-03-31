const db = require('../services/database');
const { authHook } = require('../utils/jwt');
const logger = require('../utils/logger').child({ module: 'reports' });

const ALLOWED_ENTITY_TYPES = ['camera', 'video_message', 'broadcast', 'comment'];
const ALLOWED_REASONS = ['inappropriate', 'spam', 'misleading', 'other'];

async function reportRoutes(fastify, options) {

  // Rate limit: 5 reports per 10 minutes
  const reportRateLimit = {
    config: {
      rateLimit: { max: 5, timeWindow: '10 minutes' }
    }
  };

  // POST /:entityType/:entityId - Submit report (auth required)
  fastify.post('/:entityType/:entityId', { preHandler: authHook, ...reportRateLimit }, async (request, reply) => {
    const { entityType, entityId } = request.params;

    if (!ALLOWED_ENTITY_TYPES.includes(entityType)) {
      return reply.code(400).send({ error: 'Invalid entity type' });
    }

    if (!entityId || entityId.length > 64) {
      return reply.code(400).send({ error: 'Invalid entity ID' });
    }

    const { reason, detail } = request.body || {};

    if (!reason || !ALLOWED_REASONS.includes(reason)) {
      return reply.code(400).send({ error: 'Invalid reason' });
    }

    if (detail && (typeof detail !== 'string' || detail.length > 500)) {
      return reply.code(400).send({ error: 'Detail too long' });
    }

    try {
      const result = await db.createReport(request.user.userId, entityType, entityId, reason, detail);

      if (!result.success && result.duplicate) {
        return reply.code(409).send({ error: 'already_reported' });
      }

      if (!result.success) {
        return reply.code(500).send({ error: 'Report failed' });
      }

      return { status: 'ok', reportId: result.reportId };
    } catch (error) {
      logger.error({ err: error, entityType, entityId }, 'Report submit failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /:entityType/:entityId - Check if current user already reported (auth required)
  fastify.get('/:entityType/:entityId', { preHandler: authHook }, async (request, reply) => {
    const { entityType, entityId } = request.params;

    if (!ALLOWED_ENTITY_TYPES.includes(entityType)) {
      return reply.code(400).send({ error: 'Invalid entity type' });
    }

    if (!entityId || entityId.length > 64) {
      return reply.code(400).send({ error: 'Invalid entity ID' });
    }

    try {
      const result = await db.getReportStatus(entityType, entityId, request.user.userId);
      return result;
    } catch (error) {
      logger.error({ err: error, entityType, entityId }, 'Report status check failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}

module.exports = reportRoutes;
