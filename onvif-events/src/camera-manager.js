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

function clamp(v, lo, hi) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// Exponential backoff for reconnect. Caps at 60s so a long-dead camera does
// not stampede retries forever but still eventually comes back online on its
// own when the network recovers. Previously `eventsError` left the cam object
// wedged — events stopped flowing until the service was manually restarted.
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 15000, 60000];

// Upper bound on how long a single continuousMove can run without an explicit
// stop. ONVIF `Timeout` + JS-side dead-man timer both enforce this so a stuck
// client or dropped WebSocket cannot leave the motor moving indefinitely.
const PTZ_MAX_MOVE_MS = 10000;
const PTZ_DEFAULT_MOVE_MS = 2000;

class CameraManager {
  constructor() {
    // Map<cameraId, { config, cam, connected, connecting, ptzProfileToken,
    //                 ptzSupported, reconnectAttempt, reconnectTimer,
    //                 ptzStopTimer, destroyed }>
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
              connecting: false,
              ptzSupported: false,
              ptzProfileToken: null,
              reconnectAttempt: 0,
              reconnectTimer: null,
              ptzStopTimer: null,
              destroyed: false
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
      connecting: false,
      ptzSupported: false,
      ptzProfileToken: null,
      reconnectAttempt: 0,
      reconnectTimer: null,
      ptzStopTimer: null,
      destroyed: false
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
    // If reconnect was pending (retry path), swallow the timer: we're handling
    // the reconnect right now.
    this._clearReconnectTimer(camera);

    // Dispose old cam object (listeners + any pending pullpoints) before
    // replacing it. Otherwise an `eventsError` from the stale socket could fire
    // after a fresh connect and tear the new one down too.
    if (camera.cam) {
      try {
        camera.cam.removeAllListeners('event');
        camera.cam.removeAllListeners('eventsError');
      } catch (_) { /* ignore */ }
      camera.cam = null;
    }

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

        // Detect PTZ: any profile with a PTZConfiguration means the camera
        // advertises pan/tilt/zoom. Fallback to defaultProfile.token so the
        // agsh/onvif client can resolve the profile implicitly.
        this._detectPtz(cameraId);

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
      camera.reconnectAttempt = 0;
    } catch (err) {
      console.error(`[ONVIF] Failed to connect to ${cameraId}:`, err.message);
      camera.connected = false;
      throw err;
    } finally {
      camera.connecting = false;
    }
  }

  /**
   * Inspect the freshly-connected Cam instance for PTZ capability.
   * agsh/onvif populates `cam.profiles` and `cam.defaultProfile` inside the
   * constructor init chain, so by the time the connect callback fires they are
   * available synchronously.
   */
  _detectPtz(cameraId) {
    const camera = this.cameras.get(cameraId);
    if (!camera || !camera.cam) return;
    const cam = camera.cam;

    let token = null;
    try {
      const profiles = Array.isArray(cam.profiles) ? cam.profiles : [];
      const ptzProfile = profiles.find(p => p && p.PTZConfiguration) || cam.defaultProfile;
      if (ptzProfile) {
        token = ptzProfile.$ && ptzProfile.$.token
          ? ptzProfile.$.token
          : ptzProfile.token || null;
      }
    } catch (e) {
      console.warn(`[ONVIF] PTZ detect failed for ${cameraId}:`, e.message);
    }

    // Tapo firmwares advertise top-level PTZ=false in capabilities yet still
    // accept continuousMove/stop as long as a profile has a PTZConfiguration.
    // Trust the profile marker; the capability field alone is too strict.
    const profiles = Array.isArray(cam.profiles) ? cam.profiles : [];
    const ptzProfile = profiles.find(p => p && p.PTZConfiguration) || null;
    camera.ptzProfileToken = token;
    camera.ptzSupported = !!token && !!ptzProfile;
    // Optical zoom detection: C236 style pan-tilt cameras advertise
    // panTiltLimits but no zoomLimits / no defaultContinuousZoomVelocitySpace.
    // Sending zoom commands to such a camera is a no-op at best, so let the
    // frontend know to hide the zoom buttons entirely.
    const ptzConfig = ptzProfile ? ptzProfile.PTZConfiguration : null;
    camera.ptzZoomSupported = !!(ptzConfig && (
      ptzConfig.zoomLimits ||
      ptzConfig.ZoomLimits ||
      ptzConfig.defaultContinuousZoomVelocitySpace
    ));
    if (camera.ptzSupported) {
      console.log(`[ONVIF] ${cameraId} PTZ: profile=${token} zoom=${camera.ptzZoomSupported}`);
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

    // Tapo cameras lie about capabilities — C236 reports capabilities.events
    // = null yet advertises the Events WSDL via getServices and actually
    // delivers motion/person/line-cross/tamper/TPSmartEvent topics via
    // PullPoint. So we don't gate on capabilities.events anymore. Instead we
    // treat eventsError as benign (the Tapo keep-alive drops the PullMessages
    // socket every ~10s) and let agsh/onvif re-subscribe without tearing
    // down the whole camera connection — otherwise PTZ commands race-fail
    // with "not connected" during the reconnect window.
    console.log(`[ONVIF] Subscribing to events for ${cameraId}...`);

    cam.on('event', (event) => this.handleEvent(cameraId, event));

    cam.on('eventsError', (err) => {
      // agsh/onvif keeps its single PullPoint subscription alive internally
      // across transient Tapo errors — observed empirically on C236 and
      // Office 01/02/03, events flow continuously despite 'socket hang up'
      // and 'ONVIF SOAP Fault: error' emissions every few seconds. Do NOT
      // try to re-subscribe here: swapping listeners triggers newListener
      // → _eventRequest() on top of the still-running subscription, which
      // leaks subscriptions and produces a runaway storm of SOAP faults
      // (observed: ~180K faults accumulated in 2 hours before this fix).
      // Just rate-limit the log so the journal doesn't fill up.
      const msg = (err && err.message) || 'unknown';
      const now = Date.now();
      const key = `evterr:${cameraId}:${msg}`;
      const last = this.lastEventTimes.get(key) || 0;
      if (now - last > 60000) {
        this.lastEventTimes.set(key, now);
        console.log(`[ONVIF] ${cameraId} event error (Tapo quirk, benign): ${msg}`);
      }
    });
  }

  /**
   * Schedule a reconnect with exponential backoff. Safe to call repeatedly —
   * only one timer is ever armed per camera.
   */
  scheduleReconnect(cameraId, reason) {
    const camera = this.cameras.get(cameraId);
    if (!camera || camera.destroyed) return;
    if (camera.reconnectTimer || camera.connecting) return;

    const idx = Math.min(camera.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[idx];
    camera.reconnectAttempt += 1;
    camera.connected = false;

    console.log(`[ONVIF] Scheduling reconnect for ${cameraId} in ${delay}ms (attempt ${camera.reconnectAttempt}, reason: ${reason})`);

    camera.reconnectTimer = setTimeout(() => {
      camera.reconnectTimer = null;
      if (camera.destroyed) return;
      this.connect(cameraId).catch(err => {
        console.warn(`[ONVIF] Reconnect failed for ${cameraId}: ${err.message}`);
        // Chain the next backoff step. Caps at 60s so we don't stampede.
        this.scheduleReconnect(cameraId, 'retry-failed');
      });
    }, delay);
  }

  _clearReconnectTimer(camera) {
    if (camera && camera.reconnectTimer) {
      clearTimeout(camera.reconnectTimer);
      camera.reconnectTimer = null;
    }
  }

  /**
   * Start a continuous PTZ move. x/y/zoom are velocities in [-1, 1]. Schedules
   * a dead-man stop after `timeoutMs` so a dropped client or locked UI cannot
   * leave the motor running indefinitely.
   */
  async move(cameraId, { x = 0, y = 0, zoom = 0 } = {}, timeoutMs = PTZ_DEFAULT_MOVE_MS) {
    const camera = this.cameras.get(cameraId);
    if (!camera) throw new Error(`Camera ${cameraId} not found`);
    if (!camera.connected || !camera.cam) throw new Error(`Camera ${cameraId} is not connected`);
    if (!camera.ptzSupported) throw new Error(`Camera ${cameraId} does not support PTZ`);

    const clampedTimeout = Math.min(Math.max(parseInt(timeoutMs) || PTZ_DEFAULT_MOVE_MS, 100), PTZ_MAX_MOVE_MS);
    const options = {
      x: clamp(x, -1, 1),
      y: clamp(y, -1, 1),
      zoom: clamp(zoom, -1, 1),
      // ONVIF-side auto-stop, formatted as ISO-8601 duration (PT<seconds>S).
      onvifTimeout: `PT${Math.ceil(clampedTimeout / 1000)}S`
    };
    if (camera.ptzProfileToken) options.profileToken = camera.ptzProfileToken;

    await new Promise((resolve, reject) => {
      camera.cam.continuousMove(options, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    // JS-side dead-man timer — belt-and-braces over ONVIF Timeout, since some
    // firmwares ignore the protocol-level timeout.
    if (camera.ptzStopTimer) clearTimeout(camera.ptzStopTimer);
    camera.ptzStopTimer = setTimeout(() => {
      camera.ptzStopTimer = null;
      this.stop(cameraId).catch(() => { /* already logged */ });
    }, clampedTimeout);
  }

  /**
   * Relative pan/tilt step: move by a fixed translation in the profile's
   * default TranslationGenericSpace (where 1.0 ≈ full range of the axis).
   * On Tapo C236 this is the practical control method — each press jumps a
   * fixed angle rather than running continuously. Does not take a timeout
   * because the camera self-terminates when the relative target is reached.
   */
  async step(cameraId, { x = 0, y = 0 } = {}) {
    const camera = this.cameras.get(cameraId);
    if (!camera) throw new Error(`Camera ${cameraId} not found`);
    if (!camera.connected || !camera.cam) throw new Error(`Camera ${cameraId} is not connected`);
    if (!camera.ptzSupported) throw new Error(`Camera ${cameraId} does not support PTZ`);

    const options = {
      x: clamp(x, -1, 1),
      y: clamp(y, -1, 1),
      zoom: 0
    };
    if (camera.ptzProfileToken) options.profileToken = camera.ptzProfileToken;

    await new Promise((resolve, reject) => {
      camera.cam.relativeMove(options, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * Re-center the camera. Uses AbsoluteMove to (0, 0) in generic space
   * rather than GotoHomePosition, because Tapo firmwares return
   * ActionNotSupported on GotoHomePosition and don't ship a settable home.
   * (0, 0) is the geometric center of panTiltLimits so it's the natural
   * "reset" target.
   */
  async home(cameraId) {
    const camera = this.cameras.get(cameraId);
    if (!camera) throw new Error(`Camera ${cameraId} not found`);
    if (!camera.connected || !camera.cam) throw new Error(`Camera ${cameraId} is not connected`);
    if (!camera.ptzSupported) throw new Error(`Camera ${cameraId} does not support PTZ`);

    const options = { x: 0, y: 0, zoom: 0 };
    if (camera.ptzProfileToken) options.profileToken = camera.ptzProfileToken;

    await new Promise((resolve, reject) => {
      camera.cam.absoluteMove(options, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * Stop any active PTZ motion (pan/tilt AND zoom).
   */
  async stop(cameraId) {
    const camera = this.cameras.get(cameraId);
    if (!camera) throw new Error(`Camera ${cameraId} not found`);
    if (!camera.connected || !camera.cam) throw new Error(`Camera ${cameraId} is not connected`);
    if (!camera.ptzSupported) return; // no-op: nothing to stop

    if (camera.ptzStopTimer) {
      clearTimeout(camera.ptzStopTimer);
      camera.ptzStopTimer = null;
    }

    const options = { panTilt: true, zoom: true };
    if (camera.ptzProfileToken) options.profileToken = camera.ptzProfileToken;

    await new Promise((resolve, reject) => {
      camera.cam.stop(options, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * Report PTZ capability for a camera — used by the popup to decide whether
   * to render the control overlay at all.
   */
  capabilities(cameraId) {
    const camera = this.cameras.get(cameraId);
    if (!camera) return null;
    return {
      connected: !!camera.connected,
      ptz: !!camera.ptzSupported,
      ptzZoom: !!camera.ptzZoomSupported,
      profileToken: camera.ptzProfileToken || null
    };
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

      // Tapo topic map (from getEventProperties on C236):
      //   ruleEngine/cellMotionDetector/motion   → motion
      //   ruleEngine/peopleDetector/people       → human/person
      //   ruleEngine/lineCrossDetector/lineCross → line_crossing
      //   ruleEngine/tamperDetector/tamper       → tamper
      //   ruleEngine/TPSmartEventDetector/TPSmartEvent → unified smart event
      //     (contains pet/vehicle/baby-cry as runtime payload — we log the
      //      full data on the first occurrence so the user can tell us what
      //      a real pet/vehicle/baby-cry event looks like)
      if (topicStr.includes('cellMotionDetector') || topicStr.includes('Motion') || topicStr.includes('motion')) {
        eventType = 'motion';
      } else if (topicStr.includes('peopleDetector') || topicStr.includes('Human') || topicStr.includes('human') || topicStr.includes('Person') || topicStr.includes('People')) {
        eventType = 'human';
      } else if (topicStr.includes('Pet') || topicStr.includes('pet') || topicStr.includes('Animal')) {
        eventType = 'pet';
      } else if (topicStr.includes('Vehicle') || topicStr.includes('vehicle') || topicStr.includes('Car')) {
        eventType = 'vehicle';
      } else if (topicStr.includes('LineCross') || topicStr.includes('lineCross') || topicStr.includes('LineDetector') || topicStr.includes('Crossing')) {
        eventType = 'line_crossing';
      } else if (topicStr.includes('tamperDetector') || topicStr.includes('Tamper') || topicStr.includes('tamper')) {
        eventType = 'tamper';
      } else if (topicStr.includes('TPSmartEventDetector') || topicStr.includes('TPSmartEvent')) {
        eventType = 'smart';
        try {
          console.log(`[TAPO_SMART] ${cameraId} raw event payload:`, JSON.stringify(event, null, 2));
        } catch (_) { /* event may contain circular refs from onvif lib */ }
      }

      // Diagnostic: dump the raw event for anything that didn't match above
      // so we can learn the actual Tapo topic strings for pet / vehicle /
      // baby-cry / line-crossing etc. Remove once the mapping is complete.
      if (eventType === 'unknown') {
        try {
          console.log(`[TAPO_UNKNOWN] ${cameraId} topic=${topicStr} payload=${JSON.stringify(event)}`);
        } catch (_) { /* ignore circulars */ }
      }

      // Try to extract state (true/false for motion on/off). Tapo uses
      // IsMotion / IsPeople / IsLineCross / IsTamper / IsTPSmartEvent as the
      // state field name; other ONVIF vendors use plain 'State'. Accept any
      // boolean-ish simpleItem whose Name starts with "Is" or equals "State".
      if (message && message.message) {
        const data = message.message.data || message.message;
        if (data && data.simpleItem) {
          const items = Array.isArray(data.simpleItem) ? data.simpleItem : [data.simpleItem];
          for (const item of items) {
            const name = item.$ && item.$.Name;
            if (!name) continue;
            if (name === 'State' || name.startsWith('Is')) {
              const val = item.$.Value;
              eventState = val === 'true' || val === true;
              break;
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

    // Mark destroyed so any in-flight reconnect timer exits cleanly rather
    // than trying to reconnect a camera we just deleted.
    camera.destroyed = true;
    this._clearReconnectTimer(camera);
    if (camera.ptzStopTimer) {
      clearTimeout(camera.ptzStopTimer);
      camera.ptzStopTimer = null;
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
      connected: camera.connected,
      ptz: !!camera.ptzSupported
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
        connected: camera.connected,
        ptz: !!camera.ptzSupported
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
