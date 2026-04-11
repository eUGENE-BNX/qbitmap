import '../../css/live-broadcast.css';
import { QBitmapConfig } from '../config.js';
import { Logger, escapeHtml, showNotification } from '../utils.js';
import { AuthSystem } from '../auth.js';
import { Analytics } from '../analytics.js';
import * as AppState from '../state.js';
import { applyAutofocus, getSavedCameraId, saveCameraId } from '../video-message/media.js';
import { LocationService } from '../services/location-service.js';

function _hapticBroadcast(style) {
  if (!navigator.vibrate) return;
  const p = { light: 10, medium: 20, heavy: 30, success: [10, 50, 20] };
  navigator.vibrate(p[style] || 10);
}

const CoreMixin = {
  // State
  isBroadcasting: false,
  peerConnection: null,
  mediaStream: null,
  whipSessionUrl: null,
  currentBroadcast: null,

  // Active broadcasts from all users (for map display)
  activeBroadcasts: new Map(),

  // Viewer popup state
  currentPopup: null,
  viewerPeerConnection: null,

  // Camera facing mode (front/back)
  currentFacingMode: 'environment',
  _stopping: false,
  _cameraSwitchBtn: null,

  // AI Search state
  _aiSearchMode: false,
  _aiSearchSelection: null,
  _aiSearchMouseDown: null,
  _aiSearchMouseMove: null,
  _aiSearchMouseUp: null,
  _aiSearchCardTimeout: null,

  // AI Analyze state
  _broadcastAiAnalyzeActive: false,
  _broadcastAiAnalyzeIntervalId: null,
  _broadcastAiAnalyzeProcessing: false,
  _broadcastAiTypewriteTimer: null,

  // Face Detection state
  faceDetectionActive: false,
  faceDetectionInterval: null,
  faceDetectionFaces: [],
  _lastFaceDetection: null,
  _faceDetectionBtn: null,

  // Recording state
  broadcastRecording: false,
  broadcastRecordEnabled: false,

  // Broadcast timer state
  _broadcastTimerInterval: null,
  _broadcastMaxDurationMs: 600000,
  _broadcastStartTime: null,

  // Popup zoom state
  _popupZoomLevel: 0,

  // Resolution state
  currentResolution: { width: 1280, height: 720, label: '720p' },
  _resolutionBtn: null,
  RESOLUTIONS: [
    { width: 1280, height: 720, label: '720p' },
    { width: 1920, height: 1080, label: '1080p' }
  ],

  apiBase: null,

  /**
   * Initialize the live broadcast system
   */
  init() {
    this.apiBase = QBitmapConfig.api.base + '/api/broadcasts';

    // Load active broadcasts on startup
    this.loadActiveBroadcasts();

    // Initialize map layer when map is ready
    this.initMapLayer();

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      if (this.isBroadcasting) {
        this.stopBroadcastSync();
      }
    });

    // Stop broadcast on logout
    window.addEventListener('auth:logout', () => {
      if (this.isBroadcasting) {
        this.stopBroadcast();
      }
    });

    Logger.log('[LiveBroadcast] System initialized');
  },

  /**
   * Bind the broadcast button after auth UI renders
   */
  bindButton() {
    const btn = document.getElementById('broadcast-button');
    if (btn && !btn._broadcastBound) {
      btn._broadcastBound = true;
      btn.addEventListener('click', () => this.toggleBroadcast());
    }
  },

  /**
   * Toggle broadcast on/off
   */
  async toggleBroadcast() {
    if (this.isBroadcasting) {
      await this.stopBroadcast();
    } else {
      await this.startBroadcast();
    }
  },

  /**
   * Start broadcasting
   */
  async startBroadcast() {
    if (!AuthSystem.isLoggedIn()) {
      AuthSystem.showNotification('Yayın için giriş yapın', 'error');
      return;
    }

    const btn = document.getElementById('broadcast-button');

    try {
      // 1. Request camera + mic permissions (use currentResolution, back camera preferred)
      const savedId = getSavedCameraId();
      const videoConstraints = {
        width: { exact: this.currentResolution.width },
        height: { exact: this.currentResolution.height },
        frameRate: { ideal: 24 },
        focusMode: { ideal: 'continuous' }
      };
      if (savedId) {
        videoConstraints.deviceId = { exact: savedId };
      } else {
        videoConstraints.facingMode = { ideal: this.currentFacingMode };
      }
      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: true });
      } catch (e) {
        if (savedId) {
          delete videoConstraints.deviceId;
          videoConstraints.facingMode = { ideal: this.currentFacingMode };
          this.mediaStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: true });
        } else { throw e; }
      }
      applyAutofocus(this.mediaStream);
      saveCameraId(this.mediaStream.getVideoTracks()[0]?.getSettings()?.deviceId);

      // 2. Get geolocation via unified LocationService
      let lng, lat, accuracyRadiusM = null, locationSource = null;
      let locationResolved = false;

      try {
        const loc = await LocationService.get({
          purpose: 'broadcast',
          acceptThresholdM: 25,
          approximateMaxM: 100
        });
        lng = loc.lng;
        lat = loc.lat;
        accuracyRadiusM = loc.accuracy_radius_m;
        locationSource = loc.source;

        if (loc.quality === 'precise') {
          locationResolved = true;
        } else {
          // Approximate GPS or coarse IP — let user confirm or pick on map
          const choice = await this._showLocationDialog(loc.accuracy_radius_m, lng, lat);
          if (choice) {
            lng = choice.lng;
            lat = choice.lat;
            locationResolved = true;
          }
        }
      } catch {
        // Both GPS and IP fallback failed; user must pick on map
      }

      if (!locationResolved) {
        try {
          const picked = await this._pickLocationFromMap();
          lng = picked.lng;
          lat = picked.lat;
          accuracyRadiusM = null;
          locationSource = 'manual';
        } catch {
          this.cleanupMediaResources();
          return;
        }
      }

      // 3. Ask if user wants to record this broadcast
      const recordChoice = await this._showRecordDialog();
      if (recordChoice.cancelled) {
        this.cleanupMediaResources();
        return;
      }
      const shouldRecord = recordChoice.record;

      // 4. Call backend to start broadcast
      const startResponse = await fetch(`${this.apiBase}/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lng, lat, accuracy_radius_m: accuracyRadiusM, source: locationSource, record: shouldRecord })
      });

      if (!startResponse.ok) {
        const err = await startResponse.json().catch(() => ({}));
        throw new Error(err.error || `Server error: ${startResponse.status}`);
      }

      const data = await startResponse.json();
      this.currentBroadcast = data.broadcast;
      this.broadcastRecordEnabled = shouldRecord;
      this.broadcastRecording = shouldRecord;

      // 5. Publish via WHIP
      await this.publishWhip(data.broadcast.whipUrl, this.mediaStream);

      Analytics.event('broadcast_start');

      // 6. Update UI
      this.isBroadcasting = true;
      this._broadcastMaxDurationMs = data.broadcast.maxDurationMs || 600000;
      this._broadcastStartTime = Date.now();
      this._startBroadcastCountdown();
      if (btn) {
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        btn.title = 'Canlı Yayını Durdur';
      }

      // 7. Immediately add own broadcast to map (don't wait for WS round-trip)
      const bc = data.broadcast;
      const user = AuthSystem.getUser ? AuthSystem.getUser() : AuthSystem.user;
      this.activeBroadcasts.set(bc.broadcastId, {
        broadcast_id: bc.broadcastId,
        display_name: user?.displayName || 'User',
        avatar_url: user?.avatarUrl || '',
        lng: bc.lng,
        lat: bc.lat,
        whep_url: bc.whepUrl,
        started_at: new Date().toISOString()
      });
      this.updateMapLayer();

      // 8. Fly map to broadcast location
      if (AppState.map) {
        AppState.map.flyTo({ center: [bc.lng, bc.lat], zoom: Math.max(AppState.map.getZoom(), 14) });
      }

      _hapticBroadcast('success');
      AuthSystem.showNotification(shouldRecord ? 'Canlı yayın başladı (kayıt aktif)' : 'Canlı yayın başladı', 'success');
      Logger.log('[LiveBroadcast] Broadcasting started');

      // 9. Auto-open own broadcast popup (so controls are accessible)
      this.openBroadcastPopup({
        broadcastId: bc.broadcastId,
        displayName: user?.displayName || 'User',
        whepUrl: bc.whepUrl
      }, [bc.lng, bc.lat]);

    } catch (error) {
      Logger.error('[LiveBroadcast] Start error:', error);
      this.cleanupMediaResources();

      let msg = 'Yayın başlatılamadı';
      if (error.name === 'NotAllowedError') msg = 'Kamera izni reddedildi';
      else if (error.code === 1) msg = 'Konum izni reddedildi';
      else if (error.message) msg = error.message;

      AuthSystem.showNotification(msg, 'error');
    }
  },

  /**
   * Publish media stream via WHIP protocol
   */
  async publishWhip(whipUrl, stream) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    this.peerConnection = pc;

    // Add tracks from getUserMedia stream
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }

    // Prefer H264 codec for video (required for MediaMTX fMP4 recording - VP8 not supported)
    const videoTransceiver = pc.getTransceivers().find(t => t.sender.track?.kind === 'video');
    if (videoTransceiver && typeof RTCRtpSender.getCapabilities === 'function') {
      const caps = RTCRtpSender.getCapabilities('video');
      if (caps) {
        const h264Codecs = caps.codecs.filter(c => c.mimeType === 'video/H264');
        const otherCodecs = caps.codecs.filter(c => c.mimeType !== 'video/H264');
        if (h264Codecs.length > 0) {
          videoTransceiver.setCodecPreferences([...h264Codecs, ...otherCodecs]);
        }
      }
    }

    // Handle ICE connection state
    pc.oniceconnectionstatechange = () => {
      Logger.log('[WHIP] ICE state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        Logger.warn('[WHIP] Connection failed, stopping broadcast');
        this.stopBroadcast();
      }
    };

    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Wait for ICE gathering to complete (3s timeout)
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
      } else {
        const checkState = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', checkState);
            resolve();
          }
        };
        pc.addEventListener('icegatheringstatechange', checkState);
        setTimeout(resolve, 3000);
      }
    });

    // Send offer via WHIP proxy
    const proxyUrl = `${QBitmapConfig.api.public}/whip-proxy?url=${encodeURIComponent(whipUrl)}`;
    const response = await fetch(proxyUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp
    });

    if (!response.ok) {
      throw new Error(`WHIP request failed: ${response.status}`);
    }

    // Store session URL for teardown
    const location = response.headers.get('location');
    if (location) {
      this.whipSessionUrl = location;
    }

    // Set remote description
    const answerSdp = await response.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    Logger.log('[WHIP] WebRTC publish connection established');
  },

  /**
   * Stop broadcasting
   */
  async stopBroadcast() {
    if (this._stopping) return;
    this._stopping = true;

    const btn = document.getElementById('broadcast-button');

    // Stop countdown timer
    this._stopBroadcastCountdown();

    // Stop face detection if active
    this.stopBroadcastFaceDetection();

    const wasRecording = this.broadcastRecording || this.broadcastRecordEnabled;

    // Immediately remove own broadcast from map (don't wait for backend)
    if (this.currentBroadcast) {
      this.activeBroadcasts.delete(this.currentBroadcast.broadcastId);
      this.updateMapLayer();
    }

    // Cleanup media first to prevent ICE handler re-triggering
    this.cleanupMediaResources();

    try {
      // Notify backend FIRST - use keepalive so request survives on mobile
      const stopPromise = fetch(`${this.apiBase}/stop`, {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' }
      }).catch(e => Logger.warn('[LiveBroadcast] Stop API failed:', e));

      // Teardown WHIP session in parallel (can be slow on mobile)
      const whipPromise = this.whipSessionUrl
        ? fetch(`${QBitmapConfig.api.public}/whip-proxy?url=${encodeURIComponent(this.whipSessionUrl)}`, {
            method: 'DELETE', credentials: 'include', keepalive: true
          }).catch(e => Logger.warn('[WHIP] Session teardown failed:', e))
        : Promise.resolve();

      await Promise.all([stopPromise, whipPromise]);

    } catch (error) {
      Logger.error('[LiveBroadcast] Stop error:', error);
    } finally {
      this.isBroadcasting = false;
      this.currentBroadcast = null;
      this.whipSessionUrl = null;
      this._stopping = false;
      this.broadcastRecording = false;
      this.broadcastRecordEnabled = false;

      if (btn) {
        btn.classList.remove('active');
        btn.setAttribute('aria-pressed', 'false');
        btn.title = 'Canlı Yayın';
      }

      if (wasRecording) {
        showNotification('Yayın kaydediliyor...', 'info');
      }

      Logger.log('[LiveBroadcast] Broadcasting stopped');
    }
  },

  /**
   * Synchronous stop for beforeunload (best effort)
   */
  stopBroadcastSync() {
    // Use keepalive fetch (survives page unload, sends credentials)
    try {
      fetch(`${this.apiBase}/stop`, {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' }
      }).catch(() => {});
    } catch (e) {
      // Fallback to sync XHR
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${this.apiBase}/stop`, false);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send('{}');
      } catch (e2) { /* Best effort */ }
    }
    this.cleanupMediaResources();
  },

  /**
   * Cleanup media resources
   */
  cleanupMediaResources() {
    if (this.peerConnection) {
      try { this.peerConnection.close(); } catch (e) {}
      this.peerConnection = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
  },

  /**
   * Show pre-broadcast dialog asking if user wants to record
   * @returns {Promise<boolean>} true if user wants to record
   */
  /**
   * Show pre-broadcast dialog asking if user wants to record.
   * Returns: { cancelled: false, record: boolean } or { cancelled: true }
   */
  _showRecordDialog() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'broadcast-dialog-overlay';
      overlay.innerHTML = `
        <div class="broadcast-dialog">
          <div class="broadcast-dialog-title">Canlı Yayın Ayarları</div>
          <div class="broadcast-dialog-body">
            <label class="broadcast-record-toggle">
              <input type="checkbox" id="broadcast-record-checkbox" checked>
              <span>Yayını kaydet</span>
            </label>
            <div class="broadcast-dialog-hint">Kayıt, yayın boyunca devam eder. Sonradan profilinizde ve haritada paylaşabilirsiniz. Maks. 10 dk.</div>
          </div>
          <div class="broadcast-dialog-actions">
            <button class="broadcast-dialog-btn cancel">İptal</button>
            <button class="broadcast-dialog-btn confirm">Yayına Başla</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('visible'));

      const cleanup = (result) => {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 200);
        resolve(result);
      };

      overlay.querySelector('.cancel').addEventListener('click', () => {
        cleanup({ cancelled: true });
      });
      overlay.querySelector('.confirm').addEventListener('click', () => {
        const checked = overlay.querySelector('#broadcast-record-checkbox').checked;
        cleanup({ cancelled: false, record: checked });
      });
    });
  },

  /**
   * Start broadcast countdown timer
   */
  _startBroadcastCountdown() {
    this._broadcastStartTime = Date.now();
    this._updateCountdownDisplay();
    this._broadcastTimerInterval = setInterval(() => {
      const elapsed = Date.now() - this._broadcastStartTime;
      const remaining = this._broadcastMaxDurationMs - elapsed;
      if (remaining <= 0) {
        this._stopBroadcastCountdown();
        this.stopBroadcast();
        return;
      }
      this._updateCountdownDisplay();
    }, 1000);
  },

  /**
   * Update countdown display in the broadcast popup
   */
  _updateCountdownDisplay() {
    const el = document.getElementById('broadcast-countdown');
    if (!el) return;
    const elapsed = Date.now() - this._broadcastStartTime;
    const remaining = Math.max(0, this._broadcastMaxDurationMs - elapsed);
    const totalSec = Math.ceil(remaining / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    el.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
    el.classList.toggle('countdown-warning', remaining <= 30000);
  },

  /**
   * Stop broadcast countdown timer
   */
  _stopBroadcastCountdown() {
    if (this._broadcastTimerInterval) {
      clearInterval(this._broadcastTimerInterval);
      this._broadcastTimerInterval = null;
    }
    this._broadcastStartTime = null;
  },

  /**
   * Load active broadcasts from API
   */
  async loadActiveBroadcasts() {
    try {
      const response = await fetch(`${QBitmapConfig.api.base}/api/broadcasts/active`);
      if (!response.ok) return;

      const data = await response.json();
      this.activeBroadcasts.clear();
      for (const b of (data.broadcasts || [])) {
        this.activeBroadcasts.set(b.broadcast_id, b);
      }
      this.updateMapLayer();
    } catch (e) {
      Logger.warn('[LiveBroadcast] Failed to load active broadcasts');
    }
  },

  // ==================== WebSocket Handlers ====================

  handleBroadcastStarted(payload) {
    this.activeBroadcasts.set(payload.broadcastId, {
      broadcast_id: payload.broadcastId,
      user_id: payload.userId,
      display_name: payload.displayName,
      avatar_url: payload.avatarUrl,
      lng: payload.lng,
      lat: payload.lat,
      whep_url: payload.whepUrl,
      started_at: payload.startedAt
    });
    this.updateMapLayer();
  },

  handleBroadcastEnded(payload) {
    this.activeBroadcasts.delete(payload.broadcastId);
    this.updateMapLayer();
    this.closeBroadcastPopup(payload.broadcastId);

    // If timeout, show notification (for own broadcast)
    if (payload.reason === 'timeout' && this.currentBroadcast?.broadcastId === payload.broadcastId) {
      this._stopBroadcastCountdown();
      this.cleanupMediaResources();
      this.isBroadcasting = false;
      this.currentBroadcast = null;
      this._stopping = false;
      const btn = document.getElementById('broadcast-button');
      if (btn) {
        btn.classList.remove('active');
        btn.setAttribute('aria-pressed', 'false');
        btn.title = 'Canlı Yayın';
      }
      showNotification('Yayın süresi doldu (10 dk)', 'info');
    }
  },

  handleRecordingSaved(payload) {
    const user = AuthSystem.getUser ? AuthSystem.getUser() : AuthSystem.user;
    if (user && payload.userId === user.id) {
      showNotification('Yayın kaydı başarıyla kaydedildi', 'success');
    }
  },
};

export { CoreMixin };
