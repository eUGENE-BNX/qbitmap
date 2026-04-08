/**
 * Geo routes — IP-based geolocation fallback for LocationService.
 *
 * Tries Cloudflare-provided headers first (cf-iplatitude / cf-iplongitude).
 * If those are missing (no CF in front of the backend, local dev, etc.) the
 * route returns 503 and the frontend caller falls through to its own UX.
 *
 * TODO: if CF headers turn out to be unavailable in production, plug an
 * adapter here for ipapi.co / ipinfo.io.
 */

const logger = require('../utils/logger').child({ module: 'geo' });

async function geoRoutes(fastify, options) {

  // GET /api/geo/ip-locate - approximate location from request IP
  // Public (no auth) — needed during map first-paint before login.
  fastify.get('/ip-locate', async (request, reply) => {
    const h = request.headers || {};

    const latStr = h['cf-iplatitude'];
    const lngStr = h['cf-iplongitude'];
    const city = h['cf-ipcity'] || null;
    const country = h['cf-ipcountry'] || null;

    if (!latStr || !lngStr) {
      // First-time observability: log so we can verify CF wiring on staging.
      logger.warn(
        { hasCfLat: !!latStr, hasCfLng: !!lngStr, ua: h['user-agent'] },
        'ip-locate: Cloudflare geo headers missing'
      );
      return reply.code(503).send({
        error: 'ip-geolocation-unavailable',
        hint: 'Cloudflare geo headers not present on this request'
      });
    }

    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return reply.code(502).send({ error: 'invalid-cf-coordinates' });
    }

    // City-level CF resolution is roughly metro-area scale; tune if needed.
    const accuracyRadiusM = city ? 15000 : 50000;

    return {
      lng,
      lat,
      accuracy_radius_m: accuracyRadiusM,
      source: 'ip',
      city,
      country
    };
  });

}

module.exports = geoRoutes;
