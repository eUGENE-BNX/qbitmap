/**
 * In-memory frame cache for fast serving
 * Reduces DB I/O for real-time streaming
 * [CC-010] Added TTL-based cleanup to prevent memory leaks
 */

class FrameCache {
  constructor() {
    // Map<cameraId, {frameData: Buffer, capturedAt: Date, size: number, expiresAt: number}>
    this.cache = new Map();
    this.TTL = 5000; // 5 seconds TTL (reduced from 30s - only keep latest frame)
    this.MAX_FRAMES = 500; // Hard limit to prevent memory issues

    // Start cleanup interval (every 2 seconds for faster cleanup)
    this.cleanupInterval = setInterval(() => this.cleanup(), 2000);
  }

  /**
   * Store frame in memory cache with TTL
   */
  set(cameraId, frameData, capturedAt = new Date()) {
    // Enforce max size limit
    if (this.cache.size >= this.MAX_FRAMES && !this.cache.has(cameraId)) {
      // Remove oldest entry
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(cameraId, {
      frameData: frameData,
      capturedAt: capturedAt,
      size: frameData.length,
      expiresAt: Date.now() + this.TTL
    });
  }

  /**
   * Get frame from memory cache
   * Returns null if not found or expired
   */
  get(cameraId) {
    const frame = this.cache.get(cameraId);
    if (!frame) return null;

    // Check if expired
    if (Date.now() > frame.expiresAt) {
      this.cache.delete(cameraId);
      return null;
    }

    return frame;
  }

  /**
   * Check if camera has valid (non-expired) cached frame
   */
  has(cameraId) {
    const frame = this.cache.get(cameraId);
    if (!frame) return false;

    if (Date.now() > frame.expiresAt) {
      this.cache.delete(cameraId);
      return false;
    }

    return true;
  }

  /**
   * Clear cache for specific camera
   */
  clear(cameraId) {
    this.cache.delete(cameraId);
  }

  /**
   * Cleanup expired frames (called periodically)
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;

    for (const [cameraId, frame] of this.cache.entries()) {
      if (now > frame.expiresAt) {
        this.cache.delete(cameraId);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[FrameCache] Cleaned up ${removed} expired frames`);
    }
  }

  /**
   * Get cache stats
   */
  getStats() {
    return {
      cached_cameras: this.cache.size,
      total_bytes: Array.from(this.cache.values()).reduce((sum, f) => sum + f.size, 0),
      ttl_seconds: this.TTL / 1000
    };
  }

  /**
   * Shutdown cleanup (for graceful shutdown)
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Singleton instance
const frameCache = new FrameCache();

module.exports = frameCache;
