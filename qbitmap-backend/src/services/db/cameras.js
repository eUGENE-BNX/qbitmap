const { notifyH3CameraChange, notifyH3CameraRemove, notifyH3ContentItem, notifyH3ContentItemRemove } = require('../../utils/h3-sync');
const settingsCache = require('../settings-cache');
const logger = require('../../utils/logger').child({ module: 'db-cameras' });

// Columns returned by getCameraById / getCameraByDeviceId — the two hot-path
// lookups used on every frame upload, WS subscribe, and route auth check.
// Intentionally excludes face_detection_enabled, face_detection_interval,
// and alarm_trigger_names: those live behind the dedicated
// getFaceDetectionSettings() query and are never read off the generic
// camera object (verified across all routes/* and services/*). Trimming
// them keeps the row payload small — alarm_trigger_names in particular is
// a TEXT column that can grow arbitrarily. Admin-side flows that need
// every column should build a bespoke query.
const CAMERA_COLS = 'id, device_id, user_id, name, lng, lat, is_public, stream_mode, last_seen, camera_type, whep_url, voice_call_enabled, mediamtx_path, onvif_camera_id, rtsp_source_url, audio_muted, created_at';

module.exports = function(DatabaseService) {

DatabaseService.prototype._safePagination = function(page, limit, maxLimit = 100) {
  page = Math.max(parseInt(page) || 1, 1);
  limit = Math.min(Math.max(parseInt(limit) || 20, 1), maxLimit);
  return { page, limit, offset: (page - 1) * limit };
};

DatabaseService.prototype.registerCamera = async function(deviceId) {
  const [result] = await this.pool.execute(
    'INSERT IGNORE INTO cameras (device_id, last_seen) VALUES (?, NOW())',
    [deviceId]
  );

  if (result.affectedRows > 0) {
    return this.getCameraByDeviceId(deviceId);
  }

  // Update last_seen if already exists
  await this.pool.execute(
    'UPDATE cameras SET last_seen = NOW() WHERE device_id = ?',
    [deviceId]
  );

  return this.getCameraByDeviceId(deviceId);
};

DatabaseService.prototype.getCameraByDeviceId = async function(deviceId) {
  const [rows] = await this.pool.execute(`SELECT ${CAMERA_COLS} FROM cameras WHERE device_id = ?`, [deviceId]);
  return rows[0];
};

DatabaseService.prototype.getCameraSettings = async function(cameraId) {
  // Check cache first
  const cached = settingsCache.get(cameraId);
  if (cached) {
    return cached;
  }

  const [rows] = await this.pool.execute('SELECT * FROM camera_settings WHERE camera_id = ?', [cameraId]);
  const settings = rows[0];

  if (settings) {
    settingsCache.set(cameraId, settings);
  }

  return settings;
};

DatabaseService.prototype.updateCameraSettings = async function(cameraId, settingsJson) {
  settingsCache.invalidate(cameraId);

  const [rows] = await this.pool.execute('SELECT * FROM camera_settings WHERE camera_id = ?', [cameraId]);
  const existing = rows[0];

  if (existing) {
    const newVersion = existing.config_version + 1;
    await this.pool.execute(
      'UPDATE camera_settings SET settings_json = ?, config_version = ?, updated_at = NOW() WHERE camera_id = ?',
      [settingsJson, newVersion, cameraId]
    );
    return newVersion;
  } else {
    await this.pool.execute(
      'INSERT INTO camera_settings (camera_id, settings_json, config_version) VALUES (?, ?, 1)',
      [cameraId, settingsJson]
    );
    return 1;
  }
};

DatabaseService.prototype.getAllCameraIds = async function() {
  const [rows] = await this.pool.execute('SELECT id FROM cameras');
  return rows.map(row => row.id);
};

DatabaseService.prototype.claimCamera = async function(userId, deviceId) {
  const camera = await this.getCameraByDeviceId(deviceId);

  if (!camera) {
    return { success: false, error: 'Camera not found. Make sure the device has connected at least once.' };
  }

  if (camera.user_id !== null) {
    if (camera.user_id === userId) {
      return { success: false, error: 'You already own this camera.' };
    }
    return { success: false, error: 'This camera is already claimed by another user.' };
  }

  await this.pool.execute('UPDATE cameras SET user_id = ? WHERE id = ?', [userId, camera.id]);

  return { success: true, camera: await this.getCameraById(camera.id) };
};

DatabaseService.prototype.getCameraById = async function(cameraId) {
  const [rows] = await this.pool.execute(`SELECT ${CAMERA_COLS} FROM cameras WHERE id = ?`, [cameraId]);
  return rows[0];
};

DatabaseService.prototype.isUserCameraOwner = async function(userId, cameraId) {
  const camera = await this.getCameraById(cameraId);
  return camera && camera.user_id === userId;
};

DatabaseService.prototype.updateCamera = async function(cameraId, userId, { name, lng, lat, isPublic, skipOwnerCheck } = {}) {
  if (!skipOwnerCheck && !(await this.isUserCameraOwner(userId, cameraId))) {
    return { success: false, error: 'You do not own this camera.' };
  }

  const updates = [];
  const values = [];

  if (name !== undefined && name !== '') { updates.push('name = ?'); values.push(name); }
  if (lng !== undefined) { updates.push('lng = ?'); values.push(lng); }
  if (lat !== undefined) { updates.push('lat = ?'); values.push(lat); }
  if (isPublic !== undefined) { updates.push('is_public = ?'); values.push(isPublic ? 1 : 0); }

  if (updates.length === 0) {
    return { success: false, error: 'No fields to update.' };
  }

  values.push(cameraId);

  await this.pool.execute(
    `UPDATE cameras SET ${updates.join(', ')} WHERE id = ?`,
    values
  );

  if (isPublic !== undefined) {
    this.invalidateAccessCache(cameraId);
  }

  const updatedCamera = await this.getCameraById(cameraId);
  if (updatedCamera && updatedCamera.lat && updatedCamera.lng) {
    notifyH3CameraChange(updatedCamera).catch(() => {});
    // Ownership sync (skip city cameras)
    if (!updatedCamera.device_id.startsWith('CITY_') && updatedCamera.user_id) {
      notifyH3ContentItem({ itemType: 'camera', itemId: updatedCamera.device_id, userId: updatedCamera.user_id, lat: updatedCamera.lat, lng: updatedCamera.lng, points: 50 }).catch(() => {});
    }
  }

  return { success: true, camera: updatedCamera };
};

DatabaseService.prototype.releaseCamera = async function(cameraId, userId) {
  if (!(await this.isUserCameraOwner(userId, cameraId))) {
    return { success: false, error: 'You do not own this camera.' };
  }

  const camera = await this.getCameraById(cameraId);
  await this.pool.execute('UPDATE cameras SET user_id = NULL WHERE id = ?', [cameraId]);

  // Remove 50-point camera content_item from H3 service
  if (camera && camera.device_id) {
    notifyH3ContentItemRemove(camera.device_id).catch(() => {});
  }

  return { success: true };
};

DatabaseService.prototype.createWhepCamera = async function(userId, { name, whepUrl }) {
  const deviceId = 'WHEP_' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

  try {
    await this.pool.execute(
      "INSERT INTO cameras (device_id, user_id, name, camera_type, whep_url, is_public) VALUES (?, ?, ?, 'whep', ?, 0)",
      [deviceId, userId, name || 'WHEP Camera', whepUrl]
    );

    const camera = await this.getCameraByDeviceId(deviceId);
    return { success: true, camera };
  } catch (error) {
    logger.error({ err: error }, 'Create WHEP camera error');
    return { success: false, error: 'Failed to create camera' };
  }
};

DatabaseService.prototype.updateCameraWhepUrl = async function(cameraId, userId, whepUrl) {
  if (!(await this.isUserCameraOwner(userId, cameraId))) {
    return { success: false, error: 'You do not own this camera.' };
  }

  await this.pool.execute('UPDATE cameras SET whep_url = ? WHERE id = ?', [whepUrl, cameraId]);
  return { success: true, camera: await this.getCameraById(cameraId) };
};

DatabaseService.prototype.createRtspCamera = async function(userId, { name, whepUrl, mediamtxPath, onvifCameraId, rtspSourceUrl }) {
  const deviceId = 'RTSP_' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

  try {
    await this.pool.execute(
      "INSERT INTO cameras (device_id, user_id, name, camera_type, whep_url, mediamtx_path, onvif_camera_id, rtsp_source_url, is_public) VALUES (?, ?, ?, 'whep', ?, ?, ?, ?, 0)",
      [deviceId, userId, name || 'RTSP Camera', whepUrl, mediamtxPath, onvifCameraId || null, rtspSourceUrl || null]
    );

    const camera = await this.getCameraByDeviceId(deviceId);
    return { success: true, camera };
  } catch (error) {
    logger.error({ err: error }, 'Create RTSP camera error');
    return { success: false, error: 'Failed to create camera' };
  }
};

DatabaseService.prototype.getRtspCamerasForSync = async function() {
  const [rows] = await this.pool.execute(`
    SELECT device_id, mediamtx_path, rtsp_source_url
    FROM cameras
    WHERE camera_type = 'whep'
      AND device_id LIKE 'RTSP_%'
      AND rtsp_source_url IS NOT NULL
      AND mediamtx_path IS NOT NULL
  `);
  return rows;
};

DatabaseService.prototype.createCityCamera = async function(adminUserId, { name, whepUrl, mediamtxPath, hlsSourceUrl, lat, lng }) {
  const deviceId = 'CITY_' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

  try {
    await this.pool.execute(
      "INSERT INTO cameras (device_id, user_id, name, camera_type, whep_url, mediamtx_path, rtsp_source_url, lng, lat, is_public) VALUES (?, ?, ?, 'city', ?, ?, ?, ?, ?, 1)",
      [deviceId, adminUserId, name || 'Şehir Kamerası', whepUrl, mediamtxPath, hlsSourceUrl, lng || null, lat || null]
    );

    const camera = await this.getCameraByDeviceId(deviceId);
    if (camera && camera.lat && camera.lng) {
      notifyH3CameraChange(camera).catch(() => {});
    }
    return { success: true, camera };
  } catch (error) {
    logger.error({ err: error }, 'Create city camera error');
    return { success: false, error: 'Failed to create city camera' };
  }
};

DatabaseService.prototype.getCityCameras = async function() {
  const [rows] = await this.pool.execute(`
    SELECT id, device_id, name, lng, lat, camera_type, whep_url, mediamtx_path, rtsp_source_url, created_at
    FROM cameras
    WHERE camera_type = 'city'
    ORDER BY name ASC
  `);
  return rows;
};

DatabaseService.prototype.getRtmpCamerasForSync = async function() {
  const [rows] = await this.pool.execute(`
    SELECT device_id, mediamtx_path
    FROM cameras
    WHERE camera_type = 'whep'
      AND device_id LIKE 'RTMP_%'
      AND mediamtx_path IS NOT NULL
  `);
  return rows;
};

DatabaseService.prototype.getCityCamerasForSync = async function() {
  const [rows] = await this.pool.execute(`
    SELECT device_id, mediamtx_path, rtsp_source_url as hls_url
    FROM cameras
    WHERE camera_type = 'city'
      AND mediamtx_path IS NOT NULL
      AND rtsp_source_url IS NOT NULL
  `);
  return rows;
};

DatabaseService.prototype.createRtmpCamera = async function(userId, { name, whepUrl, mediamtxPath }) {
  const deviceId = 'RTMP_' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

  try {
    await this.pool.execute(
      "INSERT INTO cameras (device_id, user_id, name, camera_type, whep_url, mediamtx_path, is_public) VALUES (?, ?, ?, 'whep', ?, ?, 0)",
      [deviceId, userId, name || 'RTMP Kamera', whepUrl, mediamtxPath]
    );

    const camera = await this.getCameraByDeviceId(deviceId);
    return { success: true, camera };
  } catch (error) {
    logger.error({ err: error }, 'Create RTMP camera error');
    return { success: false, error: 'Failed to create camera' };
  }
};

DatabaseService.prototype.updateCameraOnvifId = async function(cameraId, onvifCameraId) {
  await this.pool.execute('UPDATE cameras SET onvif_camera_id = ? WHERE id = ?', [onvifCameraId, cameraId]);
};

DatabaseService.prototype.getCameraByMediamtxPath = async function(mediamtxPath) {
  const [rows] = await this.pool.execute('SELECT * FROM cameras WHERE mediamtx_path = ?', [mediamtxPath]);
  return rows[0];
};

DatabaseService.prototype.getPublicCamerasByBbox = async function(bbox, page = 1, limit = 50) {
  ({ page, limit } = this._safePagination(page, limit));
  const offset = (page - 1) * limit;

  // Exclude city cameras: served via /city-cameras to keep payloads disjoint
  const [items] = await this.pool.execute(`
    SELECT id, device_id, name, lng, lat, stream_mode, last_seen, created_at, camera_type, whep_url, rtsp_source_url, mediamtx_path
    FROM cameras
    WHERE is_public = 1 AND camera_type <> 'city'
      AND lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?
    ORDER BY last_seen DESC
    LIMIT ${limit} OFFSET ${offset}
  `, [bbox.west, bbox.east, bbox.south, bbox.north]);

  const [countRows] = await this.pool.execute(
    `SELECT COUNT(*) as count FROM cameras
     WHERE is_public = 1 AND camera_type <> 'city'
       AND lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?`,
    [bbox.west, bbox.east, bbox.south, bbox.north]
  );
  const total = countRows[0].count;

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total }
  };
};

