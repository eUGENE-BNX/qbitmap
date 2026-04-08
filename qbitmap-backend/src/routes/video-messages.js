const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const db = require('../services/database');
const wsService = require('../services/websocket');
const { authHook, optionalAuthHook } = require('../utils/jwt');
const logger = require('../utils/logger').child({ module: 'video-messages' });
const videoAiQueue = require('../services/video-ai-queue');
const photoAiQueue = require('../services/photo-ai-queue');
const { safePath } = require('../utils/validation');
const { validateMagicBytes } = require('../utils/file-validation');

const UPLOADS_DIR = path.join(__dirname, '../../uploads/video-messages');
const ALLOWED_MIME_TYPES = ['video/mp4', 'video/webm', 'image/jpeg', 'image/png', 'image/webp'];
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const EXT_MAP = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_DURATION_MS = 30000;

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

async function videoMessageRoutes(fastify, options) {

  // POST / - Upload a video message
  fastify.post('/', {
    preHandler: authHook,
    bodyLimit: MAX_FILE_SIZE + 1024 * 10, // file + form fields overhead
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '10 minutes'
      }
    }
  }, async (request, reply) => {
    const userId = request.user.userId;

    let data;
    try {
      data = await request.file({ limits: { fileSize: MAX_FILE_SIZE } });
    } catch (err) {
      logger.warn({ err }, 'Multipart parse error');
      return reply.code(400).send({ error: 'Invalid multipart request' });
    }

    if (!data) {
      return reply.code(400).send({ error: 'No file uploaded' });
    }

    // Validate MIME type
    const mimeType = data.mimetype;
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      // Consume and discard the file stream to prevent hanging
      data.file.resume();
      return reply.code(400).send({ error: `Invalid file type: ${mimeType}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}` });
    }

    // Determine if this is a photo upload
    const isPhoto = IMAGE_MIME_TYPES.includes(mimeType);

    // Read form fields from multipart
    const fields = data.fields;
    const lng = parseFloat(fields.lng?.value);
    const lat = parseFloat(fields.lat?.value);
    const durationMs = isPhoto ? null : parseInt(fields.duration_ms?.value);
    const recipientEmail = fields.recipient_email?.value || null;
    const description = (fields.description?.value || '').trim().substring(0, 200) || null;
    const photoMetadata = isPhoto && fields.photo_metadata?.value ? fields.photo_metadata.value : null;
    const tagsRaw = (fields.tags?.value || '').trim();
    const tagNames = tagsRaw
      ? tagsRaw.split(',').map(t => t.trim()).filter(t => t.length > 0).slice(0, 5)
      : [];
    const placeIdRaw = fields.place_id?.value ? parseInt(fields.place_id.value) : null;

    // Validate coordinates
    if (!Number.isFinite(lng) || !Number.isFinite(lat) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      data.file.resume();
      return reply.code(400).send({ error: 'Valid lng and lat are required' });
    }

    // Validate duration (video only)
    if (!isPhoto) {
      if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > MAX_DURATION_MS) {
        data.file.resume();
        return reply.code(400).send({ error: `Duration must be between 1000 and ${MAX_DURATION_MS} ms` });
      }
    }

    // Resolve recipient if private message
    let recipientId = null;
    if (recipientEmail) {
      const [recipients] = await db.pool.execute(
        'SELECT id FROM users WHERE email = ? AND is_active = 1',
        [recipientEmail]
      );
      if (recipients.length === 0) {
        data.file.resume();
        return reply.code(404).send({ error: 'Recipient not found' });
      }
      recipientId = recipients[0].id;
      if (recipientId === userId) {
        data.file.resume();
        return reply.code(400).send({ error: 'Cannot send a message to yourself' });
      }
    }

    // Generate message ID and file path
    const messageId = `${isPhoto ? 'pmsg' : 'vmsg'}_${userId}_${Date.now().toString(36)}`;
    const ext = EXT_MAP[mimeType] || 'bin';
    const fileName = `${messageId}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    try {
      // Save file to disk
      const writeStream = fs.createWriteStream(filePath);
      await pipeline(data.file, writeStream);

      // Check if file was truncated (exceeded size limit)
      if (data.file.truncated) {
        await fs.promises.unlink(filePath);
        return reply.code(413).send({ error: 'File too large (max 20MB)' });
      }

      const stats = await fs.promises.stat(filePath);
      const fileSize = stats.size;

      // Validate actual file content matches declared MIME type
      const headBuf = Buffer.alloc(12);
      const fh = await fs.promises.open(filePath, 'r');
      try { await fh.read(headBuf, 0, 12, 0); } finally { await fh.close(); }
      if (!validateMagicBytes(headBuf, mimeType)) {
        await fs.promises.unlink(filePath);
        return reply.code(400).send({ error: 'File content does not match declared type' });
      }

      // Generate thumbnail (fire-and-forget, don't block upload response)
      const thumbFileName = `${messageId}_thumb.webp`;
      const thumbFilePath = path.join(UPLOADS_DIR, thumbFileName);
      const thumbRelPath = `uploads/video-messages/${thumbFileName}`;
      if (isPhoto) {
        const { generatePhotoThumbnail } = require('../utils/thumbnail');
        generatePhotoThumbnail(filePath, thumbFilePath).then(async (ok) => {
          if (ok) {
            try { await db.updateVideoMessageThumbnail(messageId, thumbRelPath); } catch {}
          }
        }).catch(() => {});
      } else {
        const { generateThumbnail } = require('../utils/thumbnail');
        generateThumbnail(filePath, thumbFilePath).then(async (ok) => {
          if (ok) {
            try { await db.updateVideoMessageThumbnail(messageId, thumbRelPath); } catch {}
          }
        }).catch(() => {});
      }

      // Validate place_id if provided
      let validatedPlaceId = null;
      if (placeIdRaw && Number.isFinite(placeIdRaw)) {
        const place = await db.getPlaceById(placeIdRaw);
        if (place) validatedPlaceId = place.id;
      }

      // Save to database
      const message = await db.createVideoMessage(userId, {
        messageId,
        recipientId,
        lng,
        lat,
        filePath: `uploads/video-messages/${fileName}`,
        fileSize,
        durationMs,
        mimeType,
        description,
        mediaType: isPhoto ? 'photo' : 'video',
        photoMetadata,
        placeId: validatedPlaceId
      });

      // Enqueue for AI content analysis (fire-and-forget)
      if (isPhoto) {
        photoAiQueue.enqueue(messageId, fileName);
      } else {
        videoAiQueue.enqueue(messageId, fileName);
      }

      // Save tags
      if (tagNames.length > 0) {
        await db.setVideoMessageTags(message.id, tagNames);
        message.tags = tagNames;
      }

      // Send WebSocket notifications
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
          createdAt: message.created_at,
          placeName: message.place_name || null
        }
      };

      if (recipientId) {
        // Private message: notify recipient only
        wsService.sendToUser(recipientId, wsPayload);
        // Also send updated unread count
        const unreadCount = await db.getUnreadVideoMessageCount(recipientId);
        wsService.sendToUser(recipientId, {
          type: 'video_message_unread_count',
          payload: { count: unreadCount }
        });
      } else {
        // Public message: broadcast to all
        wsService.broadcast(wsPayload);
      }

      logger.info({ messageId, userId, recipientId, fileSize, durationMs, mediaType: isPhoto ? 'photo' : 'video' }, 'Message uploaded');
      return reply.code(201).send({ status: 'ok', message });

    } catch (error) {
      // Cleanup file on error
      try { fs.unlinkSync(filePath); } catch {}
      logger.error({ err: error, messageId }, 'Video message upload failed');
      return reply.code(500).send({ error: 'Upload failed' });
    }
  });

  // GET / - List video messages (for map markers)
  fastify.get('/', { preHandler: optionalAuthHook }, async (request, reply) => {
    try {
      const userId = request.user?.userId || null;
      const { bounds: boundsStr, limit, offset } = request.query;

      let bounds = null;
      if (boundsStr) {
        const parts = boundsStr.split(',').map(Number);
        if (parts.length === 4 && parts.every(Number.isFinite)) {
          bounds = { swLng: parts[0], swLat: parts[1], neLng: parts[2], neLat: parts[3] };
        }
      }

      const messages = await db.getVideoMessages(userId, { bounds, limit, offset });
      return { messages };
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
  fastify.get('/:messageId/thumbnail', { preHandler: optionalAuthHook }, async (request, reply) => {
    try {
      const { messageId } = request.params;
      const msg = await db.getVideoMessageById(messageId);

      if (!msg || !msg.thumbnail_path) {
        return reply.code(404).send({ error: 'Thumbnail not found' });
      }

      // Access control for private messages
      if (msg.recipient_id !== null) {
        const userId = request.user?.userId;
        if (!userId || (msg.sender_id !== userId && msg.recipient_id !== userId)) {
          return reply.code(403).send({ error: 'Access denied' });
        }
      }

      const thumbPath = safePath(msg.thumbnail_path, 'uploads');
      if (!thumbPath || !fs.existsSync(thumbPath)) {
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

      // Access control for private messages
      if (msg.recipient_id !== null) {
        const userId = request.user?.userId;
        if (!userId || (msg.sender_id !== userId && msg.recipient_id !== userId)) {
          return reply.code(403).send({ error: 'Access denied' });
        }
      }

      return { message: msg };
    } catch (error) {
      logger.error({ err: error }, 'Failed to get video message');
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

      // Access control for private messages
      if (msg.recipient_id !== null) {
        const userId = request.user?.userId;
        if (!userId || (msg.sender_id !== userId && msg.recipient_id !== userId)) {
          return reply.code(403).send({ error: 'Access denied' });
        }
      }

      const filePath = safePath(msg.file_path, 'uploads');
      if (!filePath || !fs.existsSync(filePath)) {
        return reply.code(404).send({ error: 'Video file not found' });
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;

      // Handle Range request for mobile video seeking
      const range = request.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
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

      // Delete file from disk (path traversal safe)
      const filePath = safePath(deleted.file_path, 'uploads');
      if (filePath) { try { fs.unlinkSync(filePath); } catch {} }
      // Delete thumbnail if exists
      if (deleted.thumbnail_path) {
        const thumbPath = safePath(deleted.thumbnail_path, 'uploads');
        if (thumbPath) { try { fs.unlinkSync(thumbPath); } catch {} }
      }

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
