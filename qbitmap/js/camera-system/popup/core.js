import { QBitmapConfig } from "../../config.js";
import { Logger, escapeHtml, sanitize, fetchWithTimeout, TimerManager, showNotification } from "../../utils.js";
import { AuthSystem } from "../../auth.js";
import { Analytics } from "../../analytics.js";

const PopupCoreMixin = {
  // Maximum concurrent popups
  maxPopups: 5,

  // Adaptive polling intervals
  POLL_INTERVAL_VISIBLE: 5000,
  POLL_INTERVAL_HIDDEN: 15000,

  startAdaptivePolling(popupData, updateFn) {
    if (popupData.clockInterval) clearInterval(popupData.clockInterval);
    if (popupData._visHandler) document.removeEventListener('visibilitychange', popupData._visHandler);

    const self = this;
    const schedule = () => {
      if (popupData.clockInterval) clearInterval(popupData.clockInterval);
      const interval = document.hidden ? self.POLL_INTERVAL_HIDDEN : self.POLL_INTERVAL_VISIBLE;
      popupData.clockInterval = setInterval(updateFn, interval);
    };

    popupData._visHandler = schedule;
    document.addEventListener('visibilitychange', popupData._visHandler);

    updateFn();
    schedule();
  },

  /**
   * Format bandwidth to human-readable string in kbit/s or Mbit/s
   */
  formatBandwidth(bytesPerSecond) {
    const bitsPerSecond = bytesPerSecond * 8;
    if (bitsPerSecond < 1000) return bitsPerSecond.toFixed(0) + 'bit/s';
    if (bitsPerSecond < 1000000) return (bitsPerSecond / 1000).toFixed(1) + 'kbit/s';
    return (bitsPerSecond / 1000000).toFixed(1) + 'Mbit/s';
  },

  /**
   * Generate popup HTML
   */
  getPopupHTML(camera) {
    const displayName = escapeHtml(camera.name || camera.device_id);
    const isWhep = camera.camera_type === 'whep';
    const isCity = camera.camera_type === 'city';

    // For WHEP/City cameras, show video element instead of img
    if (isWhep || isCity) {
      const dataType = isCity ? 'city' : 'whep';

      // WHEP cameras get zone and record buttons, city cameras don't
      const whepOnlyButtons = isCity ? '' : `
              <button class="cam-btn toggle-zones-btn zones-hidden-state" title="Alanları göster" style="display:none;">
                <svg class="eye-off" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
                <svg class="eye-on" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none;">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              </button>
              <button class="cam-btn draw-zone-btn" title="Alan çiz" style="display:none;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                </svg>
              </button>`;

      const recordButton = isCity ? '' : `
              <button class="cam-btn record-btn" title="Kayıt">
                <span class="rec-text">REC</span>
              </button>`;

      return `
        <div class="camera-popup-content" data-device-id="${escapeHtml(camera.device_id)}" data-camera-type="${dataType}" data-whep-url="${escapeHtml(camera.whep_url || '')}" data-hls-url="${escapeHtml(camera.hls_url || '')}">
          <div class="camera-popup-header">
            <div class="camera-popup-title">
              <div class="camera-title-line1">
                <span class="camera-id">${displayName}</span>
              </div>
              <div class="camera-title-line2">
                <span class="live-badge"><b>LIVE</b></span>
                <span class="camera-bandwidth">[--]</span>
                <span class="camera-viewers">/ <span class="viewer-count">0</span></span>
              </div>
            </div>
            <div class="camera-popup-buttons">
              <button class="cam-btn search-btn" title="Yuz Ara" style="display:none;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="3"/>
                  <circle cx="12" cy="10" r="3"/>
                  <path d="M7 21v-2a5 5 0 0 1 10 0v2"/>
                </svg>
              </button>
              ${isCity ? '' : `<button class="cam-btn ai-analyze-btn" title="AI Analiz" style="display:none;">
                <span style="font-weight:900;font-size:11px;letter-spacing:-0.5px;">AI</span>
              </button>`}
              <button class="cam-btn ai-search-btn" title="AI Arama (Alan Sec)" style="display:none;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="11" cy="11" r="8"/>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  <path d="M9 11h4M11 9v4" stroke-width="1.5"/>
                </svg>
              </button>
              ${isCity ? '' : `<button class="cam-btn blur-btn" title="Yüz Bulanıklaştır" style="display:none;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <rect x="3" y="3" width="5" height="5" rx="1"/>
                  <rect x="10" y="3" width="5" height="5" rx="1"/>
                  <rect x="17" y="3" width="5" height="5" rx="1"/>
                  <rect x="3" y="10" width="5" height="5" rx="1"/>
                  <rect x="10" y="10" width="5" height="5" rx="1"/>
                  <rect x="17" y="10" width="5" height="5" rx="1"/>
                  <rect x="3" y="17" width="5" height="5" rx="1"/>
                  <rect x="10" y="17" width="5" height="5" rx="1"/>
                  <rect x="17" y="17" width="5" height="5" rx="1"/>
                </svg>
              </button>
              <button class="cam-btn ai-btn ai-active-btn" title="AI Durdur" style="display:none;">
                <span style="font-weight:900;font-size:11px;color:#000;">AI</span>
              </button>`}${whepOnlyButtons}
              ${isCity ? '' : `<button class="cam-btn protocol-toggle-btn" title="Gerçek Zamanlı Mod">
                <span class="protocol-label">HLS</span>
              </button>`}
              <button class="cam-btn audio-btn" title="Ses Aç">
                <svg class="audio-off" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                  <line x1="23" y1="9" x2="17" y2="15"></line>
                  <line x1="17" y1="9" x2="23" y2="15"></line>
                </svg>
                <svg class="audio-on" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none;">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>
              </button>${recordButton}
              ${isCity ? '' : `<button class="cam-btn terminal-btn" title="Terminal">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="4 17 10 11 4 5"></polyline>
                  <line x1="12" y1="19" x2="20" y2="19"></line>
                </svg>
              </button>`}
              <button class="cam-btn close-btn" title="Kapat">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>
          <div class="camera-popup-body">
            <div class="camera-frame-container whep-container loading">
              <div class="camera-loading">
                <div class="spinner"></div>
                <span>Bağlantı Kuruluyor...</span>
              </div>
              <video class="camera-video" autoplay playsinline muted></video>
              <div class="camera-error">Bağlantı kurulamadı</div>
            </div>
          </div>
        </div>
      `;
    }

    // Regular device camera
    return `
      <div class="camera-popup-content" data-device-id="${escapeHtml(camera.device_id)}" data-camera-type="device">
        <div class="camera-popup-header">
          <div class="camera-popup-title">
            <span class="camera-id">${displayName}</span>
            <span class="camera-time"></span>
          </div>
          <div class="camera-popup-buttons">
            <button class="cam-btn ai-btn ai-active-btn" title="AI Durdur" style="display:none;">
              <span style="font-weight:900;font-size:11px;color:#000;">AI</span>
            </button>
            <button class="cam-btn blur-btn" title="Yüz Bulanıklaştır" style="display:none;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <rect x="3" y="3" width="5" height="5" rx="1"/>
                <rect x="10" y="3" width="5" height="5" rx="1"/>
                <rect x="17" y="3" width="5" height="5" rx="1"/>
                <rect x="3" y="10" width="5" height="5" rx="1"/>
                <rect x="10" y="10" width="5" height="5" rx="1"/>
                <rect x="17" y="10" width="5" height="5" rx="1"/>
                <rect x="3" y="17" width="5" height="5" rx="1"/>
                <rect x="10" y="17" width="5" height="5" rx="1"/>
                <rect x="17" y="17" width="5" height="5" rx="1"/>
              </svg>
            </button>
            <button class="cam-btn terminal-btn" title="Terminal">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="4 17 10 11 4 5"></polyline>
                <line x1="12" y1="19" x2="20" y2="19"></line>
              </svg>
            </button>
            <button class="cam-btn mjpeg-btn" title="MJPEG Stream">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 7l-7 5 7 5V7z"></path>
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
              </svg>
            </button>
            <button class="cam-btn settings-btn" title="Ayarlar">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
            <button class="cam-btn close-btn" title="Kapat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        <div class="camera-popup-body">
          <div class="camera-frame-container loading">
            <div class="camera-loading">
              <div class="spinner"></div>
              <span>Yükleniyor...</span>
            </div>
            <img class="camera-frame" alt="Camera Frame" crossorigin="anonymous">
            <div class="camera-error">Görüntü alınamadı</div>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * Open camera popup
   * @param {Object|string} cameraOrDeviceId - Camera object or device ID string
   * @param {Array} coordinates - [lng, lat] coordinates (optional if camera has lng/lat)
   */
  async openCameraPopup(cameraOrDeviceId, coordinates) {
    // Support calling with just device ID for console testing
    let camera = cameraOrDeviceId;
    if (typeof cameraOrDeviceId === 'string') {
      camera = this.cameras.find(c => c.device_id === cameraOrDeviceId);
      if (!camera) {
        Logger.log(`[Popup] Camera not found: ${cameraOrDeviceId}`);
        return;
      }
    }

    // Use camera coordinates if not provided
    if (!coordinates && camera.lng && camera.lat) {
      coordinates = [camera.lng, camera.lat];
    }

    const deviceId = camera.device_id;
    const isWhep = camera.camera_type === 'whep';
    const isCity = camera.camera_type === 'city';

    // If this camera's popup is already open, just return
    if (this.popups.has(deviceId)) {
      return;
    }

    // If we're at max popups, close the oldest one
    if (this.popups.size >= this.maxPopups) {
      const oldestKey = this.popups.keys().next().value;
      this.closeCameraPopup(oldestKey);
    }

    // Create popup
    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: 'none',
      anchor: 'bottom',
      className: 'camera-popup'
    })
    .setLngLat(coordinates)
    .setHTML(this.getPopupHTML(camera))
    .addTo(this.map);

    // Store popup info
    this.popups.set(deviceId, { popup, refreshInterval: null, camera, isWhep: isWhep || isCity, isCity, _openedAt: performance.now() });

    Analytics.event('camera_view', { camera_id: deviceId, camera_type: camera.camera_type || 'device' });

    // Wire up event listeners after popup is in DOM
    setTimeout(() => this.setupPopupListeners(deviceId), 0);

    // Apply resolution class for WHEP cameras
    if (isWhep || isCity) {
      this.applyResolutionClass(deviceId);
    }

    // City cameras and WHEP cameras: HLS default, WHEP fallback
    if ((isCity || isWhep) && camera.hls_url) {
      await this.startHlsPlayback(deviceId, camera.hls_url);
    } else if ((isCity || isWhep) && camera.whep_url) {
      await this.startWhepStream(deviceId, camera.whep_url);
    } else if (isCity || isWhep) {
      // No URL available - show error
      const popupEl = this.popups.get(deviceId)?.popup.getElement();
      const frameContainer = popupEl?.querySelector('.camera-frame-container');
      if (frameContainer) {
        frameContainer.classList.remove('loading');
        frameContainer.classList.add('error');
      }
    } else {
      // Regular device camera - load frame
      await this.loadFrame(deviceId);
      await this.setupRefreshInterval(deviceId);
    }

    // Load and render clickable zones
    if (this.loadZonesForCamera) {
      await this.loadZonesForCamera(deviceId);
      this.renderZones(deviceId);
    }

    // Check if AI monitoring is active for this camera
    const aiState = this.aiMonitoring.get(deviceId);
    if (aiState?.enabled && !aiState.intervalId) {
      // AI is globally enabled but no local interval
      // Start local interval for this popup
      setTimeout(() => {
        this.startLocalAIInterval(deviceId);
      }, 1000);
    }

    // Update AI button visibility (must be after popup is fully loaded)
    setTimeout(() => {
      this.updatePopupAiButton(deviceId);
    }, 100);
  },


  setupPopupListeners(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const closeBtn = popupEl.querySelector('.close-btn');
    const settingsBtn = popupEl.querySelector('.settings-btn');
    const recordBtn = popupEl.querySelector('.record-btn');
    const mjpegBtn = popupEl.querySelector('.mjpeg-btn');
    const aiBtn = popupEl.querySelector('.ai-btn');
    const terminalBtn = popupEl.querySelector('.terminal-btn');
    const audioBtn = popupEl.querySelector('.audio-btn');
    const drawZoneBtn = popupEl.querySelector('.draw-zone-btn');
    const toggleZonesBtn = popupEl.querySelector('.toggle-zones-btn');
    const blurBtn = popupEl.querySelector('.blur-btn');
    const protocolToggleBtn = popupEl.querySelector('.protocol-toggle-btn');
    const frameContainer = popupEl.querySelector('.camera-frame-container');

    if (closeBtn) closeBtn.onclick = () => this.closeCameraPopup(deviceId);
    if (protocolToggleBtn) protocolToggleBtn.onclick = () => this.toggleStreamProtocol(deviceId);
    if (settingsBtn) settingsBtn.onclick = () => this.openSettings(deviceId);
    if (recordBtn) recordBtn.onclick = () => this.toggleRecording(deviceId);
    if (mjpegBtn) mjpegBtn.onclick = () => this.toggleMjpeg(deviceId);
    if (aiBtn) aiBtn.onclick = () => this.stopAIFromTitle(deviceId);
    if (terminalBtn) terminalBtn.onclick = (e) => this.toggleTerminalPanel(deviceId, e);
    if (drawZoneBtn) drawZoneBtn.onclick = () => this.toggleDrawMode(deviceId);
    if (toggleZonesBtn) toggleZonesBtn.onclick = () => this.toggleZonesVisibility(deviceId);
    if (blurBtn) blurBtn.onclick = () => this.toggleFaceBlur(deviceId);
    if (audioBtn) {
      const cam = popupData.camera;
      const isPublicCamera = !cam.isOwned && !cam.isShared;

      if (isPublicCamera) {
        // Public cameras: audio stays muted, button disabled
        audioBtn.style.opacity = '0.4';
        audioBtn.style.cursor = 'not-allowed';
        audioBtn.title = 'Ses kapalı (herkese açık kamera)';
      } else {
        // Owned/shared cameras: apply saved state
        const savedMuted = !!cam.audio_muted;
        if (!savedMuted) {
          const video = popupEl.querySelector('.camera-video');
          if (video) {
            video.muted = false;
            audioBtn.querySelector('.audio-on').style.display = 'block';
            audioBtn.querySelector('.audio-off').style.display = 'none';
            audioBtn.title = 'Ses Kapat';
          }
        }

        audioBtn.onclick = () => {
          const video = popupEl.querySelector('.camera-video');
          if (video) {
            video.muted = !video.muted;
            audioBtn.querySelector('.audio-on').style.display = video.muted ? 'none' : 'block';
            audioBtn.querySelector('.audio-off').style.display = video.muted ? 'block' : 'none';
            audioBtn.title = video.muted ? 'Ses Aç' : 'Ses Kapat';

            // Persist mute state to backend (fire-and-forget)
            cam.audio_muted = video.muted ? 1 : 0;
            fetch(`${QBitmapConfig.api.public}/cameras/${deviceId}/audio-muted`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ muted: video.muted })
            }).catch(() => {});
          }
        };
      }
    }

    // Double-click on frame to toggle zoom
    if (frameContainer) {
      frameContainer.ondblclick = () => this.cycleZoom(deviceId);
      frameContainer.style.cursor = 'zoom-in';
    }

    // Double-click on header to go to zoom-2 (only for WHEP cameras)
    const header = popupEl.querySelector('.camera-popup-header');
    if (header && popupData.isWhep) {
      header.ondblclick = (e) => {
        // Prevent if clicking on buttons
        if (e.target.closest('.camera-popup-buttons')) return;
        this.cycleToZoom2(deviceId);
      };
      header.style.cursor = 'pointer';
    }

    // Search button handler
    const searchBtn = popupEl.querySelector('.search-btn');
    if (searchBtn) {
      searchBtn.onclick = () => this.toggleSearchMode(deviceId);
    }

    // AI Search button handler
    const aiSearchBtn = popupEl.querySelector('.ai-search-btn');
    if (aiSearchBtn) {
      aiSearchBtn.onclick = () => this.toggleAiSearchMode(deviceId);
    }

    // AI Analyze button handler (toggle on/off)
    const aiAnalyzeBtn = popupEl.querySelector('.ai-analyze-btn');
    if (aiAnalyzeBtn) {
      aiAnalyzeBtn.onclick = () => this.toggleAiAnalyze(deviceId);
    }

    // Initialize zoom level
    popupData.zoomLevel = 0;

    // Initialize search mode
    popupData.searchMode = false;

    // Initialize AI search mode
    popupData.aiSearchMode = false;

    // Initialize MJPEG button state
    this.updateMjpegButtonState(deviceId);

    // WHEP kameralar için kayıt butonu durumunu senkronize et
    if (recordBtn) {
      const camera = this.cameras.find(c => c.device_id === deviceId);
      if (camera?.camera_type === 'whep') {
        this.checkRecordingStatus(deviceId).then(isRecording => {
          if (isRecording) {
            recordBtn.classList.add('recording');
            this.recordingCameras.add(deviceId);
            this.updateCameraIcon(deviceId);
            // Blink başlamadıysa başlat
            this.startRecordingBlink();
          } else {
            recordBtn.classList.remove('recording');
          }
        });
      }
    }
  },

  /**
   * Update MJPEG button state based on settings
   */

  async closeCameraPopup(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    // Track view duration
    if (popupData._openedAt) {
      const seconds = Math.round((performance.now() - popupData._openedAt) / 1000);
      Analytics.event('camera_view_duration', { camera_id: deviceId, value: seconds });
    }

    const popupEl = popupData.popup.getElement();

    // Cleanup blob URLs to prevent memory leak
    if (popupEl) {
      const frameImg = popupEl.querySelector('.camera-frame');
      if (frameImg?._blobUrl) {
        URL.revokeObjectURL(frameImg._blobUrl);
        frameImg._blobUrl = null;
      }

      // Cleanup onclick/ondblclick handlers to prevent memory leaks
      const closeBtn = popupEl.querySelector('.close-btn');
      const settingsBtn = popupEl.querySelector('.settings-btn');
      const recordBtn = popupEl.querySelector('.record-btn');
      const mjpegBtn = popupEl.querySelector('.mjpeg-btn');
      const aiBtn = popupEl.querySelector('.ai-btn');
      const terminalBtn = popupEl.querySelector('.terminal-btn');
      const audioBtn = popupEl.querySelector('.audio-btn');
      const drawZoneBtn = popupEl.querySelector('.draw-zone-btn');
      const toggleZonesBtn = popupEl.querySelector('.toggle-zones-btn');
      const blurBtn = popupEl.querySelector('.blur-btn');
      const searchBtn = popupEl.querySelector('.search-btn');
      const aiSearchBtn = popupEl.querySelector('.ai-search-btn');
      const aiAnalyzeBtn = popupEl.querySelector('.ai-analyze-btn');
      const protocolToggleBtn = popupEl.querySelector('.protocol-toggle-btn');
      const frameContainer = popupEl.querySelector('.camera-frame-container');
      const header = popupEl.querySelector('.camera-popup-header');

      if (closeBtn) closeBtn.onclick = null;
      if (settingsBtn) settingsBtn.onclick = null;
      if (recordBtn) recordBtn.onclick = null;
      if (mjpegBtn) mjpegBtn.onclick = null;
      if (aiBtn) aiBtn.onclick = null;
      if (terminalBtn) terminalBtn.onclick = null;
      if (audioBtn) audioBtn.onclick = null;
      if (drawZoneBtn) drawZoneBtn.onclick = null;
      if (toggleZonesBtn) toggleZonesBtn.onclick = null;
      if (blurBtn) blurBtn.onclick = null;
      if (searchBtn) searchBtn.onclick = null;
      if (aiSearchBtn) aiSearchBtn.onclick = null;
      if (aiAnalyzeBtn) aiAnalyzeBtn.onclick = null;
      if (protocolToggleBtn) protocolToggleBtn.onclick = null;
      if (frameContainer) frameContainer.ondblclick = null;
      if (header) header.ondblclick = null;
    }

    // Cleanup search mode
    if (popupData.searchMode) {
      const videoEl = popupEl?.querySelector('.camera-video');
      if (videoEl && popupData.searchClickHandler) {
        videoEl.removeEventListener('click', popupData.searchClickHandler);
      }
    }

    // Cleanup AI search mode
    if (popupData.aiSearchMode) {
      this.exitAiSearchMode(deviceId);
    }
    if (popupData.aiSearchCardTimeout) {
      clearTimeout(popupData.aiSearchCardTimeout);
    }

    // Cleanup AI analyze (stop interval + remove card)
    if (popupData.aiAnalyzeActive) {
      this.stopAiAnalyze(deviceId);
    }

    // Cleanup face blur
    if (this.cleanupFaceBlur) {
      this.cleanupFaceBlur(deviceId);
    }

    // Cleanup tooltip if open for this popup
    if (popupData.tooltipElement) {
      this.dismissFaceSearchTooltip();
    }

    // Cleanup capture blob URL
    if (popupData.lastCapture?.thumbnailUrl) {
      URL.revokeObjectURL(popupData.lastCapture.thumbnailUrl);
    }

    // Remove popup from map
    popupData.popup.remove();

    // Clear refresh interval
    if (popupData.refreshInterval) {
      clearInterval(popupData.refreshInterval);
    }

    // Clear clock interval and visibility listener
    if (popupData.clockInterval) {
      clearInterval(popupData.clockInterval);
    }
    if (popupData._visHandler) {
      document.removeEventListener('visibilitychange', popupData._visHandler);
    }

    // Cleanup HLS instance
    if (popupData.hlsInstance) {
      popupData.hlsInstance.destroy();
      popupData.hlsInstance = null;
      Logger.log('[HLS] Instance destroyed for', deviceId);
    }

    // Close WebRTC peer connection if WHEP camera
    if (popupData.peerConnection) {
      try {
        popupData.peerConnection.close();
      } catch (e) {
        // Ignore close errors
      }
      popupData.peerConnection = null;
      Logger.log('[WHEP] Peer connection closed for', deviceId);
    }

    // Note: AI monitoring continues globally even when popup is closed
    // Interval keeps running for WHEP cameras (capture service)
    // For device cameras, interval will pause until popup reopens (needs video element)

    // Stop recording if this popup was recording (only for device cameras, not WHEP)
    // WHEP cameras use server-side recording that continues independently
    const camera = this.cameras.find(c => c.device_id === deviceId);
    if (this.isRecording && this.recordingDeviceId === deviceId && camera?.camera_type !== 'whep') {
      this.stopRecording();
    }

    // Remove from map
    this.popups.delete(deviceId);
  },
};

export { PopupCoreMixin };
