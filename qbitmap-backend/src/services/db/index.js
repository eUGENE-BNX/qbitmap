const pool = require('../db-pool');
const settingsCache = require('../settings-cache');
const logger = require('../../utils/logger').child({ module: 'db' });
const { services } = require('../../config');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');

// [PERF] Access cache configuration
const ACCESS_CACHE_TTL = 60000; // 1 minute cache
const ACCESS_CACHE_MAX_SIZE = 5000; // Max entries

class DatabaseService {
  constructor() {
    this.pool = pool;

    // [PERF] Camera access cache: Map<"userId:cameraId" -> { result, time }>
    this.accessCache = new Map();
    // [PERF-10] Reverse indexes for O(K) invalidation instead of O(N) scan.
    // K = entries for that camera/user, N = total cache size (up to 5000).
    this._cameraAccessKeys = new Map(); // cameraId → Set<cacheKey>
    this._userAccessKeys = new Map();   // userId → Set<cacheKey>

    // Periodic cleanup of expired access cache entries (every 5 minutes).
    // .unref() so this maintenance timer alone can't keep the event loop
    // alive on SIGTERM — explicit clearInterval in index.js shutdown still
    // runs, this is belt-and-suspenders for abnormal exits.
    this.accessCacheCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.accessCache.entries()) {
        if (now - entry.time > ACCESS_CACHE_TTL) {
          this._removeAccessCacheKey(key);
        }
      }
    }, 5 * 60 * 1000);
    this.accessCacheCleanupInterval.unref();

    this._ready = this._initialize();
  }

  // [PERF-10] Access cache key management — keeps reverse indexes in sync.
  _addAccessCacheKey(key, userId, cameraId) {
    if (!this._cameraAccessKeys.has(cameraId)) this._cameraAccessKeys.set(cameraId, new Set());
    this._cameraAccessKeys.get(cameraId).add(key);
    if (!this._userAccessKeys.has(userId)) this._userAccessKeys.set(userId, new Set());
    this._userAccessKeys.get(userId).add(key);
  }

  _removeAccessCacheKey(key) {
    this.accessCache.delete(key);
    const [userId, cameraId] = key.split(':');
    const camSet = this._cameraAccessKeys.get(cameraId);
    if (camSet) { camSet.delete(key); if (camSet.size === 0) this._cameraAccessKeys.delete(cameraId); }
    const userSet = this._userAccessKeys.get(userId);
    if (userSet) { userSet.delete(key); if (userSet.size === 0) this._userAccessKeys.delete(userId); }
  }

  async ensureReady() {
    await this._ready;
  }

  async _initialize() {
    await this._runMigrations();
    await this._migrateEncryptionKey();
    await this.seedUserPlans();
    await this.seedOnvifTemplates();
    await this.seedSystemSettings();
    await this.setAdminUser();
    logger.info('Database initialized successfully');
  }

  // [SEC-12] One-time re-encryption of Tesla tokens from SHA-256 key
  // derivation to raw base64-decoded key. Idempotent — tokens already
  // encrypted with the new key are silently skipped.
  async _migrateEncryptionKey() {
    try {
      // Check if tesla_accounts table exists
      const [tables] = await this.pool.execute(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'tesla_tokens' LIMIT 1"
      );
      if (tables.length === 0) return; // No Tesla integration yet

      const { reEncryptAllTokens } = require('../../utils/encryption');
      const result = await reEncryptAllTokens(this.pool);

      if (result.migrated > 0) {
        logger.info({ migrated: result.migrated, skipped: result.skipped, errors: result.errors }, 'Tesla tokens re-encrypted (SEC-12)');
      }
    } catch (e) {
      // Non-fatal: if the encryption key isn't set (no Tesla configured),
      // or the table doesn't have the expected columns, just log and move on.
      if (e.message?.includes('TESLA_ENCRYPTION_KEY')) {
        logger.info('Tesla encryption key not configured, skipping token migration');
      } else {
        logger.warn({ err: e.message }, 'Tesla token migration skipped (non-fatal)');
      }
    }
  }

  // [ARCH-06] Lightweight migration runner.
  //
  // Reads .sql files from migrations/ sorted by filename (date-prefixed),
  // tracks applied migrations in a `schema_migrations` table, and applies
  // any that haven't been recorded yet. Each file is split on semicolons
  // and each statement is executed individually.
  //
  // Error handling:
  //   - MySQL 1060 (duplicate column) and 1061 (duplicate key/index) are
  //     treated as "already applied" — the migration is recorded and the
  //     runner moves on. This handles the common case where a migration
  //     was applied manually before the runner existed.
  //   - Any other error aborts the boot. Partial schema is worse than
  //     refusing to start.
  //
  // Checksums are recorded for audit but not enforced — modifying a
  // migration file after it's been applied doesn't trigger a re-run.
  async _runMigrations() {
    // Ensure tracking table exists
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        checksum VARCHAR(64)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Read migration files
    if (!fs.existsSync(MIGRATIONS_DIR)) return;
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();
    if (files.length === 0) return;

    // Which migrations are already applied?
    const [applied] = await this.pool.execute('SELECT name FROM schema_migrations');
    const appliedSet = new Set(applied.map(r => r.name));

    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);

      // Split on semicolons, strip comment lines within each chunk, drop empties.
      // A chunk like "-- comment\nALTER TABLE..." must keep the ALTER after
      // stripping the comment lines — the original filter dropped the whole
      // chunk if it started with '--'.
      const statements = sql
        .split(';')
        .map(s => s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim())
        .filter(s => s.length > 0);

      try {
        for (const stmt of statements) {
          await this.pool.execute(stmt);
        }
        await this.pool.execute(
          'INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)',
          [file, checksum]
        );
        logger.info({ migration: file }, 'Migration applied successfully');
      } catch (err) {
        // Idempotent DDL errors: the change is already in place.
        // 1060 duplicate column, 1061 duplicate key,
        // 1826 duplicate foreign key name, 1091 can't drop (already gone).
        if (err.errno === 1060 || err.errno === 1061 || err.errno === 1826 || err.errno === 1091) {
          await this.pool.execute(
            'INSERT IGNORE INTO schema_migrations (name, checksum) VALUES (?, ?)',
            [file, checksum]
          );
          logger.info({ migration: file, errno: err.errno }, 'Migration already applied (schema matches), recorded');
        } else {
          logger.error({ migration: file, err: err.message, errno: err.errno }, 'Migration failed — aborting startup');
          throw err;
        }
      }
    }
  }

  // System settings
  async seedSystemSettings() {
    const [rows] = await this.pool.execute('SELECT COUNT(*) as count FROM system_settings');
    if (rows[0].count === 0) {
      const defaults = [
        ['ai_service_url', services.aiServiceUrl],
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
require('./reports')(DatabaseService);
require('./tesla')(DatabaseService);

module.exports = new DatabaseService();
