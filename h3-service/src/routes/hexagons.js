const h3Service = require('../services/h3-service');
const ownershipService = require('../services/ownership-service');

// Shared viewport query schema
const viewportQuerySchema = {
  type: 'object',
  required: ['sw_lat', 'sw_lng', 'ne_lat', 'ne_lng', 'zoom'],
  properties: {
    sw_lat: { type: 'number', minimum: -90, maximum: 90 },
    sw_lng: { type: 'number', minimum: -180, maximum: 180 },
    ne_lat: { type: 'number', minimum: -90, maximum: 90 },
    ne_lng: { type: 'number', minimum: -180, maximum: 180 },
    zoom:   { type: 'number', minimum: 0, maximum: 22 }
  }
};

async function hexagonRoutes(fastify) {
  // Viewport query - main endpoint frontend calls
  fastify.get('/viewport', {
    schema: { querystring: viewportQuerySchema }
  }, async (request) => {
    const { sw_lat, sw_lng, ne_lat, ne_lng, zoom } = request.query;
    return h3Service.getViewportHexagons(sw_lat, sw_lng, ne_lat, ne_lng, zoom);
  });

  // Viewport ownership query
  fastify.get('/ownership', {
    schema: { querystring: viewportQuerySchema }
  }, async (request) => {
    const { sw_lat, sw_lng, ne_lat, ne_lng, zoom } = request.query;
    return ownershipService.getViewportOwnership(sw_lat, sw_lng, ne_lat, ne_lng, zoom);
  });

  // Leaderboard
  fastify.get('/leaderboard', {
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } }
      }
    }
  }, async (request) => {
    return ownershipService.getLeaderboard(request.query.limit);
  });

  // User stats for profile
  fastify.get('/user-stats/:userId', {
    schema: {
      params: {
        type: 'object',
        properties: { userId: { type: 'integer', minimum: 1 } }
      }
    }
  }, async (request) => {
    return ownershipService.getUserStats(request.params.userId);
  });

  // Hexagon details (cameras inside)
  fastify.get('/:h3Index', {
    schema: {
      params: {
        type: 'object',
        properties: { h3Index: { type: 'string', pattern: '^[0-9a-fA-F]{15}$' } }
      }
    }
  }, async (request) => {
    return h3Service.getHexagonDetails(request.params.h3Index);
  });

  // k-ring neighbors
  fastify.get('/:h3Index/neighbors', {
    schema: {
      params: {
        type: 'object',
        properties: { h3Index: { type: 'string', pattern: '^[0-9a-fA-F]{15}$' } }
      },
      querystring: {
        type: 'object',
        properties: { k: { type: 'integer', minimum: 1, maximum: 5, default: 1 } }
      }
    }
  }, async (request) => {
    const neighbors = await h3Service.getHexagonNeighbors(request.params.h3Index, request.query.k);
    return { center: request.params.h3Index, k: request.query.k, neighbors };
  });
}

module.exports = hexagonRoutes;
