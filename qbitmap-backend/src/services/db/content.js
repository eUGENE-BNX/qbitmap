const logger = require('../../utils/logger').child({ module: 'db-content' });

module.exports = function(DatabaseService) {

DatabaseService.prototype.createClickableZone = async function(cameraId, userId, { name, points, relayOnUrl, relayOffUrl, relayStatusUrl }) {
  const zoneId = 'zone_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);

  try {
    await this.pool.execute(
      'INSERT INTO clickable_zones (id, camera_id, user_id, name, points, relay_on_url, relay_off_url, relay_status_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [zoneId, cameraId, userId, name, JSON.stringify(points), relayOnUrl || null, relayOffUrl || null, relayStatusUrl || null]
    );
    return { success: true, zoneId };
  } catch (error) {
    logger.error({ err: error }, 'Create clickable zone error');
    return { success: false, error: error.message };
  }
};

DatabaseService.prototype.getCameraZones = async function(cameraId) {
  const [rows] = await this.pool.execute(
    'SELECT id, camera_id, user_id, name, points, last_state, created_at FROM clickable_zones WHERE camera_id = ? ORDER BY created_at ASC',
    [cameraId]
  );
  return rows;
};

DatabaseService.prototype.getZoneById = async function(zoneId) {
  const [rows] = await this.pool.execute('SELECT * FROM clickable_zones WHERE id = ?', [zoneId]);
  return rows[0];
};

DatabaseService.prototype.getZoneByIdSafe = async function(zoneId) {
  const [rows] = await this.pool.execute(
    'SELECT id, camera_id, user_id, name, points, last_state, created_at FROM clickable_zones WHERE id = ?',
    [zoneId]
  );
  return rows[0];
};

DatabaseService.prototype.updateZoneState = async function(zoneId, newState) {
  await this.pool.execute('UPDATE clickable_zones SET last_state = ? WHERE id = ?', [newState, zoneId]);
};

DatabaseService.prototype.updateClickableZone = async function(zoneId, userId, { name, points, relayOnUrl, relayOffUrl, relayStatusUrl }) {
  const zone = await this.getZoneById(zoneId);
  if (!zone) return { success: false, error: 'Zone not found' };
  if (zone.user_id !== userId) return { success: false, error: 'Not authorized' };

  const updates = [];
  const values = [];

  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (points !== undefined) { updates.push('points = ?'); values.push(JSON.stringify(points)); }
  if (relayOnUrl !== undefined) { updates.push('relay_on_url = ?'); values.push(relayOnUrl); }
  if (relayOffUrl !== undefined) { updates.push('relay_off_url = ?'); values.push(relayOffUrl); }
  if (relayStatusUrl !== undefined) { updates.push('relay_status_url = ?'); values.push(relayStatusUrl); }

  if (updates.length === 0) return { success: true };

  values.push(zoneId);
  await this.pool.execute(`UPDATE clickable_zones SET ${updates.join(', ')} WHERE id = ?`, values);
  return { success: true };
};

DatabaseService.prototype.deleteClickableZone = async function(zoneId, userId) {
  const zone = await this.getZoneById(zoneId);
  if (!zone) return { success: false, error: 'Zone not found' };
  if (userId !== null && zone.user_id !== userId) return { success: false, error: 'Not authorized' };

  await this.pool.execute('DELETE FROM clickable_zones WHERE id = ?', [zoneId]);
  return { success: true };
};

DatabaseService.prototype.isUserZoneOwner = async function(userId, zoneId) {
  const zone = await this.getZoneById(zoneId);
  return zone && zone.user_id === userId;
};

DatabaseService.prototype.createLiveBroadcast = async function(userId, { broadcastId, displayName, avatarUrl, mediamtxPath, whepUrl, lng, lat, accuracyRadiusM, locationSource, orientation }) {
  await this.pool.execute(
    'INSERT INTO live_broadcasts (broadcast_id, user_id, display_name, avatar_url, mediamtx_path, whep_url, lng, lat, accuracy_radius_m, location_source, orientation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [broadcastId, userId, displayName, avatarUrl, mediamtxPath, whepUrl, lng, lat, accuracyRadiusM || null, locationSource || null, orientation || 'landscape']
  );
};

DatabaseService.prototype.endLiveBroadcast = async function(broadcastId, userId) {
  await this.pool.execute(
    "UPDATE live_broadcasts SET status = 'ended', ended_at = NOW() WHERE broadcast_id = ? AND user_id = ? AND status = 'active'",
    [broadcastId, userId]
  );
};

DatabaseService.prototype.getActiveBroadcasts = async function() {
  const [rows] = await this.pool.execute("SELECT * FROM live_broadcasts WHERE status = 'active' ORDER BY started_at DESC");
  return rows;
};

DatabaseService.prototype.getActiveBroadcastByUser = async function(userId) {
  const [rows] = await this.pool.execute("SELECT * FROM live_broadcasts WHERE user_id = ? AND status = 'active'", [userId]);
  return rows[0];
};

DatabaseService.prototype.endAllBroadcastsForUser = async function(userId) {
  await this.pool.execute(
    "UPDATE live_broadcasts SET status = 'ended', ended_at = NOW() WHERE user_id = ? AND status = 'active'",
    [userId]
  );
};

DatabaseService.prototype.cleanupStaleBroadcasts = async function(maxAgeMinutes) {
  const [rows] = await this.pool.execute(
    "SELECT * FROM live_broadcasts WHERE status = 'active' AND started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)",
    [maxAgeMinutes]
  );

  if (rows.length > 0) {
    await this.pool.execute(
      "UPDATE live_broadcasts SET status = 'ended', ended_at = NOW() WHERE status = 'active' AND started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)",
      [maxAgeMinutes]
    );
  }

  return rows;
};

DatabaseService.prototype.incrementViewCount = async function(entityType, entityId) {
  await this.pool.execute(
    `INSERT INTO view_counts (entity_type, entity_id, view_count)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE view_count = view_count + 1`,
    [entityType, entityId]
  );
};

DatabaseService.prototype.getViewCount = async function(entityType, entityId) {
  const [rows] = await this.pool.execute(
    'SELECT view_count FROM view_counts WHERE entity_type = ? AND entity_id = ?',
    [entityType, entityId]
  );
  return rows[0]?.view_count || 0;
};

DatabaseService.prototype.toggleLike = async function(userId, entityType, entityId) {
  const conn = await this.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.execute(
      'SELECT id FROM likes WHERE entity_type = ? AND entity_id = ? AND user_id = ?',
      [entityType, entityId, userId]
    );
    let liked;
    if (existing.length > 0) {
      await conn.execute('DELETE FROM likes WHERE id = ?', [existing[0].id]);
      await conn.execute(
        'UPDATE like_counts SET like_count = GREATEST(like_count - 1, 0) WHERE entity_type = ? AND entity_id = ?',
        [entityType, entityId]
      );
      liked = false;
    } else {
      await conn.execute(
        'INSERT INTO likes (entity_type, entity_id, user_id) VALUES (?, ?, ?)',
        [entityType, entityId, userId]
      );
      await conn.execute(
        `INSERT INTO like_counts (entity_type, entity_id, like_count)
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE like_count = like_count + 1`,
        [entityType, entityId]
      );
      liked = true;
    }
    const [countRows] = await conn.execute(
      'SELECT like_count FROM like_counts WHERE entity_type = ? AND entity_id = ?',
      [entityType, entityId]
    );
    await conn.commit();
    return { liked, likeCount: countRows[0]?.like_count || 0 };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

DatabaseService.prototype.getLikeStatus = async function(entityType, entityId, userId = null) {
  const [countRows] = await this.pool.execute(
    'SELECT like_count FROM like_counts WHERE entity_type = ? AND entity_id = ?',
    [entityType, entityId]
  );
  const likeCount = countRows[0]?.like_count || 0;
  let liked = false;
  if (userId) {
    const [likeRows] = await this.pool.execute(
      'SELECT 1 FROM likes WHERE entity_type = ? AND entity_id = ? AND user_id = ?',
      [entityType, entityId, userId]
    );
    liked = likeRows.length > 0;
  }
  return { likeCount, liked };
};

DatabaseService.prototype.createComment = async function(userId, entityType, entityId, content) {
  const [result] = await this.pool.execute(
    'INSERT INTO comments (entity_type, entity_id, user_id, content) VALUES (?, ?, ?, ?)',
    [entityType, entityId, userId, content]
  );
  return this.getCommentById(result.insertId);
};

DatabaseService.prototype.getCommentById = async function(id) {
  const [rows] = await this.pool.execute(
    `SELECT c.*, u.display_name AS user_name, u.avatar_url AS user_avatar
     FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.id = ?`,
    [id]
  );
  return rows[0] || null;
};

DatabaseService.prototype.getComments = async function(entityType, entityId, { limit = 20, before } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 50);
  const params = [entityType, entityId];
  let whereExtra = '';
  if (before) {
    whereExtra = ' AND c.id < ?';
    params.push(parseInt(before));
  }
  const [rows] = await this.pool.execute(
    `SELECT c.*, u.display_name AS user_name, u.avatar_url AS user_avatar
     FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.entity_type = ? AND c.entity_id = ?${whereExtra}
     ORDER BY c.id DESC
     LIMIT ${safeLimit}`,
    params
  );
  return rows;
};

DatabaseService.prototype.getCommentCount = async function(entityType, entityId) {
  const [rows] = await this.pool.execute(
    'SELECT COUNT(*) AS cnt FROM comments WHERE entity_type = ? AND entity_id = ?',
    [entityType, entityId]
  );
  return rows[0].cnt;
};

DatabaseService.prototype.deleteComment = async function(commentId, userId) {
  const comment = await this.getCommentById(commentId);
  if (!comment || comment.user_id !== userId) return null;
  await this.pool.execute('DELETE FROM comments WHERE id = ?', [commentId]);
  return comment;
};

DatabaseService.prototype.getPlacesCacheCell = async function(cellLat, cellLng, radius) {
  const [rows] = await this.pool.execute(
    'SELECT id, queried_at FROM places_cache_cells WHERE cell_lat = ? AND cell_lng = ? AND radius_m = ?',
    [cellLat, cellLng, radius]
  );
  return rows[0] || null;
};

DatabaseService.prototype.getPlacesForCell = async function(cellId) {
  const [rows] = await this.pool.execute(
    `SELECT gp.id, gp.google_place_id, gp.display_name, gp.formatted_address,
            gp.lat, gp.lng, gp.types, gp.icon_url, gp.business_status, gp.rating, gp.user_ratings_total
     FROM google_places gp
     JOIN places_cache_cell_places pccp ON pccp.place_id = gp.id
     WHERE pccp.cell_id = ?
     ORDER BY gp.rating DESC, gp.user_ratings_total DESC`,
    [cellId]
  );
  return rows;
};

DatabaseService.prototype.getPlaceById = async function(placeId) {
  const [rows] = await this.pool.execute(
    'SELECT id, google_place_id, display_name, formatted_address, lat, lng, types, icon_url, business_status, rating, user_ratings_total FROM google_places WHERE id = ?',
    [placeId]
  );
  return rows[0] || null;
};

DatabaseService.prototype.storePlacesCache = async function(cellLat, cellLng, radius, places) {
  // Upsert the cache cell
  await this.pool.execute(
    `INSERT INTO places_cache_cells (cell_lat, cell_lng, radius_m, queried_at, result_count)
     VALUES (?, ?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE queried_at = NOW(), result_count = VALUES(result_count)`,
    [cellLat, cellLng, radius, places.length]
  );

  const [cellRows] = await this.pool.execute(
    'SELECT id FROM places_cache_cells WHERE cell_lat = ? AND cell_lng = ? AND radius_m = ?',
    [cellLat, cellLng, radius]
  );
  const cellId = cellRows[0].id;

  // Clear old cell-place links
  await this.pool.execute('DELETE FROM places_cache_cell_places WHERE cell_id = ?', [cellId]);

  // Upsert each place and link to cell
  for (const p of places) {
    await this.pool.execute(
      `INSERT INTO google_places (google_place_id, display_name, formatted_address, lat, lng, types, business_status, rating, user_ratings_total, cached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), formatted_address = VALUES(formatted_address),
         lat = VALUES(lat), lng = VALUES(lng), types = VALUES(types), business_status = VALUES(business_status),
         rating = VALUES(rating), user_ratings_total = VALUES(user_ratings_total), cached_at = NOW()`,
      [p.googlePlaceId, p.displayName, p.formattedAddress, p.lat, p.lng, JSON.stringify(p.types), p.businessStatus, p.rating, p.userRatingsTotal]
    );

    const [placeRows] = await this.pool.execute(
      'SELECT id FROM google_places WHERE google_place_id = ?',
      [p.googlePlaceId]
    );

    await this.pool.execute(
      'INSERT IGNORE INTO places_cache_cell_places (cell_id, place_id) VALUES (?, ?)',
      [cellId, placeRows[0].id]
    );
  }

  return cellId;
};

DatabaseService.prototype.getAllPlaces = async function(page = 1, limit = 20, search = '') {
  const safePage = Math.max(parseInt(page) || 1, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
  const safeOffset = (safePage - 1) * safeLimit;

  let where = '1=1';
  const params = [];
  if (search) {
    where = '(gp.display_name LIKE ? OR gp.formatted_address LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const [countRows] = await this.pool.execute(
    `SELECT COUNT(*) AS total FROM google_places gp WHERE ${where}`,
    params
  );
  const total = countRows[0].total;

  const [rows] = await this.pool.execute(
    `SELECT gp.*, COUNT(vm.id) AS tag_count
     FROM google_places gp
     LEFT JOIN video_messages vm ON vm.place_id = gp.id
     WHERE ${where}
     GROUP BY gp.id
     ORDER BY gp.cached_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params
  );

  return {
    places: rows,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit)
    }
  };
};

DatabaseService.prototype.updatePlaceIcon = async function(placeId, iconUrl) {
  await this.pool.execute(
    'UPDATE google_places SET icon_url = ? WHERE id = ?',
    [iconUrl, placeId]
  );
};

DatabaseService.prototype.deletePlace = async function(placeId) {
  // Remove from junction first (cascade should handle this, but be explicit)
  await this.pool.execute('DELETE FROM places_cache_cell_places WHERE place_id = ?', [placeId]);
  // Set null on video_messages
  await this.pool.execute('UPDATE video_messages SET place_id = NULL WHERE place_id = ?', [placeId]);
  // Delete place
  await this.pool.execute('DELETE FROM google_places WHERE id = ?', [placeId]);
};

DatabaseService.prototype.clearPlacesCache = async function() {
  await this.pool.execute('DELETE FROM places_cache_cell_places');
  await this.pool.execute('DELETE FROM places_cache_cells');
  // Don't delete google_places that are referenced by video_messages
  await this.pool.execute(
    'DELETE FROM google_places WHERE id NOT IN (SELECT DISTINCT place_id FROM video_messages WHERE place_id IS NOT NULL)'
  );
};

DatabaseService.prototype.getPlacesStats = async function() {
  const [[{ totalPlaces }]] = await this.pool.execute('SELECT COUNT(*) AS totalPlaces FROM google_places');
  const [[{ totalCells }]] = await this.pool.execute('SELECT COUNT(*) AS totalCells FROM places_cache_cells');
  const [[{ taggedMessages }]] = await this.pool.execute('SELECT COUNT(*) AS taggedMessages FROM video_messages WHERE place_id IS NOT NULL');
  return { totalPlaces, totalCells, taggedMessages };
};

};
