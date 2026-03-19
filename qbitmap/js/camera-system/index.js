/**
 * QBitmap Camera System - Main Entry Point
 * Modular architecture using mixins
 */

// AI Vision Prompt (used by ai-monitoring module)
const AI_VISION_PROMPT = `Sen bir acil durum algılama asistanısın. Sana verilen görüntüyü analiz et ve sadece JSON formatında yanıt ver.

Tespit etmen gereken durumlar:
- Düşmüş kişi (yerde yatan, bilinçsiz görünen)
- Yangın veya duman
- Kavga veya şiddet
- Panik hali veya kaçış
- Tıbbi acil durum belirtileri

JSON formatı:
{
  "alarm": true/false,
  "confidence": 0-100,
  "tasvir": "kısa açıklama"
}

Önemli:
- Normal aktiviteler için alarm: false
- Sadece gerçek acil durumlar için alarm: true
- Emin değilsen düşük confidence ver
- Yanıt SADECE JSON olmalı, başka metin yok`;

// Build AI prompt from structured detection rules (mirrors AI_VISION_PROMPT structure)
function buildPromptFromRules(rules) {
  const enabled = (rules || []).filter(r => r.text?.trim());
  if (!enabled.length) return AI_VISION_PROMPT;

  // Detection list - same format as global prompt
  let detectionList = '';
  enabled.forEach(r => { detectionList += `- ${r.text.trim()}\n`; });

  // Alarm rules in "Önemli" section
  const alarmItems = enabled.filter(r => r.alarm);
  const reportItems = enabled.filter(r => !r.alarm);

  let alarmRules = '';
  alarmItems.forEach(r => { alarmRules += `- ${r.text.trim()} tespit edersen alarm: true\n`; });
  reportItems.forEach(r => { alarmRules += `- ${r.text.trim()} tespit edersen alarm: false, sadece tasvir yaz\n`; });

  return `Sen bir acil durum algılama asistanısın. Sana verilen görüntüyü analiz et ve sadece JSON formatında yanıt ver.

Tespit etmen gereken durumlar:
${detectionList}
JSON formatı:
{
  "alarm": true/false,
  "confidence": 0-100,
  "tasvir": "kısa açıklama"
}

Önemli:
- Normal aktiviteler için alarm: false
${alarmRules}- Emin değilsen düşük confidence ver
- Yanıt SADECE JSON olmalı, başka metin yok`;
}

// Capture Service URL (proxied via Caddy to 167.235.27.12:3002)
const CAPTURE_SERVICE_URL = QBitmapConfig.frontend.base;

/**
 * Core CameraSystem Object - State and Configuration
 */
