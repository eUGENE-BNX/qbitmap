const db = require('../services/database');
const frameCache = require('../services/frame-cache');
const streamCache = require('../services/stream-cache');
const { authHook, optionalAuthHook } = require('../utils/jwt');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const { validateBody, cameraSettingsSchema } = require('../utils/validation');
const logger = require('../utils/logger').child({ module: 'public' });

// Allowed WHEP server hosts (prevent SSRF attacks)
// Can be extended via environment variable (comma-separated)
const ALLOWED_WHEP_HOSTS = (process.env.ALLOWED_WHEP_HOSTS || '91.98.90.57')
  .split(',')
  .map(h => h.trim())
  .filter(Boolean);

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
      const response = await fetchWithTimeout(targetUrl, {
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
      const response = await fetchWithTimeout(targetUrl, {
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
      if (!ALLOWED_WHEP_HOSTS.includes(url.hostname)) {
        return reply.code(403).send({ error: 'Server not in allowed list' });
      }
    } catch (e) {
      return reply.code(400).send({ error: 'Invalid URL format' });
    }

    try {
      const response = await fetchWithTimeout(targetUrl, { method: 'DELETE' }, 10000);
      return reply.code(response.status).send();
    } catch (error) {
      logger.error({ err: error }, 'WHIP DELETE proxy error');
      return reply.code(502).send({ error: 'Failed to teardown WHIP session' });
    }
  });

  // Get all public cameras (with pagination)
  // Default limit: 500, Max limit: 1000 to prevent memory/IO issues
  fastify.get('/cameras', async (request, reply) => {
    try {
      const DEFAULT_LIMIT = 500;
      const MAX_LIMIT = 1000;

      const page = Math.max(1, parseInt(request.query.page) || 1);
      const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(request.query.limit) || DEFAULT_LIMIT));

      // Always use pagination to prevent unbounded queries
      const result = await db.getPublicCamerasPaginated(page, limit);

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
          // MediaMTX HLS URL (via hls.qbitmap.com)
          if (c.mediamtx_path) {
            cam.hls_url = getHlsUrl(c.mediamtx_path);
          }
          return cam;
        })
      };
    } catch (error) {
      logger.error({ err: error }, 'City cameras list error');
      return reply.code(500).send({ error: 'Failed to retrieve city cameras' });
    }
  });

  // Get frame JPEG image (supports both DB frame ID and "cached")
  // Note: Accessible to anyone who knows the device_id (for user's own cameras)
  fastify.get('/frames/:frameId', { preHandler: optionalAuthHook }, async (request, reply) => {
    const { frameId } = request.params;

    try {
      // Special handling for cached frames
      if (frameId === 'cached') {
        // Need device_id or camera_id to get cached frame
        const deviceId = request.query.device_id;
        if (!deviceId) {
          return reply.code(400).send({ error: 'device_id required for cached frames' });
        }

        const camera = await db.getCameraByDeviceId(deviceId);
        if (!camera) {
          return reply.code(404).send({ error: 'Camera not found' });
        }

        // Security: Check ownership for private cameras
        if (!camera.is_public) {
          if (!request.user) {
            return reply.code(401).send({ error: 'Authentication required for private camera' });
          }
          if (camera.user_id !== request.user.userId) {
            return reply.code(403).send({ error: 'Not authorized to access this camera' });
          }
        }

        const cachedFrame = frameCache.get(camera.id);
        if (!cachedFrame) {
          return reply.code(404).send({ error: 'No cached frame available' });
        }

        reply.type('image/jpeg');
        
        reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
        reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        reply.header('Pragma', 'no-cache');
        reply.header('Expires', '0');
        return cachedFrame.frameData;
      }

      // Historical frame lookup (DEPRECATED - frames no longer stored in DB)
      // Use /frames/cached?device_id=XXX for live frames instead
      return reply.code(410).send({
        error: 'Historical frame storage has been deprecated',
        hint: 'Use /frames/cached?device_id=XXX for live frames'
      });
    } catch (error) {
      logger.error({ err: error, frameId }, 'Frame image error');
      return reply.code(500).send({ error: 'Failed to retrieve frame image' });
    }
  });

  // Get latest frame info for a camera (FAST - uses cache first)
  fastify.get('/cameras/:deviceId/latest', { preHandler: optionalAuthHook }, async (request, reply) => {
    const { deviceId } = request.params;

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      // Security: Check ownership for private cameras
      if (!camera.is_public) {
        if (!request.user) {
          return reply.code(401).send({ error: 'Authentication required for private camera' });
        }
        if (camera.user_id !== request.user.userId) {
          return reply.code(403).send({ error: 'Not authorized to access this camera' });
        }
      }

      // Get frame from memory cache (frames are no longer stored in DB)
      const cachedFrame = frameCache.get(camera.id);
      if (!cachedFrame) {
        return reply.code(404).send({ error: 'No live frame available (camera may be offline)' });
      }

      return {
        camera: {
          id: camera.id,
          device_id: camera.device_id,
          name: camera.name,
          last_seen: camera.last_seen,
          is_public: camera.is_public
        },
        frame: {
          id: 'cached',
          file_size: cachedFrame.size,
          captured_at: cachedFrame.capturedAt.toISOString().replace('T', ' ').substring(0, 19) + 'Z',
          source: 'cache'
        }
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, 'Latest frame error');
      return reply.code(500).send({ error: 'Failed to retrieve frame' });
    }
  });

  // Get camera settings (filtered by ownership)
  const PUBLIC_SETTINGS_FIELDS = [
    'capture_interval_ms',
    'ai_capture_interval_ms',
    'ai_detection_enabled',
    'mjpeg_enabled'
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
        return {
          config_version: 0,
          settings: {},
          message: 'No settings configured yet'
        };
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

  // Update camera settings - REQUIRES AUTHENTICATION AND OWNERSHIP
  fastify.put('/settings/:deviceId', {
    preHandler: [authHook, validateBody(cameraSettingsSchema)]
  }, async (request, reply) => {
    const { deviceId } = request.params;

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      // Security: Verify ownership
      if (camera.user_id !== request.user.userId) {
        logger.warn({ userId: request.user.userId, ownerId: camera.user_id, deviceId }, 'Unauthorized settings update attempt');
        return reply.code(403).send({ error: 'Not authorized to modify this camera' });
      }

      const newSettings = request.body;

      const settingsJson = JSON.stringify(newSettings);
      const newVersion = await db.updateCameraSettings(camera.id, settingsJson);

      logger.info({ cameraId: camera.id, configVersion: newVersion }, 'Settings updated');

      return {
        status: 'ok',
        config_version: newVersion,
        settings: newSettings,
        message: 'Settings updated successfully. Device will sync on next frame upload.'
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, 'Update settings error');
      return reply.code(500).send({ error: 'Failed to update settings' });
    }
  });

  // MJPEG live stream endpoint
  // Security: Only accessible to camera owner, shared users, or if camera is public
  fastify.get('/stream/:deviceId', { preHandler: optionalAuthHook }, async (request, reply) => {
    const { deviceId } = request.params;

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      // Security check: public cameras are open, private cameras require auth
      if (!camera.is_public) {
        const userId = request.user?.userId;
        if (!userId) {
          return reply.code(401).send({ error: 'Authentication required for private camera' });
        }

        const access = await db.hasAccessToCamera(userId, deviceId);
        if (!access.hasAccess) {
          return reply.code(403).send({ error: 'Not authorized to view this camera' });
        }
      }

      // Check if camera has active stream
      if (!streamCache.hasActiveStream(camera.id)) {
        return reply.code(503).send({
          error: 'No active stream',
          message: 'Camera is not streaming. Enable MJPEG in camera settings.'
        });
      }

      logger.info({ deviceId }, 'Stream client connected');

      // Set MJPEG headers
      reply.raw.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Connection': 'keep-alive',
      });

      // Register client for frame updates
      streamCache.addClient(camera.id, reply);

      // Send initial frame if available
      const initialFrame = streamCache.get(camera.id);
      if (initialFrame) {
        reply.raw.write('--frame\r\n');
        reply.raw.write(`Content-Type: image/jpeg\r\nContent-Length: ${initialFrame.size}\r\n\r\n`);
        reply.raw.write(initialFrame.buffer);
        reply.raw.write('\r\n');
      }

      // Handle client disconnect
      request.raw.on('close', () => {
        logger.info({ deviceId }, 'Stream client disconnected');
        streamCache.removeClient(camera.id, reply);
      });

      // Keep connection open - don't return, let streamCache push frames
      return reply;

    } catch (error) {
      logger.error({ err: error, deviceId }, 'Stream error');
      return reply.code(500).send({ error: 'Stream failed' });
    }
  });

  // Stream status endpoint
  fastify.get('/stream/:deviceId/status', async (request, reply) => {
    const { deviceId } = request.params;

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: 'Camera not found' });
      }

      const hasStream = streamCache.hasActiveStream(camera.id);
      const clientCount = streamCache.getClientCount(camera.id);
      const latestFrame = streamCache.get(camera.id);

      return {
        device_id: deviceId,
        camera_id: camera.id,
        streaming: hasStream,
        clients: clientCount,
        last_frame: latestFrame ? {
          size: latestFrame.size,
          timestamp: latestFrame.timestamp.toISOString()
        } : null
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, 'Stream status error');
      return reply.code(500).send({ error: 'Failed to get stream status' });
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
  fastify.get('/mediamtx/metrics/:path', async (request, reply) => {
    const { path } = request.params;

    try {
      const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://91.98.90.57:9997';

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
        ai_vision_model: getSetting('ai_vision_model') || 'qwen3-vl:32b-instruct'
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

      // Fetch the image
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'QBitmap-ImageProxy/1.0'
        }
      });

      if (!response.ok) {
        return reply.code(response.status).send({ error: 'Failed to fetch image' });
      }

      // Verify content type is an image
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.startsWith('image/')) {
        return reply.code(400).send({ error: 'URL does not point to an image' });
      }

      // Get image data as buffer
      const buffer = Buffer.from(await response.arrayBuffer());

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
  fastify.get('/all-camera-coordinates', async (request, reply) => {
    const serviceKey = request.headers['x-service-key'];
    if (!serviceKey || serviceKey !== process.env.H3_SERVICE_KEY) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const [rows] = await db.pool.query(
      'SELECT id, device_id, lat, lng, name, camera_type, is_public FROM cameras WHERE lat IS NOT NULL AND lng IS NOT NULL'
    );
    return { cameras: rows };
  });
}

module.exports = publicRoutes;
