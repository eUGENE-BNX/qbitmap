import { QBitmapConfig } from '../config.js';
import { Logger } from '../utils.js';
import { AuthSystem } from '../auth.js';
import { PhotoCaptureMixin } from './photo-capture.js';
import { RecordingMixin } from './recording.js';
import { FormUploadMixin } from './form-upload.js';
import { MediaMixin } from './media.js';
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
  currentFacingMode: 'user',

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

  // ==================== BUTTON BINDING ====================

  bindButton() {
    const btn = document.getElementById('video-msg-button');
    if (btn && !btn._vmsgBound) {
      btn._vmsgBound = true;
      btn.addEventListener('click', () => {
        if (window.AuthSystem) AuthSystem.toggleDropdown();
        this.startFlow();
      });
    }
  },

  bindPhotoButton() {
    const btn = document.getElementById('photo-msg-button');
    if (btn && !btn._pmsgBound) {
      btn._pmsgBound = true;
      btn.addEventListener('click', () => {
        if (window.AuthSystem) AuthSystem.toggleDropdown();
        this.startPhotoFlow();
      });
    }
  },

  // ==================== MAIN FLOW ====================

  async startFlow() {
    if (!AuthSystem.isLoggedIn()) {
      AuthSystem.showNotification('Video mesaj için giriş yapın', 'error');
      return;
    }

    if (this.isRecording || this._modalEl) return;

    try {
      const rawStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: this.RESOLUTION.width },
          height: { ideal: this.RESOLUTION.height },
          aspectRatio: { ideal: 16 / 9 },
          frameRate: { ideal: 25, max: 25 },
          facingMode: { ideal: this.currentFacingMode }
        },
        audio: true
      });
      this.mediaStream = this._processAudio(rawStream);

      this._selectedCameraId = rawStream.getVideoTracks()[0]?.getSettings()?.deviceId || null;
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
window.VideoMessage = VideoMessage;
