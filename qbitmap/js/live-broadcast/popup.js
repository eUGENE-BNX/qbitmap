import { QBitmapConfig } from '../config.js';
import { Logger, escapeHtml } from '../utils.js';
import { AuthSystem } from '../auth.js';
import { Analytics } from '../analytics.js';
import { ReportSystem } from '../report.js';
import * as AppState from '../state.js';

const PopupMixin = {
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
    this._isOwnBroadcastPopup = isOwnBroadcast;

    const html = `
      <div class="broadcast-popup-content" data-broadcast-id="${escapeHtml(broadcastId)}">
        <div class="camera-popup-header">
          <div class="camera-popup-title">
            <div class="camera-title-line1">
              <span class="camera-id">${escapeHtml(displayName)}</span>
              ${isOwnBroadcast ? '<span id="broadcast-countdown" class="broadcast-countdown"></span>' : ''}
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
            ${isLoggedIn && !isOwnBroadcast ? ReportSystem.getCamBtnHtml() : ''}
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
      if (closeBtn) closeBtn.onclick = () => {
        if (isOwnBroadcast) {
          this.stopBroadcast();
        }
        this.closeBroadcastPopupElement();
      };

      const reportBtn = popupEl.querySelector('.report-btn');
      if (reportBtn) reportBtn.onclick = () => ReportSystem.showReportDialog('broadcast', broadcastId);

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
        this.startWhepPlayback(popupEl, whepUrl, { displayName });
      }
    }, 0);
  },

  /**
   * Start WHEP playback in a broadcast popup
   */
  async startWhepPlayback(popupEl, whepUrl, opts = {}) {
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

          // Detect portrait/landscape video and adjust container dynamically
          const updateOrientation = () => {
            if (videoEl.videoWidth && videoEl.videoHeight) {
              frameContainer.classList.toggle('portrait', videoEl.videoHeight > videoEl.videoWidth);
            }
          };
          videoEl.addEventListener('loadedmetadata', updateOrientation);
          videoEl.addEventListener('resize', updateOrientation);

          // [PWA] Media Session — broadcaster name + "Canlı Yayın" on the
          // lock screen. Live stream: no seek, Stop closes the popup.
          import('../../src/pwa/media-session.js').then(({ wireMediaSession }) => {
            if (this._broadcastMediaSessionCleanup) this._broadcastMediaSessionCleanup();
            this._broadcastMediaSessionCleanup = wireMediaSession(videoEl, {
              title: opts.displayName || 'Canlı Yayın',
              artist: 'Canlı',
              album: 'QBitmap Canlı Yayın',
              live: true,
              onStop: () => { try { this.closeBroadcastPopupElement?.(); } catch {} },
            });
          }).catch(() => {});
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
    // If closing own broadcast popup, stop the broadcast + remove icon immediately
    if (this._isOwnBroadcastPopup && this.isBroadcasting) {
      this._isOwnBroadcastPopup = false;
      // Remove icon from map RIGHT NOW (don't wait for async stopBroadcast)
      if (this.currentBroadcast) {
        this.activeBroadcasts.delete(this.currentBroadcast.broadcastId);
        this.updateMapLayer();
      }
      this.stopBroadcast();
    }

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
    if (this._broadcastMediaSessionCleanup) {
      this._broadcastMediaSessionCleanup();
      this._broadcastMediaSessionCleanup = null;
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

  // ==================== Popup Zoom ====================

  /**
   * Double-click on video: cycle zoom-0 <-> zoom-1
   */
  cycleBroadcastZoom(popupEl) {
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
      if (this._aiSearchMode) this.exitBroadcastAiSearch(popupEl);
    } else {
      return;
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
      if (this._aiSearchMode) this.exitBroadcastAiSearch(popupEl);
      if (this._broadcastAiAnalyzeActive) this.stopBroadcastAiAnalyze(popupEl);
    }
  },
};

export { PopupMixin };
