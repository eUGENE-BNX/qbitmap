/**
 * Camera Settings Cache Service
 * In-memory cache for camera settings to reduce database queries
 * TTL: 5 minutes, auto-invalidated on update
 */

class SettingsCache {
  constructor() {
    this.cache = new Map();
    this.TTL = 5 * 60 * 1000; // 5 minutes

    // Periodic cleanup of expired entries to prevent memory leak
    setInterval(() => {
      this.cleanupExpired();
    }, 5 * 60 * 1000); // Clean every 5 minutes
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
      console.log(`[Settings Cache] Cleaned up ${cleanedCount} expired entries`);
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
}

// Singleton instance
const settingsCache = new SettingsCache();

module.exports = settingsCache;