const CameraSystem = {
  // ==================== STATE ====================
  cameras: [],
  map: null,
  apiBase: QBitmapConfig.api.public,
  apiSettings: QBitmapConfig.api.public + '/settings',

  // Popup management
  popups: new Map(), // deviceId -> { popup, intervalId, isWhep }

  // AI Monitoring state (global - persists across popup open/close)
  aiMonitoring: new Map(), // deviceId -> { enabled, intervalId, isAnalyzing, recentResults, streamId }

  // Active alarms (global - synced via WebSocket)
  activeAlarms: new Map(), // deviceId -> alarm data

  // Camera GeoJSON data (for icon state updates)
  cameraGeojson: null,

  // WebSocket
  ws: null,
  wsReconnectAttempts: 0,
  wsMaxReconnectAttempts: 10,

  // Recording state
  isRecording: false,
  recordingDeviceId: null,
  mediaRecorder: null,
  recordedChunks: [],
  recordCanvas: null,
  recordingCameras: new Set(),      // WHEP kameralar için kayıt takibi
  recordingBlinkInterval: null,     // Harita ikonu blink timer

  // Settings cache
  settingsCache: {},

  // AI Settings cache (loaded from admin panel settings)
  aiSettings: null,

  // Constants
  AI_VISION_PROMPT,
  CAPTURE_SERVICE_URL,

  // ==================== CORE METHODS ====================

  /**
   * Initialize camera system with map reference
   */
  async init(map) {
    this.map = map;

    // Create settings drawer (once)
    this.createSettingsDrawer();

    // Load AI prompt settings from admin panel
    await this.loadAiPromptSettings();

    // Load cameras
    await this.loadCameras();

    // Add camera layer to map
    this.addCameraLayer();

    // Initialize WebSocket for real-time sync
    this.initWebSocket();

    // Load recording state from localStorage (after map layer is ready)
    setTimeout(() => {
      if (this.loadRecordingState) {
        this.loadRecordingState();
      }
    }, 1000);

    Logger.log('[Cameras] System initialized');
  },

  /**
   * Load cameras from backend (parallel fetches for performance)
   */
  async loadCameras() {
    try {
      // Prepare fetch promises - run all in parallel
      const fetchPromises = [
        // Public cameras (always fetch)
        fetch(`${this.apiBase}/cameras`).then(r => r.ok ? r.json() : { cameras: [] }).catch(() => ({ cameras: [] })),
        // City cameras (always fetch)
        fetch(`${this.apiBase}/city-cameras`).then(r => r.ok ? r.json() : { cameras: [] }).catch(() => ({ cameras: [] }))
      ];

      // Add user camera fetches if logged in
      const isLoggedIn = window.AuthSystem && AuthSystem.isLoggedIn();
      if (isLoggedIn) {
        fetchPromises.push(
          // User cameras
          fetch(`${QBitmapConfig.api.users}/me/cameras`, { credentials: 'include' })
            .then(r => r.ok ? r.json() : { cameras: [] }).catch(() => ({ cameras: [] })),
          // Shared cameras
          fetch(`${QBitmapConfig.api.users}/me/shared-cameras`, { credentials: 'include' })
            .then(r => r.ok ? r.json() : { cameras: [] }).catch(() => ({ cameras: [] }))
        );
      }

      // Execute all fetches in parallel (200-400ms faster than sequential)
      const results = await Promise.all(fetchPromises);

      const publicCameras = results[0].cameras || [];
      const cityCameras = (results[1].cameras || []).map(cam => ({ ...cam, camera_type: 'city' }));
      const userCameras = isLoggedIn ? (results[2]?.cameras || []).map(cam => ({ ...cam, isOwned: true })) : [];
      const sharedCameras = isLoggedIn ? (results[3]?.cameras || []).map(cam => ({
        ...cam,
        isShared: true
      })) : [];

      // Merge cameras, avoiding duplicates
      // Priority order: user > city > shared > public
      // BUT: city cameras should keep their hls_url even if user owns them
      const cameraMap = new Map();
      // Public cameras first (lowest priority)
      for (const cam of publicCameras) {
        cameraMap.set(cam.device_id, cam);
      }
      // Shared cameras (don't override existing)
      for (const cam of sharedCameras) {
        if (!cameraMap.has(cam.device_id)) {
          cameraMap.set(cam.device_id, cam);
        }
      }
      // City cameras override public (they have hls_url)
      for (const cam of cityCameras) {
        cameraMap.set(cam.device_id, cam);
      }
      // User cameras - merge with existing city camera data if present
      for (const cam of userCameras) {
        const existing = cameraMap.get(cam.device_id);
        if (existing && existing.camera_type === 'city') {
          // Merge: keep city camera's hls_url but add user data
          cameraMap.set(cam.device_id, { ...cam, ...existing, camera_type: 'city' });
        } else {
          cameraMap.set(cam.device_id, cam);
        }
      }

      this.cameras = Array.from(cameraMap.values());
      Logger.log(`[Cameras] Loaded ${this.cameras.length} cameras (${publicCameras.length} public + ${cityCameras.length} city + ${userCameras.length} user + ${sharedCameras.length} shared)`);
    } catch (error) {
      Logger.error('[Cameras] Load error:', error);
    }
  },

  /**
   * Cleanup - close all popups and clear all intervals
   */
  cleanup() {
    // Close all camera popups (this clears their intervals)
    for (const deviceId of this.popups.keys()) {
      this.closeCameraPopup(deviceId);
    }

    // Stop any active recording
    if (this.isRecording) {
      this.stopRecording();
    }

    // Stop recording blink interval
    if (this.recordingBlinkInterval) {
      clearInterval(this.recordingBlinkInterval);
      this.recordingBlinkInterval = null;
    }
    this.recordingCameras.clear();

    // Clear settings cache
    this.settingsCache = {};

    // Remove AI panel if open
    const aiPanel = document.getElementById('ai-detection-panel');
    if (aiPanel) aiPanel.remove();

    // Remove alarm popup if shown
    const alarm = document.getElementById('ai-alarm-popup');
    if (alarm) alarm.remove();

    // Close settings drawer
    const drawer = document.getElementById('settings-drawer');
    if (drawer) drawer.classList.remove('active');

    Logger.log('[Cameras] Cleanup complete');
  },

  /**
   * Reload cameras including user's private cameras (called on login)
   * Uses parallel fetches for performance
   */
  async reloadCamerasWithUserCameras() {
    try {
      // Execute all fetches in parallel (200-400ms faster than sequential)
      const [publicResult, cityResult, userResult, sharedResult] = await Promise.all([
        fetch(`${this.apiBase}/cameras`).then(r => r.ok ? r.json() : { cameras: [] }).catch(() => ({ cameras: [] })),
        fetch(`${this.apiBase}/city-cameras`).then(r => r.ok ? r.json() : { cameras: [] }).catch(() => ({ cameras: [] })),
        fetch(`${QBitmapConfig.api.users}/me/cameras`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : { cameras: [] }).catch(() => ({ cameras: [] })),
        fetch(`${QBitmapConfig.api.users}/me/shared-cameras`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : { cameras: [] }).catch(() => ({ cameras: [] }))
      ]);

      const publicCameras = publicResult.cameras || [];
      const cityCameras = (cityResult.cameras || []).map(cam => ({ ...cam, camera_type: 'city' }));
      const userCameras = (userResult.cameras || []).map(cam => ({ ...cam, isOwned: true }));
      const sharedCameras = (sharedResult.cameras || []).map(cam => ({
        ...cam,
        isShared: true
      }));

      // Merge cameras, avoiding duplicates
      // Priority order: user > city > shared > public
      const cameraMap = new Map();
      // Public cameras first (lowest priority)
      for (const cam of publicCameras) {
        cameraMap.set(cam.device_id, cam);
      }
      // Shared cameras (don't override existing)
      for (const cam of sharedCameras) {
        if (!cameraMap.has(cam.device_id)) {
          cameraMap.set(cam.device_id, cam);
        }
      }
      // City cameras override public (they have hls_url)
      for (const cam of cityCameras) {
        cameraMap.set(cam.device_id, cam);
      }
      // User cameras - merge with existing city camera data if present
      for (const cam of userCameras) {
        const existing = cameraMap.get(cam.device_id);
        if (existing && existing.camera_type === 'city') {
          cameraMap.set(cam.device_id, { ...cam, ...existing, camera_type: 'city' });
        } else {
          cameraMap.set(cam.device_id, cam);
        }
      }

      this.cameras = Array.from(cameraMap.values());
      Logger.log(`[Cameras] Loaded ${this.cameras.length} cameras (${publicCameras.length} public + ${cityCameras.length} city + ${userCameras.length} user + ${sharedCameras.length} shared)`);

      // Refresh the map layer
      this.refreshCameraLayer();
    } catch (error) {
      Logger.error('[Cameras] Reload error:', error);
    }
  },

  /**
   * Reload only public cameras (called on logout)
   */
  async reloadPublicCameras() {
    try {
      // Fetch both regular public cameras and city cameras in parallel
      const [publicResponse, cityResponse] = await Promise.all([
        fetch(`${this.apiBase}/cameras`),
        fetch(`${this.apiBase}/city-cameras`)
      ]);

      const publicData = publicResponse.ok ? await publicResponse.json() : { cameras: [] };
      const cityData = cityResponse.ok ? await cityResponse.json() : { cameras: [] };

      // Merge cameras - city cameras come first
      const cityCameras = (cityData.cameras || []).map(c => ({ ...c, camera_type: 'city' }));
      const regularCameras = publicData.cameras || [];

      this.cameras = [...cityCameras, ...regularCameras];
      Logger.log(`[Cameras] Loaded ${regularCameras.length} public + ${cityCameras.length} city cameras`);

      // Refresh the map layer
      this.refreshCameraLayer();
    } catch (error) {
      Logger.error('[Cameras] Reload error:', error);
    }
  },

  /**
   * Refresh camera layer on map with current camera data
   */
  refreshCameraLayer() {
    if (!this.map) return;

    const validCameras = this.cameras.filter(c => c.lng && c.lat);

    // Update stored GeoJSON with state preserved where possible
    this.cameraGeojson = {
      type: 'FeatureCollection',
      features: validCameras.map(camera => {
        // Preserve existing state if camera was already in the list
        const existingFeature = this.cameraGeojson?.features?.find(
          f => f.properties.device_id === camera.device_id
        );
        // Determine initial state: shared cameras should show orange
        const initialState = camera.isShared ? 'shared' : 'normal';
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [camera.lng, camera.lat] },
          properties: {
            device_id: camera.device_id,
            name: camera.name || camera.device_id,
            state: existingFeature?.properties?.state || initialState,
            isShared: !!camera.isShared,
            camera_type: camera.camera_type || 'device'
          }
        };
      })
    };

    // Update the source data if it exists
    const source = this.map.getSource('cameras');
    if (source) {
      source.setData(this.cameraGeojson);
      // Update all icons to reflect current state (alarm > monitoring > shared > normal)
      this.updateAllCameraIcons();
      Logger.log(`[Cameras] Refreshed layer with ${validCameras.length} cameras`);
    }
  },

  /**
   * Load AI prompt settings from admin panel
   * These settings are used by ai-monitoring.js and popup.js
   */
  async loadAiPromptSettings() {
    try {
      const resp = await fetch(`${QBitmapConfig.api.public}/ai-settings`);
      if (!resp.ok) throw new Error('Failed to load AI settings');

      const data = await resp.json();
      this.aiSettings = {
        monitoringPrompt: data.ai_monitoring_prompt || this.AI_VISION_PROMPT,
        searchPrompt: data.ai_search_prompt || 'bu resimde ne görüyorsun maksimum birkaç cümle ile açıkla ve sadece emin olduklarını yaz',
        maxTokens: parseInt(data.ai_max_tokens) || 1024,
        temperature: parseFloat(data.ai_temperature) || 0.7,
        model: data.ai_vision_model || 'qwen3-vl:32b-instruct'
      };
      Logger.log('[AI] Settings loaded from admin panel');
    } catch (e) {
      // Fallback to defaults
      this.aiSettings = {
        monitoringPrompt: this.AI_VISION_PROMPT,
        searchPrompt: 'bu resimde ne görüyorsun maksimum birkaç cümle ile açıkla ve sadece emin olduklarını yaz',
        maxTokens: 1024,
        temperature: 0.7,
        model: 'qwen3-vl:32b-instruct'
      };
      Logger.log('[AI] Using default settings (admin settings not available)');
    }
  }
};