DatabaseService.prototype.getPublicCamerasPaginated = async function(page = 1, limit = 20) {
  ({ page, limit } = this._safePagination(page, limit));
  const offset = (page - 1) * limit;

  // Exclude city cameras: served via /city-cameras to keep payloads disjoint
  const [items] = await this.pool.query(`
    SELECT id, device_id, name, lng, lat, stream_mode, last_seen, created_at, camera_type, whep_url, rtsp_source_url, mediamtx_path
    FROM cameras
    WHERE is_public = 1 AND camera_type <> 'city'
    ORDER BY last_seen DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const [countRows] = await this.pool.execute("SELECT COUNT(*) as count FROM cameras WHERE is_public = 1 AND camera_type <> 'city'");
  const total = countRows[0].count;

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total }
  };
};

DatabaseService.prototype.getUserCamerasPaginated = async function(userId, page = 1, limit = 20) {
  ({ page, limit } = this._safePagination(page, limit));
  const offset = (page - 1) * limit;

  const [items] = await this.pool.execute(`
    SELECT id, device_id, name, lng, lat, is_public, stream_mode, last_seen, created_at, camera_type, whep_url, audio_muted
    FROM cameras
    WHERE user_id = ?
    ORDER BY last_seen DESC
    LIMIT ${limit} OFFSET ${offset}
  `, [userId]);

  const [countRows] = await this.pool.execute('SELECT COUNT(*) as count FROM cameras WHERE user_id = ?', [userId]);
  const total = countRows[0].count;

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total }
  };
};

DatabaseService.prototype.getActiveAlarmsPaginated = async function(page = 1, limit = 20) {
  ({ page, limit } = this._safePagination(page, limit));
  const offset = (page - 1) * limit;

  const [items] = await this.pool.query(`
    SELECT a.*, c.device_id, c.name
    FROM alarms a
    JOIN cameras c ON c.id = a.camera_id
    WHERE a.cleared_at IS NULL
    ORDER BY a.triggered_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const [countRows] = await this.pool.execute('SELECT COUNT(*) as count FROM alarms WHERE cleared_at IS NULL');
  const total = countRows[0].count;

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total }
  };
};

