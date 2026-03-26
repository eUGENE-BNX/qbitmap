import { Logger } from "../utils.js";
import { AuthSystem } from "../auth.js";

function _haptic(style) {
  if (!navigator.vibrate) return;
  const p = { light: 10, medium: 20, heavy: 30, success: [10, 50, 20] };
  navigator.vibrate(p[style] || 10);
}

const PhotoCaptureMixin = {
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
    const res = this.PHOTO_RESOLUTIONS[this._photoResolution];
    const targetW = res.width;
    const targetH = res.height; // Already 16:9 (1920x1080, 2560x1440, 3840x2160)

    // Always use canvas capture — ImageCapture.takePhoto() produces black frames
    // on many mobile devices due to GPU-only video decode paths
    this.capturedPhotoBlob = await this._canvasCapture(video, targetW, targetH);

    // If canvas capture failed, try ImageCapture.grabFrame() as fallback
    if (!this.capturedPhotoBlob && typeof ImageCapture !== 'undefined') {
      try {
        Logger.log('[VideoMessage] Canvas capture failed, trying grabFrame()');
        const imageCapture = new ImageCapture(track);
        const bitmap = await imageCapture.grabFrame();
        this.capturedPhotoBlob = await this._cropTo16x9(bitmap, targetW, targetH);
        bitmap.close();
      } catch (e) {
        Logger.warn('[VideoMessage] grabFrame also failed:', e);
      }
    }

    if (!this.capturedPhotoBlob) {
      AuthSystem.showNotification('Fotoğraf çekilemedi, tekrar deneyin', 'error');
      return;
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
    // Ensure video has a rendered frame before capture
    if (video.readyState < 2) { // HAVE_CURRENT_DATA
      await new Promise((resolve) => {
        video.addEventListener('canplay', resolve, { once: true });
        setTimeout(resolve, 1000); // Timeout safety
      });
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (!vw || !vh) {
      Logger.warn('[VideoMessage] Canvas capture: video has no dimensions', vw, vh);
      return null;
    }

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

    // Use a smaller canvas matching video dimensions first, then scale
    // This avoids mobile GPU limits with large canvases (e.g. 3840x2160)
    const captureW = Math.min(targetW, vw);
    const captureH = Math.min(targetH, vh);

    const canvas = document.createElement('canvas');
    canvas.width = captureW;
    canvas.height = captureH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      Logger.warn('[VideoMessage] Canvas 2d context unavailable');
      return null;
    }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, captureW, captureH);

    // Check if the captured image is all black (GPU decode issue on mobile)
    try {
      const sample = ctx.getImageData(
        Math.floor(captureW / 4), Math.floor(captureH / 4),
        Math.min(32, captureW), Math.min(32, captureH)
      );
      const d = sample.data;
      let nonBlack = 0;
      for (let i = 0; i < d.length; i += 16) { // Sample every 4th pixel
        if (d[i] > 5 || d[i + 1] > 5 || d[i + 2] > 5) nonBlack++;
      }
      if (nonBlack === 0) {
        Logger.warn('[VideoMessage] Canvas captured all-black frame, retrying after delay');
        // Wait and retry once — GPU may need a tick to make pixels readable
        await new Promise(r => setTimeout(r, 200));
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, captureW, captureH);

        const retry = ctx.getImageData(
          Math.floor(captureW / 4), Math.floor(captureH / 4),
          Math.min(32, captureW), Math.min(32, captureH)
        );
        let retryNonBlack = 0;
        for (let i = 0; i < retry.data.length; i += 16) {
          if (retry.data[i] > 5 || retry.data[i + 1] > 5 || retry.data[i + 2] > 5) retryNonBlack++;
        }
        if (retryNonBlack === 0) {
          Logger.warn('[VideoMessage] Still all-black after retry');
          return null;
        }
      }
    } catch (e) {
      // getImageData may fail on tainted canvas — proceed anyway
      Logger.warn('[VideoMessage] Pixel check failed:', e);
    }

    // If we captured at smaller size, scale up to target
    if (captureW < targetW || captureH < targetH) {
      const finalCanvas = document.createElement('canvas');
      finalCanvas.width = targetW;
      finalCanvas.height = targetH;
      const fctx = finalCanvas.getContext('2d');
      fctx.drawImage(canvas, 0, 0, targetW, targetH);
      return new Promise((resolve) => {
        finalCanvas.toBlob(resolve, 'image/jpeg', 0.92);
      });
    }

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
};

export { PhotoCaptureMixin, _haptic };
