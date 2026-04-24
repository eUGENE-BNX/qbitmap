const db = require("../services/database");
const faceApi = require("../services/face-api");
const voiceCallService = require("../services/voice-call");
const { authHook } = require("../utils/jwt");
const { checkFaceLimitMiddleware } = require("../middleware/limits");
const { validateMagicBytes } = require("../utils/file-validation");
const logger = require("../utils/logger").child({ module: "face-detection" });
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

async function getCameraByDeviceId(deviceId, userId) {
  const camera = await db.getCameraByDeviceId(deviceId);
  if (!camera) return { error: "Camera not found", camera: null };
  if (camera.user_id !== userId) return { error: "Not authorized", camera: null };
  return { error: null, camera };
}

// Dedup key: `${userId}:${userFaceId}` → last push timestamp (ms).
// Client-side logs run every ~5s per camera; without this, a person standing
// in frame would spam 12 push notifications per minute. 60s window is tight
// enough to re-notify if they leave and come back shortly.
const _facePushCache = new Map();
const FACE_PUSH_DEDUP_MS = 60_000;

async function faceDetectionRoutes(fastify, options) {
  fastify.addHook("preHandler", authHook);

  // Route-level rate limit for face detection (resource-intensive)
  const faceRateLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  /**
   * GET /api/face-detection/active
   * Cameras with face detection enabled for current user.
   */
  fastify.get("/active", async (request, reply) => {
    try {
      const cameras = await db.getActiveFaceDetectionCameras(request.user.userId);
      return { cameras };
    } catch (error) {
      logger.error({ error }, "Failed to get active face detection cameras");
      return reply.code(500).send({ error: "Failed to get cameras" });
    }
  });

  /**
   * GET /api/face-detection/library
   * User's full face library (same list regardless of which camera opened the modal).
   */
  fastify.get("/library", async (request, reply) => {
    const faces = await db.getUserFaces(request.user.userId);
    return { faces };
  });

  /**
   * POST /api/face-detection/library
   * Add a new face to the user's library. Not camera-scoped: the matcher
   * service is already global, so each person_id should live in exactly
   * one user_faces row.
   */
  fastify.post("/library", {
    preHandler: async (request, reply) => {
      // Reuse checkFaceLimit via a synthetic cameraId (function now counts user_faces).
      const userId = request.user?.userId;
      if (!userId) return reply.code(401).send({ error: "Authentication required" });
      const result = await db.checkFaceLimit(userId, null);
      if (!result.allowed) {
        return reply.code(403).send({ error: result.reason || "Face limit reached", current: result.current, limit: result.limit });
      }
    },
    ...faceRateLimit
  }, async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: "No file uploaded" });

    const name = data.fields?.name?.value || "Unknown";

    const chunks = [];
    for await (const chunk of data.file) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const allowedTypes = ["image/jpeg", "image/png"];
    if (!allowedTypes.includes(data.mimetype)) return reply.code(400).send({ error: "Only JPEG and PNG allowed" });
    if (buffer.length > 2 * 1024 * 1024) return reply.code(400).send({ error: "File size must be less than 2MB" });
    if (!validateMagicBytes(buffer, data.mimetype)) return reply.code(400).send({ error: "File content does not match declared type" });

    try {
      const tag = "user_" + request.user.userId + "_" + Date.now();
      const createResult = await faceApi.createPerson(name, tag);
      if (!createResult.ok || !createResult.data?.result?.id) {
        logger.error({ createResult }, "Failed to create person");
        return reply.code(500).send({ error: "Failed to create face profile" });
      }

      const personId = createResult.data.result.id;
      const addFaceResult = await faceApi.addFace(personId, buffer, data.mimetype);
      if (!addFaceResult.ok) {
        await faceApi.deletePerson(personId);
        return reply.code(400).send({ error: addFaceResult.data?.error || "Failed to register face" });
      }

      const uploadsDir = path.resolve(__dirname, "../../uploads/camera-faces");
      await fs.promises.mkdir(uploadsDir, { recursive: true });
      const ext = data.mimetype === "image/png" ? "png" : "jpg";
      const filename = "u" + request.user.userId + "_" + personId + "_" + crypto.randomUUID() + "." + ext;
      const filePath = path.resolve(uploadsDir, filename);
      if (!filePath.startsWith(uploadsDir + path.sep)) {
        logger.error({ filename, filePath, uploadsDir }, "Path traversal attempt blocked");
        return reply.code(400).send({ error: "Invalid filename" });
      }
      await fs.promises.writeFile(filePath, buffer);

      const faceImageUrl = "/uploads/camera-faces/" + filename;
      const dbResult = await db.addUserFace(request.user.userId, personId, name, faceImageUrl);
      if (!dbResult.success) {
        await faceApi.deletePerson(personId);
        return reply.code(409).send({ error: dbResult.error });
      }

      logger.info({ userId: request.user.userId, personId, name, user: request.user.email }, "Face added to library");

      return {
        success: true,
        face: { id: dbResult.faceId, person_id: personId, name, face_image_url: faceImageUrl, trigger_alarm: 0 }
      };
    } catch (error) {
      logger.error({ err: error }, "Failed to add face");
      return reply.code(500).send({ error: "Failed to add face" });
    }
  });

  /**
   * DELETE /api/face-detection/library/:faceId
   */
  fastify.delete("/library/:faceId", async (request, reply) => {
    const { faceId } = request.params;
    const result = await db.removeUserFace(parseInt(faceId), request.user.userId);
    if (!result.success) return reply.code(404).send({ error: result.error });

    if (result.personId) {
      try { await faceApi.deletePerson(result.personId); }
      catch (e) { logger.warn({ personId: result.personId }, "Failed to delete from Face API"); }
    }

    logger.info({ faceId, user: request.user.email }, "Face removed from library");
    return { success: true };
  });

  /**
   * PATCH /api/face-detection/library/:faceId/alarm
   */
  fastify.patch("/library/:faceId/alarm", async (request, reply) => {
    const { faceId } = request.params;
    const { trigger_alarm } = request.body || {};
    const result = await db.updateUserFaceAlarm(parseInt(faceId), request.user.userId, trigger_alarm);
    if (!result.success) return reply.code(404).send({ error: result.error });
    return { success: true, trigger_alarm };
  });

  /**
   * GET /api/face-detection/:deviceId/settings
   * Per-camera detection knobs plus the (user-global) face list, kept in one
   * response so the modal's "Bu Kamera" tab can render in a single request.
   */
  fastify.get("/:deviceId/settings", async (request, reply) => {
    const { deviceId } = request.params;
    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    if (error) return reply.code(error === "Not authorized" ? 403 : 404).send({ error });

    const settings = await db.getFaceDetectionSettings(camera.id);
    const faces = await db.getUserFaces(request.user.userId);
    const recentLogs = await db.getFaceDetectionLogs(camera.id, 5);

    return {
      enabled: !!settings?.face_detection_enabled,
      alarm_trigger_names: settings?.alarm_trigger_names || "",
      interval: settings?.face_detection_interval || 10,
      match_threshold: settings?.face_match_threshold || 70,
      faces,
      recentDetections: recentLogs
    };
  });

  /**
   * PATCH /api/face-detection/:deviceId/settings
   */
  fastify.patch("/:deviceId/settings", async (request, reply) => {
    const { deviceId } = request.params;
    const { enabled, interval, alarm_trigger_names, match_threshold } = request.body || {};

    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    if (error) return reply.code(error === "Not authorized" ? 403 : 404).send({ error });

    const result = await db.updateFaceDetectionSettings(
      camera.id,
      request.user.userId,
      enabled,
      interval,
      alarm_trigger_names,
      match_threshold
    );
    if (!result.success) return reply.code(403).send({ error: result.error });

    logger.info({ deviceId, enabled, interval, match_threshold, user: request.user.email }, "Face detection settings updated");
    return { success: true, enabled, interval, match_threshold };
  });

  /**
   * GET /api/face-detection/:deviceId/faces
   * Backward-compat alias — still returns the user's full library, since
   * the UI hit this endpoint before the refactor.
   */
  fastify.get("/:deviceId/faces", async (request, reply) => {
    const { deviceId } = request.params;
    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    if (error) return reply.code(error === "Not authorized" ? 403 : 404).send({ error });
    const faces = await db.getUserFaces(request.user.userId);
    return { faces };
  });

  /**
   * POST /api/face-detection/:deviceId/faces
   * Legacy camera-scoped add-face — still accepted for backward compat but
   * writes to the user's global library. The deviceId is only used to
   * verify ownership.
   */
  fastify.post("/:deviceId/faces", {
    preHandler: checkFaceLimitMiddleware,
    ...faceRateLimit
  }, async (request, reply) => {
    const { deviceId } = request.params;
    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    if (error) return reply.code(error === "Not authorized" ? 403 : 404).send({ error });

    const data = await request.file();
    if (!data) return reply.code(400).send({ error: "No file uploaded" });

    const name = data.fields?.name?.value || "Unknown";

    const chunks = [];
    for await (const chunk of data.file) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const allowedTypes = ["image/jpeg", "image/png"];
    if (!allowedTypes.includes(data.mimetype)) return reply.code(400).send({ error: "Only JPEG and PNG allowed" });
    if (buffer.length > 2 * 1024 * 1024) return reply.code(400).send({ error: "File size must be less than 2MB" });
    if (!validateMagicBytes(buffer, data.mimetype)) return reply.code(400).send({ error: "File content does not match declared type" });

    try {
      const tag = "user_" + request.user.userId + "_" + Date.now();
      const createResult = await faceApi.createPerson(name, tag);
      if (!createResult.ok || !createResult.data?.result?.id) {
        logger.error({ createResult }, "Failed to create person");
        return reply.code(500).send({ error: "Failed to create face profile" });
      }

      const personId = createResult.data.result.id;
      const addFaceResult = await faceApi.addFace(personId, buffer, data.mimetype);
      if (!addFaceResult.ok) {
        await faceApi.deletePerson(personId);
        return reply.code(400).send({ error: addFaceResult.data?.error || "Failed to register face" });
      }

      const uploadsDir = path.resolve(__dirname, "../../uploads/camera-faces");
      await fs.promises.mkdir(uploadsDir, { recursive: true });
      const ext = data.mimetype === "image/png" ? "png" : "jpg";
      const filename = "u" + request.user.userId + "_" + personId + "_" + crypto.randomUUID() + "." + ext;
      const filePath = path.resolve(uploadsDir, filename);
      if (!filePath.startsWith(uploadsDir + path.sep)) {
        logger.error({ filename, filePath, uploadsDir }, "Path traversal attempt blocked");
        return reply.code(400).send({ error: "Invalid filename" });
      }
      await fs.promises.writeFile(filePath, buffer);

      const faceImageUrl = "/uploads/camera-faces/" + filename;
      const dbResult = await db.addUserFace(request.user.userId, personId, name, faceImageUrl);
      if (!dbResult.success) {
        await faceApi.deletePerson(personId);
        return reply.code(409).send({ error: dbResult.error });
      }

      logger.info({ deviceId, personId, name, user: request.user.email }, "Face added via camera route");

      return {
        success: true,
        face: { id: dbResult.faceId, person_id: personId, name, face_image_url: faceImageUrl, trigger_alarm: 0 }
      };
    } catch (error) {
      logger.error({ err: error, deviceId }, "Failed to add face");
      return reply.code(500).send({ error: "Failed to add face" });
    }
  });

  /**
   * DELETE /api/face-detection/:deviceId/faces/:faceId
   * Legacy alias — deletes from user's library; deviceId used only for auth.
   */
  fastify.delete("/:deviceId/faces/:faceId", async (request, reply) => {
    const { deviceId, faceId } = request.params;
    const { error } = await getCameraByDeviceId(deviceId, request.user.userId);
    if (error) return reply.code(error === "Not authorized" ? 403 : 404).send({ error });

    const result = await db.removeUserFace(parseInt(faceId), request.user.userId);
    if (!result.success) return reply.code(404).send({ error: result.error });

    if (result.personId) {
      try { await faceApi.deletePerson(result.personId); }
      catch (e) { logger.warn({ personId: result.personId }, "Failed to delete from Face API"); }
    }

    logger.info({ deviceId, faceId, user: request.user.email }, "Face removed");
    return { success: true };
  });

  /**
   * PATCH /api/face-detection/:deviceId/faces/:faceId/alarm
   * Legacy alias — toggles alarm on the user-level face.
   */
  fastify.patch("/:deviceId/faces/:faceId/alarm", async (request, reply) => {
    const { deviceId, faceId } = request.params;
    const { trigger_alarm } = request.body || {};
    const { error } = await getCameraByDeviceId(deviceId, request.user.userId);
    if (error) return reply.code(error === "Not authorized" ? 403 : 404).send({ error });
    const result = await db.updateUserFaceAlarm(parseInt(faceId), request.user.userId, trigger_alarm);
    if (!result.success) return reply.code(404).send({ error: result.error });
    logger.info({ deviceId, faceId, trigger_alarm, user: request.user.email }, "Face alarm toggled");
    return { success: true, trigger_alarm };
  });

  /**
   * GET /api/face-detection/:deviceId/logs
   */
  fastify.get("/:deviceId/logs", async (request, reply) => {
    const { deviceId } = request.params;
    const limit = parseInt(request.query.limit) || 10;
    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    if (error) return reply.code(error === "Not authorized" ? 403 : 404).send({ error });

    const logs = await db.getFaceDetectionLogs(camera.id, limit);
    return { logs };
  });

  /**
   * POST /api/face-detection/:deviceId/log
   * Client-side detection found a match; we persist it + maybe fire voice call.
   * Lookup is now user-scoped — a match for Ahmet triggers alarm on any of
   * this user's cameras, not only the one he was originally enrolled on.
   */
  fastify.post("/:deviceId/log", async (request, reply) => {
    const { deviceId } = request.params;
    const { person_id, name, confidence } = request.body || {};

    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    if (error) return reply.code(error === "Not authorized" ? 403 : 404).send({ error });

    try {
      let userFace = null;
      if (person_id) {
        userFace = await db.getUserFaceByPersonId(request.user.userId, person_id);
      }

      await db.logFaceDetection(camera.id, userFace?.id, name, confidence);

      // Voice call gates (unchanged): face.trigger_alarm + camera.voice_call_enabled + camera.face_detection_enabled
      if (userFace && userFace.trigger_alarm) {
        // Web Push — fires independently of voice call gate so users with
        // push enabled but voice calls disabled still get notified. Deduped
        // per (user, face) to avoid spamming while subject stays in frame.
        const pushKey = `${request.user.userId}:${userFace.id}`;
        const now = Date.now();
        const lastPush = _facePushCache.get(pushKey) || 0;
        if (now - lastPush > FACE_PUSH_DEDUP_MS) {
          _facePushCache.set(pushKey, now);
          try {
            const pushService = require('../services/push');
            await pushService.sendToUser(request.user.userId, {
              title: `${userFace.name} algılandı`,
              body: `${camera.name || deviceId} · skor ${Math.round(confidence || 0)}`,
              tag: `face-${userFace.id}`,
              topic: `face-${userFace.id}`,
              urgency: 'high',
              navigate: '/',
              icon: userFace.face_image_url || undefined,
              image: userFace.face_image_url || undefined,
            });
          } catch (err) {
            logger.warn({ err: err.message, deviceId, faceId: userFace.id }, 'face detection push failed (non-fatal)');
          }
        }

        const voiceCallEnabled = await db.getVoiceCallEnabled(camera.id);
        const faceSettings = await db.getFaceDetectionSettings(camera.id);

        if (voiceCallEnabled && faceSettings?.face_detection_enabled) {
          setImmediate(async () => {
            try {
              const result = await voiceCallService.initiateCallForFace(
                deviceId,
                camera.name || deviceId,
                userFace.name || name || 'Unknown'
              );

              if (result.success) {
                logger.info({ deviceId, faceName: userFace.name, personId: person_id, callId: result.callId }, 'Face detection voice call triggered');
              } else {
                logger.info({ deviceId, faceName: userFace.name, reason: result.reason }, 'Face detection voice call not triggered');
              }
            } catch (err) {
              logger.error({ err, deviceId, personId: person_id }, 'Face detection voice call error');
            }
          });
        }
      }

      return { success: true, trigger_alarm: !!userFace?.trigger_alarm };
    } catch (e) {
      logger.error({ err: e, deviceId }, "Failed to log face detection");
      return reply.code(500).send({ error: "Failed to log" });
    }
  });

  /**
   * POST /api/face-detection/:deviceId/recognize
   * Proxy to Face API with auth.
   */
  fastify.post("/:deviceId/recognize", { ...faceRateLimit }, async (request, reply) => {
    const { deviceId } = request.params;
    const { error } = await getCameraByDeviceId(deviceId, request.user.userId);
    if (error) return reply.code(error === "Not authorized" ? 403 : 404).send({ error });

    const data = await request.file();
    if (!data) return reply.code(400).send({ error: "No image uploaded" });

    const chunks = [];
    for await (const chunk of data.file) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const result = await faceApi.recognizeFace(buffer, data.mimetype || "image/jpeg");
    if (!result.ok) {
      logger.warn({ deviceId, status: result.status }, "Face recognition failed");
      return reply.code(result.status).send(result.data);
    }
    return result.data;
  });
}

module.exports = faceDetectionRoutes;
