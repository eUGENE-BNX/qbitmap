const db = require('../../services/database');
const { safePath, parseId } = require('../../utils/validation');
const logger = require('../../utils/logger').child({ module: 'admin-cameras' });

module.exports = async function(fastify) {

  // ==================== ONVIF TEMPLATES ====================

  /**
   * GET /api/admin/onvif-templates
   * List all ONVIF camera templates
   */
  fastify.get('/onvif-templates', async (request, reply) => {
    const templates = await db.getOnvifTemplates();
    return {
      templates: templates.map(t => ({
        id: t.id,
        modelName: t.model_name,
        manufacturer: t.manufacturer,
        onvifPort: t.onvif_port,
        supportedEvents: JSON.parse(t.supported_events || '[]'),
        createdAt: t.created_at
      }))
    };
  });

  /**
   * GET /api/admin/onvif-templates/:templateId
   * Get single ONVIF template details
   */
  fastify.get('/onvif-templates/:templateId', async (request, reply) => {
    const { templateId } = request.params;
    const template = await db.getOnvifTemplateById(parseInt(templateId));

    if (!template) {
      return reply.code(404).send({ error: 'Template not found' });
    }

    return {
      id: template.id,
      modelName: template.model_name,
      manufacturer: template.manufacturer,
      onvifPort: template.onvif_port,
      supportedEvents: JSON.parse(template.supported_events || '[]'),
      createdAt: template.created_at
    };
  });

  /**
   * POST /api/admin/onvif-templates
   * Create a new ONVIF template
   * Body: { modelName, manufacturer, onvifPort, supportedEvents[] }
   */
  fastify.post('/onvif-templates', async (request, reply) => {
    const { modelName, manufacturer, onvifPort, supportedEvents } = request.body;

    if (!modelName || !manufacturer) {
      return reply.code(400).send({ error: 'modelName and manufacturer are required' });
    }

    const result = await db.createOnvifTemplate({
      modelName,
      manufacturer,
      onvifPort: onvifPort || 80,
      supportedEvents: supportedEvents || ['motion']
    });

    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    return { success: true, template: result.template };
  });

  /**
   * PUT /api/admin/onvif-templates/:templateId
   * Update an ONVIF template
   */
  fastify.put('/onvif-templates/:templateId', async (request, reply) => {
    const { templateId } = request.params;
    const { modelName, manufacturer, onvifPort, supportedEvents } = request.body;

    const template = await db.getOnvifTemplateById(parseInt(templateId));
    if (!template) {
      return reply.code(404).send({ error: 'Template not found' });
    }

    const result = await db.updateOnvifTemplate(parseInt(templateId), {
      modelName,
      manufacturer,
      onvifPort,
      supportedEvents
    });

    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    return { success: true, template: await db.getOnvifTemplateById(parseInt(templateId)) };
  });

  /**
   * DELETE /api/admin/onvif-templates/:templateId
   * Delete an ONVIF template
   */
  fastify.delete('/onvif-templates/:templateId', async (request, reply) => {
    const { templateId } = request.params;

    // Don't allow deleting default template (id=1)
    if (parseInt(templateId) === 1) {
      return reply.code(400).send({ error: 'Cannot delete default template' });
    }

    const template = await db.getOnvifTemplateById(parseInt(templateId));
    if (!template) {
      return reply.code(404).send({ error: 'Template not found' });
    }

    const result = await db.deleteOnvifTemplate(parseInt(templateId));

    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    return { success: true };
  });

  // ==================== CITY CAMERAS ====================

  /**
   * GET /api/admin/cameras/city
   * List all city cameras
   */
  fastify.get('/cameras/city', async (request, reply) => {
    const cameras = await db.getCityCameras();
    return { cameras };
  });

  /**
   * POST /api/admin/cameras/city
   * Create a city camera (HLS source)
   * Body: { name, hls_url, lat?, lng? }
   */
  fastify.post('/cameras/city', async (request, reply) => {
    const { name, hls_url, lat, lng } = request.body;

    // Validate HLS URL
    if (!hls_url) {
      return reply.code(400).send({ error: 'hls_url is required' });
    }

    // Basic URL validation
    try {
      const url = new URL(hls_url);
      if (!url.pathname.endsWith('.m3u8')) {
        return reply.code(400).send({ error: 'URL must end with .m3u8' });
      }
      if (!['http:', 'https:'].includes(url.protocol)) {
        return reply.code(400).send({ error: 'URL must use HTTP or HTTPS' });
      }
    } catch (e) {
      return reply.code(400).send({ error: 'Invalid URL format' });
    }

    // Generate MediaMTX path
    const mediamtx = require('../../services/mediamtx');
    const pathName = mediamtx.generatePathName(request.user.userId);

    try {
      // Add HLS source to MediaMTX
      const mediamtxResult = await mediamtx.addHlsPath(pathName, hls_url);

      if (!mediamtxResult.success) {
        return reply.code(502).send({
          error: 'Failed to add HLS source to streaming server',
          details: mediamtxResult.error
        });
      }

      // Create camera in database
      const whepUrl = mediamtx.getWhepUrl(pathName);
      const result = await db.createCityCamera(request.user.userId, {
        name: name || 'Şehir Kamerası',
        whepUrl,
        mediamtxPath: pathName,
        hlsSourceUrl: hls_url,
        lat: lat || null,
        lng: lng || null
      });

      if (!result.success) {
        // Rollback MediaMTX path
        await mediamtx.removePath(pathName);
        return reply.code(500).send({ error: result.error });
      }

      logger.info({
        cameraId: result.camera.id,
        name,
        pathName,
        admin: request.user.email
      }, 'City camera created');

      return { success: true, camera: result.camera };

    } catch (error) {
      logger.error({ err: error }, 'City camera creation failed');
      return reply.code(500).send({ error: 'Failed to create city camera' });
    }
  });

  /**
   * DELETE /api/admin/cameras/city/:cameraId
   * Delete a city camera
   */
  fastify.delete('/cameras/city/:cameraId', async (request, reply) => {
    const cameraId = parseId(request.params.cameraId);
    if (cameraId === null) return reply.code(400).send({ error: 'Invalid cameraId' });

    const camera = await db.getCameraById(cameraId);
    if (!camera) {
      return reply.code(404).send({ error: 'Camera not found' });
    }

    if (camera.camera_type !== 'city') {
      return reply.code(400).send({ error: 'Not a city camera' });
    }

    // Cleanup MediaMTX path
    if (camera.mediamtx_path) {
      const mediamtx = require('../../services/mediamtx');
      await mediamtx.removePath(camera.mediamtx_path);
    }

    // Delete from database
    await db.adminDeleteCamera(cameraId);

    logger.info({ cameraId, name: camera.name, admin: request.user.email }, 'City camera deleted');

    return { success: true };
  });

  /**
   * PUT /api/admin/cameras/city/:cameraId
   * Update a city camera
   * Body: { name?, lat?, lng?, ai_confidence_threshold?, ai_consecutive_frames?, ai_capture_interval_ms? }
   */
  fastify.put('/cameras/city/:cameraId', async (request, reply) => {
    const cameraId = parseId(request.params.cameraId);
    if (cameraId === null) return reply.code(400).send({ error: 'Invalid cameraId' });
    const { name, lat, lng, hls_url, ai_confidence_threshold, ai_consecutive_frames, ai_capture_interval_ms,
      ai_vision_model, ai_monitoring_prompt, ai_search_prompt, ai_max_tokens, ai_temperature } = request.body;

    const camera = await db.getCameraById(cameraId);
    if (!camera) {
      return reply.code(404).send({ error: 'Camera not found' });
    }

    if (camera.camera_type !== 'city') {
      return reply.code(400).send({ error: 'Not a city camera' });
    }

    // Handle HLS source URL update
    if (hls_url !== undefined) {
      try {
        const url = new URL(hls_url);
        if (!url.pathname.endsWith('.m3u8')) {
          return reply.code(400).send({ error: 'URL must end with .m3u8' });
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
          return reply.code(400).send({ error: 'URL must use HTTP or HTTPS' });
        }
      } catch (e) {
        return reply.code(400).send({ error: 'Invalid URL format' });
      }

      const mediamtx = require('../../services/mediamtx');

      // Remove old MediaMTX path and re-add with new URL
      if (camera.mediamtx_path) {
        await mediamtx.removePath(camera.mediamtx_path);
        const result = await mediamtx.addHlsPath(camera.mediamtx_path, hls_url);
        if (!result.success) {
          return reply.code(502).send({ error: 'Failed to update HLS source', details: result.error });
        }
      }

      // Update source URL in database
      await db.updateCameraRtspSourceUrl(cameraId, hls_url);
    }

    // Build update query for cameras table
    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name.trim());
    }
    if (lat !== undefined) {
      updates.push('lat = ?');
      params.push(parseFloat(lat));
    }
    if (lng !== undefined) {
      updates.push('lng = ?');
      params.push(parseFloat(lng));
    }

    // Update cameras table if there are basic updates
    if (updates.length > 0) {
      params.push(cameraId);
      await db.adminUpdateCamera(cameraId, updates, params);
    }

    // Handle AI settings separately (stored in camera_settings table)
    const hasAiSettings = ai_confidence_threshold !== undefined ||
                          ai_consecutive_frames !== undefined ||
                          ai_capture_interval_ms !== undefined ||
                          ai_vision_model !== undefined ||
                          ai_monitoring_prompt !== undefined ||
                          ai_search_prompt !== undefined ||
                          ai_max_tokens !== undefined ||
                          ai_temperature !== undefined;

    if (hasAiSettings) {
      // Get existing settings or create empty object
      const existingSettings = await db.getCameraSettings(cameraId);
      const currentSettings = existingSettings ? JSON.parse(existingSettings.settings_json) : {};

      // Update AI settings
      if (ai_confidence_threshold !== undefined) {
        currentSettings.ai_confidence_threshold = parseInt(ai_confidence_threshold);
      }
      if (ai_consecutive_frames !== undefined) {
        currentSettings.ai_consecutive_frames = parseInt(ai_consecutive_frames);
      }
      if (ai_capture_interval_ms !== undefined) {
        currentSettings.ai_capture_interval_ms = parseInt(ai_capture_interval_ms);
      }
      if (ai_vision_model !== undefined) {
        currentSettings.ai_vision_model = ai_vision_model;
      }
      if (ai_monitoring_prompt !== undefined) {
        currentSettings.ai_monitoring_prompt = ai_monitoring_prompt;
      }
      if (ai_search_prompt !== undefined) {
        currentSettings.ai_search_prompt = ai_search_prompt;
      }
      if (ai_max_tokens !== undefined) {
        currentSettings.ai_max_tokens = parseInt(ai_max_tokens);
      }
      if (ai_temperature !== undefined) {
        currentSettings.ai_temperature = parseFloat(ai_temperature);
      }

      // Save updated settings
      await db.updateCameraSettings(cameraId, JSON.stringify(currentSettings));
    }

    // Check if any updates were made
    if (updates.length === 0 && !hasAiSettings && hls_url === undefined) {
      return reply.code(400).send({ error: 'No updates provided' });
    }

    logger.info({
      cameraId,
      name,
      lat,
      lng,
      ai_confidence_threshold,
      ai_consecutive_frames,
      ai_capture_interval_ms,
      admin: request.user.email
    }, 'City camera updated');

    return {
      success: true,
      updated: {
        name,
        lat,
        lng,
        ai_confidence_threshold,
        ai_consecutive_frames,
        ai_capture_interval_ms
      }
    };
  });
};
