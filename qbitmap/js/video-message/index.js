import '../../css/video-message.css';
import { QBitmapConfig } from '../config.js';
import { Logger } from '../utils.js';
import { AuthSystem } from '../auth.js';
import { PhotoCaptureMixin } from './photo-capture.js';
import { RecordingMixin } from './recording.js';
import { FormUploadMixin } from './form-upload.js';
import { MediaMixin, applyAutofocus, getSavedCameraId, saveCameraId } from './media.js';
import { MapLayerMixin } from './map-layer.js';
import { PopupMixin } from './popup.js';
import { SearchInboxMixin } from './search-inbox.js';
import { CleanupMixin } from './cleanup.js';

/**
 * QBitmap Video Message System
 * Handles recording, uploading, and displaying video/photo messages on the map
 */

const VideoMessage = {
  // Recording state
  isRecording: false,
  mediaStream: null,
  mediaRecorder: null,
  recordedChunks: [],
  recordedBlob: null,
  recordingTimer: null,
  recordingStartTime: null,

  // Location selection
  isSelectingLocation: false,
  selectedLocation: null,
  _locationClickHandler: null,

  // Camera
  currentFacingMode: 'environment',

  // Map layer
  videoMessages: new Map(),
  currentPopup: null,

  // View count debounce (per session)
  viewedMessages: new Set(),

  // Badge
  unreadCount: 0,

  // UI elements
  _modalEl: null,

  // Privacy & recipient
  isPrivate: false,
  selectedRecipient: null,
  _searchDebounce: null,

  // Photo capture state
  isPhotoMode: false,
  capturedPhotoBlob: null,
  _photoZoomLevel: 1,
  _photoResolution: 'high',
  _flashEnabled: false,
  _capturedWidth: 0,
  _capturedHeight: 0,

  // Place tagging
  _nearbyPlaces: [],
  _selectedPlace: null,

  // Constants
  MAX_DURATION_MS: 30000,
  RESOLUTION: { width: 1280, height: 720 },
  PHOTO_RESOLUTIONS: {
    standard: { width: 1920, height: 1080 },
    high: { width: 2560, height: 1440 },
    max: { width: 3840, height: 2160 }
  },

  apiBase: null,

  // ==================== INIT ====================

  init() {
    this.apiBase = QBitmapConfig.api.base + '/api/video-messages';
    this.initMapLayer();
    this.initSearch();
    this.loadVideoMessages().then(() => this.handleDeepLink());

    // Reload messages on auth changes (skip during init to avoid duplicate calls)
    let _vmsgInitDone = false;
    setTimeout(() => { _vmsgInitDone = true; }, 3000);
    window.addEventListener('auth:login', () => {
      if (!_vmsgInitDone) return;
      this.loadVideoMessages();
      this.fetchUnreadCount();
    });
    window.addEventListener('auth:logout', () => {
      this.unreadCount = 0;
      this.updateBadgeCount(0);
      this.loadVideoMessages();
    });

    // Check browser support for recording
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      Logger.warn('[VideoMessage] MediaRecorder not supported, recording disabled');
      return;
    }

    Logger.log('[VideoMessage] System initialized');
  },

  // ==================== DEVICE DETECTION ====================

  _isMobileDevice() {
    const hasTouch = ('ontouchstart' in window || navigator.maxTouchPoints > 0);
    const smallScreen = window.matchMedia('(max-width: 1024px)').matches;
    const mobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    return hasTouch && (smallScreen || mobileUA);
  },

  _showDesktopWarning() {
    document.getElementById('vmsg-desktop-warning')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'vmsg-desktop-warning';
    overlay.className = 'vmsg-desktop-warning-overlay';
    overlay.innerHTML = `
      <div class="vmsg-desktop-warning-box">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#e67e22" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>
        </svg>
        <h3>Mobil Cihaz Gerekli</h3>
        <p>Video ve fotoğraf mesaj özellikleri yalnızca cep telefonlarında kullanılabilir.</p>
        <button class="vmsg-desktop-warning-close">Tamam</button>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('.vmsg-desktop-warning-close').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  },

  // ==================== BUTTON BINDING ====================

  bindButton() {
    const btn = document.getElementById('video-msg-button');
    if (btn && !btn._vmsgBound) {
      btn._vmsgBound = true;
      btn.addEventListener('click', () => {
        AuthSystem.toggleDropdown();
        if (!this._isMobileDevice()) {
          this._showDesktopWarning();
          return;
        }
        this.startFlow();
      });
    }
  },

  bindPhotoButton() {
    const btn = document.getElementById('photo-msg-button');
    if (btn && !btn._pmsgBound) {
      btn._pmsgBound = true;
      btn.addEventListener('click', () => {
        AuthSystem.toggleDropdown();
        if (!this._isMobileDevice()) {
          this._showDesktopWarning();
          return;
        }
        this._showSourcePicker();
      });
    }
  },

  _showSourcePicker() {
    document.getElementById('vmsg-source-picker')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'vmsg-source-picker';
    overlay.className = 'vmsg-source-picker-overlay';
    overlay.innerHTML = `
      <div class="vmsg-source-picker-box">
        <h3>Fotoğraf Mesaj</h3>
        <button class="vmsg-source-btn" data-source="camera">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
          </svg>
          Kamerayı Kullan
        </button>
        <button class="vmsg-source-btn" data-source="gallery">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          Galeriden Seç
        </button>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.remove();
    };
    overlay.querySelector('[data-source="camera"]').onclick = () => {
      overlay.remove();
      this.startPhotoFlow();
    };
    overlay.querySelector('[data-source="gallery"]').onclick = () => {
      overlay.remove();
      this.startGalleryPhotoFlow();
    };
  },

  // ==================== GALLERY PHOTO FLOW ====================

  startGalleryPhotoFlow() {
    if (!AuthSystem.isLoggedIn()) {
      AuthSystem.showNotification('Foto mesaj için giriş yapın', 'error');
      return;
    }
    if (this._modalEl) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;

      const MAX_SIZE = 20 * 1024 * 1024;
      if (file.size > MAX_SIZE) {
        AuthSystem.showNotification('Fotoğraf 20MB\'dan küçük olmalı', 'error');
        return;
      }

      this.isPhotoMode = true;
      this._isGalleryMode = true;
      this.capturedPhotoBlob = file;

      const modal = document.createElement('div');
      modal.className = 'video-msg-modal';
      document.body.appendChild(modal);
      this._modalEl = modal;

      this.showPhotoPreview();
    };
    input.click();
  },

  // ==================== MAIN FLOW ====================

  async startFlow() {
    if (!AuthSystem.isLoggedIn()) {
      AuthSystem.showNotification('Video mesaj için giriş yapın', 'error');
      return;
    }

    if (this.isRecording || this._modalEl) return;

    try {
      const savedId = getSavedCameraId();
      const videoConstraints = {
        width: { ideal: this.RESOLUTION.width },
        height: { ideal: this.RESOLUTION.height },
        aspectRatio: { ideal: 16 / 9 },
        frameRate: { ideal: 25, max: 25 },
        focusMode: { ideal: 'continuous' }
      };
      if (savedId) {
        videoConstraints.deviceId = { exact: savedId };
      } else {
        videoConstraints.facingMode = { ideal: this.currentFacingMode };
      }
      let rawStream;
      try {
        rawStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: true });
      } catch (e) {
        // Saved camera might be unavailable, fallback to facingMode
        if (savedId) {
          delete videoConstraints.deviceId;
          videoConstraints.facingMode = { ideal: this.currentFacingMode };
          rawStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: true });
        } else { throw e; }
      }
      this.mediaStream = this._processAudio(rawStream);
      applyAutofocus(rawStream);

      this._selectedCameraId = rawStream.getVideoTracks()[0]?.getSettings()?.deviceId || null;
      saveCameraId(this._selectedCameraId);
      await this._enumerateCameras();

      this.showRecordingModal();
    } catch (error) {
      Logger.error('[VideoMessage] getUserMedia error:', error);
      let msg = 'Kamera açılamadı';
      if (error.name === 'NotAllowedError') msg = 'Kamera izni reddedildi';
      AuthSystem.showNotification(msg, 'error');
    }
  },
};

// Merge all mixins
Object.assign(VideoMessage,
  PhotoCaptureMixin, RecordingMixin, FormUploadMixin, MediaMixin,
  MapLayerMixin, PopupMixin, SearchInboxMixin, CleanupMixin
);

export { VideoMessage };
