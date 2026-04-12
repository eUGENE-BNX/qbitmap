/**
 * Camera Settings Cache Service
 * In-memory cache for camera settings to reduce database queries
 * TTL: 5 minutes, auto-invalidated on update
 */

const logger = require('../utils/logger').child({ module: 'settings-cache' });

class SettingsCache {
  constructor() {
    this.cache = new Map();
    this.TTL = 5 * 60 * 1000; // 5 minutes

    // [PERF-18] Store interval ID so shutdown() can clear it.
    this._cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 5 * 60 * 1000);
  }

  /**
   * Remove expired entries from cache to prevent memory leak
   */
  cleanupExpired() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [cameraId, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.TTL) {
        this.cache.delete(cameraId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info({ cleanedCount }, 'Cleaned up expired entries');
    }
  }

  /**
   * Get cached settings for a camera
   * @param {number} cameraId - Camera ID
   * @returns {object|null} - Cached settings or null if not cached/expired
   */
  get(cameraId) {
    const entry = this.cache.get(cameraId);
    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp > this.TTL) {
      this.cache.delete(cameraId);
      return null;
    }

    return entry.data;
  }

  /**
   * Set cached settings for a camera
   * @param {number} cameraId - Camera ID
   * @param {object} settings - Settings data from database
   */
  set(cameraId, settings) {
    this.cache.set(cameraId, {
      data: settings,
      timestamp: Date.now()
    });
  }

  /**
   * Invalidate cache for a camera (call after update)
   * @param {number} cameraId - Camera ID
   */
  invalidate(cameraId) {
    this.cache.delete(cameraId);
  }

  /**
   * Clear all cached settings
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   * @returns {object} - Cache stats
   */
  getStats() {
    return {
      size: this.cache.size,
      ttl: this.TTL
    };
  }

  /**
   * [PERF-18] Stop the cleanup interval. Call on process shutdown or
   * test teardown to prevent the timer from keeping the process alive.
   */
  shutdown() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this.cache.clear();
  }
}

// Singleton instance
const settingsCache = new SettingsCache();

module.exports = settingsCache;
