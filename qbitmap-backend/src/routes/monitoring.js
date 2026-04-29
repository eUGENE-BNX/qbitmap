const db = require('../services/database');
const { authHook, optionalAuthHook } = require('../utils/jwt');
const wsService = require('../services/websocket');
const { validateBody, monitoringToggleSchema, createAlarmSchema } = require('../utils/validation');
const logger = require('../utils/logger').child({ module: 'monitoring' });

/**
 * Monitoring API Routes
 * Handles AI monitoring and alarm management
 */
async function monitoringRoutes(fastify, options) {

  // ==================== AI MONITORING ROUTES ====================

  /**
   * POST /api/monitoring/cameras/:deviceId/monitoring
   * Start or stop AI monitoring for a camera
   */
  fastify.post('/cameras/:deviceId/monitoring', {
    preHandler: [authHook, validateBody(monitoringToggleSchema)]
  }, async (request, reply) => {
    const { deviceId } = request.params;
    const { enabled } = request.body;

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      // Security: Verify ownership
      if (camera.user_id !== request.user.userId) {
        return reply.code(403).send({ error: 'Not authorized to modify this camera' });
      }

      const userId = request.user.userId;

      const state = await db.setAiMonitoring(camera.id, enabled, userId);

      // Broadcast to all connected clients
      wsService.broadcastMonitoringChange(deviceId, enabled, userId).catch(err => {
        logger.warn({ err, deviceId }, 'Monitoring broadcast failed');
      });

      logger.info({ deviceId, enabled }, `AI monitoring ${enabled ? 'started' : 'stopped'}`);

      return {
        status: 'ok',
        deviceId,
        enabled: !!state.enabled,
        startedAt: state.started_at
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, 'Toggle monitoring error');
      return reply.code(500).send({ error: 'Failed to toggle monitoring' });
    }
  });

  /**
   * GET /api/monitoring/cameras/:deviceId/monitoring
   * Get AI monitoring status for a camera
   */
  fastify.get('/cameras/:deviceId/monitoring', { preHandler: optionalAuthHook }, async (request, reply) => {
    const { deviceId } = request.params;

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      if (!camera.is_public) {
        if (!request.user) {
          return reply.code(401).send({ error: 'Authentication required for private camera' });
        }
        if (camera.user_id !== request.user.userId) {
          return reply.code(403).send({ error: 'Not authorized to access this camera' });
        }
      }

      const state = await db.getAiMonitoringState(camera.id);

      return {
        deviceId,
        enabled: state ? !!state.enabled : false,
        startedAt: state?.started_at || null,
        lastAnalysis: state?.last_analysis_at || null
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, 'Get monitoring status error');
      return reply.code(500).send({ error: 'Failed to get monitoring status' });
    }
  });

  /**
   * GET /api/monitoring/active
   * Get all active monitoring cameras
   */
  fastify.get('/active', { preHandler: authHook }, async (request, reply) => {
    try {
      const active = await db.getAllActiveMonitoring();
      return {
        cameras: active.map(m => ({
          deviceId: m.device_id,
          name: m.name,
          enabled: !!m.enabled,
          startedAt: m.started_at,
          lastAnalysis: m.last_analysis_at
        }))
      };
    } catch (error) {
      logger.error({ err: error }, 'Get active monitoring error');
      return reply.code(500).send({ error: 'Failed to get active monitoring' });
    }
  });

  /**
   * POST /api/monitoring/cameras/:deviceId/analysis
   * Record that an analysis was performed (called by frontend)
   */
  fastify.post('/cameras/:deviceId/analysis', { preHandler: optionalAuthHook }, async (request, reply) => {
    const { deviceId } = request.params;

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      await db.updateLastAnalysis(camera.id);

      return { status: 'ok' };
    } catch (error) {
      logger.error({ err: error, deviceId }, 'Record analysis error');
      return reply.code(500).send({ error: 'Failed to record analysis' });
    }
  });

  // ==================== ALARM ROUTES ====================

  /**
   * POST /api/monitoring/cameras/:deviceId/alarms
   * Create alarm for a camera (called by frontend after detection)
   */
  fastify.post('/cameras/:deviceId/alarms', {
    preHandler: [authHook, validateBody(createAlarmSchema)]
  }, async (request, reply) => {
    const { deviceId } = request.params;
    const alarmData = request.body;

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      // Check if there's already an active alarm for this camera
      const existing = await db.getActiveAlarm(camera.id);
      if (existing) {
        return reply.code(409).send({
          error: 'Alarm already active',
          alarmId: existing.id
        });
      }

      // Separate snapshot from alarm data - snapshot is for broadcast only, not stored in DB
      const { snapshot, ...alarmDataForDb } = alarmData;
      const alarmId = await db.createAlarm(camera.id, deviceId, alarmDataForDb);

      // Broadcast to all clients (includes snapshot for live display)
      wsService.broadcastAlarm(alarmId, deviceId, camera.name, alarmData).catch(err => {
        logger.warn({ err, deviceId }, 'Alarm broadcast failed');
      });

      logger.info({ alarmId, deviceId, tasvir: alarmData.tasvir }, 'Alarm created');

      return {
        status: 'ok',
        alarmId,
        deviceId
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, 'Alarm create error');
      return reply.code(500).send({ error: 'Failed to create alarm' });
    }
  });

  /**
   * DELETE /api/monitoring/alarms/:alarmId
   * Clear alarm (user dismisses it)
   */
  fastify.delete('/alarms/:alarmId', { preHandler: authHook }, async (request, reply) => {
    const { alarmId } = request.params;

    try {
      const userId = request.user.userId;

      // Get alarm before clearing to get deviceId
      const alarm = await db.getAlarmById(alarmId);
      if (!alarm) {
        return reply.code(404).send({ error: 'Alarm not found' });
      }

      if (alarm.cleared_at) {
        return reply.code(400).send({ error: 'Alarm already cleared' });
      }

      await db.clearAlarm(alarmId, userId);

      // Broadcast to all clients
      wsService.broadcastAlarmCleared(alarmId, alarm.device_id, userId).catch(err => {
        logger.warn({ err, alarmId }, 'Alarm cleared broadcast failed');
      });

      logger.info({ alarmId, deviceId: alarm.device_id }, 'Alarm cleared');

      return {
        status: 'ok',
        alarmId
      };
    } catch (error) {
      logger.error({ err: error, alarmId }, 'Alarm clear error');
      return reply.code(500).send({ error: 'Failed to clear alarm' });
    }
  });

  /**
   * GET /api/monitoring/alarms/active
   * Get all active alarms (with optional pagination)
   */
  fastify.get('/alarms/active', { preHandler: authHook }, async (request, reply) => {
    try {
      const page = Math.max(1, parseInt(request.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit) || 50));

      // If no pagination params, return all (backward compatible)
      if (!request.query.page && !request.query.limit) {
        const alarms = await db.getAllActiveAlarms();
        return {
          alarms: alarms.map(a => ({
            id: a.id,
            deviceId: a.device_id,
            cameraName: a.name,
            data: a.alarm_data,
            triggeredAt: a.triggered_at
          }))
        };
      }

      // Return paginated results
      const result = await db.getActiveAlarmsPaginated(page, limit);
      return {
        alarms: result.items.map(a => ({
          id: a.id,
          deviceId: a.device_id,
          cameraName: a.name,
          data: a.alarm_data,
          triggeredAt: a.triggered_at
        })),
        pagination: result.pagination
      };
    } catch (error) {
      logger.error({ err: error }, 'Get active alarms error');
      return reply.code(500).send({ error: 'Failed to get active alarms' });
    }
  });

  /**
   * GET /api/monitoring/cameras/:deviceId/alarms
   * Get alarm history for a camera (with optional pagination)
   */
  fastify.get('/cameras/:deviceId/alarms', { preHandler: optionalAuthHook }, async (request, reply) => {
    const { deviceId } = request.params;
    const page = Math.max(1, parseInt(request.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit) || 50));

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      if (!camera.is_public) {
        if (!request.user) {
          return reply.code(401).send({ error: 'Authentication required for private camera' });
        }
        if (camera.user_id !== request.user.userId) {
          return reply.code(403).send({ error: 'Not authorized to access this camera' });
        }
      }

      // If no pagination params, return with limit only (backward compatible)
      if (!request.query.page) {
        const alarms = await db.getCameraAlarmHistory(camera.id, limit);
        return {
          deviceId,
          alarms: alarms.map(a => ({
            id: a.id,
            data: a.alarm_data,
            triggeredAt: a.triggered_at,
            clearedAt: a.cleared_at,
            acknowledged: !!a.acknowledged
          }))
        };
      }

      // Return paginated results
      const result = await db.getCameraAlarmHistoryPaginated(camera.id, page, limit);
      return {
        deviceId,
        alarms: result.items.map(a => ({
          id: a.id,
          data: a.alarm_data,
          triggeredAt: a.triggered_at,
          clearedAt: a.cleared_at,
          acknowledged: !!a.acknowledged
        })),
        pagination: result.pagination
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, 'Get alarm history error');
      return reply.code(500).send({ error: 'Failed to get alarm history' });
    }
  });

  // ==================== STATS ROUTES ====================

  /**
   * GET /api/monitoring/stats
   * Get monitoring and alarm statistics
   */
  fastify.get('/stats', { preHandler: authHook }, async (request, reply) => {
    try {
      const activeMonitoring = await db.getAllActiveMonitoring();
      const activeAlarms = await db.getAllActiveAlarms();
      const wsStats = wsService.getStats();

      return {
        monitoring: {
          active: activeMonitoring.length,
          cameras: activeMonitoring.map(m => m.device_id)
        },
        alarms: {
          active: activeAlarms.length
        },
        websocket: wsStats
      };
    } catch (error) {
      logger.error({ err: error }, 'Get stats error');
      return reply.code(500).send({ error: 'Failed to get stats' });
    }
  });
}

module.exports = monitoringRoutes;
