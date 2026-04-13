const db = require('../../services/database');
const { safePath, parseId } = require('../../utils/validation');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger').child({ module: 'admin-content' });

module.exports = async function(fastify) {

  // ==================== VIDEO/PHOTO MESSAGES ====================

  /**
   * GET /api/admin/messages
   * List all video/photo messages with pagination and filtering
   */
  fastify.get('/messages', async (request, reply) => {
    const { page = 1, limit = 20, media_type, search } = request.query;

    const filters = {};
    if (media_type) filters.media_type = media_type;
    if (search) filters.search = search;

    return await db.getAdminVideoMessages(parseInt(page), parseInt(limit), filters);
  });

  /**
   * DELETE /api/admin/messages/:messageId
   * Admin delete a video/photo message (with file cleanup)
   */
  fastify.delete('/messages/:messageId', async (request, reply) => {
    const { messageId } = request.params;

    const deleted = await db.adminDeleteVideoMessage(messageId);
    if (!deleted) {
      return reply.code(404).send({ error: 'Message not found' });
    }

    // Delete file from disk
    const filePath = safePath(deleted.file_path, 'uploads');
    if (filePath) { try { fs.unlinkSync(filePath); } catch {} }
    // Delete original archive if exists
    if (filePath) {
      const origPath = path.resolve(path.dirname(filePath), 'originals', path.basename(filePath));
      try { fs.unlinkSync(origPath); } catch {}
    }

    // Delete thumbnail
    if (deleted.thumbnail_path) {
      const thumbPath = safePath(deleted.thumbnail_path, 'uploads');
      if (thumbPath) { try { fs.unlinkSync(thumbPath); } catch {} }
    }

    logger.info({ messageId, admin: request.user.email }, 'Admin deleted message');
    return { success: true };
  });

  /**
   * PUT /api/admin/messages/:messageId/ai-description
   * Admin edit the AI-generated description of a message
   */
  fastify.put('/messages/:messageId/ai-description', async (request, reply) => {
    const { messageId } = request.params;
    const { text, lang } = request.body || {};

    if (typeof text !== 'string' || text.length > 2000) {
      return reply.code(400).send({ error: 'Invalid text (max 2000 chars)' });
    }

    await db.updateVideoMessageAiDescription(messageId, text.trim(), lang || null);
    await db.clearVideoMessageTranslations(messageId);

    logger.info({ messageId, admin: request.user.email }, 'Admin edited AI description');
    return { success: true };
  });

  // ==================== GOOGLE PLACES ====================

  /**
   * GET /api/admin/places
   * List all cached places with pagination and search
   */
  fastify.get('/places', async (request, reply) => {
    const { page = 1, limit = 20, search = '' } = request.query;
    return await db.getAllPlaces(parseInt(page), parseInt(limit), search);
  });

  /**
   * GET /api/admin/places/stats
   * Get places cache statistics
   */
  fastify.get('/places/stats', async (request, reply) => {
    return await db.getPlacesStats();
  });

  /**
   * DELETE /api/admin/places/cache
   * Clear all places cache (forces re-query from Google API)
   * NOTE: Must be registered before /places/:placeId to avoid route collision
   */
  fastify.delete('/places/cache', async (request, reply) => {
    await db.clearPlacesCache();
    logger.info({ admin: request.user.email }, 'Admin cleared places cache');
    return { success: true };
  });

  /**
   * PUT /api/admin/places/:placeId
   * Update a place (icon_url)
   */
  fastify.put('/places/:placeId', async (request, reply) => {
    const placeId = parseId(request.params.placeId);
    if (placeId === null) return reply.code(400).send({ error: 'Invalid placeId' });
    const { icon_url } = request.body || {};

    const place = await db.getPlaceById(placeId);
    if (!place) {
      return reply.code(404).send({ error: 'Place not found' });
    }

    await db.updatePlaceIcon(placeId, icon_url || null);
    logger.info({ placeId, admin: request.user.email }, 'Admin updated place icon');
    return { success: true };
  });

  /**
   * DELETE /api/admin/places/:placeId
   * Delete a cached place
   */
  fastify.delete('/places/:placeId', async (request, reply) => {
    const placeId = parseId(request.params.placeId);
    if (placeId === null) return reply.code(400).send({ error: 'Invalid placeId' });
    const place = await db.getPlaceById(placeId);
    if (!place) {
      return reply.code(404).send({ error: 'Place not found' });
    }

    await db.deletePlace(placeId);
    logger.info({ placeId, admin: request.user.email }, 'Admin deleted place');
    return { success: true };
  });

  // ==================== CONTENT REPORTS ====================

  /**
   * GET /api/admin/reports
   * List all content reports with pagination and filtering
   */
  fastify.get('/reports', async (request, reply) => {
    const { page = 1, limit = 20, status, entity_type, search } = request.query;

    const filters = {};
    if (status) filters.status = status;
    if (entity_type) filters.entityType = entity_type;
    if (search) filters.search = search;

    return await db.getAdminReports(parseInt(page), parseInt(limit), filters);
  });

  /**
   * PUT /api/admin/reports/:reportId
   * Resolve or dismiss a report
   */
  fastify.put('/reports/:reportId', async (request, reply) => {
    const reportId = parseId(request.params.reportId);
    if (reportId === null) return reply.code(400).send({ error: 'Invalid reportId' });
    const { action } = request.body || {};

    if (!action || !['resolve', 'dismiss'].includes(action)) {
      return reply.code(400).send({ error: 'Invalid action. Use resolve or dismiss.' });
    }

    const updated = await db.resolveReport(reportId, request.user.userId, action);
    if (!updated) {
      return reply.code(404).send({ error: 'Report not found or already processed' });
    }

    logger.info({ reportId, action, admin: request.user.email }, 'Admin processed report');
    return { success: true };
  });

  /**
   * DELETE /api/admin/reports/:reportId/content
   * Delete the reported content and resolve the report
   */
  fastify.delete('/reports/:reportId/content', async (request, reply) => {
    const reportId = parseId(request.params.reportId);
    if (reportId === null) return reply.code(400).send({ error: 'Invalid reportId' });

    const report = await db.getReportById(reportId);
    if (!report) {
      return reply.code(404).send({ error: 'Report not found' });
    }

    const { entity_type, entity_id } = report;

    try {
      if (entity_type === 'video_message') {
        const deleted = await db.adminDeleteVideoMessage(entity_id);
        if (deleted) {
          const filePath = safePath(deleted.file_path, 'uploads');
          if (filePath) { try { fs.unlinkSync(filePath); } catch {} }
          if (filePath) {
            const origPath = path.resolve(path.dirname(filePath), 'originals', path.basename(filePath));
            try { fs.unlinkSync(origPath); } catch {}
          }
          if (deleted.thumbnail_path) {
            const thumbPath = safePath(deleted.thumbnail_path, 'uploads');
            if (thumbPath) { try { fs.unlinkSync(thumbPath); } catch {} }
          }
        }
      } else if (entity_type === 'comment') {
        await db.deleteCommentAdmin(entity_id);
      }
      // camera and broadcast reports: admin reviews but content stays (cameras are infrastructure)
      // Admin can manually remove cameras from their respective tabs

      // Resolve all pending reports for this entity
      await db.resolveReportsByEntity(entity_type, entity_id, request.user.userId);

      logger.info({ reportId, entity_type, entity_id, admin: request.user.email }, 'Admin deleted reported content');
      return { success: true };
    } catch (error) {
      logger.error({ err: error, reportId }, 'Delete reported content failed');
      return reply.code(500).send({ error: 'Failed to delete content' });
    }
  });
};
