/**
 * Admin API Routes
 * All routes require admin role
 */

const db = require('../services/database');
const { authHook } = require('../utils/jwt');
const { validateBody, userOverridesSchema, adminUpdateUserSchema, adminPlanSchema, safePath, parseId } = require('../utils/validation');
const fs = require('fs');

async function adminRoutes(fastify, options) {
  // First apply auth hook to all routes
  fastify.addHook('preHandler', authHook);

  // Then check admin role
  fastify.addHook('preHandler', async (request, reply) => {
    // Check if user is authenticated (authHook sets request.user)
    if (!request.user?.userId) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    // Then check admin role
    const user = await db.getUserById(request.user.userId);
    if (!user || user.role !== 'admin') {
      return reply.status(403).send({ error: 'Admin access required' });
    }
  });

  // ==================== DASHBOARD ====================

  /**
   * GET /api/admin/stats
   * Get admin dashboard statistics
   */
  fastify.get('/stats', async (request, reply) => {
    const stats = await db.getAdminStats();
    return stats;
  });

  // ==================== USER MANAGEMENT ====================

  /**
   * GET /api/admin/users
   * List all users with pagination and filtering
   */
  fastify.get('/users', async (request, reply) => {
    const { page = 1, limit = 20, plan_id, role, is_active, search } = request.query;

    const filters = {};
    if (plan_id) filters.plan_id = parseInt(plan_id);
    if (role) filters.role = role;
    if (is_active !== undefined) filters.is_active = is_active === 'true' || is_active === '1';
    if (search) filters.search = search;

    const result = await db.getAllUsersPaginated(parseInt(page), parseInt(limit), filters);
    return result;
  });

  /**
   * GET /api/admin/users/:userId
   * Get detailed user info
   */
  fastify.get('/users/:userId', async (request, reply) => {
    const { userId } = request.params;
    const user = await db.getUserDetail(parseInt(userId));

    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    return user;
  });

  /**
   * PUT /api/admin/users/:userId
   * Update user (plan, role, active status, notes)
   */
  fastify.put('/users/:userId', {
    preHandler: validateBody(adminUpdateUserSchema)
  }, async (request, reply) => {
    const { userId } = request.params;
    const { plan_id, role, is_active, notes } = request.body;

    const user = await db.getUserById(parseInt(userId));
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    // Don't allow modifying own admin status
    if (parseInt(userId) === request.user.userId && role && role !== 'admin') {
      return reply.status(400).send({ error: 'Cannot remove your own admin role' });
    }

    // Update plan
    if (plan_id !== undefined) {
      const plan = await db.getPlanById(parseInt(plan_id));
      if (!plan) {
        return reply.status(400).send({ error: 'Invalid plan ID' });
      }
      await db.updateUserPlan(parseInt(userId), parseInt(plan_id));
    }

    // Update role
    if (role !== undefined) {
      const validRoles = ['user', 'admin'];
      if (!validRoles.includes(role)) {
        return reply.status(400).send({ error: 'Invalid role. Must be: user or admin' });
      }
      const result = await db.updateUserRole(parseInt(userId), role);
      if (!result.success) {
        return reply.status(400).send({ error: result.error });
      }
    }

    // Update active status
    if (is_active !== undefined) {
      await db.setUserActive(parseInt(userId), is_active);
    }

    // Update notes
    if (notes !== undefined) {
      await db.updateUserNotes(parseInt(userId), notes);
    }

    // Return updated user
    return await db.getUserDetail(parseInt(userId));
  });

  /**
   * DELETE /api/admin/users/:userId
   * Delete a user (soft delete by deactivating)
   */
  fastify.delete('/users/:userId', async (request, reply) => {
    const { userId } = request.params;

    // Don't allow deleting self
    if (parseInt(userId) === request.user.userId) {
      return reply.status(400).send({ error: 'Cannot delete your own account' });
    }

    const user = await db.getUserById(parseInt(userId));
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    // Soft delete by deactivating
    await db.setUserActive(parseInt(userId), false);

    return { success: true, message: 'User deactivated' };
  });

  // ==================== USER OVERRIDES ====================

  /**
   * PUT /api/admin/users/:userId/overrides
   * Set user feature overrides
   */
  fastify.put('/users/:userId/overrides', {
    preHandler: validateBody(userOverridesSchema)
  }, async (request, reply) => {
    const { userId } = request.params;
    const overrides = request.body;

    const user = await db.getUserById(parseInt(userId));
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const result = await db.setUserOverrides(parseInt(userId), overrides);

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }

    // Return updated limits
    const limits = await db.getUserEffectiveLimits(parseInt(userId));
    return { success: true, limits };
  });

  /**
   * DELETE /api/admin/users/:userId/overrides
   * Clear all user overrides (revert to plan defaults)
   */
  fastify.delete('/users/:userId/overrides', async (request, reply) => {
    const { userId } = request.params;

    const user = await db.getUserById(parseInt(userId));
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    await db.clearUserOverrides(parseInt(userId));

    // Return updated limits
    const limits = await db.getUserEffectiveLimits(parseInt(userId));
    return { success: true, limits };
  });

  // ==================== PLAN MANAGEMENT ====================

  /**
   * GET /api/admin/plans
   * List all plans
   */
  fastify.get('/plans', async (request, reply) => {
    const plans = await db.getAllPlans();

    // [PERF] Single query for all user counts instead of N+1
    const userCounts = await db.getPlanUserCounts();

    // Build lookup map
    const countMap = new Map(userCounts.map(uc => [uc.plan_id, uc.count]));

    // Add user count to each plan
    const plansWithCounts = plans.map(plan => ({
      ...plan,
      user_count: countMap.get(plan.id) || 0
    }));

    return plansWithCounts;
  });

  /**
   * GET /api/admin/plans/:planId
   * Get plan details
   */
  fastify.get('/plans/:planId', async (request, reply) => {
    const { planId } = request.params;
    const plan = await db.getPlanById(parseInt(planId));

    if (!plan) {
      return reply.status(404).send({ error: 'Plan not found' });
    }

    // Add user count
    const userCount = await db.getPlanUserCount(plan.id);

    return { ...plan, user_count: userCount };
  });

  /**
   * POST /api/admin/plans
   * Create a new plan
   */
  fastify.post('/plans', {
    preHandler: validateBody(adminPlanSchema)
  }, async (request, reply) => {
    const planData = request.body;

    // Check if name already exists
    const existing = await db.getPlanByName(planData.name);
    if (existing) {
      return reply.status(400).send({ error: 'Plan name already exists' });
    }

    const result = await db.createPlan(planData);

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }

    const plan = await db.getPlanById(result.planId);
    return { success: true, plan };
  });

  /**
   * PUT /api/admin/plans/:planId
   * Update a plan
   */
  fastify.put('/plans/:planId', {
    preHandler: validateBody(adminPlanSchema)
  }, async (request, reply) => {
    const { planId } = request.params;
    const planData = request.body;

    const plan = await db.getPlanById(parseInt(planId));
    if (!plan) {
      return reply.status(404).send({ error: 'Plan not found' });
    }

    // Don't allow changing the name of default plans
    if (planId <= 4 && planData.name && planData.name !== plan.name) {
      return reply.status(400).send({ error: 'Cannot change name of default plans' });
    }

    const result = await db.updatePlan(parseInt(planId), planData);

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }

    return { success: true, plan: await db.getPlanById(parseInt(planId)) };
  });

  /**
   * DELETE /api/admin/plans/:planId
   * Delete a plan
   */
  fastify.delete('/plans/:planId', async (request, reply) => {
    const { planId } = request.params;

    const result = await db.deletePlan(parseInt(planId));

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }

    return { success: true };
  });

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
      return reply.status(404).send({ error: 'Template not found' });
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
      return reply.status(400).send({ error: 'modelName and manufacturer are required' });
    }

    const result = await db.createOnvifTemplate({
      modelName,
      manufacturer,
      onvifPort: onvifPort || 80,
      supportedEvents: supportedEvents || ['motion']
    });

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
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
      return reply.status(404).send({ error: 'Template not found' });
    }

    const result = await db.updateOnvifTemplate(parseInt(templateId), {
      modelName,
      manufacturer,
      onvifPort,
      supportedEvents
    });

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
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
      return reply.status(400).send({ error: 'Cannot delete default template' });
    }

    const template = await db.getOnvifTemplateById(parseInt(templateId));
    if (!template) {
      return reply.status(404).send({ error: 'Template not found' });
    }

    const result = await db.deleteOnvifTemplate(parseInt(templateId));

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
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
      return reply.status(400).send({ error: 'hls_url is required' });
    }

    // Basic URL validation
    try {
      const url = new URL(hls_url);
      if (!url.pathname.endsWith('.m3u8')) {
        return reply.status(400).send({ error: 'URL must end with .m3u8' });
      }
      if (!['http:', 'https:'].includes(url.protocol)) {
        return reply.status(400).send({ error: 'URL must use HTTP or HTTPS' });
      }
    } catch (e) {
      return reply.status(400).send({ error: 'Invalid URL format' });
    }

    // Generate MediaMTX path
    const mediamtx = require('../services/mediamtx');
    const pathName = mediamtx.generatePathName(request.user.userId);

    try {
      // Add HLS source to MediaMTX
      const mediamtxResult = await mediamtx.addHlsPath(pathName, hls_url);

      if (!mediamtxResult.success) {
        return reply.status(502).send({
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
        return reply.status(500).send({ error: result.error });
      }

      fastify.log.info({
        cameraId: result.camera.id,
        name,
        pathName,
        admin: request.user.email
      }, 'City camera created');

      return { success: true, camera: result.camera };

    } catch (error) {
      fastify.log.error({ err: error }, 'City camera creation failed');
      return reply.status(500).send({ error: 'Failed to create city camera' });
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
      return reply.status(404).send({ error: 'Camera not found' });
    }

    if (camera.camera_type !== 'city') {
      return reply.status(400).send({ error: 'Not a city camera' });
    }

    // Cleanup MediaMTX path
    if (camera.mediamtx_path) {
      const mediamtx = require('../services/mediamtx');
      await mediamtx.removePath(camera.mediamtx_path);
    }

    // Delete from database
    await db.adminDeleteCamera(cameraId);

    fastify.log.info({ cameraId, name: camera.name, admin: request.user.email }, 'City camera deleted');

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
      return reply.status(404).send({ error: 'Camera not found' });
    }

    if (camera.camera_type !== 'city') {
      return reply.status(400).send({ error: 'Not a city camera' });
    }

    // Handle HLS source URL update
    if (hls_url !== undefined) {
      try {
        const url = new URL(hls_url);
        if (!url.pathname.endsWith('.m3u8')) {
          return reply.status(400).send({ error: 'URL must end with .m3u8' });
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
          return reply.status(400).send({ error: 'URL must use HTTP or HTTPS' });
        }
      } catch (e) {
        return reply.status(400).send({ error: 'Invalid URL format' });
      }

      const mediamtx = require('../services/mediamtx');

      // Remove old MediaMTX path and re-add with new URL
      if (camera.mediamtx_path) {
        await mediamtx.removePath(camera.mediamtx_path);
        const result = await mediamtx.addHlsPath(camera.mediamtx_path, hls_url);
        if (!result.success) {
          return reply.status(502).send({ error: 'Failed to update HLS source', details: result.error });
        }
      }

      // Update source URL in database
      await db.pool.execute('UPDATE cameras SET rtsp_source_url = ? WHERE id = ?', [hls_url, cameraId]);
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
      return reply.status(400).send({ error: 'No updates provided' });
    }

    fastify.log.info({
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

  // ==================== SYSTEM SETTINGS ====================

  /**
   * GET /api/admin/settings
   * Get all system settings
   */
  fastify.get('/settings', async (request, reply) => {
    const settings = await db.getAllSystemSettings();
    return { settings };
  });

  /**
   * PUT /api/admin/settings
   * Update system settings
   * Body: { key: value, ... }
   */
  fastify.put('/settings', async (request, reply) => {
    const updates = request.body;

    if (!updates || typeof updates !== 'object') {
      return reply.status(400).send({ error: 'Invalid settings object' });
    }

    // Allowed settings keys
    const allowedKeys = [
      // AI settings
      'ai_service_url',
      'ai_vision_model',
      'ai_monitoring_prompt',
      'ai_search_prompt',
      'ai_max_tokens',
      'ai_temperature',
      'ai_broadcast_interval',
      'ai_broadcast_prompt',
      // Voice call settings
      'voice_api_url',
      'voice_room_id',
      'voice_target_user',
      'voice_sample_type',
      'voice_cooldown',
      'voice_auto_hangup',
      'voice_call_timeout',
      // Google Places settings
      'places_included_types',
      'places_fallback_types',
      'places_radius',
      'places_max_results'
    ];

    for (const [key, value] of Object.entries(updates)) {
      if (!allowedKeys.includes(key)) {
        return reply.status(400).send({ error: `Invalid setting key: ${key}` });
      }
      if (typeof value !== 'string' || value.trim() === '') {
        return reply.status(400).send({ error: `Invalid value for ${key}` });
      }
      await db.setSystemSetting(key, value.trim());
    }

    fastify.log.info({ updates, admin: request.user.email }, 'System settings updated');

    return { success: true, settings: await db.getAllSystemSettings() };
  });

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
    const path = require('path');
    const fs = require('fs');

    const deleted = await db.adminDeleteVideoMessage(messageId);
    if (!deleted) {
      return reply.status(404).send({ error: 'Message not found' });
    }

    // Delete file from disk
    const filePath = safePath(deleted.file_path, 'uploads');
    if (filePath) { try { fs.unlinkSync(filePath); } catch {} }

    // Delete thumbnail
    if (deleted.thumbnail_path) {
      const thumbPath = safePath(deleted.thumbnail_path, 'uploads');
      if (thumbPath) { try { fs.unlinkSync(thumbPath); } catch {} }
    }

    fastify.log.info({ messageId, admin: request.user.email }, 'Admin deleted message');
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
    fastify.log.info({ admin: request.user.email }, 'Admin cleared places cache');
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
      return reply.status(404).send({ error: 'Place not found' });
    }

    await db.updatePlaceIcon(placeId, icon_url || null);
    fastify.log.info({ placeId, admin: request.user.email }, 'Admin updated place icon');
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
      return reply.status(404).send({ error: 'Place not found' });
    }

    await db.deletePlace(placeId);
    fastify.log.info({ placeId, admin: request.user.email }, 'Admin deleted place');
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
      return reply.status(400).send({ error: 'Invalid action. Use resolve or dismiss.' });
    }

    const updated = await db.resolveReport(reportId, request.user.userId, action);
    if (!updated) {
      return reply.status(404).send({ error: 'Report not found or already processed' });
    }

    fastify.log.info({ reportId, action, admin: request.user.email }, 'Admin processed report');
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
      return reply.status(404).send({ error: 'Report not found' });
    }

    const { entity_type, entity_id } = report;

    try {
      if (entity_type === 'video_message') {
        const deleted = await db.adminDeleteVideoMessage(entity_id);
        if (deleted) {
          const filePath = safePath(deleted.file_path, 'uploads');
          if (filePath) { try { fs.unlinkSync(filePath); } catch {} }
          if (deleted.thumbnail_path) {
            const thumbPath = safePath(deleted.thumbnail_path, 'uploads');
            if (thumbPath) { try { fs.unlinkSync(thumbPath); } catch {} }
          }
        }
      } else if (entity_type === 'comment') {
        await db.pool.execute('DELETE FROM comments WHERE id = ?', [entity_id]);
      }
      // camera and broadcast reports: admin reviews but content stays (cameras are infrastructure)
      // Admin can manually remove cameras from their respective tabs

      // Resolve all pending reports for this entity
      await db.resolveReportsByEntity(entity_type, entity_id, request.user.userId);

      fastify.log.info({ reportId, entity_type, entity_id, admin: request.user.email }, 'Admin deleted reported content');
      return { success: true };
    } catch (error) {
      fastify.log.error({ err: error, reportId }, 'Delete reported content failed');
      return reply.status(500).send({ error: 'Failed to delete content' });
    }
  });

  // ==================== H3 OWNERSHIP MIGRATION ====================

  /**
   * POST /api/admin/h3-ownership-sync
   * One-time migration: push all existing cameras + video/photo messages + user profiles to H3 service
   */
  fastify.post('/h3-ownership-sync', async (request, reply) => {
    const { notifyH3ContentItem, notifyH3UserProfile } = require('../utils/h3-sync');
    const H3_SERVICE_URL = process.env.H3_SERVICE_URL;
    const H3_SERVICE_KEY = process.env.H3_SERVICE_KEY;

    if (!H3_SERVICE_URL || !H3_SERVICE_KEY) {
      return reply.status(400).send({ error: 'H3_SERVICE_URL or H3_SERVICE_KEY not configured' });
    }

    const results = { users: 0, cameras: 0, messages: 0, errors: [] };

    // 1. Sync all user profiles
    const [users] = await db.pool.execute('SELECT id, display_name, avatar_url FROM users');
    const userProfiles = users.map(u => ({ id: u.id, displayName: u.display_name, avatarUrl: u.avatar_url }));
    try {
      const res = await fetch(`${H3_SERVICE_URL}/api/v1/sync/user-profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Key': H3_SERVICE_KEY },
        body: JSON.stringify({ profiles: userProfiles })
      });
      if (res.ok) results.users = userProfiles.length;
      else results.errors.push('user profiles sync failed: ' + res.status);
    } catch (e) {
      results.errors.push('user profiles sync error: ' + e.message);
    }

    // 2. Sync all cameras (excluding CITY_)
    const [cameras] = await db.pool.execute(
      "SELECT device_id, user_id, lat, lng FROM cameras WHERE lat IS NOT NULL AND lng IS NOT NULL AND user_id IS NOT NULL AND device_id NOT LIKE 'CITY_%'"
    );
    const cameraItems = cameras.map(c => ({
      itemType: 'camera', itemId: c.device_id, userId: c.user_id,
      lat: c.lat, lng: c.lng, points: 50
    }));

    // 3. Sync all video/photo messages
    const [messages] = await db.pool.execute(
      'SELECT message_id, sender_id, lat, lng, media_type FROM video_messages WHERE lat IS NOT NULL AND lng IS NOT NULL'
    );
    const messageItems = messages.map(m => ({
      itemType: m.media_type === 'photo' ? 'photo' : 'video',
      itemId: m.message_id, userId: m.sender_id,
      lat: m.lat, lng: m.lng, points: m.media_type === 'photo' ? 1 : 5
    }));

    // 4. Purge old video/photo content from H3 (removes orphans from direct DB deletes)
    try {
      const purgeRes = await fetch(`${H3_SERVICE_URL}/api/v1/sync/content-messages`, {
        method: 'DELETE',
        headers: { 'X-Service-Key': H3_SERVICE_KEY }
      });
      if (!purgeRes.ok) results.errors.push('content purge failed: ' + purgeRes.status);
    } catch (e) {
      results.errors.push('content purge error: ' + e.message);
    }

    // 5. Bulk sync all content items (fresh insert after purge)
    const allItems = [...cameraItems, ...messageItems];
    try {
      const res = await fetch(`${H3_SERVICE_URL}/api/v1/sync/full-content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Key': H3_SERVICE_KEY },
        body: JSON.stringify({ items: allItems })
      });
      if (res.ok) {
        results.cameras = cameraItems.length;
        results.messages = messageItems.length;
      } else {
        results.errors.push('content sync failed: ' + res.status);
      }
    } catch (e) {
      results.errors.push('content sync error: ' + e.message);
    }

    return { success: results.errors.length === 0, ...results };
  });
}

module.exports = adminRoutes;
