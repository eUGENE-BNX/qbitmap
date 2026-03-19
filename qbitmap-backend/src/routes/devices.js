const db = require("../services/database");
const { validateDeviceToken } = require("../utils/auth");
const { validateBody, cameraSettingsSchema, deviceIdSchema, validate } = require("../utils/validation");
const frameCache = require("../services/frame-cache");
const streamCache = require("../services/stream-cache");
const logger = require("../utils/logger").child({ module: "devices" });

// [PERF] Module-level Map for last_seen throttling (survives across requests)
const lastSeenUpdates = new Map();

async function deviceRoutes(fastify, options) {

  // Public routes (no auth required) - with pagination
  fastify.get("/list", async (request, reply) => {
    try {
      const page = Math.max(1, parseInt(request.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit) || 50));
      const offset = (page - 1) * limit;

      // Get paginated results (uses db method instead of raw SQL)
      const result = await db.getPublicCamerasPaginated(page, limit);
      const cameras = result.items;
      const total = result.pagination.total;

      return {
        cameras,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      logger.error({ err: error }, "Failed to retrieve cameras");
      return reply.code(500).send({ error: "Failed to retrieve cameras" });
    }
  });

  // Historical frame lookup (DEPRECATED - frames no longer stored in DB)
  fastify.get("/frame/:frameId/image", async (request, reply) => {
    return reply.code(410).send({
      error: "Historical frame storage has been deprecated",
      hint: "Use memory cache for live frames"
    });
  });

  // Auth hook for protected routes (skip public routes)
  fastify.addHook("preHandler", async (request, reply) => {
    // Skip auth for public routes
    const publicRoutes = ["/list", "/frame/"];
    const pathname = request.url.split('?')[0];
    if (publicRoutes.some(r => pathname === r || pathname.startsWith(r))) {
      return;
    }

    const deviceId = request.headers["x-device-id"];
    const deviceToken = request.headers["x-device-token"];

    if (!deviceId || !deviceToken) {
      return reply.code(401).send({ error: "Missing device credentials" });
    }

    if (!validateDeviceToken(deviceId, deviceToken)) {
      return reply.code(401).send({ error: "Invalid device token" });
    }

    request.deviceId = deviceId;
  });

  // Device registration
  fastify.post("/", async (request, reply) => {
    const { deviceId } = request;

    try {
      const camera = await db.registerCamera(deviceId);

      logger.info({ deviceId, cameraId: camera.id }, "Device registered");

      // Get settings to retrieve capture_interval_ms
      const settings = await db.getCameraSettings(camera.id);
      // Always send current config version in header
      if (settings) {
        reply.header("X-Config-Version", settings.config_version.toString());
      }
      let captureIntervalMs = 5000; // Default 5 seconds
      let configVersion = 0;

      if (settings) {
        try {
          const settingsObj = JSON.parse(settings.settings_json);
          captureIntervalMs = settingsObj.capture_interval_ms || 5000;
        } catch {}
        configVersion = settings.config_version;
      }

      return {
        status: "registered",
        camera_id: camera.id,
        device_id: deviceId,
        message: "Device registered successfully",
        capture_interval_ms: captureIntervalMs,
        config_version: configVersion
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, "Registration failed");
      return reply.code(500).send({ error: "Registration failed" });
    }
  });

  // Frame upload with settings sync + MEMORY CACHE
  // Rate limited to 30 frames/minute per device (0.5 fps) to prevent abuse
  fastify.post("/:deviceId/frame", {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (req) => req.deviceId || req.headers['x-device-id']
      }
    }
  }, async (request, reply) => {
    const { deviceId } = request;
    const currentVersion = parseInt(request.headers["x-config-version"] || "0");

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: "Camera not found. Register first." });
      }

      const frameData = request.body;

      if (!Buffer.isBuffer(frameData) || frameData.length === 0) {
        return reply.code(400).send({ error: "Invalid frame data" });
      }

      const capturedAt = new Date();

      // Store in memory cache only (no DB - reduces I/O and BLOB storage)
      frameCache.set(camera.id, frameData, capturedAt);
      logger.debug({ cameraId: camera.id, size: frameData.length }, "Frame cached");

      const settings = await db.getCameraSettings(camera.id);
      // Always send current config version in header
      if (settings) {
        reply.header("X-Config-Version", settings.config_version.toString());
      }
      const dbVersion = settings ? settings.config_version : 0;

      if (settings && settings.config_version > currentVersion) {
        reply.header("X-Config-Version", settings.config_version.toString());
        logger.info({ cameraId: camera.id, oldVersion: currentVersion, newVersion: settings.config_version }, "Sending settings update");
        return {
          status: "ok",
          settings: JSON.parse(settings.settings_json),
          config_version: settings.config_version
        };
      }

      return {
        status: "ok"
      };

    } catch (error) {
      logger.error({ err: error, deviceId }, "Frame upload failed");
      return reply.code(500).send({ error: "Frame upload failed" });
    }
  });

  // Stream frame upload (MJPEG push mode - high frequency)
  // Also handles settings sync via piggyback (like normal frame upload)
  // Rate limited to 300 frames/minute per device (5 fps) for streaming
  fastify.post("/:deviceId/stream", {
    config: {
      rateLimit: {
        max: 300,
        timeWindow: '1 minute',
        keyGenerator: (req) => req.deviceId || req.headers['x-device-id']
      }
    }
  }, async (request, reply) => {
    const { deviceId } = request;
    const currentVersion = parseInt(request.headers["x-config-version"] || "0");

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: "Camera not found" });
      }

      const frameData = request.body;

      if (!Buffer.isBuffer(frameData) || frameData.length === 0) {
        return reply.code(400).send({ error: "Invalid frame data" });
      }

      // Store in stream cache (fast, no DB write)
      streamCache.set(camera.id, frameData);

      // Update last_seen timestamp (throttled - only every 5 seconds)
      // [PERF] Use module-level Map instead of camera object (which is re-fetched each request)
      const now = Date.now();
      const lastUpdate = lastSeenUpdates.get(camera.id);
      if (!lastUpdate || now - lastUpdate > 5000) {
        await db.updateCameraLastSeen(camera.id);
        lastSeenUpdates.set(camera.id, now);
      }

      // Settings sync via piggyback (same as normal frame upload)
      const settings = await db.getCameraSettings(camera.id);
      if (settings) {
        reply.header("X-Config-Version", settings.config_version.toString());
      }

      // If settings changed, send them in response
      if (settings && settings.config_version > currentVersion) {
        logger.info({ cameraId: camera.id, oldVersion: currentVersion, newVersion: settings.config_version }, "Stream settings update");
        return {
          status: "ok",
          settings: JSON.parse(settings.settings_json),
          config_version: settings.config_version
        };
      }

      return { status: "ok" };

    } catch (error) {
      logger.error({ err: error, deviceId }, "Stream upload failed");
      return reply.code(500).send({ error: "Stream upload failed" });
    }
  });

  // Get camera info
  fastify.get("/:deviceId", async (request, reply) => {
    const { deviceId } = request;

    const camera = await db.getCameraByDeviceId(deviceId);
    if (!camera) {
      return reply.code(404).send({ error: "Camera not found" });
    }

    const settings = await db.getCameraSettings(camera.id);
    // Always send current config version in header
    if (settings) {
      reply.header("X-Config-Version", settings.config_version.toString());
    }
    const cachedFrame = frameCache.get(camera.id);

    return {
      camera: {
        id: camera.id,
        device_id: camera.device_id,
        name: camera.name,
        location: camera.lng && camera.lat ? { lng: camera.lng, lat: camera.lat } : null,
        is_public: !!camera.is_public,
        stream_mode: camera.stream_mode,
        last_seen: camera.last_seen,
        created_at: camera.created_at
      },
      settings: settings ? {
        config_version: settings.config_version,
        settings: JSON.parse(settings.settings_json),
        updated_at: settings.updated_at
      } : null,
      has_cached_frame: !!cachedFrame,
      last_frame_at: cachedFrame ? cachedFrame.capturedAt.toISOString() : null
    };
  });

  // Get latest frame info for a camera (cache only - frames not stored in DB)
  fastify.get("/:deviceId/frame/latest", async (request, reply) => {
    const { deviceId } = request.params;

    // Validate deviceId format
    const validation = validate(deviceId, deviceIdSchema);
    if (!validation.success) {
      return reply.code(400).send({ error: "Invalid device ID format" });
    }

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: "Camera not found" });
      }

      // Get from memory cache (frames are no longer stored in DB)
      const cachedFrame = frameCache.get(camera.id);
      if (!cachedFrame) {
        return reply.code(404).send({ error: "No live frame available (camera may be offline)" });
      }

      return {
        id: "cached",
        file_size: cachedFrame.size,
        captured_at: cachedFrame.capturedAt.toISOString().replace("T", " ").substring(0, 19),
        source: "cache"
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, "Failed to retrieve latest frame");
      return reply.code(500).send({ error: "Failed to retrieve frame" });
    }
  });

  // Get camera settings
  fastify.get("/:deviceId/settings", async (request, reply) => {
    const { deviceId } = request;

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: "Camera not found" });
      }

      const settings = await db.getCameraSettings(camera.id);
      // Always send current config version in header
      if (settings) {
        reply.header("X-Config-Version", settings.config_version.toString());
      }

      if (!settings) {
        return {
          config_version: 0,
          settings: {},
          message: "No settings configured yet"
        };
      }

      return {
        config_version: settings.config_version,
        settings: JSON.parse(settings.settings_json),
        updated_at: settings.updated_at
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, "Failed to retrieve settings");
      return reply.code(500).send({ error: "Failed to retrieve settings" });
    }
  });

  // Update camera settings
  // Uses Zod validation to ensure settings are valid and not too large
  fastify.put("/:deviceId/settings", {
    preHandler: validateBody(cameraSettingsSchema)
  }, async (request, reply) => {
    const { deviceId } = request;

    try {
      const camera = await db.getCameraByDeviceId(deviceId);
      if (!camera) {
        return reply.code(404).send({ error: "Camera not found" });
      }

      const newSettings = request.body;

      const settingsJson = JSON.stringify(newSettings);
      const newVersion = await db.updateCameraSettings(camera.id, settingsJson);

      logger.info({ cameraId: camera.id, configVersion: newVersion }, "Settings updated");

      return {
        status: "ok",
        config_version: newVersion,
        settings: newSettings,
        message: "Settings updated successfully. Device will sync on next frame upload."
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, "Failed to update settings");
      return reply.code(500).send({ error: "Failed to update settings" });
    }
  });
}

module.exports = deviceRoutes;