// Make CameraSystem globally accessible on window
window.CameraSystem = CameraSystem;

// ==================== MODULE LOADING ====================
// Modules will be loaded via script tags and merged using Object.assign
// Each module file should define a *Mixin object and call:
// Object.assign(CameraSystem, ModuleMixin);

// ==================== INITIALIZATION ====================
function initCameraSystem() {
  if (window.map) {
    CameraSystem.init(window.map);
  } else {
    setTimeout(initCameraSystem, 200);
  }
}

// Start initialization after all modules are loaded
// This is called from the last module script or can be called manually
window.startCameraSystem = function() {
  initCameraSystem();

  // Listen for auth events to reload cameras
  window.addEventListener('auth:login', () => {
    Logger.log('[Cameras] User logged in, reloading cameras with private cameras');
    CameraSystem.reloadCamerasWithUserCameras();
  });

  window.addEventListener('auth:logout', () => {
    Logger.log('[Cameras] User logged out, reloading public cameras only');
    CameraSystem.reloadPublicCameras();
  });
};

// Auto-start if this is the only file (backward compat)
if (typeof window.CameraSystemModulesLoaded === 'undefined') {
  // Wait a bit to see if modules will be loaded
  setTimeout(() => {
    if (typeof window.CameraSystemModulesLoaded === 'undefined') {
      window.startCameraSystem();
    }
  }, 100);
}
