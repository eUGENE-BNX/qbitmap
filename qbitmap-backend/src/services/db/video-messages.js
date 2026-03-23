const { notifyH3ContentItem, notifyH3ContentItemRemove } = require('../../utils/h3-sync');

module.exports = function(DatabaseService) {

DatabaseService.prototype.createVideoMessage = async function(senderId, { messageId, recipientId, lng, lat, filePath, fileSize, durationMs, mimeType, description, mediaType, photoMetadata, placeId }) {
  await this.pool.execute(
    `INSERT INTO video_messages (message_id, sender_id, recipient_id, lng, lat, file_path, file_size, duration_ms, mime_type, media_type, description, photo_metadata, place_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [messageId, senderId, recipientId || null, lng, lat, filePath, fileSize, durationMs || null, mimeType, mediaType || 'video', description || null, photoMetadata || null, placeId || null]
  );
  // Ownership sync
  if (lat && lng) {
    const type = (mediaType || 'video') === 'photo' ? 'photo' : 'video';
    const points = type === 'video' ? 5 : 1;
    notifyH3ContentItem({ itemType: type, itemId: messageId, userId: senderId, lat, lng, points }).catch(() => {});
  }
  return this.getVideoMessageById(messageId);
};

DatabaseService.prototype.getVideoMessageById = async function(messageId, userId = null) {
  const [rows] = await this.pool.execute(
    `SELECT vm.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar,
            COALESCE(vc.view_count, 0) AS view_count,
            COALESCE(lc.like_count, 0) AS like_count,
            gp.display_name AS place_name, gp.formatted_address AS place_address
     FROM video_messages vm
     JOIN users u ON u.id = vm.sender_id
     LEFT JOIN view_counts vc ON vc.entity_type = 'video_message' AND vc.entity_id = vm.message_id
     LEFT JOIN like_counts lc ON lc.entity_type = 'video_message' AND lc.entity_id = vm.message_id
     LEFT JOIN google_places gp ON gp.id = vm.place_id
     WHERE vm.message_id = ?`,
    [messageId]
  );
  const msg = rows[0] || null;
  if (msg) {
    msg.tags = await this.getVideoMessageTags(msg.id);
    if (userId) {
      const [likeRows] = await this.pool.execute(
        'SELECT 1 FROM likes WHERE entity_type = ? AND entity_id = ? AND user_id = ?',
        ['video_message', messageId, userId]
      );
      msg.liked = likeRows.length > 0;
    } else {
      msg.liked = false;
    }
  }
  return msg;
};

DatabaseService.prototype.getVideoMessages = async function(userId, { bounds, limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
  const safeOffset = Math.max(parseInt(offset) || 0, 0);

  let where = '(vm.recipient_id IS NULL';
  const params = [];

  if (userId) {
    where += ' OR vm.recipient_id = ? OR vm.sender_id = ?)';
    params.push(userId, userId);
  } else {
    where += ')';
  }

  if (bounds) {
    where += ' AND vm.lng BETWEEN ? AND ? AND vm.lat BETWEEN ? AND ?';
    params.push(bounds.swLng, bounds.neLng, bounds.swLat, bounds.neLat);
  }

  const [rows] = await this.pool.execute(
    `SELECT vm.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar,
            COALESCE(vc.view_count, 0) AS view_count,
            COALESCE(lc.like_count, 0) AS like_count,
            gp.display_name AS place_name, gp.formatted_address AS place_address
     FROM video_messages vm
     JOIN users u ON u.id = vm.sender_id
     LEFT JOIN view_counts vc ON vc.entity_type = 'video_message' AND vc.entity_id = vm.message_id
     LEFT JOIN like_counts lc ON lc.entity_type = 'video_message' AND lc.entity_id = vm.message_id
     LEFT JOIN google_places gp ON gp.id = vm.place_id
     WHERE ${where}
     ORDER BY vm.created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params
  );
  // [PERF] Batch fetch tags instead of N+1 queries
  if (rows.length > 0) {
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const [tagRows] = await this.pool.query(
      `SELECT vmt.video_message_id, t.name FROM tags t
       JOIN video_message_tags vmt ON vmt.tag_id = t.id
       WHERE vmt.video_message_id IN (${placeholders})
       ORDER BY t.name`,
      ids
    );
    const tagMap = new Map();
    for (const tr of tagRows) {
      if (!tagMap.has(tr.video_message_id)) tagMap.set(tr.video_message_id, []);
      tagMap.get(tr.video_message_id).push(tr.name);
    }

    // [PERF] Batch fetch liked status for current user
    let likedSet = new Set();
    if (userId) {
      const messageIds = rows.map(r => r.message_id);
      const msgPlaceholders = messageIds.map(() => '?').join(',');
      const [likeRows] = await this.pool.query(
        `SELECT entity_id FROM likes WHERE entity_type = 'video_message' AND user_id = ? AND entity_id IN (${msgPlaceholders})`,
        [userId, ...messageIds]
      );
      likedSet = new Set(likeRows.map(r => r.entity_id));
    }

    for (const row of rows) {
      row.tags = tagMap.get(row.id) || [];
      row.liked = likedSet.has(row.message_id);
    }
  }
  return rows;
};

DatabaseService.prototype.getUnreadVideoMessageCount = async function(userId) {
  const [rows] = await this.pool.execute(
    'SELECT COUNT(*) AS cnt FROM video_messages WHERE recipient_id = ? AND is_read = 0',
    [userId]
  );
  return rows[0].cnt;
};

DatabaseService.prototype.markVideoMessageRead = async function(messageId, userId) {
  const [result] = await this.pool.execute(
    'UPDATE video_messages SET is_read = 1 WHERE message_id = ? AND recipient_id = ?',
    [messageId, userId]
  );
  return result.affectedRows > 0;
};

DatabaseService.prototype.deleteVideoMessage = async function(messageId, userId) {
  const msg = await this.getVideoMessageById(messageId);
  if (!msg || msg.sender_id !== userId) return null;
  await this.pool.execute('DELETE FROM video_messages WHERE message_id = ?', [messageId]);
  notifyH3ContentItemRemove(messageId).catch(() => {});
  return msg;
};

DatabaseService.prototype.ensureTag = async function(tagName) {
  const trimmed = tagName.trim().substring(0, 100);
  if (!trimmed) return null;
  await this.pool.execute('INSERT IGNORE INTO tags (name) VALUES (?)', [trimmed]);
  const [rows] = await this.pool.execute('SELECT id FROM tags WHERE name = ?', [trimmed]);
  return rows[0]?.id || null;
};

DatabaseService.prototype.setVideoMessageTags = async function(videoMessageId, tagNames) {
  if (!tagNames || tagNames.length === 0) return;
  const limited = tagNames.slice(0, 5);
  for (const name of limited) {
    const tagId = await this.ensureTag(name);
    if (tagId) {
      await this.pool.execute(
        'INSERT IGNORE INTO video_message_tags (video_message_id, tag_id) VALUES (?, ?)',
        [videoMessageId, tagId]
      );
    }
  }
};

DatabaseService.prototype.replaceVideoMessageTags = async function(videoMessageId, tagNames) {
  await this.pool.execute('DELETE FROM video_message_tags WHERE video_message_id = ?', [videoMessageId]);
  if (tagNames && tagNames.length > 0) {
    await this.setVideoMessageTags(videoMessageId, tagNames);
  }
};

DatabaseService.prototype.getVideoMessageTags = async function(videoMessageId) {
  const [rows] = await this.pool.execute(
    `SELECT t.name FROM tags t
     JOIN video_message_tags vmt ON vmt.tag_id = t.id
     WHERE vmt.video_message_id = ?
     ORDER BY t.name`,
    [videoMessageId]
  );
  return rows.map(r => r.name);
};

DatabaseService.prototype.searchVideoMessages = async function(query, userId = null, limit = 20, offset = 0) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 50);
  const safeOffset = Math.max(parseInt(offset) || 0, 0);

  let visibilityClause = 'vm.recipient_id IS NULL';
  const visibilityParams = [];

  if (userId) {
    visibilityClause = '(vm.recipient_id IS NULL OR vm.sender_id = ? OR vm.recipient_id = ?)';
    visibilityParams.push(userId, userId);
  }

  // Build FULLTEXT search term for BOOLEAN MODE (prefix matching with *)
  const ftTerm = query.split(/\s+/).filter(w => w.length >= 2).map(w => `+${w}*`).join(' ');

  // UNION: tag LIKE search + FULLTEXT search on description/ai_description
  const sql = `SELECT DISTINCT vm.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar,
          COALESCE(vc.view_count, 0) AS view_count
   FROM video_messages vm
   JOIN users u ON u.id = vm.sender_id
   LEFT JOIN view_counts vc ON vc.entity_type = 'video_message' AND vc.entity_id = vm.message_id
   WHERE vm.id IN (
     SELECT vmt_vm.id FROM video_messages vmt_vm
     JOIN video_message_tags vmt ON vmt.video_message_id = vmt_vm.id
     JOIN tags t ON t.id = vmt.tag_id
     WHERE t.name LIKE ?
     UNION
     SELECT ft_vm.id FROM video_messages ft_vm
     WHERE MATCH(ft_vm.description, ft_vm.ai_description) AGAINST(? IN BOOLEAN MODE)
   )
   AND ${visibilityClause}
   ORDER BY vm.created_at DESC
   LIMIT ${safeLimit} OFFSET ${safeOffset}`;

  const params = [`%${query}%`, ftTerm, ...visibilityParams];
  const [rows] = await this.pool.execute(sql, params);

  // [PERF] Batch fetch tags instead of N+1 queries
  if (rows.length > 0) {
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const [tagRows] = await this.pool.query(
      `SELECT vmt.video_message_id, t.name FROM tags t
       JOIN video_message_tags vmt ON vmt.tag_id = t.id
       WHERE vmt.video_message_id IN (${placeholders})
       ORDER BY t.name`,
      ids
    );
    const tagMap = new Map();
    for (const tr of tagRows) {
      if (!tagMap.has(tr.video_message_id)) tagMap.set(tr.video_message_id, []);
      tagMap.get(tr.video_message_id).push(tr.name);
    }
    for (const row of rows) {
      row.tags = tagMap.get(row.id) || [];
    }
  }
  return rows;
};