DatabaseService.prototype.getCameraAlarmHistoryPaginated = async function(cameraId, page = 1, limit = 20) {
  ({ page, limit } = this._safePagination(page, limit));
  const offset = (page - 1) * limit;

  const [items] = await this.pool.execute(`
    SELECT id, alarm_data, triggered_at, cleared_at, acknowledged
    FROM alarms
    WHERE camera_id = ?
    ORDER BY triggered_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `, [cameraId]);

  const [countRows] = await this.pool.execute('SELECT COUNT(*) as count FROM alarms WHERE camera_id = ?', [cameraId]);
  const total = countRows[0].count;

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total }
  };
};

DatabaseService.prototype.deleteCamera = async function(cameraId, userId) {
  if (!(await this.isUserCameraOwner(userId, cameraId))) {
    return { success: false, error: 'You do not own this camera.' };
  }

  const camera = await this.getCameraById(cameraId);
  const conn = await this.pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM face_detection_log WHERE camera_id = ?', [cameraId]);
    await conn.execute('DELETE FROM camera_faces WHERE camera_id = ?', [cameraId]);
    await conn.execute('DELETE FROM ai_monitoring WHERE camera_id = ?', [cameraId]);

    await conn.execute('DELETE FROM alarms WHERE camera_id = ?', [cameraId]);
    await conn.execute('DELETE FROM camera_settings WHERE camera_id = ?', [cameraId]);
    await conn.execute('DELETE FROM camera_shares WHERE camera_id = ?', [cameraId]);
    await conn.execute('DELETE FROM camera_onvif_links WHERE qbitmap_camera_id = ?', [cameraId]);
    await conn.execute('DELETE FROM clickable_zones WHERE camera_id = ?', [camera.device_id]);
    await conn.execute('DELETE FROM cameras WHERE id = ?', [cameraId]);
    await conn.commit();
    if (camera) {
      notifyH3CameraRemove(camera.device_id).catch(() => {});
      notifyH3ContentItemRemove(camera.device_id).catch(() => {});
    }
    return { success: true };
  } catch (error) {
    await conn.rollback();
    return { success: false, error: 'Database error during deletion: ' + error.message };
  } finally {
    conn.release();
  }
};

