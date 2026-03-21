const h3Service = require('../services/h3-service');
const ownershipService = require('../services/ownership-service');

async function hexagonRoutes(fastify) {
  // Viewport query - main endpoint frontend calls
  fastify.get('/viewport', async (request, reply) => {
    const { sw_lat, sw_lng, ne_lat, ne_lng, zoom } = request.query;

    if (!sw_lat || !sw_lng || !ne_lat || !ne_lng || !zoom) {
      return reply.code(400).send({ error: 'Missing viewport parameters: sw_lat, sw_lng, ne_lat, ne_lng, zoom' });
    }

    const result = await h3Service.getViewportHexagons(
      parseFloat(sw_lat), parseFloat(sw_lng),
      parseFloat(ne_lat), parseFloat(ne_lng),
      parseFloat(zoom)
    );

    return result;
  });

  // Viewport ownership query
  fastify.get('/ownership', async (request, reply) => {
    const { sw_lat, sw_lng, ne_lat, ne_lng, zoom } = request.query;

    if (!sw_lat || !sw_lng || !ne_lat || !ne_lng || !zoom) {
      return reply.code(400).send({ error: 'Missing viewport parameters: sw_lat, sw_lng, ne_lat, ne_lng, zoom' });
    }

    const result = await ownershipService.getViewportOwnership(
      parseFloat(sw_lat), parseFloat(sw_lng),
      parseFloat(ne_lat), parseFloat(ne_lng),
      parseFloat(zoom)
    );

    return result;
  });

  // Leaderboard
  fastify.get('/leaderboard', async (request) => {
    const limit = Math.min(Math.max(parseInt(request.query.limit) || 10, 1), 50);
    return ownershipService.getLeaderboard(limit);
  });

  // User stats for profile
  fastify.get('/user-stats/:userId', async (request) => {
    const userId = parseInt(request.params.userId);
    if (!Number.isFinite(userId)) {
      return { totalPoints: 0, cellCount: 0, totalAreaM2: 0, rank: 0 };
    }
    return ownershipService.getUserStats(userId);
  });

  // Hexagon details (cameras inside)
  fastify.get('/:h3Index', async (request) => {
    return h3Service.getHexagonDetails(request.params.h3Index);
  });

  // k-ring neighbors
  fastify.get('/:h3Index/neighbors', async (request) => {
    const k = Math.min(parseInt(request.query.k) || 1, 5);
    const neighbors = await h3Service.getHexagonNeighbors(request.params.h3Index, k);
    return { center: request.params.h3Index, k, neighbors };
  });
}

module.exports = hexagonRoutes;
