import { Logger } from "../utils.js";
import { AuthSystem } from "../auth.js";
import { _haptic } from "./photo-capture.js";
import { bindTapToFocus } from "./media.js";

const RecordingMixin = {
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

    // Tap-to-focus on video element
    bindTapToFocus(video, this.mediaStream);

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
      ? { mimeType, videoBitsPerSecond: 5000000, audioBitsPerSecond: 64000 }
      : { videoBitsPerSecond: 5000000, audioBitsPerSecond: 64000 };

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
};

export { RecordingMixin };
