const pool = require('./db-pool');
const settingsCache = require('./settings-cache');
const { notifyH3CameraChange, notifyH3CameraRemove, notifyH3ContentItem, notifyH3ContentItemRemove, notifyH3UserProfile } = require('../utils/h3-sync');

// [PERF] Access cache configuration
const ACCESS_CACHE_TTL = 60000; // 1 minute cache
const ACCESS_CACHE_MAX_SIZE = 5000; // Max entries

class DatabaseService {
  constructor() {
    this.pool = pool;

    // [PERF] Camera access cache: Map<"userId:cameraId" -> { result, time }>
    this.accessCache = new Map();

    // [QW-3] Periodic cleanup of expired access cache entries (every 5 minutes)
    this.accessCacheCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.accessCache.entries()) {
        if (now - entry.time > ACCESS_CACHE_TTL) {
          this.accessCache.delete(key);
        }
      }
    }, 5 * 60 * 1000);

    this._ready = this._initialize();
  }

  async ensureReady() {
    await this._ready;
  }

  async _initialize() {
    // Tables are created via schema.sql during migration.
    // On startup, just seed defaults if not present.
    await this.seedUserPlans();
    await this.seedOnvifTemplates();
    await this.seedSystemSettings();
    await this.setAdminUser();
    console.log('Database initialized successfully');
  }

  // ==================== SYSTEM SETTINGS ====================
  async seedSystemSettings() {
    const defaults = [
      { key: 'ai_service_url', value: 'http://92.44.163.139:8080/api/generate', description: 'Ollama API URL' },
      { key: 'ai_vision_model', value: 'qwen3-vl:32b-instruct', description: 'Vision LLM model name' }
    ];

    for (const setting of defaults) {
      await this.pool.execute(
        'INSERT IGNORE INTO system_settings (`key`, value, description) VALUES (?, ?, ?)',
        [setting.key, setting.value, setting.description]
      );
    }
  }

  // [PERF] System settings cache - avoids repeated DB queries for rarely-changing values
  _systemSettingsCache = new Map();
  _SYSTEM_SETTINGS_TTL = 60000; // 1 minute

  async getSystemSetting(key) {
    const cached = this._systemSettingsCache.get(key);
    if (cached && Date.now() - cached.time < this._SYSTEM_SETTINGS_TTL) {
      return cached.value;
    }
    const [rows] = await this.pool.execute('SELECT value FROM system_settings WHERE `key` = ?', [key]);
    const value = rows[0]?.value || null;
    this._systemSettingsCache.set(key, { value, time: Date.now() });
    return value;
  }

  async setSystemSetting(key, value) {
    this._systemSettingsCache.delete(key); // Invalidate cache on write
    await this.pool.execute(
      'INSERT INTO system_settings (`key`, value, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()',
      [key, value]
    );
  }

  async getAllSystemSettings() {
    const [rows] = await this.pool.execute('SELECT `key`, value, description, updated_at FROM system_settings');
    return rows;
  }

  // ==================== ACTIVE RECORDINGS ====================

  async startRecording(cameraId, pathName, userId, maxDurationMs = 3600000) {
    await this.pool.execute(
      'REPLACE INTO active_recordings (camera_id, path_name, user_id, started_at, max_duration_ms) VALUES (?, ?, ?, NOW(), ?)',
      [cameraId, pathName, userId, maxDurationMs]
    );
  }

  async stopRecording(cameraId) {
    await this.pool.execute('DELETE FROM active_recordings WHERE camera_id = ?', [cameraId]);
  }

  async getActiveRecording(cameraId) {
    const [rows] = await this.pool.execute('SELECT * FROM active_recordings WHERE camera_id = ?', [cameraId]);
    return rows[0];
  }

  async getAllActiveRecordings() {
    const [rows] = await this.pool.execute('SELECT * FROM active_recordings');
    return rows;
  }

  async clearAllActiveRecordings() {
    await this.pool.execute('DELETE FROM active_recordings');
  }

  // Camera operations
  async registerCamera(deviceId) {
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
  }

  async getCameraByDeviceId(deviceId) {
    const [rows] = await this.pool.execute('SELECT * FROM cameras WHERE device_id = ?', [deviceId]);
    return rows[0];
  }

  async getCameraSettings(cameraId) {
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
  }

  async updateCameraSettings(cameraId, settingsJson) {
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
  }

  async getAllCameraIds() {
    const [rows] = await this.pool.execute('SELECT id FROM cameras');
    return rows.map(row => row.id);
  }

  // ==================== USER OPERATIONS ====================

  async createOrUpdateUser({ googleId, email, displayName, avatarUrl }) {
    const existing = await this.getUserByGoogleId(googleId);

    if (existing) {
      await this.pool.execute(
        'UPDATE users SET email = ?, display_name = ?, avatar_url = ? WHERE google_id = ?',
        [email, displayName, avatarUrl, googleId]
      );
      const user = await this.getUserByGoogleId(googleId);
      notifyH3UserProfile({ id: user.id, displayName: user.display_name, avatarUrl: user.avatar_url }).catch(() => {});
      return user;
    } else {
      await this.pool.execute(
        'INSERT INTO users (google_id, email, display_name, avatar_url) VALUES (?, ?, ?, ?)',
        [googleId, email, displayName, avatarUrl]
      );
      const user = await this.getUserByGoogleId(googleId);
      notifyH3UserProfile({ id: user.id, displayName: user.display_name, avatarUrl: user.avatar_url }).catch(() => {});
      return user;
    }
  }

  async getUserById(userId) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    return rows[0];
  }

  async getUserByGoogleId(googleId) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE google_id = ?', [googleId]);
    return rows[0];
  }

  async getUserByEmail(email) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    return rows[0];
  }

  async getUserByDisplayName(displayName) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE display_name = ?', [displayName]);
    return rows[0];
  }

  // ==================== FACE RECOGNITION OPERATIONS ====================

  async updateUserFace(userId, faceImagePath, faceApiPersonId) {
    await this.pool.execute(
      'UPDATE users SET face_image_path = ?, face_api_person_id = ? WHERE id = ?',
      [faceImagePath, faceApiPersonId, userId]
    );
    return this.getUserById(userId);
  }

  async getUserFaceInfo(userId) {
    const [rows] = await this.pool.execute(
      'SELECT id, face_image_path, face_api_person_id FROM users WHERE id = ?',
      [userId]
    );
    const user = rows[0];

    return user ? {
      userId: user.id,
      faceImagePath: user.face_image_path,
      faceApiPersonId: user.face_api_person_id,
      hasFaceRegistered: !!user.face_api_person_id
    } : null;
  }

  async clearUserFace(userId) {
    await this.pool.execute(
      'UPDATE users SET face_image_path = NULL, face_api_person_id = NULL WHERE id = ?',
      [userId]
    );
  }

  // ==================== USER LOCATION ====================

  async updateUserLocation(userId, lat, lng, accuracy) {
    await this.pool.execute(
      'UPDATE users SET last_lat = ?, last_lng = ?, last_location_accuracy = ?, last_location_updated = NOW() WHERE id = ?',
      [lat, lng, accuracy, userId]
    );
    return this.getUserById(userId);
  }

  async updateUserLocationVisibility(userId, showOnMap) {
    await this.pool.execute(
      'UPDATE users SET show_location_on_map = ? WHERE id = ?',
      [showOnMap ? 1 : 0, userId]
    );
    return this.getUserById(userId);
  }

  async getUserLocation(userId) {
    const [rows] = await this.pool.execute(
      'SELECT id, last_lat, last_lng, last_location_accuracy, last_location_updated, show_location_on_map FROM users WHERE id = ?',
      [userId]
    );
    const user = rows[0];

    if (!user) return null;

    return {
      lat: user.last_lat,
      lng: user.last_lng,
      accuracy: user.last_location_accuracy,
      updatedAt: user.last_location_updated,
      showOnMap: !!user.show_location_on_map
    };
  }

  async getUsersWithVisibleLocation() {
    const [rows] = await this.pool.execute(`
      SELECT u.id, u.display_name, u.avatar_url, u.last_lat, u.last_lng, u.last_location_accuracy, u.last_location_updated,
             (SELECT COUNT(*) FROM cameras WHERE user_id = u.id) as camera_count
      FROM users u
      WHERE u.show_location_on_map = 1 AND u.last_lat IS NOT NULL AND u.last_lng IS NOT NULL
    `);
    return rows;
  }

  async getUserByFaceApiPersonId(faceApiPersonId) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE face_api_person_id = ?', [faceApiPersonId]);
    return rows[0];
  }

  // ==================== USER CAMERA OPERATIONS ====================

  async getUserCameras(userId) {
    const [rows] = await this.pool.execute(`
      SELECT id, device_id, name, lng, lat, is_public, stream_mode, last_seen, created_at, camera_type, whep_url, mediamtx_path, onvif_camera_id, audio_muted
      FROM cameras
      WHERE user_id = ?
      ORDER BY last_seen DESC
    `, [userId]);
    return rows;
  }

  async claimCamera(userId, deviceId) {
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
  }

  async getCameraById(cameraId) {
    const [rows] = await this.pool.execute('SELECT * FROM cameras WHERE id = ?', [cameraId]);
    return rows[0];
  }

  async isUserCameraOwner(userId, cameraId) {
    const camera = await this.getCameraById(cameraId);
    return camera && camera.user_id === userId;
  }

  async updateCamera(cameraId, userId, { name, lng, lat, isPublic, skipOwnerCheck } = {}) {
    if (!skipOwnerCheck && !(await this.isUserCameraOwner(userId, cameraId))) {
      return { success: false, error: 'You do not own this camera.' };
    }

    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
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
  }

  async releaseCamera(cameraId, userId) {
    if (!(await this.isUserCameraOwner(userId, cameraId))) {
      return { success: false, error: 'You do not own this camera.' };
    }

    await this.pool.execute('UPDATE cameras SET user_id = NULL WHERE id = ?', [cameraId]);
    return { success: true };
  }

  async createWhepCamera(userId, { name, whepUrl }) {
    const deviceId = 'WHEP_' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

    try {
      await this.pool.execute(
        "INSERT INTO cameras (device_id, user_id, name, camera_type, whep_url, is_public) VALUES (?, ?, ?, 'whep', ?, 0)",
        [deviceId, userId, name || 'WHEP Camera', whepUrl]
      );

      const camera = await this.getCameraByDeviceId(deviceId);
      return { success: true, camera };
    } catch (error) {
      console.error('[Database] Create WHEP camera error:', error);
      return { success: false, error: 'Failed to create camera' };
    }
  }

  async updateCameraWhepUrl(cameraId, userId, whepUrl) {
    if (!(await this.isUserCameraOwner(userId, cameraId))) {
      return { success: false, error: 'You do not own this camera.' };
    }

    await this.pool.execute('UPDATE cameras SET whep_url = ? WHERE id = ?', [whepUrl, cameraId]);
    return { success: true, camera: await this.getCameraById(cameraId) };
  }

  async createRtspCamera(userId, { name, whepUrl, mediamtxPath, onvifCameraId, rtspSourceUrl }) {
    const deviceId = 'RTSP_' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

    try {
      await this.pool.execute(
        "INSERT INTO cameras (device_id, user_id, name, camera_type, whep_url, mediamtx_path, onvif_camera_id, rtsp_source_url, is_public) VALUES (?, ?, ?, 'whep', ?, ?, ?, ?, 0)",
        [deviceId, userId, name || 'RTSP Camera', whepUrl, mediamtxPath, onvifCameraId || null, rtspSourceUrl || null]
      );

      const camera = await this.getCameraByDeviceId(deviceId);
      return { success: true, camera };
    } catch (error) {
      console.error('[Database] Create RTSP camera error:', error);
      return { success: false, error: 'Failed to create camera' };
    }
  }

  async getRtspCamerasForSync() {
    const [rows] = await this.pool.execute(`
      SELECT device_id, mediamtx_path, rtsp_source_url
      FROM cameras
      WHERE camera_type = 'whep'
        AND device_id LIKE 'RTSP_%'
        AND rtsp_source_url IS NOT NULL
        AND mediamtx_path IS NOT NULL
    `);
    return rows;
  }

  async createCityCamera(adminUserId, { name, whepUrl, mediamtxPath, hlsSourceUrl, lat, lng }) {
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
      console.error('[Database] Create city camera error:', error);
      return { success: false, error: 'Failed to create city camera' };
    }
  }

  async getCityCameras() {
    const [rows] = await this.pool.execute(`
      SELECT id, device_id, name, lng, lat, camera_type, whep_url, mediamtx_path, rtsp_source_url, created_at
      FROM cameras
      WHERE camera_type = 'city'
      ORDER BY name ASC
    `);
    return rows;
  }

  async getRtmpCamerasForSync() {
    const [rows] = await this.pool.execute(`
      SELECT device_id, mediamtx_path
      FROM cameras
      WHERE camera_type = 'whep'
        AND device_id LIKE 'RTMP_%'
        AND mediamtx_path IS NOT NULL
    `);
    return rows;
  }

  async getCityCamerasForSync() {
    const [rows] = await this.pool.execute(`
      SELECT device_id, mediamtx_path, rtsp_source_url as hls_url
      FROM cameras
      WHERE camera_type = 'city'
        AND mediamtx_path IS NOT NULL
        AND rtsp_source_url IS NOT NULL
    `);
    return rows;
  }

  async createRtmpCamera(userId, { name, whepUrl, mediamtxPath }) {
    const deviceId = 'RTMP_' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

    try {
      await this.pool.execute(
        "INSERT INTO cameras (device_id, user_id, name, camera_type, whep_url, mediamtx_path, is_public) VALUES (?, ?, ?, 'whep', ?, ?, 0)",
        [deviceId, userId, name || 'RTMP Kamera', whepUrl, mediamtxPath]
      );

      const camera = await this.getCameraByDeviceId(deviceId);
      return { success: true, camera };
    } catch (error) {
      console.error('[Database] Create RTMP camera error:', error);
      return { success: false, error: 'Failed to create camera' };
    }
  }

  async updateCameraOnvifId(cameraId, onvifCameraId) {
    await this.pool.execute('UPDATE cameras SET onvif_camera_id = ? WHERE id = ?', [onvifCameraId, cameraId]);
  }

  async getCameraByMediamtxPath(mediamtxPath) {
    const [rows] = await this.pool.execute('SELECT * FROM cameras WHERE mediamtx_path = ?', [mediamtxPath]);
    return rows[0];
  }

  // ==================== AI MONITORING OPERATIONS ====================

  async getAiMonitoringState(cameraId) {
    const [rows] = await this.pool.execute('SELECT * FROM ai_monitoring WHERE camera_id = ?', [cameraId]);
    return rows[0];
  }

  async setAiMonitoring(cameraId, enabled, userId) {
    const existing = await this.getAiMonitoringState(cameraId);

    if (existing) {
      await this.pool.execute(
        'UPDATE ai_monitoring SET enabled = ?, started_by_user_id = ?, started_at = NOW(), config_version = config_version + 1 WHERE camera_id = ?',
        [enabled ? 1 : 0, userId, cameraId]
      );
    } else {
      await this.pool.execute(
        'INSERT INTO ai_monitoring (camera_id, enabled, started_by_user_id) VALUES (?, ?, ?)',
        [cameraId, enabled ? 1 : 0, userId]
      );
    }

    return this.getAiMonitoringState(cameraId);
  }

  async updateLastAnalysis(cameraId) {
    await this.pool.execute('UPDATE ai_monitoring SET last_analysis_at = NOW() WHERE camera_id = ?', [cameraId]);
  }

  async getAllActiveMonitoring() {
    const [rows] = await this.pool.execute(`
      SELECT am.*, c.device_id, c.name, c.camera_type, c.whep_url
      FROM ai_monitoring am
      JOIN cameras c ON c.id = am.camera_id
      WHERE am.enabled = 1
    `);
    return rows;
  }

  async getActiveMonitoringForUser(userId) {
    const [rows] = await this.pool.execute(`
      SELECT am.*, c.device_id, c.name, c.camera_type, c.whep_url
      FROM ai_monitoring am
      JOIN cameras c ON c.id = am.camera_id
      WHERE am.enabled = 1
        AND (
          c.user_id = ?
          OR c.is_public = 1
          OR EXISTS (
            SELECT 1 FROM camera_shares cs
            WHERE cs.camera_id = c.id AND cs.shared_with_user_id = ?
          )
        )
    `, [userId, userId]);
    return rows;
  }

  // ==================== ALARM OPERATIONS ====================

  async createAlarm(cameraId, deviceId, alarmData) {
    const [result] = await this.pool.execute(
      'INSERT INTO alarms (camera_id, device_id, alarm_data) VALUES (?, ?, ?)',
      [cameraId, deviceId, JSON.stringify(alarmData)]
    );
    return result.insertId;
  }

  async getActiveAlarm(cameraId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM alarms WHERE camera_id = ? AND cleared_at IS NULL ORDER BY triggered_at DESC LIMIT 1',
      [cameraId]
    );
    return rows[0];
  }

  async clearAlarm(alarmId, userId) {
    await this.pool.execute(
      'UPDATE alarms SET cleared_at = NOW(), cleared_by_user_id = ? WHERE id = ?',
      [userId, alarmId]
    );
  }

  async getAllActiveAlarms() {
    const [rows] = await this.pool.execute(`
      SELECT a.*, c.device_id, c.name
      FROM alarms a
      JOIN cameras c ON c.id = a.camera_id
      WHERE a.cleared_at IS NULL
      ORDER BY a.triggered_at DESC
    `);
    return rows;
  }

  async getActiveAlarmsForUser(userId) {
    const [rows] = await this.pool.execute(`
      SELECT a.*, c.device_id, c.name
      FROM alarms a
      JOIN cameras c ON c.id = a.camera_id
      WHERE a.cleared_at IS NULL
        AND (
          c.user_id = ?
          OR c.is_public = 1
          OR EXISTS (
            SELECT 1 FROM camera_shares cs
            WHERE cs.camera_id = c.id AND cs.shared_with_user_id = ?
          )
        )
      ORDER BY a.triggered_at DESC
    `, [userId, userId]);
    return rows;
  }

  async getCameraAlarmHistory(cameraId, limit = 50) {
    const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const [rows] = await this.pool.execute(
      `SELECT * FROM alarms WHERE camera_id = ? ORDER BY triggered_at DESC LIMIT ${safeLimit}`,
      [cameraId]
    );
    return rows;
  }

  async getAlarmById(alarmId) {
    const [rows] = await this.pool.execute('SELECT * FROM alarms WHERE id = ?', [alarmId]);
    return rows[0];
  }

  // ==================== ONVIF OPERATIONS ====================

  async seedOnvifTemplates() {
    const templates = [
      { model_name: 'Tapo C100', manufacturer: 'TP-Link', onvif_port: 2020, supported_events: JSON.stringify(['motion', 'human']) },
      { model_name: 'Tapo C200', manufacturer: 'TP-Link', onvif_port: 2020, supported_events: JSON.stringify(['motion', 'human', 'pet']) },
      { model_name: 'Tapo C210', manufacturer: 'TP-Link', onvif_port: 2020, supported_events: JSON.stringify(['motion', 'human', 'pet']) }
    ];

    for (const t of templates) {
      try {
        await this.pool.execute(
          'INSERT IGNORE INTO onvif_camera_templates (model_name, manufacturer, onvif_port, supported_events) VALUES (?, ?, ?, ?)',
          [t.model_name, t.manufacturer, t.onvif_port, t.supported_events]
        );
      } catch (e) {
        // Ignore duplicate errors
      }
    }
  }

  async getOnvifTemplates() {
    const [rows] = await this.pool.execute(
      'SELECT id, model_name, manufacturer, onvif_port, supported_events, created_at FROM onvif_camera_templates ORDER BY manufacturer, model_name'
    );
    return rows;
  }

  async getOnvifTemplateById(templateId) {
    const [rows] = await this.pool.execute(
      'SELECT id, model_name, manufacturer, onvif_port, supported_events, created_at FROM onvif_camera_templates WHERE id = ?',
      [templateId]
    );
    return rows[0];
  }

  async createOnvifTemplate({ modelName, manufacturer, onvifPort, supportedEvents }) {
    try {
      const [result] = await this.pool.execute(
        'INSERT INTO onvif_camera_templates (model_name, manufacturer, onvif_port, supported_events) VALUES (?, ?, ?, ?)',
        [modelName, manufacturer, onvifPort, JSON.stringify(supportedEvents)]
      );

      const template = await this.getOnvifTemplateById(result.insertId);
      return { success: true, template };
    } catch (error) {
      console.error('[Database] Create ONVIF template error:', error);
      return { success: false, error: error.message };
    }
  }

  async updateOnvifTemplate(templateId, { modelName, manufacturer, onvifPort, supportedEvents }) {
    try {
      const updates = [];
      const values = [];

      if (modelName !== undefined) { updates.push('model_name = ?'); values.push(modelName); }
      if (manufacturer !== undefined) { updates.push('manufacturer = ?'); values.push(manufacturer); }
      if (onvifPort !== undefined) { updates.push('onvif_port = ?'); values.push(onvifPort); }
      if (supportedEvents !== undefined) { updates.push('supported_events = ?'); values.push(JSON.stringify(supportedEvents)); }

      if (updates.length === 0) return { success: true };

      values.push(templateId);
      await this.pool.execute(`UPDATE onvif_camera_templates SET ${updates.join(', ')} WHERE id = ?`, values);

      return { success: true };
    } catch (error) {
      console.error('[Database] Update ONVIF template error:', error);
      return { success: false, error: error.message };
    }
  }

  async deleteOnvifTemplate(templateId) {
    try {
      const [rows] = await this.pool.execute(
        'SELECT COUNT(*) as count FROM camera_onvif_links WHERE onvif_template_id = ?',
        [templateId]
      );

      if (rows[0].count > 0) {
        return { success: false, error: `Template is in use by ${rows[0].count} camera(s)` };
      }

      await this.pool.execute('DELETE FROM onvif_camera_templates WHERE id = ?', [templateId]);
      return { success: true };
    } catch (error) {
      console.error('[Database] Delete ONVIF template error:', error);
      return { success: false, error: error.message };
    }
  }

  async createOnvifLink(qbitmapCameraId, onvifCameraId, templateId) {
    try {
      await this.pool.execute('DELETE FROM camera_onvif_links WHERE onvif_camera_id = ?', [onvifCameraId]);

      await this.pool.execute(
        'REPLACE INTO camera_onvif_links (qbitmap_camera_id, onvif_camera_id, onvif_template_id) VALUES (?, ?, ?)',
        [qbitmapCameraId, onvifCameraId, templateId]
      );

      return { success: true };
    } catch (error) {
      console.error('[Database] Create ONVIF link error:', error);
      return { success: false, error: error.message };
    }
  }

  async getOnvifLink(qbitmapCameraId) {
    const [rows] = await this.pool.execute(`
      SELECT col.*, oct.model_name, oct.manufacturer, oct.supported_events
      FROM camera_onvif_links col
      JOIN onvif_camera_templates oct ON oct.id = col.onvif_template_id
      WHERE col.qbitmap_camera_id = ?
    `, [qbitmapCameraId]);
    return rows[0];
  }

  async getOnvifLinkByOnvifId(onvifCameraId) {
    const [rows] = await this.pool.execute(`
      SELECT col.*, oct.model_name, oct.manufacturer
      FROM camera_onvif_links col
      JOIN onvif_camera_templates oct ON oct.id = col.onvif_template_id
      WHERE col.onvif_camera_id = ?
    `, [onvifCameraId]);
    return rows[0];
  }

  async getAllOnvifLinks() {
    const [rows] = await this.pool.execute(`
      SELECT col.*, c.device_id, c.name, oct.model_name, oct.manufacturer
      FROM camera_onvif_links col
      JOIN cameras c ON c.id = col.qbitmap_camera_id
      JOIN onvif_camera_templates oct ON oct.id = col.onvif_template_id
      ORDER BY col.created_at DESC
    `);
    return rows;
  }

  async deleteOnvifLink(qbitmapCameraId) {
    try {
      await this.pool.execute('DELETE FROM camera_onvif_links WHERE qbitmap_camera_id = ?', [qbitmapCameraId]);
      return { success: true };
    } catch (error) {
      console.error('[Database] Delete ONVIF link error:', error);
      return { success: false, error: error.message };
    }
  }

  async updateOnvifLinkTemplate(qbitmapCameraId, templateId) {
    try {
      const [result] = await this.pool.execute(
        'UPDATE camera_onvif_links SET onvif_template_id = ? WHERE qbitmap_camera_id = ?',
        [templateId, qbitmapCameraId]
      );

      if (result.affectedRows === 0) {
        return { success: false, error: 'Link not found' };
      }

      return { success: true };
    } catch (error) {
      console.error('[Database] Update ONVIF link template error:', error);
      return { success: false, error: error.message };
    }
  }

  async saveOnvifEvent(cameraId, eventType, eventState, eventData) {
    try {
      const [result] = await this.pool.execute(
        'INSERT INTO onvif_events (camera_id, event_type, event_state, event_data) VALUES (?, ?, ?, ?)',
        [cameraId, eventType, eventState ? 1 : 0, eventData != null ? JSON.stringify(eventData) : null]
      );
      return result.insertId;
    } catch (error) {
      console.error('[Database] Save ONVIF event error:', error);
      return null;
    }
  }

  async getOnvifEvents(cameraId, limit = 100) {
    const safeLimit = Math.min(Math.max(parseInt(limit) || 100, 1), 500);
    const [rows] = await this.pool.execute(
      `SELECT id, camera_id, event_type, event_state, event_data, \`timestamp\` FROM onvif_events WHERE camera_id = ? ORDER BY \`timestamp\` DESC LIMIT ${safeLimit}`,
      [cameraId]
    );
    return rows;
  }

  async getAllRecentOnvifEvents(limit = 50) {
    const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
    const [rows] = await this.pool.query(`
      SELECT oe.*, c.device_id, c.name
      FROM onvif_events oe
      JOIN cameras c ON c.id = oe.camera_id
      ORDER BY oe.\`timestamp\` DESC
      LIMIT ${safeLimit}
    `);
    return rows;
  }

  // ==================== PAGINATION HELPERS ====================

  _safePagination(page, limit, maxLimit = 100) {
    page = Math.max(parseInt(page) || 1, 1);
    limit = Math.min(Math.max(parseInt(limit) || 20, 1), maxLimit);
    return { page, limit, offset: (page - 1) * limit };
  }

  async getPublicCamerasByBbox(bbox, page = 1, limit = 50) {
    ({ page, limit } = this._safePagination(page, limit));
    const offset = (page - 1) * limit;

    const [items] = await this.pool.execute(`
      SELECT id, device_id, name, lng, lat, stream_mode, last_seen, created_at, camera_type, whep_url, rtsp_source_url, mediamtx_path
      FROM cameras
      WHERE is_public = 1 AND lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?
      ORDER BY last_seen DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `, [bbox.west, bbox.east, bbox.south, bbox.north]);

    const [countRows] = await this.pool.execute(
      'SELECT COUNT(*) as count FROM cameras WHERE is_public = 1 AND lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?',
      [bbox.west, bbox.east, bbox.south, bbox.north]
    );
    const total = countRows[0].count;

    return {
      items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total }
    };
  }

  async getPublicCamerasPaginated(page = 1, limit = 20) {
    ({ page, limit } = this._safePagination(page, limit));
    const offset = (page - 1) * limit;

    const [items] = await this.pool.query(`
      SELECT id, device_id, name, lng, lat, stream_mode, last_seen, created_at, camera_type, whep_url, rtsp_source_url, mediamtx_path
      FROM cameras
      WHERE is_public = 1
      ORDER BY last_seen DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `);

    const [countRows] = await this.pool.execute('SELECT COUNT(*) as count FROM cameras WHERE is_public = 1');
    const total = countRows[0].count;

    return {
      items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total }
    };
  }

  async getUserCamerasPaginated(userId, page = 1, limit = 20) {
    ({ page, limit } = this._safePagination(page, limit));
    const offset = (page - 1) * limit;

    const [items] = await this.pool.execute(`
      SELECT id, device_id, name, lng, lat, is_public, stream_mode, last_seen, created_at, camera_type, whep_url, audio_muted
      FROM cameras
      WHERE user_id = ?
      ORDER BY last_seen DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `, [userId]);

    const [countRows] = await this.pool.execute('SELECT COUNT(*) as count FROM cameras WHERE user_id = ?', [userId]);
    const total = countRows[0].count;

    return {
      items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total }
    };
  }

  async getActiveAlarmsPaginated(page = 1, limit = 20) {
    ({ page, limit } = this._safePagination(page, limit));
    const offset = (page - 1) * limit;

    const [items] = await this.pool.query(`
      SELECT a.*, c.device_id, c.name
      FROM alarms a
      JOIN cameras c ON c.id = a.camera_id
      WHERE a.cleared_at IS NULL
      ORDER BY a.triggered_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `);

    const [countRows] = await this.pool.execute('SELECT COUNT(*) as count FROM alarms WHERE cleared_at IS NULL');
    const total = countRows[0].count;

    return {
      items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total }
    };
  }

  async getCameraAlarmHistoryPaginated(cameraId, page = 1, limit = 20) {
    ({ page, limit } = this._safePagination(page, limit));
    const offset = (page - 1) * limit;

    const [items] = await this.pool.execute(`
      SELECT id, alarm_data, triggered_at, cleared_at, acknowledged
      FROM alarms
      WHERE camera_id = ?
      ORDER BY triggered_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `, [cameraId]);

    const [countRows] = await this.pool.execute('SELECT COUNT(*) as count FROM alarms WHERE camera_id = ?', [cameraId]);
    const total = countRows[0].count;

    return {
      items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total }
    };
  }

  async deleteCamera(cameraId, userId) {
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
      await conn.execute('DELETE FROM frames WHERE camera_id = ?', [cameraId]);
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
  }

  // ==================== FACE DETECTION ====================

  async getFaceDetectionSettings(cameraId) {
    const [rows] = await this.pool.execute(
      'SELECT face_detection_enabled, face_detection_interval, alarm_trigger_names FROM cameras WHERE id = ?',
      [cameraId]
    );
    return rows[0];
  }

  async updateFaceDetectionSettings(cameraId, userId, enabled, interval, alarmTriggerNames) {
    if (!(await this.isUserCameraOwner(userId, cameraId))) {
      return { success: false, error: 'Not authorized' };
    }
    const updates = [];
    const params = [];
    if (enabled !== undefined) { updates.push('face_detection_enabled = ?'); params.push(enabled ? 1 : 0); }
    if (interval !== undefined) { updates.push('face_detection_interval = ?'); params.push(interval); }
    if (alarmTriggerNames !== undefined) { updates.push('alarm_trigger_names = ?'); params.push(alarmTriggerNames); }
    if (updates.length > 0) {
      params.push(cameraId);
      await this.pool.execute('UPDATE cameras SET ' + updates.join(', ') + ' WHERE id = ?', params);
    }
    return { success: true };
  }

  async getCameraFaces(cameraId) {
    const [rows] = await this.pool.execute(
      'SELECT id, person_id, name, face_image_url, trigger_alarm, created_at FROM camera_faces WHERE camera_id = ? ORDER BY created_at DESC',
      [cameraId]
    );
    return rows;
  }

  async addCameraFace(cameraId, personId, name, faceImageUrl) {
    const [result] = await this.pool.execute(
      'INSERT INTO camera_faces (camera_id, person_id, name, face_image_url) VALUES (?, ?, ?, ?)',
      [cameraId, personId, name, faceImageUrl]
    );
    return { success: true, faceId: result.insertId };
  }

  async removeCameraFace(faceId, cameraId) {
    const [rows] = await this.pool.execute('SELECT * FROM camera_faces WHERE id = ? AND camera_id = ?', [faceId, cameraId]);
    const face = rows[0];
    if (!face) return { success: false, error: 'Face not found' };
    await this.pool.execute('DELETE FROM camera_faces WHERE id = ?', [faceId]);
    return { success: true, personId: face.person_id };
  }

  async updateFaceAlarm(faceId, cameraId, triggerAlarm) {
    const [rows] = await this.pool.execute('SELECT * FROM camera_faces WHERE id = ? AND camera_id = ?', [faceId, cameraId]);
    if (!rows[0]) return { success: false, error: 'Face not found' };
    await this.pool.execute('UPDATE camera_faces SET trigger_alarm = ? WHERE id = ?', [triggerAlarm ? 1 : 0, faceId]);
    return { success: true };
  }

  async getFaceByPersonId(cameraId, personId) {
    const [rows] = await this.pool.execute(
      'SELECT id, person_id, name, face_image_url, trigger_alarm FROM camera_faces WHERE camera_id = ? AND person_id = ?',
      [cameraId, personId]
    );
    return rows[0];
  }

  async logFaceDetection(cameraId, faceId, personName, confidence) {
    await this.pool.execute(
      'INSERT INTO face_detection_log (camera_id, face_id, person_name, confidence) VALUES (?, ?, ?, ?)',
      [cameraId, faceId, personName, confidence]
    );
  }

  async getFaceDetectionLogs(cameraId, limit = 10) {
    const safeLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 200);
    const [rows] = await this.pool.execute(
      `SELECT l.id, l.face_id, l.person_name, l.confidence, l.detected_at, f.face_image_url FROM face_detection_log l LEFT JOIN camera_faces f ON l.face_id = f.id WHERE l.camera_id = ? ORDER BY l.detected_at DESC LIMIT ${safeLimit}`,
      [cameraId]
    );
    return rows;
  }

  async getCamerasWithFaceDetection() {
    const [rows] = await this.pool.execute(
      'SELECT c.id, c.device_id, c.name, c.user_id, c.camera_type, c.whep_url, c.face_detection_interval FROM cameras c WHERE c.face_detection_enabled = 1'
    );
    return rows;
  }

  // ==================== VOICE CALL OPERATIONS ====================

  async getVoiceCallEnabled(cameraId) {
    const [rows] = await this.pool.execute('SELECT voice_call_enabled FROM cameras WHERE id = ?', [cameraId]);
    return rows[0] ? !!rows[0].voice_call_enabled : false;
  }

  async setVoiceCallEnabled(cameraId, userId, enabled) {
    if (!(await this.isUserCameraOwner(userId, cameraId))) {
      return { success: false, error: 'You do not own this camera.' };
    }

    await this.pool.execute('UPDATE cameras SET voice_call_enabled = ? WHERE id = ?', [enabled ? 1 : 0, cameraId]);
    return { success: true, enabled: !!enabled };
  }

  async getCamerasWithVoiceCallEnabled() {
    const [rows] = await this.pool.execute(
      'SELECT id, device_id, name, user_id FROM cameras WHERE voice_call_enabled = 1'
    );
    return rows;
  }

  // ==================== AUDIO MUTE OPERATIONS ====================

  async setAudioMuted(cameraId, userId, muted) {
    if (!(await this.isUserCameraOwner(userId, cameraId))) {
      return { success: false, error: 'You do not own this camera.' };
    }

    await this.pool.execute('UPDATE cameras SET audio_muted = ? WHERE id = ?', [muted ? 1 : 0, cameraId]);
    return { success: true, muted: !!muted };
  }

  // ==================== USER PLANS & LIMITS ====================

  async seedUserPlans() {
    const plans = [
      { name: 'free', display_name: 'Free', max_cameras: 2, max_whep_cameras: 1, ai_analysis_enabled: 0, ai_daily_limit: 0, face_recognition_enabled: 0, max_faces_per_camera: 0, recording_enabled: 0, max_recording_hours: 0, recording_retention_days: 7, voice_call_enabled: 0, face_login_enabled: 0, voice_control_enabled: 0, public_sharing_enabled: 0, priority_support: 0 },
      { name: 'basic', display_name: 'Basic', max_cameras: 5, max_whep_cameras: 2, ai_analysis_enabled: 1, ai_daily_limit: 10, face_recognition_enabled: 1, max_faces_per_camera: 5, recording_enabled: 1, max_recording_hours: 5, recording_retention_days: 7, voice_call_enabled: 0, face_login_enabled: 0, voice_control_enabled: 0, public_sharing_enabled: 0, priority_support: 0 },
      { name: 'pro', display_name: 'Pro', max_cameras: 15, max_whep_cameras: 5, ai_analysis_enabled: 1, ai_daily_limit: 100, face_recognition_enabled: 1, max_faces_per_camera: 20, recording_enabled: 1, max_recording_hours: 50, recording_retention_days: 30, voice_call_enabled: 1, face_login_enabled: 1, voice_control_enabled: 1, public_sharing_enabled: 1, priority_support: 0 },
      { name: 'enterprise', display_name: 'Enterprise', max_cameras: -1, max_whep_cameras: -1, ai_analysis_enabled: 1, ai_daily_limit: -1, face_recognition_enabled: 1, max_faces_per_camera: -1, recording_enabled: 1, max_recording_hours: -1, recording_retention_days: 90, voice_call_enabled: 1, face_login_enabled: 1, voice_control_enabled: 1, public_sharing_enabled: 1, priority_support: 1 }
    ];

    const columns = Object.keys(plans[0]);
    const placeholders = columns.map(() => '?').join(', ');

    for (const plan of plans) {
      try {
        await this.pool.execute(
          `INSERT IGNORE INTO user_plans (${columns.join(', ')}) VALUES (${placeholders})`,
          columns.map(c => plan[c])
        );
      } catch (e) {
        // Plan already exists
      }
    }
  }

  async setAdminUser() {
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
    for (const email of adminEmails) {
      try {
        await this.pool.execute(
          "UPDATE users SET role = 'admin' WHERE email = ? AND (role IS NULL OR role = 'user')",
          [email]
        );
      } catch (e) {
        // User might not exist yet
      }
    }
  }

  async getAllPlans() {
    const [rows] = await this.pool.execute('SELECT * FROM user_plans ORDER BY id');
    return rows;
  }

  async getPlanById(planId) {
    const [rows] = await this.pool.execute('SELECT * FROM user_plans WHERE id = ?', [planId]);
    return rows[0];
  }

  async getPlanByName(name) {
    const [rows] = await this.pool.execute('SELECT * FROM user_plans WHERE name = ?', [name]);
    return rows[0];
  }

  async getUserEffectiveLimits(userId) {
    // [PERF] Single JOIN query instead of 3 sequential queries
    const [rows] = await this.pool.execute(`
      SELECT u.id, u.plan_id, u.role, u.is_active, u.google_id, u.email, u.display_name, u.avatar_url,
             u.face_api_person_id, u.created_at, u.last_login,
             p.name as p_name, p.display_name as p_display_name,
             p.max_cameras as p_max_cameras, p.max_whep_cameras as p_max_whep_cameras,
             p.ai_analysis_enabled as p_ai_analysis_enabled, p.ai_daily_limit as p_ai_daily_limit,
             p.face_recognition_enabled as p_face_recognition_enabled, p.max_faces_per_camera as p_max_faces_per_camera,
             p.recording_enabled as p_recording_enabled, p.max_recording_hours as p_max_recording_hours,
             p.recording_retention_days as p_recording_retention_days, p.voice_call_enabled as p_voice_call_enabled,
             p.face_login_enabled as p_face_login_enabled, p.voice_control_enabled as p_voice_control_enabled,
             p.public_sharing_enabled as p_public_sharing_enabled, p.priority_support as p_priority_support,
             o.max_cameras as o_max_cameras, o.max_whep_cameras as o_max_whep_cameras,
             o.ai_analysis_enabled as o_ai_analysis_enabled, o.ai_daily_limit as o_ai_daily_limit,
             o.face_recognition_enabled as o_face_recognition_enabled, o.max_faces_per_camera as o_max_faces_per_camera,
             o.recording_enabled as o_recording_enabled, o.max_recording_hours as o_max_recording_hours,
             o.recording_retention_days as o_recording_retention_days, o.voice_call_enabled as o_voice_call_enabled,
             o.face_login_enabled as o_face_login_enabled, o.voice_control_enabled as o_voice_control_enabled,
             o.public_sharing_enabled as o_public_sharing_enabled,
             o.id as o_id
      FROM users u
      LEFT JOIN user_plans p ON p.id = COALESCE(u.plan_id, 1)
      LEFT JOIN user_feature_overrides o ON o.user_id = u.id
      WHERE u.id = ?
    `, [userId]);

    const row = rows[0];
    if (!row) return null;

    const user = row;
    const plan = { name: row.p_name, display_name: row.p_display_name };
    const override = row.o_id ? row : null;

    const limits = {
      plan_id: user.plan_id || 1,
      plan_name: plan.name,
      plan_display_name: plan.display_name,
      role: user.role || 'user',
      is_active: user.is_active !== 0,
      max_cameras: override?.o_max_cameras ?? row.p_max_cameras,
      max_whep_cameras: override?.o_max_whep_cameras ?? row.p_max_whep_cameras,
      ai_analysis_enabled: override?.o_ai_analysis_enabled ?? row.p_ai_analysis_enabled,
      ai_daily_limit: override?.o_ai_daily_limit ?? row.p_ai_daily_limit,
      face_recognition_enabled: override?.o_face_recognition_enabled ?? row.p_face_recognition_enabled,
      max_faces_per_camera: override?.o_max_faces_per_camera ?? row.p_max_faces_per_camera,
      recording_enabled: override?.o_recording_enabled ?? row.p_recording_enabled,
      max_recording_hours: override?.o_max_recording_hours ?? row.p_max_recording_hours,
      recording_retention_days: override?.o_recording_retention_days ?? row.p_recording_retention_days,
      voice_call_enabled: override?.o_voice_call_enabled ?? row.p_voice_call_enabled,
      face_login_enabled: override?.o_face_login_enabled ?? row.p_face_login_enabled,
      voice_control_enabled: override?.o_voice_control_enabled ?? row.p_voice_control_enabled,
      public_sharing_enabled: override?.o_public_sharing_enabled ?? row.p_public_sharing_enabled,
      priority_support: row.p_priority_support,
      has_override: !!override
    };

    Object.keys(limits).forEach(key => {
      if (key.endsWith('_enabled') || key === 'priority_support') {
        limits[key] = !!limits[key];
      }
    });

    return limits;
  }

  async getUserTodayUsage(userId) {
    const today = new Date().toISOString().split('T')[0];
    const [rows] = await this.pool.execute(
      'SELECT * FROM user_usage WHERE user_id = ? AND usage_date = ?',
      [userId, today]
    );

    if (!rows[0]) {
      await this.pool.execute(
        'INSERT INTO user_usage (user_id, usage_date) VALUES (?, ?)',
        [userId, today]
      );
      return { ai_analysis_count: 0, face_recognition_count: 0, recording_minutes: 0, voice_call_count: 0 };
    }

    return rows[0];
  }

  async incrementUsage(userId, feature, amount = 1) {
    const today = new Date().toISOString().split('T')[0];

    await this.getUserTodayUsage(userId);

    const columnMap = {
      ai_analysis: 'ai_analysis_count',
      face_recognition: 'face_recognition_count',
      recording: 'recording_minutes',
      voice_call: 'voice_call_count'
    };

    const column = columnMap[feature];
    if (!column) return false;

    await this.pool.execute(
      `UPDATE user_usage SET ${column} = ${column} + ? WHERE user_id = ? AND usage_date = ?`,
      [amount, userId, today]
    );

    return true;
  }

  async checkFeatureLimit(userId, feature) {
    const limits = await this.getUserEffectiveLimits(userId);
    if (!limits) return { allowed: false, reason: 'User not found' };
    if (!limits.is_active) return { allowed: false, reason: 'Account deactivated' };

    const usage = await this.getUserTodayUsage(userId);

    switch (feature) {
      case 'cameras': {
        const [rows] = await this.pool.execute(
          "SELECT COUNT(*) as count FROM cameras WHERE user_id = ? AND camera_type = 'device'",
          [userId]
        );
        const currentCameras = rows[0].count;

        if (limits.max_cameras === -1) return { allowed: true };
        return {
          allowed: currentCameras < limits.max_cameras,
          current: currentCameras,
          limit: limits.max_cameras,
          reason: currentCameras >= limits.max_cameras ? 'Camera limit reached' : null
        };
      }

      case 'whep_cameras': {
        const [rows] = await this.pool.execute(
          "SELECT COUNT(*) as count FROM cameras WHERE user_id = ? AND camera_type = 'whep'",
          [userId]
        );
        const currentWhep = rows[0].count;

        if (limits.max_whep_cameras === -1) return { allowed: true };
        return {
          allowed: currentWhep < limits.max_whep_cameras,
          current: currentWhep,
          limit: limits.max_whep_cameras,
          reason: currentWhep >= limits.max_whep_cameras ? 'WHEP camera limit reached' : null
        };
      }

      case 'ai_analysis': {
        if (!limits.ai_analysis_enabled) {
          return { allowed: false, reason: 'AI analysis not enabled for your plan' };
        }
        if (limits.ai_daily_limit === -1) return { allowed: true };
        return {
          allowed: usage.ai_analysis_count < limits.ai_daily_limit,
          current: usage.ai_analysis_count,
          limit: limits.ai_daily_limit,
          reason: usage.ai_analysis_count >= limits.ai_daily_limit ? 'Daily AI limit reached' : null
        };
      }

      case 'face_recognition': {
        if (!limits.face_recognition_enabled) {
          return { allowed: false, reason: 'Face recognition not enabled for your plan' };
        }
        return { allowed: true };
      }

      case 'recording': {
        if (!limits.recording_enabled) {
          return { allowed: false, reason: 'Recording not enabled for your plan' };
        }
        if (limits.max_recording_hours === -1) return { allowed: true };
        const maxMinutes = limits.max_recording_hours * 60;
        return {
          allowed: usage.recording_minutes < maxMinutes,
          current: usage.recording_minutes,
          limit: maxMinutes,
          reason: usage.recording_minutes >= maxMinutes ? 'Monthly recording limit reached' : null
        };
      }

      case 'voice_call': {
        if (!limits.voice_call_enabled) {
          return { allowed: false, reason: 'Voice call not enabled for your plan' };
        }
        return { allowed: true };
      }

      case 'face_login':
        return { allowed: limits.face_login_enabled, reason: !limits.face_login_enabled ? 'FaceID login not enabled for your plan' : null };

      case 'voice_control':
        return { allowed: limits.voice_control_enabled, reason: !limits.voice_control_enabled ? 'Voice control not enabled for your plan' : null };

      case 'public_sharing':
        return { allowed: limits.public_sharing_enabled, reason: !limits.public_sharing_enabled ? 'Public sharing not enabled for your plan' : null };

      default:
        return { allowed: false, reason: 'Unknown feature' };
    }
  }

  async checkFaceLimit(userId, cameraId) {
    const limits = await this.getUserEffectiveLimits(userId);
    if (!limits) return { allowed: false, reason: 'User not found' };
    if (!limits.face_recognition_enabled) {
      return { allowed: false, reason: 'Face recognition not enabled for your plan' };
    }

    if (limits.max_faces_per_camera === -1) return { allowed: true };

    const [rows] = await this.pool.execute(
      'SELECT COUNT(*) as count FROM camera_faces WHERE camera_id = ?',
      [cameraId]
    );
    const currentFaces = rows[0].count;

    return {
      allowed: currentFaces < limits.max_faces_per_camera,
      current: currentFaces,
      limit: limits.max_faces_per_camera,
      reason: currentFaces >= limits.max_faces_per_camera ? 'Face limit per camera reached' : null
    };
  }

  async updateLastLogin(userId) {
    await this.pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [userId]);
  }

  async updateUserPlan(userId, planId) {
    await this.pool.execute('UPDATE users SET plan_id = ? WHERE id = ?', [planId, userId]);
    return this.getUserById(userId);
  }

  async updateUserRole(userId, role) {
    if (!['user', 'admin'].includes(role)) {
      return { success: false, error: 'Invalid role' };
    }
    await this.pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
    return { success: true };
  }

  async setUserActive(userId, isActive) {
    await this.pool.execute('UPDATE users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, userId]);
    return { success: true };
  }

  async setUserOverrides(userId, overrides) {
    const [existingRows] = await this.pool.execute(
      'SELECT id FROM user_feature_overrides WHERE user_id = ?',
      [userId]
    );
    const existing = existingRows[0];

    const columns = [
      'max_cameras', 'max_whep_cameras', 'ai_analysis_enabled', 'ai_daily_limit',
      'face_recognition_enabled', 'max_faces_per_camera', 'recording_enabled',
      'max_recording_hours', 'recording_retention_days', 'voice_call_enabled',
      'face_login_enabled', 'voice_control_enabled', 'public_sharing_enabled', 'notes'
    ];

    if (existing) {
      const updates = [];
      const values = [];

      columns.forEach(col => {
        if (overrides.hasOwnProperty(col)) {
          updates.push(`${col} = ?`);
          values.push(overrides[col]);
        }
      });

      if (updates.length > 0) {
        updates.push('updated_at = NOW()');
        values.push(userId);
        await this.pool.execute(
          `UPDATE user_feature_overrides SET ${updates.join(', ')} WHERE user_id = ?`,
          values
        );
      }
    } else {
      const cols = ['user_id'];
      const vals = [userId];
      const placeholders = ['?'];

      columns.forEach(col => {
        if (overrides.hasOwnProperty(col)) {
          cols.push(col);
          vals.push(overrides[col]);
          placeholders.push('?');
        }
      });

      await this.pool.execute(
        `INSERT INTO user_feature_overrides (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
        vals
      );
    }

    return { success: true };
  }

  async clearUserOverrides(userId) {
    await this.pool.execute('DELETE FROM user_feature_overrides WHERE user_id = ?', [userId]);
    return { success: true };
  }

  async getUserOverrides(userId) {
    const [rows] = await this.pool.execute('SELECT * FROM user_feature_overrides WHERE user_id = ?', [userId]);
    return rows[0];
  }

  // ==================== CAMERA SHARING ====================

  async shareCamera(cameraId, ownerUserId, shareWithEmail) {
    if (!(await this.isUserCameraOwner(ownerUserId, cameraId))) {
      return { success: false, error: 'You do not own this camera' };
    }

    const targetUser = await this.getUserByEmail(shareWithEmail);
    if (!targetUser) {
      return { success: false, error: 'User not found' };
    }

    if (targetUser.id === ownerUserId) {
      return { success: false, error: 'Cannot share with yourself' };
    }

    const [existingRows] = await this.pool.execute(
      'SELECT id FROM camera_shares WHERE camera_id = ? AND shared_with_user_id = ?',
      [cameraId, targetUser.id]
    );

    if (existingRows[0]) {
      return { success: false, error: 'Already shared with this user' };
    }

    try {
      await this.pool.execute(
        'INSERT INTO camera_shares (camera_id, shared_with_user_id) VALUES (?, ?)',
        [cameraId, targetUser.id]
      );

      this.invalidateUserAccessCache(targetUser.id);

      return {
        success: true,
        share: {
          camera_id: cameraId,
          shared_with_user_id: targetUser.id,
          shared_with_email: targetUser.email,
          shared_with_name: targetUser.display_name
        }
      };
    } catch (e) {
      return { success: false, error: 'Failed to create share' };
    }
  }

  async getCameraShares(cameraId) {
    const [rows] = await this.pool.execute(`
      SELECT cs.id, cs.camera_id, cs.shared_with_user_id, cs.permission, cs.created_at,
             u.email as shared_with_email, u.display_name as shared_with_name, u.avatar_url as shared_with_avatar
      FROM camera_shares cs
      JOIN users u ON u.id = cs.shared_with_user_id
      WHERE cs.camera_id = ?
      ORDER BY cs.created_at DESC
    `, [cameraId]);
    return rows;
  }

  async removeCameraShare(shareId, ownerUserId) {
    const [shareRows] = await this.pool.execute('SELECT * FROM camera_shares WHERE id = ?', [shareId]);
    const share = shareRows[0];
    if (!share) {
      return { success: false, error: 'Share not found' };
    }

    if (!(await this.isUserCameraOwner(ownerUserId, share.camera_id))) {
      return { success: false, error: 'You do not own this camera' };
    }

    await this.pool.execute('DELETE FROM camera_shares WHERE id = ?', [shareId]);
    this.invalidateUserAccessCache(share.shared_with_user_id);
    return { success: true };
  }

  async getSharedCameras(userId) {
    const [rows] = await this.pool.execute(`
      SELECT c.id, c.device_id, c.name, c.lng, c.lat, c.stream_mode, c.last_seen,
             c.camera_type, c.whep_url, cs.permission, cs.created_at as shared_at,
             owner.email as owner_email, owner.display_name as owner_name
      FROM camera_shares cs
      JOIN cameras c ON c.id = cs.camera_id
      JOIN users owner ON owner.id = c.user_id
      WHERE cs.shared_with_user_id = ?
      ORDER BY cs.created_at DESC
    `, [userId]);
    return rows;
  }

  async hasAccessToCamera(userId, cameraIdOrDeviceId) {
    let camera;
    if (typeof cameraIdOrDeviceId === 'string') {
      camera = await this.getCameraByDeviceId(cameraIdOrDeviceId);
    } else {
      camera = await this.getCameraById(cameraIdOrDeviceId);
    }

    if (!camera) {
      return { hasAccess: false, permission: null };
    }

    const cameraId = camera.id;

    // [PERF] Check cache first
    const cacheKey = `${userId}:${cameraId}`;
    const cached = this.accessCache.get(cacheKey);
    if (cached && Date.now() - cached.time < ACCESS_CACHE_TTL) {
      return cached.result;
    }

    let result;

    if (camera.user_id === userId) {
      result = { hasAccess: true, permission: 'owner' };
    } else {
      const [shareRows] = await this.pool.execute(
        'SELECT permission FROM camera_shares WHERE camera_id = ? AND shared_with_user_id = ?',
        [cameraId, userId]
      );

      if (shareRows[0]) {
        result = { hasAccess: true, permission: shareRows[0].permission };
      } else if (camera.is_public) {
        result = { hasAccess: true, permission: 'public' };
      } else {
        result = { hasAccess: false, permission: null };
      }
    }

    // Evict oldest entries when cache is full
    if (this.accessCache.size >= ACCESS_CACHE_MAX_SIZE) {
      const now = Date.now();
      let oldestKey = null, oldestTime = Infinity;
      for (const [key, entry] of this.accessCache.entries()) {
        if (entry.time < oldestTime) { oldestTime = entry.time; oldestKey = key; }
      }
      if (oldestKey) this.accessCache.delete(oldestKey);
    }
    this.accessCache.set(cacheKey, { result, time: Date.now() });

    return result;
  }

  invalidateAccessCache(cameraId) {
    for (const key of this.accessCache.keys()) {
      if (key.endsWith(`:${cameraId}`)) {
        this.accessCache.delete(key);
      }
    }
  }

  async getUsersWithCameraAccess(deviceId) {
    const camera = await this.getCameraByDeviceId(deviceId);
    if (!camera) return [];

    const [rows] = await this.pool.execute(`
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM cameras WHERE device_id = ?
        UNION
        SELECT shared_with_user_id as user_id FROM camera_shares cs
        JOIN cameras c ON cs.camera_id = c.id WHERE c.device_id = ?
      ) sub WHERE user_id IS NOT NULL
    `, [deviceId, deviceId]);
    return rows.map(r => r.user_id);
  }

  invalidateUserAccessCache(userId) {
    for (const key of this.accessCache.keys()) {
      if (key.startsWith(`${userId}:`)) {
        this.accessCache.delete(key);
      }
    }
  }

  // ==================== ADMIN OPERATIONS ====================

  async getAllUsersPaginated(page = 1, limit = 20, filters = {}) {
    page = Number(page) || 1; limit = Number(limit) || 20;
    const MAX_LIMIT = 100;
    limit = Math.min(Math.max(1, limit), MAX_LIMIT);
    const offset = (page - 1) * limit;

    let whereClause = '1=1';
    const params = [];

    if (filters.plan_id) { whereClause += ' AND u.plan_id = ?'; params.push(filters.plan_id); }
    if (filters.role) { whereClause += ' AND u.role = ?'; params.push(filters.role); }
    if (filters.is_active !== undefined) { whereClause += ' AND u.is_active = ?'; params.push(filters.is_active ? 1 : 0); }
    if (filters.search) {
      whereClause += ' AND (u.email LIKE ? OR u.display_name LIKE ?)';
      const searchTerm = `%${filters.search}%`;
      params.push(searchTerm, searchTerm);
    }

    const [items] = await this.pool.execute(`
      SELECT u.id, u.email, u.display_name, u.avatar_url, u.role, u.plan_id, u.is_active,
             u.last_login, u.created_at, u.notes,
             p.name as plan_name, p.display_name as plan_display_name,
             COALESCE(cc.camera_count, 0) as camera_count
      FROM users u
      LEFT JOIN user_plans p ON p.id = u.plan_id
      LEFT JOIN (SELECT user_id, COUNT(*) as camera_count FROM cameras GROUP BY user_id) cc ON cc.user_id = u.id
      WHERE ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `, params);

    const [countRows] = await this.pool.execute(
      `SELECT COUNT(*) as count FROM users u WHERE ${whereClause}`,
      params
    );
    const total = countRows[0].count;

    return {
      items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total }
    };
  }

  async getUserDetail(userId) {
    const [userRows] = await this.pool.execute(`
      SELECT u.*, p.name as plan_name, p.display_name as plan_display_name
      FROM users u
      LEFT JOIN user_plans p ON p.id = u.plan_id
      WHERE u.id = ?
    `, [userId]);
    const user = userRows[0];

    if (!user) return null;

    const limits = await this.getUserEffectiveLimits(userId);
    const overrides = await this.getUserOverrides(userId);
    const usage = await this.getUserTodayUsage(userId);
    const cameras = await this.getUserCameras(userId);

    return {
      ...user,
      limits,
      overrides,
      usage,
      cameras,
      camera_count: cameras.length
    };
  }

  async updateUserNotes(userId, notes) {
    await this.pool.execute('UPDATE users SET notes = ? WHERE id = ?', [notes, userId]);
    return { success: true };
  }

  async getAdminStats() {
    const [totalUsersRows] = await this.pool.execute('SELECT COUNT(*) as count FROM users');
    const [activeUsersRows] = await this.pool.execute('SELECT COUNT(*) as count FROM users WHERE is_active = 1');
    const [totalCamerasRows] = await this.pool.execute('SELECT COUNT(*) as count FROM cameras');
    const [onlineCamerasRows] = await this.pool.execute(
      'SELECT COUNT(*) as count FROM cameras WHERE last_seen > DATE_SUB(NOW(), INTERVAL 5 MINUTE)'
    );

    const today = new Date().toISOString().split('T')[0];
    const [aiRows] = await this.pool.execute(
      'SELECT SUM(ai_analysis_count) as count FROM user_usage WHERE usage_date = ?',
      [today]
    );

    const [videoCountRows] = await this.pool.execute(
      "SELECT COUNT(*) as count FROM video_messages WHERE media_type = 'video'"
    );
    const [photoCountRows] = await this.pool.execute(
      "SELECT COUNT(*) as count FROM video_messages WHERE media_type = 'photo'"
    );

    const [planDistribution] = await this.pool.execute(`
      SELECT p.name, p.display_name, COUNT(u.id) as user_count
      FROM user_plans p
      LEFT JOIN users u ON u.plan_id = p.id
      GROUP BY p.id
      ORDER BY p.id
    `);

    return {
      total_users: totalUsersRows[0].count,
      active_users: activeUsersRows[0].count,
      total_cameras: totalCamerasRows[0].count,
      online_cameras: onlineCamerasRows[0].count,
      today_ai_queries: aiRows[0].count || 0,
      total_videos: videoCountRows[0].count,
      total_photos: photoCountRows[0].count,
      plan_distribution: planDistribution
    };
  }

  // ==================== PLAN CRUD (Admin) ====================

  async createPlan(planData) {
    try {
      const [result] = await this.pool.execute(`
        INSERT INTO user_plans (
          name, display_name, max_cameras, max_whep_cameras,
          ai_analysis_enabled, ai_daily_limit, face_recognition_enabled,
          max_faces_per_camera, recording_enabled, max_recording_hours,
          recording_retention_days, voice_call_enabled, face_login_enabled,
          voice_control_enabled, public_sharing_enabled, priority_support
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        planData.name, planData.display_name,
        planData.max_cameras ?? 2, planData.max_whep_cameras ?? 1,
        planData.ai_analysis_enabled ? 1 : 0, planData.ai_daily_limit ?? 0,
        planData.face_recognition_enabled ? 1 : 0, planData.max_faces_per_camera ?? 0,
        planData.recording_enabled ? 1 : 0, planData.max_recording_hours ?? 0,
        planData.recording_retention_days ?? 7, planData.voice_call_enabled ? 1 : 0,
        planData.face_login_enabled ? 1 : 0, planData.voice_control_enabled ? 1 : 0,
        planData.public_sharing_enabled ? 1 : 0, planData.priority_support ? 1 : 0
      ]);

      return { success: true, planId: result.insertId };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async updatePlan(planId, planData) {
    const updates = [];
    const values = [];

    const columns = [
      'display_name', 'max_cameras', 'max_whep_cameras',
      'ai_analysis_enabled', 'ai_daily_limit', 'face_recognition_enabled',
      'max_faces_per_camera', 'recording_enabled', 'max_recording_hours',
      'recording_retention_days', 'voice_call_enabled', 'face_login_enabled',
      'voice_control_enabled', 'public_sharing_enabled', 'priority_support'
    ];

    columns.forEach(col => {
      if (planData.hasOwnProperty(col)) {
        updates.push(`${col} = ?`);
        let value = planData[col];
        if (col.endsWith('_enabled') || col === 'priority_support') {
          value = value ? 1 : 0;
        }
        values.push(value);
      }
    });

    if (updates.length === 0) {
      return { success: false, error: 'No fields to update' };
    }

    values.push(planId);

    try {
      await this.pool.execute(`UPDATE user_plans SET ${updates.join(', ')} WHERE id = ?`, values);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async deletePlan(planId) {
    if (planId === 1) {
      return { success: false, error: 'Cannot delete the free plan' };
    }

    const [rows] = await this.pool.execute('SELECT COUNT(*) as count FROM users WHERE plan_id = ?', [planId]);
    if (rows[0].count > 0) {
      return { success: false, error: `Cannot delete plan: ${rows[0].count} users are using it` };
    }

    try {
      await this.pool.execute('DELETE FROM user_plans WHERE id = ?', [planId]);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ==================== CLICKABLE ZONES ====================

  async createClickableZone(cameraId, userId, { name, points, relayOnUrl, relayOffUrl, relayStatusUrl }) {
    const zoneId = 'zone_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);

    try {
      await this.pool.execute(
        'INSERT INTO clickable_zones (id, camera_id, user_id, name, points, relay_on_url, relay_off_url, relay_status_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [zoneId, cameraId, userId, name, JSON.stringify(points), relayOnUrl || null, relayOffUrl || null, relayStatusUrl || null]
      );
      return { success: true, zoneId };
    } catch (error) {
      console.error('[Database] Create clickable zone error:', error);
      return { success: false, error: error.message };
    }
  }

  async getCameraZones(cameraId) {
    const [rows] = await this.pool.execute(
      'SELECT id, camera_id, user_id, name, points, last_state, created_at FROM clickable_zones WHERE camera_id = ? ORDER BY created_at ASC',
      [cameraId]
    );
    return rows;
  }

  async getZoneById(zoneId) {
    const [rows] = await this.pool.execute('SELECT * FROM clickable_zones WHERE id = ?', [zoneId]);
    return rows[0];
  }

  async getZoneByIdSafe(zoneId) {
    const [rows] = await this.pool.execute(
      'SELECT id, camera_id, user_id, name, points, last_state, created_at FROM clickable_zones WHERE id = ?',
      [zoneId]
    );
    return rows[0];
  }

  async updateZoneState(zoneId, newState) {
    await this.pool.execute('UPDATE clickable_zones SET last_state = ? WHERE id = ?', [newState, zoneId]);
  }

  async updateClickableZone(zoneId, userId, { name, points, relayOnUrl, relayOffUrl, relayStatusUrl }) {
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
  }

  async deleteClickableZone(zoneId, userId) {
    const zone = await this.getZoneById(zoneId);
    if (!zone) return { success: false, error: 'Zone not found' };
    if (userId !== null && zone.user_id !== userId) return { success: false, error: 'Not authorized' };

    await this.pool.execute('DELETE FROM clickable_zones WHERE id = ?', [zoneId]);
    return { success: true };
  }

  async isUserZoneOwner(userId, zoneId) {
    const zone = await this.getZoneById(zoneId);
    return zone && zone.user_id === userId;
  }

  // ==================== LIVE BROADCASTS ====================

  async createLiveBroadcast(userId, { broadcastId, displayName, avatarUrl, mediamtxPath, whepUrl, lng, lat, orientation }) {
    await this.pool.execute(
      'INSERT INTO live_broadcasts (broadcast_id, user_id, display_name, avatar_url, mediamtx_path, whep_url, lng, lat, orientation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [broadcastId, userId, displayName, avatarUrl, mediamtxPath, whepUrl, lng, lat, orientation || 'landscape']
    );
  }

  async endLiveBroadcast(broadcastId, userId) {
    await this.pool.execute(
      "UPDATE live_broadcasts SET status = 'ended', ended_at = NOW() WHERE broadcast_id = ? AND user_id = ? AND status = 'active'",
      [broadcastId, userId]
    );
  }

  async getActiveBroadcasts() {
    const [rows] = await this.pool.execute("SELECT * FROM live_broadcasts WHERE status = 'active' ORDER BY started_at DESC");
    return rows;
  }

  async getActiveBroadcastByUser(userId) {
    const [rows] = await this.pool.execute("SELECT * FROM live_broadcasts WHERE user_id = ? AND status = 'active'", [userId]);
    return rows[0];
  }

  async endAllBroadcastsForUser(userId) {
    await this.pool.execute(
      "UPDATE live_broadcasts SET status = 'ended', ended_at = NOW() WHERE user_id = ? AND status = 'active'",
      [userId]
    );
  }

  async cleanupStaleBroadcasts(maxAgeMinutes) {
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
  }

  // ==================== EXTRA METHODS FOR ROUTES (moved from raw SQL) ====================

  async updateCameraLastSeen(cameraId) {
    await this.pool.execute('UPDATE cameras SET last_seen = NOW() WHERE id = ?', [cameraId]);
  }

  async getUserCameraTypeCounts(userId) {
    const [rows] = await this.pool.execute(`
      SELECT COUNT(*) as total,
             COUNT(CASE WHEN camera_type = 'device' THEN 1 END) as device_count,
             COUNT(CASE WHEN camera_type = 'whep' THEN 1 END) as whep_count
      FROM cameras WHERE user_id = ?
    `, [userId]);
    return rows[0];
  }

  async getUserWhepCameraCount(userId) {
    const [rows] = await this.pool.execute(
      "SELECT COUNT(*) as count FROM cameras WHERE user_id = ? AND camera_type = 'whep'",
      [userId]
    );
    return rows[0].count;
  }

  async getPlanUserCounts() {
    const [rows] = await this.pool.execute('SELECT plan_id, COUNT(*) as count FROM users GROUP BY plan_id');
    return rows;
  }

  async getPlanUserCount(planId) {
    const [rows] = await this.pool.execute('SELECT COUNT(*) as count FROM users WHERE plan_id = ?', [planId]);
    return rows[0].count;
  }

  async adminDeleteCamera(cameraId) {
    await this.pool.execute('DELETE FROM cameras WHERE id = ?', [cameraId]);
  }

  async adminUpdateCamera(cameraId, updates, params) {
    await this.pool.execute(`UPDATE cameras SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  async getActiveFaceDetectionCameras(userId) {
    const [rows] = await this.pool.execute(
      'SELECT device_id, name, face_detection_enabled, face_detection_interval FROM cameras WHERE user_id = ? AND face_detection_enabled = 1',
      [userId]
    );
    return rows;
  }

  async getUserFacesWithCameraNames(userId) {
    const [rows] = await this.pool.execute(`
      SELECT cf.id, cf.person_id, cf.name, cf.face_image_url, cf.trigger_alarm, c.name as camera_name
      FROM camera_faces cf
      JOIN cameras c ON cf.camera_id = c.id
      WHERE c.user_id = ?
      ORDER BY cf.name
    `, [userId]);
    return rows;
  }

  async getAlarmCount() {
    const [rows] = await this.pool.execute('SELECT COUNT(*) as count FROM alarms WHERE cleared_at IS NULL');
    return rows[0].count;
  }

  // ==================== VIDEO MESSAGES ====================

  async createVideoMessage(senderId, { messageId, recipientId, lng, lat, filePath, fileSize, durationMs, mimeType, description, mediaType, photoMetadata, placeId }) {
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
  }

  async getVideoMessageById(messageId) {
    const [rows] = await this.pool.execute(
      `SELECT vm.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar,
              COALESCE(vc.view_count, 0) AS view_count,
              gp.display_name AS place_name, gp.formatted_address AS place_address
       FROM video_messages vm
       JOIN users u ON u.id = vm.sender_id
       LEFT JOIN view_counts vc ON vc.entity_type = 'video_message' AND vc.entity_id = vm.message_id
       LEFT JOIN google_places gp ON gp.id = vm.place_id
       WHERE vm.message_id = ?`,
      [messageId]
    );
    const msg = rows[0] || null;
    if (msg) {
      msg.tags = await this.getVideoMessageTags(msg.id);
    }
    return msg;
  }

  async getVideoMessages(userId, { bounds, limit = 50, offset = 0 } = {}) {
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
              gp.display_name AS place_name, gp.formatted_address AS place_address
       FROM video_messages vm
       JOIN users u ON u.id = vm.sender_id
       LEFT JOIN view_counts vc ON vc.entity_type = 'video_message' AND vc.entity_id = vm.message_id
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
      for (const row of rows) {
        row.tags = tagMap.get(row.id) || [];
      }
    }
    return rows;
  }

  async getUnreadVideoMessageCount(userId) {
    const [rows] = await this.pool.execute(
      'SELECT COUNT(*) AS cnt FROM video_messages WHERE recipient_id = ? AND is_read = 0',
      [userId]
    );
    return rows[0].cnt;
  }

  async markVideoMessageRead(messageId, userId) {
    const [result] = await this.pool.execute(
      'UPDATE video_messages SET is_read = 1 WHERE message_id = ? AND recipient_id = ?',
      [messageId, userId]
    );
    return result.affectedRows > 0;
  }

  async deleteVideoMessage(messageId, userId) {
    const msg = await this.getVideoMessageById(messageId);
    if (!msg || msg.sender_id !== userId) return null;
    await this.pool.execute('DELETE FROM video_messages WHERE message_id = ?', [messageId]);
    notifyH3ContentItemRemove(messageId).catch(() => {});
    return msg;
  }

  // ==================== VIDEO MESSAGE TAGS ====================

  async ensureTag(tagName) {
    const trimmed = tagName.trim().substring(0, 100);
    if (!trimmed) return null;
    await this.pool.execute('INSERT IGNORE INTO tags (name) VALUES (?)', [trimmed]);
    const [rows] = await this.pool.execute('SELECT id FROM tags WHERE name = ?', [trimmed]);
    return rows[0]?.id || null;
  }

  async setVideoMessageTags(videoMessageId, tagNames) {
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
  }

  async replaceVideoMessageTags(videoMessageId, tagNames) {
    await this.pool.execute('DELETE FROM video_message_tags WHERE video_message_id = ?', [videoMessageId]);
    if (tagNames && tagNames.length > 0) {
      await this.setVideoMessageTags(videoMessageId, tagNames);
    }
  }

  async getVideoMessageTags(videoMessageId) {
    const [rows] = await this.pool.execute(
      `SELECT t.name FROM tags t
       JOIN video_message_tags vmt ON vmt.tag_id = t.id
       WHERE vmt.video_message_id = ?
       ORDER BY t.name`,
      [videoMessageId]
    );
    return rows.map(r => r.name);
  }

  async searchVideoMessages(query, userId = null, limit = 20, offset = 0) {
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
  }

  async updateVideoMessageThumbnail(messageId, thumbnailPath) {
    await this.pool.execute(
      'UPDATE video_messages SET thumbnail_path = ? WHERE message_id = ?',
      [thumbnailPath, messageId]
    );
  }

  async updateVideoMessageAiDescription(messageId, aiDescription) {
    await this.pool.execute(
      'UPDATE video_messages SET ai_description = ? WHERE message_id = ?',
      [aiDescription, messageId]
    );
  }

  // ==================== ADMIN VIDEO MESSAGES ====================

  async getAdminVideoMessages(page = 1, limit = 20, filters = {}) {
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
  }

  async adminDeleteVideoMessage(messageId) {
    const msg = await this.getVideoMessageById(messageId);
    if (!msg) return null;
    await this.pool.execute('DELETE FROM video_messages WHERE message_id = ?', [messageId]);
    notifyH3ContentItemRemove(messageId).catch(() => {});
    return msg;
  }

  // ==================== VIEW COUNTS (generic) ====================

  async incrementViewCount(entityType, entityId) {
    await this.pool.execute(
      `INSERT INTO view_counts (entity_type, entity_id, view_count)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE view_count = view_count + 1`,
      [entityType, entityId]
    );
  }

  async getViewCount(entityType, entityId) {
    const [rows] = await this.pool.execute(
      'SELECT view_count FROM view_counts WHERE entity_type = ? AND entity_id = ?',
      [entityType, entityId]
    );
    return rows[0]?.view_count || 0;
  }

  // ==================== COMMENTS (generic) ====================

  async createComment(userId, entityType, entityId, content) {
    const [result] = await this.pool.execute(
      'INSERT INTO comments (entity_type, entity_id, user_id, content) VALUES (?, ?, ?, ?)',
      [entityType, entityId, userId, content]
    );
    return this.getCommentById(result.insertId);
  }

  async getCommentById(id) {
    const [rows] = await this.pool.execute(
      `SELECT c.*, u.display_name AS user_name, u.avatar_url AS user_avatar
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.id = ?`,
      [id]
    );
    return rows[0] || null;
  }

  async getComments(entityType, entityId, { limit = 20, before } = {}) {
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
  }

  async getCommentCount(entityType, entityId) {
    const [rows] = await this.pool.execute(
      'SELECT COUNT(*) AS cnt FROM comments WHERE entity_type = ? AND entity_id = ?',
      [entityType, entityId]
    );
    return rows[0].cnt;
  }

  async deleteComment(commentId, userId) {
    const comment = await this.getCommentById(commentId);
    if (!comment || comment.user_id !== userId) return null;
    await this.pool.execute('DELETE FROM comments WHERE id = ?', [commentId]);
    return comment;
  }

  // ==================== GOOGLE PLACES CACHE ====================

  async getPlacesCacheCell(cellLat, cellLng, radius) {
    const [rows] = await this.pool.execute(
      'SELECT id, queried_at FROM places_cache_cells WHERE cell_lat = ? AND cell_lng = ? AND radius_m = ?',
      [cellLat, cellLng, radius]
    );
    return rows[0] || null;
  }

  async getPlacesForCell(cellId) {
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
  }

  async getPlaceById(placeId) {
    const [rows] = await this.pool.execute(
      'SELECT id, google_place_id, display_name, formatted_address, lat, lng, types, icon_url, business_status, rating, user_ratings_total FROM google_places WHERE id = ?',
      [placeId]
    );
    return rows[0] || null;
  }

  async storePlacesCache(cellLat, cellLng, radius, places) {
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
  }

  // ==================== GOOGLE PLACES ADMIN ====================

  async getAllPlaces(page = 1, limit = 20, search = '') {
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
  }

  async updatePlaceIcon(placeId, iconUrl) {
    await this.pool.execute(
      'UPDATE google_places SET icon_url = ? WHERE id = ?',
      [iconUrl, placeId]
    );
  }

  async deletePlace(placeId) {
    // Remove from junction first (cascade should handle this, but be explicit)
    await this.pool.execute('DELETE FROM places_cache_cell_places WHERE place_id = ?', [placeId]);
    // Set null on video_messages
    await this.pool.execute('UPDATE video_messages SET place_id = NULL WHERE place_id = ?', [placeId]);
    // Delete place
    await this.pool.execute('DELETE FROM google_places WHERE id = ?', [placeId]);
  }

  async clearPlacesCache() {
    await this.pool.execute('DELETE FROM places_cache_cell_places');
    await this.pool.execute('DELETE FROM places_cache_cells');
    // Don't delete google_places that are referenced by video_messages
    await this.pool.execute(
      'DELETE FROM google_places WHERE id NOT IN (SELECT DISTINCT place_id FROM video_messages WHERE place_id IS NOT NULL)'
    );
  }

  async getPlacesStats() {
    const [[{ totalPlaces }]] = await this.pool.execute('SELECT COUNT(*) AS totalPlaces FROM google_places');
    const [[{ totalCells }]] = await this.pool.execute('SELECT COUNT(*) AS totalCells FROM places_cache_cells');
    const [[{ taggedMessages }]] = await this.pool.execute('SELECT COUNT(*) AS taggedMessages FROM video_messages WHERE place_id IS NOT NULL');
    return { totalPlaces, totalCells, taggedMessages };
  }

  async searchUsersByName(query, limit = 10) {
    const safeLimit = Math.min(parseInt(limit) || 10, 20);
    const [rows] = await this.pool.execute(
      `SELECT id, display_name, email, avatar_url FROM users
       WHERE is_active = 1 AND (display_name LIKE ? OR email LIKE ?)
       ORDER BY display_name
       LIMIT ${safeLimit}`,
      [`%${query}%`, `%${query}%`]
    );
    return rows;
  }

  async getUserRecentMessages(userId, limit = 5) {
    const safeLimit = Math.min(Math.max(parseInt(limit) || 5, 1), 20);
    const [rows] = await this.pool.execute(
      `SELECT message_id, media_type, thumbnail_path, description, duration_ms, created_at
       FROM video_messages
       WHERE sender_id = ?
       ORDER BY created_at DESC
       LIMIT ${safeLimit}`,
      [userId]
    );
    return rows;
  }

  async getSharedCameraCount(userId) {
    const [rows] = await this.pool.execute(
      'SELECT COUNT(*) as count FROM camera_shares WHERE shared_with_user_id = ?',
      [userId]
    );
    return rows[0].count;
  }

  async getUserMessageCount(userId) {
    const [rows] = await this.pool.execute(
      'SELECT COUNT(*) as count FROM video_messages WHERE sender_id = ?',
      [userId]
    );
    return rows[0].count;
  }
}

module.exports = new DatabaseService();
