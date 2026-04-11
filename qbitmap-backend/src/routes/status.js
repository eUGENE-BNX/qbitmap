/**
 * Status Routes
 * Provides system health monitoring endpoints
 */

const healthChecker = require('../services/health-checker');
const { authHook } = require('../utils/jwt');
const logger = require('../utils/logger').child({ module: 'status-routes' });

// [SEC-07] Scrub a service health entry before sending it to unauthenticated
// callers. The raw entry includes:
//   - host         → internal IP/port (91.98.90.57, etc.)
//   - metadata     → upstream /health JSON, which for MediaMTX leaks the
//                    full camera path list including device IDs
//   - error        → connection error string, often includes the internal
//                    URL/IP in ECONNREFUSED messages
// Authenticated detail requests (/service/:serviceId) still get the raw
// object; the sanitization only affects anonymous /health responses.
function sanitizeServiceForPublic(s) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    // Replace the raw host with the human-readable description so the
    // public status page still has something to render in the "host"
    // column without exposing an internal IP.
    host: s.description,
    icon: s.icon,
    status: s.status,
    statusCode: s.statusCode,
    responseTime: s.responseTime,
    lastCheck: s.lastCheck,
    // `error` is intentionally replaced with a non-descriptive flag so the
    // UI can still badge a service as failing without leaking the raw
    // upstream URL embedded in the error message.
    ...(s.error ? { error: 'unreachable' } : {})
  };
}

function sanitizePublicHealth(health) {
  return {
    timestamp: health.timestamp,
    services: (health.services || []).map(sanitizeServiceForPublic),
    connections: health.connections,
    summary: health.summary,
    overall: health.overall
  };
}

async function statusRoutes(fastify, options) {
  /**
   * GET /health
   * Returns aggregated health status of all services
   */
  fastify.get('/health', {
    schema: {
      description: 'Get health status of all QBitmap services',
      response: {
        200: {
          type: 'object',
          properties: {
            timestamp: { type: 'string' },
            services: { type: 'array' },
            connections: { type: 'array' },
            summary: {
              type: 'object',
              properties: {
                total: { type: 'number' },
                online: { type: 'number' },
                offline: { type: 'number' },
                degraded: { type: 'number' },
                avgResponseTime: { type: ['number', 'null'] }
              }
            },
            overall: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      // Check if force refresh is requested
      const forceRefresh = request.query.refresh === 'true';
      const status = await healthChecker.checkAllServices(forceRefresh);
      // [SEC-07] Scrub internal topology before sending to the public.
      // The /health endpoint stays public so status.qbitmap.com keeps
      // working without credentials, but callers never see internal IPs.
      return sanitizePublicHealth(status);
    } catch (error) {
      logger.error({ err: error }, 'Health check failed');
      return reply.code(500).send({
        error: 'Health check failed',
        message: 'Unable to complete health check'
      });
    }
  });

  /**
   * GET /config
   * Returns service configuration for graph layout
   */
  fastify.get('/config', {
    schema: {
      description: 'Get service configuration for status page layout',
      response: {
        200: {
          type: 'object',
          properties: {
            services: { type: 'array' },
            connections: { type: 'array' }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      return healthChecker.getServiceConfig();
    } catch (error) {
      logger.error({ err: error }, 'Failed to get service config');
      return reply.code(500).send({
        error: 'Failed to get service configuration',
        message: 'Unable to load service configuration'
      });
    }
  });

  /**
   * GET /service/:serviceId
   * Returns health status of a specific service.
   * [SEC-07] Requires authentication — this endpoint returns the full
   * internal service record (host, metadata, error) which previously
   * leaked MediaMTX IPs and camera path listings to anonymous callers.
   * The public /health endpoint above delivers the same overall picture
   * with sanitized fields for the status.qbitmap.com page.
   */
  fastify.get('/service/:serviceId', {
    preHandler: authHook,
    schema: {
      description: 'Get health status of a specific service (authenticated)',
      params: {
        type: 'object',
        properties: {
          serviceId: { type: 'string' }
        },
        required: ['serviceId']
      }
    }
  }, async (request, reply) => {
    try {
      const { serviceId } = request.params;
      const service = healthChecker.SERVICES.find(s => s.id === serviceId);

      if (!service) {
        return reply.code(404).send({
          error: 'Service not found',
          serviceId
        });
      }

      const result = await healthChecker.checkService(service);
      return result;
    } catch (error) {
      logger.error({ err: error, serviceId: request.params.serviceId }, 'Service health check failed');
      return reply.code(500).send({
        error: 'Service health check failed',
        message: 'Unable to check service status'
      });
    }
  });
}

module.exports = statusRoutes;
