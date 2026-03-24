const pool = require('../db-pool');
const settingsCache = require('../settings-cache');

// [PERF] Access cache configuration
const ACCESS_CACHE_TTL = 60000; // 1 minute cache
const ACCESS_CACHE_MAX_SIZE = 5000; // Max entries

class DatabaseService {
  constructor() {
    this.pool = pool;

    // [PERF] Camera access cache: Map<"userId:cameraId" -> { result, time }>
    this.accessCache = new Map();

    // Periodic cleanup of expired access cache entries (every 5 minutes)
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
    await this.seedUserPlans();
    await this.seedOnvifTemplates();
    await this.seedSystemSettings();
    await this.setAdminUser();
    console.log('Database initialized successfully');
  }

  // System settings
  async seedSystemSettings() {
    const [rows] = await this.pool.execute('SELECT COUNT(*) as count FROM system_settings');
    if (rows[0].count === 0) {
      const defaults = [
        ['ai_service_url', 'http://92.44.163.139:8001'],
        ['ai_vision_model', 'Qwen/Qwen3-VL-8B-Instruct-FP8'],
        ['ai_max_tokens', '1024'],
        ['ai_temperature', '0.7']
      ];
      for (const [key, value] of defaults) {
        await this.pool.execute('INSERT IGNORE INTO system_settings (`key`, `value`) VALUES (?, ?)', [key, value]);
      }
    }
  }

  async getSystemSetting(key) {
    const [rows] = await this.pool.execute('SELECT `value` FROM system_settings WHERE `key` = ?', [key]);
    return rows[0]?.value || null;
  }

  async setSystemSetting(key, value) {
    await this.pool.execute(
      'INSERT INTO system_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = NOW()',
      [key, value]
    );
  }

  async getAllSystemSettings() {
    const [rows] = await this.pool.execute('SELECT `key`, `value` FROM system_settings ORDER BY `key`');
    return rows;
  }

  // Recording state
  async startRecording(cameraId, pathName, userId, maxDurationMs = 3600000) {
    await this.pool.execute(
      'INSERT INTO active_recordings (camera_id, path_name, user_id, max_duration_ms) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE path_name = VALUES(path_name), user_id = VALUES(user_id), max_duration_ms = VALUES(max_duration_ms), started_at = NOW()',
      [cameraId, pathName, userId, maxDurationMs]
    );
  }

  async stopRecording(cameraId) {
    await this.pool.execute('DELETE FROM active_recordings WHERE camera_id = ?', [cameraId]);
  }

  async getActiveRecording(cameraId) {
    const [rows] = await this.pool.execute('SELECT * FROM active_recordings WHERE camera_id = ?', [cameraId]);
    return rows[0] || null;
  }

  async getAllActiveRecordings() {
    const [rows] = await this.pool.execute('SELECT * FROM active_recordings');
    return rows;
  }

  async clearAllActiveRecordings() {
    await this.pool.execute('DELETE FROM active_recordings');
  }
}

// Extend prototype with domain-specific methods
require('./cameras')(DatabaseService);
require('./users')(DatabaseService);
require('./monitoring')(DatabaseService);
require('./video-messages')(DatabaseService);
require('./onvif')(DatabaseService);
require('./admin')(DatabaseService);
require('./sharing')(DatabaseService);
require('./content')(DatabaseService);
require('./ai-jobs')(DatabaseService);

module.exports = new DatabaseService();
