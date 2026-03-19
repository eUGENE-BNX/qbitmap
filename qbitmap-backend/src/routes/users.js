const db = require('../services/database');
const { authHook } = require('../utils/jwt');
const frameCache = require('../services/frame-cache');
const faceApi = require('../services/face-api');
const mediamtx = require('../services/mediamtx');
const { validateBody, addRtspCameraSchema, safePath } = require('../utils/validation');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const { checkFeatureLimit } = require('../middleware/limits');
const path = require('path');
const fs = require('fs');
const { mkdir, writeFile } = require('fs/promises');
const crypto = require('crypto');
const logger = require('../utils/logger').child({ module: 'users' });

// ONVIF Events service configuration
const ONVIF_SERVICE_URL = process.env.ONVIF_SERVICE_URL || 'http://91.98.90.57:3003';

async function userRoutes(fastify, options) {

  // All routes in this module require authentication
  fastify.addHook('preHandler', authHook);

  // Get current user's profile (with plan info)
  fastify.get('/me', async (request, reply) => {
    const user = await db.getUserById(request.user.userId);

    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    // Get effective limits
    const limits = await db.getUserEffectiveLimits(request.user.userId);

    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
      hasFaceRegistered: !!user.face_api_person_id,
      plan: {
        id: limits?.plan_id,
        name: limits?.plan_name,
        displayName: limits?.plan_display_name
      },
      role: limits?.role || 'user',
      isActive: limits?.is_active ?? true,
      location: await db.getUserLocation(request.user.userId)
    };
  });

  // ==================== USER LOCATION ====================

  // Get current user's location
  fastify.get('/me/location', async (request, reply) => {
    const location = await db.getUserLocation(request.user.userId);
    return { location };
  });

  // Update current user's location
  fastify.put('/me/location', async (request, reply) => {
    const { lat, lng, accuracy } = request.body;

    if (lat === undefined || lng === undefined) {
      return reply.code(400).send({ error: 'lat and lng are required' });
    }

    // Validate coordinates (including NaN/Infinity check)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return reply.code(400).send({ error: 'Invalid coordinates' });
    }

    await db.updateUserLocation(request.user.userId, lat, lng, accuracy || null);

    logger.info({ user: request.user.email, lat, lng, accuracy }, 'User location updated');

    return {
      status: 'ok',
      message: 'Location updated',
      location: await db.getUserLocation(request.user.userId)
    };
  });

  // Update location visibility setting
  fastify.put('/me/location/visibility', async (request, reply) => {
    const { showOnMap } = request.body;

    if (showOnMap === undefined) {
      return reply.code(400).send({ error: 'showOnMap is required' });
    }

    await db.updateUserLocationVisibility(request.user.userId, showOnMap);

    logger.info({ user: request.user.email, showOnMap }, 'User location visibility updated');

    return {
      status: 'ok',
      message: showOnMap ? 'Location visible on map' : 'Location hidden from map',
      location: await db.getUserLocation(request.user.userId)
    };
  });

  // Get current user's limits and usage
  fastify.get('/me/limits', async (request, reply) => {
    const limits = await db.getUserEffectiveLimits(request.user.userId);
    const usage = await db.getUserTodayUsage(request.user.userId);

    if (!limits) {
      return reply.code(404).send({ error: 'User not found' });
    }

    // Get current counts - single query instead of 3 separate queries
    const cameraCounts = await db.getUserCameraTypeCounts(request.user.userId);
    const cameraCount = cameraCounts.total;
    const deviceCameraCount = cameraCounts.device_count;
    const whepCameraCount = cameraCounts.whep_count;

    return {
      limits,
      usage: {
        ai_analysis: {
          used: usage.ai_analysis_count,
          limit: limits.ai_daily_limit,
          unlimited: limits.ai_daily_limit === -1
        },
        cameras: {
          device: {
            used: deviceCameraCount,
            limit: limits.max_cameras,
            unlimited: limits.max_cameras === -1
          },
          whep: {
            used: whepCameraCount,
            limit: limits.max_whep_cameras,
            unlimited: limits.max_whep_cameras === -1
          },
          total: cameraCount
        },
        recording_minutes: {
          used: usage.recording_minutes,
          limit: limits.max_recording_hours * 60,
          unlimited: limits.max_recording_hours === -1
        }
      }
    };
  });

  // ==================== FACE REGISTRATION ====================

  // Upload face image
  fastify.put('/me/face', async (request, reply) => {
    try {
      const data = await request.file();

      if (!data) {
        return reply.code(400).send({ error: 'No file uploaded' });
      }

      // Validate file type
      const allowedTypes = ['image/jpeg', 'image/png'];
      if (!allowedTypes.includes(data.mimetype)) {
        return reply.code(400).send({ error: 'Only JPEG and PNG images are allowed' });
      }

      // Read file buffer
      const chunks = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Check file size (2MB limit)
      if (buffer.length > 2 * 1024 * 1024) {
        return reply.code(400).send({ error: 'File size must be less than 2MB' });
      }

      const userId = request.user.userId;
      const user = await db.getUserById(userId);

      // Check if user already has a face registered
      let personId = user.face_api_person_id;

      // If no person exists, create one
      if (!personId) {
        const createResult = await faceApi.createPerson(user.email, `qbitmap_user_${userId}`);

        if (!createResult.ok || !createResult.data.success || !createResult.data.result?.id) {
          logger.error({ result: createResult, userId }, 'Failed to create person in Face API');
          return reply.code(500).send({ error: 'Failed to create face profile' });
        }

        personId = createResult.data.result.id;
        logger.info({ personId, userId }, 'Created person in Face API');
      }

      // Add face to the person (send buffer directly, not base64)
      const addFaceResult = await faceApi.addFace(personId, buffer, data.mimetype);

      if (!addFaceResult.ok) {
        logger.error({ result: addFaceResult, personId }, 'Failed to add face');
        return reply.code(400).send({ error: addFaceResult.data?.error || 'Failed to register face. Please try a clearer photo.' });
      }

      // Save image to filesystem
      const uploadsDir = path.join(__dirname, '../../uploads/faces');
      await mkdir(uploadsDir, { recursive: true });
      const ext = data.mimetype === 'image/png' ? 'png' : 'jpg';
      const filename = `${userId}_${crypto.randomUUID()}.${ext}`;
      const filePath = path.join(uploadsDir, filename);

      await writeFile(filePath, buffer);

      // Update database
      await db.updateUserFace(userId, `/uploads/faces/${filename}`, personId);

      logger.info({ user: request.user.email, personId }, 'Face registered');

      return {
        status: 'ok',
        message: 'Face registered successfully',
        hasFaceRegistered: true
      };
    } catch (error) {
      logger.error({ err: error }, 'Face upload error');
      return reply.code(500).send({ error: 'Failed to process face image' });
    }
  });

  // Delete face registration
  fastify.delete('/me/face', async (request, reply) => {
    const userId = request.user.userId;
    const faceInfo = await db.getUserFaceInfo(userId);

    if (!faceInfo || !faceInfo.hasFaceRegistered) {
      return reply.code(400).send({ error: 'No face registered' });
    }

    try {
      // Delete from Face API
      if (faceInfo.faceApiPersonId) {
        await faceApi.deletePerson(faceInfo.faceApiPersonId);
        logger.info({ personId: faceInfo.faceApiPersonId }, 'Deleted person from Face API');
      }

      // Delete local file (path traversal safe)
      if (faceInfo.faceImagePath) {
        const filePath = safePath(faceInfo.faceImagePath, 'uploads');
        if (filePath && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }

      // Clear database
      await db.clearUserFace(userId);

      logger.info({ user: request.user.email }, 'Face deleted');

      return {
        status: 'ok',
        message: 'Face registration deleted',
        hasFaceRegistered: false
      };
    } catch (error) {
      logger.error({ err: error }, 'Face delete error');
      return reply.code(500).send({ error: 'Failed to delete face registration' });
    }
  });

  // ==================== CAMERA ROUTES ====================

  // Get current user's cameras
  fastify.get('/me/cameras', async (request, reply) => {
    const cameras = await db.getUserCameras(request.user.userId);

    // Add latest frame info for each camera
    const camerasWithFrames = cameras.map(camera => {
      const cachedFrame = frameCache.get(camera.id);
      return {
        ...camera,
        hasRecentFrame: !!cachedFrame,
        lastFrameAt: cachedFrame ? cachedFrame.capturedAt.toISOString() : null
      };
    });

    return { cameras: camerasWithFrames };
  });

  // Claim a camera (device type)
  fastify.post('/me/cameras/claim', async (request, reply) => {
    const { device_id } = request.body;

    if (!device_id) {
      return reply.code(400).send({ error: 'device_id is required' });
    }

    const result = await db.claimCamera(request.user.userId, device_id);

    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    logger.info({ user: request.user.email, deviceId: device_id }, 'Camera claimed');

    return {
      status: 'ok',
      message: 'Camera claimed successfully',
      camera: result.camera
    };
  });

  // Create a WHEP camera (WebRTC stream)
  fastify.post('/me/cameras/whep', {
    preHandler: checkFeatureLimit('whep_cameras')
  }, async (request, reply) => {
    const { name, whep_url } = request.body;

    if (!whep_url) {
      return reply.code(400).send({ error: 'whep_url is required' });
    }

    // Validate URL format
    try {
      const url = new URL(whep_url);
      if (!url.pathname.includes('/whep')) {
        return reply.code(400).send({ error: 'Invalid WHEP URL format. URL should end with /whep' });
      }
    } catch (e) {
      return reply.code(400).send({ error: 'Invalid URL format' });
    }

    const result = await db.createWhepCamera(request.user.userId, {
      name: name || 'WHEP Camera',
      whepUrl: whep_url
    });

    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    logger.info({ user: request.user.email, whepUrl: whep_url }, 'WHEP camera created');

    return {
      status: 'ok',
      message: 'WHEP camera created successfully',
      camera: result.camera
    };
  });

  // ==================== RTSP CAMERA (UNIFIED) ====================

  /**
   * Create an RTSP camera with automatic MediaMTX and ONVIF integration
   * POST /me/cameras/rtsp
   * Body: { name, rtsp_url, onvif_port, enable_onvif, onvif_template_id }
   *
   * IMPORTANT: Order of operations for proper rollback:
   * 1. External services FIRST (MediaMTX, ONVIF)
   * 2. Database commit LAST
   * This ensures we can cleanly rollback external services if anything fails
   */
  fastify.post('/me/cameras/rtsp', {
    preHandler: validateBody(addRtspCameraSchema)
  }, async (request, reply) => {
    const { name, rtsp_url, onvif_port, enable_onvif, onvif_template_id } = request.body;
    const userId = request.user.userId;

    // Parse RTSP URL to extract credentials (includes SSRF + DNS rebinding protection)
    const parsed = await mediamtx.parseRtspUrl(rtsp_url);
    if (!parsed) {
      return reply.code(400).send({
        error: 'Invalid RTSP URL format or blocked IP address',
        hint: 'Private/internal IP addresses are not allowed for security reasons'
      });
    }

    const { host, username, password } = parsed;

    // Generate unique path name for MediaMTX (cryptographically secure)
    const pathName = mediamtx.generatePathName(userId);

    // Track what we've created for rollback
    const created = { mediamtx: false, onvif: false };
    let onvifCameraId = null;

    try {
      // ============================================================
      // STEP 1: Add to MediaMTX FIRST (external service)
      // ============================================================
      logger.info({ pathName, host }, 'Adding camera to MediaMTX');
      const mediamtxResult = await mediamtx.addPath(pathName, rtsp_url);

      if (!mediamtxResult.success) {
        return reply.code(502).send({
          error: 'Failed to add camera to streaming server',
          details: mediamtxResult.error
        });
      }
      created.mediamtx = true;

      // ============================================================
      // STEP 2: Add to ONVIF-Events service (external service, optional)
      // ============================================================
      if (enable_onvif) {
        onvifCameraId = `cam_${userId}_${Date.now().toString(36)}`;

        // Get profile slug from template if specified
        let profileSlug = null;
        if (onvif_template_id) {
          const template = await db.getOnvifTemplateById(onvif_template_id);
          if (template && template.model_name) {
            // Convert model name to profile slug: "Tapo C325WB" → "tapo-c325wb"
            profileSlug = template.model_name.toLowerCase().replace(/\s+/g, '-');
            logger.info({ templateId: onvif_template_id, modelName: template.model_name, profileSlug }, 'Resolved ONVIF profile from template');
          }
        }

        try {
          logger.info({ onvifCameraId, host, onvif_port, profile: profileSlug }, 'Adding camera to ONVIF service');

          const onvifPayload = {
            id: onvifCameraId,
            name: name || 'RTSP Camera',
            host: host,
            port: onvif_port || 2020,
            username: username,
            password: password
          };

          // Add profile if we have one
          if (profileSlug) {
            onvifPayload.profile = profileSlug;
          }

          const onvifResponse = await fetchWithTimeout(`${ONVIF_SERVICE_URL}/cameras`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(onvifPayload)
          }, 15000);

          if (onvifResponse.ok) {
            created.onvif = true;
            logger.info({ onvifCameraId }, 'Camera added to ONVIF service');
          } else {
            const errorData = await onvifResponse.json().catch(() => ({}));
            logger.warn({ onvifCameraId, status: onvifResponse.status, error: errorData }, 'ONVIF service returned error (continuing anyway)');
            // Don't fail - ONVIF is optional
            onvifCameraId = null;
          }
        } catch (onvifError) {
          logger.warn({ err: onvifError }, 'ONVIF service unavailable (continuing anyway)');
          onvifCameraId = null;
        }
      }

      // ============================================================
      // STEP 3: Validate ONVIF template exists (if specified)
      // ============================================================
      let templateId = 1; // Default to Generic template
      if (onvif_template_id) {
        const template = await db.getOnvifTemplateById(onvif_template_id);
        if (!template) {
          // Rollback external services before returning error
          throw new Error(`ONVIF template with ID ${onvif_template_id} not found`);
        }
        templateId = onvif_template_id;
      }

      // ============================================================
      // STEP 4: Create camera in database LAST
      // This is the commit point - if this succeeds, the operation is complete
      // ============================================================
      const whepUrl = mediamtx.getWhepUrl(pathName);

      const dbResult = await db.createRtspCamera(userId, {
        name: name || 'RTSP Camera',
        whepUrl: whepUrl,
        mediamtxPath: pathName,
        onvifCameraId: onvifCameraId,
        rtspSourceUrl: rtsp_url
      });

      if (!dbResult.success) {
        throw new Error(dbResult.error || 'Database error');
      }

      // ============================================================
      // STEP 5: Create ONVIF link (post-commit, non-critical)
      // If this fails, the camera still works, just without ONVIF link
      // ============================================================
      if (onvifCameraId && created.onvif) {
        try {
          await db.createOnvifLink(dbResult.camera.id, onvifCameraId, templateId);
          logger.info({ cameraId: dbResult.camera.id, onvifCameraId, templateId }, 'ONVIF link created');
        } catch (linkError) {
          // Log but don't fail - camera is already created
          logger.error({ err: linkError, cameraId: dbResult.camera.id, onvifCameraId }, 'Failed to create ONVIF link (camera still functional)');
        }
      }

      logger.info({
        user: request.user.email,
        cameraId: dbResult.camera.id,
        pathName,
        onvifCameraId,
        whepUrl: mediamtx.sanitizeRtspUrl(whepUrl) // Don't log full URL
      }, 'RTSP camera created successfully');

      return {
        status: 'ok',
        message: 'Camera added successfully',
        camera: {
          ...dbResult.camera,
          onvif_linked: !!onvifCameraId
        }
      };

    } catch (error) {
      logger.error({ err: error, pathName, onvifCameraId }, 'RTSP camera creation failed, rolling back external services');

      // ============================================================
      // ROLLBACK: Clean up external services in reverse order
      // Database was never committed, so nothing to rollback there
      // ============================================================

      const rollbackResults = { mediamtx: null, onvif: null };

      // Rollback: Remove from ONVIF service first
      if (created.onvif && onvifCameraId) {
        try {
          await fetchWithTimeout(`${ONVIF_SERVICE_URL}/cameras/${onvifCameraId}`, {
            method: 'DELETE'
          }, 5000);
          rollbackResults.onvif = 'success';
        } catch (err) {
          logger.error({ err, onvifCameraId }, 'Rollback: Failed to remove ONVIF camera');
          rollbackResults.onvif = 'failed';
        }
      }

      // Rollback: Remove from MediaMTX
      if (created.mediamtx) {
        try {
          await mediamtx.removePath(pathName);
          rollbackResults.mediamtx = 'success';
        } catch (err) {
          logger.error({ err, pathName }, 'Rollback: Failed to remove MediaMTX path');
          rollbackResults.mediamtx = 'failed';
        }
      }

      logger.info({ rollbackResults }, 'Rollback completed');

      return reply.code(500).send({
        error: 'Failed to create camera',
        details: 'Camera creation failed. Please check your settings and try again.'
      });
    }
  });

  // ==================== RTMP CAMERA ====================

  /**
   * Create an RTMP camera (GoPro, OBS, etc.)
   * POST /me/cameras/rtmp
   * Body: { name }
   *
   * RTMP cameras are simpler than RTSP:
   * - No external service calls needed (MediaMTX auto-creates paths on first publish)
   * - No credentials to manage
   * - Just generate path and return RTMP URL for user to configure their device
   */
  fastify.post('/me/cameras/rtmp', async (request, reply) => {
    const { name } = request.body;
    const userId = request.user.userId;

    // Check WHEP camera limits (RTMP counts toward WHEP limit)
    const limits = await db.getUserEffectiveLimits(userId);
    const currentWhep = await db.getUserWhepCameraCount(userId);

    if (limits.max_whep_cameras !== -1 && currentWhep >= limits.max_whep_cameras) {
      return reply.code(403).send({
        error: 'WHEP/RTMP kamera limitine ulastiniz',
        limit: limits.max_whep_cameras,
        current: currentWhep
      });
    }

    // Generate unique path for RTMP (same pattern as RTSP)
    const pathName = mediamtx.generatePathName(userId);

    // RTMP URL format: rtmp://rtmp.qbitmap.com:1935/{pathName}
    // Note: rtmp.qbitmap.com is DNS-only (no Cloudflare proxy) because Cloudflare doesn't proxy RTMP
    const rtmpUrl = `rtmp://rtmp.qbitmap.com:1935/${pathName}`;

    // WHEP URL for playback (same as RTSP cameras)
    const whepUrl = `https://stream.qbitmap.com/${pathName}/whep`;

    try {
      // Add empty path to MediaMTX for RTMP publish
      const mediamtxResult = await mediamtx.addRtmpPath(pathName);
      if (!mediamtxResult.success) {
        return reply.code(502).send({
          error: 'Failed to create RTMP path on streaming server',
          details: mediamtxResult.error
        });
      }

      // Create camera in database
      const result = await db.createRtmpCamera(userId, {
        name: name || 'RTMP Kamera',
        whepUrl: whepUrl,
        mediamtxPath: pathName
      });

      if (!result.success) {
        return reply.code(500).send({ error: result.error });
      }

      logger.info({
        user: request.user.email,
        cameraId: result.camera.id,
        pathName,
        rtmpUrl
      }, 'RTMP camera created');

      return {
        status: 'ok',
        message: 'RTMP kamera olusturuldu',
        camera: {
          ...result.camera,
          rtmp_url: rtmpUrl
        }
      };

    } catch (error) {
      logger.error({ err: error, pathName }, 'RTMP camera creation failed');
      return reply.code(500).send({ error: 'Kamera olusturulamadi' });
    }
  });

  // Update a camera
  fastify.put('/me/cameras/:cameraId', async (request, reply) => {
    const cameraId = parseInt(request.params.cameraId);
    const { name, lng, lat, is_public, whep_url } = request.body;

    // Update basic camera info
    const result = await db.updateCamera(cameraId, request.user.userId, {
      name,
      lng,
      lat,
      isPublic: is_public
    });

    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    // Update WHEP URL if provided
    if (whep_url !== undefined) {
      await db.updateCameraWhepUrl(cameraId, request.user.userId, whep_url);
    }

    logger.info({ user: request.user.email, cameraId }, 'Camera updated');

    return {
      status: 'ok',
      message: 'Camera updated successfully',
      camera: await db.getCameraById(cameraId)
    };
  });

  // Get single camera details (must be owner)
  fastify.get('/me/cameras/:cameraId', async (request, reply) => {
    const cameraId = parseInt(request.params.cameraId);

    if (!await db.isUserCameraOwner(request.user.userId, cameraId)) {
      return reply.code(403).send({ error: 'You do not own this camera' });
    }

    const camera = await db.getCameraById(cameraId);
    const settings = await db.getCameraSettings(cameraId);
    const cachedFrame = frameCache.get(cameraId);

    return {
      camera: {
        id: camera.id,
        device_id: camera.device_id,
        name: camera.name,
        lng: camera.lng,
        lat: camera.lat,
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
      stats: {
        has_cached_frame: !!cachedFrame,
        last_frame_at: cachedFrame ? cachedFrame.capturedAt.toISOString() : null
      }
    };
  });

  // Release camera ownership
  fastify.delete('/me/cameras/:cameraId', async (request, reply) => {
    const cameraId = parseInt(request.params.cameraId);

    const result = await db.releaseCamera(cameraId, request.user.userId);

    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    logger.info({ user: request.user.email, cameraId }, 'Camera released');

    return {
      status: 'ok',
      message: 'Camera released successfully'
    };
  });
  // ==================== CAMERA SHARING ====================

  /**
   * POST /me/cameras/:cameraId/share
   * Share a camera with another user by email
   */
  fastify.post('/me/cameras/:cameraId/share', async (request, reply) => {
    const cameraId = parseInt(request.params.cameraId);
    const { email } = request.body;

    if (!email) {
      return reply.code(400).send({ error: 'email is required' });
    }

    const result = await db.shareCamera(cameraId, request.user.userId, email);

    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    logger.info({ cameraId, sharedWith: email, user: request.user.email }, 'Camera shared');

    return {
      status: 'ok',
      message: 'Camera shared successfully',
      share: result.share
    };
  });

  /**
   * GET /me/cameras/:cameraId/shares
   * Get all shares for a camera
   */
  fastify.get('/me/cameras/:cameraId/shares', async (request, reply) => {
    const cameraId = parseInt(request.params.cameraId);

    // Check ownership
    if (!await db.isUserCameraOwner(request.user.userId, cameraId)) {
      return reply.code(403).send({ error: 'You do not own this camera' });
    }

    const shares = await db.getCameraShares(cameraId);
    return { shares };
  });

  /**
   * DELETE /me/cameras/:cameraId/shares/:shareId
   * Remove a camera share
   */
  fastify.delete('/me/cameras/:cameraId/shares/:shareId', async (request, reply) => {
    const shareId = parseInt(request.params.shareId);

    const result = await db.removeCameraShare(shareId, request.user.userId);

    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    logger.info({ shareId, user: request.user.email }, 'Camera share removed');

    return {
      status: 'ok',
      message: 'Share removed successfully'
    };
  });

  /**
   * GET /me/shared-cameras
   * Get cameras shared with the current user
   */
  fastify.get('/me/shared-cameras', async (request, reply) => {
    const userId = request.user.userId;
    fastify.log.info({ userId }, '[SharedCameras] Fetching shared cameras for user');

    const cameras = await db.getSharedCameras(userId);
    fastify.log.info({ userId, count: cameras.length }, '[SharedCameras] Found cameras');

    // Add latest frame info for each camera
    const camerasWithFrames = cameras.map(camera => {
      const cachedFrame = frameCache.get(camera.id);
      return {
        ...camera,
        hasRecentFrame: !!cachedFrame,
        lastFrameAt: cachedFrame ? cachedFrame.capturedAt.toISOString() : null
      };
    });

    return { cameras: camerasWithFrames };
  });

  // ==================== DELETE CAMERA (with cleanup) ====================

  // MediaMTX server configuration (use env variable)
  const MEDIAMTX_SERVER = process.env.MEDIAMTX_SERVER || "91.98.90.57";

  /**
   * Validate path name to prevent command injection
   * Only allows alphanumeric characters, underscores, and hyphens
   */
  function isValidPathName(pathName) {
    return /^[a-zA-Z0-9_-]+$/.test(pathName);
  }

  // Delete camera permanently (with full cleanup: ONVIF → MediaMTX → DB)
  // Order matters: delete from external services FIRST, then database LAST
  fastify.delete("/me/cameras/:cameraId/delete", async (request, reply) => {
    const cameraId = parseInt(request.params.cameraId);
    const { deleteRecordings = true } = request.body || {};

    // Check ownership
    if (!await db.isUserCameraOwner(request.user.userId, cameraId)) {
      return reply.code(403).send({ error: "You do not own this camera" });
    }

    // Get camera data before deletion
    const camera = await db.getCameraById(cameraId);
    if (!camera) {
      return reply.code(404).send({ error: "Camera not found" });
    }

    const isWhep = camera.camera_type === "whep";

    // Get MediaMTX path - prefer stored path, fallback to extracting from URL
    let pathName = camera.mediamtx_path;
    if (!pathName && isWhep && camera.whep_url) {
      const match = camera.whep_url.match(/\/([^\/]+)\/whep/i);
      pathName = match ? match[1] : null;
    }

    // Get ONVIF camera ID
    const onvifCameraId = camera.onvif_camera_id;

    const cleanupResults = {
      onvifCamera: null,
      mediamtxPath: null,
      recordings: null,
      database: false
    };

    try {
      // ============================================================
      // IMPORTANT: Delete from external services FIRST, database LAST
      // This prevents orphaned resources if database deletion fails
      // ============================================================

      // 1. Delete from ONVIF-Events service FIRST
      if (onvifCameraId) {
        try {
          const onvifResponse = await fetchWithTimeout(
            `${ONVIF_SERVICE_URL}/cameras/${onvifCameraId}`,
            { method: 'DELETE' },
            10000
          );
          cleanupResults.onvifCamera = onvifResponse.ok ? "deleted" : "failed";
          logger.info({ onvifCameraId, status: onvifResponse.status }, "ONVIF camera cleanup");
        } catch (err) {
          logger.error({ err, onvifCameraId }, "ONVIF camera deletion failed");
          cleanupResults.onvifCamera = "error";
          // Continue anyway - we don't want orphaned DB records
        }
      }

      // 2. For WHEP/RTSP cameras: cleanup MediaMTX
      if (isWhep && pathName) {
        try {
          const mediamtxResult = await mediamtx.removePath(pathName);
          cleanupResults.mediamtxPath = mediamtxResult.success ? "deleted" : "failed";
          if (mediamtxResult.warning) {
            cleanupResults.mediamtxPath = "not_found";
          }
          logger.info({ pathName, result: cleanupResults.mediamtxPath }, "MediaMTX path cleanup");
        } catch (err) {
          logger.error({ err, pathName }, "MediaMTX path deletion failed");
          cleanupResults.mediamtxPath = "error";
          // Continue anyway
        }

        // 3. Delete recordings folder (using execFile to prevent command injection)
        if (deleteRecordings && pathName && isValidPathName(pathName)) {
          try {
            const { execFile } = require("child_process");
            const { promisify } = require("util");
            const execFileAsync = promisify(execFile);
            const recordingsPath = `/opt/rtcgateway/recordings/${pathName}`;

            // Use execFile instead of exec to prevent shell injection
            await execFileAsync('ssh', [
              '-o', 'StrictHostKeyChecking=accept-new',
              '-o', 'BatchMode=yes',
              '-o', 'ConnectTimeout=10',
              `root@${MEDIAMTX_SERVER}`,
              'rm', '-rf', recordingsPath
            ]);

            cleanupResults.recordings = "deleted";
            logger.info({ pathName, recordingsPath }, "Recordings deleted");
          } catch (err) {
            logger.error({ err, pathName }, "Recordings deletion failed");
            cleanupResults.recordings = "error";
          }
        } else if (pathName && !isValidPathName(pathName)) {
          logger.warn({ pathName }, "Invalid path name format, skipping recordings deletion for security");
          cleanupResults.recordings = "skipped_invalid_path";
        }
      }

      // 4. Delete from database LAST (this also removes ONVIF links via CASCADE)
      const dbResult = await db.deleteCamera(cameraId, request.user.userId);
      if (!dbResult.success) {
        return reply.code(400).send({ error: dbResult.error });
      }
      cleanupResults.database = true;

      logger.info({
        cameraId,
        cameraName: camera.name,
        deviceId: camera.device_id,
        cameraType: camera.camera_type,
        pathName,
        onvifCameraId,
        cleanup: cleanupResults,
        user: request.user.email
      }, "Camera deleted with full cleanup");

      return { status: "ok", message: "Camera deleted successfully", cleanup: cleanupResults };

    } catch (error) {
      logger.error({ err: error, cameraId }, "Camera deletion failed");
      return reply.code(500).send({ error: "Failed to delete camera" });
    }
  });

}

module.exports = userRoutes;
