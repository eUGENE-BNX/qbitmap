const db = require('../services/database');
const wsService = require('../services/websocket');
const { authHook, optionalAuthHook } = require('../utils/jwt');
const { parseId } = require('../utils/validation');
const logger = require('../utils/logger').child({ module: 'comments' });

const ALLOWED_ENTITY_TYPES = ['video_message', 'camera'];

async function commentRoutes(fastify, options) {

  // POST / - Create a comment
  fastify.post('/', {
    preHandler: authHook,
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '5 minutes'
      }
    }
  }, async (request, reply) => {
    const userId = request.user.userId;
    const { entityType, entityId, content } = request.body || {};

    // Validate entity type
    if (!ALLOWED_ENTITY_TYPES.includes(entityType)) {
      return reply.code(400).send({ error: 'Invalid entity type' });
    }

    // Validate entity ID
    if (!entityId || typeof entityId !== 'string' || entityId.length > 64) {
      return reply.code(400).send({ error: 'Invalid entity ID' });
    }

    // Validate content
    const trimmed = (content || '').trim();
    if (!trimmed || trimmed.length > 500) {
      return reply.code(400).send({ error: 'Comment must be 1-500 characters' });
    }

    try {
      const comment = await db.createComment(userId, entityType, entityId, trimmed);

      // Broadcast via WebSocket
      wsService.broadcast({
        type: 'comment_new',
        payload: {
          commentId: comment.id,
          entityType: comment.entity_type,
          entityId: comment.entity_id,
          userId: comment.user_id,
          userName: comment.user_name,
          userAvatar: comment.user_avatar,
          content: comment.content,
          createdAt: comment.created_at
        }
      });

      logger.info({ commentId: comment.id, entityType, entityId, userId }, 'Comment created');
      return reply.code(201).send({ status: 'ok', comment });

    } catch (error) {
      logger.error({ err: error }, 'Comment creation failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET / - List comments for an entity
  fastify.get('/', { preHandler: optionalAuthHook }, async (request, reply) => {
    try {
      const { entityType, entityId, limit, before } = request.query;

      if (!ALLOWED_ENTITY_TYPES.includes(entityType)) {
        return reply.code(400).send({ error: 'Invalid entity type' });
      }

      if (!entityId) {
        return reply.code(400).send({ error: 'entityId is required' });
      }

      const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 50);
      const comments = await db.getComments(entityType, entityId, {
        limit: safeLimit + 1, // fetch one extra to check hasMore
        before: before || undefined
      });

      const hasMore = comments.length > safeLimit;
      if (hasMore) comments.pop();

      return { comments, hasMore };

    } catch (error) {
      logger.error({ err: error }, 'Failed to list comments');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // DELETE /:commentId - Delete own comment
  fastify.delete('/:commentId', { preHandler: authHook }, async (request, reply) => {
    try {
      const commentId = parseId(request.params.commentId);
      if (commentId === null) {
        return reply.code(400).send({ error: 'Invalid comment ID' });
      }

      const deleted = await db.deleteComment(commentId, request.user.userId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Comment not found or not yours' });
      }

      // Broadcast deletion via WebSocket
      wsService.broadcast({
        type: 'comment_deleted',
        payload: {
          commentId: deleted.id,
          entityType: deleted.entity_type,
          entityId: deleted.entity_id
        }
      });

      logger.info({ commentId, userId: request.user.userId }, 'Comment deleted');
      return { status: 'ok' };

    } catch (error) {
      logger.error({ err: error }, 'Comment deletion failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}

module.exports = commentRoutes;
