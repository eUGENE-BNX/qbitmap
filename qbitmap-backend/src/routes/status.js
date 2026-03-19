/**
 * Status Routes
 * Provides system health monitoring endpoints
 */

const healthChecker = require('../services/health-checker');
const logger = require('../utils/logger').child({ module: 'status-routes' });

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
      return status;
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
   * Returns health status of a specific service
   */
  fastify.get('/service/:serviceId', {
    schema: {
      description: 'Get health status of a specific service',
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
