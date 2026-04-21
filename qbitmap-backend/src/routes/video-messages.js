const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pipeline } = require('stream/promises');
const db = require('../services/database');
const wsService = require('../services/websocket');
const { authHook, optionalAuthHook } = require('../utils/jwt');
const logger = require('../utils/logger').child({ module: 'video-messages' });
const videoAiQueue = require('../services/video-ai-queue');
const photoAiQueue = require('../services/photo-ai-queue');
const { safePath } = require('../utils/validation');
const { validateMagicBytes } = require('../utils/file-validation');
const { assertCanViewMessage } = require('../utils/message-access');
const { Semaphore } = require('../utils/semaphore');
const { execFile } = require('child_process');

// Cap concurrent FFmpeg optimize processes. Photo optimize is synchronous
// (the response awaits completion so the caller never races the rename of
// filePath), so without a cap N concurrent uploads = N FFmpeg processes
// = CPU thrash + each job taking 5-10x longer. 3 keeps the CPU busy while
// leaving headroom for video ffprobe/thumbnail work.
const photoOptimizeSem = new Semaphore(3);

const UPLOADS_DIR = path.resolve(__dirname, '../../uploads/video-messages');
const ALLOWED_MIME_TYPES = ['video/mp4', 'video/webm', 'image/jpeg', 'image/png', 'image/webp'];
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const EXT_MAP = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_DURATION_MS = 30000;
const MAX_PHOTOS_PER_MESSAGE = 5;

const ORIGINALS_DIR = path.resolve(UPLOADS_DIR, 'originals');
const OPTIMIZED_MAX_DIM = 2048;
const OPTIMIZED_QUALITY_JPEG = 3;  // ffmpeg JPEG: 2=best, 31=worst
const OPTIMIZED_QUALITY_WEBP = 85; // WebP: 0=worst, 100=best

// Ensure uploads directories exist
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(ORIGINALS_DIR)) {
  fs.mkdirSync(ORIGINALS_DIR, { recursive: true });
}

