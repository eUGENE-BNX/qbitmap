const { Cam } = require('onvif');
const fs = require('fs');
const path = require('path');
const eventStore = require('./event-store');
const config = require('./config');
const { encrypt, decrypt, isEncrypted } = require('./crypto');

// Credential file path is overridable via env so the production file can live
// outside the deploy tree (e.g. /etc/qbitmap/cameras.json). Keeping it inside
// the repo root makes it a casualty of any future rsync --delete that forgets
// to exclude it (same class of incident as the tesla *.pem wipe) and a one-
// .gitignore-line-away-from-being-committed risk. Default preserves current
// behavior so existing deploys keep working until the operator moves the file
// and sets CAMERAS_CONFIG_PATH.
const DEFAULT_CAMERAS_FILE = path.join(__dirname, '..', 'cameras.json');
const CAMERAS_FILE = process.env.CAMERAS_CONFIG_PATH || DEFAULT_CAMERAS_FILE;
if (!process.env.CAMERAS_CONFIG_PATH) {
  console.warn(`[ONVIF] CAMERAS_CONFIG_PATH not set; using ${DEFAULT_CAMERAS_FILE}. In production, move this file outside the deploy tree and set CAMERAS_CONFIG_PATH.`);
} else {
  console.log(`[ONVIF] Using credentials file: ${CAMERAS_FILE}`);
}
const EVENT_DEBOUNCE_MS = 3000; // 3 seconds debounce per event type per camera

class CameraManager {
  constructor() {
    // Map<cameraId, { config, cam, connected }>
    this.cameras = new Map();
    // Map<"cameraId:eventType", lastEventTime> for debouncing
    this.lastEventTimes = new Map();
  }

  /**
   * Load cameras from persistent storage and connect those with credentials
   */
  async loadFromFile() {
    try {
      if (fs.existsSync(CAMERAS_FILE)) {
        const data = fs.readFileSync(CAMERAS_FILE, 'utf8');
        const cameras = JSON.parse(data);
        console.log(`[ONVIF] Loading ${cameras.length} cameras from file...`);

        let needsResave = false;
        for (const cam of cameras) {
          if (!this.cameras.has(cam.id)) {
            // Decrypt password from disk; legacy plaintext is accepted then
            // re-saved encrypted at the end of this load.
            let plainPassword = cam.password;
            try {
              if (isEncrypted(cam.password)) {
                plainPassword = decrypt(cam.password);
              } else if (cam.password) {
                needsResave = true; // legacy plaintext, upgrade on next save
              }
            } catch (e) {
              console.error(`[ONVIF] Failed to decrypt credentials for ${cam.id}:`, e.message);
              continue;
            }

            this.cameras.set(cam.id, {
              config: { id: cam.id, name: cam.name, host: cam.host, port: cam.port, username: cam.username, password: plainPassword },
              cam: null,
              connected: false,
              connecting: false
            });

            if (cam.username && plainPassword) {
              // Connect in background — don't block startup
              this.connect(cam.id).catch(err => {
                console.error(`[ONVIF] Failed to load camera ${cam.id}:`, err.message);
              });
            } else {
              console.log(`[ONVIF] Loaded stub for ${cam.id} (${cam.host}:${cam.port}) — no credentials`);
            }
          }
        }
        if (needsResave) {
          console.log('[ONVIF] Upgrading legacy plaintext credentials to encrypted format');
          this.saveToFile();
        }
      } else {
        console.log('[ONVIF] No cameras.json found, starting with empty list');
      }
    } catch (err) {
      console.error('[ONVIF] Failed to load cameras from file:', err.message);
    }
  }

  /**
   * Save cameras to persistent storage (with credentials for reconnect on restart)
   */
  saveToFile() {
    try {
      const cameras = [];
      for (const [id, camera] of this.cameras) {
        const c = { ...camera.config };
        // Encrypt password at rest. In-memory config keeps the plaintext
        // because the ONVIF client needs it on every reconnect.
        if (c.password) {
          c.password = encrypt(c.password);
        }
        cameras.push(c);
      }
      // Restrictive perms — credentials file must not be world-readable.
      fs.writeFileSync(CAMERAS_FILE, JSON.stringify(cameras, null, 2), { mode: 0o600 });
      try { fs.chmodSync(CAMERAS_FILE, 0o600); } catch (_) {}
      console.log(`[ONVIF] Saved ${cameras.length} cameras to file (encrypted)`);
    } catch (err) {
      console.error('[ONVIF] Failed to save cameras to file:', err.message);
    }
  }

