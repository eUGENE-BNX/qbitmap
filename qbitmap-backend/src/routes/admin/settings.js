const db = require('../../services/database');
const { clearAiConfigCache } = require('../../utils/ai-config');
const logger = require('../../utils/logger').child({ module: 'admin-settings' });

module.exports = async function(fastify) {

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
      return reply.code(400).send({ error: 'Invalid settings object' });
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
        return reply.code(400).send({ error: `Invalid setting key: ${key}` });
      }
      if (typeof value !== 'string' || value.trim() === '') {
        return reply.code(400).send({ error: `Invalid value for ${key}` });
      }
      await db.setSystemSetting(key, value.trim());
    }

    // [PERF-02] Drop the ai-config module cache so the next AI job sees
    // the updated ai_service_url / ai_vision_model / ai_service_api_key /
    // backend_public_url immediately instead of waiting out the 60s TTL.
    clearAiConfigCache();

    logger.info({ updates, admin: request.user.email }, 'System settings updated');

    return { success: true, settings: await db.getAllSystemSettings() };
  });
};