async function videoMessageRoutes(fastify, options) {

  // POST / - Upload a video message OR photo message (1-5 photos)
  fastify.post('/', {
    preHandler: authHook,
    bodyLimit: MAX_FILE_SIZE * MAX_PHOTOS_PER_MESSAGE + 1024 * 64,
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '10 minutes'
      }
    }
  }, async (request, reply) => {
    const userId = request.user.userId;

    // Collected state from streaming multipart parse
    const fieldsBag = {};         // form field name -> value (string)
    const writtenFiles = [];      // tracks every file we wrote (for cleanup on failure)
    const photoFiles = [];        // [{ filePath, fileName, mimeType, fileSize }]
    let videoFile = null;         // { filePath, fileName, mimeType, fileSize, mediaType: 'video' }
    let truncated = false;
    let parseError = null;
    let mediaType = null;         // 'photo' | 'video'
    const tsBase = Date.now().toString(36);
    // messageId yields known prefix (pmsg_/vmsg_) — frontend popup also branches on this
    const messageId = `__pending__${userId}_${tsBase}`;

    // Helper: drop a partially-written stream that exceeds limits
    const cleanupWritten = async () => {
      for (const f of writtenFiles) {
        await fsp.unlink(f).catch(() => {});
      }
    };

    try {
      const parts = request.parts({
        limits: { fileSize: MAX_FILE_SIZE, files: MAX_PHOTOS_PER_MESSAGE + 1 }
      });

      for await (const part of parts) {
        if (part.type === 'field') {
          fieldsBag[part.fieldname] = part.value;
          continue;
        }

        // Part is a file
        const partMime = part.mimetype;
        if (!ALLOWED_MIME_TYPES.includes(partMime)) {
          part.file.resume();
          parseError = { code: 400, msg: `Invalid file type: ${partMime}` };
          break;
        }
        const isImage = IMAGE_MIME_TYPES.includes(partMime);

        if (isImage) {
          if (mediaType === 'video') {
            part.file.resume();
            parseError = { code: 400, msg: 'Cannot mix images and videos' };
            break;
          }
          if (photoFiles.length >= MAX_PHOTOS_PER_MESSAGE) {
            part.file.resume();
            parseError = { code: 400, msg: `Too many photos (max ${MAX_PHOTOS_PER_MESSAGE})` };
            break;
          }
          mediaType = 'photo';
          const idx = photoFiles.length;
          const ext = EXT_MAP[partMime] || 'bin';
          const fileName = `pmsg_${userId}_${tsBase}_${idx}.${ext}`;
          const filePath = path.resolve(UPLOADS_DIR, fileName);
          if (!filePath.startsWith(UPLOADS_DIR + path.sep)) {
            part.file.resume();
            parseError = { code: 400, msg: 'Invalid filename' };
            break;
          }
          const ws = fs.createWriteStream(filePath);
          writtenFiles.push(filePath);
          await pipeline(part.file, ws);
          if (part.file.truncated) {
            truncated = true;
            parseError = { code: 413, msg: 'File too large (max 20MB per photo)' };
            break;
          }
          const st = await fsp.stat(filePath);
          photoFiles.push({ filePath, fileName, mimeType: partMime, fileSize: st.size, idx, ext });
        } else {
          // Video file (single)
          if (mediaType === 'photo') {
            part.file.resume();
            parseError = { code: 400, msg: 'Cannot mix images and videos' };
            break;
          }
          if (videoFile) {
            part.file.resume();
            parseError = { code: 400, msg: 'Only one video per message' };
            break;
          }
          mediaType = 'video';
          const ext = EXT_MAP[partMime] || 'bin';
          const fileName = `vmsg_${userId}_${tsBase}.${ext}`;
          const filePath = path.resolve(UPLOADS_DIR, fileName);
          if (!filePath.startsWith(UPLOADS_DIR + path.sep)) {
            part.file.resume();
            parseError = { code: 400, msg: 'Invalid filename' };
            break;
          }
          const ws = fs.createWriteStream(filePath);
          writtenFiles.push(filePath);
          await pipeline(part.file, ws);
          if (part.file.truncated) {
            truncated = true;
            parseError = { code: 413, msg: 'File too large (max 20MB)' };
            break;
          }
          const st = await fsp.stat(filePath);
          videoFile = { filePath, fileName, mimeType: partMime, fileSize: st.size, ext };
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Multipart parse error');
      await cleanupWritten();
      return reply.code(400).send({ error: 'Invalid multipart request' });
    }

    if (parseError) {
      await cleanupWritten();
      return reply.code(parseError.code).send({ error: parseError.msg });
    }
    if (truncated) {
      await cleanupWritten();
      return reply.code(413).send({ error: 'File too large' });
    }
    if (!mediaType || (mediaType === 'photo' && photoFiles.length === 0) || (mediaType === 'video' && !videoFile)) {
      await cleanupWritten();
      return reply.code(400).send({ error: 'No file uploaded' });
    }

    const isPhoto = mediaType === 'photo';

    // Read & validate form fields
    const lng = parseFloat(fieldsBag.lng);
    const lat = parseFloat(fieldsBag.lat);
    const accuracyRadiusMRaw = fieldsBag.accuracy_radius_m ? parseInt(fieldsBag.accuracy_radius_m) : null;
    const accuracyRadiusM = Number.isFinite(accuracyRadiusMRaw) ? accuracyRadiusMRaw : null;
    const locationSource = (fieldsBag.location_source || '').slice(0, 16) || null;
    const durationMs = isPhoto ? null : parseInt(fieldsBag.duration_ms);
    const recipientEmail = fieldsBag.recipient_email || null;
    const description = (fieldsBag.description || '').trim().substring(0, 200) || null;
    const tagsRaw = (fieldsBag.tags || '').trim();
    const tagNames = tagsRaw
      ? tagsRaw.split(',').map(t => t.trim()).filter(t => t.length > 0).slice(0, 5)
      : [];
    const placeIdRaw = fieldsBag.place_id ? parseInt(fieldsBag.place_id) : null;

    // Photo metadata: array (one per photo) or single legacy object
    let photoMetadataPerIdx = [];
    if (isPhoto && fieldsBag.photo_metadata) {
      try {
        const parsed = JSON.parse(fieldsBag.photo_metadata);
        photoMetadataPerIdx = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        photoMetadataPerIdx = [];
      }
    }

    if (!Number.isFinite(lng) || !Number.isFinite(lat) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      await cleanupWritten();
      return reply.code(400).send({ error: 'Valid lng and lat are required' });
    }

    if (!isPhoto) {
      if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > MAX_DURATION_MS) {
        await cleanupWritten();
        return reply.code(400).send({ error: `Duration must be between 1000 and ${MAX_DURATION_MS} ms` });
      }
    }

    let recipientId = null;
    if (recipientEmail) {
      recipientId = await db.getActiveUserIdByEmail(recipientEmail);
      if (!recipientId) {
        await cleanupWritten();
        return reply.code(404).send({ error: 'Recipient not found' });
      }
      if (recipientId === userId) {
        await cleanupWritten();
        return reply.code(400).send({ error: 'Cannot send a message to yourself' });
      }
    }

    // Real messageId now that we know media type
    const realMessageId = `${isPhoto ? 'pmsg' : 'vmsg'}_${userId}_${tsBase}`;

    try {
      // ============ Per-file post-processing ============
      // Validate magic bytes for every uploaded file
      const filesToValidate = isPhoto ? photoFiles : [videoFile];
      for (const f of filesToValidate) {
        const headBuf = Buffer.alloc(12);
        const fh = await fsp.open(f.filePath, 'r');
        try { await fh.read(headBuf, 0, 12, 0); } finally { await fh.close(); }
        if (!validateMagicBytes(headBuf, f.mimeType)) {
          await cleanupWritten();
          return reply.code(400).send({ error: 'File content does not match declared type' });
        }
      }

      // Photo optimization: per-photo archive + ffmpeg optimize
      if (isPhoto) {
        for (const p of photoFiles) {
          const originalPath = path.resolve(ORIGINALS_DIR, p.fileName);
          try {
            await fsp.copyFile(p.filePath, originalPath);
            await photoOptimizeSem.run(() => new Promise((resolve, reject) => {
              const args = [
                '-i', originalPath,
                '-vf', `scale='min(${OPTIMIZED_MAX_DIM},iw)':'min(${OPTIMIZED_MAX_DIM},ih)':force_original_aspect_ratio=decrease`,
                '-map_metadata', '-1',
                ...(p.mimeType === 'image/jpeg' ? ['-q:v', String(OPTIMIZED_QUALITY_JPEG)] : []),
                ...(p.mimeType === 'image/png' ? ['-compression_level', '6'] : []),
                ...(p.mimeType === 'image/webp' ? ['-quality', String(OPTIMIZED_QUALITY_WEBP)] : []),
                '-y', p.filePath
              ];
              execFile('/usr/bin/ffmpeg', args, { timeout: 15000 }, (err) => err ? reject(err) : resolve());
            }));
            const optStats = await fsp.stat(p.filePath);
            p.fileSize = optStats.size;
          } catch (optErr) {
            logger.warn({ err: optErr.message, messageId: realMessageId, idx: p.idx }, 'Photo optimization failed, serving original');
          }
        }
      }

      // Server-side video duration validation
      if (!isPhoto) {
        const actualDurationMs = await new Promise((resolve) => {
          execFile('/usr/bin/ffprobe', [
            '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'csv=p=0', videoFile.filePath
          ], { timeout: 10000 }, (err, stdout) => {
            if (err) return resolve(null);
            const secs = parseFloat(stdout.trim());
            resolve(Number.isFinite(secs) ? Math.round(secs * 1000) : null);
          });
        });
        if (actualDurationMs !== null && actualDurationMs > MAX_DURATION_MS + 1000) {
          await cleanupWritten();
          return reply.code(400).send({ error: `Video too long: ${Math.round(actualDurationMs / 1000)}s (max ${MAX_DURATION_MS / 1000}s)` });
        }
      }

      // Thumbnails (fire-and-forget) — per photo or single video
      const { generateThumbnail, generatePhotoThumbnail, PREVIEW_WIDTH, PREVIEW_QUALITY } = require('../utils/thumbnail');

      if (isPhoto) {
        // Defer thumbnail generation until after DB INSERT so we can use the
        // child row's video_message_id for per-idx persistence.
      } else {
        const thumbFileName = `${realMessageId}_thumb.webp`;
        const previewFileName = `${realMessageId}_preview.webp`;
        const thumbFilePath = path.resolve(UPLOADS_DIR, thumbFileName);
        const previewFilePath = path.resolve(UPLOADS_DIR, previewFileName);
        const thumbRelPath = `uploads/video-messages/${thumbFileName}`;
        const vidDurationMs = durationMs || null;
        Promise.all([
          generateThumbnail(videoFile.filePath, thumbFilePath, { durationMs: vidDurationMs }),
          generateThumbnail(videoFile.filePath, previewFilePath, { width: PREVIEW_WIDTH, quality: PREVIEW_QUALITY, durationMs: vidDurationMs })
        ]).then(async ([thumbOk]) => {
          if (thumbOk) {
            try { await db.updateVideoMessageThumbnail(realMessageId, thumbRelPath); } catch (e) { logger.warn({ err: e.message, messageId: realMessageId }, 'Failed to save thumbnail path to DB'); }
          }
        }).catch(() => {});
      }

      // Validate place_id
      let validatedPlaceId = null;
      if (placeIdRaw && Number.isFinite(placeIdRaw)) {
        const place = await db.getPlaceById(placeIdRaw);
        if (place) validatedPlaceId = place.id;
      }

      // Save parent video_messages row — kapak (idx=0) field'ları parent'a yansır
      const primaryFile = isPhoto ? photoFiles[0] : videoFile;
      const primaryMeta = isPhoto && photoMetadataPerIdx[0] ? JSON.stringify(photoMetadataPerIdx[0]) : null;
      const message = await db.createVideoMessage(userId, {
        messageId: realMessageId,
        recipientId,
        lng,
        lat,
        accuracyRadiusM,
        locationSource,
        filePath: `uploads/video-messages/${primaryFile.fileName}`,
        fileSize: primaryFile.fileSize,
        durationMs,
        mimeType: primaryFile.mimeType,
        description,
        mediaType: isPhoto ? 'photo' : 'video',
        photoMetadata: primaryMeta,
        placeId: validatedPlaceId
      });

      // Persist child photo rows + per-photo thumbnails
      if (isPhoto) {
        const childThumbsRel = []; // for response/WS payload
        for (const p of photoFiles) {
          const meta = photoMetadataPerIdx[p.idx] ? JSON.stringify(photoMetadataPerIdx[p.idx]) : null;
          await db.addVideoMessagePhoto(message.id, {
            idx: p.idx,
            filePath: `uploads/video-messages/${p.fileName}`,
            thumbnailPath: null,
            photoMetadata: meta,
            fileSize: p.fileSize,
            mimeType: p.mimeType,
            isPrimary: p.idx === 0
          });

          // Generate thumb+preview per photo (fire-and-forget)
          const baseName = p.fileName.replace(/\.[^.]+$/, '');
          const thumbFileName = `${baseName}_thumb.webp`;
          const previewFileName = `${baseName}_preview.webp`;
          const thumbFilePath = path.resolve(UPLOADS_DIR, thumbFileName);
          const previewFilePath = path.resolve(UPLOADS_DIR, previewFileName);
          const thumbRelPath = `uploads/video-messages/${thumbFileName}`;
          childThumbsRel.push({ idx: p.idx, thumbRel: thumbRelPath });

          Promise.all([
            generatePhotoThumbnail(p.filePath, thumbFilePath),
            generatePhotoThumbnail(p.filePath, previewFilePath, { width: PREVIEW_WIDTH, quality: PREVIEW_QUALITY })
          ]).then(async ([thumbOk]) => {
            if (thumbOk) {
              try {
                await db.updateVideoMessagePhotoThumbnail(message.id, p.idx, thumbRelPath);
                if (p.idx === 0) {
                  // Mirror primary to parent for BC with old single-photo paths
                  await db.updateVideoMessageThumbnail(realMessageId, thumbRelPath);
                }
              } catch (e) {
                logger.warn({ err: e.message, messageId: realMessageId, idx: p.idx }, 'Failed to save photo thumbnail path');
              }
            }
          }).catch(() => {});
        }
        // Attach (still-pending) thumb URLs for client optimism
        message.photos = photoFiles.map((p) => ({
          idx: p.idx,
          file_path: `uploads/video-messages/${p.fileName}`,
          thumbnail_path: childThumbsRel.find(c => c.idx === p.idx)?.thumbRel || null,
          photo_metadata: photoMetadataPerIdx[p.idx] || null,
          file_size: p.fileSize,
          mime_type: p.mimeType,
          is_primary: p.idx === 0 ? 1 : 0
        }));
      }

      // AI queue — every photo gets its own analysis job
      if (isPhoto) {
        for (const p of photoFiles) {
          photoAiQueue.enqueue(realMessageId, p.fileName, p.idx);
        }
      } else {
        videoAiQueue.enqueue(realMessageId, videoFile.fileName);
      }

      // Tags
      if (tagNames.length > 0) {
        await db.setVideoMessageTags(message.id, tagNames);
        message.tags = tagNames;
      }

      const wsPayload = {
        type: 'video_message_new',
        payload: {
          messageId: message.message_id,
          senderId: message.sender_id,
          senderName: message.sender_name,
          senderAvatar: message.sender_avatar,
          recipientId: message.recipient_id,
          lng: message.lng,
          lat: message.lat,
          durationMs: message.duration_ms,
          mimeType: message.mime_type,
          mediaType: message.media_type || 'video',
          description: message.description || null,
          aiDescription: message.ai_description || null,
          tags: message.tags || [],
          thumbnailPath: message.thumbnail_path || null,
          photos: message.photos || [],
          createdAt: message.created_at,
          placeName: message.place_name || null
        }
      };

      if (recipientId) {
        wsService.sendToUser(recipientId, wsPayload);
        const unreadCount = await db.getUnreadVideoMessageCount(recipientId);
        wsService.sendToUser(recipientId, {
          type: 'video_message_unread_count',
          payload: { count: unreadCount }
        });

        // [PWA] Web Push — fires in parallel with the WS broadcast so
        // recipients whose PWA tab is closed still see the message in
        // their notification tray (with the thumbnail as the big image).
        try {
          const pushService = require('../services/push');
          const senderLabel = message.sender_name || 'Biri';
          const kind = (message.media_type === 'photo') ? 'fotoğraf' : 'video';
          const thumbUrl = `https://stream.qbitmap.com/api/video-messages/${encodeURIComponent(message.message_id)}/thumbnail?size=preview`;
          await pushService.sendToUser(recipientId, {
            title: `${senderLabel} sana bir ${kind} mesajı gönderdi`,
            body: message.place_name || message.description || '',
            tag: `vmsg-${message.message_id}`,
            topic: `vmsg-${message.message_id}`,
            urgency: 'normal',
            image: thumbUrl,
            icon: thumbUrl,
            navigate: `/?vmsg=${encodeURIComponent(message.message_id)}`,
          });
        } catch (err) {
          logger.warn({ err: err.message, messageId: realMessageId }, 'video-message push dispatch failed (non-fatal)');
        }
      } else {
        wsService.broadcast(wsPayload);
      }

      logger.info({
        messageId: realMessageId, userId, recipientId,
        photoCount: isPhoto ? photoFiles.length : 0,
        durationMs, mediaType
      }, 'Message uploaded');
      return reply.code(201).send({ status: 'ok', message });

    } catch (error) {
      await cleanupWritten();
      logger.error({ err: error, messageId: realMessageId }, 'Video message upload failed');
      return reply.code(500).send({ error: 'Upload failed' });
    }
  });

  // GET / - List video messages (for map markers)
  // Supports cursor-based pagination: ?cursor=2026-04-10T12:00:00.000Z
  fastify.get('/', { preHandler: optionalAuthHook }, async (request, reply) => {
    try {
      const userId = request.user?.userId || null;
      const { bounds: boundsStr, limit, offset, cursor } = request.query;

      let bounds = null;
      if (boundsStr) {
        const parts = boundsStr.split(',').map(Number);
        if (parts.length === 4 && parts.every(Number.isFinite)) {
          bounds = { swLng: parts[0], swLat: parts[1], neLng: parts[2], neLat: parts[3] };
        }
      }

      const messages = await db.getVideoMessages(userId, { bounds, limit, offset, cursor: cursor || null });
      // Include nextCursor for cursor-based pagination
      const nextCursor = messages.length > 0 ? messages[messages.length - 1].created_at : null;
      return { messages, nextCursor };
    } catch (error) {
      logger.error({ err: error }, 'Failed to list video messages');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /my-recent - Get user's recent messages (for profile)
  fastify.get('/my-recent', { preHandler: authHook }, async (request, reply) => {
    try {
      const limit = Math.min(Math.max(parseInt(request.query.limit) || 5, 1), 20);
      const messages = await db.getUserRecentMessages(request.user.userId, limit);
      return { messages };
    } catch (error) {
      logger.error({ err: error }, 'Failed to get recent messages');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /unread-count - Get unread private message count
  fastify.get('/unread-count', { preHandler: authHook }, async (request, reply) => {
    try {
      const count = await db.getUnreadVideoMessageCount(request.user.userId);
      return { count };
    } catch (error) {
      logger.error({ err: error }, 'Failed to get unread count');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /users/search - Search users for recipient selection
  fastify.get('/users/search', { preHandler: authHook }, async (request, reply) => {
    try {
      const query = (request.query.q || '').trim();
      if (query.length < 2) {
        return { users: [] };
      }
      const users = await db.searchUsersByName(query);
      // Exclude current user from results
      const filtered = users.filter(u => u.id !== request.user.userId);
      return { users: filtered };
    } catch (error) {
      logger.error({ err: error }, 'User search failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /search - Search video messages by tag, title, and AI description
  fastify.get('/search', { preHandler: optionalAuthHook }, async (request, reply) => {
    try {
      const query = (request.query.q || '').trim();
      if (query.length < 2) {
        return { messages: [] };
      }
      const userId = request.user?.userId || null;
      const messages = await db.searchVideoMessages(query, userId, request.query.limit, request.query.offset);
      return { messages };
    } catch (error) {
      logger.error({ err: error }, 'Search failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /nearby-places - Get nearby places for a location (Google Places API)
  fastify.get('/nearby-places', { preHandler: authHook }, async (request, reply) => {
    try {
      const lat = parseFloat(request.query.lat);
      const lng = parseFloat(request.query.lng);

      if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
          lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return reply.code(400).send({ error: 'Valid lat and lng are required' });
      }

      const { getNearbyPlaces } = require('../services/google-places');
      const places = await getNearbyPlaces(lat, lng);
      return { places };
    } catch (error) {
      logger.error({ err: error }, 'Nearby places lookup failed');
      return reply.code(500).send({ error: 'Failed to fetch nearby places' });
    }
  });

  // GET /:messageId/thumbnail - Serve thumbnail image
  // ?size=preview returns 800px preview, default returns 320px thumb
  fastify.get('/:messageId/thumbnail', { preHandler: optionalAuthHook }, async (request, reply) => {
    try {
      const { messageId } = request.params;
      const wantPreview = request.query.size === 'preview';
      const msg = await db.getVideoMessageById(messageId);

      if (!msg || !msg.thumbnail_path) {
        return reply.code(404).send({ error: 'Thumbnail not found' });
      }

      const denied = assertCanViewMessage(msg, request.user);
      if (denied) return reply.code(denied.code).send(denied.body);

      let thumbPath = safePath(msg.thumbnail_path, 'uploads');
      // Try preview version if requested
      if (wantPreview && thumbPath) {
        const previewPath = thumbPath.replace('_thumb.webp', '_preview.webp');
        try { await fsp.access(previewPath); thumbPath = previewPath; } catch {
          // Falls back to regular thumb if preview doesn't exist
        }
      }

      if (!thumbPath) {
        return reply.code(404).send({ error: 'Thumbnail file not found' });
      }
      try { await fsp.access(thumbPath); } catch {
        return reply.code(404).send({ error: 'Thumbnail file not found' });
      }

      const contentType = thumbPath.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      reply.header('Content-Type', contentType);
      reply.header('Cache-Control', 'public, max-age=604800');
      return reply.send(fs.createReadStream(thumbPath));
    } catch (error) {
      logger.error({ err: error }, 'Thumbnail serve failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /:messageId - Get single message details (for deep links / share)
  fastify.get('/:messageId', { preHandler: optionalAuthHook }, async (request, reply) => {
    try {
      const { messageId } = request.params;
      const msg = await db.getVideoMessageById(messageId);

      if (!msg) {
        return reply.code(404).send({ error: 'Message not found' });
      }

      const denied = assertCanViewMessage(msg, request.user);
      if (denied) return reply.code(denied.code).send(denied.body);

      return { message: msg };
    } catch (error) {
      logger.error({ err: error }, 'Failed to get video message');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /:messageId/description?lang=XX - Translated AI description (cached)
  fastify.get('/:messageId/description', {
    preHandler: optionalAuthHook,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const ALLOWED_LANGS = ['en', 'de', 'fr', 'tr', 'es', 'zh', 'ru', 'ar'];
    try {
      const { messageId } = request.params;
      const lang = String(request.query.lang || '').toLowerCase();
      if (!ALLOWED_LANGS.includes(lang)) {
        return reply.code(400).send({ error: 'Unsupported lang' });
      }

      const msg = await db.getVideoMessageById(messageId);
      if (!msg) return reply.code(404).send({ error: 'Message not found' });

      const denied = assertCanViewMessage(msg, request.user);
      if (denied) return reply.code(denied.code).send(denied.body);

      if (!msg.ai_description) {
        return reply.code(404).send({ error: 'No AI description yet' });
      }

      const sourceLang = msg.ai_description_lang || 'tr';
      if (sourceLang === lang) {
        return { lang, text: msg.ai_description, cached: true };
      }

      const cached = await db.getVideoMessageTranslation(messageId, 0, lang);
      if (cached) return { lang, text: cached, cached: true };

      const { translateText } = require('../services/ai-translate');
      try {
        const translated = await translateText(msg.ai_description, sourceLang, lang);
        await db.saveVideoMessageTranslation(messageId, 0, lang, translated);
        return { lang, text: translated, cached: false };
      } catch (err) {
        logger.warn({ err: err.message, messageId, lang }, 'Translation failed');
        return reply.code(503).send({ error: 'Translation unavailable' });
      }
    } catch (error) {
      logger.error({ err: error }, 'Description endpoint failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /:messageId/photos/:idx/description?lang=XX - Per-photo translated AI description
  fastify.get('/:messageId/photos/:idx/description', {
    preHandler: optionalAuthHook,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const ALLOWED_LANGS = ['en', 'de', 'fr', 'tr', 'es', 'zh', 'ru', 'ar'];
    try {
      const { messageId } = request.params;
      const idx = parseInt(request.params.idx, 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= MAX_PHOTOS_PER_MESSAGE) {
        return reply.code(400).send({ error: 'Invalid photo index' });
      }
      const lang = String(request.query.lang || '').toLowerCase();
      if (!ALLOWED_LANGS.includes(lang)) {
        return reply.code(400).send({ error: 'Unsupported lang' });
      }

      const msg = await db.getVideoMessageById(messageId);
      if (!msg || msg.media_type !== 'photo') return reply.code(404).send({ error: 'Message not found' });

      const denied = assertCanViewMessage(msg, request.user);
      if (denied) return reply.code(denied.code).send(denied.body);

      const photo = (msg.photos || []).find(p => p.idx === idx);
      if (!photo || !photo.ai_description) {
        return reply.code(404).send({ error: 'No AI description yet' });
      }

      const sourceLang = photo.ai_description_lang || 'tr';
      if (sourceLang === lang) {
        return { lang, text: photo.ai_description, cached: true };
      }

      const cached = await db.getVideoMessageTranslation(messageId, idx, lang);
      if (cached) return { lang, text: cached, cached: true };

      const { translateText } = require('../services/ai-translate');
      try {
        const translated = await translateText(photo.ai_description, sourceLang, lang);
        await db.saveVideoMessageTranslation(messageId, idx, lang, translated);
        return { lang, text: translated, cached: false };
      } catch (err) {
        logger.warn({ err: err.message, messageId, idx, lang }, 'Translation failed');
        return reply.code(503).send({ error: 'Translation unavailable' });
      }
    } catch (error) {
      logger.error({ err: error }, 'Photo description endpoint failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /:messageId/video - Serve video file with Range support
  fastify.get('/:messageId/video', { preHandler: optionalAuthHook }, async (request, reply) => {
    try {
      const { messageId } = request.params;
      const msg = await db.getVideoMessageById(messageId);

      if (!msg) {
        return reply.code(404).send({ error: 'Message not found' });
      }

      const denied = assertCanViewMessage(msg, request.user);
      if (denied) return reply.code(denied.code).send(denied.body);

      const filePath = safePath(msg.file_path, 'uploads');
      if (!filePath) {
        return reply.code(404).send({ error: 'Video file not found' });
      }
      let stat;
      try { stat = await fsp.stat(filePath); } catch {
        return reply.code(404).send({ error: 'Video file not found' });
      }
      const fileSize = stat.size;

      // Handle Range request for mobile video seeking
      const range = request.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = Math.max(0, parseInt(parts[0], 10) || 0);
        const end = Math.min(parts[1] ? parseInt(parts[1], 10) : fileSize - 1, fileSize - 1);

        if (start >= fileSize || start > end) {
          reply.header('Content-Range', `bytes */${fileSize}`);
          return reply.code(416).send({ error: 'Range not satisfiable' });
        }

        const chunkSize = end - start + 1;

        reply.code(206);
        reply.header('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        reply.header('Accept-Ranges', 'bytes');
        reply.header('Content-Length', chunkSize);
        reply.header('Content-Type', msg.mime_type);
        reply.header('Cache-Control', 'public, max-age=86400');
        return reply.send(fs.createReadStream(filePath, { start, end }));
      }

      // Full file response
      reply.header('Content-Length', fileSize);
      reply.header('Content-Type', msg.mime_type);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(fs.createReadStream(filePath));

    } catch (error) {
      logger.error({ err: error }, 'Video serve failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /:messageId/photos/:idx - Serve a specific photo from a multi-photo message
  fastify.get('/:messageId/photos/:idx', { preHandler: optionalAuthHook }, async (request, reply) => {
    try {
      const { messageId } = request.params;
      const idx = parseInt(request.params.idx, 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= MAX_PHOTOS_PER_MESSAGE) {
        return reply.code(400).send({ error: 'Invalid photo index' });
      }
      const msg = await db.getVideoMessageById(messageId);
      if (!msg || msg.media_type !== 'photo') return reply.code(404).send({ error: 'Photo not found' });

      const denied = assertCanViewMessage(msg, request.user);
      if (denied) return reply.code(denied.code).send(denied.body);

      const photo = (msg.photos || []).find(p => p.idx === idx);
      if (!photo) return reply.code(404).send({ error: 'Photo not found' });

      const filePath = safePath(photo.file_path, 'uploads');
      if (!filePath) return reply.code(404).send({ error: 'Photo file not found' });
      try { await fsp.access(filePath); } catch {
        return reply.code(404).send({ error: 'Photo file not found' });
      }

      const stat = await fsp.stat(filePath);
      reply.header('Content-Length', stat.size);
      reply.header('Content-Type', photo.mime_type);
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(fs.createReadStream(filePath));
    } catch (error) {
      logger.error({ err: error }, 'Photo serve failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /:messageId/photos/:idx/original - Serve uncompressed original of a specific photo
  fastify.get('/:messageId/photos/:idx/original', { preHandler: optionalAuthHook }, async (request, reply) => {
    try {
      const { messageId } = request.params;
      const idx = parseInt(request.params.idx, 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= MAX_PHOTOS_PER_MESSAGE) {
        return reply.code(400).send({ error: 'Invalid photo index' });
      }
      const msg = await db.getVideoMessageById(messageId);
      if (!msg || msg.media_type !== 'photo') return reply.code(404).send({ error: 'Photo not found' });

      const denied = assertCanViewMessage(msg, request.user);
      if (denied) return reply.code(denied.code).send(denied.body);

      const photo = (msg.photos || []).find(p => p.idx === idx);
      if (!photo) return reply.code(404).send({ error: 'Photo not found' });

      const baseName = path.basename(photo.file_path);
      const originalPath = path.resolve(ORIGINALS_DIR, baseName);
      let filePath;
      try {
        await fsp.stat(originalPath);
        filePath = originalPath;
      } catch {
        filePath = safePath(photo.file_path, 'uploads');
      }
      if (!filePath) return reply.code(404).send({ error: 'File not found' });

      const stat = await fsp.stat(filePath);
      reply.header('Content-Length', stat.size);
      reply.header('Content-Type', photo.mime_type);
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(fs.createReadStream(filePath));
    } catch (error) {
      logger.error({ err: error }, 'Photo original serve failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // GET /:messageId/original - Serve original (uncompressed) photo
  fastify.get('/:messageId/original', { preHandler: optionalAuthHook }, async (request, reply) => {
    try {
      const { messageId } = request.params;
      const msg = await db.getVideoMessageById(messageId);

      if (!msg || msg.media_type !== 'photo') {
        return reply.code(404).send({ error: 'Photo not found' });
      }

      const denied = assertCanViewMessage(msg, request.user);
      if (denied) return reply.code(denied.code).send(denied.body);

      // Try original first, fall back to optimized
      const baseName = path.basename(msg.file_path);
      const originalPath = path.resolve(ORIGINALS_DIR, baseName);
      let filePath;
      try {
        await fsp.stat(originalPath);
        filePath = originalPath;
      } catch {
        filePath = safePath(msg.file_path, 'uploads');
      }

      if (!filePath) {
        return reply.code(404).send({ error: 'File not found' });
      }

      const stat = await fsp.stat(filePath);
      reply.header('Content-Length', stat.size);
      reply.header('Content-Type', msg.mime_type);
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(fs.createReadStream(filePath));
    } catch (error) {
      logger.error({ err: error }, 'Original photo serve failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // POST /:messageId/read - Mark private message as read
  fastify.post('/:messageId/read', { preHandler: authHook }, async (request, reply) => {
    try {
      const { messageId } = request.params;
      const userId = request.user.userId;

      const success = await db.markVideoMessageRead(messageId, userId);
      if (!success) {
        return reply.code(404).send({ error: 'Message not found or not addressed to you' });
      }

      // Send updated unread count via WebSocket
      const count = await db.getUnreadVideoMessageCount(userId);
      wsService.sendToUser(userId, {
        type: 'video_message_unread_count',
        payload: { count }
      });

      return { status: 'ok' };
    } catch (error) {
      logger.error({ err: error }, 'Mark read failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // PUT /:messageId/tags - Update tags on own message
  fastify.put('/:messageId/tags', { preHandler: authHook }, async (request, reply) => {
    try {
      const { messageId } = request.params;
      const userId = request.user.userId;

      const msg = await db.getVideoMessageById(messageId);
      if (!msg || msg.sender_id !== userId) {
        return reply.code(404).send({ error: 'Message not found or not yours' });
      }

      const tagNames = (request.body.tags || [])
        .map(t => String(t).trim())
        .filter(t => t.length > 0)
        .slice(0, 5);

      await db.replaceVideoMessageTags(msg.id, tagNames);

      // Broadcast tag update via WebSocket
      const wsPayload = {
        type: 'video_message_tags_updated',
        payload: { messageId, tags: tagNames }
      };
      if (msg.recipient_id) {
        wsService.sendToUser(msg.sender_id, wsPayload);
        wsService.sendToUser(msg.recipient_id, wsPayload);
      } else {
        wsService.broadcast(wsPayload);
      }

      logger.info({ messageId, userId, tags: tagNames }, 'Video message tags updated');
      return { status: 'ok', tags: tagNames };
    } catch (error) {
      logger.error({ err: error }, 'Tag update failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // DELETE /:messageId - Delete own message
  fastify.delete('/:messageId', { preHandler: authHook }, async (request, reply) => {
    try {
      const { messageId } = request.params;
      const userId = request.user.userId;

      const deleted = await db.deleteVideoMessage(messageId, userId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Message not found or not yours' });
      }

      // Delete files from disk (fire-and-forget, path traversal safe)
      // For multi-photo messages: iterate child rows; for video/legacy single-photo: parent paths
      const filesToUnlink = [];
      if (deleted.media_type === 'photo' && Array.isArray(deleted.photos) && deleted.photos.length > 0) {
        for (const p of deleted.photos) {
          const fp = safePath(p.file_path, 'uploads');
          if (fp) {
            filesToUnlink.push(fp);
            filesToUnlink.push(path.resolve(ORIGINALS_DIR, path.basename(fp)));
          }
          if (p.thumbnail_path) {
            const tp = safePath(p.thumbnail_path, 'uploads');
            if (tp) {
              filesToUnlink.push(tp);
              filesToUnlink.push(tp.replace('_thumb.webp', '_preview.webp'));
            }
          }
        }
      } else {
        const filePath = safePath(deleted.file_path, 'uploads');
        if (filePath) {
          filesToUnlink.push(filePath);
          filesToUnlink.push(path.resolve(ORIGINALS_DIR, path.basename(filePath)));
        }
        if (deleted.thumbnail_path) {
          const thumbPath = safePath(deleted.thumbnail_path, 'uploads');
          if (thumbPath) {
            filesToUnlink.push(thumbPath);
            filesToUnlink.push(thumbPath.replace('_thumb.webp', '_preview.webp'));
          }
        }
      }
      for (const f of filesToUnlink) fsp.unlink(f).catch(() => {});

      // Notify via WebSocket
      const wsPayload = {
        type: 'video_message_deleted',
        payload: { messageId }
      };

      if (deleted.recipient_id) {
        wsService.sendToUser(deleted.recipient_id, wsPayload);
        // Update unread count for recipient
        const count = await db.getUnreadVideoMessageCount(deleted.recipient_id);
        wsService.sendToUser(deleted.recipient_id, {
          type: 'video_message_unread_count',
          payload: { count }
        });
      } else {
        wsService.broadcast(wsPayload);
      }

      logger.info({ messageId, userId }, 'Video message deleted');
      return { status: 'ok' };

    } catch (error) {
      logger.error({ err: error }, 'Delete failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}

module.exports = videoMessageRoutes;
