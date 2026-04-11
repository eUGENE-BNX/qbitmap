const { notifyH3ContentItem, notifyH3ContentItemRemove } = require('../../utils/h3-sync');

module.exports = function(DatabaseService) {

DatabaseService.prototype.createVideoMessage = async function(senderId, { messageId, recipientId, lng, lat, accuracyRadiusM, locationSource, filePath, fileSize, durationMs, mimeType, description, mediaType, photoMetadata, placeId }) {
  await this.pool.execute(
    `INSERT INTO video_messages (message_id, sender_id, recipient_id, lng, lat, accuracy_radius_m, location_source, file_path, file_size, duration_ms, mime_type, media_type, description, photo_metadata, place_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [messageId, senderId, recipientId || null, lng, lat, accuracyRadiusM || null, locationSource || null, filePath, fileSize, durationMs || null, mimeType, mediaType || 'video', description || null, photoMetadata || null, placeId || null]
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

DatabaseService.prototype.getVideoMessages = async function(userId, { bounds, limit = 50, offset = 0, cursor = null } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);

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

  // Cursor-based pagination: use created_at cursor for O(1) seeks
  // Falls back to OFFSET for backwards compatibility
  if (cursor) {
    where += ' AND vm.created_at < ?';
    params.push(cursor);
  }

  const offsetClause = (!cursor && offset) ? ` OFFSET ${Math.max(parseInt(offset) || 0, 0)}` : '';

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
     LIMIT ${safeLimit}${offsetClause}`,
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

  // Ensure all tags exist in parallel
  const tagIds = await Promise.all(limited.map(name => this.ensureTag(name)));
  const validIds = tagIds.filter(Boolean);

  if (validIds.length === 0) return;

  // Batch insert all tag associations
  const placeholders = validIds.map(() => '(?, ?)').join(', ');
  const params = validIds.flatMap(tagId => [videoMessageId, tagId]);
  await this.pool.execute(
    `INSERT IGNORE INTO video_message_tags (video_message_id, tag_id) VALUES ${placeholders}`,
    params
  );
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

  // UNION: tag LIKE + FULLTEXT on description/ai_description + FULLTEXT on translations
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
     UNION
     SELECT tr_vm.id FROM video_messages tr_vm
     JOIN video_message_translations vmt2 ON vmt2.message_id = tr_vm.message_id
     WHERE MATCH(vmt2.text) AGAINST(? IN BOOLEAN MODE)
   )
   AND ${visibilityClause}
   ORDER BY vm.created_at DESC
   LIMIT ${safeLimit} OFFSET ${safeOffset}`;

  const params = [`%${query}%`, ftTerm, ftTerm, ...visibilityParams];
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

DatabaseService.prototype.updateVideoMessageAiDescription = async function(messageId, aiDescription, langCode = null) {
  await this.pool.execute(
    'UPDATE video_messages SET ai_description = ?, ai_description_lang = ? WHERE message_id = ?',
    [aiDescription, langCode, messageId]
  );
};

// --- Geo language cell cache (coord → primary local lang) ---
DatabaseService.prototype.getGeoLangCell = async function(cellKey) {
  const [rows] = await this.pool.execute(
    'SELECT lang_code, country_code, subdivision_code FROM geo_lang_cells WHERE cell_key = ?',
    [cellKey]
  );
  return rows[0] || null;
};

DatabaseService.prototype.upsertGeoLangCell = async function(cellKey, countryCode, subdivisionCode, langCode) {
  await this.pool.execute(
    `INSERT INTO geo_lang_cells (cell_key, country_code, subdivision_code, lang_code)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE lang_code = VALUES(lang_code), country_code = VALUES(country_code), subdivision_code = VALUES(subdivision_code)`,
    [cellKey, countryCode, subdivisionCode, langCode]
  );
};

// --- On-demand translation cache ---
DatabaseService.prototype.getVideoMessageTranslation = async function(messageId, lang) {
  const [rows] = await this.pool.execute(
    'SELECT text FROM video_message_translations WHERE message_id = ? AND lang = ?',
    [messageId, lang]
  );
  return rows[0]?.text || null;
};

DatabaseService.prototype.saveVideoMessageTranslation = async function(messageId, lang, text) {
  await this.pool.execute(
    `INSERT INTO video_message_translations (message_id, lang, text) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE text = VALUES(text), created_at = CURRENT_TIMESTAMP`,
    [messageId, lang, text]
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
     LIMIT ${limit} OFFSET ${offset}`,
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
