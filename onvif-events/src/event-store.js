const config = require('./config');

class EventStore {
  constructor() {
    // Map<cameraId, Event[]>
    this.events = new Map();
  }

  /**
   * Add event for a camera
   */
  add(cameraId, event) {
    if (!this.events.has(cameraId)) {
      this.events.set(cameraId, []);
    }

    const cameraEvents = this.events.get(cameraId);

    // Add new event at the beginning
    cameraEvents.unshift({
      id: `${cameraId}-${Date.now()}`,
      cameraId,
      type: event.type || 'motion',
      state: event.state,
      data: event.data || {},
      timestamp: new Date().toISOString()
    });

    // Keep only last N events
    if (cameraEvents.length > config.events.maxPerCamera) {
      cameraEvents.pop();
    }
  }

  /**
   * Get events for a specific camera
   */
  getByCamera(cameraId) {
    return this.events.get(cameraId) || [];
  }

  /**
   * Get latest event for a camera
   */
  getLatest(cameraId) {
    const events = this.events.get(cameraId);
    return events && events.length > 0 ? events[0] : null;
  }

  /**
   * Get all events from all cameras
   */
  getAll() {
    const allEvents = [];
    for (const [cameraId, events] of this.events) {
      allEvents.push(...events);
    }
    // Sort by timestamp descending
    return allEvents.sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    );
  }

  /**
   * Clear events for a camera
   */
  clear(cameraId) {
    this.events.delete(cameraId);
  }

  /**
   * Get stats
   */
  getStats() {
    let totalEvents = 0;
    for (const events of this.events.values()) {
      totalEvents += events.length;
    }
    return {
      cameras: this.events.size,
      totalEvents
    };
  }
}

module.exports = new EventStore();
