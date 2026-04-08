const config = require('./config');

// Hard caps to keep heap bounded under long uptime / many cameras.
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000; // 24h absolute TTL
const MAX_TOTAL_EVENTS = 5000;                // global cap, LRU-evict cameras

class EventStore {
  constructor() {
    // Map<cameraId, Event[]>  — Map iteration order = insertion order,
    // and we re-insert on add() so the oldest-touched camera is the LRU head.
    this.events = new Map();

    // Periodic absolute-age sweep.
    this._sweepTimer = setInterval(() => this._sweep(), 10 * 60 * 1000).unref();
  }

  /**
   * Add event for a camera
   */
  add(cameraId, event) {
    let cameraEvents = this.events.get(cameraId);
    if (!cameraEvents) {
      cameraEvents = [];
    } else {
      // Re-insert to move this camera to the MRU end of the Map.
      this.events.delete(cameraId);
    }
    this.events.set(cameraId, cameraEvents);

    // Add new event at the beginning
    cameraEvents.unshift({
      id: `${cameraId}-${Date.now()}`,
      cameraId,
      type: event.type || 'motion',
      state: event.state,
      data: event.data || {},
      timestamp: new Date().toISOString()
    });

    // Keep only last N events per camera
    if (cameraEvents.length > config.events.maxPerCamera) {
      cameraEvents.length = config.events.maxPerCamera;
    }

    // Global cap: drop the LRU camera (oldest in Map iteration order)
    // until total events fit. Cheap because Map keys are insertion-ordered.
    let total = this._countTotal();
    while (total > MAX_TOTAL_EVENTS) {
      const oldestKey = this.events.keys().next().value;
      if (oldestKey === undefined || oldestKey === cameraId) break;
      const dropped = this.events.get(oldestKey).length;
      this.events.delete(oldestKey);
      total -= dropped;
    }
  }

  _countTotal() {
    let n = 0;
    for (const arr of this.events.values()) n += arr.length;
    return n;
  }

  _sweep() {
    const cutoff = Date.now() - MAX_EVENT_AGE_MS;
    for (const [cameraId, arr] of this.events) {
      const kept = arr.filter(e => new Date(e.timestamp).getTime() >= cutoff);
      if (kept.length === 0) {
        this.events.delete(cameraId);
      } else if (kept.length !== arr.length) {
        this.events.set(cameraId, kept);
      }
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
