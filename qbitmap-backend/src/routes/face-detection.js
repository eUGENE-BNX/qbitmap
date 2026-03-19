const db = require("../services/database");
const faceApi = require("../services/face-api");
const voiceCallService = require("../services/voice-call");
const { authHook } = require("../utils/jwt");
const { checkFaceLimitMiddleware } = require("../middleware/limits");
const logger = require("../utils/logger").child({ module: "face-detection" });
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Helper function to get camera by device_id and check ownership
async function getCameraByDeviceId(deviceId, userId) {
  const camera = await db.getCameraByDeviceId(deviceId);

  if (!camera) {
    return { error: "Camera not found", camera: null };
  }

  if (camera.user_id !== userId) {
    return { error: "Not authorized", camera: null };
  }

  return { error: null, camera };
}

async function faceDetectionRoutes(fastify, options) {
  // All routes require authentication
  fastify.addHook("preHandler", authHook);

  /**
   * GET /api/face-detection/active
   * Get all cameras with face detection enabled for current user
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
   * GET /api/face-detection/:deviceId/settings
   * Get face detection settings for a camera
   */
  fastify.get("/:deviceId/settings", async (request, reply) => {
    const { deviceId } = request.params;
    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    
    if (error) {
      return reply.code(error === "Not authorized" ? 403 : 404).send({ error });
    }

    const settings = await db.getFaceDetectionSettings(camera.id);
    const faces = await db.getCameraFaces(camera.id);
    const recentLogs = await db.getFaceDetectionLogs(camera.id, 5);

    return {
      enabled: !!settings?.face_detection_enabled, alarm_trigger_names: settings?.alarm_trigger_names || "",
      interval: settings?.face_detection_interval || 10,
      faces,
      recentDetections: recentLogs
    };
  });

  /**
   * PATCH /api/face-detection/:deviceId/settings
   * Update face detection settings (enable/disable, interval)
   */
  fastify.patch("/:deviceId/settings", async (request, reply) => {
    const { deviceId } = request.params;
    const { enabled, interval, alarm_trigger_names } = request.body || {};
    
    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    
    if (error) {
      return reply.code(error === "Not authorized" ? 403 : 404).send({ error });
    }

    const result = await db.updateFaceDetectionSettings(
      camera.id, 
      request.user.userId, 
      enabled, 
      interval,
      alarm_trigger_names
    );

    if (!result.success) {
      return reply.code(403).send({ error: result.error });
    }

    logger.info({ deviceId, enabled, interval, user: request.user.email }, "Face detection settings updated");

    return { success: true, enabled, interval };
  });

  /**
   * GET /api/face-detection/:deviceId/faces
   * List all reference faces for a camera
   */
  fastify.get("/:deviceId/faces", async (request, reply) => {
    const { deviceId } = request.params;
    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    
    if (error) {
      return reply.code(error === "Not authorized" ? 403 : 404).send({ error });
    }

    const faces = await db.getCameraFaces(camera.id);
    return { faces };
  });

  /**
   * POST /api/face-detection/:deviceId/faces
   * Add a reference face to a camera
   */
  fastify.post("/:deviceId/faces", {
    preHandler: checkFaceLimitMiddleware
  }, async (request, reply) => {
    const { deviceId } = request.params;
    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    
    if (error) {
      return reply.code(error === "Not authorized" ? 403 : 404).send({ error });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: "No file uploaded" });
    }

    const name = data.fields?.name?.value || "Unknown";

    // Read file buffer
    const chunks = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Validate file
    const allowedTypes = ["image/jpeg", "image/png"];
    if (!allowedTypes.includes(data.mimetype)) {
      return reply.code(400).send({ error: "Only JPEG and PNG allowed" });
    }

    if (buffer.length > 2 * 1024 * 1024) {
      return reply.code(400).send({ error: "File size must be less than 2MB" });
    }

    try {
      // Create person in Face API
      const tag = "camera_" + camera.id + "_" + Date.now();
      const createResult = await faceApi.createPerson(name, tag);

      if (!createResult.ok || !createResult.data?.result?.id) {
        logger.error({ createResult }, "Failed to create person");
        return reply.code(500).send({ error: "Failed to create face profile" });
      }

      const personId = createResult.data.result.id;

      // Add face to person
      const addFaceResult = await faceApi.addFace(personId, buffer, data.mimetype);

      if (!addFaceResult.ok) {
        // Cleanup: delete the person we just created
        await faceApi.deletePerson(personId);
        return reply.code(400).send({ 
          error: addFaceResult.data?.error || "Failed to register face" 
        });
      }

      // Save face image locally
      const uploadsDir = path.join(__dirname, "../../uploads/camera-faces");
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      const ext = data.mimetype === "image/png" ? "png" : "jpg";
      const filename = camera.id + "_" + personId + "_" + crypto.randomUUID() + "." + ext;
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, buffer);

      // Save to database
      const faceImageUrl = "/uploads/camera-faces/" + filename;
      const dbResult = await db.addCameraFace(camera.id, personId, name, faceImageUrl);

      logger.info({ deviceId, personId, name, user: request.user.email }, "Face added");

      return {
        success: true,
        face: {
          id: dbResult.faceId,
          person_id: personId,
          name,
          face_image_url: faceImageUrl
        }
      };

    } catch (error) {
      logger.error({ err: error, deviceId }, "Failed to add face");
      return reply.code(500).send({ error: "Failed to add face" });
    }
  });

  /**
   * DELETE /api/face-detection/:deviceId/faces/:faceId
   * Remove a reference face
   */
  fastify.delete("/:deviceId/faces/:faceId", async (request, reply) => {
    const { deviceId, faceId } = request.params;
    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    
    if (error) {
      return reply.code(error === "Not authorized" ? 403 : 404).send({ error });
    }

    const result = await db.removeCameraFace(parseInt(faceId), camera.id);

    if (!result.success) {
      return reply.code(404).send({ error: result.error });
    }

    // Delete from Face API
    if (result.personId) {
      try {
        await faceApi.deletePerson(result.personId);
      } catch (e) {
        logger.warn({ personId: result.personId }, "Failed to delete from Face API");
      }
    }

    logger.info({ deviceId, faceId, user: request.user.email }, "Face removed");

    return { success: true };
  });

  /**
   * PATCH /api/face-detection/:deviceId/faces/:faceId/alarm
   * Toggle alarm for a face
   */
  fastify.patch("/:deviceId/faces/:faceId/alarm", async (request, reply) => {
    const { deviceId, faceId } = request.params;
    const { trigger_alarm } = request.body || {};
    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    if (error) { return reply.code(error === "Not authorized" ? 403 : 404).send({ error }); }
    const result = await db.updateFaceAlarm(parseInt(faceId), camera.id, trigger_alarm);
    if (!result.success) { return reply.code(404).send({ error: result.error }); }
    logger.info({ deviceId, faceId, trigger_alarm, user: request.user.email }, "Face alarm toggled");
    return { success: true, trigger_alarm };
  });

  /**
   * GET /api/face-detection/:deviceId/logs
   * Get recent face detection logs
   */
  fastify.get("/:deviceId/logs", async (request, reply) => {
    const { deviceId } = request.params;
    const limit = parseInt(request.query.limit) || 10;
    
    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    
    if (error) {
      return reply.code(error === "Not authorized" ? 403 : 404).send({ error });
    }

    const logs = await db.getFaceDetectionLogs(camera.id, limit);
    return { logs };
  });
  /**
   * POST /api/face-detection/:deviceId/log
   * Log a face detection event and trigger voice call if conditions are met
   */
  fastify.post("/:deviceId/log", async (request, reply) => {
    const { deviceId } = request.params;
    const { face_id, person_id, name, confidence } = request.body || {};

    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    if (error) {
      return reply.code(error === "Not authorized" ? 403 : 404).send({ error });
    }

    try {
      // Log the face detection
      await db.logFaceDetection(camera.id, face_id, name, confidence);

      // Voice call trigger check:
      // 1. Face must have trigger_alarm=true
      // 2. Camera must have voice_call_enabled=true
      // 3. Camera must have face_detection_enabled=true
      if (person_id) {
        const face = await db.getFaceByPersonId(camera.id, person_id);

        if (face && face.trigger_alarm) {
          const voiceCallEnabled = await db.getVoiceCallEnabled(camera.id);
          const faceSettings = await db.getFaceDetectionSettings(camera.id);

          if (voiceCallEnabled && faceSettings?.face_detection_enabled) {
            // Trigger voice call asynchronously (don't block response)
            setImmediate(async () => {
              try {
                const result = await voiceCallService.initiateCallForFace(
                  deviceId,
                  camera.name || deviceId,
                  face.name || name || 'Unknown'
                );

                if (result.success) {
                  logger.info({
                    deviceId,
                    faceName: face.name,
                    personId: person_id,
                    callId: result.callId
                  }, 'Face detection voice call triggered');
                } else {
                  logger.info({
                    deviceId,
                    faceName: face.name,
                    reason: result.reason
                  }, 'Face detection voice call not triggered');
                }
              } catch (err) {
                logger.error({ err, deviceId, personId: person_id }, 'Face detection voice call error');
              }
            });
          }
        }
      }

      return { success: true };
    } catch (e) {
      logger.error({ e, deviceId }, "Failed to log face detection");
      return reply.code(500).send({ error: "Failed to log" });
    }
  });

  /**
   * POST /api/face-detection/:deviceId/recognize
   * Recognize faces in an image (proxies to Face API with auth)
   */
  fastify.post("/:deviceId/recognize", async (request, reply) => {
    const { deviceId } = request.params;

    const { error, camera } = await getCameraByDeviceId(deviceId, request.user.userId);
    if (error) {
      return reply.code(error === "Not authorized" ? 403 : 404).send({ error });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: "No image uploaded" });
    }

    // Read file buffer
    const chunks = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Call Face API with authentication
    const result = await faceApi.recognizeFace(buffer, data.mimetype || "image/jpeg");

    if (!result.ok) {
      logger.warn({ deviceId, status: result.status }, "Face recognition failed");
      return reply.code(result.status).send(result.data);
    }

    return result.data;
  });
}

module.exports = faceDetectionRoutes;
