/**
 * In-memory frame storage
 * Stores the latest captured frame for each stream
 */

class FrameStore {
  constructor() {
    // Map<streamId, { buffer, capturedAt, size }>
    this.frames = new Map();
  }

  /**
   * Store a frame for a stream
   */
  set(streamId, buffer) {
    this.frames.set(streamId, {
      buffer,
      capturedAt: new Date(),
      size: buffer.length
    });
  }

  /**
   * Get frame for a stream
   */
  get(streamId) {
    return this.frames.get(streamId) || null;
  }

  /**
   * Get frame as base64
   */
  getBase64(streamId) {
    const frame = this.frames.get(streamId);
    if (!frame) return null;

    return {
      base64: frame.buffer.toString('base64'),
      capturedAt: frame.capturedAt,
      size: frame.size
    };
  }

  /**
   * Check if stream has a frame
   */
  has(streamId) {
    return this.frames.has(streamId);
  }

  /**
   * Remove frame for a stream
   */
  remove(streamId) {
    this.frames.delete(streamId);
  }

  /**
   * Get all stream IDs with frames
   */
  getStreamIds() {
    return Array.from(this.frames.keys());
  }
}

module.exports = new FrameStore();
