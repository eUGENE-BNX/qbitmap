import { QBitmapConfig } from '../config.js';
import { Logger, escapeHtml, sanitize, fetchWithTimeout, TimerManager, showNotification } from '../utils.js';
import { AuthSystem } from '../auth.js';
import { Analytics } from '../analytics.js';

/**
 * QBitmap Camera System - Popup Module
 * Handles camera popup display, WHEP streams, and frame loading
 */

const PopupMixin = {
  // Maximum concurrent popups
  maxPopups: 5,

  // Adaptive polling intervals
  POLL_INTERVAL_VISIBLE: 5000,
  POLL_INTERVAL_HIDDEN: 15000,

  /**
   * Start adaptive stats polling - slower when tab is hidden
   */
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

  /**
   * Start WHEP WebRTC stream
   */
  async startWhepStream(deviceId, whepUrl) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    const videoEl = popupEl.querySelector('.camera-video');

    if (!frameContainer || !videoEl || !whepUrl) {
      Logger.error('[WHEP] Missing video element or URL');
      frameContainer?.classList.remove('loading');
      frameContainer?.classList.add('error');
      return;
    }

    try {
      // Create RTCPeerConnection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      // Store peer connection for cleanup
      popupData.peerConnection = pc;

      // Handle incoming tracks
      pc.ontrack = (event) => {
        Logger.log('[WHEP] Got track:', event.track.kind);
        if (event.streams && event.streams[0]) {
          videoEl.srcObject = event.streams[0];
          frameContainer.classList.remove('loading', 'error');
          frameContainer.classList.add('loaded');

          // Start stats polling for viewer count and bandwidth
          const bandwidthSpan = popupEl.querySelector('.camera-bandwidth');
          const viewerCountSpan = popupEl.querySelector('.viewer-count');

          if (bandwidthSpan && viewerCountSpan) {
            if (popupData.clockInterval) clearInterval(popupData.clockInterval);

            // Extract path from WHEP URL (e.g., http://167.235.27.12:8889/cam1/whep -> cam1)
            const extractPath = (url) => {
              try {
                const parts = url.split('/');
                const whepIndex = parts.findIndex(p => p === 'whep');
                return whepIndex > 0 ? parts[whepIndex - 1] : null;
              } catch (e) {
                return null;
              }
            };

            const streamPath = extractPath(whepUrl);
            let lastBytesSent = 0;
            let lastTimestamp = Date.now();

            const updateStats = async () => {
              if (!streamPath) return;

              try {
                const response = await fetch(`${QBitmapConfig.api.public}/mediamtx/metrics/${streamPath}`);
                if (response.ok) {
                  const data = await response.json();

                  // Update viewer count
                  viewerCountSpan.textContent = data.viewers;

                  // Calculate bandwidth rate (bytes per second)
                  const now = Date.now();
                  const timeDiff = (now - lastTimestamp) / 1000; // seconds
                  const bytesDiff = data.bytesSent - lastBytesSent;

                  if (lastBytesSent > 0 && timeDiff > 0) {
                    const bytesPerSecond = bytesDiff / timeDiff;
                    bandwidthSpan.textContent = this.formatBandwidth(bytesPerSecond);
                  } else {
                    bandwidthSpan.textContent = data.bytesSentFormatted;
                  }

                  lastBytesSent = data.bytesSent;
                  lastTimestamp = now;
                }
              } catch (e) {
                // Silent fail
              }
            };

            this.startAdaptivePolling(popupData, updateStats);
          }
        }
      };

      pc.oniceconnectionstatechange = () => {
        Logger.log('[WHEP] ICE state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed') {
          frameContainer.classList.remove('loading', 'loaded');
          frameContainer.classList.add('error');
          // Auto-reconnect after 3 seconds on ICE failure
          setTimeout(() => {
            if (this.popups.has(deviceId)) {
              Logger.log('[WHEP] Auto-reconnecting after ICE failure...');
              this.reconnectWhepStream(deviceId);
            }
          }, 3000);
        } else if (pc.iceConnectionState === 'disconnected') {
          // Disconnected state - might recover, wait before showing error
          setTimeout(() => {
            if (pc.iceConnectionState === 'disconnected') {
              frameContainer.classList.remove('loading', 'loaded');
              frameContainer.classList.add('error');
            }
          }, 5000);
        }
      };

      // Add transceivers for receiving audio and video
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      // Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete (or timeout)
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
          // Timeout after 3 seconds
          setTimeout(resolve, 3000);
        }
      });

      // Send offer to WHEP endpoint via proxy (to avoid mixed content issues)
      // Use proxy for HTTP URLs, direct for HTTPS
      let fetchUrl = whepUrl;
      if (whepUrl.startsWith('http://')) {
        fetchUrl = `${QBitmapConfig.api.public}/whep-proxy?url=${encodeURIComponent(whepUrl)}`;
      }

      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp'
        },
        body: pc.localDescription.sdp
      });

      if (!response.ok) {
        throw new Error(`WHEP request failed: ${response.status}`);
      }

      // Get answer from WHEP server
      const answerSdp = await response.text();
      await pc.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp
      });

      Logger.log('[WHEP] WebRTC connection established');

    } catch (error) {
      Logger.error('[WHEP] Connection error:', error);

      // Cleanup peer connection on error to prevent memory leak
      if (popupData.peerConnection) {
        try {
          popupData.peerConnection.close();
        } catch (e) {
          // Ignore close errors
        }
        popupData.peerConnection = null;
      }

      frameContainer.classList.remove('loading', 'loaded');
      frameContainer.classList.add('error');
    }
  },

  /**
   * Start HLS playback for a popup
   */
  async startHlsPlayback(deviceId, hlsUrl) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    const videoEl = popupEl.querySelector('.camera-video');

    if (!frameContainer || !videoEl || !hlsUrl) {
      Logger.error('[HLS] Missing video element or URL');
      frameContainer?.classList.remove('loading');
      frameContainer?.classList.add('error');
      return;
    }

    popupData.streamMode = 'hls';

    // Update protocol toggle label
    const protocolLabel = popupEl.querySelector('.protocol-label');
    if (protocolLabel) protocolLabel.textContent = 'HLS';
    const protocolBtn = popupEl.querySelector('.protocol-toggle-btn');
    if (protocolBtn) {
      protocolBtn.classList.remove('active');
      protocolBtn.title = 'Gerçek Zamanlı Mod';
    }

    const isCityCamera = popupData.camera?.camera_type === 'city' || popupData.camera?.is_city_camera;

    const result = this.startHlsStream(videoEl, hlsUrl, {
      isVod: isCityCamera,
      onReady: () => {
        frameContainer.classList.remove('loading', 'error');
        frameContainer.classList.add('loaded');

        // Start metrics polling
        const bandwidthSpan = popupEl.querySelector('.camera-bandwidth');
        const viewerCountSpan = popupEl.querySelector('.viewer-count');
        const whepUrl = popupData.camera.whep_url;

        if (bandwidthSpan && viewerCountSpan && whepUrl) {
          if (popupData.clockInterval) clearInterval(popupData.clockInterval);

          const extractPath = (url) => {
            try {
              const parts = url.split('/');
              const whepIndex = parts.findIndex(p => p === 'whep');
              return whepIndex > 0 ? parts[whepIndex - 1] : null;
            } catch (e) { return null; }
          };

          const streamPath = extractPath(whepUrl);
          let lastBytesSent = 0;
          let lastTimestamp = Date.now();
          const updateStats = async () => {
            if (!streamPath) return;
            try {
              const response = await fetch(`${QBitmapConfig.api.public}/mediamtx/metrics/${streamPath}`);
              if (response.ok) {
                const data = await response.json();
                // WHEP viewers + at least 1 if HLS active (current user)
                const hlsViewers = data.hlsActive ? 1 : 0;
                viewerCountSpan.textContent = data.viewers + hlsViewers;
                const now = Date.now();
                const timeDiff = (now - lastTimestamp) / 1000;
                const bytesDiff = data.bytesSent - lastBytesSent;
                if (lastBytesSent > 0 && timeDiff > 0) {
                  bandwidthSpan.textContent = this.formatBandwidth(bytesDiff / timeDiff);
                } else {
                  bandwidthSpan.textContent = data.bytesSentFormatted || '--';
                }
                lastBytesSent = data.bytesSent;
                lastTimestamp = now;
              }
            } catch (e) { /* silent */ }
          };

          this.startAdaptivePolling(popupData, updateStats);
        }
      },
      onError: (data) => {
        Logger.error('[HLS] Fatal error:', data);
        frameContainer.classList.remove('loading', 'loaded');
        frameContainer.classList.add('error');
      }
    });

    popupData.hlsInstance = result;
  },

  /**
   * Toggle between HLS and WHEP stream protocols
   */
  async toggleStreamProtocol(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const camera = popupData.camera;
    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    const videoEl = popupEl.querySelector('.camera-video');

    if (!frameContainer || !videoEl) return;

    // Show loading state
    frameContainer.classList.remove('loaded', 'error');
    frameContainer.classList.add('loading');

    // Cleanup current stream
    if (popupData.hlsInstance) {
      popupData.hlsInstance.destroy();
      popupData.hlsInstance = null;
    }
    if (popupData.peerConnection) {
      try { popupData.peerConnection.close(); } catch (e) {}
      popupData.peerConnection = null;
      if (videoEl.srcObject) {
        videoEl.srcObject.getTracks().forEach(t => t.stop());
        videoEl.srcObject = null;
      }
    }
    if (popupData.clockInterval) {
      clearInterval(popupData.clockInterval);
      popupData.clockInterval = null;
    }

    const currentMode = popupData.streamMode || 'hls';

    if (currentMode === 'hls' && camera.whep_url) {
      // Switch to WHEP
      popupData.streamMode = 'whep';
      const protocolLabel = popupEl.querySelector('.protocol-label');
      if (protocolLabel) protocolLabel.textContent = 'LIVE';
      const protocolBtn = popupEl.querySelector('.protocol-toggle-btn');
      if (protocolBtn) {
        protocolBtn.classList.add('active');
        protocolBtn.title = 'HLS Moduna Dön';
      }
      await this.startWhepStream(deviceId, camera.whep_url);
    } else if (camera.hls_url) {
      // Switch to HLS
      await this.startHlsPlayback(deviceId, camera.hls_url);
    }
  },

  /**
   * Setup popup button listeners
   */
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
  async updateMjpegButtonState(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const mjpegBtn = popupEl?.querySelector('.mjpeg-btn');
    if (!mjpegBtn) return;

    try {
      const response = await fetch(`${this.apiSettings}/${deviceId}`);
      if (response.ok) {
        const data = await response.json();
        const mjpegEnabled = data.settings?.mjpeg_enabled || false;

        if (mjpegEnabled) {
          mjpegBtn.classList.add('active');
          mjpegBtn.title = 'MJPEG Stream (Açık)';
        } else {
          mjpegBtn.classList.remove('active');
          mjpegBtn.title = 'MJPEG Stream (Kapalı)';
        }
      }
    } catch (e) {
      Logger.warn('[Cameras] Could not get MJPEG state');
    }
  },

  /**
   * Toggle zoom: 320x180 <-> 640x360 (via double-click on video)
   */
  cycleZoom(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    if (!frameContainer) return;

    // Cycle: 0 -> 1 -> 0 (video dblclick)
    // zoom-2 is handled by title bar dblclick
    if (popupData.zoomLevel === 0) {
      popupData.zoomLevel = 1;
    } else {
      popupData.zoomLevel = 0;
      // Deactivate search mode when zooming out
      if (popupData.searchMode) {
        this.toggleSearchMode(deviceId);
      }
    }

    const level = popupData.zoomLevel;

    // Remove all zoom classes and add current
    frameContainer.classList.remove('zoom-0', 'zoom-1', 'zoom-2');
    frameContainer.classList.add(`zoom-${level}`);

    // Update cursor (respect search mode)
    if (!popupData.searchMode) {
      frameContainer.style.cursor = level === 0 ? 'zoom-in' : 'zoom-out';
    }

    // Update search button visibility
    this.updateSearchButtonVisibility(deviceId);

    // Update blur button visibility based on zoom
    if (this.updateBlurButtonVisibility) {
      this.updateBlurButtonVisibility(deviceId);
    }

    // Update zone buttons visibility based on zoom
    if (this.updateZoneButtonsVisibility) {
      this.updateZoneButtonsVisibility(deviceId);
    }

    Logger.log(`[Cameras] Zoom: ${level === 0 ? '320x180' : '640x360'}`);
  },

  /**
   * Cycle to zoom-2 (x4) when title bar is double-clicked
   * Only works when at zoom-1 (x2) or higher
   */
  cycleToZoom2(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    if (!frameContainer) return;

    // From zoom-1 go to zoom-2, from zoom-2 go back to zoom-0
    if (popupData.zoomLevel === 1) {
      popupData.zoomLevel = 2;
    } else if (popupData.zoomLevel === 2) {
      popupData.zoomLevel = 0;
      // Deactivate search mode when zooming out
      if (popupData.searchMode) {
        this.toggleSearchMode(deviceId);
      }
    } else {
      // zoom-0: do nothing (need to go to zoom-1 first via video dblclick)
      return;
    }

    const level = popupData.zoomLevel;

    frameContainer.classList.remove('zoom-0', 'zoom-1', 'zoom-2');
    frameContainer.classList.add(`zoom-${level}`);

    // Update cursor (respect search mode)
    if (!popupData.searchMode) {
      frameContainer.style.cursor = level === 0 ? 'zoom-in' : 'zoom-out';
    }

    // Update search button visibility
    this.updateSearchButtonVisibility(deviceId);

    // Update blur button visibility based on zoom
    if (this.updateBlurButtonVisibility) {
      this.updateBlurButtonVisibility(deviceId);
    }

    // Update zone buttons visibility
    if (this.updateZoneButtonsVisibility) {
      this.updateZoneButtonsVisibility(deviceId);
    }

    Logger.log(`[Cameras] Zoom: ${level === 0 ? '320x180' : level === 1 ? '640x360' : '1280x720'}`);
  },

  /**
   * Update search button visibility based on zoom level
   * Only visible at zoom-1 (x2) or zoom-2 (x4)
   */
  updateSearchButtonVisibility(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const searchBtn = popupEl?.querySelector('.search-btn');
    if (!searchBtn) return;

    // Show only at zoom-1 (x2) or zoom-2 (x4) for WHEP cameras
    if (popupData.isWhep && popupData.zoomLevel >= 1) {
      searchBtn.style.display = 'flex';
    } else {
      searchBtn.style.display = 'none';
      // Deactivate search mode when hiding button
      if (popupData.searchMode) {
        this.toggleSearchMode(deviceId);
      }
    }

    // Also update AI search button visibility
    this.updateAiSearchButtonVisibility(deviceId);
  },

  /**
   * Update AI search button visibility based on zoom level
   * Only visible at zoom-1 (x2) or zoom-2 (x4)
   */
  updateAiSearchButtonVisibility(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const aiSearchBtn = popupEl?.querySelector('.ai-search-btn');
    const aiAnalyzeBtn = popupEl?.querySelector('.ai-analyze-btn');

    // Show only at zoom-1 (x2) or zoom-2 (x4) for WHEP cameras
    if (popupData.isWhep && popupData.zoomLevel >= 1) {
      if (aiSearchBtn) aiSearchBtn.style.display = 'flex';
      if (aiAnalyzeBtn) aiAnalyzeBtn.style.display = 'flex';
    } else {
      if (aiSearchBtn) aiSearchBtn.style.display = 'none';
      if (aiAnalyzeBtn) aiAnalyzeBtn.style.display = 'none';
      // Exit AI search mode when hiding button
      if (popupData.aiSearchMode) {
        this.exitAiSearchMode(deviceId);
      }
      // Stop AI analyze when hiding button
      if (popupData.aiAnalyzeActive) {
        this.stopAiAnalyze(deviceId);
      }
    }
  },

  /**
   * Toggle face search mode on/off
   */
  toggleSearchMode(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const searchBtn = popupEl?.querySelector('.search-btn');
    const frameContainer = popupEl?.querySelector('.camera-frame-container');
    const videoEl = popupEl?.querySelector('.camera-video');

    if (!searchBtn || !frameContainer || !videoEl) return;

    popupData.searchMode = !popupData.searchMode;

    if (popupData.searchMode) {
      // Activate search mode
      searchBtn.classList.add('active');
      frameContainer.classList.add('search-mode');
      frameContainer.style.cursor = 'crosshair';

      // Add click handler for face capture
      popupData.searchClickHandler = (e) => this.handleSearchClick(deviceId, e);
      videoEl.addEventListener('click', popupData.searchClickHandler);

      Logger.log('[FaceSearch] Search mode activated');
    } else {
      // Deactivate search mode
      searchBtn.classList.remove('active');
      frameContainer.classList.remove('search-mode');
      frameContainer.style.cursor = popupData.zoomLevel === 0 ? 'zoom-in' : 'zoom-out';

      // Remove click handler
      if (popupData.searchClickHandler) {
        videoEl.removeEventListener('click', popupData.searchClickHandler);
        popupData.searchClickHandler = null;
      }

      // Dismiss any open tooltip
      this.dismissFaceSearchTooltip();

      Logger.log('[FaceSearch] Search mode deactivated');
    }
  },

  /**
   * Handle click on video in search mode - capture face region
   */
  async handleSearchClick(deviceId, event) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.searchMode) return;

    // Prevent if already processing
    if (popupData.searchProcessing) return;
    popupData.searchProcessing = true;

    const popupEl = popupData.popup.getElement();
    const videoEl = popupEl?.querySelector('.camera-video');
    if (!videoEl) {
      popupData.searchProcessing = false;
      return;
    }

    // Get click coordinates relative to video element
    const rect = videoEl.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;

    // Calculate scale factor between displayed size and actual video resolution
    const scaleX = videoEl.videoWidth / rect.width;
    const scaleY = videoEl.videoHeight / rect.height;

    // Convert to video coordinates
    const videoX = clickX * scaleX;
    const videoY = clickY * scaleY;

    // Define capture region size (250x250 at native resolution)
    const captureSize = 250;
    const halfSize = captureSize / 2;

    // Clamp coordinates to stay within video bounds
    const x = Math.max(0, Math.min(videoEl.videoWidth - captureSize, videoX - halfSize));
    const y = Math.max(0, Math.min(videoEl.videoHeight - captureSize, videoY - halfSize));

    // Create canvas and capture the region
    const canvas = document.createElement('canvas');
    canvas.width = captureSize;
    canvas.height = captureSize;
    const ctx = canvas.getContext('2d');

    // Draw the cropped region from video
    ctx.drawImage(
      videoEl,
      x, y, captureSize, captureSize,  // Source rect
      0, 0, captureSize, captureSize    // Dest rect
    );

    // Convert to JPEG blob
    try {
      const blob = await new Promise(resolve => {
        canvas.toBlob(resolve, 'image/jpeg', 0.9);
      });

      // Store capture data for tooltip
      const thumbnailUrl = URL.createObjectURL(blob);
      popupData.lastCapture = {
        blob,
        thumbnailUrl,
        mouseX: event.clientX,
        mouseY: event.clientY
      };

      // Show loading tooltip
      this.showFaceSearchTooltip(deviceId, {
        loading: true,
        thumbnailUrl,
        mouseX: event.clientX,
        mouseY: event.clientY
      });

      // Send to recognition API
      await this.sendFaceToRecognition(deviceId, blob);

    } catch (error) {
      Logger.error('[FaceSearch] Capture error:', error);
      popupData.searchProcessing = false;
    }
  },

  /**
   * Send captured face region to recognition API
   */
  async sendFaceToRecognition(deviceId, blob) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    try {
      // Create FormData with image
      const formData = new FormData();
      formData.append('image', blob, 'face.jpg');

      // Send to backend proxy (handles matcher.qbitwise.com auth)
      const response = await fetch(
        `${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/recognize`,
        {
          method: 'POST',
          credentials: 'include',
          body: formData
        }
      );

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = await response.json();

      // Process results
      if (result.success && Array.isArray(result.result) && result.result.length > 0) {
        // Find best match
        const bestMatch = result.result.reduce((best, current) =>
          (!best || current.score > best.score) ? current : best
        , null);

        if (bestMatch && bestMatch.isMatchFound) {
          // Show success tooltip with match
          this.showFaceSearchTooltip(deviceId, {
            loading: false,
            matched: true,
            name: bestMatch.name,
            confidence: Math.round(bestMatch.score),
            thumbnailUrl: popupData.lastCapture?.thumbnailUrl,
            mouseX: popupData.lastCapture?.mouseX,
            mouseY: popupData.lastCapture?.mouseY
          });
        } else {
          // No match found
          this.showFaceSearchTooltip(deviceId, {
            loading: false,
            matched: false,
            message: 'Eslesen yuz bulunamadi',
            thumbnailUrl: popupData.lastCapture?.thumbnailUrl,
            mouseX: popupData.lastCapture?.mouseX,
            mouseY: popupData.lastCapture?.mouseY
          });
        }
      } else {
        // No faces detected
        this.showFaceSearchTooltip(deviceId, {
          loading: false,
          matched: false,
          message: 'Yuz tespit edilemedi',
          thumbnailUrl: popupData.lastCapture?.thumbnailUrl,
          mouseX: popupData.lastCapture?.mouseX,
          mouseY: popupData.lastCapture?.mouseY
        });
      }

    } catch (error) {
      Logger.error('[FaceSearch] Recognition error:', error);
      this.showFaceSearchTooltip(deviceId, {
        loading: false,
        error: true,
        message: 'API hatasi',
        thumbnailUrl: popupData.lastCapture?.thumbnailUrl,
        mouseX: popupData.lastCapture?.mouseX,
        mouseY: popupData.lastCapture?.mouseY
      });
    } finally {
      popupData.searchProcessing = false;
    }
  },

  /**
   * Show face search result tooltip near mouse cursor
   */
  showFaceSearchTooltip(deviceId, options) {
    const { loading, matched, error, name, confidence, message, thumbnailUrl, mouseX, mouseY } = options;

    // Remove existing tooltip (but don't revoke the blob URL if we're updating with same thumbnail)
    const existingTooltip = document.getElementById('face-search-tooltip');
    if (existingTooltip) {
      existingTooltip.remove();
    }

    // Clear previous handlers
    if (this.tooltipDismissTimer) {
      clearTimeout(this.tooltipDismissTimer);
      this.tooltipDismissTimer = null;
    }
    if (this.tooltipEscHandler) {
      document.removeEventListener('keydown', this.tooltipEscHandler);
      this.tooltipEscHandler = null;
    }
    if (this.tooltipClickHandler) {
      document.removeEventListener('click', this.tooltipClickHandler);
      this.tooltipClickHandler = null;
    }

    // Create tooltip element
    const tooltip = document.createElement('div');
    tooltip.id = 'face-search-tooltip';
    tooltip.className = 'face-search-tooltip';

    // Create thumbnail HTML - use placeholder if no URL
    const thumbHtml = thumbnailUrl
      ? `<img src="${thumbnailUrl}" class="fst-thumb" alt="Captured">`
      : `<div class="fst-thumb fst-thumb-placeholder"></div>`;

    if (loading) {
      tooltip.innerHTML = `
        <div class="fst-content loading">
          ${thumbHtml}
          <div class="fst-info">
            <div class="fst-spinner"></div>
            <span>Araniyor...</span>
          </div>
        </div>
      `;
    } else if (error) {
      tooltip.innerHTML = `
        <div class="fst-content error">
          ${thumbHtml}
          <div class="fst-info">
            <div class="fst-status">Hata</div>
            <div class="fst-message">${escapeHtml(message || 'Bilinmeyen hata')}</div>
          </div>
        </div>
      `;
    } else if (matched) {
      tooltip.innerHTML = `
        <div class="fst-content matched">
          ${thumbHtml}
          <div class="fst-info">
            <div class="fst-name">${escapeHtml(name || 'Bilinmiyor')}</div>
            <div class="fst-confidence">Eslesme: ${confidence || 0}%</div>
          </div>
        </div>
      `;
    } else {
      tooltip.innerHTML = `
        <div class="fst-content no-match">
          ${thumbHtml}
          <div class="fst-info">
            <div class="fst-status">Sonuc Yok</div>
            <div class="fst-message">${escapeHtml(message || 'Eslesen yuz bulunamadi')}</div>
          </div>
        </div>
      `;
    }

    // Position tooltip near mouse BEFORE appending
    const offset = 5;
    tooltip.style.left = `${mouseX + offset}px`;
    tooltip.style.top = `${mouseY + offset}px`;

    document.body.appendChild(tooltip);

    // Ensure tooltip stays within viewport, then show
    requestAnimationFrame(() => {
      const rect = tooltip.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        tooltip.style.left = `${mouseX - rect.width - offset}px`;
      }
      if (rect.bottom > window.innerHeight) {
        tooltip.style.top = `${mouseY - rect.height - offset}px`;
      }
      // Show tooltip after positioning
      tooltip.classList.add('visible');
    });

    // Store popup data reference for mouse tracking
    const popupData = this.popups.get(deviceId);
    if (popupData) {
      popupData.tooltipElement = tooltip;
      popupData.tooltipDeviceId = deviceId;

      // Set up mouse move handler for following
      popupData.tooltipMouseMoveHandler = (e) => {
        this.updateTooltipPosition(deviceId, e.clientX, e.clientY);
      };
      document.addEventListener('mousemove', popupData.tooltipMouseMoveHandler);
    }

    // Auto-dismiss after 5 seconds (if not loading)
    if (!loading) {
      this.tooltipDismissTimer = setTimeout(() => this.dismissFaceSearchTooltip(), 5000);
    }

    // ESC to dismiss
    this.tooltipEscHandler = (e) => {
      if (e.key === 'Escape') {
        this.dismissFaceSearchTooltip();
      }
    };
    document.addEventListener('keydown', this.tooltipEscHandler);

    // Click outside to dismiss (with delay to prevent immediate dismiss)
    setTimeout(() => {
      this.tooltipClickHandler = (e) => {
        if (!tooltip.contains(e.target)) {
          this.dismissFaceSearchTooltip();
        }
      };
      document.addEventListener('click', this.tooltipClickHandler);
    }, 100);
  },

  /**
   * Update tooltip position to follow mouse
   */
  updateTooltipPosition(deviceId, mouseX, mouseY) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.tooltipElement) return;

    const tooltip = popupData.tooltipElement;
    const offset = 5;

    tooltip.style.left = `${mouseX + offset}px`;
    tooltip.style.top = `${mouseY + offset}px`;

    // Adjust if going off-screen
    const rect = tooltip.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      tooltip.style.left = `${mouseX - rect.width - offset}px`;
    }
    if (rect.bottom > window.innerHeight) {
      tooltip.style.top = `${mouseY - rect.height - offset}px`;
    }
  },

  /**
   * Dismiss and cleanup face search tooltip
   */
  dismissFaceSearchTooltip() {
    const tooltip = document.getElementById('face-search-tooltip');
    if (tooltip) {
      tooltip.remove();
    }

    // Clear dismiss timer
    if (this.tooltipDismissTimer) {
      clearTimeout(this.tooltipDismissTimer);
      this.tooltipDismissTimer = null;
    }

    // Remove ESC handler
    if (this.tooltipEscHandler) {
      document.removeEventListener('keydown', this.tooltipEscHandler);
      this.tooltipEscHandler = null;
    }

    // Remove click handler
    if (this.tooltipClickHandler) {
      document.removeEventListener('click', this.tooltipClickHandler);
      this.tooltipClickHandler = null;
    }

    // Cleanup mouse move handlers and blob URLs from all popups
    for (const [deviceId, popupData] of this.popups) {
      if (popupData.tooltipMouseMoveHandler) {
        document.removeEventListener('mousemove', popupData.tooltipMouseMoveHandler);
        popupData.tooltipMouseMoveHandler = null;
      }
      if (popupData.lastCapture?.thumbnailUrl) {
        URL.revokeObjectURL(popupData.lastCapture.thumbnailUrl);
        popupData.lastCapture = null;
      }
      popupData.tooltipElement = null;
    }
  },

  // ==================== AI Search Mode ====================

  /**
   * Toggle AI search mode on/off
   */
  toggleAiSearchMode(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    popupData.aiSearchMode = !popupData.aiSearchMode;

    if (popupData.aiSearchMode) {
      this.enterAiSearchMode(deviceId);
    } else {
      this.exitAiSearchMode(deviceId);
    }
  },

  /**
   * Enter AI search mode
   */
  enterAiSearchMode(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const aiSearchBtn = popupEl?.querySelector('.ai-search-btn');
    const frameContainer = popupEl?.querySelector('.camera-frame-container');
    const videoEl = popupEl?.querySelector('.camera-video');

    if (!aiSearchBtn || !frameContainer || !videoEl) return;

    // Activate button
    aiSearchBtn.classList.add('active');
    frameContainer.classList.add('ai-search-mode');
    frameContainer.style.cursor = 'crosshair';

    // Create selection overlay
    this.createAiSearchOverlay(deviceId);

    // Add mouse handlers
    popupData.aiSearchMouseDown = (e) => this.handleAiSearchMouseDown(deviceId, e);
    popupData.aiSearchMouseMove = (e) => this.handleAiSearchMouseMove(deviceId, e);
    popupData.aiSearchMouseUp = (e) => this.handleAiSearchMouseUp(deviceId, e);

    videoEl.addEventListener('mousedown', popupData.aiSearchMouseDown);
    document.addEventListener('mousemove', popupData.aiSearchMouseMove);
    document.addEventListener('mouseup', popupData.aiSearchMouseUp);

    Logger.log('[AISearch] Mode activated');
  },

  /**
   * Exit AI search mode
   */
  exitAiSearchMode(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const aiSearchBtn = popupEl?.querySelector('.ai-search-btn');
    const frameContainer = popupEl?.querySelector('.camera-frame-container');
    const videoEl = popupEl?.querySelector('.camera-video');

    popupData.aiSearchMode = false;

    if (aiSearchBtn) aiSearchBtn.classList.remove('active');
    if (frameContainer) {
      frameContainer.classList.remove('ai-search-mode');
      frameContainer.style.cursor = popupData.zoomLevel === 0 ? 'zoom-in' : 'zoom-out';
    }

    // Remove overlay
    const overlay = popupEl?.querySelector('.ai-search-overlay');
    if (overlay) overlay.remove();

    // Remove event listeners
    if (videoEl && popupData.aiSearchMouseDown) {
      videoEl.removeEventListener('mousedown', popupData.aiSearchMouseDown);
    }
    if (popupData.aiSearchMouseMove) {
      document.removeEventListener('mousemove', popupData.aiSearchMouseMove);
    }
    if (popupData.aiSearchMouseUp) {
      document.removeEventListener('mouseup', popupData.aiSearchMouseUp);
    }

    // Clear selection state
    popupData.aiSearchSelection = null;

    // Dismiss result card if open
    this.dismissAiSearchCard();

    Logger.log('[AISearch] Mode deactivated');
  },

  /**
   * Create AI search overlay for rectangle selection
   */
  createAiSearchOverlay(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const container = popupEl.querySelector('.camera-frame-container');
    if (!container) return;

    const overlay = document.createElement('div');
    overlay.className = 'ai-search-overlay';
    overlay.innerHTML = `<div class="ai-search-rect"></div>`;
    container.appendChild(overlay);
  },

  /**
   * Handle mouse down for AI search rectangle
   */
  handleAiSearchMouseDown(deviceId, e) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.aiSearchMode) return;

    e.preventDefault();
    e.stopPropagation();

    const popupEl = popupData.popup.getElement();
    const videoEl = popupEl.querySelector('.camera-video');
    const rect = videoEl.getBoundingClientRect();

    popupData.aiSearchSelection = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      endX: e.clientX - rect.left,
      endY: e.clientY - rect.top,
      isDrawing: true,
      videoRect: rect
    };

    this.updateAiSearchRect(deviceId);
  },

  /**
   * Handle mouse move for AI search rectangle
   */
  handleAiSearchMouseMove(deviceId, e) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.aiSearchSelection?.isDrawing) return;

    const { videoRect } = popupData.aiSearchSelection;

    // Clamp to video bounds
    popupData.aiSearchSelection.endX = Math.max(0, Math.min(
      videoRect.width,
      e.clientX - videoRect.left
    ));
    popupData.aiSearchSelection.endY = Math.max(0, Math.min(
      videoRect.height,
      e.clientY - videoRect.top
    ));

    this.updateAiSearchRect(deviceId);
  },

  /**
   * Handle mouse up for AI search rectangle
   */
  handleAiSearchMouseUp(deviceId, e) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.aiSearchSelection?.isDrawing) return;

    popupData.aiSearchSelection.isDrawing = false;

    // Check if selection is large enough (at least 50x50 pixels)
    const { startX, startY, endX, endY } = popupData.aiSearchSelection;
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    if (width >= 50 && height >= 50) {
      // Process the selection
      this.processAiSearchSelection(deviceId);
    } else {
      // Too small, reset
      Logger.log('[AISearch] Selection too small, ignoring');
      const popupEl = popupData.popup.getElement();
      const rectEl = popupEl?.querySelector('.ai-search-rect');
      if (rectEl) rectEl.style.display = 'none';
    }
  },

  /**
   * Update AI search rectangle visual
   */
  updateAiSearchRect(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.aiSearchSelection) return;

    const popupEl = popupData.popup.getElement();
    const rectEl = popupEl?.querySelector('.ai-search-rect');
    if (!rectEl) return;

    const { startX, startY, endX, endY, videoRect } = popupData.aiSearchSelection;

    // Calculate rect bounds (handle negative selection direction)
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    // Convert to percentages
    rectEl.style.left = (left / videoRect.width * 100) + '%';
    rectEl.style.top = (top / videoRect.height * 100) + '%';
    rectEl.style.width = (width / videoRect.width * 100) + '%';
    rectEl.style.height = (height / videoRect.height * 100) + '%';
    rectEl.style.display = 'block';
  },

  /**
   * Process AI search selection - crop and send to API
   */
  async processAiSearchSelection(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.aiSearchSelection) return;

    const popupEl = popupData.popup.getElement();
    const videoEl = popupEl.querySelector('.camera-video');
    if (!videoEl) return;

    const { startX, startY, endX, endY, videoRect } = popupData.aiSearchSelection;

    // Calculate coordinates
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    // Scale to video's actual dimensions
    const scaleX = videoEl.videoWidth / videoRect.width;
    const scaleY = videoEl.videoHeight / videoRect.height;

    const cropX = left * scaleX;
    const cropY = top * scaleY;
    const cropWidth = width * scaleX;
    const cropHeight = height * scaleY;

    // Create canvas and crop
    const canvas = document.createElement('canvas');
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(
      videoEl,
      cropX, cropY, cropWidth, cropHeight,  // Source rect
      0, 0, cropWidth, cropHeight            // Dest rect
    );

    // Convert to base64
    const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];

    // Show loading card
    this.showAiSearchCard(deviceId, { loading: true });

    // Send to API
    await this.sendToAiSearch(deviceId, base64);
  },

  /**
   * Send cropped image to AI API
   */
  async sendToAiSearch(deviceId, base64) {
    // Get effective AI settings (per-camera > global fallback)
    const aiSettings = await this.getEffectiveAiSettings(deviceId);

    try {
      const response = await fetch(`${QBitmapConfig.api.ai}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: aiSettings.model,
          prompt: aiSettings.searchPrompt,
          images: [base64],
          stream: false,
          options: {
            num_predict: aiSettings.maxTokens,
            temperature: aiSettings.temperature
          }
        })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();

      // Extract response text (strip thinking tags from qwen)
      let responseText = data.response || '';
      responseText = responseText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      this.showAiSearchCard(deviceId, {
        loading: false,
        success: true,
        response: responseText
      });

      Logger.log('[AISearch] Analysis complete');

    } catch (error) {
      Logger.error('[AISearch] API error:', error);
      this.showAiSearchCard(deviceId, {
        loading: false,
        error: true,
        message: error.message
      });
    }
  },

  /**
   * Show AI search result card (positioned to the right of popup)
   */
  showAiSearchCard(deviceId, options) {
    const { loading, success, error, response, message } = options;

    // Remove existing card
    this.dismissAiSearchCard();

    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const card = document.createElement('div');
    card.id = 'ai-search-card';
    card.className = 'ai-search-card';
    card.dataset.deviceId = deviceId;

    if (loading) {
      card.innerHTML = `
        <div class="asc-header">
          <span class="asc-title">AI</span>
          <span>Analiz</span>
        </div>
        <div class="asc-body asc-loading">
          <div class="asc-spinner"></div>
          <span>Analiz ediliyor...</span>
        </div>
      `;
    } else if (error) {
      card.innerHTML = `
        <div class="asc-header asc-error-header">
          <span class="asc-title">AI</span>
          <span>Hata</span>
          <button class="asc-close">&times;</button>
        </div>
        <div class="asc-body">
          <p class="asc-error-text">${escapeHtml(message || 'Analiz tamamlanamadı')}</p>
        </div>
      `;
    } else {
      card.innerHTML = `
        <div class="asc-header">
          <span class="asc-title">AI</span>
          <span>Analiz</span>
          <button class="asc-close">&times;</button>
        </div>
        <div class="asc-body">
          <p class="asc-response">${this.escapeHtmlAiSearch(response || '')}</p>
        </div>
      `;
    }

    // Append to body and position to the right of popup
    document.body.appendChild(card);

    // Position card to the right of popup
    const popupRect = popupEl.getBoundingClientRect();
    card.style.position = 'fixed';
    card.style.left = (popupRect.right + 10) + 'px';
    card.style.top = popupRect.top + 'px';

    // Ensure card stays within viewport
    requestAnimationFrame(() => {
      const cardRect = card.getBoundingClientRect();
      if (cardRect.right > window.innerWidth - 10) {
        // Move to left side of popup if no space on right
        card.style.left = (popupRect.left - cardRect.width - 10) + 'px';
      }
      if (cardRect.bottom > window.innerHeight - 10) {
        card.style.top = (window.innerHeight - cardRect.height - 10) + 'px';
      }
    });

    // Add close handler
    const closeBtn = card.querySelector('.asc-close');
    if (closeBtn) {
      closeBtn.onclick = () => this.dismissAiSearchCard();
    }

    // Auto-dismiss after 20 seconds (if not loading)
    if (!loading) {
      popupData.aiSearchCardTimeout = setTimeout(() => {
        this.dismissAiSearchCard();
      }, 20000);
    }
  },

  /**
   * Dismiss AI search result card
   */
  dismissAiSearchCard() {
    const card = document.getElementById('ai-search-card');
    if (card) card.remove();

    // Clear auto-dismiss timeout and selection rect
    for (const [, popupData] of this.popups) {
      if (popupData.aiSearchCardTimeout) {
        clearTimeout(popupData.aiSearchCardTimeout);
        popupData.aiSearchCardTimeout = null;
      }
    }

    // Clear selection rectangle
    const rectEl = document.querySelector('.ai-search-rect');
    if (rectEl) rectEl.style.display = 'none';
  },

  /**
   * Escape HTML for AI search response
   */
  escapeHtmlAiSearch(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  /**
   * Toggle AI analyze on/off (periodic analysis while active)
   */
  async toggleAiAnalyze(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    if (popupData.aiAnalyzeActive) {
      // Stop
      this.stopAiAnalyze(deviceId);
    } else {
      // Start
      await this.startAiAnalyze(deviceId);
    }
  },

  /**
   * Start periodic AI analysis
   */
  async startAiAnalyze(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const btn = popupEl?.querySelector('.ai-analyze-btn');

    popupData.aiAnalyzeActive = true;
    popupData.aiAnalyzeResults = [];

    // Activate button visual
    if (btn) {
      btn.classList.add('ai-analyzing');
      btn.title = 'AI Analiz Durdur';
    }

    // Get settings from per-camera settings
    let intervalMs = 3000;
    try {
      const resp = await fetch(`${this.apiSettings}/${deviceId}`);
      if (resp.ok) {
        const data = await resp.json();
        const s = data.settings || {};
        intervalMs = s.ai_capture_interval_ms ?? 3000;
        popupData.aiAnalyzeThreshold = s.ai_confidence_threshold ?? 70;
        popupData.aiAnalyzeRequiredFrames = s.ai_consecutive_frames ?? 3;
      }
    } catch (e) {}
    if (!popupData.aiAnalyzeThreshold) popupData.aiAnalyzeThreshold = 70;
    if (!popupData.aiAnalyzeRequiredFrames) popupData.aiAnalyzeRequiredFrames = 3;

    // Show initial loading
    this.showAiAnalyzeCard(deviceId, { loading: true });

    // Run first analysis immediately
    await this.doAiAnalyzeFrame(deviceId);

    // Start periodic interval (only if still active - user might have stopped during first analysis)
    if (popupData.aiAnalyzeActive) {
      popupData.aiAnalyzeIntervalId = setInterval(() => this.doAiAnalyzeFrame(deviceId), intervalMs);
      Logger.log(`[AI Analyze] Started periodic analysis for ${deviceId} (interval: ${intervalMs}ms)`);
    }
  },

  /**
   * Stop periodic AI analysis
   */
  stopAiAnalyze(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    popupData.aiAnalyzeActive = false;

    // Clear interval
    if (popupData.aiAnalyzeIntervalId) {
      clearInterval(popupData.aiAnalyzeIntervalId);
      popupData.aiAnalyzeIntervalId = null;
    }

    // Clear typewriter timer
    if (popupData.aiTypewriteTimer) {
      clearInterval(popupData.aiTypewriteTimer);
      popupData.aiTypewriteTimer = null;
    }

    // Reset button
    const popupEl = popupData.popup.getElement();
    const btn = popupEl?.querySelector('.ai-analyze-btn');
    if (btn) {
      btn.classList.remove('ai-analyzing');
      btn.title = 'AI Analiz';
    }

    // Clear any active alarm for this camera
    if (this.activeAlarms.has(deviceId)) {
      this.activeAlarms.delete(deviceId);
      this.dismissAlarm();
      this.updateCameraIcon(deviceId);
    }

    // Remove card
    this.dismissAiAnalyzeCard(deviceId);

    Logger.log(`[AI Analyze] Stopped for ${deviceId}`);
  },

  /**
   * Analyze a single frame (called by interval)
   */
  async doAiAnalyzeFrame(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.aiAnalyzeActive) return;

    // Prevent overlapping analyses
    if (popupData.aiAnalyzeProcessing) return;
    popupData.aiAnalyzeProcessing = true;

    const popupEl = popupData.popup.getElement();
    const videoEl = popupEl?.querySelector('.camera-video');

    try {
      // Capture frame
      let base64;
      if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        base64 = this.videoToBase64(videoEl);
      }
      if (!base64) {
        this.showAiAnalyzeCard(deviceId, { error: true, message: 'Frame yakalanamadi' });
        return;
      }

      // Get effective AI settings
      const aiSettings = await this.getEffectiveAiSettings(deviceId);

      // Send to API
      const response = await fetch(`${QBitmapConfig.api.ai}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: aiSettings.model,
          prompt: aiSettings.monitoringPrompt,
          images: [base64],
          stream: false,
          options: {
            num_predict: aiSettings.maxTokens,
            temperature: aiSettings.temperature
          }
        })
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      let responseText = data.response || '';
      responseText = responseText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      const parsed = this.parseOllamaResponse(responseText);
      const confidence = parsed?.confidence || 0;
      const threshold = popupData.aiAnalyzeThreshold || 70;
      const requiredFrames = popupData.aiAnalyzeRequiredFrames || 3;

      if (parsed?.alarm) {
        // Add to consecutive results
        popupData.aiAnalyzeResults.push(confidence);
        while (popupData.aiAnalyzeResults.length > requiredFrames) {
          popupData.aiAnalyzeResults.shift();
        }

        const avgConfidence = popupData.aiAnalyzeResults.reduce((a, b) => a + b, 0) / popupData.aiAnalyzeResults.length;

        if (avgConfidence >= threshold && popupData.aiAnalyzeResults.length >= requiredFrames) {
          // Consecutive frames met - trigger alarm
          const thumbnail = await this.resizeBase64Image(base64, 360);
          const alarmPayload = {
            tasvir: parsed.tasvir,
            confidence: avgConfidence / 100,
            timestamp: new Date().toISOString(),
            snapshot: thumbnail
          };

          // Send alarm to backend (also broadcasts via WebSocket to other clients)
          try {
            const alarmResp = await fetch(`${QBitmapConfig.api.monitoring}/cameras/${deviceId}/alarms`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify(alarmPayload)
            });
            if (alarmResp.ok) {
              const alarmResult = await alarmResp.json();
              // Store in activeAlarms so dismiss works
              this.activeAlarms.set(deviceId, {
                id: alarmResult.alarmId,
                deviceId,
                cameraName: popupData.camera?.name || deviceId,
                data: alarmPayload
              });
            }
          } catch (e) {
            Logger.error('[AI Analyze] Failed to send alarm:', e);
          }

          // Show alarm popup + sound directly (inline, no mixin dependency)
          const cameraName = popupData.camera?.name || deviceId;
          try {
            // Remove existing alarm popup
            const existingAlarm = document.getElementById('ai-alarm-popup');
            if (existingAlarm) existingAlarm.remove();

            // Create floating alarm popup
            const alarmEl = document.createElement('div');
            alarmEl.id = 'ai-alarm-popup';
            alarmEl.dataset.deviceId = deviceId;
            alarmEl.className = 'ai-alarm active';
            alarmEl.innerHTML = `
              <div class="ai-alarm-header">
                <span class="ai-alarm-icon">\u{1F6A8}</span>
                <span class="ai-alarm-title">ACIL DURUM</span>
                <button class="ai-alarm-close" onclick="CameraSystem.clearAlarmClick('${escapeHtml(deviceId)}')">&times;</button>
              </div>
              <div class="ai-alarm-body">
                <div class="ai-alarm-desc">${escapeHtml(alarmPayload.tasvir) || 'Acil durum tespit edildi!'}</div>
                ${alarmPayload.snapshot ? `
                  <div class="ai-alarm-snapshot">
                    <img src="data:image/jpeg;base64,${alarmPayload.snapshot}" alt="Alarm snapshot">
                  </div>
                ` : ''}
                <div class="ai-alarm-meta">
                  <span>Kamera: ${escapeHtml(cameraName)}</span>
                  <span>${new Date().toLocaleTimeString('tr-TR')}</span>
                </div>
              </div>
            `;
            document.body.appendChild(alarmEl);

            // Play alarm sound
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            oscillator.frequency.value = 800;
            oscillator.type = 'square';
            gainNode.gain.value = 0.3;
            oscillator.start();
            let beepCount = 0;
            const beepInterval = setInterval(() => {
              gainNode.gain.value = gainNode.gain.value > 0 ? 0 : 0.3;
              beepCount++;
              if (beepCount >= 6) {
                clearInterval(beepInterval);
                oscillator.stop();
              }
            }, 200);
          } catch (alarmUiErr) {
            Logger.error('[AI Analyze] Alarm UI error:', alarmUiErr);
          }

          this.showAiAnalyzeCard(deviceId, {
            alarm: true,
            text: parsed.tasvir || responseText,
            confidence: avgConfidence
          });
          popupData.aiAnalyzeResults = []; // Reset after alarm
        } else {
          // Still collecting frames
          this.showAiAnalyzeCard(deviceId, {
            success: true,
            text: `${parsed.tasvir || responseText} (${popupData.aiAnalyzeResults.length}/${requiredFrames})`,
            confidence: confidence
          });
        }
      } else {
        // No alarm - reset counter
        popupData.aiAnalyzeResults = [];
        this.showAiAnalyzeCard(deviceId, {
          success: true,
          text: parsed?.tasvir || responseText,
          confidence: parsed?.confidence
        });
      }

    } catch (error) {
      Logger.error('[AI Analyze] Error:', error);
      this.showAiAnalyzeCard(deviceId, { error: true, message: error.message });
    } finally {
      popupData.aiAnalyzeProcessing = false;
    }
  },

  /**
   * Show AI analyze result card (attached to popup, not floating)
   */
  showAiAnalyzeCard(deviceId, options) {
    const { loading, success, alarm, error, text, message, confidence } = options;

    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const popupContent = popupEl?.querySelector('.camera-popup-content');
    if (!popupContent) return;

    // Remove existing card within this popup
    const existing = popupContent.querySelector('.ai-analyze-card');
    if (existing) existing.remove();

    const card = document.createElement('div');
    card.className = 'ai-analyze-card';

    if (loading) {
      card.innerHTML = `
        <div class="aac-header">
          <span class="aac-title">AI</span>
          <span>Analiz</span>
        </div>
        <div class="aac-body aac-loading">
          <div class="asc-spinner"></div>
          <span>AI analiz ediliyor...</span>
        </div>
      `;
    } else if (error) {
      card.innerHTML = `
        <div class="aac-header aac-error-header">
          <span class="aac-title">AI</span>
          <span>Hata</span>
        </div>
        <div class="aac-body">
          <p class="aac-error-text">${this.escapeHtmlAiSearch(message || 'Analiz tamamlanamadi')}</p>
        </div>
      `;
    } else if (alarm) {
      card.innerHTML = `
        <div class="aac-header aac-alarm-header">
          <span class="aac-title">AI</span>
          <span class="aac-badge aac-badge-alarm">ALARM${confidence ? ` (${confidence}%)` : ''}</span>
        </div>
        <div class="aac-body">
          <p class="aac-response aac-alarm-text"></p>
        </div>
      `;
    } else {
      card.innerHTML = `
        <div class="aac-header">
          <span class="aac-title">AI</span>
          <span class="aac-badge aac-badge-ok">OK${confidence ? ` (${confidence}%)` : ''}</span>
        </div>
        <div class="aac-body">
          <p class="aac-response"></p>
        </div>
      `;
    }

    // Append inside popup content (after popup body)
    popupContent.appendChild(card);

    // Typewriter effect for success/alarm text
    if ((success || alarm) && text) {
      const responseEl = card.querySelector('.aac-response');
      if (responseEl) {
        this.typewriteAiResponse(deviceId, responseEl, text);
      }
    }
  },

  /**
   * Typewriter effect for AI response text
   */
  typewriteAiResponse(deviceId, element, text) {
    const popupData = this.popups.get(deviceId);

    // Clear any previous typewriter for this device
    if (popupData?.aiTypewriteTimer) {
      clearInterval(popupData.aiTypewriteTimer);
      popupData.aiTypewriteTimer = null;
    }

    const escaped = this.escapeHtmlAiSearch(text);
    let charIndex = 0;
    const speed = 20; // ms per character

    // Add blinking cursor
    const cursor = document.createElement('span');
    cursor.className = 'aac-cursor';
    element.textContent = '';
    element.appendChild(cursor);

    const timer = setInterval(() => {
      if (charIndex >= escaped.length || !element.isConnected) {
        clearInterval(timer);
        if (popupData) popupData.aiTypewriteTimer = null;
        // Remove cursor when done
        cursor.remove();
        return;
      }
      // Insert text before cursor
      cursor.before(escaped[charIndex]);
      charIndex++;
    }, speed);

    if (popupData) popupData.aiTypewriteTimer = timer;
  },

  /**
   * Dismiss AI analyze result card
   */
  dismissAiAnalyzeCard(deviceId) {
    if (deviceId) {
      const popupData = this.popups.get(deviceId);
      if (popupData) {
        const popupEl = popupData.popup.getElement();
        const card = popupEl?.querySelector('.ai-analyze-card');
        if (card) card.remove();
      }
    } else {
      // Remove all ai-analyze-cards (cleanup)
      document.querySelectorAll('.ai-analyze-card').forEach(c => c.remove());
    }
  },

  /**
   * Close camera popup
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

  /**
   * Load frame from API
   */
  async loadFrame(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    const frameImg = popupEl.querySelector('.camera-frame');
    const timeSpan = popupEl.querySelector('.camera-time');

    if (!frameContainer || !frameImg) return;

    try {
      const response = await fetch(`${this.apiBase}/cameras/${deviceId}/latest`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('No frame');

      const data = await response.json();
      const frame = data.frame;

      const frameUrl = frame.id === 'cached'
        ? `${this.apiBase}/frames/cached?device_id=${deviceId}&t=${Date.now()}`
        : `${this.apiBase}/frames/${frame.id}?t=${Date.now()}`;

      // Fetch image with credentials and convert to blob URL
      const imgResponse = await fetch(frameUrl, { credentials: 'include' });
      if (!imgResponse.ok) throw new Error('Frame fetch failed');

      const blob = await imgResponse.blob();
      const blobUrl = URL.createObjectURL(blob);

      // Revoke old blob URL if exists
      if (frameImg._blobUrl) {
        URL.revokeObjectURL(frameImg._blobUrl);
      }
      frameImg._blobUrl = blobUrl;

      // Load image
      frameImg.onload = () => {
        frameContainer.classList.remove('loading', 'error');
        frameContainer.classList.add('loaded');
        this.captureFrameToRecording(deviceId);
      };

      frameImg.onerror = () => {
        frameContainer.classList.remove('loading', 'loaded');
        frameContainer.classList.add('error');
      };

      frameImg.src = blobUrl;
      if (timeSpan) timeSpan.textContent = new Date(frame.captured_at).toLocaleString('tr-TR');

    } catch (error) {
      Logger.error('[Cameras] Frame load error:', error);
      frameContainer.classList.remove('loading', 'loaded');
      frameContainer.classList.add('error');
    }
  },

  /**
   * Setup auto-refresh interval or MJPEG stream
   */
  async setupRefreshInterval(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    let intervalMs = 5500;
    let mjpegEnabled = false;

    try {
      const response = await fetch(`${this.apiSettings}/${deviceId}`);
      if (response.ok) {
        const data = await response.json();
        if (data.settings?.capture_interval_ms) {
          this.captureIntervalMs = data.settings.capture_interval_ms;
          intervalMs = data.settings.capture_interval_ms + 500;
        }
        // Check if MJPEG streaming is enabled
        if (data.settings?.mjpeg_enabled) {
          mjpegEnabled = true;
        }
      }
    } catch (e) {
      Logger.warn('[Cameras] Could not get capture interval');
    }

    // If MJPEG is enabled, use stream URL with retry logic
    if (mjpegEnabled) {
      const popupEl = popupData.popup.getElement();
      if (popupEl) {
        const frameImg = popupEl.querySelector('.camera-frame');
        const frameContainer = popupEl.querySelector('.camera-frame-container');
        const timeSpan = popupEl.querySelector('.camera-time');

        if (frameImg && frameContainer) {
          // Show loading while waiting for stream
          frameContainer.classList.add('loading');
          frameContainer.classList.remove('loaded', 'error');

          // Retry loading stream with exponential backoff (firmware needs ~5s to start)
          const streamUrl = `${this.apiBase}/stream/${deviceId}`;
          let retryCount = 0;
          const maxRetries = 5; // Reduced from 10, with exponential backoff
          const baseDelay = 1000; // Start with 1s, then 2s, 4s, 8s, 16s

          const tryLoadStream = () => {
            frameImg.onload = () => {
              frameContainer.classList.remove('loading', 'error');
              frameContainer.classList.add('loaded');
              Logger.log(`[Cameras] MJPEG stream connected: ${deviceId}`);

              // Start real-time clock for MJPEG mode
              if (timeSpan) {
                // Clear any existing clock interval
                if (popupData.clockInterval) {
                  clearInterval(popupData.clockInterval);
                }
                // Update time immediately and then every second
                const updateClock = () => {
                  timeSpan.textContent = '🔴 ' + new Date().toLocaleString('tr-TR');
                };
                updateClock();
                popupData.clockInterval = setInterval(updateClock, 1000);
              }
            };

            frameImg.onerror = () => {
              retryCount++;
              if (retryCount < maxRetries) {
                // Exponential backoff: 1s, 2s, 4s, 8s, 16s
                const delay = baseDelay * Math.pow(2, retryCount - 1);
                Logger.log(`[Cameras] MJPEG stream retry ${retryCount}/${maxRetries} in ${delay}ms...`);
                setTimeout(tryLoadStream, delay);
              } else {
                frameContainer.classList.remove('loading', 'loaded');
                frameContainer.classList.add('error');
                Logger.error(`[Cameras] MJPEG stream failed after ${maxRetries} retries`);
              }
            };

            // Add cache-buster to force reload
            frameImg.src = `${streamUrl}?t=${Date.now()}`;
          };

          // Start first attempt after short delay (give firmware time to receive settings)
          setTimeout(tryLoadStream, 500);
        }
      }
      // Store flag for popup - no interval needed for MJPEG
      popupData.mjpegMode = true;
      return;
    }

    // Normal mode: polling at capture_interval + buffer
    popupData.refreshInterval = setInterval(() => {
      if (this.popups.has(deviceId)) {
        this.loadFrame(deviceId);
      }
    }, intervalMs);
  },

  /**
   * Restart refresh interval (switch between MJPEG and polling)
   */
  async restartRefresh(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    // Clear existing interval
    if (popupData.refreshInterval) {
      clearInterval(popupData.refreshInterval);
      popupData.refreshInterval = null;
    }

    // Clear clock interval (used during MJPEG mode)
    if (popupData.clockInterval) {
      clearInterval(popupData.clockInterval);
      popupData.clockInterval = null;
    }

    // Reset MJPEG mode flag
    popupData.mjpegMode = false;

    // Show loading state
    const popupEl = popupData.popup.getElement();
    const frameContainer = popupEl?.querySelector('.camera-frame-container');
    const frameImg = popupEl?.querySelector('.camera-frame');
    if (frameContainer && frameImg) {
      frameContainer.classList.add('loading');
      frameContainer.classList.remove('loaded', 'error');
      // Clear current image to force reload
      frameImg.src = '';
    }

    // Re-setup refresh (will detect MJPEG mode automatically)
    await this.setupRefreshInterval(deviceId);

    // If not in MJPEG mode, load first frame immediately
    if (!popupData.mjpegMode) {
      await this.loadFrame(deviceId);
    }
  },

  /**
   * Load voice call state from backend
   */
  async loadVoiceCallState(deviceId, voiceBtn) {
    try {
      // Check if user is logged in via AuthSystem
      if (!AuthSystem.isLoggedIn()) {
        // Show button but mark as unauthorized
        voiceBtn.dataset.authorized = 'false';
        voiceBtn.title = 'Sesli Arama (Giriş yapın)';
        voiceBtn.style.opacity = '0.5';
        return;
      }

      const response = await fetch(`${QBitmapConfig.api.public}/cameras/${deviceId}/voice-call`, {
        credentials: 'include'
      });

      if (!response.ok) {
        if (response.status === 403) {
          // User doesn't own this camera
          voiceBtn.dataset.authorized = 'false';
          voiceBtn.title = 'Sesli Arama (Yetkiniz yok)';
          voiceBtn.style.opacity = '0.5';
        }
        return;
      }

      voiceBtn.dataset.authorized = 'true';
      const data = await response.json();
      this.updateVoiceButtonState(voiceBtn, data.voiceCallEnabled);

    } catch (error) {
      Logger.error('[VoiceCall] Load state error:', error);
    }
  },

  /**
   * Toggle voice call enabled state
   */
  async toggleVoiceCall(deviceId, voiceBtn) {
    try {
      // Check if user is logged in via AuthSystem
      if (!AuthSystem.isLoggedIn()) {
        alert('Bu özellik için giriş yapmanız gerekiyor.');
        return;
      }

      // Check authorization
      if (voiceBtn.dataset.authorized === 'false') {
        alert('Bu kamera için sesli arama yetkiniz yok.');
        return;
      }

      // Get current state from button class
      const currentEnabled = voiceBtn.classList.contains('active');
      const newEnabled = !currentEnabled;

      // Optimistic UI update
      this.updateVoiceButtonState(voiceBtn, newEnabled);

      const response = await fetch(`${QBitmapConfig.api.public}/cameras/${deviceId}/voice-call`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ enabled: newEnabled })
      });

      if (!response.ok) {
        // Revert on error
        this.updateVoiceButtonState(voiceBtn, currentEnabled);
        const error = await response.json().catch(() => ({}));
        alert(error.error || 'Sesli arama ayarı güncellenemedi.');
        return;
      }

      const data = await response.json();
      Logger.log('[VoiceCall] State updated:', data.voiceCallEnabled);

    } catch (error) {
      Logger.error('[VoiceCall] Toggle error:', error);
      alert('Sesli arama ayarı güncellenemedi.');
    }
  },

  /**
   * Update voice button visual state
   */
  updateVoiceButtonState(voiceBtn, enabled) {
    if (enabled) {
      voiceBtn.classList.add('active');
      voiceBtn.title = 'Sesli Arama (Açık)';
    } else {
      voiceBtn.classList.remove('active');
      voiceBtn.title = 'Sesli Arama (Kapalı)';
    }
  },

  /**
   * Apply resolution class to camera popup frame container
   * Reads stream_resolution from camera settings and applies res-{resolution} class
   * City cameras always use res-1080 (480x270 → 960x540 → 1920x1080)
   */
  async applyResolutionClass(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    if (!frameContainer) return;

    // Remove any existing resolution classes
    frameContainer.classList.remove('res-720', 'res-1080', 'res-1440', 'res-2160');

    // City cameras use city-cam class (640x360 → 1280x720), skip resolution class
    if (popupData.isCity) {
      popupData.resolution = 720;
      Logger.log(`[Popup] City camera ${deviceId} — using city-cam class`);
      return;
    }

    try {
      // Fetch camera settings to get resolution
      const response = await fetch(`${this.apiSettings}/${deviceId}`);
      if (!response.ok) return;

      const data = await response.json();
      const resolution = data.settings?.stream_resolution || 720;

      // Add the resolution class
      frameContainer.classList.add(`res-${resolution}`);

      // Store resolution in popup data for reference
      popupData.resolution = resolution;

      Logger.log(`[Popup] Applied resolution class: res-${resolution} for ${deviceId}`);
    } catch (error) {
      Logger.warn('[Popup] Could not fetch resolution setting:', error.message);
      // Default to 720p if fetch fails
      frameContainer.classList.add('res-720');
    }
  }
};

export { PopupMixin };
