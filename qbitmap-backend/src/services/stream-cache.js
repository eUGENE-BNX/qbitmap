/**
 * Stream Cache Service
 * Ultra-fast in-memory cache for MJPEG streaming frames
 * Optimized for high-frequency updates (10-15 FPS per camera)
 */

class StreamCache {
  constructor() {
    // Map<cameraId, { buffer: Buffer, timestamp: Date, size: number }>
    this.frames = new Map();

    // Map<cameraId, Set<responseObject>> - active MJPEG clients
    this.clients = new Map();

    // Stream timeout - remove inactive streams after 30 seconds
    this.streamTimeoutMs = 30000;

    // Start periodic cleanup (every 60 seconds)
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleData();
    }, 60000);
  }

  /**
   * Cleanup stale frames and disconnected clients
   */
  cleanupStaleData() {
    const now = Date.now();
    let cleanedFrames = 0;
    let cleanedClients = 0;

    // Clean up stale frames
    for (const [cameraId, entry] of this.frames.entries()) {
      const age = now - entry.timestamp.getTime();
      if (age > this.streamTimeoutMs) {
        this.frames.delete(cameraId);
        cleanedFrames++;
      }
    }

    // Clean up disconnected clients
    for (const [cameraId, clientSet] of this.clients.entries()) {
      for (const response of clientSet) {
        try {
          // Check if response is still writable
          if (!response.raw || response.raw.destroyed || response.raw.writableEnded) {
            clientSet.delete(response);
            cleanedClients++;
          }
        } catch (err) {
          clientSet.delete(response);
          cleanedClients++;
        }
      }
      // Remove empty Sets
      if (clientSet.size === 0) {
        this.clients.delete(cameraId);
      }
    }

    if (cleanedFrames > 0 || cleanedClients > 0) {
      console.log(`[STREAM] Cleanup: ${cleanedFrames} stale frames, ${cleanedClients} disconnected clients`);
    }
  }

  /**
   * Store a stream frame
   * @param {number} cameraId - Camera ID
   * @param {Buffer} frameData - JPEG frame data
   */
  set(cameraId, frameData) {
    const entry = {
      buffer: frameData,
      timestamp: new Date(),
      size: frameData.length
    };

    this.frames.set(cameraId, entry);

    // Notify all waiting clients
    this.notifyClients(cameraId, frameData);
  }

  /**
   * Get latest stream frame
   * @param {number} cameraId - Camera ID
   * @returns {{ buffer: Buffer, timestamp: Date, size: number } | null}
   */
  get(cameraId) {
    const entry = this.frames.get(cameraId);
    if (!entry) return null;

    // Check if frame is too old (stream might have stopped)
    const age = Date.now() - entry.timestamp.getTime();
    if (age > this.streamTimeoutMs) {
      this.frames.delete(cameraId);
      return null;
    }

    return entry;
  }

  /**
   * Check if camera has active stream
   * @param {number} cameraId - Camera ID
   * @returns {boolean}
   */
  hasActiveStream(cameraId) {
    const entry = this.frames.get(cameraId);
    if (!entry) return false;

    const age = Date.now() - entry.timestamp.getTime();
    return age < this.streamTimeoutMs;
  }

  /**
   * Register a client for MJPEG streaming
   * @param {number} cameraId - Camera ID
   * @param {object} response - Fastify response object
   */
  addClient(cameraId, response) {
    if (!this.clients.has(cameraId)) {
      this.clients.set(cameraId, new Set());
    }
    this.clients.get(cameraId).add(response);

    const count = this.clients.get(cameraId).size;
    console.log(`[STREAM] Client added for camera ${cameraId}, total: ${count}`);
  }

  /**
   * Remove a client from MJPEG streaming
   * @param {number} cameraId - Camera ID
   * @param {object} response - Fastify response object
   */
  removeClient(cameraId, response) {
    const clients = this.clients.get(cameraId);
    if (clients) {
      clients.delete(response);
      const count = clients.size;
      console.log(`[STREAM] Client removed from camera ${cameraId}, remaining: ${count}`);

      if (count === 0) {
        this.clients.delete(cameraId);
      }
    }
  }

  /**
   * Get number of connected clients for a camera
   * @param {number} cameraId - Camera ID
   * @returns {number}
   */
  getClientCount(cameraId) {
    const clients = this.clients.get(cameraId);
    return clients ? clients.size : 0;
  }

  /**
   * Notify all clients of a new frame
   * @param {number} cameraId - Camera ID
   * @param {Buffer} frameData - JPEG frame data
   */
  notifyClients(cameraId, frameData) {
    const clients = this.clients.get(cameraId);
    if (!clients || clients.size === 0) return;

    const boundary = '--frame\r\n';
    const header = `Content-Type: image/jpeg\r\nContent-Length: ${frameData.length}\r\n\r\n`;
    const disconnected = [];

    for (const response of clients) {
      try {
        // Check if response is still writable before attempting to write
        if (!response.raw || response.raw.destroyed || response.raw.writableEnded) {
          disconnected.push(response);
          continue;
        }
        response.raw.write(boundary);
        response.raw.write(header);
        response.raw.write(frameData);
        response.raw.write('\r\n');
      } catch (err) {
        // Client disconnected
        disconnected.push(response);
      }
    }

    // Remove disconnected clients after iteration (avoid modifying Set during iteration)
    for (const response of disconnected) {
      this.removeClient(cameraId, response);
    }
  }

  /**
   * Clear all data for a camera
   * @param {number} cameraId - Camera ID
   */
  clear(cameraId) {
    this.frames.delete(cameraId);

    // Close all client connections
    const clients = this.clients.get(cameraId);
    if (clients) {
      for (const response of clients) {
        try {
          response.raw.end();
        } catch (err) {
          // Ignore errors
        }
      }
      this.clients.delete(cameraId);
    }
  }

  /**
   * Get statistics
   * @returns {{ activeCameras: number, totalClients: number }}
   */
  getStats() {
    let totalClients = 0;
    for (const clients of this.clients.values()) {
      totalClients += clients.size;
    }

    return {
      activeCameras: this.frames.size,
      totalClients
    };
  }
}

// Singleton instance
const streamCache = new StreamCache();

module.exports = streamCache;