DatabaseService.prototype.updateVideoMessageThumbnail = async function(messageId, thumbnailPath) {
  await this.pool.execute(
    'UPDATE video_messages SET thumbnail_path = ? WHERE message_id = ?',
    [thumbnailPath, messageId]
  );
};

DatabaseService.prototype.updateVideoMessageAiDescription = async function(messageId, aiDescription) {
  await this.pool.execute(
    'UPDATE video_messages SET ai_description = ? WHERE message_id = ?',
    [aiDescription, messageId]
  );
};

DatabaseService.prototype.getAdminVideoMessages = async function(page = 1, limit = 20, filters = {}) {
  page = Math.max(1, parseInt(page) || 1);
  limit = Math.min(Math.max(1, parseInt(limit) || 20), 100);
  const offset = (page - 1) * limit;

  let whereClause = '1=1';
  const params = [];

  if (filters.media_type && ['video', 'photo'].includes(filters.media_type)) {
    whereClause += ' AND vm.media_type = ?';
    params.push(filters.media_type);
  }

  if (filters.search) {
    whereClause += ' AND (vm.description LIKE ? OR vm.ai_description LIKE ? OR u.display_name LIKE ?)';
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }

  const [items] = await this.pool.execute(
    `SELECT vm.id, vm.message_id, vm.sender_id, vm.recipient_id,
            vm.file_size, vm.duration_ms, vm.media_type,
            vm.description, vm.ai_description, vm.thumbnail_path,
            vm.created_at,
            u.display_name AS sender_name, u.avatar_url AS sender_avatar,
            COALESCE(vc.view_count, 0) AS view_count
     FROM video_messages vm
     JOIN users u ON u.id = vm.sender_id
     LEFT JOIN view_counts vc ON vc.entity_type = 'video_message' AND vc.entity_id = vm.message_id
     WHERE ${whereClause}
     ORDER BY vm.created_at DESC
     LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`,
    params
  );

  const countParams = [...params];
  const [countRows] = await this.pool.execute(
    `SELECT COUNT(*) AS total FROM video_messages vm
     JOIN users u ON u.id = vm.sender_id
     WHERE ${whereClause}`,
    countParams
  );
  const total = countRows[0].total;

  // Batch fetch tags
  if (items.length > 0) {
    const ids = items.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const [tagRows] = await this.pool.query(
      `SELECT vmt.video_message_id, t.name FROM tags t
       JOIN video_message_tags vmt ON vmt.tag_id = t.id
       WHERE vmt.video_message_id IN (${placeholders})
       ORDER BY t.name`,
      ids
    );
    const tagMap = new Map();
    for (const tr of tagRows) {
      if (!tagMap.has(tr.video_message_id)) tagMap.set(tr.video_message_id, []);
      tagMap.get(tr.video_message_id).push(tr.name);
    }
    for (const row of items) {
      row.tags = tagMap.get(row.id) || [];
    }
  }

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  };
};

DatabaseService.prototype.adminDeleteVideoMessage = async function(messageId) {
  const msg = await this.getVideoMessageById(messageId);
  if (!msg) return null;
  await this.pool.execute('DELETE FROM video_messages WHERE message_id = ?', [messageId]);
  notifyH3ContentItemRemove(messageId).catch(() => {});
  return msg;
};

};
