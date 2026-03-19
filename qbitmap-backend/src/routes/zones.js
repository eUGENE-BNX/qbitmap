/**
 * QBitmap Backend - Clickable Zones Routes
 * Handles zone CRUD and relay proxy operations
 */

const db = require('../services/database');
const { authHook, optionalAuthHook } = require('../utils/jwt');
const logger = require('../utils/logger').child({ module: 'zones' });
const { isBlockedIP } = require('../services/mediamtx');

/**
 * Validate relay URL to prevent SSRF attacks
 * @param {string} url - URL to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateRelayUrl(url) {
  if (!url) return { valid: true }; // null/undefined is OK

  try {
    const urlObj = new URL(url);

    // Only allow HTTP/HTTPS
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      return { valid: false, error: 'Only HTTP/HTTPS protocols allowed' };
    }

    // Block private/internal IPs
    if (isBlockedIP(urlObj.hostname)) {
      return { valid: false, error: 'Internal/private IP addresses not allowed' };
    }

    // Block common internal hostnames
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
    if (blockedHosts.includes(urlObj.hostname.toLowerCase())) {
      return { valid: false, error: 'Localhost addresses not allowed' };
    }

    return { valid: true };
  } catch (e) {
    return { valid: false, error: 'Invalid URL format' };
  }
}

async function zonesRoutes(fastify, options) {
  // Note: Auth is applied per-route, not globally
  // Public routes: GET zones, GET metrics, POST toggle
  // Protected routes: POST create, PUT update, DELETE

  /**
   * POST /api/zones - Create a new zone (requires auth)
   */
  fastify.post('/', { preHandler: authHook }, async (request, reply) => {
    try {
      const { cameraId, name, points, relayOnUrl, relayOffUrl, relayStatusUrl } = request.body;

      if (!cameraId || !name || !points || !Array.isArray(points) || points.length < 3) {
        return reply.code(400).send({ error: 'cameraId, name, and at least 3 points are required' });
      }

      // Validate relay URLs to prevent SSRF
      for (const [urlName, urlValue] of [['relayOnUrl', relayOnUrl], ['relayOffUrl', relayOffUrl], ['relayStatusUrl', relayStatusUrl]]) {
        const validation = validateRelayUrl(urlValue);
        if (!validation.valid) {
          return reply.code(400).send({ error: `Invalid ${urlName}: ${validation.error}` });
        }
      }

      // Verify user owns the camera or has access
      const camera = await db.getCameraByDeviceId(cameraId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      const access = await db.hasAccessToCamera(request.user.userId, camera.id);
      if (!access.hasAccess || access.permission === 'public') {
        return reply.code(403).send({ error: 'Not authorized to create zones for this camera' });
      }

      const result = await db.createClickableZone(cameraId, request.user.userId, {
        name,
        points,
        relayOnUrl,
        relayOffUrl,
        relayStatusUrl
      });

      if (!result.success) {
        return reply.code(500).send({ error: result.error });
      }

      // Return zone without relay URLs
      const zone = await db.getZoneByIdSafe(result.zoneId);
      logger.info({ zoneId: result.zoneId, cameraId, userId: request.user.userId }, 'Zone created');

      return reply.code(201).send({ success: true, zone });

    } catch (error) {
      logger.error({ err: error }, 'Zone create error');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/zones/camera/:cameraId - Get all zones for a camera
   */
  fastify.get('/camera/:cameraId', async (request, reply) => {
    try {
      const { cameraId } = request.params;

      // Get zones (without relay URLs)
      const zones = await db.getCameraZones(cameraId);

      // Parse points JSON for each zone
      const parsedZones = zones.map(zone => ({
        ...zone,
        points: JSON.parse(zone.points)
      }));

      return { zones: parsedZones };

    } catch (error) {
      logger.error({ err: error }, 'Get camera zones error');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/zones/:zoneId - Get a specific zone
   */
  fastify.get('/:zoneId', async (request, reply) => {
    try {
      const { zoneId } = request.params;

      const zone = await db.getZoneByIdSafe(zoneId);
      if (!zone) {
        return reply.code(404).send({ error: 'Zone not found' });
      }

      return {
        zone: {
          ...zone,
          points: JSON.parse(zone.points)
        }
      };

    } catch (error) {
      logger.error({ err: error }, 'Get zone error');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * PUT /api/zones/:zoneId - Update a zone (requires auth)
   */
  fastify.put('/:zoneId', { preHandler: authHook }, async (request, reply) => {
    try {
      const { zoneId } = request.params;
      const { name, points, relayOnUrl, relayOffUrl, relayStatusUrl } = request.body;

      // Validate relay URLs to prevent SSRF
      for (const [urlName, urlValue] of [['relayOnUrl', relayOnUrl], ['relayOffUrl', relayOffUrl], ['relayStatusUrl', relayStatusUrl]]) {
        const validation = validateRelayUrl(urlValue);
        if (!validation.valid) {
          return reply.code(400).send({ error: `Invalid ${urlName}: ${validation.error}` });
        }
      }

      const result = await db.updateClickableZone(zoneId, request.user.userId, {
        name,
        points,
        relayOnUrl,
        relayOffUrl,
        relayStatusUrl
      });

      if (!result.success) {
        const statusCode = result.error === 'Not authorized' ? 403 : 404;
        return reply.code(statusCode).send({ error: result.error });
      }

      const zone = await db.getZoneByIdSafe(zoneId);
      logger.info({ zoneId, userId: request.user.userId }, 'Zone updated');

      return {
        success: true,
        zone: {
          ...zone,
          points: JSON.parse(zone.points)
        }
      };

    } catch (error) {
      logger.error({ err: error }, 'Zone update error');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * DELETE /api/zones/:zoneId - Delete a zone (requires auth)
   */
  fastify.delete('/:zoneId', { preHandler: authHook }, async (request, reply) => {
    try {
      const { zoneId } = request.params;

      // Admins can delete any zone; regular users only their own
      const userId = request.user.role === 'admin' ? null : request.user.userId;
      const result = await db.deleteClickableZone(zoneId, userId);

      if (!result.success) {
        const statusCode = result.error === 'Not authorized' ? 403 : 404;
        return reply.code(statusCode).send({ error: result.error });
      }

      logger.info({ zoneId, userId: request.user.userId }, 'Zone deleted');
      return { success: true };

    } catch (error) {
      logger.error({ err: error }, 'Zone delete error');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/zones/:zoneId/toggle - Toggle relay state (proxy)
   * [SECURITY] Requires auth + camera access check
   */
  fastify.post('/:zoneId/toggle', {
    preHandler: authHook,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    try {
      const { zoneId } = request.params;

      // Get zone with relay URLs (internal)
      const zone = await db.getZoneById(zoneId);
      if (!zone) {
        return reply.code(404).send({ error: 'Zone not found' });
      }

      // Determine which URL to call
      const currentState = zone.last_state || 'off';
      const targetUrl = currentState === 'on' ? zone.relay_off_url : zone.relay_on_url;

      if (!targetUrl) {
        return reply.code(400).send({ error: 'Relay URL not configured' });
      }

      // [SECURITY] Verify user has access to the camera owning this zone
      const access = await db.hasAccessToCamera(request.user.userId, zone.camera_id);
      if (!access.hasAccess || access.permission === 'public') {
        return reply.code(403).send({ error: 'Not authorized to toggle this relay' });
      }

      // Call relay endpoint
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

        const response = await fetch(targetUrl, {
          method: 'GET',
          signal: controller.signal
        });

        clearTimeout(timeout);

        // Update state in database
        const newState = currentState === 'on' ? 'off' : 'on';
        await db.updateZoneState(zoneId, newState);

        logger.info({ zoneId, newState, relayOk: response.ok }, 'Relay toggled');

        return {
          success: true,
          newState,
          relayResponse: response.ok ? 'OK' : `HTTP ${response.status}`
        };

      } catch (fetchError) {
        logger.error({ err: fetchError, zoneId }, 'Relay fetch error');

        // Still toggle state optimistically if timeout (relay might have worked)
        if (fetchError.name === 'AbortError') {
          const newState = currentState === 'on' ? 'off' : 'on';
          await db.updateZoneState(zoneId, newState);
          return {
            success: true,
            newState,
            warning: 'Relay timeout - state updated optimistically'
          };
        }

        return reply.code(502).send({
          error: 'Failed to reach relay',
          details: 'Relay connection failed'
        });
      }

    } catch (error) {
      logger.error({ err: error }, 'Zone toggle error');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/zones/:zoneId/status - Get relay status (proxy)
   * [SECURITY] Requires auth
   */
  fastify.get('/:zoneId/status', { preHandler: authHook }, async (request, reply) => {
    try {
      const { zoneId } = request.params;

      const zone = await db.getZoneById(zoneId);
      if (!zone) {
        return reply.code(404).send({ error: 'Zone not found' });
      }

      // If no status URL configured, return last known state
      if (!zone.relay_status_url) {
        return {
          state: zone.last_state || 'unknown',
          source: 'cached'
        };
      }

      // Call relay status endpoint
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

        const response = await fetch(zone.relay_status_url, {
          method: 'GET',
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (response.ok) {
          const text = await response.text();

          // Try to parse state from response
          let state = 'unknown';
          if (text.toLowerCase().includes('on') || text.includes('1')) {
            state = 'on';
          } else if (text.toLowerCase().includes('off') || text.includes('0')) {
            state = 'off';
          }

          // Update database with actual state
          if (state !== 'unknown') {
            await db.updateZoneState(zoneId, state);
          }

          return {
            state,
            source: 'relay',
            rawResponse: text.substring(0, 100) // First 100 chars only
          };
        } else {
          return {
            state: zone.last_state || 'unknown',
            source: 'cached',
            warning: `Relay returned HTTP ${response.status}`
          };
        }

      } catch (fetchError) {
        logger.error({ err: fetchError, zoneId }, 'Status fetch error');
        return {
          state: zone.last_state || 'unknown',
          source: 'cached',
          warning: 'Could not reach relay'
        };
      }

    } catch (error) {
      logger.error({ err: error }, 'Zone status error');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/zones/:zoneId/metrics - Get relay power metrics (Shelly API)
   * [SECURITY] Requires auth
   */
  fastify.get('/:zoneId/metrics', { preHandler: authHook }, async (request, reply) => {
    try {
      const { zoneId } = request.params;

      const zone = await db.getZoneById(zoneId);
      if (!zone) {
        return reply.code(404).send({ error: 'Zone not found' });
      }

      // If no status URL configured, return error
      if (!zone.relay_status_url) {
        return reply.code(400).send({ error: 'Relay status URL not configured' });
      }

      // Call Shelly API
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(zone.relay_status_url, {
          method: 'GET',
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
          return reply.code(502).send({ error: `Relay returned HTTP ${response.status}` });
        }

        const data = await response.json();

        // Extract Shelly metrics
        const metrics = {
          zoneName: zone.name,
          output: data.output || false,
          apower: data.apower || 0,
          voltage: data.voltage || 0,
          current: data.current || 0,
          totalEnergy: data.aenergy?.total || 0,
          temperature: data.temperature?.tC || null,
          // Calculate bill (kWh * 2.59 TL)
          bill: ((data.aenergy?.total || 0) / 1000) * 2.59
        };

        return { success: true, metrics };

      } catch (fetchError) {
        logger.error({ err: fetchError, zoneId }, 'Metrics fetch error');
        if (fetchError.name === 'AbortError') {
          return reply.code(504).send({ error: 'Relay timeout' });
        }
        return reply.code(502).send({ error: 'Could not reach relay' });
      }

    } catch (error) {
      logger.error({ err: error }, 'Zone metrics error');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}

module.exports = zonesRoutes;
