const db = require('../services/database');
const wsService = require('../services/websocket');
const voiceCallService = require('../services/voice-call');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const { authHook } = require('../utils/jwt');
const { validateBody, addOnvifCameraSchema, linkCameraSchema, webhookEventSchema } = require('../utils/validation');
const logger = require('../utils/logger').child({ module: 'onvif' });
const { TIMEOUTS } = require('../config/constants');
const { services } = require('../config');

const WEBHOOK_ALLOWED_IPS = services.webhookAllowedIps;

/**
 * ONVIF Integration API Routes
 * Handles ONVIF camera templates, links, events, and webhooks
 */
async function onvifRoutes(fastify, options) {

  // [SECURITY] Require auth for all ONVIF routes except webhook
  fastify.addHook('preHandler', async (request, reply) => {
    // Webhook uses IP-based auth instead
    if (request.url.includes('/webhook/')) return;
    return authHook(request, reply);
  });

  // ==================== ONVIF TEMPLATE ROUTES ====================

  /**
   * GET /api/onvif/templates
   * Get all available ONVIF camera templates
   */
  fastify.get('/templates', async (request, reply) => {
    try {
      const templates = await db.getOnvifTemplates();
      return {
        templates: templates.map(t => ({
          id: t.id,
          modelName: t.model_name,
          manufacturer: t.manufacturer,
          onvifPort: t.onvif_port,
          supportedEvents: JSON.parse(t.supported_events)
        }))
      };
    } catch (error) {
      logger.error({ err: error }, 'Failed to get templates');
      return reply.code(500).send({ error: 'Failed to get templates' });
    }
  });

  // ==================== ONVIF CAMERA ROUTES ====================

  /**
   * GET /api/onvif/available-cameras
   * Get list of available ONVIF cameras from the ONVIF service
   */
  fastify.get('/available-cameras', async (request, reply) => {
    try {
      const onvifServiceUrl = services.onvifServiceUrl;

      const response = await fetchWithTimeout(`${onvifServiceUrl}/cameras`, {}, TIMEOUTS.ONVIF_DEFAULT);

      if (!response.ok) {
        logger.error({ status: response.status }, 'Failed to fetch cameras from ONVIF service');
        return reply.code(502).send({ error: 'Failed to fetch cameras from ONVIF service' });
      }

      const data = await response.json();

      return {
        cameras: data.cameras || []
      };
    } catch (error) {
      logger.error({ err: error }, 'Failed to fetch available cameras');
      return reply.code(500).send({ error: 'Failed to fetch available cameras' });
    }
  });

  /**
   * POST /api/onvif/cameras
   * Register a new ONVIF camera to the ONVIF service
   * Body: { id, name, host, port, username, password }
   */
  fastify.post('/cameras', {
    preHandler: validateBody(addOnvifCameraSchema)
  }, async (request, reply) => {
    const { id, name, host, port, username, password } = request.body;

    try {
      const onvifServiceUrl = services.onvifServiceUrl;

      const response = await fetchWithTimeout(`${onvifServiceUrl}/cameras`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, host, port: parseInt(port), username, password })
      }, TIMEOUTS.ONVIF_CREATE);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error({ status: response.status, cameraId: id, error: errorData }, 'Failed to add camera to ONVIF service');
        return reply.code(response.status).send(errorData);
      }

      const data = await response.json();
      logger.info({ cameraId: id }, 'Camera added to ONVIF service');

      return {
        success: true,
        camera: data.camera
      };
    } catch (error) {
      logger.error({ err: error }, 'Failed to add camera to ONVIF service');
      return reply.code(500).send({ error: 'Failed to add camera to ONVIF service' });
    }
  });

  // ==================== ONVIF LINK ROUTES ====================

  /**
   * POST /api/onvif/link
   * Link a QBitmap camera to an ONVIF camera
   * Body: { qbitmapCameraId, onvifCameraId, templateId }
   */
  fastify.post('/link', {
    preHandler: validateBody(linkCameraSchema)
  }, async (request, reply) => {
    const { qbitmapCameraId, onvifCameraId, templateId = 1 } = request.body;

    try {
      // Verify QBitmap camera exists
      const camera = await db.getCameraById(qbitmapCameraId);
      if (!camera) {
        return reply.code(404).send({ error: 'QBitmap camera not found' });
      }

      // Create link
      const result = await db.createOnvifLink(qbitmapCameraId, onvifCameraId, templateId);

      if (!result.success) {
        return reply.code(500).send({ error: result.error || 'Failed to create link' });
      }

      logger.info({ qbitmapCameraId, onvifCameraId }, 'Camera linked to ONVIF');

      return {
        success: true,
        message: 'Camera linked successfully'
      };
    } catch (error) {
      logger.error({ err: error, qbitmapCameraId, onvifCameraId }, 'Failed to create link');
      return reply.code(500).send({ error: 'Failed to create link' });
    }
  });

  /**
   * GET /api/onvif/link/:cameraId
   * Get ONVIF link for a QBitmap camera
   */
  fastify.get('/link/:cameraId', async (request, reply) => {
    const { cameraId } = request.params;

    try {
      const link = await db.getOnvifLink(parseInt(cameraId));

      if (!link) {
        // Return 200 with null link instead of 404 to avoid console errors
        return { link: null };
      }

      return {
        qbitmapCameraId: link.qbitmap_camera_id,
        onvifCameraId: link.onvif_camera_id,
        templateId: link.onvif_template_id,
        modelName: link.model_name,
        manufacturer: link.manufacturer,
        supportedEvents: JSON.parse(link.supported_events),
        createdAt: link.created_at
      };
    } catch (error) {
      logger.error({ err: error, cameraId }, 'Failed to get link');
      return reply.code(500).send({ error: 'Failed to get link' });
    }
  });

  /**
   * PUT /api/onvif/link/:cameraId
   * Update ONVIF link template (change profile)
   * Body: { templateId }
   */
  fastify.put('/link/:cameraId', async (request, reply) => {
    const { cameraId } = request.params;
    const { templateId } = request.body;

    if (!templateId) {
      return reply.code(400).send({ error: 'templateId is required' });
    }

    try {
      // Verify template exists
      const template = await db.getOnvifTemplateById(templateId);
      if (!template) {
        return reply.code(404).send({ error: 'Template not found' });
      }

      // Get existing link to find onvifCameraId
      const link = await db.getOnvifLink(parseInt(cameraId));
      if (!link) {
        return reply.code(404).send({ error: 'ONVIF link not found' });
      }

      // Update template in database
      const result = await db.updateOnvifLinkTemplate(parseInt(cameraId), templateId);

      if (!result.success) {
        return reply.code(500).send({ error: result.error || 'Failed to update link' });
      }

      // Update profile in onvif-events service
      const onvifServiceUrl = services.onvifServiceUrl;
      const profileSlug = template.model_name.toLowerCase().replace(/\s+/g, '-');

      try {
        const onvifResponse = await fetchWithTimeout(`${onvifServiceUrl}/cameras/${link.onvif_camera_id}/profile`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: profileSlug })
        }, TIMEOUTS.ONVIF_DEFAULT);

        if (!onvifResponse.ok) {
          logger.warn({ cameraId, onvifCameraId: link.onvif_camera_id, status: onvifResponse.status }, 'Failed to update profile in ONVIF service (continuing anyway)');
        } else {
          logger.info({ cameraId, onvifCameraId: link.onvif_camera_id, profileSlug }, 'Profile updated in ONVIF service');
        }
      } catch (onvifError) {
        logger.warn({ err: onvifError, cameraId }, 'ONVIF service unavailable for profile update (continuing anyway)');
      }

      logger.info({ cameraId, templateId, profileSlug }, 'ONVIF link template updated');

      return {
        success: true,
        message: 'Profile updated successfully',
        template: {
          id: template.id,
          modelName: template.model_name,
          manufacturer: template.manufacturer
        }
      };
    } catch (error) {
      logger.error({ err: error, cameraId }, 'Failed to update link');
      return reply.code(500).send({ error: 'Failed to update link' });
    }
  });

  /**
   * DELETE /api/onvif/link/:cameraId
   * Remove ONVIF link for a QBitmap camera
   */
  fastify.delete('/link/:cameraId', async (request, reply) => {
    const { cameraId } = request.params;

    try {
      const result = await db.deleteOnvifLink(parseInt(cameraId));

      if (!result.success) {
        return reply.code(500).send({ error: result.error || 'Failed to delete link' });
      }

      logger.info({ cameraId }, 'Camera unlinked from ONVIF');

      return {
        success: true,
        message: 'Link removed successfully'
      };
    } catch (error) {
      logger.error({ err: error, cameraId }, 'Failed to delete link');
      return reply.code(500).send({ error: 'Failed to delete link' });
    }
  });

  // ==================== ONVIF EVENT ROUTES ====================

  /**
   * POST /api/onvif/webhook/event
   * Receive ONVIF events from the ONVIF service via webhook
   * Body: { onvifCameraId, eventType, eventState, eventData }
   */
  fastify.post('/webhook/event', {
    config: {
      rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: (req) => req.ip }
    },
    preHandler: [
      async (request, reply) => {
        const clientIp = request.ip;
        if (!WEBHOOK_ALLOWED_IPS.includes(clientIp)) {
          logger.warn({ clientIp }, 'Unauthorized webhook source');
          return reply.code(403).send({ error: 'Unauthorized webhook source' });
        }
      },
      validateBody(webhookEventSchema)
    ]
  }, async (request, reply) => {
    const { onvifCameraId, eventType, eventState, eventData } = request.body;

    // Debug: Log incoming webhook with onvifCameraId
    logger.info({ onvifCameraId, eventType, eventState }, '[WEBHOOK] Incoming ONVIF event');

    try {
      // Find linked QBitmap camera
      const link = await db.getOnvifLinkByOnvifId(onvifCameraId);
      logger.info({ onvifCameraId, linkedQbitmapCameraId: link?.qbitmap_camera_id }, '[WEBHOOK] Link lookup result');

      if (!link) {
        logger.warn({ onvifCameraId }, 'Webhook event for unlinked camera');
        return reply.code(404).send({ error: 'Camera not linked to QBitmap' });
      }

      const qbitmapCameraId = link.qbitmap_camera_id;

      // Save event to database
      const eventId = await db.saveOnvifEvent(qbitmapCameraId, eventType, eventState, eventData);

      if (!eventId) {
        logger.error({ cameraId: qbitmapCameraId, eventType }, 'Failed to save event');
        return reply.code(500).send({ error: 'Failed to save event' });
      }

      // Get camera details for WebSocket broadcast
      const camera = await db.getCameraById(qbitmapCameraId);

      // Broadcast to WebSocket clients
      wsService.broadcastOnvifEvent({
        cameraId: qbitmapCameraId,
        deviceId: camera.device_id,
        eventType,
        eventState,
        timestamp: new Date().toISOString()
      });

      logger.info({ onvifCameraId, deviceId: camera.device_id, eventType, eventState }, 'ONVIF event received');

      // Voice call trigger for motion and human events
      if (eventState && (eventType === 'motion' || eventType === 'human')) {
        // Check if voice call is enabled for this camera
        const voiceCallEnabled = await db.getVoiceCallEnabled(qbitmapCameraId);

        if (voiceCallEnabled) {
          // Trigger voice call asynchronously (don't block webhook response)
          setImmediate(async () => {
            try {
              const callResult = await voiceCallService.initiateCall(
                camera.device_id,
                camera.name || camera.device_id,
                eventType
              );

              if (callResult.success) {
                logger.info({ deviceId: camera.device_id, callId: callResult.callId }, 'Voice call triggered');
              } else {
                logger.info({ deviceId: camera.device_id, reason: callResult.reason }, 'Voice call not triggered');
              }
            } catch (err) {
              logger.error({ err, deviceId: camera.device_id }, 'Voice call trigger error');
            }
          });
        }
      }

      return {
        success: true,
        eventId
      };
    } catch (error) {
      logger.error({ err: error, onvifCameraId, eventType }, 'Webhook processing error');
      return reply.code(500).send({ error: 'Failed to process webhook' });
    }
  });

  /**
   * GET /api/onvif/events/:cameraId
   * Get ONVIF event history for a camera
   */
  fastify.get('/events/:cameraId', async (request, reply) => {
    const { cameraId } = request.params;
    const { limit = 100 } = request.query;

    try {
      const events = await db.getOnvifEvents(parseInt(cameraId), parseInt(limit));

      return {
        cameraId: parseInt(cameraId),
        events: events.map(e => ({
          id: e.id,
          eventType: e.event_type,
          eventState: !!e.event_state,
          data: e.event_data ? JSON.parse(e.event_data) : null,
          timestamp: e.timestamp
        }))
      };
    } catch (error) {
      logger.error({ err: error, cameraId }, 'Failed to get events');
      return reply.code(500).send({ error: 'Failed to get events' });
    }
  });

  /**
   * GET /api/onvif/links
   * Get all ONVIF links (for debugging)
   */
  fastify.get('/links', async (request, reply) => {
    try {
      const links = await db.getAllOnvifLinks();
      return {
        links: links.map(l => ({
          qbitmapCameraId: l.qbitmap_camera_id,
          deviceId: l.device_id,
          cameraName: l.name,
          onvifCameraId: l.onvif_camera_id,
          templateId: l.onvif_template_id,
          modelName: l.model_name
        }))
      };
    } catch (error) {
      logger.error({ err: error }, 'Failed to get links');
      return reply.code(500).send({ error: 'Failed to get links' });
    }
  });

  /**
   * GET /api/onvif/events
   * Get recent ONVIF events for all cameras
   */
  fastify.get('/events', async (request, reply) => {
    const { limit = 50 } = request.query;

    try {
      const events = await db.getAllRecentOnvifEvents(parseInt(limit));

      return {
        events: events.map(e => ({
          id: e.id,
          cameraId: e.camera_id,
          deviceId: e.device_id,
          cameraName: e.name,
          eventType: e.event_type,
          eventState: !!e.event_state,
          data: e.event_data ? JSON.parse(e.event_data) : null,
          timestamp: e.timestamp
        }))
      };
    } catch (error) {
      logger.error({ err: error }, 'Failed to get all events');
      return reply.code(500).send({ error: 'Failed to get events' });
    }
  });
}

module.exports = onvifRoutes;
