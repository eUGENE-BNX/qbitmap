/**
 * QBitmap Video Message System
 * Handles recording, uploading, and displaying video messages on the map
 */

function _haptic(style) {
  if (!navigator.vibrate) return;
  const p = { light: 10, medium: 20, heavy: 30, success: [10, 50, 20] };
  navigator.vibrate(p[style] || 10);
}

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

    // Reload messages on auth changes
    window.addEventListener('auth:login', () => {
      this.loadVideoMessages();
      this.fetchUnreadCount();
    });
    window.addEventListener('auth:logout', () => {
      this.unreadCount = 0;
      this.updateBadgeCount(0);
      this.loadVideoMessages();
    });

    // Check browser support for recording (viewing messages still works without this)
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

      // Store active camera deviceId and enumerate all cameras
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

  // ==================== PHOTO FLOW ====================

  async startPhotoFlow() {
    if (!AuthSystem.isLoggedIn()) {
      AuthSystem.showNotification('Foto mesaj için giriş yapın', 'error');
      return;
    }

    if (this.isRecording || this._modalEl) return;
    this.isPhotoMode = true;

    try {
      const res = this.PHOTO_RESOLUTIONS[this._photoResolution];
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: res.width },
          height: { ideal: res.height },
          aspectRatio: { ideal: 16 / 9 },
          facingMode: { ideal: this.currentFacingMode }
        },
        audio: false
      });
      this.mediaStream = stream;
      this._selectedCameraId = stream.getVideoTracks()[0]?.getSettings()?.deviceId || null;
      await this._enumerateCameras();
      this.showPhotoCaptureModal();
    } catch (error) {
      Logger.error('[VideoMessage] Photo getUserMedia error:', error);
      this.isPhotoMode = false;
      let msg = 'Kamera açılamadı';
      if (error.name === 'NotAllowedError') msg = 'Kamera izni reddedildi';
      AuthSystem.showNotification(msg, 'error');
    }
  },

  showPhotoCaptureModal() {
    const modal = document.createElement('div');
    modal.className = 'video-msg-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="video-msg-modal-content">
        <div class="video-msg-video-container" id="vmsg-video-container">
          <video id="vmsg-preview-video" autoplay playsinline muted></video>
        </div>
        <div class="photo-settings-bar" id="photo-settings">
          <div class="photo-zoom-control" id="photo-zoom-ctrl">
            <span>1x</span>
            <input type="range" id="photo-zoom" min="1" max="5" step="0.1" value="1">
            <span id="photo-zoom-label">1.0x</span>
          </div>
          <div class="photo-resolution-control">
            <select id="photo-resolution">
              <option value="standard">1080p</option>
              <option value="high" ${this._photoResolution === 'high' ? 'selected' : ''}>1440p</option>
              <option value="max">4K</option>
            </select>
          </div>
          <button class="photo-flash-btn" id="photo-flash" title="Flaş">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>
          </button>
        </div>
        <div class="video-msg-controls photo-controls" id="vmsg-controls">
          <button class="video-msg-btn video-msg-btn-cancel" id="vmsg-cancel" title="İptal" aria-label="İptal">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
          <button class="video-msg-btn video-msg-btn-capture" id="vmsg-capture" title="Fotoğraf Çek" aria-label="Fotoğraf çek">
            <div class="capture-inner"></div>
          </button>
          <button class="video-msg-btn" id="vmsg-switch-cam" title="Kamerayı Değiştir" aria-label="Kamerayı değiştir">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 16v4a2 2 0 0 1-2 2h-4M4 8V4a2 2 0 0 1 2-2h4M16 4l4 4-4 4M8 20l-4-4 4-4"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this._modalEl = modal;

    const video = modal.querySelector('#vmsg-preview-video');
    video.srcObject = this.mediaStream;

    // Detect orientation
    const container = modal.querySelector('#vmsg-video-container');
    this._applyVideoOrientation(container, this.mediaStream, video);

    // Bind controls
    modal.querySelector('#vmsg-cancel').onclick = () => this.cancelFlow();
    modal.querySelector('#vmsg-capture').onclick = () => this.capturePhoto();
    modal.querySelector('#vmsg-switch-cam').onclick = () => {
      if (this._cameras && this._cameras.length >= 2) {
        this._showCameraDropdown();
      } else {
        this.switchCamera();
      }
    };

    // Photo-specific controls
    this._bindPhotoZoom(modal);
    this._bindPhotoResolution(modal);
    this._bindPhotoFlash(modal);
  },

  async capturePhoto() {
    if (!this.mediaStream) return;

    const video = this._modalEl?.querySelector('#vmsg-preview-video');
    if (!video) return;

    const track = this.mediaStream.getVideoTracks()[0];
    const settings = track.getSettings();
    const res = this.PHOTO_RESOLUTIONS[this._photoResolution];
    const targetW = res.width;
    const targetH = res.height; // Already 16:9 (1920x1080, 2560x1440, 3840x2160)

    // Try ImageCapture API (higher quality), then crop to 16:9
    if (typeof ImageCapture !== 'undefined') {
      try {
        const imageCapture = new ImageCapture(track);
        const rawBlob = await imageCapture.takePhoto();

        // ImageCapture may return sensor's native ratio (4:3, 1:1 etc.)
        // Always crop to 16:9 via canvas
        const bitmap = await createImageBitmap(rawBlob);
        this.capturedPhotoBlob = await this._cropTo16x9(bitmap, targetW, targetH);
        bitmap.close();
      } catch (e) {
        Logger.warn('[VideoMessage] ImageCapture failed, falling back to canvas:', e);
        this.capturedPhotoBlob = await this._canvasCapture(video, targetW, targetH);
      }
    } else {
      // Safari, Firefox: canvas capture from video element
      this.capturedPhotoBlob = await this._canvasCapture(video, targetW, targetH);
    }

    this._capturedWidth = targetW;
    this._capturedHeight = targetH;

    _haptic('medium');

    // Stop camera
    this.mediaStream.getTracks().forEach(t => t.stop());
    this.mediaStream = null;

    this.showPhotoPreview();
  },

  // Crop any source (ImageBitmap) to 16:9 center-crop
  _cropTo16x9(source, targetW, targetH) {
    const srcW = source.width;
    const srcH = source.height;
    const targetRatio = 16 / 9;
    const srcRatio = srcW / srcH;

    let sx, sy, sw, sh;
    if (srcRatio > targetRatio) {
      // Source wider than 16:9 → crop sides
      sh = srcH;
      sw = Math.round(srcH * targetRatio);
      sx = Math.round((srcW - sw) / 2);
      sy = 0;
    } else {
      // Source taller than 16:9 (4:3, 1:1) → crop top/bottom
      sw = srcW;
      sh = Math.round(srcW / targetRatio);
      sx = 0;
      sy = Math.round((srcH - sh) / 2);
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, targetW, targetH);

    return new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.92);
    });
  },

  // Canvas capture from video element, cropped to 16:9
  async _canvasCapture(video, targetW, targetH) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const targetRatio = 16 / 9;
    const srcRatio = vw / vh;

    let sx, sy, sw, sh;
    if (srcRatio > targetRatio) {
      sh = vh;
      sw = Math.round(vh * targetRatio);
      sx = Math.round((vw - sw) / 2);
      sy = 0;
    } else {
      sw = vw;
      sh = Math.round(vw / targetRatio);
      sx = 0;
      sy = Math.round((vh - sh) / 2);
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);

    return new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.92);
    });
  },

  showPhotoPreview() {
    if (!this._modalEl || !this.capturedPhotoBlob) return;

    const objectUrl = URL.createObjectURL(this.capturedPhotoBlob);

    this._modalEl.innerHTML = `
      <div class="video-msg-modal-content">
        <div class="video-msg-video-container photo-preview-container">
          <img id="vmsg-photo-preview" src="${objectUrl}" alt="Captured photo">
        </div>
        <div class="video-msg-send-panel">
          <input type="text" class="video-msg-description-input" id="vmsg-description"
                 placeholder="Bir başlık girin..." maxlength="200" autocomplete="off">
          <div class="video-msg-tag-input-container">
            <div class="video-msg-tag-chips" id="vmsg-tag-chips"></div>
            <input type="text" class="video-msg-tag-input" id="vmsg-tag-input"
                   placeholder="Etiket ekleyin (Enter ile)..." maxlength="100" autocomplete="off">
          </div>
          <div class="video-msg-place-section" id="vmsg-place-section" style="display:none;">
            <div class="video-msg-place-label">
              <svg class="video-msg-place-pin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <span>Yakındaki Mekanlar</span>
              <span class="video-msg-place-loading" id="vmsg-place-loading">...</span>
            </div>
            <div class="video-msg-place-list" id="vmsg-place-list"></div>
            <div class="video-msg-selected-place" id="vmsg-selected-place" style="display:none;"></div>
          </div>
          <div class="video-msg-privacy-toggle">
            <button class="video-msg-privacy-option active" data-mode="public">Herkese Açık</button>
            <button class="video-msg-privacy-option" data-mode="private">Kişiye Özel</button>
          </div>
          <div class="video-msg-recipient-search" id="vmsg-recipient-search">
            <div id="vmsg-selected-recipient"></div>
            <input type="text" class="video-msg-recipient-input" id="vmsg-recipient-input"
                   placeholder="İsim veya email ile ara..." autocomplete="off">
            <div class="video-msg-recipient-results" id="vmsg-recipient-results"></div>
          </div>
          <div class="video-msg-progress" id="vmsg-progress" style="display:none;">
            <div class="video-msg-progress-bar" id="vmsg-progress-bar"></div>
          </div>
          <div class="video-msg-progress-text" id="vmsg-progress-text" style="display:none;"></div>
          <div class="video-msg-actions">
            <button class="video-msg-action-btn secondary" id="vmsg-rerecord">Tekrar Çek</button>
            <button class="video-msg-action-btn primary" id="vmsg-select-location" disabled>Konum alınıyor...</button>
          </div>
        </div>
      </div>
    `;

    // Detect photo orientation
    const previewContainer = this._modalEl.querySelector('.photo-preview-container');
    const img = this._modalEl.querySelector('#vmsg-photo-preview');
    if (previewContainer && img) {
      img.onload = () => {
        if (img.naturalHeight > img.naturalWidth) {
          previewContainer.classList.add('vmsg-portrait');
        } else {
          previewContainer.classList.remove('vmsg-portrait');
        }
      };
    }

    this._objectUrl = objectUrl;
    this._bindSendPanel();
  },

  // ==================== PHOTO CONTROLS ====================

  _bindPhotoZoom(modal) {
    const slider = modal.querySelector('#photo-zoom');
    const label = modal.querySelector('#photo-zoom-label');
    const ctrl = modal.querySelector('#photo-zoom-ctrl');
    if (!slider || !ctrl) return;

    const track = this.mediaStream?.getVideoTracks()[0];
    const capabilities = track?.getCapabilities?.();

    if (!capabilities?.zoom) {
      ctrl.style.display = 'none';
      return;
    }

    slider.min = capabilities.zoom.min;
    slider.max = capabilities.zoom.max;
    slider.step = capabilities.zoom.step || 0.1;
    slider.value = capabilities.zoom.min;
    this._photoZoomLevel = capabilities.zoom.min;

    slider.oninput = () => {
      const zoom = parseFloat(slider.value);
      this._photoZoomLevel = zoom;
      if (label) label.textContent = zoom.toFixed(1) + 'x';
      track.applyConstraints({ advanced: [{ zoom }] });
    };
  },

  _bindPhotoResolution(modal) {
    const select = modal.querySelector('#photo-resolution');
    if (!select) return;

    select.onchange = async () => {
      this._photoResolution = select.value;
      const res = this.PHOTO_RESOLUTIONS[this._photoResolution];
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: this._selectedCameraId ? { exact: this._selectedCameraId } : undefined,
            width: { ideal: res.width },
            height: { ideal: res.height },
            aspectRatio: { ideal: 16 / 9 },
            facingMode: !this._selectedCameraId ? { ideal: this.currentFacingMode } : undefined
          },
          audio: false
        });
        this.mediaStream.getTracks().forEach(t => t.stop());
        this.mediaStream = newStream;
        this._selectedCameraId = newStream.getVideoTracks()[0]?.getSettings()?.deviceId || null;
        const video = modal.querySelector('#vmsg-preview-video');
        if (video) video.srcObject = newStream;
        // Re-bind zoom for new track
        this._bindPhotoZoom(modal);
        this._bindPhotoFlash(modal);
      } catch (e) {
        Logger.warn('[VideoMessage] Resolution change failed:', e);
      }
    };
  },

  _bindPhotoFlash(modal) {
    const btn = modal.querySelector('#photo-flash');
    if (!btn) return;

    const track = this.mediaStream?.getVideoTracks()[0];
    const capabilities = track?.getCapabilities?.();

    if (!capabilities?.torch) {
      btn.style.display = 'none';
      return;
    }

    btn.style.display = '';
    btn.classList.toggle('active', this._flashEnabled);
    btn.onclick = () => {
      this._flashEnabled = !this._flashEnabled;
      btn.classList.toggle('active', this._flashEnabled);
      track.applyConstraints({ advanced: [{ torch: this._flashEnabled }] });
    };
  },

  // ==================== RECORDING MODAL ====================

  showRecordingModal() {
    const modal = document.createElement('div');
    modal.className = 'video-msg-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="video-msg-modal-content">
        <div class="video-msg-video-container" id="vmsg-video-container">
          <video id="vmsg-preview-video" autoplay playsinline muted></video>
          <div class="video-msg-timer" id="vmsg-timer" style="display:none;">00:30</div>
          <div class="video-msg-rec-indicator" id="vmsg-rec-indicator" style="display:none;">
            <div class="video-msg-rec-dot"></div>
            <span class="video-msg-rec-label">REC</span>
          </div>
        </div>
        <div class="video-msg-controls" id="vmsg-controls">
          <button class="video-msg-btn video-msg-btn-cancel" id="vmsg-cancel" title="İptal" aria-label="İptal">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
          <button class="photo-flash-btn" id="video-flash" title="Flaş" aria-label="Flaş aç/kapat" style="display:none;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>
          </button>
          <button class="video-msg-btn video-msg-btn-record" id="vmsg-record" title="Kayıt Başlat" aria-label="Video kaydını başlat">
            <div class="rec-inner"></div>
          </button>
          <button class="video-msg-btn" id="vmsg-switch-cam" title="Kamerayı Değiştir" aria-label="Kamerayı değiştir">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="1 4 1 10 7 10"/>
              <polyline points="23 20 23 14 17 14"/>
              <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10"/>
              <path d="M3.51 15A9 9 0 0 0 18.36 18.36L23 14"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this._modalEl = modal;

    // Set video source
    const video = modal.querySelector('#vmsg-preview-video');
    video.srcObject = this.mediaStream;

    // Detect video orientation and apply portrait class if needed
    const container = modal.querySelector('#vmsg-video-container');
    this._applyVideoOrientation(container, this.mediaStream, video);

    // Bind buttons
    modal.querySelector('#vmsg-cancel').onclick = () => this.cancelFlow();
    modal.querySelector('#vmsg-record').onclick = () => this.startRecording();
    modal.querySelector('#vmsg-switch-cam').onclick = () => {
      if (this._cameras && this._cameras.length >= 2) {
        this._showCameraDropdown();
      } else {
        this.switchCamera();
      }
    };

    // Flash/torch toggle for video recording
    this._bindVideoFlash(modal);
  },

  _bindVideoFlash(modal) {
    const btn = modal.querySelector('#video-flash');
    if (!btn) return;

    const track = this.mediaStream?.getVideoTracks()[0];
    const capabilities = track?.getCapabilities?.();

    if (!capabilities?.torch) {
      btn.style.display = 'none';
      return;
    }

    btn.style.display = '';
    btn.classList.toggle('active', this._flashEnabled);
    btn.onclick = () => {
      this._flashEnabled = !this._flashEnabled;
      btn.classList.toggle('active', this._flashEnabled);
      track.applyConstraints({ advanced: [{ torch: this._flashEnabled }] });
    };
  },

  // ==================== RECORDING ====================

  startRecording() {
    if (this.isRecording || !this.mediaStream) return;

    const mimeType = this.getPreferredMimeType();
    const options = mimeType
      ? { mimeType, videoBitsPerSecond: 2500000, audioBitsPerSecond: 32000 }
      : { videoBitsPerSecond: 2500000, audioBitsPerSecond: 32000 };

    try {
      this.mediaRecorder = new MediaRecorder(this.mediaStream, options);
    } catch (e) {
      Logger.warn('[VideoMessage] MediaRecorder creation failed with options, using default');
      this.mediaRecorder = new MediaRecorder(this.mediaStream);
    }

    this.recordedChunks = [];

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };

    this.mediaRecorder.onstop = () => {
      const actualMime = this.mediaRecorder.mimeType || mimeType || 'video/webm';
      this.recordedBlob = new Blob(this.recordedChunks, { type: actualMime });
      this.recordedChunks = [];
      this.showPreview();
    };

    this.mediaRecorder.start(1000); // Collect data every 1s
    this.isRecording = true;
    this.recordingStartTime = Date.now();
    _haptic('medium');

    // Update UI
    const container = this._modalEl.querySelector('#vmsg-video-container');
    container.classList.add('recording');

    const timer = this._modalEl.querySelector('#vmsg-timer');
    timer.style.display = '';

    const recIndicator = this._modalEl.querySelector('#vmsg-rec-indicator');
    recIndicator.style.display = '';

    // Disable camera switch during recording
    const switchBtn = this._modalEl.querySelector('#vmsg-switch-cam');
    if (switchBtn) { switchBtn.disabled = true; switchBtn.style.opacity = '0.3'; }

    // Replace record button with stop button
    const controls = this._modalEl.querySelector('#vmsg-controls');
    const recordBtn = controls.querySelector('#vmsg-record');
    recordBtn.className = 'video-msg-btn video-msg-btn-stop';
    recordBtn.title = 'Durdur';
    recordBtn.innerHTML = '<div class="stop-inner"></div>';
    recordBtn.onclick = () => this.stopRecording();

    // Start countdown timer
    this.updateTimer();
    this.recordingTimer = setInterval(() => this.updateTimer(), 250);
  },

  updateTimer() {
    const elapsed = Date.now() - this.recordingStartTime;
    const remaining = Math.max(0, this.MAX_DURATION_MS - elapsed);
    const seconds = Math.ceil(remaining / 1000);

    const timer = this._modalEl?.querySelector('#vmsg-timer');
    if (timer) {
      timer.textContent = `00:${String(seconds).padStart(2, '0')}`;
      if (seconds <= 5) timer.classList.add('warning');
    }

    // Auto-stop at 30 seconds
    if (remaining <= 0) {
      this.stopRecording();
    }
  },

  stopRecording() {
    if (!this.isRecording || !this.mediaRecorder) return;

    clearInterval(this.recordingTimer);
    this.recordingTimer = null;
    this.isRecording = false;

    // Re-enable camera switch
    const switchBtn = this._modalEl?.querySelector('#vmsg-switch-cam');
    if (switchBtn) { switchBtn.disabled = false; switchBtn.style.opacity = ''; }

    if (this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }

    // Stop camera tracks (we don't need the live preview anymore)
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
  },

  // ==================== PREVIEW & SEND ====================

  showPreview() {
    if (!this._modalEl || !this.recordedBlob) return;

    const durationMs = Math.min(Date.now() - this.recordingStartTime, this.MAX_DURATION_MS);
    const objectUrl = URL.createObjectURL(this.recordedBlob);

    this._modalEl.innerHTML = `
      <div class="video-msg-modal-content">
        <div class="video-msg-video-container">
          <video id="vmsg-playback" controls playsinline src="${objectUrl}"></video>
        </div>
        <div class="video-msg-send-panel">
          <input type="text" class="video-msg-description-input" id="vmsg-description"
                 placeholder="Bir başlık girin..." maxlength="200" autocomplete="off">
          <div class="video-msg-tag-input-container">
            <div class="video-msg-tag-chips" id="vmsg-tag-chips"></div>
            <input type="text" class="video-msg-tag-input" id="vmsg-tag-input"
                   placeholder="Etiket ekleyin (Enter ile)..." maxlength="100" autocomplete="off">
          </div>
          <div class="video-msg-place-section" id="vmsg-place-section" style="display:none;">
            <div class="video-msg-place-label">
              <svg class="video-msg-place-pin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <span>Yakındaki Mekanlar</span>
              <span class="video-msg-place-loading" id="vmsg-place-loading">...</span>
            </div>
            <div class="video-msg-place-list" id="vmsg-place-list"></div>
            <div class="video-msg-selected-place" id="vmsg-selected-place" style="display:none;"></div>
          </div>
          <div class="video-msg-privacy-toggle">
            <button class="video-msg-privacy-option active" data-mode="public">Herkese Açık</button>
            <button class="video-msg-privacy-option" data-mode="private">Kişiye Özel</button>
          </div>
          <div class="video-msg-recipient-search" id="vmsg-recipient-search">
            <div id="vmsg-selected-recipient"></div>
            <input type="text" class="video-msg-recipient-input" id="vmsg-recipient-input"
                   placeholder="İsim veya email ile ara..." autocomplete="off">
            <div class="video-msg-recipient-results" id="vmsg-recipient-results"></div>
          </div>
          <div class="video-msg-progress" id="vmsg-progress" style="display:none;">
            <div class="video-msg-progress-bar" id="vmsg-progress-bar"></div>
          </div>
          <div class="video-msg-progress-text" id="vmsg-progress-text" style="display:none;"></div>
          <div class="video-msg-actions">
            <button class="video-msg-action-btn secondary" id="vmsg-rerecord">Tekrar Kaydet</button>
            <button class="video-msg-action-btn primary" id="vmsg-select-location" disabled>Konum alınıyor...</button>
          </div>
        </div>
      </div>
    `;

    // Detect orientation of recorded video
    const playbackVideo = this._modalEl.querySelector('#vmsg-playback');
    const previewContainer = this._modalEl.querySelector('.video-msg-video-container');
    this._applyVideoOrientation(previewContainer, null, playbackVideo);

    // Store duration for upload
    this._durationMs = durationMs;
    this._objectUrl = objectUrl;

    this._bindSendPanel();
  },

  // Shared send panel bindings for both video and photo preview
  _bindSendPanel() {
    if (!this._modalEl) return;

    // Privacy toggle
    const toggleBtns = this._modalEl.querySelectorAll('.video-msg-privacy-option');
    toggleBtns.forEach(btn => {
      btn.onclick = () => {
        toggleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.isPrivate = btn.dataset.mode === 'private';
        const searchEl = this._modalEl.querySelector('#vmsg-recipient-search');
        if (this.isPrivate) {
          searchEl.classList.add('visible');
        } else {
          searchEl.classList.remove('visible');
          this.selectedRecipient = null;
        }
      };
    });

    // Tag chip input
    const tagInput = this._modalEl.querySelector('#vmsg-tag-input');
    const tagChips = this._modalEl.querySelector('#vmsg-tag-chips');
    this._tags = [];
    const addTagFromInput = () => {
      const val = tagInput.value.trim().replace(/,/g, '');
      if (val && this._tags.length < 5 && !this._tags.includes(val)) {
        this._tags.push(val);
        this._renderTagChips(tagChips);
      }
      tagInput.value = '';
    };
    tagInput.onkeydown = (e) => {
      if ((e.key === 'Enter' || e.key === ',') && tagInput.value.trim()) {
        e.preventDefault();
        addTagFromInput();
      }
      if (e.key === 'Backspace' && !tagInput.value && this._tags.length > 0) {
        this._tags.pop();
        this._renderTagChips(tagChips);
      }
    };
    // Also handle input event for mobile comma entry
    tagInput.oninput = () => {
      if (tagInput.value.includes(',')) {
        addTagFromInput();
      }
    };
    // Add remaining text as tag on blur
    tagInput.onblur = () => {
      if (tagInput.value.trim()) addTagFromInput();
    };

    // Recipient search
    const input = this._modalEl.querySelector('#vmsg-recipient-input');
    input.oninput = () => {
      clearTimeout(this._searchDebounce);
      this._searchDebounce = setTimeout(() => this.searchUsers(input.value), 300);
    };

    // Re-record / re-capture
    this._modalEl.querySelector('#vmsg-rerecord').onclick = () => {
      if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
      this.recordedBlob = null;
      this.capturedPhotoBlob = null;
      this.selectedRecipient = null;
      this.isPrivate = false;
      this._tags = [];
      this._nearbyPlaces = [];
      this._selectedPlace = null;
      this.closeModal();
      if (this.isPhotoMode) {
        this.startPhotoFlow();
      } else {
        this.startFlow();
      }
    };

    // Try auto GPS location
    const locationBtn = this._modalEl.querySelector('#vmsg-select-location');
    this._tryAutoLocation(locationBtn);
  },

  _tryAutoLocation(btn) {
    if (!navigator.geolocation) {
      // No geolocation support - show map picker
      btn.disabled = false;
      btn.textContent = 'Konumu Seç';
      this._bindLocationBtn(btn);
      return;
    }

    const GPS_ACCURACY_THRESHOLD = 25; // meters
    const GPS_TIMEOUT = 8000; // ms

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        if (accuracy <= GPS_ACCURACY_THRESHOLD) {
          // Good GPS - auto-set location and show Send button
          this.selectedLocation = { lng: longitude, lat: latitude };
          btn.disabled = false;
          btn.textContent = 'Gönder';
          btn.onclick = () => {
            if (this.isPrivate && !this.selectedRecipient) {
              AuthSystem.showNotification('Önce alıcı seçin', 'error');
              return;
            }
            this.uploadMessage();
          };
          // Fetch nearby places asynchronously
          this.fetchNearbyPlaces(latitude, longitude);
        } else {
          // Poor GPS accuracy - show map picker
          btn.disabled = false;
          btn.textContent = 'Konumu Seç';
          this._bindLocationBtn(btn);
        }
      },
      () => {
        // GPS failed - show map picker
        btn.disabled = false;
        btn.textContent = 'Konumu Seç';
        this._bindLocationBtn(btn);
      },
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT, maximumAge: 10000 }
    );
  },

  _bindLocationBtn(btn) {
    btn.onclick = () => {
      if (this.isPrivate && !this.selectedRecipient) {
        AuthSystem.showNotification('Önce alıcı seçin', 'error');
        return;
      }
      this.enterLocationSelection();
    };
  },

  // ==================== USER SEARCH ====================

  async searchUsers(query) {
    const resultsEl = this._modalEl?.querySelector('#vmsg-recipient-results');
    if (!resultsEl) return;

    query = query.trim();
    if (query.length < 2) {
      resultsEl.innerHTML = '';
      return;
    }

    try {
      const response = await fetch(`${this.apiBase}/users/search?q=${encodeURIComponent(query)}`, {
        credentials: 'include'
      });
      if (!response.ok) return;

      const data = await response.json();
      const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

      resultsEl.innerHTML = (data.users || []).map(u => `
        <div class="video-msg-recipient-item" data-id="${u.id}" data-email="${esc(u.email)}" data-name="${esc(u.display_name)}">
          <img src="${esc(u.avatar_url || '')}" alt="" onerror="this.style.display='none'">
          <div>
            <div class="name">${esc(u.display_name)}</div>
            <div class="email">${esc(u.email)}</div>
          </div>
        </div>
      `).join('');

      resultsEl.querySelectorAll('.video-msg-recipient-item').forEach(item => {
        item.onclick = () => {
          this.selectedRecipient = {
            id: parseInt(item.dataset.id),
            email: item.dataset.email,
            name: item.dataset.name
          };
          this.showSelectedRecipient();
        };
      });
    } catch (error) {
      Logger.error('[VideoMessage] User search error:', error);
    }
  },

  showSelectedRecipient() {
    const container = this._modalEl?.querySelector('#vmsg-selected-recipient');
    const input = this._modalEl?.querySelector('#vmsg-recipient-input');
    const results = this._modalEl?.querySelector('#vmsg-recipient-results');
    if (!container) return;

    const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
    const r = this.selectedRecipient;

    container.innerHTML = `
      <div class="video-msg-selected-recipient">
        <img src="${esc(r.email)}" alt="" style="display:none;">
        <span>${esc(r.name)} (${esc(r.email)})</span>
        <span class="remove" id="vmsg-remove-recipient">&times;</span>
      </div>
    `;

    if (input) input.style.display = 'none';
    if (results) results.innerHTML = '';

    container.querySelector('#vmsg-remove-recipient').onclick = () => {
      this.selectedRecipient = null;
      container.innerHTML = '';
      if (input) { input.style.display = ''; input.value = ''; }
    };
  },

  // ==================== LOCATION SELECTION ====================

  enterLocationSelection() {
    // Hide modal (shrink to allow map interaction)
    if (this._modalEl) {
      this._modalEl.style.display = 'none';
    }

    this.isSelectingLocation = true;
    const map = window.map;
    if (!map) return;

    map.getCanvas().style.cursor = 'crosshair';

    // Show hint overlay
    const hint = document.createElement('div');
    hint.className = 'video-msg-location-hint';
    hint.id = 'vmsg-location-hint';
    hint.innerHTML = `
      <span class="hint-icon">📍</span>
      <span>Konumu seçin</span>
      <button class="hint-cancel" id="vmsg-hint-cancel">İptal</button>
    `;
    document.body.appendChild(hint);

    hint.querySelector('#vmsg-hint-cancel').onclick = () => this.exitLocationSelection();

    // One-time map click handler
    this._locationClickHandler = (e) => {
      this.selectedLocation = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      this.exitLocationSelection();
      // Show modal again with Send button and fetch nearby places
      if (this._modalEl) {
        this._modalEl.style.display = '';
        const locationBtn = this._modalEl.querySelector('#vmsg-select-location');
        if (locationBtn) {
          locationBtn.textContent = 'Gönder';
          locationBtn.disabled = false;
          locationBtn.onclick = () => {
            if (this.isPrivate && !this.selectedRecipient) {
              AuthSystem.showNotification('Önce alıcı seçin', 'error');
              return;
            }
            this.uploadMessage();
          };
        }
        this.fetchNearbyPlaces(e.lngLat.lat, e.lngLat.lng);
      }
    };

    map.once('click', this._locationClickHandler);
  },

  exitLocationSelection() {
    this.isSelectingLocation = false;

    const map = window.map;
    if (map) {
      map.getCanvas().style.cursor = '';
      if (this._locationClickHandler) {
        map.off('click', this._locationClickHandler);
        this._locationClickHandler = null;
      }
    }

    const hint = document.getElementById('vmsg-location-hint');
    if (hint) hint.remove();

    // Show modal again if upload hasn't started
    if (this._modalEl && !this.selectedLocation) {
      this._modalEl.style.display = '';
    }
  },

  _renderTagChips(container) {
    const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
    container.innerHTML = this._tags.map((tag, i) => `
      <span class="video-msg-tag-chip">
        ${esc(tag)}
        <span class="video-msg-tag-chip-remove" data-tag-index="${i}">&times;</span>
      </span>
    `).join('');
    container.querySelectorAll('.video-msg-tag-chip-remove').forEach(btn => {
      btn.onclick = () => {
        this._tags.splice(parseInt(btn.dataset.tagIndex), 1);
        this._renderTagChips(container);
      };
    });
  },

  // ==================== PLACE TAGGING ====================

  async fetchNearbyPlaces(lat, lng) {
    const section = this._modalEl?.querySelector('#vmsg-place-section');
    const loading = this._modalEl?.querySelector('#vmsg-place-loading');
    const list = this._modalEl?.querySelector('#vmsg-place-list');
    if (!section || !list) return;

    section.style.display = '';
    if (loading) loading.style.display = '';
    this._nearbyPlaces = [];
    this._selectedPlace = null;

    try {
      const response = await fetch(
        `${this.apiBase}/nearby-places?lat=${lat}&lng=${lng}`,
        { credentials: 'include' }
      );
      if (!response.ok) throw new Error('Failed');

      const data = await response.json();
      this._nearbyPlaces = data.places || [];

      if (loading) loading.style.display = 'none';

      if (this._nearbyPlaces.length === 0) {
        section.style.display = 'none';
        return;
      }

      const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
      list.innerHTML = this._nearbyPlaces.map(p => {
        return `
          <div class="video-msg-place-item" data-place-id="${p.id}" data-place-name="${esc(p.display_name)}">
            <span class="video-msg-place-name">${esc(p.display_name)}</span>
            ${p.formatted_address ? `<span class="video-msg-place-address">${esc(p.formatted_address)}</span>` : ''}
          </div>
        `;
      }).join('');

      list.querySelectorAll('.video-msg-place-item').forEach(item => {
        item.onclick = () => {
          this._selectedPlace = {
            id: parseInt(item.dataset.placeId),
            name: item.dataset.placeName
          };
          this._showSelectedPlace();
        };
      });

    } catch (err) {
      Logger.warn('[VideoMessage] Nearby places fetch failed:', err);
      if (section) section.style.display = 'none';
    }
  },

  _showSelectedPlace() {
    const list = this._modalEl?.querySelector('#vmsg-place-list');
    const selected = this._modalEl?.querySelector('#vmsg-selected-place');
    if (!selected || !this._selectedPlace) return;

    const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
    selected.style.display = '';
    if (list) list.style.display = 'none';

    selected.innerHTML = `
      <div class="video-msg-place-chip">
        <svg class="video-msg-place-pin-chip" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
        <span>${esc(this._selectedPlace.name)}</span>
        <span class="video-msg-place-remove" id="vmsg-remove-place">&times;</span>
      </div>
    `;

    selected.querySelector('#vmsg-remove-place').onclick = () => {
      this._selectedPlace = null;
      selected.style.display = 'none';
      selected.innerHTML = '';
      if (list) list.style.display = '';
    };
  },

  // ==================== UPLOAD ====================

  async uploadMessage() {
    const blob = this.isPhotoMode ? this.capturedPhotoBlob : this.recordedBlob;
    if (!blob || !this.selectedLocation) return;

    // Client-side file size check (max 20MB)
    const MAX_SIZE = 20 * 1024 * 1024;
    if (blob.size > MAX_SIZE) {
      AuthSystem.showNotification(`Dosya çok büyük (${(blob.size / 1024 / 1024).toFixed(1)}MB). Maksimum 20MB.`, 'error');
      return;
    }

    // Show modal with progress
    if (this._modalEl) {
      this._modalEl.style.display = '';
    }

    const formData = new FormData();
    // Fields MUST come before file for @fastify/multipart request.file() to parse them
    formData.append('lng', this.selectedLocation.lng);
    formData.append('lat', this.selectedLocation.lat);
    if (!this.isPhotoMode) {
      formData.append('duration_ms', this._durationMs);
    }
    if (this.isPrivate && this.selectedRecipient) {
      formData.append('recipient_email', this.selectedRecipient.email);
    }
    const descInput = this._modalEl?.querySelector('#vmsg-description');
    if (descInput && descInput.value.trim()) {
      formData.append('description', descInput.value.trim());
    }
    // Grab any remaining text in tag input before upload
    const tagInputEl = this._modalEl?.querySelector('#vmsg-tag-input');
    if (tagInputEl && tagInputEl.value.trim()) {
      const val = tagInputEl.value.trim().replace(/,/g, '');
      if (val && (!this._tags || this._tags.length < 5) && !(this._tags || []).includes(val)) {
        if (!this._tags) this._tags = [];
        this._tags.push(val);
      }
    }
    if (this._tags && this._tags.length > 0) {
      formData.append('tags', this._tags.join(','));
    }
    if (this._selectedPlace) {
      formData.append('place_id', this._selectedPlace.id);
    }
    if (this.isPhotoMode) {
      // Send photo metadata
      const photoMeta = {
        width: this._capturedWidth,
        height: this._capturedHeight,
        zoom: this._photoZoomLevel,
        flash: this._flashEnabled,
        resolution: this._photoResolution
      };
      formData.append('photo_metadata', JSON.stringify(photoMeta));
      const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
      formData.append('video', blob, `photo.${ext}`);
    } else {
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      formData.append('video', blob, `message.${ext}`);
    }

    // Show progress UI
    const progressEl = this._modalEl?.querySelector('#vmsg-progress');
    const progressBar = this._modalEl?.querySelector('#vmsg-progress-bar');
    const progressText = this._modalEl?.querySelector('#vmsg-progress-text');
    const actions = this._modalEl?.querySelector('.video-msg-actions');

    if (progressEl) progressEl.style.display = '';
    if (progressText) { progressText.style.display = ''; progressText.textContent = 'Yükleniyor...'; }
    if (actions) actions.style.display = 'none';

    try {
      const uploadStartTime = Date.now();
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', this.apiBase, true);
        xhr.withCredentials = true;

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && progressBar) {
            const pct = Math.round((e.loaded / e.total) * 100);
            progressBar.style.width = pct + '%';
            if (progressText) {
              const elapsed = (Date.now() - uploadStartTime) / 1000;
              if (pct > 0 && pct < 100 && elapsed > 1) {
                const speed = e.loaded / elapsed;
                const remaining = Math.ceil((e.total - e.loaded) / speed);
                const eta = remaining < 60 ? `${remaining}s` : `${Math.floor(remaining / 60)}dk ${remaining % 60}s`;
                progressText.textContent = `Yükleniyor... ${pct}% (${eta} kaldı)`;
              } else {
                progressText.textContent = `Yükleniyor... ${pct}%`;
              }
            }
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); }
            catch { resolve({ status: 'ok' }); }
          } else {
            try { reject(new Error(JSON.parse(xhr.responseText).error || `HTTP ${xhr.status}`)); }
            catch { reject(new Error(`HTTP ${xhr.status}`)); }
          }
        };

        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(formData);
      });

      // Success
      if (result.message) {
        const msg = result.message;
        this.videoMessages.set(msg.message_id, msg);
        this.updateMapLayer();
      }

      _haptic('success');
      this.cleanupAndClose();
      Analytics.event('video_message_create', { type: this.isPhotoMode ? 'photo' : 'video', has_location: !!this.selectedLocation, is_private: !!this.isPrivate });
      AuthSystem.showNotification(this.isPhotoMode ? 'Foto mesaj gönderildi' : 'Video mesaj gönderildi', 'success');

      // Fly to location
      if (window.map && this.selectedLocation) {
        window.map.flyTo({
          center: [this.selectedLocation.lng, this.selectedLocation.lat],
          zoom: Math.max(window.map.getZoom(), 14)
        });
      }

    } catch (error) {
      Logger.error('[VideoMessage] Upload error:', error);
      AuthSystem.showNotification(error.message || 'Yükleme başarısız', 'error');

      // Restore actions
      if (progressEl) progressEl.style.display = 'none';
      if (progressText) progressText.style.display = 'none';
      if (actions) actions.style.display = '';
      this.selectedLocation = null;
    }
  },

  // ==================== VIDEO ORIENTATION ====================

  _applyVideoOrientation(container, stream, videoEl) {
    if (!container) return;

    const apply = () => {
      let w, h;
      if (videoEl && videoEl.videoWidth) {
        w = videoEl.videoWidth;
        h = videoEl.videoHeight;
      } else if (stream) {
        const track = stream.getVideoTracks()[0];
        if (track) {
          const s = track.getSettings();
          w = s.width;
          h = s.height;
        }
      }
      if (!w || !h) return;

      // On mobile landscape, camera may still report portrait dimensions
      // but the browser rotates the display. Swap to match device orientation.
      const isDeviceLandscape = window.innerWidth > window.innerHeight;
      if (isDeviceLandscape && h > w) {
        [w, h] = [h, w];
      }

      const isPortrait = h > w;
      const isMobileLandscape = isDeviceLandscape && window.innerHeight <= 500;

      container.style.aspectRatio = `${w} / ${h}`;
      container.classList.toggle('vmsg-portrait', isPortrait);

      if (isMobileLandscape) {
        // Mobile landscape: height is the constraint, width follows from aspect-ratio
        container.style.maxWidth = 'none';
        container.style.width = 'auto';
        container.style.height = 'calc(100vh - 16px)';
      } else {
        container.style.height = '';
        container.style.width = '';
        if (isPortrait) {
          container.style.maxWidth = `min(360px, calc((100vh - 120px) * ${w} / ${h}))`;
        } else {
          container.style.maxWidth = `min(640px, calc((100vh - 120px) * ${w} / ${h}))`;
        }
      }
    };

    // Try immediate detection from track settings
    if (stream) {
      const track = stream.getVideoTracks()[0];
      if (track) {
        const s = track.getSettings();
        if (s.width && s.height) apply();
      }
    }
    // Backup: detect from video element metadata
    if (videoEl) {
      videoEl.addEventListener('loadedmetadata', apply, { once: true });
    }

    // Listen for device orientation changes (resize)
    if (this._orientationHandler) {
      window.removeEventListener('resize', this._orientationHandler);
    }
    this._orientationHandler = apply;
    window.addEventListener('resize', apply);
  },

  // ==================== CAMERA SWITCH ====================

  async switchCamera() {
    if (!this.mediaStream || this.isRecording) return;

    try {
      const newMode = this.currentFacingMode === 'user' ? 'environment' : 'user';

      const rawStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: this.RESOLUTION.width },
          height: { ideal: this.RESOLUTION.height },
          aspectRatio: { ideal: 16 / 9 },
          frameRate: { ideal: 25, max: 25 },
          facingMode: { exact: newMode }
        },
        audio: true
      });

      // Stop old stream, raw audio track and audio context
      this.mediaStream.getTracks().forEach(t => t.stop());
      if (this._rawAudioTrack) { this._rawAudioTrack.stop(); this._rawAudioTrack = null; }
      if (this._audioCtx) { this._audioCtx.close().catch(() => {}); this._audioCtx = null; }
      this.mediaStream = this._processAudio(rawStream);
      this.currentFacingMode = newMode;

      // Update video preview
      const video = this._modalEl?.querySelector('#vmsg-preview-video');
      if (video) video.srcObject = this.mediaStream;

      // Re-detect orientation for new camera
      const container = this._modalEl?.querySelector('#vmsg-video-container');
      this._applyVideoOrientation(container, this.mediaStream, video);

      Logger.log('[VideoMessage] Camera switched to', newMode);
    } catch (error) {
      Logger.error('[VideoMessage] Camera switch failed:', error);
      AuthSystem.showNotification('Kamera değiştirilemedi', 'error');
    }
  },

  // ==================== CAMERA ENUMERATION ====================

  async _enumerateCameras() {
    try {
      // First enumerate with current permission
      let devices = await navigator.mediaDevices.enumerateDevices();
      let cameras = devices.filter(d => d.kind === 'videoinput');

      // If we only see ≤2 cameras, try unlocking more by briefly requesting
      // the opposite facingMode (some devices hide cameras until both are accessed)
      if (cameras.length <= 2) {
        const oppositeMode = this.currentFacingMode === 'user' ? 'environment' : 'user';
        try {
          const tempStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { exact: oppositeMode } }
          });
          tempStream.getTracks().forEach(t => t.stop());
          // Re-enumerate after unlocking
          devices = await navigator.mediaDevices.enumerateDevices();
          cameras = devices.filter(d => d.kind === 'videoinput');
        } catch (e) {
          // Ignore — opposite camera might not exist
        }
      }

      this._cameras = cameras;
      Logger.log('[VideoMessage] Found', this._cameras.length, 'cameras');
    } catch (e) {
      Logger.warn('[VideoMessage] enumerateDevices failed:', e);
      this._cameras = [];
    }
  },

  _getCameraLabel(device, index) {
    const label = (device.label || '').toLowerCase();
    if (label.includes('front') || label.includes('user') || label.includes('facing front')) return 'Ön Kamera';
    if (label.includes('wide') || label.includes('ultra')) return 'Geniş Açı';
    if (label.includes('tele')) return 'Telefoto';
    if (label.includes('back') || label.includes('environment') || label.includes('facing back') || label.includes('rear')) return 'Arka Kamera';
    if (device.label) return device.label.substring(0, 20);
    return `Kamera ${index + 1}`;
  },

  _showCameraDropdown() {
    // Remove existing dropdown
    const existing = this._modalEl?.querySelector('.vmsg-camera-dropdown');
    if (existing) { existing.remove(); return; }

    if (!this._cameras || this._cameras.length < 2) return;

    const btn = this._modalEl?.querySelector('#vmsg-switch-cam');
    if (!btn) return;

    const dropdown = document.createElement('div');
    dropdown.className = 'vmsg-camera-dropdown';

    this._cameras.forEach((cam, i) => {
      const opt = document.createElement('div');
      opt.className = 'vmsg-camera-option';
      if (cam.deviceId === this._selectedCameraId) opt.classList.add('active');
      opt.textContent = this._getCameraLabel(cam, i);
      opt.onclick = (e) => {
        e.stopPropagation();
        dropdown.remove();
        if (cam.deviceId !== this._selectedCameraId) {
          this._switchToCamera(cam.deviceId);
        }
      };
      dropdown.appendChild(opt);
    });

    // Position relative to the button's parent
    const parent = btn.parentElement;
    parent.style.position = 'relative';
    parent.appendChild(dropdown);

    // Close on outside click
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && e.target !== btn) {
        dropdown.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  },

  async _switchToCamera(deviceId) {
    if (!this.mediaStream) return;

    try {
      const rawStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: this.RESOLUTION.width },
          height: { ideal: this.RESOLUTION.height },
          aspectRatio: { ideal: 16 / 9 },
          frameRate: { ideal: 25, max: 25 }
        },
        audio: true
      });

      // Stop old stream and audio context
      this.mediaStream.getTracks().forEach(t => t.stop());
      if (this._rawAudioTrack) { this._rawAudioTrack.stop(); this._rawAudioTrack = null; }
      if (this._audioCtx) { this._audioCtx.close().catch(() => {}); this._audioCtx = null; }
      this.mediaStream = this._processAudio(rawStream);
      this._selectedCameraId = deviceId;

      // Update facing mode from new track
      const settings = this.mediaStream.getVideoTracks()[0]?.getSettings();
      if (settings?.facingMode) this.currentFacingMode = settings.facingMode;

      // Update video preview
      const video = this._modalEl?.querySelector('#vmsg-preview-video');
      if (video) video.srcObject = this.mediaStream;

      const container = this._modalEl?.querySelector('#vmsg-video-container');
      this._applyVideoOrientation(container, this.mediaStream, video);

      Logger.log('[VideoMessage] Switched to camera:', deviceId);
    } catch (error) {
      Logger.error('[VideoMessage] Camera switch failed:', error);
      AuthSystem.showNotification('Kamera değiştirilemedi', 'error');
    }
  },

  // ==================== AUDIO PROCESSING ====================

  _processAudio(rawStream) {
    // Web Audio API: force mono downmix + resample to 22050 Hz
    // - getUserMedia constraints for sampleRate/channelCount are NOT enforced by browsers
    // - Opus codec (WebM) always reports 48kHz regardless of input, so we prefer MP4/AAC
    // - MediaStreamAudioDestinationNode.channelCount is buggy; use explicit GainNode for mono
    try {
      const ctx = new AudioContext({ sampleRate: 22050 });
      Logger.log('[VideoMessage] AudioContext created, actual sampleRate:', ctx.sampleRate);

      const source = ctx.createMediaStreamSource(rawStream);

      // Force mono through a GainNode (more reliable than dest.channelCount)
      const mono = ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';
      mono.gain.value = 1;

      const dest = ctx.createMediaStreamDestination();

      source.connect(mono);
      mono.connect(dest);

      // Combine original video track with processed audio track
      const videoTrack = rawStream.getVideoTracks()[0];
      const processedAudio = dest.stream.getAudioTracks()[0];
      const combined = new MediaStream([videoTrack, processedAudio]);

      const audioSettings = processedAudio.getSettings ? processedAudio.getSettings() : {};
      Logger.log('[VideoMessage] Processed audio track settings:', JSON.stringify(audioSettings));

      // Store for cleanup
      this._audioCtx = ctx;
      this._rawAudioTrack = rawStream.getAudioTracks()[0];

      return combined;
    } catch (e) {
      Logger.warn('[VideoMessage] Audio processing failed, using raw stream:', e);
      return rawStream;
    }
  },

  // ==================== CODEC DETECTION ====================

  getPreferredMimeType() {
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  },

  // ==================== MAP LAYER ====================

  initMapLayer() {
    if (window.map && window.map.isStyleLoaded()) {
      this.addVideoMessageLayer(window.map);
    } else if (window.map) {
      window.map.on('load', () => this.addVideoMessageLayer(window.map));
    } else {
      setTimeout(() => this.initMapLayer(), 500);
    }
  },

  addVideoMessageLayer(map) {
    if (map.getSource('video-messages')) {
      this.updateMapLayer();
      return;
    }

    this.loadVideoMessageIcon(map, () => {
      this.loadPhotoMessageIcon(map, () => {
        if (map.getSource('video-messages')) {
          this.updateMapLayer();
          return;
        }

        // ---- Video messages source & layers ----
        map.addSource('video-messages', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          cluster: true,
          clusterMaxZoom: 14,
          clusterRadius: 50
        });

        map.addLayer({
          id: 'video-message-clusters',
          type: 'circle',
          source: 'video-messages',
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': ['step', ['get', 'point_count'], '#e8a87c', 10, '#d4946a', 30, '#c07f58'],
            'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 30, 22],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff'
          }
        });

        map.addLayer({
          id: 'video-message-cluster-count',
          type: 'symbol',
          source: 'video-messages',
          filter: ['has', 'point_count'],
          layout: {
            'text-field': '{point_count_abbreviated}',
            'text-font': ['Noto Sans Medium'],
            'text-size': 12
          }
        });

        map.addLayer({
          id: 'video-messages',
          type: 'symbol',
          source: 'video-messages',
          filter: ['!', ['has', 'point_count']],
          layout: {
            'icon-image': 'video-message-icon',
            'icon-size': /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 0.35 : 0.4,
            'icon-allow-overlap': true
          }
        });

        // ---- Photo messages source & layers ----
        map.addSource('photo-messages', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          cluster: true,
          clusterMaxZoom: 14,
          clusterRadius: 50
        });

        map.addLayer({
          id: 'photo-message-clusters',
          type: 'circle',
          source: 'photo-messages',
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': ['step', ['get', 'point_count'], '#7cb3e8', 10, '#5a9ad4', 30, '#3d7ebf'],
            'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 30, 22],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff'
          }
        });

        map.addLayer({
          id: 'photo-message-cluster-count',
          type: 'symbol',
          source: 'photo-messages',
          filter: ['has', 'point_count'],
          layout: {
            'text-field': '{point_count_abbreviated}',
            'text-font': ['Noto Sans Medium'],
            'text-size': 12
          }
        });

        map.addLayer({
          id: 'photo-messages',
          type: 'symbol',
          source: 'photo-messages',
          filter: ['!', ['has', 'point_count']],
          layout: {
            'icon-image': 'photo-message-icon',
            'icon-size': /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 0.35 : 0.4,
            'icon-allow-overlap': true
          }
        });

        // ---- Event handlers for video layers ----
        map.on('click', 'video-message-clusters', (e) => {
          const features = map.queryRenderedFeatures(e.point, { layers: ['video-message-clusters'] });
          if (!features.length) return;
          const clusterId = features[0].properties.cluster_id;
          map.getSource('video-messages').getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err) return;
            map.easeTo({ center: features[0].geometry.coordinates, zoom });
          });
        });

        map.on('click', 'video-messages', (e) => {
          if (this.isSelectingLocation) return;
          if (e.features && e.features.length > 0) {
            const feature = e.features[0];
            const coords = feature.geometry.coordinates.slice();
            const props = feature.properties;
            while (Math.abs(e.lngLat.lng - coords[0]) > 180) {
              coords[0] += e.lngLat.lng > coords[0] ? 360 : -360;
            }
            this.openMessagePopup(props, coords);
          }
        });

        // ---- Event handlers for photo layers ----
        map.on('click', 'photo-message-clusters', (e) => {
          const features = map.queryRenderedFeatures(e.point, { layers: ['photo-message-clusters'] });
          if (!features.length) return;
          const clusterId = features[0].properties.cluster_id;
          map.getSource('photo-messages').getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err) return;
            map.easeTo({ center: features[0].geometry.coordinates, zoom });
          });
        });

        map.on('click', 'photo-messages', (e) => {
          if (this.isSelectingLocation) return;
          if (e.features && e.features.length > 0) {
            const feature = e.features[0];
            const coords = feature.geometry.coordinates.slice();
            const props = feature.properties;
            while (Math.abs(e.lngLat.lng - coords[0]) > 180) {
              coords[0] += e.lngLat.lng > coords[0] ? 360 : -360;
            }
            this.openMessagePopup(props, coords);
          }
        });

        // ---- Cursor handlers ----
        map.on('mouseenter', 'video-message-clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'video-message-clusters', () => { map.getCanvas().style.cursor = ''; });
        map.on('mouseenter', 'video-messages', () => { if (!this.isSelectingLocation) map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'video-messages', () => { if (!this.isSelectingLocation) map.getCanvas().style.cursor = ''; });
        map.on('mouseenter', 'photo-message-clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'photo-message-clusters', () => { map.getCanvas().style.cursor = ''; });
        map.on('mouseenter', 'photo-messages', () => { if (!this.isSelectingLocation) map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'photo-messages', () => { if (!this.isSelectingLocation) map.getCanvas().style.cursor = ''; });

        this.updateMapLayer();
      });
    });
  },

  loadVideoMessageIcon(map, callback) {
    const size = 48;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10.5" fill="#e8a87c" stroke="white" stroke-width="1.5"/>
        <polygon points="10,7 10,17 18,12" fill="white"/>
      </svg>
    `;

    const base64 = 'data:image/svg+xml;base64,' + btoa(svg);
    const img = new Image(size, size);
    img.onload = () => {
      if (!map.hasImage('video-message-icon')) {
        map.addImage('video-message-icon', img);
      }
      callback();
    };
    img.onerror = () => {
      Logger.warn('[VideoMessage] Icon load failed');
      callback();
    };
    img.src = base64;
  },

  loadPhotoMessageIcon(map, callback) {
    const size = 48;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10.5" fill="#5a9ad4" stroke="white" stroke-width="1.5"/>
        <rect x="7" y="8.5" width="10" height="8" rx="1.2" fill="white"/>
        <circle cx="12" cy="12.5" r="2.2" fill="#5a9ad4"/>
        <circle cx="12" cy="12.5" r="1" fill="white"/>
        <rect x="9" y="7.5" width="3" height="1.5" rx="0.5" fill="white"/>
      </svg>
    `;

    const base64 = 'data:image/svg+xml;base64,' + btoa(svg);
    const img = new Image(size, size);
    img.onload = () => {
      if (!map.hasImage('photo-message-icon')) {
        map.addImage('photo-message-icon', img);
      }
      callback();
    };
    img.onerror = () => {
      Logger.warn('[VideoMessage] Photo icon load failed');
      callback();
    };
    img.src = base64;
  },

  updateMapLayer() {
    const map = window.map;
    if (!map) return;

    const allMessages = Array.from(this.videoMessages.values());
    const toFeature = (m) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [m.lng, m.lat] },
      properties: {
        messageId: m.message_id,
        senderId: m.sender_id,
        senderName: m.sender_name || '',
        senderAvatar: m.sender_avatar || '',
        recipientId: m.recipient_id,
        durationMs: m.duration_ms,
        mimeType: m.mime_type,
        mediaType: m.media_type || (m.message_id.startsWith('pmsg_') ? 'photo' : 'video'),
        isRead: m.is_read,
        createdAt: m.created_at,
        viewCount: m.view_count || 0,
        likeCount: m.like_count || 0,
        liked: m.liked ? 'true' : 'false',
        description: m.description || '',
        aiDescription: m.ai_description || '',
        tags: JSON.stringify(m.tags || []),
        thumbnailPath: m.thumbnail_path || '',
        placeName: m.place_name || ''
      }
    });

    const videoFeatures = allMessages.filter(m => (m.media_type || 'video') === 'video' && !m.message_id.startsWith('pmsg_')).map(toFeature);
    const photoFeatures = allMessages.filter(m => m.media_type === 'photo' || m.message_id.startsWith('pmsg_')).map(toFeature);

    const videoSource = map.getSource('video-messages');
    if (videoSource) videoSource.setData({ type: 'FeatureCollection', features: videoFeatures });

    const photoSource = map.getSource('photo-messages');
    if (photoSource) photoSource.setData({ type: 'FeatureCollection', features: photoFeatures });
  },

  // ==================== LOAD MESSAGES ====================

  async loadVideoMessages() {
    try {
      const response = await fetch(`${this.apiBase}`, {
        credentials: 'include'
      });
      if (!response.ok) return;

      const data = await response.json();
      this.videoMessages.clear();
      for (const m of (data.messages || [])) {
        this.videoMessages.set(m.message_id, m);
      }
      this.updateMapLayer();
    } catch (e) {
      Logger.warn('[VideoMessage] Failed to load messages');
    }
  },

  // ==================== DEEP LINK ====================

  async handleDeepLink() {
    const params = new URLSearchParams(window.location.search);
    const vmsgId = params.get('vmsg');
    if (!vmsgId) return;

    // Clean URL
    const url = new URL(window.location);
    url.searchParams.delete('vmsg');
    window.history.replaceState({}, '', url.pathname + url.search);

    // Check if already loaded
    let msg = this.videoMessages.get(vmsgId);

    // If not in local cache, fetch from API
    if (!msg) {
      try {
        const response = await fetch(`${this.apiBase}/${encodeURIComponent(vmsgId)}`, {
          credentials: 'include'
        });
        if (!response.ok) return;
        const data = await response.json();
        msg = data.message;
        if (msg) {
          this.videoMessages.set(msg.message_id, msg);
          this.updateMapLayer();
        }
      } catch (e) {
        Logger.warn('[VideoMessage] Deep link message fetch failed');
        return;
      }
    }

    if (!msg) return;

    // Wait for map to be ready, then fly to location and open popup
    const openMsg = () => {
      window.map.flyTo({ center: [msg.lng, msg.lat], zoom: Math.max(window.map.getZoom(), 16) });
      setTimeout(() => {
        this.openMessagePopup({
          messageId: msg.message_id,
          senderId: msg.sender_id,
          senderName: msg.sender_name,
          senderAvatar: msg.sender_avatar,
          recipientId: msg.recipient_id,
          durationMs: msg.duration_ms,
          mimeType: msg.mime_type,
          mediaType: msg.media_type || 'video',
          isRead: msg.is_read,
          createdAt: msg.created_at,
          viewCount: msg.view_count || 0,
          likeCount: msg.like_count || 0,
          liked: msg.liked ? 'true' : 'false',
          description: msg.description || '',
          aiDescription: msg.ai_description || '',
          tags: JSON.stringify(msg.tags || []),
          thumbnailPath: msg.thumbnail_path || '',
          placeName: msg.place_name || ''
        }, [msg.lng, msg.lat]);
      }, 1500);
    };

    if (window.map && window.map.isStyleLoaded()) {
      openMsg();
    } else if (window.map) {
      window.map.on('load', openMsg);
    } else {
      // Map not yet created, wait for it
      const waitForMap = setInterval(() => {
        if (window.map && window.map.isStyleLoaded()) {
          clearInterval(waitForMap);
          openMsg();
        }
      }, 500);
      // Give up after 10 seconds
      setTimeout(() => clearInterval(waitForMap), 10000);
    }
  },

  // ==================== POPUP ====================

  openMessagePopup(props, coordinates) {
    const map = window.map;
    if (!map) return;

    Analytics.event('video_message_view', { media_type: props.mediaType || 'video' });
    this.closeMessagePopup();

    const messageId = String(props.messageId || '');
    const senderName = props.senderName || 'Kullanıcı';
    const senderAvatar = props.senderAvatar || '';
    const recipientId = props.recipientId ? parseInt(props.recipientId) : null;
    const createdAt = props.createdAt;
    const isRead = parseInt(props.isRead) || 0;

    const timeAgo = this.formatTimeAgo(createdAt);
    const isOwn = AuthSystem.isLoggedIn() && AuthSystem.getCurrentUser()?.id === parseInt(props.senderId);
    const isPrivateMsg = recipientId !== null;

    const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

    const videoUrl = `${this.apiBase}/${encodeURIComponent(messageId)}/video`;

    const viewCount = parseInt(props.viewCount) || 0;
    const likeCount = parseInt(props.likeCount) || 0;
    const liked = props.liked === 'true' || props.liked === true;
    const isLoggedIn = AuthSystem.isLoggedIn();
    const description = props.description || '';
    const aiDescription = props.aiDescription || '';
    const placeName = props.placeName || '';
    const tags = props.tags ? (typeof props.tags === 'string' ? JSON.parse(props.tags) : props.tags) : [];
    const mediaType = props.mediaType || (messageId.startsWith('pmsg_') ? 'photo' : 'video');
    const isPhoto = mediaType === 'photo';

    const mediaBodyHtml = isPhoto
      ? `<img class="vmsg-popup-photo" alt="Foto mesaj" data-photo-src="${videoUrl}">
         <button class="vmsg-photo-expand-btn" data-action="expand-photo" title="Büyük görüntüle">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
             <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
           </svg>
         </button>`
      : `<video controls playsinline preload="metadata" crossorigin="use-credentials">
            <source src="${videoUrl}" type="${esc(props.mimeType || 'video/mp4')}">
          </video>`;

    const html = `
      <div class="video-msg-popup" data-message-id="${esc(messageId)}">
        <div class="video-msg-popup-header">
          <img class="video-msg-popup-avatar" src="${esc(senderAvatar)}" alt="" onerror="this.style.display='none'">
          <div class="video-msg-popup-sender">
            <div class="video-msg-popup-name">
              ${esc(senderName)}
              ${isPrivateMsg ? '<span class="video-msg-popup-private">Özel</span>' : ''}
            </div>
            <div class="video-msg-popup-time">
              ${esc(timeAgo)}
              <span class="video-msg-view-count" data-view-count>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                <span data-view-count-num>${viewCount}</span>
              </span>
            </div>
          </div>
          ${isLoggedIn ? `
          <button class="video-msg-like-btn${liked ? ' liked' : ''}" data-action="toggle-like" title="Beğen">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            <span data-like-count-num>${likeCount}</span>
          </button>
          ` : (likeCount > 0 ? `
          <span class="video-msg-like-btn disabled" title="Beğeni">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            <span data-like-count-num>${likeCount}</span>
          </span>
          ` : '')}
          <button class="video-msg-popup-close" title="Kapat">&times;</button>
        </div>
        <div class="video-msg-popup-body">
          ${mediaBodyHtml}
        </div>
        ${description || aiDescription || placeName || tags.length > 0 || isOwn ? `
        <div class="video-msg-popup-meta">
          ${description ? `<div class="video-msg-popup-title">${esc(description)}</div>` : ''}
          ${placeName ? `<div class="video-msg-popup-place"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg> ${esc(placeName)}</div>` : ''}
          ${aiDescription ? `<div class="video-msg-popup-ai-description">${esc(aiDescription)}</div>` : ''}
          <div class="video-msg-popup-tags" data-tags-container>
            ${tags.map(t => `<span class="video-msg-popup-tag">${esc(t)}${isOwn ? '<button class="video-msg-tag-remove" data-tag="' + esc(t) + '">&times;</button>' : ''}</span>`).join('')}
            ${isOwn ? `<button class="video-msg-tag-add" data-action="add-tag" title="Etiket ekle">+</button>` : ''}
          </div>
        </div>
        ` : ''}
        <div data-comments-container></div>
        <div class="video-msg-popup-footer">
          ${isOwn ? `<button class="video-msg-popup-action delete" data-action="delete">Sil</button>` : ''}
          ${!isPrivateMsg ? `
          <div class="video-msg-share-buttons">
            <button class="video-msg-share-btn whatsapp" data-action="share-whatsapp" title="WhatsApp'ta Paylaş">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              <span>Paylaş</span>
            </button>
            <button class="video-msg-share-btn twitter" data-action="share-twitter" title="X'te Paylaş">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              <span>Paylaş</span>
            </button>
          </div>
          ` : ''}
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

    // Wire up after DOM insertion
    setTimeout(() => {
      const popupEl = popup.getElement();
      if (!popupEl) return;

      // Close button
      const closeBtn = popupEl.querySelector('.video-msg-popup-close');
      if (closeBtn) closeBtn.onclick = () => this.closeMessagePopup();

      // Delete button
      const deleteBtn = popupEl.querySelector('[data-action="delete"]');
      if (deleteBtn) deleteBtn.onclick = () => this.deleteMessage(messageId);

      // Mark as read if private and unread
      if (isPrivateMsg && !isRead && !isOwn && AuthSystem.isLoggedIn()) {
        this.markAsRead(messageId);
      }

      // Set media credentials
      if (isPhoto) {
        const imgEl = popupEl.querySelector('.vmsg-popup-photo');
        if (imgEl) {
          this.loadPhotoWithCredentials(imgEl, videoUrl);

          // Click on photo or expand button → open fullscreen overlay
          const expandBtn = popupEl.querySelector('[data-action="expand-photo"]');
          const openOverlay = () => {
            if (imgEl.src && imgEl.src.startsWith('blob:')) {
              this.openPhotoOverlay(imgEl.src);
            }
          };
          imgEl.style.cursor = 'pointer';
          imgEl.onclick = openOverlay;
          if (expandBtn) expandBtn.onclick = openOverlay;
        }
      } else {
        const videoEl = popupEl.querySelector('video');
        if (videoEl) {
          this.loadVideoWithCredentials(videoEl, videoUrl);
        }
      }

      // Increment view count (once per session per message)
      if (!this.viewedMessages.has(messageId)) {
        this.viewedMessages.add(messageId);
        this.incrementViewCount(messageId, popupEl);
      }

      // Like button
      const likeBtn = popupEl.querySelector('[data-action="toggle-like"]');
      if (likeBtn) likeBtn.onclick = () => this.toggleLike(messageId, likeBtn);

      // Share buttons
      const whatsappBtn = popupEl.querySelector('[data-action="share-whatsapp"]');
      if (whatsappBtn) whatsappBtn.onclick = () => this.shareOnWhatsApp(messageId);

      const twitterBtn = popupEl.querySelector('[data-action="share-twitter"]');
      if (twitterBtn) twitterBtn.onclick = () => this.shareOnTwitter(messageId);

      // Tag add/remove handlers
      const addTagBtn = popupEl.querySelector('[data-action="add-tag"]');
      if (addTagBtn) {
        addTagBtn.onclick = () => {
          const container = popupEl.querySelector('[data-tags-container]');
          if (container.querySelector('.video-msg-tag-input')) return;
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'video-msg-tag-input';
          input.style.cssText = 'color:#222!important;background:#fff!important;-webkit-text-fill-color:#222;';
          input.placeholder = 'Etiket...';
          input.maxLength = 30;
          container.insertBefore(input, addTagBtn);
          input.focus();
          const commit = () => {
            const val = input.value.trim();
            if (val) this.updateMessageTags(messageId, popupEl, val, 'add');
            input.remove();
          };
          input.onkeydown = (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') input.remove(); };
          input.onblur = commit;
        };
      }
      popupEl.querySelectorAll('.video-msg-tag-remove').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          this.updateMessageTags(messageId, popupEl, btn.dataset.tag, 'remove');
        };
      });

      // Render comments
      const commentsContainer = popupEl.querySelector('[data-comments-container]');
      if (commentsContainer && typeof CommentWidget !== 'undefined') {
        CommentWidget.render(commentsContainer, 'video_message', messageId);
      }
    }, 0);
  },

  async loadVideoWithCredentials(videoEl, url) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) return;
      const blob = await response.blob();
      videoEl.src = URL.createObjectURL(blob);
    } catch (e) {
      Logger.warn('[VideoMessage] Video load failed:', e);
    }
  },

  async loadPhotoWithCredentials(imgEl, url) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) return;
      const blob = await response.blob();
      imgEl.src = URL.createObjectURL(blob);
    } catch (e) {
      Logger.warn('[VideoMessage] Photo load failed:', e);
    }
  },

  openPhotoOverlay(blobUrl) {
    // Remove existing overlay if any
    document.querySelector('.vmsg-photo-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'vmsg-photo-overlay';
    overlay.innerHTML = `
      <div class="vmsg-photo-overlay-toolbar">
        <button class="vmsg-photo-overlay-btn" data-action="zoom-in" title="Yakınlaştır">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button class="vmsg-photo-overlay-btn" data-action="zoom-out" title="Uzaklaştır">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button class="vmsg-photo-overlay-btn" data-action="zoom-reset" title="Sıfırla">1:1</button>
        <button class="vmsg-photo-overlay-btn close" data-action="close-overlay" title="Kapat">&times;</button>
      </div>
      <div class="vmsg-photo-overlay-container">
        <img src="${blobUrl}" alt="Foto mesaj" draggable="false">
      </div>
    `;
    document.body.appendChild(overlay);

    const img = overlay.querySelector('img');
    const container = overlay.querySelector('.vmsg-photo-overlay-container');
    let scale = 1;
    let panX = 0, panY = 0;
    let isPanning = false, startX = 0, startY = 0;

    const applyTransform = () => {
      img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    };

    // Zoom buttons
    overlay.querySelector('[data-action="zoom-in"]').onclick = () => {
      scale = Math.min(scale * 1.3, 8);
      applyTransform();
    };
    overlay.querySelector('[data-action="zoom-out"]').onclick = () => {
      scale = Math.max(scale / 1.3, 0.5);
      if (scale <= 1) { panX = 0; panY = 0; }
      applyTransform();
    };
    overlay.querySelector('[data-action="zoom-reset"]').onclick = () => {
      scale = 1; panX = 0; panY = 0;
      applyTransform();
    };

    // Close
    const closeOverlay = () => overlay.remove();
    overlay.querySelector('[data-action="close-overlay"]').onclick = closeOverlay;
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay(); });

    // Click on backdrop to close (but not on image)
    overlay.onclick = (e) => { if (e.target === overlay || e.target === container) closeOverlay(); };

    // Mouse wheel zoom
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      scale = Math.min(Math.max(scale * delta, 0.5), 8);
      if (scale <= 1) { panX = 0; panY = 0; }
      applyTransform();
    }, { passive: false });

    // Pan with mouse drag
    img.addEventListener('mousedown', (e) => {
      if (scale <= 1) return;
      isPanning = true;
      startX = e.clientX - panX;
      startY = e.clientY - panY;
      img.style.cursor = 'grabbing';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function handler(e) {
      if (!isPanning) return;
      panX = e.clientX - startX;
      panY = e.clientY - startY;
      applyTransform();
    });
    document.addEventListener('mouseup', function handler() {
      isPanning = false;
      if (img.parentNode) img.style.cursor = scale > 1 ? 'grab' : 'pointer';
    });

    // Touch pinch zoom & pan
    let lastTouchDist = 0;
    let lastTouchX = 0, lastTouchY = 0;
    container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        lastTouchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      } else if (e.touches.length === 1 && scale > 1) {
        isPanning = true;
        lastTouchX = e.touches[0].clientX - panX;
        lastTouchY = e.touches[0].clientY - panY;
      }
    }, { passive: true });
    container.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (lastTouchDist > 0) {
          scale = Math.min(Math.max(scale * (dist / lastTouchDist), 0.5), 8);
          if (scale <= 1) { panX = 0; panY = 0; }
          applyTransform();
        }
        lastTouchDist = dist;
      } else if (e.touches.length === 1 && isPanning) {
        e.preventDefault();
        panX = e.touches[0].clientX - lastTouchX;
        panY = e.touches[0].clientY - lastTouchY;
        applyTransform();
      }
    }, { passive: false });
    let lastTapTime = 0;
    container.addEventListener('touchend', (e) => {
      isPanning = false;
      lastTouchDist = 0;
      // Double-tap to zoom
      if (e.touches.length === 0) {
        const now = Date.now();
        if (now - lastTapTime < 300) {
          e.preventDefault();
          if (scale > 1) { scale = 1; panX = 0; panY = 0; } else { scale = 2.5; }
          applyTransform();
        }
        lastTapTime = now;
      }
    }, { passive: false });

    // Focus for keyboard events
    overlay.tabIndex = -1;
    overlay.focus();
  },

  async incrementViewCount(messageId, popupEl) {
    try {
      await fetch(`${QBitmapConfig.api.base}/api/views/video_message/${encodeURIComponent(messageId)}`, {
        method: 'POST',
        credentials: 'include'
      });
      // Update displayed count
      const countEl = popupEl?.querySelector('[data-view-count-num]');
      if (countEl) {
        countEl.textContent = parseInt(countEl.textContent || '0') + 1;
      }
      // Update local cache so next popup open shows correct count
      const cached = this.videoMessages.get(messageId);
      if (cached) {
        cached.view_count = (cached.view_count || 0) + 1;
      }
    } catch (e) {
      // Silently ignore - view count is non-critical
    }
  },

  async toggleLike(messageId, btnEl) {
    if (!AuthSystem.isLoggedIn()) return;

    // Optimistic UI update
    const isLiked = btnEl.classList.contains('liked');
    const countEl = btnEl.querySelector('[data-like-count-num]');
    const svgEl = btnEl.querySelector('svg');
    const currentCount = parseInt(countEl?.textContent || '0');

    btnEl.classList.toggle('liked');
    if (svgEl) svgEl.setAttribute('fill', isLiked ? 'none' : 'currentColor');
    if (countEl) countEl.textContent = isLiked ? Math.max(currentCount - 1, 0) : currentCount + 1;

    try {
      const res = await fetch(`${QBitmapConfig.api.base}/api/likes/video_message/${encodeURIComponent(messageId)}`, {
        method: 'POST',
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        // Reconcile with server state
        if (countEl) countEl.textContent = data.likeCount;
        if (data.liked) {
          btnEl.classList.add('liked');
          if (svgEl) svgEl.setAttribute('fill', 'currentColor');
        } else {
          btnEl.classList.remove('liked');
          if (svgEl) svgEl.setAttribute('fill', 'none');
        }
        // Update local cache
        const cached = this.videoMessages.get(messageId);
        if (cached) {
          cached.like_count = data.likeCount;
          cached.liked = data.liked;
        }
      }
    } catch (e) {
      // Revert on error
      if (isLiked) {
        btnEl.classList.add('liked');
        if (svgEl) svgEl.setAttribute('fill', 'currentColor');
      } else {
        btnEl.classList.remove('liked');
        if (svgEl) svgEl.setAttribute('fill', 'none');
      }
      if (countEl) countEl.textContent = currentCount;
    }
  },

  shareOnWhatsApp(messageId) {
    const url = `https://qbitmap.com/?vmsg=${encodeURIComponent(messageId)}`;
    const text = encodeURIComponent(`Bu video mesaji izle!\n${url}`);
    window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
  },

  shareOnTwitter(messageId) {
    const url = encodeURIComponent(`https://qbitmap.com/?vmsg=${encodeURIComponent(messageId)}`);
    const text = encodeURIComponent('Bu video mesaji izle!');
    window.open(`https://twitter.com/intent/tweet?url=${url}&text=${text}`, '_blank');
  },

  closeMessagePopup() {
    if (typeof CommentWidget !== 'undefined') CommentWidget.destroy();
    if (this.currentPopup) {
      this.currentPopup.remove();
      this.currentPopup = null;
    }
  },

  // ==================== MESSAGE ACTIONS ====================

  async markAsRead(messageId) {
    try {
      await fetch(`${this.apiBase}/${encodeURIComponent(messageId)}/read`, {
        method: 'POST',
        credentials: 'include'
      });
      // Update local state
      const msg = this.videoMessages.get(messageId);
      if (msg) msg.is_read = 1;
    } catch (e) {
      Logger.warn('[VideoMessage] Mark read failed');
    }
  },

  async deleteMessage(messageId) {
    try {
      const response = await fetch(`${this.apiBase}/${encodeURIComponent(messageId)}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Delete failed');
      }

      this.videoMessages.delete(messageId);
      this.updateMapLayer();
      this.closeMessagePopup();
      AuthSystem.showNotification('Mesaj silindi', 'success');
    } catch (error) {
      AuthSystem.showNotification(error.message || 'Silme başarısız', 'error');
    }
  },

  async updateMessageTags(messageId, popupEl, tagValue, action) {
    try {
      const msg = this.videoMessages.get(messageId);
      let currentTags = msg?.tags ? (typeof msg.tags === 'string' ? JSON.parse(msg.tags) : [...msg.tags]) : [];

      if (action === 'add' && !currentTags.includes(tagValue)) {
        currentTags.push(tagValue);
      } else if (action === 'remove') {
        currentTags = currentTags.filter(t => t !== tagValue);
      }
      currentTags = currentTags.slice(0, 5);

      const response = await fetch(`${this.apiBase}/${encodeURIComponent(messageId)}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tags: currentTags })
      });
      if (!response.ok) throw new Error('Tag update failed');

      // Update local data
      if (msg) msg.tags = currentTags;

      // Re-render tags in popup
      const container = popupEl.querySelector('[data-tags-container]');
      if (container) {
        const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
        container.innerHTML = currentTags.map(t =>
          `<span class="video-msg-popup-tag">${esc(t)}<button class="video-msg-tag-remove" data-tag="${esc(t)}">&times;</button></span>`
        ).join('') + `<button class="video-msg-tag-add" data-action="add-tag" title="Etiket ekle">+</button>`;

        // Re-bind events
        container.querySelector('[data-action="add-tag"]').onclick = () => {
          if (container.querySelector('.video-msg-tag-input')) return;
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'video-msg-tag-input';
          input.style.cssText = 'color:#222!important;background:#fff!important;-webkit-text-fill-color:#222;';
          input.placeholder = 'Etiket...';
          input.maxLength = 30;
          container.insertBefore(input, container.querySelector('[data-action="add-tag"]'));
          input.focus();
          const commit = () => {
            const val = input.value.trim();
            if (val) this.updateMessageTags(messageId, popupEl, val, 'add');
            input.remove();
          };
          input.onkeydown = (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') input.remove(); };
          input.onblur = commit;
        };
        container.querySelectorAll('.video-msg-tag-remove').forEach(btn => {
          btn.onclick = (e) => {
            e.stopPropagation();
            this.updateMessageTags(messageId, popupEl, btn.dataset.tag, 'remove');
          };
        });
      }

      this.updateMapLayer();
    } catch (error) {
      AuthSystem.showNotification('Etiket güncellenemedi', 'error');
    }
  },

  // ==================== UNREAD COUNT / BADGE ====================

  async fetchUnreadCount() {
    if (!AuthSystem.isLoggedIn()) return;
    try {
      const response = await fetch(`${this.apiBase}/unread-count`, { credentials: 'include' });
      if (!response.ok) return;
      const data = await response.json();
      this.updateBadgeCount(data.count);
    } catch {}
  },

  updateBadgeCount(count) {
    this.unreadCount = count;
    const badge = document.getElementById('video-msg-badge');
    if (badge) {
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
  },

  // ==================== INBOX ====================

  async openInbox() {
    if (!AuthSystem.isLoggedIn()) return;

    // Remove existing
    const existing = document.getElementById('vmsg-inbox-overlay');
    if (existing) existing.remove();
    const existingInbox = document.getElementById('vmsg-inbox');
    if (existingInbox) existingInbox.remove();

    // Fetch private messages for current user
    let messages = [];
    try {
      const response = await fetch(`${this.apiBase}?limit=50`, { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        const userId = AuthSystem.getCurrentUser()?.id;
        messages = (data.messages || []).filter(m => m.recipient_id === userId);
      }
    } catch {}

    const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'video-msg-inbox-overlay';
    overlay.id = 'vmsg-inbox-overlay';
    overlay.onclick = () => this.closeInbox();
    document.body.appendChild(overlay);

    // Create inbox
    const inbox = document.createElement('div');
    inbox.className = 'video-msg-inbox';
    inbox.id = 'vmsg-inbox';

    inbox.innerHTML = `
      <div class="video-msg-inbox-header">
        <span class="video-msg-inbox-title">Video Mesajlar</span>
        <button class="video-msg-inbox-close" id="vmsg-inbox-close">&times;</button>
      </div>
      <div class="video-msg-inbox-list" id="vmsg-inbox-list">
        ${messages.length === 0 ? '<div class="video-msg-inbox-empty">Henüz video mesajınız yok</div>' :
          messages.map(m => `
            <div class="video-msg-inbox-item ${m.is_read ? '' : 'unread'}" data-message-id="${esc(m.message_id)}" data-lng="${m.lng}" data-lat="${m.lat}">
              <img src="${esc(m.sender_avatar || '')}" alt="" onerror="this.style.display='none'">
              <div class="video-msg-inbox-item-info">
                <div class="video-msg-inbox-item-name">${esc(m.sender_name || 'Kullanıcı')}</div>
                <div class="video-msg-inbox-item-time">${esc(this.formatTimeAgo(m.created_at))}</div>
              </div>
              ${!m.is_read ? '<div class="video-msg-inbox-item-unread-dot"></div>' : ''}
            </div>
          `).join('')}
      </div>
    `;

    document.body.appendChild(inbox);

    inbox.querySelector('#vmsg-inbox-close').onclick = () => this.closeInbox();

    // Click on message -> fly to location and open popup
    inbox.querySelectorAll('.video-msg-inbox-item').forEach(item => {
      item.onclick = () => {
        const msgId = item.dataset.messageId;
        const lng = parseFloat(item.dataset.lng);
        const lat = parseFloat(item.dataset.lat);

        this.closeInbox();

        if (window.map) {
          window.map.flyTo({ center: [lng, lat], zoom: Math.max(window.map.getZoom(), 16) });

          // Open popup after fly animation
          setTimeout(() => {
            const msg = this.videoMessages.get(msgId);
            if (msg) {
              this.openMessagePopup({
                messageId: msg.message_id,
                senderId: msg.sender_id,
                senderName: msg.sender_name,
                senderAvatar: msg.sender_avatar,
                recipientId: msg.recipient_id,
                durationMs: msg.duration_ms,
                mimeType: msg.mime_type,
                mediaType: msg.media_type || 'video',
                isRead: msg.is_read,
                createdAt: msg.created_at,
                viewCount: msg.view_count || 0,
                likeCount: msg.like_count || 0,
                liked: msg.liked ? 'true' : 'false',
                description: msg.description || '',
                aiDescription: msg.ai_description || '',
                tags: JSON.stringify(msg.tags || []),
                thumbnailPath: msg.thumbnail_path || ''
              }, [msg.lng, msg.lat]);
            }
          }, 1500);
        }
      };
    });
  },

  closeInbox() {
    const overlay = document.getElementById('vmsg-inbox-overlay');
    if (overlay) overlay.remove();
    const inbox = document.getElementById('vmsg-inbox');
    if (inbox) inbox.remove();
  },

  // ==================== WEBSOCKET HANDLERS ====================

  handleNewMessage(payload) {
    const msg = {
      message_id: payload.messageId,
      sender_id: payload.senderId,
      sender_name: payload.senderName,
      sender_avatar: payload.senderAvatar,
      recipient_id: payload.recipientId,
      lng: payload.lng,
      lat: payload.lat,
      duration_ms: payload.durationMs,
      mime_type: payload.mimeType,
      media_type: payload.mediaType || 'video',
      is_read: 0,
      created_at: payload.createdAt,
      view_count: 0,
      like_count: 0,
      liked: false,
      description: payload.description || '',
      ai_description: payload.aiDescription || '',
      tags: payload.tags || [],
      thumbnail_path: payload.thumbnailPath || '',
      place_name: payload.placeName || ''
    };
    this.videoMessages.set(msg.message_id, msg);
    this.updateMapLayer();
  },

  handleDeletedMessage(payload) {
    this.videoMessages.delete(payload.messageId);
    this.updateMapLayer();
    // Close popup if it's showing this message
    if (this.currentPopup) {
      const el = this.currentPopup.getElement();
      if (el?.querySelector(`[data-message-id="${payload.messageId}"]`)) {
        this.closeMessagePopup();
      }
    }
  },

  handleTagsUpdated(payload) {
    const msg = this.videoMessages.get(payload.messageId);
    if (msg) msg.tags = payload.tags || [];
  },

  // ==================== HELPERS ====================

  formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    // Treat as UTC if no timezone suffix (server stores UTC without Z)
    const normalized = /Z|[+-]\d{2}:?\d{2}$/.test(dateStr) ? dateStr : dateStr + 'Z';
    const date = new Date(normalized);
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'Az önce';
    if (diffMin < 60) return `${diffMin} dk önce`;
    if (diffHour < 24) return `${diffHour} saat önce`;
    return date.toLocaleDateString('tr-TR') + ' - ' + date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  },

  // ==================== SEARCH ====================

  initSearch() {
    const bar = document.getElementById('vmsg-search-toggle');
    const input = document.getElementById('vmsg-search-bar-input');
    if (!bar || !input) return;

    // Click icon to expand
    bar.addEventListener('click', (e) => {
      if (!bar.classList.contains('expanded')) {
        e.preventDefault();
        bar.classList.add('expanded');
        input.focus();
      }
    });

    // Search on input
    input.addEventListener('input', () => {
      clearTimeout(this._searchDebounce);
      const query = input.value.trim();
      if (query.length < 2) {
        this._closeSearchResults();
        return;
      }
      this._searchDebounce = setTimeout(() => {
        Analytics.event('search_use', { query_length: query.length });
        this._ensureSearchPanel();
        this.performTagSearch(query);
      }, 400);
    });

    // ESC to close
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        input.blur();
        this._collapseSearchBar();
      }
    });

    // Collapse when clicking outside
    document.addEventListener('click', (e) => {
      if (!bar.contains(e.target) && !document.getElementById('vmsg-search-panel')?.contains(e.target)) {
        if (bar.classList.contains('expanded') && !input.value.trim()) {
          this._collapseSearchBar();
        }
        this._closeSearchResults();
      }
    });
  },

  _collapseSearchBar() {
    const bar = document.getElementById('vmsg-search-toggle');
    const input = document.getElementById('vmsg-search-bar-input');
    if (bar) bar.classList.remove('expanded');
    if (input) { input.value = ''; input.blur(); }
    this._closeSearchResults();
  },

  _ensureSearchPanel() {
    if (document.getElementById('vmsg-search-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'vmsg-search-panel';
    panel.className = 'vmsg-search-panel';
    panel.innerHTML = `
      <div class="vmsg-search-results" id="vmsg-search-results">
        <div class="vmsg-search-empty">Aranıyor...</div>
      </div>
    `;
    document.body.appendChild(panel);
  },

  _closeSearchResults() {
    const panel = document.getElementById('vmsg-search-panel');
    if (panel) panel.remove();
    this._searchDebounce = null;
  },

  async performTagSearch(query) {
    const resultsEl = document.getElementById('vmsg-search-results');
    if (!resultsEl) return;

    if (query.length < 2) {
      resultsEl.innerHTML = '<div class="vmsg-search-empty">Etiket yazarak video mesaj arayın</div>';
      return;
    }

    resultsEl.innerHTML = '<div class="vmsg-search-empty">Aranıyor...</div>';

    try {
      const response = await fetch(
        `${this.apiBase}/search?q=${encodeURIComponent(query)}&limit=20`,
        { credentials: 'include' }
      );
      if (!response.ok) throw new Error('Search failed');
      const data = await response.json();
      const messages = data.messages || [];

      if (messages.length === 0) {
        resultsEl.innerHTML = '<div class="vmsg-search-empty">Sonuç bulunamadı</div>';
        return;
      }

      const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

      resultsEl.innerHTML = messages.map(m => {
        const tags = (m.tags || []).map(t => `<span class="vmsg-search-tag">${esc(t)}</span>`).join('');
        const thumbUrl = m.thumbnail_path
          ? `${this.apiBase}/${encodeURIComponent(m.message_id)}/thumbnail`
          : '';
        const timeAgo = this.formatTimeAgo(m.created_at);

        return `
          <div class="vmsg-search-result" data-msg-id="${esc(m.message_id)}"
               data-lng="${m.lng}" data-lat="${m.lat}">
            <div class="vmsg-search-thumb">
              ${thumbUrl
                ? `<img src="${thumbUrl}" alt="" loading="lazy" onerror="this.parentElement.classList.add('no-thumb')">`
                : '<div class="vmsg-search-thumb-placeholder"><svg width="20" height="16" viewBox="0 0 36 28"><rect x="1" y="2" width="24" height="24" rx="4" fill="#e67e22"/><polygon points="28,8 35,4 35,24 28,20" fill="#e67e22"/></svg></div>'}
            </div>
            <div class="vmsg-search-info">
              <div class="vmsg-search-sender">${esc(m.sender_name || 'Kullanıcı')} <span class="vmsg-search-time">${esc(timeAgo)}</span></div>
              ${m.description ? `<div class="vmsg-search-desc">${esc(m.description)}</div>` : ''}
              <div class="vmsg-search-tags">${tags}</div>
            </div>
          </div>
        `;
      }).join('');

      // Click handler for results
      resultsEl.querySelectorAll('.vmsg-search-result').forEach(el => {
        el.addEventListener('click', () => {
          const msgId = el.dataset.msgId;
          const lng = parseFloat(el.dataset.lng);
          const lat = parseFloat(el.dataset.lat);

          // Close search panel
          const panel = document.getElementById('vmsg-search-panel');
          if (panel) panel.remove();

          // Fly to location
          if (window.map) {
            window.map.flyTo({ center: [lng, lat], zoom: Math.max(window.map.getZoom(), 16) });

            // Open popup after fly animation
            setTimeout(() => {
              const msg = this.videoMessages.get(msgId);
              if (msg) {
                this.openMessagePopup({
                  messageId: msg.message_id,
                  senderId: msg.sender_id,
                  senderName: msg.sender_name,
                  senderAvatar: msg.sender_avatar,
                  recipientId: msg.recipient_id,
                  durationMs: msg.duration_ms,
                  mimeType: msg.mime_type,
                  mediaType: msg.media_type || 'video',
                  isRead: msg.is_read,
                  createdAt: msg.created_at,
                  viewCount: msg.view_count || 0,
                  likeCount: msg.like_count || 0,
                  liked: msg.liked ? 'true' : 'false',
                  description: msg.description || '',
                  aiDescription: msg.ai_description || '',
                  tags: JSON.stringify(msg.tags || []),
                  thumbnailPath: msg.thumbnail_path || ''
                }, [msg.lng, msg.lat]);
              }
            }, 1500);
          }
        });
      });

    } catch (error) {
      Logger.warn('[VideoMessage] Search failed:', error);
      resultsEl.innerHTML = '<div class="vmsg-search-empty">Arama başarısız</div>';
    }
  },

  // ==================== CLEANUP ====================

  cancelFlow() {
    this.cleanupAndClose();
  },

  cleanupAndClose() {
    // Stop recording if active
    if (this.isRecording) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
      this.isRecording = false;
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.onstop = null; // Prevent preview
        this.mediaRecorder.stop();
      }
    }

    // Stop camera stream and audio processing
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this._rawAudioTrack) {
      this._rawAudioTrack.stop();
      this._rawAudioTrack = null;
    }
    if (this._audioCtx) {
      this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
    }

    // Revoke object URL
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }

    // Exit location selection
    if (this.isSelectingLocation) {
      this.exitLocationSelection();
    }

    // Close modal
    this.closeModal();

    // Reset state
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.recordedBlob = null;
    this.selectedLocation = null;
    this.selectedRecipient = null;
    this.isPrivate = false;
    this._durationMs = null;
    this._tags = [];
    this._nearbyPlaces = [];
    this._selectedPlace = null;
    this._cameras = [];
    this._selectedCameraId = null;

    // Reset photo state
    this.capturedPhotoBlob = null;
    this.isPhotoMode = false;
    this._photoZoomLevel = 1;
    this._photoResolution = 'high';
    this._flashEnabled = false;
    this._capturedWidth = 0;
    this._capturedHeight = 0;
  },

  closeModal() {
    if (this._orientationHandler) {
      window.removeEventListener('resize', this._orientationHandler);
      this._orientationHandler = null;
    }
    if (this._modalEl) {
      const modal = this._modalEl;
      modal.classList.add('closing');
      modal.addEventListener('animationend', () => modal.remove(), { once: true });
      this._modalEl = null;
    }
  }
};

window.VideoMessage = VideoMessage;
