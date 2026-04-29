const crypto = require('crypto');
const db = require('../services/database');
const { authHook, optionalAuthHook } = require('../utils/jwt');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const { safeProxyFetch, SafeProxyError } = require('../utils/safe-proxy-fetch');
const { validateBody } = require('../utils/validation');
const { z } = require('zod');
const logger = require('../utils/logger').child({ module: 'public' });
const { services } = require('../config');

// Generic camera settings schema — stores WHEP/City AI monitoring config.
// Size-capped (50KB) passthrough to allow future keys without bumping validation.
const cameraSettingsSchema = z.object({}).passthrough().refine(
  (data) => JSON.stringify(data).length < 50000,
  { message: 'Settings too large' }
);

// Allowed WHEP server hosts (prevent SSRF attacks)
const ALLOWED_WHEP_HOSTS = [...services.allowedWhepHosts];

// Only allow localhost in development mode (SSRF protection)
if (process.env.NODE_ENV !== 'production') {
  if (!ALLOWED_WHEP_HOSTS.includes('localhost')) ALLOWED_WHEP_HOSTS.push('localhost');
  if (!ALLOWED_WHEP_HOSTS.includes('127.0.0.1')) ALLOWED_WHEP_HOSTS.push('127.0.0.1');
  logger.info({ hosts: ALLOWED_WHEP_HOSTS }, 'WHEP hosts whitelist (dev mode - localhost allowed)');
} else {
  logger.info({ hosts: ALLOWED_WHEP_HOSTS }, 'WHEP hosts whitelist (production mode)');
}

// [BE-004] SSRF protection - reuse shared isBlockedIP from mediamtx
const { isBlockedIP: isPrivateIP, getHlsUrl } = require('../services/mediamtx');