  /**
   * Add a new camera
   * @param {Object} cameraConfig - Camera configuration
   * @param {boolean} persist - Whether to save to file (default: true)
   */
  async add(cameraConfig, persist = true) {
    const { id, name, host, port, username, password } = cameraConfig;

    if (this.cameras.has(id)) {
      throw new Error(`Camera ${id} already exists`);
    }

    const camera = {
      config: { id, name, host, port, username, password },
      cam: null,
      connected: false,
      connecting: false
    };

    this.cameras.set(id, camera);

    // Save to file if persist is true
    if (persist) {
      this.saveToFile();
    }

    // Try to connect
    await this.connect(id);

    return this.getInfo(id);
  }

  /**
   * Connect to camera and subscribe to events
   */
  async connect(cameraId) {
    const camera = this.cameras.get(cameraId);
    if (!camera) {
      throw new Error(`Camera ${cameraId} not found`);
    }

    if (camera.connecting) {
      return;
    }

    const { host, port, username, password } = camera.config;
    if (!username || !password) {
      throw new Error(`Camera ${cameraId} has no credentials — supply via API`);
    }

    camera.connecting = true;

    const connectPromise = new Promise((resolve, reject) => {
      console.log(`[ONVIF] Connecting to ${cameraId} at ${host}:${port}...`);

      const cam = new Cam({
        hostname: host,
        port: port,
        username: username,
        password: password,
        timeout: 30000,
        preserveAddress: true  // Keep original address for WAN connections
      }, (err) => {
        if (err) {
          camera.connected = false;
          reject(err);
          return;
        }

        console.log(`[ONVIF] Connected to ${cameraId}`);
        camera.cam = cam;
        camera.connected = true;

        // Subscribe to events
        this.subscribeToEvents(cameraId);

        resolve();
      });
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout (45s)')), 45000)
    );

    try {
      await Promise.race([connectPromise, timeoutPromise]);
    } catch (err) {
      console.error(`[ONVIF] Failed to connect to ${cameraId}:`, err.message);
      camera.connected = false;
      throw err;
    } finally {
      camera.connecting = false;
    }
  }

  /**
   * Subscribe to camera events.
   * The onvif library auto-creates a PullPoint subscription when the first
   * 'event' listener is attached (via newListener → _eventRequest).
   * No manual createPullPointSubscription call needed.
   */
  subscribeToEvents(cameraId) {
    const camera = this.cameras.get(cameraId);
    if (!camera || !camera.cam) {
      return;
    }

    const cam = camera.cam;

    console.log(`[ONVIF] Subscribing to events for ${cameraId}...`);

    cam.on('event', (event) => {
      this.handleEvent(cameraId, event);
    });

    cam.on('eventsError', (err) => {
      console.error(`[ONVIF] Event error for ${cameraId}:`, err.message);
    });
  }

  /**
   * Handle incoming event from camera
   */
  handleEvent(cameraId, event) {
    try {
      const message = event.message || event;
      const topic = event.topic || {};

      // Parse event type
      let eventType = 'unknown';
      let eventState = null;

      // Check topic for event type
      const topicStr = typeof topic === 'string' ? topic : JSON.stringify(topic);

      if (topicStr.includes('Motion') || topicStr.includes('motion')) {
        eventType = 'motion';
      } else if (topicStr.includes('Human') || topicStr.includes('human') || topicStr.includes('Person') || topicStr.includes('People') || topicStr.includes('PeopleDetector')) {
        eventType = 'human';
      } else if (topicStr.includes('Pet') || topicStr.includes('pet') || topicStr.includes('Animal')) {
        eventType = 'pet';
      } else if (topicStr.includes('Vehicle') || topicStr.includes('vehicle') || topicStr.includes('Car')) {
        eventType = 'vehicle';
      } else if (topicStr.includes('LineDetector') || topicStr.includes('Crossing')) {
        eventType = 'line_crossing';
      } else if (topicStr.includes('Tamper') || topicStr.includes('tamper')) {
        eventType = 'tamper';
      }

      // Try to extract state (true/false for motion on/off)
      if (message && message.message) {
        const data = message.message.data || message.message;
        if (data && data.simpleItem) {
          const items = Array.isArray(data.simpleItem) ? data.simpleItem : [data.simpleItem];
          for (const item of items) {
            if (item.$ && item.$.Name === 'State') {
              eventState = item.$.Value === 'true' || item.$.Value === true;
            }
          }
        }
      }

      // If we couldn't parse state, try raw value
      if (eventState === null) {
        eventState = true; // Default to true (event occurred)
      }

      // Debounce: skip if same event type occurred recently
      const debounceKey = `${cameraId}:${eventType}`;
      const now = Date.now();
      const lastTime = this.lastEventTimes.get(debounceKey) || 0;

      if (now - lastTime < EVENT_DEBOUNCE_MS) {
        // Skip duplicate event within debounce window
        return;
      }

      this.lastEventTimes.set(debounceKey, now);
      console.log(`[EVENT] ${cameraId}: ${eventType} = ${eventState}`);

      // Store event locally
      eventStore.add(cameraId, {
        type: eventType,
        state: eventState,
        data: {
          topic: topicStr,
          raw: message
        }
      });

      // Forward to QBitmap backend via webhook
      this.sendWebhook(cameraId, eventType, eventState);

    } catch (e) {
      console.error(`[ONVIF] Failed to parse event for ${cameraId}:`, e.message);
    }
  }

  /**
   * Send event to QBitmap backend via webhook
   */
  async sendWebhook(onvifCameraId, eventType, eventState) {
    if (!config.webhook.enabled) {
      return;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(config.webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          onvifCameraId,
          eventType,
          eventState,
          timestamp: new Date().toISOString()
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        console.log(`[WEBHOOK] Event sent: ${onvifCameraId} ${eventType}=${eventState}`);
      } else {
        const errorText = await response.text();
        console.warn(`[WEBHOOK] Failed (${response.status}): ${errorText}`);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error(`[WEBHOOK] Timeout (5s): ${onvifCameraId} ${eventType}`);
      } else {
        console.error(`[WEBHOOK] Error:`, error.message);
      }
    }
  }

  /**
   * Remove a camera
   */
  remove(cameraId) {
    const camera = this.cameras.get(cameraId);
    if (!camera) {
      throw new Error(`Camera ${cameraId} not found`);
    }

    // Disconnect
    if (camera.cam) {
      try {
        // Close any subscriptions
        camera.cam.removeAllListeners('event');
        camera.cam.removeAllListeners('eventsError');
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    // Clear events
    eventStore.clear(cameraId);

    this.cameras.delete(cameraId);

    // Save to file
    this.saveToFile();

    console.log(`[ONVIF] Camera ${cameraId} removed`);
  }

  /**
   * Get camera info
   */
  getInfo(cameraId) {
    const camera = this.cameras.get(cameraId);
    if (!camera) {
      return null;
    }

    return {
      id: camera.config.id,
      name: camera.config.name,
      host: camera.config.host,
      port: camera.config.port,
      connected: camera.connected
    };
  }

  /**
   * Get all cameras
   */
  getAll() {
    const result = [];
    for (const [id, camera] of this.cameras) {
      result.push({
        id: camera.config.id,
        name: camera.config.name,
        host: camera.config.host,
        port: camera.config.port,
        connected: camera.connected
      });
    }
    return result;
  }

  /**
   * Get stats
   */
  getStats() {
    let connected = 0;
    for (const camera of this.cameras.values()) {
      if (camera.connected) connected++;
    }
    return {
      total: this.cameras.size,
      connected
    };
  }
}

module.exports = new CameraManager();