DatabaseService.prototype.updateCameraLastSeen = async function(cameraId) {
  await this.pool.execute('UPDATE cameras SET last_seen = NOW() WHERE id = ?', [cameraId]);
};

DatabaseService.prototype.getUserCameraTypeCounts = async function(userId) {
  const [rows] = await this.pool.execute(`
    SELECT COUNT(*) as total,
           COUNT(CASE WHEN camera_type = 'device' THEN 1 END) as device_count,
           COUNT(CASE WHEN camera_type = 'whep' THEN 1 END) as whep_count
    FROM cameras WHERE user_id = ?
  `, [userId]);
  return rows[0];
};

DatabaseService.prototype.getUserWhepCameraCount = async function(userId) {
  const [rows] = await this.pool.execute(
    "SELECT COUNT(*) as count FROM cameras WHERE user_id = ? AND camera_type = 'whep'",
    [userId]
  );
  return rows[0].count;
};

DatabaseService.prototype.adminDeleteCamera = async function(cameraId) {
  const camera = await this.getCameraById(cameraId);
  const conn = await this.pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM face_detection_log WHERE camera_id = ?', [cameraId]);
    await conn.execute('DELETE FROM camera_faces WHERE camera_id = ?', [cameraId]);
    await conn.execute('DELETE FROM ai_monitoring WHERE camera_id = ?', [cameraId]);

    await conn.execute('DELETE FROM alarms WHERE camera_id = ?', [cameraId]);
    await conn.execute('DELETE FROM camera_settings WHERE camera_id = ?', [cameraId]);
    await conn.execute('DELETE FROM camera_shares WHERE camera_id = ?', [cameraId]);
    await conn.execute('DELETE FROM camera_onvif_links WHERE qbitmap_camera_id = ?', [cameraId]);
    await conn.execute('DELETE FROM clickable_zones WHERE camera_id = ?', [camera?.device_id]);
    await conn.execute('DELETE FROM cameras WHERE id = ?', [cameraId]);
    await conn.commit();
    if (camera) {
      notifyH3CameraRemove(camera.device_id).catch(() => {});
      notifyH3ContentItemRemove(camera.device_id).catch(() => {});
    }
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

DatabaseService.prototype.adminUpdateCamera = async function(cameraId, updates, params) {
  await this.pool.execute(`UPDATE cameras SET ${updates.join(', ')} WHERE id = ?`, params);
};

// [ARCH-04] Moved from inline db.pool.execute in routes/admin.js
DatabaseService.prototype.updateCameraRtspSourceUrl = async function(cameraId, url) {
  await this.pool.execute('UPDATE cameras SET rtsp_source_url = ? WHERE id = ?', [url, cameraId]);
};

// [ARCH-04] Moved from inline db.pool.query in routes/public.js
DatabaseService.prototype.getCamerasWithGeolocation = async function() {
  const [rows] = await this.pool.execute(
    'SELECT id, device_id, lat, lng, name, camera_type, is_public FROM cameras WHERE lat IS NOT NULL AND lng IS NOT NULL'
  );
  return rows;
};

// [ARCH-04] H3 sync: cameras with location, excluding city cameras
DatabaseService.prototype.getCamerasForH3Sync = async function() {
  const [rows] = await this.pool.execute(
    "SELECT device_id, user_id, lat, lng FROM cameras WHERE lat IS NOT NULL AND lng IS NOT NULL AND user_id IS NOT NULL AND device_id NOT LIKE 'CITY_%'"
  );
  return rows;
};

};