async function publicRoutes(fastify, options) {

  // WHEP Proxy - forwards SDP to remote WHEP servers (solves HTTPS/HTTP mixed content)
  fastify.post('/whep-proxy', async (request, reply) => {
    const targetUrl = request.query.url;

    if (!targetUrl) {
      return reply.code(400).send({ error: 'url query parameter is required' });
    }

    // Validate URL
    try {
      const url = new URL(targetUrl);

      // [BE-004] Security: Block private IPs first (SSRF hardening)
      if (isPrivateIP(url.hostname)) {
        logger.warn({ hostname: url.hostname }, 'Blocked WHEP request to private/internal IP');
        return reply.code(403).send({ error: 'Access to internal networks is not allowed' });
      }

      // Security: Check if host is in whitelist (prevent SSRF)
      if (!ALLOWED_WHEP_HOSTS.includes(url.hostname)) {
        logger.warn({ hostname: url.hostname }, 'Blocked WHEP request to unauthorized host');
        return reply.code(403).send({ error: 'WHEP server not in allowed list' });
      }

      if (!url.pathname.includes('/whep')) {
        return reply.code(400).send({ error: 'Invalid WHEP URL' });
      }
    } catch (e) {
      return reply.code(400).send({ error: 'Invalid URL format' });
    }

    try {
      // Forward the SDP offer to the WHEP server (10s timeout)
      // safeProxyFetch resolves DNS itself + checks IP + per-host rate limit
      const response = await safeProxyFetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp'
        },
        body: request.body
      }, 10000);

      if (!response.ok) {
        return reply.code(response.status).send({ error: `WHEP server returned ${response.status}` });
      }

      const answerSdp = await response.text();

      // Return the SDP answer
      reply.type('application/sdp');
      return answerSdp;

    } catch (error) {
      if (error instanceof SafeProxyError) {
        logger.warn({ err: error.message }, 'WHEP proxy blocked');
        return reply.code(error.status).send({ error: error.message });
      }
      logger.error({ err: error }, 'WHEP proxy error');
      return reply.code(502).send({ error: 'Failed to connect to WHEP server' });
    }
  });

  // WHIP Proxy - forwards SDP to remote WHIP servers for browser-based publishing
  // Requires authentication (only logged-in users can publish)
  fastify.post('/whip-proxy', { preHandler: authHook }, async (request, reply) => {
    const targetUrl = request.query.url;

    if (!targetUrl) {
      return reply.code(400).send({ error: 'url query parameter is required' });
    }

    try {
      const url = new URL(targetUrl);

      if (isPrivateIP(url.hostname)) {
        logger.warn({ hostname: url.hostname }, 'Blocked WHIP request to private/internal IP');
        return reply.code(403).send({ error: 'Access to internal networks is not allowed' });
      }

      if (!ALLOWED_WHEP_HOSTS.includes(url.hostname)) {
        logger.warn({ hostname: url.hostname }, 'Blocked WHIP request to unauthorized host');
        return reply.code(403).send({ error: 'WHIP server not in allowed list' });
      }

      if (!url.pathname.includes('/whip')) {
        return reply.code(400).send({ error: 'Invalid WHIP URL' });
      }
    } catch (e) {
      return reply.code(400).send({ error: 'Invalid URL format' });
    }

    try {
      const response = await safeProxyFetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: request.body
      }, 10000);

      if (!response.ok) {
        return reply.code(response.status).send({ error: `WHIP server returned ${response.status}` });
      }

      const answerSdp = await response.text();

      // Forward Location header (WHIP session URL for teardown via DELETE)
      const location = response.headers.get('location');
      if (location) {
        reply.header('Location', location);
      }

      reply.code(response.status);
      reply.type('application/sdp');
      return answerSdp;

    } catch (error) {
      if (error instanceof SafeProxyError) {
        logger.warn({ err: error.message }, 'WHIP proxy blocked');
        return reply.code(error.status).send({ error: error.message });
      }
      logger.error({ err: error }, 'WHIP proxy error');
      return reply.code(502).send({ error: 'Failed to connect to WHIP server' });
    }
  });

  // WHIP DELETE proxy - teardown a WHIP session
  fastify.delete('/whip-proxy', { preHandler: authHook }, async (request, reply) => {
    const targetUrl = request.query.url;

    if (!targetUrl) {
      return reply.code(400).send({ error: 'url query parameter is required' });
    }

    try {
      const url = new URL(targetUrl);
      if (isPrivateIP(url.hostname)) {
        return reply.code(403).send({ error: 'Access to internal networks is not allowed' });
      }
      if (!ALLOWED_WHEP_HOSTS.includes(url.hostname)) {
        return reply.code(403).send({ error: 'Server not in allowed list' });
      }
    } catch (e) {
      return reply.code(400).send({ error: 'Invalid URL format' });
    }

    try {
      const response = await safeProxyFetch(targetUrl, { method: 'DELETE' }, 10000);
      return reply.code(response.status).send();
    } catch (error) {
      if (error instanceof SafeProxyError) {
        return reply.code(error.status).send({ error: error.message });
      }
      logger.error({ err: error }, 'WHIP DELETE proxy error');
      return reply.code(502).send({ error: 'Failed to teardown WHIP session' });
    }
  });

  // Get all public cameras (with pagination + optional bbox filter)
  // Supports ?bbox=west,south,east,north for viewport-based queries
  fastify.get('/cameras', async (request, reply) => {
    try {
      const DEFAULT_LIMIT = 50;
      const MAX_LIMIT = 200;

      const page = Math.max(1, parseInt(request.query.page) || 1);
      const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(request.query.limit) || DEFAULT_LIMIT));

      // Parse optional bbox (west,south,east,north)
      let bbox = null;
      if (request.query.bbox) {
        const parts = request.query.bbox.split(',').map(Number);
        if (parts.length === 4 && parts.every(n => !isNaN(n))) {
          bbox = { west: parts[0], south: parts[1], east: parts[2], north: parts[3] };
        }
      }

      const result = bbox
        ? await db.getPublicCamerasByBbox(bbox, page, limit)
        : await db.getPublicCamerasPaginated(page, limit);

      // Add HLS URL for all cameras with mediamtx_path
      const cameras = result.items.map(cam => {
        const base = { ...cam };
        if (cam.mediamtx_path) {
          base.hls_url = getHlsUrl(cam.mediamtx_path);
        }
        // Strip internal rtsp_source_url from response
        if (cam.camera_type === 'city') {
          base.rtsp_source_url = undefined;
        }
        return base;
      });

      return {
        cameras,
        pagination: result.pagination
      };
    } catch (error) {
      logger.error({ err: error }, 'Camera list error');
      return reply.code(500).send({ error: 'Failed to retrieve cameras' });
    }
  });

  // Get all city cameras (public, no pagination needed - usually small list)
  fastify.get('/city-cameras', async (request, reply) => {
    try {
      const cameras = await db.getCityCameras();
      // Internal request from clip scheduler (MediaMTX server) — include source URLs
      const isInternal = request.query.internal === '1' &&
        [...services.allowedWhepHosts, '127.0.0.1', '::1'].includes(request.ip);

      return {
        cameras: cameras.map(c => {
          const cam = {
            id: c.id,
            device_id: c.device_id,
            name: c.name,
            lng: c.lng,
            lat: c.lat,
            camera_type: c.camera_type,
            whep_url: c.whep_url,
            is_city_camera: true
          };
          if (c.mediamtx_path) {
            cam.mediamtx_path = c.mediamtx_path;
            cam.hls_url = `https://hls.qbitmap.com/clips/${c.mediamtx_path}/playlist.m3u8`;
          }
          // Include source URL only for internal requests (clip scheduler)
          if (isInternal && c.rtsp_source_url) {
            cam.source_url = c.rtsp_source_url;
          }
          return cam;
        })
      };
    } catch (error) {
      logger.error({ err: error }, 'City cameras list error');
      return reply.code(500).send({ error: 'Failed to retrieve city cameras' });
    }
  });

  // Camera settings (AI monitoring config). Shared by WHEP (user) and City
  // (admin) cameras; public consumers get a whitelisted subset only.
  const PUBLIC_SETTINGS_FIELDS = [
    'ai_capture_interval_ms',
    'ai_detection_enabled',
    'stream_resolution'
  ];

  fastify.get('/settings/:deviceId', { preHandler: optionalAuthHook }, async (request, reply) => {
    const { deviceId } = request.params;

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      const settings = await db.getCameraSettings(camera.id);

      if (!settings) {
        return { config_version: 0, settings: {}, message: 'No settings configured yet' };
      }

      const isOwner = request.user?.userId && camera.user_id === request.user.userId;
      const allSettings = JSON.parse(settings.settings_json);
      const exposedSettings = isOwner
        ? allSettings
        : Object.fromEntries(
            Object.entries(allSettings).filter(([key]) => PUBLIC_SETTINGS_FIELDS.includes(key))
          );

      return {
        config_version: settings.config_version,
        settings: exposedSettings,
        updated_at: settings.updated_at
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, 'Get settings error');
      return reply.code(500).send({ error: 'Failed to retrieve settings' });
    }
  });

  fastify.put('/settings/:deviceId', {
    preHandler: [authHook, validateBody(cameraSettingsSchema)]
  }, async (request, reply) => {
    const { deviceId } = request.params;

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      if (camera.user_id !== request.user.userId) {
        logger.warn({ userId: request.user.userId, ownerId: camera.user_id, deviceId }, 'Unauthorized settings update attempt');
        return reply.code(403).send({ error: 'Not authorized to modify this camera' });
      }

      const newSettings = request.body;
      const newVersion = await db.updateCameraSettings(camera.id, JSON.stringify(newSettings));

      logger.info({ cameraId: camera.id, configVersion: newVersion }, 'Settings updated');

      return {
        status: 'ok',
        config_version: newVersion,
        settings: newSettings
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, 'Update settings error');
      return reply.code(500).send({ error: 'Failed to update settings' });
    }
  });

  // ==================== VOICE CALL ROUTES ====================

  /**
   * GET /api/public/cameras/:deviceId/voice-call
   * Get voice call enabled status for a camera
   */
  fastify.get('/cameras/:deviceId/voice-call', { preHandler: authHook }, async (request, reply) => {
    const { deviceId } = request.params;

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      // Check ownership
      if (camera.user_id !== request.user.userId) {
        return reply.code(403).send({ error: 'Not authorized' });
      }

      return {
        deviceId,
        cameraId: camera.id,
        voiceCallEnabled: !!camera.voice_call_enabled
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, 'Get voice call status error');
      return reply.code(500).send({ error: 'Failed to get voice call status' });
    }
  });

  /**
   * PUT /api/public/cameras/:deviceId/voice-call
   * Toggle voice call enabled status for a camera
   * Body: { enabled: boolean }
   */
  fastify.put('/cameras/:deviceId/voice-call', { preHandler: authHook }, async (request, reply) => {
    const { deviceId } = request.params;
    const { enabled } = request.body || {};

    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled field must be a boolean' });
    }

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      const result = await db.setVoiceCallEnabled(camera.id, request.user.userId, enabled);

      if (!result.success) {
        return reply.code(403).send({ error: result.error });
      }

      logger.info({ deviceId, enabled }, 'Voice call status updated');

      return {
        success: true,
        deviceId,
        cameraId: camera.id,
        voiceCallEnabled: result.enabled
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, 'Update voice call status error');
      return reply.code(500).send({ error: 'Failed to update voice call status' });
    }
  });

  // ==================== AUDIO MUTE ROUTES ====================

  /**
   * PUT /api/public/cameras/:deviceId/audio-muted
   * Toggle audio muted status for a camera
   * Body: { muted: boolean }
   */
  fastify.put('/cameras/:deviceId/audio-muted', { preHandler: authHook }, async (request, reply) => {
    const { deviceId } = request.params;
    const { muted } = request.body || {};

    if (typeof muted !== 'boolean') {
      return reply.code(400).send({ error: 'muted field must be a boolean' });
    }

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      const result = await db.setAudioMuted(camera.id, request.user.userId, muted);

      if (!result.success) {
        return reply.code(403).send({ error: result.error });
      }

      logger.info({ deviceId, muted }, 'Audio muted status updated');

      return {
        success: true,
        deviceId,
        cameraId: camera.id,
        audioMuted: result.muted
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, 'Update audio muted status error');
      return reply.code(500).send({ error: 'Failed to update audio muted status' });
    }
  });

  // ==================== MEDIAMTX METRICS ====================

  /**
   * GET /api/public/mediamtx/metrics/:path
   * Get MediaMTX metrics for a specific stream path
   * Returns viewer count and bandwidth information
   */
  fastify.get('/mediamtx/metrics/:path', {
    schema: {
      // MediaMTX path names are camera-system generated and follow a
      // strict ABCDEFabcdef0-9_ pattern (e.g. cam_1_mo8fjaf2_60b73dbc...).
      // Reject anything else outright so attacker-controlled values
      // never reach the MediaMTX admin API or get logged.
      params: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' }
        }
      }
    }
  }, async (request, reply) => {
    const { path } = request.params;

    try {
      const MEDIAMTX_API = services.mediamtxApi;

      // Fetch path info and HLS muxer info in parallel
      const [pathRes, hlsRes] = await Promise.all([
        fetchWithTimeout(`${MEDIAMTX_API}/v3/paths/get/${encodeURIComponent(path)}`, {}, 5000).catch(() => null),
        fetchWithTimeout(`${MEDIAMTX_API}/v3/hlsmuxers/get/${encodeURIComponent(path)}`, {}, 5000).catch(() => null)
      ]);

      const formatBytes = (bytes) => {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
      };

      if (!pathRes?.ok) {
        const hlsData = hlsRes?.ok ? await hlsRes.json() : null;
        return {
          path,
          state: 'notReady',
          viewers: 0,
          hlsActive: !!hlsData,
          bytesReceived: 0,
          bytesSent: hlsData?.bytesSent || 0,
          bytesReceivedFormatted: '0 B',
          bytesSentFormatted: '0 B'
        };
      }

      const data = await pathRes.json();
      const hlsData = hlsRes?.ok ? await hlsRes.json() : null;

      // Count real viewers (exclude internal hlsMuxer reader)
      const realReaders = (data.readers || []).filter(r => r.type !== 'hlsMuxer');
      const viewers = realReaders.length;

      const bytesReceived = data.bytesReceived || 0;
      // Combine path bytesSent (WHEP/RTSP) + HLS muxer bytesSent
      const pathBytesSent = data.bytesSent || 0;
      const hlsBytesSent = hlsData?.bytesSent || 0;
      const bytesSent = pathBytesSent + hlsBytesSent;
      const state = data.ready ? 'ready' : 'notReady';

      return {
        path,
        state,
        viewers,
        hlsActive: !!hlsData,
        bytesReceived,
        bytesSent,
        bytesReceivedFormatted: formatBytes(bytesReceived),
        bytesSentFormatted: formatBytes(bytesSent)
      };

    } catch (error) {
      logger.error({ err: error, path }, 'MediaMTX metrics fetch error');
      return reply.code(500).send({ error: 'Failed to fetch metrics' });
    }
  });

  // ==================== AI SETTINGS ====================

  /**
   * GET /api/public/ai-settings
   * Get AI prompt settings for frontend use (no auth required)
   */
  fastify.get('/ai-settings', async (request, reply) => {
    try {
      const settings = await db.getAllSystemSettings();
      const getSetting = (key) => settings.find(s => s.key === key)?.value || null;

      return {
        ai_monitoring_prompt: getSetting('ai_monitoring_prompt'),
        ai_search_prompt: getSetting('ai_search_prompt'),
        ai_max_tokens: getSetting('ai_max_tokens') || '1024',
        ai_temperature: getSetting('ai_temperature') || '0.7',
        ai_vision_model: getSetting('ai_vision_model') || 'qwen3-vl:32b-instruct',
        ai_broadcast_interval: getSetting('ai_broadcast_interval') || '3000',
        ai_broadcast_prompt: getSetting('ai_broadcast_prompt')
      };
    } catch (error) {
      logger.error({ err: error }, 'AI settings fetch error');
      return reply.code(500).send({ error: 'Failed to fetch AI settings' });
    }
  });

  // ==================== USER LOCATIONS (for map) ====================

  /**
   * GET /api/public/user-locations
   * Get all users who enabled "show location on map"
   * Returns GeoJSON for map display
   */
  fastify.get('/user-locations', async (request, reply) => {
    try {
      const users = await db.getUsersWithVisibleLocation();

      // Return as GeoJSON FeatureCollection
      return {
        type: 'FeatureCollection',
        features: users.map(user => ({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [user.last_lng, user.last_lat]
          },
          properties: {
            userId: user.id,
            displayName: user.display_name || 'User',
            avatarUrl: user.avatar_url,
            cameraCount: user.camera_count,
            accuracy: user.last_location_accuracy,
            updatedAt: user.last_location_updated
          }
        }))
      };
    } catch (error) {
      logger.error({ err: error }, 'User locations fetch error');
      return reply.code(500).send({ error: 'Failed to fetch user locations' });
    }
  });

  // ==================== IMAGE PROXY (for CORS-restricted images) ====================

  // Allowed image domains (prevent SSRF - only allow trusted image hosts)
  const ALLOWED_IMAGE_DOMAINS = [
    'lh3.googleusercontent.com',  // Google profile pictures
    'googleusercontent.com',
    'avatars.githubusercontent.com',  // GitHub avatars
  ];

  /**
   * GET /api/public/image-proxy
   * Proxy images from trusted domains to bypass CORS restrictions
   * Used for displaying Google avatars on canvas
   */
  fastify.get('/image-proxy', async (request, reply) => {
    try {
      const { url } = request.query;

      if (!url) {
        return reply.code(400).send({ error: 'URL parameter required' });
      }

      // Parse and validate URL
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch (e) {
        return reply.code(400).send({ error: 'Invalid URL' });
      }

      // Only allow HTTPS
      if (parsedUrl.protocol !== 'https:') {
        return reply.code(400).send({ error: 'Only HTTPS URLs allowed' });
      }

      // Check if domain is allowed
      const hostname = parsedUrl.hostname.toLowerCase();
      const isAllowed = ALLOWED_IMAGE_DOMAINS.some(domain =>
        hostname === domain || hostname.endsWith('.' + domain)
      );

      if (!isAllowed) {
        logger.warn({ hostname, url }, 'Image proxy blocked - domain not allowed');
        return reply.code(403).send({ error: 'Domain not allowed' });
      }

      // Fetch the image with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      let response;
      try {
        response = await fetch(url, {
          headers: { 'User-Agent': 'QBitmap-ImageProxy/1.0' },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        return reply.code(response.status).send({ error: 'Failed to fetch image' });
      }

      // Verify content type is an image
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.startsWith('image/')) {
        return reply.code(400).send({ error: 'URL does not point to an image' });
      }

      // Reject oversized images (max 2MB for avatars)
      const contentLength = parseInt(response.headers.get('content-length') || '0');
      if (contentLength > 2 * 1024 * 1024) {
        return reply.code(413).send({ error: 'Image too large' });
      }

      // Get image data as buffer
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 2 * 1024 * 1024) {
        return reply.code(413).send({ error: 'Image too large' });
      }

      // Set cache headers (cache for 1 hour)
      reply.header('Cache-Control', 'public, max-age=3600');
      reply.header('Content-Type', contentType);
      reply.header('Access-Control-Allow-Origin', '*');

      return reply.send(buffer);

    } catch (error) {
      logger.error({ err: error }, 'Image proxy error');
      return reply.code(500).send({ error: 'Failed to proxy image' });
    }
  });

  // H3 Grid Service - camera coordinates for full sync
  // Rate-limit caps brute-force attempts on X-Service-Key. Real consumer
  // (h3-service full-sync) runs on the order of once per day; 10/min is far
  // above normal usage. timingSafeEqual + length guard prevents
  // character-by-character secret recovery via response-time side channel.
  // Long-term: move to HMAC(body, key) + timestamp to defeat replay if the
  // key leaks via logs/proxy caches.
  fastify.get('/all-camera-coordinates', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const expectedKey = process.env.H3_SERVICE_KEY;
    if (!expectedKey) return reply.code(503).send({ error: 'Service key not configured' });

    const provided = Buffer.from(String(request.headers['x-service-key'] || ''), 'utf8');
    const expected = Buffer.from(expectedKey, 'utf8');
    if (
      provided.length !== expected.length ||
      !crypto.timingSafeEqual(provided, expected)
    ) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const rows = await db.getCamerasWithGeolocation();
    return { cameras: rows };
  });
}

module.exports = publicRoutes;
