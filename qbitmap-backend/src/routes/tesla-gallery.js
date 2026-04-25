const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const db = require('../services/database');
const { authHook } = require('../utils/jwt');
const { verifyTeslaImage } = require('../services/tesla-gallery-ai');
const logger = require('../utils/logger').child({ module: 'tesla-gallery' });

const UPLOADS_DIR = path.resolve(__dirname, '../../uploads/tesla-gallery');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per upload
const MAX_SLOT_INDEX = 7;

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function vehicleDir(vehiclePk) {
  return path.join(UPLOADS_DIR, String(vehiclePk));
}

function publicUrl(vehicleIdString, slot) {
  return `/api/tesla/vehicles/${encodeURIComponent(vehicleIdString)}/photos/${slot}/file`;
}

async function teslaGalleryRoutes(fastify) {

  // GET /vehicles/:vehicleId/photos — public list
  fastify.get('/vehicles/:vehicleId/photos', async (request, reply) => {
    const { vehicleId } = request.params;
    const vehicle = await db.getTeslaVehicleByVehicleId(vehicleId);
    if (!vehicle) return reply.code(404).send({ error: 'Vehicle not found' });

    const [rows] = await db.pool.execute(
      `SELECT slot_index, created_at FROM tesla_vehicle_photos
       WHERE tesla_vehicle_id = ? ORDER BY slot_index ASC`,
      [vehicle.id]
    );

    return {
      photos: rows.map(r => ({
        slot: r.slot_index,
        url: publicUrl(vehicleId, r.slot_index),
        createdAt: r.created_at,
      }))
    };
  });

  // GET /vehicles/:vehicleId/photos/:slot/file — public stream
  fastify.get('/vehicles/:vehicleId/photos/:slot/file', async (request, reply) => {
    const { vehicleId } = request.params;
    const slot = Number(request.params.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT_INDEX) {
      return reply.code(404).send({ error: 'Not found' });
    }

    const vehicle = await db.getTeslaVehicleByVehicleId(vehicleId);
    if (!vehicle) return reply.code(404).send({ error: 'Not found' });

    const [rows] = await db.pool.execute(
      `SELECT file_name FROM tesla_vehicle_photos
       WHERE tesla_vehicle_id = ? AND slot_index = ? LIMIT 1`,
      [vehicle.id, slot]
    );
    const fileName = rows[0]?.file_name;
    if (!fileName) return reply.code(404).send({ error: 'Not found' });

    const filePath = path.join(vehicleDir(vehicle.id), fileName);
    if (!filePath.startsWith(vehicleDir(vehicle.id) + path.sep)) {
      return reply.code(404).send({ error: 'Not found' });
    }

    try {
      const stat = await fsp.stat(filePath);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Content-Length', stat.size);
      reply.header('Cache-Control', 'public, max-age=300');
      return reply.send(fs.createReadStream(filePath));
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });

  // POST /vehicles/:vehicleId/photos/:slot — owner-only upload + AI verify
  fastify.post('/vehicles/:vehicleId/photos/:slot', {
    preHandler: authHook,
    bodyLimit: MAX_FILE_SIZE + 1024 * 64,
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '10 minutes'
      }
    }
  }, async (request, reply) => {
    const { vehicleId } = request.params;
    const slot = Number(request.params.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT_INDEX) {
      return reply.code(400).send({ error: 'Invalid slot' });
    }

    const userId = request.user.userId;
    const vehiclePk = await db.getOwnedTeslaVehiclePk(vehicleId, userId);
    if (!vehiclePk) return reply.code(403).send({ error: 'Not your vehicle' });

    // Read single multipart file
    let buffer = null;
    let truncated = false;
    try {
      const parts = request.parts({
        limits: { fileSize: MAX_FILE_SIZE, files: 1 }
      });

      for await (const part of parts) {
        if (part.type === 'field') continue;
        if (part.fieldname !== 'photo') {
          part.file.resume();
          continue;
        }
        if (part.mimetype !== 'image/jpeg') {
          part.file.resume();
          return reply.code(400).send({ error: 'Only image/jpeg accepted' });
        }
        const chunks = [];
        for await (const chunk of part.file) chunks.push(chunk);
        if (part.file.truncated) {
          truncated = true;
          break;
        }
        buffer = Buffer.concat(chunks);
        break;
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Multipart parse error');
      return reply.code(400).send({ error: 'Invalid multipart request' });
    }

    if (truncated) return reply.code(413).send({ error: 'File too large (max 5MB)' });
    if (!buffer || buffer.length === 0) return reply.code(400).send({ error: 'No file uploaded' });

    // AI verification (no quota — gallery uploads are limited by 5-slot constraint)
    const verdict = await verifyTeslaImage(buffer);

    if (!verdict.ok) {
      const status = verdict.transient ? 503 : 422;
      return reply.code(status).send({
        error: verdict.transient ? 'ai_unavailable' : 'ai_rejected',
        user_message_tr: verdict.user_message_tr,
      });
    }

    // Persist: write file, replace any existing slot file
    const dir = vehicleDir(vehiclePk);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const [existing] = await db.pool.execute(
      `SELECT file_name FROM tesla_vehicle_photos
       WHERE tesla_vehicle_id = ? AND slot_index = ? LIMIT 1`,
      [vehiclePk, slot]
    );
    const oldFile = existing[0]?.file_name;

    const fileName = `${slot}_${Date.now()}.jpg`;
    const filePath = path.join(dir, fileName);
    if (!filePath.startsWith(dir + path.sep)) {
      return reply.code(500).send({ error: 'Internal error' });
    }
    await fsp.writeFile(filePath, buffer);

    await db.pool.execute(
      `INSERT INTO tesla_vehicle_photos
       (tesla_vehicle_id, slot_index, file_name, width, height, byte_size, ai_confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         file_name = VALUES(file_name),
         width = VALUES(width),
         height = VALUES(height),
         byte_size = VALUES(byte_size),
         ai_confidence = VALUES(ai_confidence),
         created_at = NOW()`,
      [vehiclePk, slot, fileName, 1920, 1080, buffer.length, verdict.confidence ?? null]
    );

    if (oldFile && oldFile !== fileName) {
      fsp.unlink(path.join(dir, oldFile)).catch(err => {
        if (err.code !== 'ENOENT') logger.warn({ err: err.message, oldFile }, 'Old slot file unlink failed');
      });
    }

    logger.info({ userId, vehicleId, slot, confidence: verdict.confidence }, 'Tesla gallery photo accepted');
    return { slot, url: publicUrl(vehicleId, slot) + `?t=${Date.now()}` };
  });

  // DELETE /vehicles/:vehicleId/photos/:slot — owner-only
  fastify.delete('/vehicles/:vehicleId/photos/:slot', { preHandler: authHook }, async (request, reply) => {
    const { vehicleId } = request.params;
    const slot = Number(request.params.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT_INDEX) {
      return reply.code(400).send({ error: 'Invalid slot' });
    }

    const userId = request.user.userId;
    const vehiclePk = await db.getOwnedTeslaVehiclePk(vehicleId, userId);
    if (!vehiclePk) return reply.code(403).send({ error: 'Not your vehicle' });

    const [rows] = await db.pool.execute(
      `SELECT file_name FROM tesla_vehicle_photos
       WHERE tesla_vehicle_id = ? AND slot_index = ? LIMIT 1`,
      [vehiclePk, slot]
    );
    const fileName = rows[0]?.file_name;
    if (!fileName) return reply.code(204).send();

    await db.pool.execute(
      `DELETE FROM tesla_vehicle_photos WHERE tesla_vehicle_id = ? AND slot_index = ?`,
      [vehiclePk, slot]
    );

    fsp.unlink(path.join(vehicleDir(vehiclePk), fileName)).catch(err => {
      if (err.code !== 'ENOENT') logger.warn({ err: err.message }, 'Delete file unlink failed');
    });

    return reply.code(204).send();
  });
}

module.exports = teslaGalleryRoutes;
