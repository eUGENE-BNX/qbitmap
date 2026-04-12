/**
 * Feature limit middleware for QBitmap
 * Checks user's plan limits before allowing access to features
 */

const db = require('../services/database');

/**
 * Create a limit check middleware for a specific feature
 * @param {string} feature - Feature to check (cameras, whep_cameras, ai_analysis, etc.)
 * @returns {Function} Fastify preHandler
 */
function checkFeatureLimit(feature) {
  return async function(request, reply) {
    // User must be authenticated
    // Note: JWT sets request.user.userId, not request.user.id
    const userId = request.user?.userId || request.user?.id;
    if (!userId) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    const result = await db.checkFeatureLimit(userId, feature);

    if (!result.allowed) {
      return reply.status(403).send({
        error: result.reason || 'Feature limit reached',
        feature,
        current: result.current,
        limit: result.limit
      });
    }

    // Attach limit info to request for use in handlers
    request.featureLimit = result;
  };
}

/**
 * Check face limit for a specific camera
 * Requires cameraId in params
 */
async function checkFaceLimitMiddleware(request, reply) {
  const userId = request.user?.userId || request.user?.id;
  if (!userId) {
    return reply.status(401).send({ error: 'Authentication required' });
  }

  const cameraId = request.params.cameraId || request.params.id || request.params.deviceId;
  if (!cameraId) {
    return reply.status(400).send({ error: 'Camera ID required' });
  }

  // deviceId might be string (device_id), cameraId might be numeric (id)
  // checkFaceLimit expects numeric camera.id, so lookup if needed
  let numericCameraId = parseInt(cameraId);
  if (isNaN(numericCameraId)) {
    // It's a device_id string, look up the camera
    const camera = await db.getCameraByDeviceId(cameraId);
    if (!camera) {
      return reply.status(404).send({ error: 'Camera not found' });
    }
    numericCameraId = camera.id;
  }

  const result = await db.checkFaceLimit(userId, numericCameraId);

  if (!result.allowed) {
    return reply.status(403).send({
      error: result.reason || 'Face limit reached',
      feature: 'face_per_camera',
      current: result.current,
      limit: result.limit
    });
  }

  request.faceLimit = result;
}

// [ARCH-02] requireAdmin removed — admin role check now runs inline
// in routes/admin.js using the JWT role claim (zero DB hit). The old
// middleware was never imported by any route file anyway.

/**
 * Check if user account is active
 */
async function requireActive(request, reply) {
  const userId = request.user?.userId || request.user?.id;
  if (!userId) {
    return reply.status(401).send({ error: 'Authentication required' });
  }

  const limits = await db.getUserEffectiveLimits(userId);

  if (!limits) {
    return reply.status(401).send({ error: 'User not found' });
  }

  if (!limits.is_active) {
    return reply.status(403).send({ error: 'Account deactivated' });
  }

  // Attach limits to request
  request.userLimits = limits;
}

/**
 * Increment usage counter after successful operation
 * Call this after the main handler succeeds
 * @param {string} feature - Feature to increment (ai_analysis, face_recognition, recording, voice_call)
 * @param {number} amount - Amount to increment (default 1)
 */
function incrementUsage(userId, feature, amount = 1) {
  return db.incrementUsage(userId, feature, amount);
}

/**
 * Helper to get user's current limits and usage
 */
async function getUserLimitsAndUsage(userId) {
  const limits = await db.getUserEffectiveLimits(userId);
  const usage = await db.getUserTodayUsage(userId);
  return { limits, usage };
}

module.exports = {
  checkFeatureLimit,
  checkFaceLimitMiddleware,
  requireActive,
  incrementUsage,
  getUserLimitsAndUsage
};
