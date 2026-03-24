import '../css/live-broadcast.css';
import { QBitmapConfig } from './config.js';
import { Logger, escapeHtml, showNotification } from './utils.js';
import { AuthSystem } from './auth.js';
import { Analytics } from './analytics.js';
import * as AppState from './state.js';

/**
 * QBitmap Live Broadcast System
 * Handles live video broadcasting from user's device to the map via WHIP
 */

function _hapticBroadcast(style) {
  if (!navigator.vibrate) return;
  const p = { light: 10, medium: 20, heavy: 30, success: [10, 50, 20] };
  navigator.vibrate(p[style] || 10);
}

const LiveBroadcast = {
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
   * Initialize map layer (retry until map is ready)
   */
  initMapLayer() {
    if (AppState.map && AppState.map.isStyleLoaded()) {
      this.addBroadcastLayer(AppState.map);
    } else if (AppState.map) {
      AppState.map.on('load', () => this.addBroadcastLayer(AppState.map));
    } else {
      setTimeout(() => this.initMapLayer(), 500);
    }
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
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: this.currentResolution.width },
          height: { ideal: this.currentResolution.height },
          frameRate: { ideal: 24 },
          facingMode: { ideal: this.currentFacingMode }
        },
        audio: true
      });

      // 2. Get accurate geolocation
      let lng, lat;
      let locationResolved = false;

      try {
        const position = await this._getAccurateLocation();
        lng = position.coords.longitude;
        lat = position.coords.latitude;

        if (position.coords.accuracy <= 25) {
          locationResolved = true;
        } else {
          const choice = await this._showLocationDialog(position.coords.accuracy, lng, lat);
          if (choice) {
            lng = choice.lng;
            lat = choice.lat;
            locationResolved = true;
          }
        }
      } catch {
        // Geolocation failed, will try map pick
      }

      if (!locationResolved) {
        try {
          const picked = await this._pickLocationFromMap();
          lng = picked.lng;
          lat = picked.lat;
        } catch {
          this.cleanupMediaResources();
          return;
        }
      }

      // 3. Call backend to start broadcast
      const startResponse = await fetch(`${this.apiBase}/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lng, lat })
      });

      if (!startResponse.ok) {
        const err = await startResponse.json().catch(() => ({}));
        throw new Error(err.error || `Server error: ${startResponse.status}`);
      }

      const data = await startResponse.json();
      this.currentBroadcast = data.broadcast;

      // 4. Publish via WHIP
      await this.publishWhip(data.broadcast.whipUrl, this.mediaStream);

      Analytics.event('broadcast_start');

      // 5. Update UI
      this.isBroadcasting = true;
      if (btn) {
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        btn.title = 'Canlı Yayını Durdur';
      }

      // 6. Immediately add own broadcast to map (don't wait for WS round-trip)
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

      // 7. Fly map to broadcast location
      if (AppState.map) {
        AppState.map.flyTo({ center: [bc.lng, bc.lat], zoom: Math.max(AppState.map.getZoom(), 14) });
      }

      _hapticBroadcast('success');
      AuthSystem.showNotification('Canlı yayın başladı', 'success');
      Logger.log('[LiveBroadcast] Broadcasting started');

      // 8. Auto-open own broadcast popup (so controls are accessible)
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

    // Stop face detection if active
    this.stopBroadcastFaceDetection();

    // Stop recording if active (best effort)
    if (this.broadcastRecording) {
      fetch(`${this.apiBase}/recording/stop`, { method: 'POST', credentials: 'include' }).catch(() => {});
      this.broadcastRecording = false;
    }

    // Immediately remove own broadcast from map (don't wait for backend)
    if (this.currentBroadcast) {
      this.activeBroadcasts.delete(this.currentBroadcast.broadcastId);
      this.updateMapLayer();
    }

    // Cleanup media first to prevent ICE handler re-triggering
    this.cleanupMediaResources();

    try {
      // Teardown WHIP session
      if (this.whipSessionUrl) {
        try {
          const deleteUrl = `${QBitmapConfig.api.public}/whip-proxy?url=${encodeURIComponent(this.whipSessionUrl)}`;
          await fetch(deleteUrl, { method: 'DELETE', credentials: 'include' });
        } catch (e) {
          Logger.warn('[WHIP] Session teardown failed:', e);
        }
      }

      // Call backend to stop broadcast
      await fetch(`${this.apiBase}/stop`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      Logger.error('[LiveBroadcast] Stop error:', error);
    } finally {
      this.isBroadcasting = false;
      this.currentBroadcast = null;
      this.whipSessionUrl = null;
      this._stopping = false;

      if (btn) {
        btn.classList.remove('active');
        btn.setAttribute('aria-pressed', 'false');
        btn.title = 'Canlı Yayın';
      }

      Logger.log('[LiveBroadcast] Broadcasting stopped');
    }
  },

  /**
   * Synchronous stop for beforeunload (best effort)
   */
  stopBroadcastSync() {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.apiBase}/stop`, false);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send('{}');
    } catch (e) {
      // Best effort
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
  },

  // ==================== Map Integration ====================

  /**
   * Update the broadcasts map layer
   */
  updateMapLayer() {
    const map = AppState.map;
    if (!map) return;

    const geojson = {
      type: 'FeatureCollection',
      features: Array.from(this.activeBroadcasts.values()).map(b => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [b.lng, b.lat] },
        properties: {
          broadcastId: b.broadcast_id,
          displayName: b.display_name || 'User',
          avatarUrl: b.avatar_url || '',
          whepUrl: b.whep_url
        }
      }))
    };

    const source = map.getSource('live-broadcasts');
    if (source) {
      source.setData(geojson);
    }
  },

  /**
   * Add broadcast layer to map
   */
  addBroadcastLayer(map) {
    // Guard: don't add if already exists
    if (map.getSource('live-broadcasts')) {
      this.updateMapLayer();
      return;
    }

    this.loadBroadcastIcon(map, () => {
      // Double-check after async icon load
      if (map.getSource('live-broadcasts')) {
        this.updateMapLayer();
        return;
      }

      map.addSource('live-broadcasts', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      map.addLayer({
        id: 'live-broadcasts',
        type: 'symbol',
        source: 'live-broadcasts',
        layout: {
          'icon-image': 'broadcast-icon-live',
          'icon-size': 0.6,
          'icon-allow-overlap': true
        }
      });

      // Click to watch
      map.on('click', 'live-broadcasts', (e) => {
        if (e.features && e.features.length > 0) {
          const feature = e.features[0];
          const coords = feature.geometry.coordinates.slice();
          const props = feature.properties;

          while (Math.abs(e.lngLat.lng - coords[0]) > 180) {
            coords[0] += e.lngLat.lng > coords[0] ? 360 : -360;
          }

          this.openBroadcastPopup(props, coords);
        }
      });

      map.on('mouseenter', 'live-broadcasts', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'live-broadcasts', () => {
        map.getCanvas().style.cursor = '';
      });

      // Load initial data
      this.updateMapLayer();
    });
  },

  /**
   * Load broadcast icon
   */
  loadBroadcastIcon(map, callback) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="46" height="18" viewBox="0 0 46 18">
        <rect x="0" y="0" width="46" height="18" rx="4" fill="#d93025"/>
        <polygon points="6,4 6,14 13,9" fill="white"/>
        <text x="16" y="13" font-family="Arial,sans-serif" font-size="10" font-weight="bold" fill="white">LIVE</text>
      </svg>
    `;

    const base64 = 'data:image/svg+xml;base64,' + btoa(svg);
    const img = new Image(46, 18);
    img.onload = () => {
      if (!map.hasImage('broadcast-icon-live')) {
        map.addImage('broadcast-icon-live', img);
      }
      callback();
    };
    img.onerror = () => {
      Logger.warn('[LiveBroadcast] Icon load failed, using fallback');
      callback();
    };
    img.src = base64;
  },

  /**
   * Open popup to view a live broadcast
   */
  openBroadcastPopup(props, coordinates) {
    const map = AppState.map;
    if (!map) return;

    Analytics.event('broadcast_view');

    // Close existing broadcast popup
    this.closeBroadcastPopupElement();

    const broadcastId = String(props.broadcastId || '');
    const displayName = props.displayName || 'User';
    const whepUrl = props.whepUrl || '';
    const isLoggedIn = typeof AuthSystem !== 'undefined' && AuthSystem.isLoggedIn();
    const isOwnBroadcast = this.isBroadcasting && this.currentBroadcast && this.currentBroadcast.broadcastId === broadcastId;

    const html = `
      <div class="broadcast-popup-content" data-broadcast-id="${escapeHtml(broadcastId)}">
        <div class="camera-popup-header">
          <div class="camera-popup-title">
            <div class="camera-title-line1">
              <span class="camera-id">${escapeHtml(displayName)}</span>
            </div>
          </div>
          <div class="camera-popup-buttons">
            <button class="cam-btn broadcast-switch-cam-btn" title="Kamerayı Değiştir" aria-label="Kamerayı değiştir" style="display:${isOwnBroadcast ? 'flex' : 'none'};">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="1 4 1 10 7 10"/>
                <polyline points="23 20 23 14 17 14"/>
                <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10"/>
                <path d="M3.51 15A9 9 0 0 0 18.36 18.36L23 14"/>
              </svg>
            </button>
            <button class="cam-btn broadcast-res-btn" title="Çözünürlük" aria-label="Çözünürlük değiştir" style="display:${isOwnBroadcast ? 'flex' : 'none'};">
              <span style="font-size:9px;font-weight:700;">${this.currentResolution.label}</span>
            </button>
            <button class="cam-btn broadcast-ai-analyze-btn" title="AI Analiz" aria-label="AI analiz başlat" style="display:none;">
              <span style="font-weight:900;font-size:11px;letter-spacing:-0.5px;">AI</span>
            </button>
            <button class="cam-btn ai-search-btn broadcast-ai-btn" title="AI Arama (Alan Sec)" aria-label="AI arama modu" style="display:none;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                <path d="M9 11h4M11 9v4" stroke-width="1.5"/>
              </svg>
            </button>
            <button class="cam-btn ai-search-btn broadcast-face-btn" title="Yüz Tanıma" aria-label="Yüz tanıma" style="display:${isLoggedIn ? 'flex' : 'none'};">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="10" r="3"/><path d="M7 21v-2a5 5 0 0 1 10 0v2"/></svg>
            </button>
            <button class="cam-btn record-btn broadcast-rec-btn" title="Kayıt" aria-label="Kayıt başlat" style="display:${isLoggedIn && this.isBroadcasting ? 'flex' : 'none'};">
              <span class="rec-text">REC</span>
            </button>
            <button class="cam-btn audio-btn" title="Ses" aria-label="Sesi aç/kapat">
              <svg class="audio-off" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <line x1="23" y1="9" x2="17" y2="15"></line>
                <line x1="17" y1="9" x2="23" y2="15"></line>
              </svg>
              <svg class="audio-on" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none;">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
              </svg>
            </button>
            <button class="cam-btn close-btn" title="Kapat" aria-label="Yayını kapat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        <div class="camera-popup-body">
          <div class="camera-frame-container whep-container loading zoom-0" style="cursor:zoom-in;">
            <div class="camera-loading">
              <div class="spinner"></div>
              <span>Bağlantı kuruluyor...</span>
            </div>
            <video class="camera-video" autoplay playsinline muted></video>
            <div class="camera-error">Yayın bağlantısı kurulamadı</div>
          </div>
        </div>
      </div>
    `;

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: 'none',
      anchor: 'bottom',
      className: 'camera-popup'
    })
    .setLngLat(coordinates)
    .setHTML(html)
    .addTo(map);

    this.currentPopup = popup;

    // Wire up buttons and start WHEP stream
    setTimeout(() => {
      const popupEl = popup.getElement();
      if (!popupEl) return;

      const closeBtn = popupEl.querySelector('.close-btn');
      if (closeBtn) closeBtn.onclick = () => this.closeBroadcastPopupElement();

      const audioBtn = popupEl.querySelector('.audio-btn');
      const videoEl = popupEl.querySelector('.camera-video');
      if (audioBtn && videoEl) {
        audioBtn.onclick = () => {
          videoEl.muted = !videoEl.muted;
          audioBtn.querySelector('.audio-on').style.display = videoEl.muted ? 'none' : 'block';
          audioBtn.querySelector('.audio-off').style.display = videoEl.muted ? 'block' : 'none';
        };
      }

      // Camera switch button (own broadcast only)
      const switchCamBtn = popupEl.querySelector('.broadcast-switch-cam-btn');
      if (switchCamBtn) {
        switchCamBtn.onclick = () => this.switchCamera();
      }

      // Resolution button (own broadcast only)
      const resBtn = popupEl.querySelector('.broadcast-res-btn');
      if (resBtn) {
        resBtn.onclick = () => this.toggleResolutionDropdown(resBtn);
      }

      // AI Search button
      const aiBtn = popupEl.querySelector('.broadcast-ai-btn');
      if (aiBtn) {
        aiBtn.onclick = () => this.toggleBroadcastAiSearch(popupEl);
      }

      // AI Analyze button (periodic single-frame analysis)
      const aiAnalyzeBtn = popupEl.querySelector('.broadcast-ai-analyze-btn');
      if (aiAnalyzeBtn) {
        aiAnalyzeBtn.onclick = () => this.toggleBroadcastAiAnalyze(popupEl);
      }

      // Face Detection button
      const faceBtn = popupEl.querySelector('.broadcast-face-btn');
      if (faceBtn) {
        this._faceDetectionBtn = faceBtn;
        faceBtn.onclick = () => this.toggleBroadcastFaceDetection(faceBtn, popupEl);
      }

      // Recording button
      const recBtn = popupEl.querySelector('.broadcast-rec-btn');
      if (recBtn) {
        recBtn.onclick = () => this.toggleBroadcastRecording(recBtn);
        // Check current recording status
        if (this.isBroadcasting) {
          this.checkBroadcastRecordingStatus(recBtn);
        }
      }

      // Zoom: double-click on video to cycle zoom-0 <-> zoom-1
      const frameContainer = popupEl.querySelector('.camera-frame-container');
      if (frameContainer) {
        this._popupZoomLevel = 0;
        frameContainer.ondblclick = () => this.cycleBroadcastZoom(popupEl);
        // Double-tap for mobile
        let lastTapFrame = 0;
        frameContainer.addEventListener('touchend', (e) => {
          if (this._aiSearchMode) return;
          const now = Date.now();
          if (now - lastTapFrame < 300) {
            e.preventDefault();
            this.cycleBroadcastZoom(popupEl);
          }
          lastTapFrame = now;
        }, { passive: false });
      }

      // Zoom: double-click on header to cycle zoom-1 -> zoom-2 -> zoom-0
      const header = popupEl.querySelector('.camera-popup-header');
      if (header) {
        header.ondblclick = (e) => {
          if (e.target.closest('button')) return;
          this.cycleBroadcastToZoom2(popupEl);
        };
        // Double-tap for mobile
        let lastTapHeader = 0;
        header.addEventListener('touchend', (e) => {
          if (e.target.closest('button')) return;
          const now = Date.now();
          if (now - lastTapHeader < 300) {
            e.preventDefault();
            this.cycleBroadcastToZoom2(popupEl);
          }
          lastTapHeader = now;
        }, { passive: false });
      }

      if (whepUrl) {
        this.startWhepPlayback(popupEl, whepUrl);
      }
    }, 0);
  },

  /**
   * Start WHEP playback in a broadcast popup
   */
  async startWhepPlayback(popupEl, whepUrl) {
    const frameContainer = popupEl.querySelector('.camera-frame-container');
    const videoEl = popupEl.querySelector('.camera-video');
    if (!frameContainer || !videoEl || !whepUrl) return;

    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      this.viewerPeerConnection = pc;

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          videoEl.srcObject = event.streams[0];
          frameContainer.classList.remove('loading', 'error');
          frameContainer.classList.add('loaded');
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') {
          frameContainer.classList.remove('loading', 'loaded');
          frameContainer.classList.add('error');
        }
      };

      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering
      await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') resolve();
        else {
          const check = () => {
            if (pc.iceGatheringState === 'complete') {
              pc.removeEventListener('icegatheringstatechange', check);
              resolve();
            }
          };
          pc.addEventListener('icegatheringstatechange', check);
          setTimeout(resolve, 3000);
        }
      });

      // Use proxy for HTTP WHEP URLs
      let fetchUrl = whepUrl;
      if (whepUrl.startsWith('http://')) {
        fetchUrl = `${QBitmapConfig.api.public}/whep-proxy?url=${encodeURIComponent(whepUrl)}`;
      }

      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp
      });

      if (!response.ok) throw new Error(`WHEP failed: ${response.status}`);

      const answerSdp = await response.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    } catch (error) {
      Logger.error('[LiveBroadcast] WHEP playback error:', error);
      frameContainer.classList.remove('loading', 'loaded');
      frameContainer.classList.add('error');
    }
  },

  /**
   * Close broadcast popup element
   */
  closeBroadcastPopupElement() {
    // Cleanup AI search mode
    if (this._aiSearchMode && this.currentPopup) {
      const popupEl = this.currentPopup.getElement();
      if (popupEl) this.exitBroadcastAiSearch(popupEl);
    }
    this.dismissBroadcastAiCard();

    // Cleanup AI analyze
    if (this._broadcastAiAnalyzeActive && this.currentPopup) {
      const popupEl = this.currentPopup.getElement();
      if (popupEl) this.stopBroadcastAiAnalyze(popupEl);
    }

    // Cleanup face detection
    this.stopBroadcastFaceDetection();

    if (this.viewerPeerConnection) {
      try { this.viewerPeerConnection.close(); } catch (e) {}
      this.viewerPeerConnection = null;
    }
    if (this.currentPopup) {
      this.currentPopup.remove();
      this.currentPopup = null;
    }
  },

  /**
   * Close popup for a specific broadcast by ID
   */
  closeBroadcastPopup(broadcastId) {
    if (this.currentPopup) {
      const el = this.currentPopup.getElement();
      if (el && el.querySelector(`[data-broadcast-id="${broadcastId}"]`)) {
        this.closeBroadcastPopupElement();
      }
    }
  },

  // ==================== Camera Switch ====================

  /**
   * Switch between front and back camera during broadcast
   */
  async switchCamera() {
    if (!this.isBroadcasting || !this.peerConnection || !this.mediaStream) return;
    if (this.broadcastRecording) {
      if (typeof AuthSystem !== 'undefined') AuthSystem.showNotification('Kayıt sırasında kamera değiştirilemez', 'error');
      return;
    }

    const switchBtn = this._cameraSwitchBtn;
    if (switchBtn) switchBtn.disabled = true;

    try {
      const newMode = this.currentFacingMode === 'environment' ? 'user' : 'environment';

      const newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: this.currentResolution.width },
          height: { ideal: this.currentResolution.height },
          frameRate: { ideal: 24 },
          facingMode: { exact: newMode }
        },
        audio: false
      });

      const newVideoTrack = newStream.getVideoTracks()[0];

      // Replace video track in PeerConnection
      const sender = this.peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
      }

      // Stop old video track and swap in stream
      const oldVideoTrack = this.mediaStream.getVideoTracks()[0];
      if (oldVideoTrack) {
        oldVideoTrack.stop();
        this.mediaStream.removeTrack(oldVideoTrack);
      }
      this.mediaStream.addTrack(newVideoTrack);

      this.currentFacingMode = newMode;
      Logger.log('[LiveBroadcast] Camera switched to', newMode);

    } catch (error) {
      Logger.error('[LiveBroadcast] Camera switch failed:', error);
      AuthSystem.showNotification('Kamera değiştirilemedi', 'error');
    } finally {
      if (switchBtn) switchBtn.disabled = false;
    }
  },

  /**
   * Show camera switch button during broadcast
   */
  showCameraSwitchButton() {
    if (this._cameraSwitchBtn) return;

    const btn = document.createElement('button');
    btn.className = 'mic-button-right';
    btn.id = 'camera-switch-button';
    btn.title = 'Kamerayı Değiştir';
    btn.setAttribute('aria-label', 'Kamerayı değiştir');
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="1 4 1 10 7 10"/>
        <polyline points="23 20 23 14 17 14"/>
        <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10"/>
        <path d="M3.51 15A9 9 0 0 0 18.36 18.36L23 14"/>
      </svg>
    `;
    btn.addEventListener('click', () => this.switchCamera());
    this._cameraSwitchBtn = btn;

    const floatContainer = document.getElementById('broadcast-float-controls');
    if (floatContainer) {
      floatContainer.appendChild(btn);
    } else {
      const broadcastBtn = document.getElementById('broadcast-button');
      if (broadcastBtn && broadcastBtn.parentNode) {
        broadcastBtn.parentNode.insertBefore(btn, broadcastBtn.nextSibling);
      }
    }
  },

  /**
   * Hide camera switch button
   */
  hideCameraSwitchButton() {
    if (this._cameraSwitchBtn) {
      this._cameraSwitchBtn.remove();
      this._cameraSwitchBtn = null;
    }
  },

  // ==================== Popup Zoom ====================

  /**
   * Double-click on video: cycle zoom-0 <-> zoom-1
   */
  cycleBroadcastZoom(popupEl) {
    // Don't zoom if AI search mode is active
    if (this._aiSearchMode) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    if (!frameContainer) return;

    this._popupZoomLevel = this._popupZoomLevel === 0 ? 1 : 0;
    const level = this._popupZoomLevel;

    frameContainer.classList.remove('zoom-0', 'zoom-1', 'zoom-2');
    frameContainer.classList.add(`zoom-${level}`);
    frameContainer.style.cursor = level === 0 ? 'zoom-in' : 'zoom-out';

    this.updateBroadcastAiButtonVisibility(popupEl);
    Logger.log(`[LiveBroadcast] Popup zoom: ${level === 0 ? '320x180' : '640x360'}`);
  },

  /**
   * Double-click on header: cycle zoom-1 -> zoom-2 -> zoom-0
   */
  cycleBroadcastToZoom2(popupEl) {
    const frameContainer = popupEl.querySelector('.camera-frame-container');
    if (!frameContainer) return;

    if (this._popupZoomLevel === 1) {
      this._popupZoomLevel = 2;
    } else if (this._popupZoomLevel === 2) {
      this._popupZoomLevel = 0;
      // Exit AI search mode when zooming out
      if (this._aiSearchMode) this.exitBroadcastAiSearch(popupEl);
    } else {
      return; // zoom-0: need to go to zoom-1 first via video dblclick
    }

    const level = this._popupZoomLevel;

    frameContainer.classList.remove('zoom-0', 'zoom-1', 'zoom-2');
    frameContainer.classList.add(`zoom-${level}`);
    frameContainer.style.cursor = level === 0 ? 'zoom-in' : 'zoom-out';

    this.updateBroadcastAiButtonVisibility(popupEl);
    Logger.log(`[LiveBroadcast] Popup zoom: ${level === 0 ? '320x180' : level === 1 ? '640x360' : '1280x720'}`);
  },

  /**
   * Show/hide AI buttons based on zoom level (visible at zoom >= 1)
   */
  updateBroadcastAiButtonVisibility(popupEl) {
    const aiSearchBtn = popupEl?.querySelector('.broadcast-ai-btn');
    const aiAnalyzeBtn = popupEl?.querySelector('.broadcast-ai-analyze-btn');
    const level = this._popupZoomLevel || 0;

    if (level >= 1) {
      if (aiSearchBtn) aiSearchBtn.style.display = 'flex';
      if (aiAnalyzeBtn) aiAnalyzeBtn.style.display = 'flex';
    } else {
      if (aiSearchBtn) aiSearchBtn.style.display = 'none';
      if (aiAnalyzeBtn) aiAnalyzeBtn.style.display = 'none';
      // Exit AI search mode when hiding button
      if (this._aiSearchMode) this.exitBroadcastAiSearch(popupEl);
      // Stop AI analyze when hiding button
      if (this._broadcastAiAnalyzeActive) this.stopBroadcastAiAnalyze(popupEl);
    }
  },

  // ==================== AI Search ====================

  toggleBroadcastAiSearch(popupEl) {
    if (this._aiSearchMode) {
      this.exitBroadcastAiSearch(popupEl);
    } else {
      this.enterBroadcastAiSearch(popupEl);
    }
  },

  enterBroadcastAiSearch(popupEl) {
    const aiBtn = popupEl.querySelector('.broadcast-ai-btn');
    const frameContainer = popupEl.querySelector('.camera-frame-container');
    const videoEl = popupEl.querySelector('.camera-video');
    if (!aiBtn || !frameContainer || !videoEl) return;

    this._aiSearchMode = true;
    aiBtn.classList.add('active');
    frameContainer.classList.add('ai-search-mode');
    frameContainer.style.cursor = 'crosshair';

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'ai-search-overlay';
    overlay.innerHTML = '<div class="ai-search-rect"></div>';
    frameContainer.appendChild(overlay);

    // Mouse handlers
    this._aiSearchMouseDown = (e) => this.handleBroadcastAiMouseDown(popupEl, e);
    this._aiSearchMouseMove = (e) => this.handleBroadcastAiMouseMove(popupEl, e);
    this._aiSearchMouseUp = (e) => this.handleBroadcastAiMouseUp(popupEl, e);

    videoEl.addEventListener('mousedown', this._aiSearchMouseDown);
    document.addEventListener('mousemove', this._aiSearchMouseMove);
    document.addEventListener('mouseup', this._aiSearchMouseUp);

    // Touch handlers for mobile
    this._aiSearchTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const t = e.touches[0];
      this.handleBroadcastAiMouseDown(popupEl, { clientX: t.clientX, clientY: t.clientY, preventDefault() {}, stopPropagation() {} });
    };
    this._aiSearchTouchMove = (e) => {
      if (!this._aiSearchSelection?.isDrawing) return;
      e.preventDefault();
      const t = e.touches[0];
      this.handleBroadcastAiMouseMove(popupEl, { clientX: t.clientX, clientY: t.clientY });
    };
    this._aiSearchTouchEnd = (e) => {
      this.handleBroadcastAiMouseUp(popupEl, e);
    };

    videoEl.addEventListener('touchstart', this._aiSearchTouchStart, { passive: false });
    document.addEventListener('touchmove', this._aiSearchTouchMove, { passive: false });
    document.addEventListener('touchend', this._aiSearchTouchEnd);
  },

  exitBroadcastAiSearch(popupEl) {
    this._aiSearchMode = false;
    this._aiSearchSelection = null;

    const aiBtn = popupEl.querySelector('.broadcast-ai-btn');
    const frameContainer = popupEl.querySelector('.camera-frame-container');
    const videoEl = popupEl.querySelector('.camera-video');

    if (aiBtn) aiBtn.classList.remove('active');
    if (frameContainer) {
      frameContainer.classList.remove('ai-search-mode');
      frameContainer.style.cursor = '';
    }

    // Remove overlay
    const overlay = popupEl.querySelector('.ai-search-overlay');
    if (overlay) overlay.remove();

    // Remove listeners
    if (videoEl && this._aiSearchMouseDown) {
      videoEl.removeEventListener('mousedown', this._aiSearchMouseDown);
    }
    if (this._aiSearchMouseMove) {
      document.removeEventListener('mousemove', this._aiSearchMouseMove);
    }
    if (this._aiSearchMouseUp) {
      document.removeEventListener('mouseup', this._aiSearchMouseUp);
    }
    // Remove touch listeners
    if (videoEl && this._aiSearchTouchStart) {
      videoEl.removeEventListener('touchstart', this._aiSearchTouchStart);
    }
    if (this._aiSearchTouchMove) {
      document.removeEventListener('touchmove', this._aiSearchTouchMove);
    }
    if (this._aiSearchTouchEnd) {
      document.removeEventListener('touchend', this._aiSearchTouchEnd);
    }

    this.dismissBroadcastAiCard();
  },

  handleBroadcastAiMouseDown(popupEl, e) {
    if (!this._aiSearchMode) return;
    e.preventDefault();
    e.stopPropagation();

    const videoEl = popupEl.querySelector('.camera-video');
    const rect = videoEl.getBoundingClientRect();

    this._aiSearchSelection = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      endX: e.clientX - rect.left,
      endY: e.clientY - rect.top,
      isDrawing: true,
      videoRect: rect
    };
    this.updateBroadcastAiRect(popupEl);
  },

  handleBroadcastAiMouseMove(popupEl, e) {
    if (!this._aiSearchSelection?.isDrawing) return;
    const { videoRect } = this._aiSearchSelection;
    this._aiSearchSelection.endX = Math.max(0, Math.min(videoRect.width, e.clientX - videoRect.left));
    this._aiSearchSelection.endY = Math.max(0, Math.min(videoRect.height, e.clientY - videoRect.top));
    this.updateBroadcastAiRect(popupEl);
  },

  handleBroadcastAiMouseUp(popupEl, e) {
    if (!this._aiSearchSelection?.isDrawing) return;
    this._aiSearchSelection.isDrawing = false;

    const { startX, startY, endX, endY } = this._aiSearchSelection;
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    if (width >= 50 && height >= 50) {
      this.processBroadcastAiSelection(popupEl);
    } else {
      const rectEl = popupEl.querySelector('.ai-search-rect');
      if (rectEl) rectEl.style.display = 'none';
    }
  },

  updateBroadcastAiRect(popupEl) {
    if (!this._aiSearchSelection) return;
    const rectEl = popupEl.querySelector('.ai-search-rect');
    if (!rectEl) return;

    const { startX, startY, endX, endY, videoRect } = this._aiSearchSelection;
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    rectEl.style.left = (left / videoRect.width * 100) + '%';
    rectEl.style.top = (top / videoRect.height * 100) + '%';
    rectEl.style.width = (width / videoRect.width * 100) + '%';
    rectEl.style.height = (height / videoRect.height * 100) + '%';
    rectEl.style.display = 'block';
  },

  async processBroadcastAiSelection(popupEl) {
    if (!this._aiSearchSelection) return;
    const videoEl = popupEl.querySelector('.camera-video');
    if (!videoEl) return;

    const { startX, startY, endX, endY, videoRect } = this._aiSearchSelection;
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    const scaleX = videoEl.videoWidth / videoRect.width;
    const scaleY = videoEl.videoHeight / videoRect.height;

    const canvas = document.createElement('canvas');
    canvas.width = width * scaleX;
    canvas.height = height * scaleY;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoEl, left * scaleX, top * scaleY, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);

    const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];

    this.showBroadcastAiCard({ loading: true }, popupEl);
    await this.sendBroadcastAiSearch(base64, popupEl);
  },

  async sendBroadcastAiSearch(base64, popupEl) {
    const aiSettings = (typeof CameraSystem !== 'undefined' && CameraSystem.aiSettings) || {};
    const searchPrompt = aiSettings.searchPrompt || 'bu resimde ne görüyorsun maksimum birkaç cümle ile açıkla ve sadece emin olduklarını yaz';

    try {
      const response = await fetch(`${QBitmapConfig.api.ai}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: aiSettings.model || 'qwen3-vl:32b-instruct',
          prompt: searchPrompt,
          images: [base64],
          stream: false,
          options: {
            num_predict: aiSettings.maxTokens || 1024,
            temperature: aiSettings.temperature || 0.7
          }
        })
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      let responseText = data.response || '';
      responseText = responseText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      this.showBroadcastAiCard({ loading: false, success: true, response: responseText }, popupEl);
    } catch (error) {
      Logger.error('[AISearch] API error:', error);
      this.showBroadcastAiCard({ loading: false, error: true, message: error.message }, popupEl);
    }
  },

  showBroadcastAiCard(options, popupEl) {
    const { loading, success, error, response, message } = options;
    this.dismissBroadcastAiCard();

    if (!popupEl) return;

    const card = document.createElement('div');
    card.id = 'broadcast-ai-card';
    card.className = 'ai-search-card';

    const escText = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

    if (loading) {
      card.innerHTML = `
        <div class="asc-header"><span class="asc-title">AI</span><span>Analiz</span></div>
        <div class="asc-body asc-loading"><div class="asc-spinner"></div><span>Analiz ediliyor...</span></div>
      `;
    } else if (error) {
      card.innerHTML = `
        <div class="asc-header asc-error-header"><span class="asc-title">AI</span><span>Hata</span><button class="asc-close">&times;</button></div>
        <div class="asc-body"><p class="asc-error-text">${escText(message || 'Analiz tamamlanamadı')}</p></div>
      `;
    } else {
      card.innerHTML = `
        <div class="asc-header"><span class="asc-title">AI</span><span>Analiz</span><button class="asc-close">&times;</button></div>
        <div class="asc-body"><p class="asc-response">${escText(response || '')}</p></div>
      `;
    }

    document.body.appendChild(card);

    // Position card
    card.style.position = 'fixed';
    if (window.innerWidth < 700) {
      // Mobile: bottom sheet style
      card.style.left = '8px';
      card.style.right = '8px';
      card.style.bottom = '8px';
      card.style.top = 'auto';
      card.style.width = 'auto';
      card.style.maxWidth = 'none';
      card.style.maxHeight = '40vh';
      card.style.overflowY = 'auto';
    } else {
      // Desktop: to right of popup
      const popupRect = popupEl.getBoundingClientRect();
      card.style.left = (popupRect.right + 10) + 'px';
      card.style.top = popupRect.top + 'px';

      requestAnimationFrame(() => {
        const cardRect = card.getBoundingClientRect();
        if (cardRect.right > window.innerWidth - 10) {
          card.style.left = (popupRect.left - cardRect.width - 10) + 'px';
        }
        if (cardRect.bottom > window.innerHeight - 10) {
          card.style.top = (window.innerHeight - cardRect.height - 10) + 'px';
        }
      });
    }

    const closeBtn = card.querySelector('.asc-close');
    if (closeBtn) closeBtn.onclick = () => this.dismissBroadcastAiCard();

    if (!loading) {
      if (this._aiSearchCardTimeout) clearTimeout(this._aiSearchCardTimeout);
      this._aiSearchCardTimeout = setTimeout(() => this.dismissBroadcastAiCard(), 20000);
    }
  },

  dismissBroadcastAiCard() {
    const card = document.getElementById('broadcast-ai-card');
    if (card) card.remove();
    if (this._aiSearchCardTimeout) {
      clearTimeout(this._aiSearchCardTimeout);
      this._aiSearchCardTimeout = null;
    }
    // Clear selection rect
    const rectEl = document.querySelector('.broadcast-popup-content .ai-search-rect');
    if (rectEl) rectEl.style.display = 'none';
  },

  // ==================== AI Analyze (Periodic) ====================

  toggleBroadcastAiAnalyze(popupEl) {
    if (this._broadcastAiAnalyzeActive) {
      this.stopBroadcastAiAnalyze(popupEl);
    } else {
      this.startBroadcastAiAnalyze(popupEl);
    }
  },

  async startBroadcastAiAnalyze(popupEl) {
    this._broadcastAiAnalyzeActive = true;

    const btn = popupEl?.querySelector('.broadcast-ai-analyze-btn');
    if (btn) {
      btn.classList.add('ai-analyzing');
      btn.title = 'AI Analiz Durdur';
    }

    // Get interval from global AI settings (broadcast has no per-camera settings)
    const intervalMs = 3000;

    // Show initial loading card
    this.showBroadcastAiAnalyzeCard(popupEl, { loading: true });

    // Run first analysis immediately
    await this.doBroadcastAiAnalyzeFrame(popupEl);

    // Start periodic interval
    if (this._broadcastAiAnalyzeActive) {
      this._broadcastAiAnalyzeIntervalId = setInterval(() => this.doBroadcastAiAnalyzeFrame(popupEl), intervalMs);
      Logger.log(`[LiveBroadcast] AI Analyze started (interval: ${intervalMs}ms)`);
    }
  },

  stopBroadcastAiAnalyze(popupEl) {
    this._broadcastAiAnalyzeActive = false;

    if (this._broadcastAiAnalyzeIntervalId) {
      clearInterval(this._broadcastAiAnalyzeIntervalId);
      this._broadcastAiAnalyzeIntervalId = null;
    }

    if (this._broadcastAiTypewriteTimer) {
      clearInterval(this._broadcastAiTypewriteTimer);
      this._broadcastAiTypewriteTimer = null;
    }

    const btn = popupEl?.querySelector('.broadcast-ai-analyze-btn');
    if (btn) {
      btn.classList.remove('ai-analyzing');
      btn.title = 'AI Analiz';
    }

    this.dismissBroadcastAiAnalyzeCard(popupEl);
    Logger.log('[LiveBroadcast] AI Analyze stopped');
  },

  async doBroadcastAiAnalyzeFrame(popupEl) {
    if (!this._broadcastAiAnalyzeActive) return;
    if (this._broadcastAiAnalyzeProcessing) return;
    this._broadcastAiAnalyzeProcessing = true;

    const videoEl = popupEl?.querySelector('.camera-video');

    try {
      if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) {
        this.showBroadcastAiAnalyzeCard(popupEl, { error: true, message: 'Frame yakalanamadi' });
        return;
      }

      // Capture frame
      const canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      canvas.getContext('2d').drawImage(videoEl, 0, 0);
      const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];

      // Use global AI settings
      const aiSettings = (typeof CameraSystem !== 'undefined' && CameraSystem.aiSettings) || {};

      const response = await fetch(`${QBitmapConfig.api.ai}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: aiSettings.model || 'qwen3-vl:32b-instruct',
          prompt: aiSettings.monitoringPrompt || aiSettings.searchPrompt || 'Bu goruntuyu analiz et ve onemli olan her seyi bildir.',
          images: [base64],
          stream: false,
          options: {
            num_predict: aiSettings.maxTokens || 1024,
            temperature: aiSettings.temperature || 0.7
          }
        })
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      let responseText = data.response || '';
      responseText = responseText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      // Try to parse structured response
      let parsed = null;
      if (typeof CameraSystem !== 'undefined' && CameraSystem.parseOllamaResponse) {
        parsed = CameraSystem.parseOllamaResponse(responseText);
      }

      if (parsed?.alarm) {
        this.showBroadcastAiAnalyzeCard(popupEl, {
          alarm: true,
          text: parsed.tasvir || responseText,
          confidence: parsed.confidence
        });
      } else {
        this.showBroadcastAiAnalyzeCard(popupEl, {
          success: true,
          text: parsed?.tasvir || responseText,
          confidence: parsed?.confidence
        });
      }
    } catch (error) {
      Logger.error('[LiveBroadcast] AI Analyze error:', error);
      this.showBroadcastAiAnalyzeCard(popupEl, { error: true, message: error.message });
    } finally {
      this._broadcastAiAnalyzeProcessing = false;
    }
  },

  showBroadcastAiAnalyzeCard(popupEl, options) {
    const { loading, success, alarm, error, text, message, confidence } = options;

    const popupContent = popupEl?.querySelector('.broadcast-popup-content');
    if (!popupContent) return;

    // Remove existing card
    const existing = popupContent.querySelector('.ai-analyze-card');
    if (existing) existing.remove();

    const card = document.createElement('div');
    card.className = 'ai-analyze-card';

    const escText = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

    if (loading) {
      card.innerHTML = `
        <div class="aac-header"><span class="aac-title">AI</span><span>Analiz</span></div>
        <div class="aac-body aac-loading"><div class="asc-spinner"></div><span>AI analiz ediliyor...</span></div>
      `;
    } else if (error) {
      card.innerHTML = `
        <div class="aac-header aac-error-header"><span class="aac-title">AI</span><span>Hata</span></div>
        <div class="aac-body"><p class="aac-error-text">${escText(message || 'Analiz tamamlanamadi')}</p></div>
      `;
    } else if (alarm) {
      card.innerHTML = `
        <div class="aac-header aac-alarm-header"><span class="aac-title">AI</span><span class="aac-badge aac-badge-alarm">ALARM${confidence ? ` (${confidence}%)` : ''}</span></div>
        <div class="aac-body"><p class="aac-response aac-alarm-text"></p></div>
      `;
    } else {
      card.innerHTML = `
        <div class="aac-header"><span class="aac-title">AI</span><span class="aac-badge aac-badge-ok">OK${confidence ? ` (${confidence}%)` : ''}</span></div>
        <div class="aac-body"><p class="aac-response"></p></div>
      `;
    }

    popupContent.appendChild(card);

    // Typewriter effect for success/alarm text
    if ((success || alarm) && text) {
      const responseEl = card.querySelector('.aac-response');
      if (responseEl) {
        this.typewriteBroadcastAiResponse(responseEl, escText(text));
      }
    }
  },

  typewriteBroadcastAiResponse(element, text) {
    if (this._broadcastAiTypewriteTimer) {
      clearInterval(this._broadcastAiTypewriteTimer);
      this._broadcastAiTypewriteTimer = null;
    }

    let charIndex = 0;
    const cursor = document.createElement('span');
    cursor.className = 'aac-cursor';
    element.textContent = '';
    element.appendChild(cursor);

    this._broadcastAiTypewriteTimer = setInterval(() => {
      if (charIndex >= text.length || !element.isConnected) {
        clearInterval(this._broadcastAiTypewriteTimer);
        this._broadcastAiTypewriteTimer = null;
        cursor.remove();
        return;
      }
      cursor.before(text[charIndex]);
      charIndex++;
    }, 20);
  },

  dismissBroadcastAiAnalyzeCard(popupEl) {
    if (popupEl) {
      const card = popupEl.querySelector('.ai-analyze-card');
      if (card) card.remove();
    }
  },

  // ==================== Face Detection ====================

  toggleBroadcastFaceDetection(btn, popupEl) {
    if (this.faceDetectionActive) {
      this.stopBroadcastFaceDetection();
    } else {
      this.startBroadcastFaceDetection(btn, popupEl);
    }
  },

  async startBroadcastFaceDetection(btn, popupEl) {
    try {
      // Load user's faces
      const response = await fetch(`${this.apiBase}/faces`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load faces');
      const data = await response.json();
      this.faceDetectionFaces = data.faces || [];

      if (this.faceDetectionFaces.length === 0) {
        AuthSystem.showNotification('Kayıtlı yüz bulunamadı. Önce kamera ayarlarından yüz ekleyin.', 'error');
        return;
      }

      this.faceDetectionActive = true;
      if (btn) btn.classList.add('active');

      // Start interval (10 seconds)
      this.faceDetectionInterval = setInterval(() => {
        this.processBroadcastFaceDetection(popupEl);
      }, 10000);

      // Run first detection after 3 seconds
      setTimeout(() => this.processBroadcastFaceDetection(popupEl), 3000);

      Logger.log('[FaceDetection] Started on broadcast');
    } catch (error) {
      Logger.error('[FaceDetection] Start error:', error);
      AuthSystem.showNotification('Yüz tanıma başlatılamadı', 'error');
    }
  },

  stopBroadcastFaceDetection() {
    if (this.faceDetectionInterval) {
      clearInterval(this.faceDetectionInterval);
      this.faceDetectionInterval = null;
    }
    this.faceDetectionActive = false;
    this._lastFaceDetection = null;

    if (this._faceDetectionBtn) {
      this._faceDetectionBtn.classList.remove('active');
    }
    Logger.log('[FaceDetection] Stopped on broadcast');
  },

  async processBroadcastFaceDetection(popupEl) {
    if (!this.faceDetectionActive || !popupEl) return;

    const videoEl = popupEl.querySelector('.camera-video');
    if (!videoEl || videoEl.videoWidth === 0) return;

    try {
      // Capture frame from video
      const canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(videoEl, 0, 0);

      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      if (!blob) return;

      const formData = new FormData();
      formData.append('image', blob, 'frame.jpg');

      const response = await fetch(`${this.apiBase}/face-recognize`, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      if (!response.ok) return;

      const result = await response.json();

      if (result.success && Array.isArray(result.result) && result.result.length > 0) {
        for (const match of result.result) {
          if (!match.isMatchFound || match.score < 70) continue;

          // Find face in loaded faces (same logic as face-detection.js)
          let matchedFace = this.faceDetectionFaces.find(f =>
            f.name?.localeCompare(match.name, 'tr', { sensitivity: 'base' }) === 0
          );
          if (!matchedFace && this.faceDetectionFaces.length === 1) {
            matchedFace = this.faceDetectionFaces[0];
          }
          if (!matchedFace) {
            const matchFirstName = match.name?.split(' ')[0]?.toLowerCase();
            matchedFace = this.faceDetectionFaces.find(f => {
              const faceFirstName = f.name?.split(' ')[0]?.toLowerCase();
              return matchFirstName && faceFirstName && matchFirstName === faceFirstName;
            });
          }

          const faceName = matchedFace?.name || match.name || 'Bilinmeyen';

          // 30s cooldown
          const now = Date.now();
          const lastKey = `broadcast_${faceName}`;
          if (this._lastFaceDetection?.key === lastKey && (now - this._lastFaceDetection.time) < 30000) {
            continue;
          }
          this._lastFaceDetection = { key: lastKey, time: now };

          // Only alert if trigger_alarm is enabled (or no trigger_alarm field)
          if (matchedFace && matchedFace.trigger_alarm === 0) continue;

          const faceImageUrl = matchedFace?.face_image_url || null;
          this.showBroadcastFaceAlert(faceName, match.score, faceImageUrl);
        }
      }
    } catch (error) {
      Logger.error('[FaceDetection] Process error:', error);
    }
  },

  showBroadcastFaceAlert(faceName, confidence, faceImageUrl) {
    // Play alarm sound
    if (typeof CameraSystem !== 'undefined' && typeof CameraSystem.playAlarmSound === 'function') {
      CameraSystem.playAlarmSound();
    }

    let alertEl = document.getElementById('face-detection-alert');
    if (!alertEl) {
      alertEl = document.createElement('div');
      alertEl.id = 'face-detection-alert';
      alertEl.className = 'face-detection-alert';
      document.body.appendChild(alertEl);
    }

    const escHtml = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

    alertEl.innerHTML = `
      <div class="face-alert-content">
        <div class="face-alert-image" id="face-alert-image-container"></div>
        <div class="face-alert-info">
          <div class="face-alert-label">YÜZ ALGILANDI</div>
          <div class="face-alert-name">${escHtml(faceName)}</div>
          <div class="face-alert-camera">Canlı Yayın</div>
          <div class="face-alert-confidence">Eşleşme Skoru: ${Math.round(confidence)}</div>
        </div>
        <button class="face-alert-close">&times;</button>
      </div>
    `;

    alertEl.querySelector('.face-alert-close').onclick = () => alertEl.classList.remove('show');

    const imageContainer = alertEl.querySelector('#face-alert-image-container');
    if (faceImageUrl) {
      const img = document.createElement('img');
      img.src = faceImageUrl;
      img.alt = faceName;
      img.className = 'face-alert-thumb';
      img.onerror = () => {
        imageContainer.innerHTML = '<div class="face-alert-icon-fallback"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4 4-6 8-6s8 2 8 6"></path></svg></div>';
      };
      imageContainer.appendChild(img);
    } else {
      imageContainer.innerHTML = '<div class="face-alert-icon-fallback"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4 4-6 8-6s8 2 8 6"></path></svg></div>';
    }

    alertEl.classList.add('show');

    setTimeout(() => alertEl.classList.remove('show'), 30000);

    Logger.log(`[FaceDetection] Alert: ${faceName} detected on broadcast (${confidence}%)`);
  },

  // ==================== Recording ====================

  async toggleBroadcastRecording(btn) {
    if (this.broadcastRecording) {
      await this.stopBroadcastRecordingAction(btn);
    } else {
      await this.startBroadcastRecordingAction(btn);
    }
  },

  async startBroadcastRecordingAction(btn) {
    try {
      const response = await fetch(`${this.apiBase}/recording/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Recording start failed');
      }

      this.broadcastRecording = true;
      if (btn) btn.classList.add('recording');
      Logger.log('[Recording] Broadcast recording started');
    } catch (error) {
      Logger.error('[Recording] Start error:', error);
      AuthSystem.showNotification(error.message || 'Kayıt başlatılamadı', 'error');
    }
  },

  async stopBroadcastRecordingAction(btn) {
    try {
      await fetch(`${this.apiBase}/recording/stop`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });

      this.broadcastRecording = false;
      if (btn) btn.classList.remove('recording');
      Logger.log('[Recording] Broadcast recording stopped');
    } catch (error) {
      Logger.error('[Recording] Stop error:', error);
    }
  },

  async checkBroadcastRecordingStatus(btn) {
    try {
      const response = await fetch(`${this.apiBase}/recording/status`, {
        credentials: 'include'
      });
      if (!response.ok) return;

      const data = await response.json();
      if (data.isRecording) {
        this.broadcastRecording = true;
        if (btn) btn.classList.add('recording');
      }
    } catch (e) {
      // ignore
    }
  },

  // ==================== Resolution Selector ====================

  showResolutionButton() {
    if (this._resolutionBtn) return;

    const btn = document.createElement('button');
    btn.className = 'mic-button-right';
    btn.id = 'resolution-button';
    btn.title = 'Çözünürlük';
    btn.setAttribute('aria-label', 'Çözünürlük değiştir');
    btn.textContent = this.currentResolution.label;
    btn.style.fontSize = '11px';
    btn.style.fontWeight = '700';
    btn.addEventListener('click', () => this.toggleResolutionDropdown());
    this._resolutionBtn = btn;

    // Insert into broadcast float controls
    const floatContainer = document.getElementById('broadcast-float-controls');
    if (floatContainer) {
      floatContainer.appendChild(btn);
    } else {
      const switchBtn = this._cameraSwitchBtn;
      if (switchBtn && switchBtn.parentNode) {
        switchBtn.parentNode.insertBefore(btn, switchBtn.nextSibling);
      }
    }
  },

  hideResolutionButton() {
    this.closeResolutionDropdown();
    if (this._resolutionBtn) {
      this._resolutionBtn.remove();
      this._resolutionBtn = null;
    }
  },

  toggleResolutionDropdown(anchorBtn) {
    const existing = document.getElementById('resolution-dropdown');
    if (existing) {
      this.closeResolutionDropdown();
      return;
    }

    const btn = anchorBtn || this._resolutionBtn;
    if (!btn) return;

    const dropdown = document.createElement('div');
    dropdown.id = 'resolution-dropdown';
    dropdown.style.cssText = 'position:fixed;background:rgba(20,20,30,0.95);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:4px;z-index:1000;min-width:80px;backdrop-filter:blur(10px);';

    for (const res of this.RESOLUTIONS) {
      const item = document.createElement('div');
      item.textContent = res.label;
      const isActive = res.label === this.currentResolution.label;
      item.style.cssText = `padding:10px 16px;cursor:pointer;border-radius:4px;font-size:14px;font-weight:600;color:${isActive ? '#4a9eff' : '#ccc'};text-align:center;min-height:44px;display:flex;align-items:center;justify-content:center;`;
      item.onmouseenter = () => { if (!isActive) item.style.background = 'rgba(255,255,255,0.1)'; };
      item.onmouseleave = () => { item.style.background = 'transparent'; };
      item.addEventListener('touchstart', () => { if (!isActive) item.style.background = 'rgba(255,255,255,0.1)'; }, { passive: true });
      item.addEventListener('touchend', () => { item.style.background = 'transparent'; }, { passive: true });
      item.onclick = () => {
        this.changeResolution(res);
        this.closeResolutionDropdown();
      };
      dropdown.appendChild(item);
    }

    document.body.appendChild(dropdown);

    // Position below or above button based on available space
    const btnRect = btn.getBoundingClientRect();
    const dropdownHeight = dropdown.offsetHeight;
    const spaceBelow = window.innerHeight - btnRect.bottom;
    const centerX = btnRect.left + btnRect.width / 2 - dropdown.offsetWidth / 2;

    if (spaceBelow >= dropdownHeight + 6) {
      dropdown.style.top = (btnRect.bottom + 6) + 'px';
    } else {
      dropdown.style.top = (btnRect.top - dropdownHeight - 6) + 'px';
    }
    dropdown.style.left = Math.max(4, Math.min(centerX, window.innerWidth - dropdown.offsetWidth - 4)) + 'px';

    // Close on outside click
    this._resolutionOutsideClick = (e) => {
      if (!btn.contains(e.target)) this.closeResolutionDropdown();
    };
    setTimeout(() => document.addEventListener('click', this._resolutionOutsideClick), 0);
  },

  closeResolutionDropdown() {
    const dropdown = document.getElementById('resolution-dropdown');
    if (dropdown) dropdown.remove();
    if (this._resolutionOutsideClick) {
      document.removeEventListener('click', this._resolutionOutsideClick);
      this._resolutionOutsideClick = null;
    }
  },

  async changeResolution(res) {
    if (res.label === this.currentResolution.label) return;
    if (!this.isBroadcasting || !this.peerConnection || !this.mediaStream) return;

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: res.width },
          height: { ideal: res.height },
          frameRate: { ideal: 24 },
          facingMode: { ideal: this.currentFacingMode }
        },
        audio: false
      });

      const newVideoTrack = newStream.getVideoTracks()[0];

      const sender = this.peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
      }

      const oldVideoTrack = this.mediaStream.getVideoTracks()[0];
      if (oldVideoTrack) {
        oldVideoTrack.stop();
        this.mediaStream.removeTrack(oldVideoTrack);
      }
      this.mediaStream.addTrack(newVideoTrack);

      this.currentResolution = res;
      // Update resolution label in popup header button
      const popupResBtn = this.currentPopup?.getElement()?.querySelector('.broadcast-res-btn span');
      if (popupResBtn) popupResBtn.textContent = res.label;

      Logger.log('[LiveBroadcast] Resolution changed to', res.label);
    } catch (error) {
      Logger.error('[LiveBroadcast] Resolution change failed:', error);
      AuthSystem.showNotification('Çözünürlük değiştirilemedi', 'error');
    }
  },

  // ==================== Geolocation Helpers ====================

  /**
   * Get accurate location using watchPosition (progressive accuracy)
   * Resolves immediately when accuracy <= 25m, or after 8s with best result
   */
  _getAccurateLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        return reject(new Error('Geolocation not supported'));
      }

      let bestPosition = null;
      const ACCURACY_THRESHOLD = 25;
      const TIMEOUT = 8000;

      const watchId = navigator.geolocation.watchPosition(
        (position) => {
          if (!bestPosition || position.coords.accuracy < bestPosition.coords.accuracy) {
            bestPosition = position;
          }
          if (position.coords.accuracy <= ACCURACY_THRESHOLD) {
            navigator.geolocation.clearWatch(watchId);
            clearTimeout(timer);
            resolve(bestPosition);
          }
        },
        (error) => {
          navigator.geolocation.clearWatch(watchId);
          clearTimeout(timer);
          if (bestPosition) {
            resolve(bestPosition);
          } else {
            reject(error);
          }
        },
        {
          enableHighAccuracy: true,
          timeout: TIMEOUT,
          maximumAge: 0
        }
      );

      const timer = setTimeout(() => {
        navigator.geolocation.clearWatch(watchId);
        if (bestPosition) {
          resolve(bestPosition);
        } else {
          reject(new Error('Location timeout'));
        }
      }, TIMEOUT);
    });
  },

  /**
   * Show dialog when GPS accuracy is poor (> 25m)
   * Returns { lng, lat } if user accepts, null if user wants map pick
   */
  _showLocationDialog(accuracy, lng, lat) {
    return new Promise((resolve) => {
      const dialog = document.createElement('div');
      dialog.className = 'broadcast-location-dialog';
      dialog.innerHTML = `
        <div class="location-dialog-content">
          <div class="location-dialog-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#4caf50" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
            </svg>
          </div>
          <div class="location-dialog-text">
            Konum dogruluğu: ±${Math.round(accuracy)}m
          </div>
          <div class="location-dialog-hint">
            Daha doğru konum için haritadan seçebilirsiniz
          </div>
          <div class="location-dialog-actions">
            <button class="location-dialog-btn primary" data-action="use">
              Bu Konumu Kullan
            </button>
            <button class="location-dialog-btn secondary" data-action="pick">
              Haritadan Seç
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(dialog);

      dialog.querySelector('[data-action="use"]').onclick = () => {
        dialog.remove();
        resolve({ lng, lat });
      };

      dialog.querySelector('[data-action="pick"]').onclick = () => {
        dialog.remove();
        resolve(null);
      };
    });
  },

  /**
   * Let user pick broadcast location by clicking on the map
   * Returns { lng, lat } or rejects on cancel/ESC
   */
  _pickLocationFromMap() {
    return new Promise((resolve, reject) => {
      const map = AppState.map;
      if (!map) return reject(new Error('Map not available'));

      map.getCanvas().style.cursor = 'crosshair';

      const hint = document.createElement('div');
      hint.className = 'broadcast-location-hint';
      hint.id = 'broadcast-location-hint';
      hint.innerHTML = `
        <span class="hint-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
          </svg>
        </span>
        <span>Yayın konumunu seçin</span>
        <button class="hint-cancel" id="broadcast-hint-cancel">İptal</button>
      `;
      document.body.appendChild(hint);

      const cleanup = () => {
        map.getCanvas().style.cursor = '';
        map.off('click', clickHandler);
        document.removeEventListener('keydown', escHandler);
        const el = document.getElementById('broadcast-location-hint');
        if (el) el.remove();
      };

      const clickHandler = (e) => {
        cleanup();
        resolve({ lng: e.lngLat.lng, lat: e.lngLat.lat });
      };

      const escHandler = (e) => {
        if (e.key === 'Escape') {
          cleanup();
          reject(new Error('cancelled'));
        }
      };

      hint.querySelector('#broadcast-hint-cancel').onclick = () => {
        cleanup();
        reject(new Error('cancelled'));
      };

      document.addEventListener('keydown', escHandler);
      map.once('click', clickHandler);
    });
  }
};

export { LiveBroadcast };
