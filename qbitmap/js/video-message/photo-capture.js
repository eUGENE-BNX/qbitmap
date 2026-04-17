import { Logger } from "../utils.js";
import { AuthSystem } from "../auth.js";
import { applyAutofocus, bindTapToFocus, refocusCenter, getSavedCameraId, saveCameraId } from "./media.js";

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
    this._capturedPhotos = [];
    this._previewActiveIdx = 0;

    try {
      const res = this.PHOTO_RESOLUTIONS[this._photoResolution];
      const savedId = getSavedCameraId();
      const videoConstraints = {
        width: { ideal: res.width },
        height: { ideal: res.height },
        focusMode: { ideal: 'continuous' }
      };
      if (savedId) {
        videoConstraints.deviceId = { exact: savedId };
      } else {
        videoConstraints.facingMode = { ideal: this.currentFacingMode };
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      } catch (e) {
        if (savedId) {
          delete videoConstraints.deviceId;
          videoConstraints.facingMode = { ideal: this.currentFacingMode };
          stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
        } else { throw e; }
      }
      this.mediaStream = stream;
      applyAutofocus(stream);
      this._selectedCameraId = stream.getVideoTracks()[0]?.getSettings()?.deviceId || null;
      saveCameraId(this._selectedCameraId);
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
        <div class="photo-capture-strip" id="vmsg-photo-strip">
          <span class="photo-strip-counter"><span id="vmsg-photo-count">0</span>/${this.MAX_PHOTOS_PER_MESSAGE}</span>
          <div class="photo-strip-thumbs" id="vmsg-photo-thumbs"></div>
          <button class="photo-strip-finish" id="vmsg-photo-finish" disabled>Bitir</button>
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
    modal.querySelector('#vmsg-photo-finish').onclick = () => this._finishCapture();
    this._renderPhotoStrip();

    // Photo-specific controls
    this._bindPhotoZoom(modal);
    this._bindPhotoResolution(modal);
    this._bindPhotoFlash(modal);

    // Tap-to-focus on video element
    bindTapToFocus(video, this.mediaStream);
  },

  async capturePhoto() {
    if (!this.mediaStream) return;
    if (this._capturedPhotos.length >= this.MAX_PHOTOS_PER_MESSAGE) return;
    if (this._capturing) return;
    this._capturing = true;

    const captureBtn = this._modalEl?.querySelector('#vmsg-capture');
    if (captureBtn) captureBtn.classList.add('is-focusing');

    const video = this._modalEl?.querySelector('#vmsg-preview-video');
    if (!video) { this._capturing = false; if (captureBtn) captureBtn.classList.remove('is-focusing'); return; }

    const track = this.mediaStream.getVideoTracks()[0];
    const res = this.PHOTO_RESOLUTIONS[this._photoResolution];

    // Trigger fresh autofocus before each shot — fixes the case where the
    // user has panned/tilted the camera between captures and the lens is
    // still focused on the previous scene.
    await refocusCenter(this.mediaStream);

    if (captureBtn) captureBtn.classList.remove('is-focusing');

    // Detect portrait: check if the container has portrait class (set by _applyVideoOrientation)
    // We can't rely on video.videoWidth/Height — mobile browsers report sensor dimensions
    // (always landscape) even when the phone is held in portrait.
    const container = this._modalEl?.querySelector('#vmsg-video-container');
    const isPortrait = container?.classList.contains('vmsg-portrait') || false;
    const targetW = isPortrait ? res.height : res.width;
    const targetH = isPortrait ? res.width : res.height;

    // Always use canvas capture — ImageCapture.takePhoto() produces black frames
    // on many mobile devices due to GPU-only video decode paths
    let blob = await this._canvasCapture(video, targetW, targetH);

    // If canvas capture failed, try ImageCapture.grabFrame() as fallback
    if (!blob && typeof ImageCapture !== 'undefined') {
      try {
        Logger.log('[VideoMessage] Canvas capture failed, trying grabFrame()');
        const imageCapture = new ImageCapture(track);
        const bitmap = await imageCapture.grabFrame();
        blob = await this._cropToAspect(bitmap, targetW, targetH);
        bitmap.close();
      } catch (e) {
        Logger.warn('[VideoMessage] grabFrame also failed:', e);
      }
    }

    if (!blob) {
      AuthSystem.showNotification('Fotoğraf çekilemedi, tekrar deneyin', 'error');
      this._capturing = false;
      return;
    }

    _haptic('medium');

    const objectUrl = URL.createObjectURL(blob);
    this._capturedPhotos.push({ blob, width: targetW, height: targetH, objectUrl });
    // BC mirrors so existing single-photo code paths keep working
    this.capturedPhotoBlob = this._capturedPhotos[0].blob;
    this._capturedWidth = this._capturedPhotos[0].width;
    this._capturedHeight = this._capturedPhotos[0].height;

    this._renderPhotoStrip();
    this._capturing = false;
  },

  _renderPhotoStrip() {
    if (!this._modalEl) return;
    const strip = this._modalEl.querySelector('#vmsg-photo-thumbs');
    const counter = this._modalEl.querySelector('#vmsg-photo-count');
    const finishBtn = this._modalEl.querySelector('#vmsg-photo-finish');
    const captureBtn = this._modalEl.querySelector('#vmsg-capture');
    if (!strip || !counter) return;

    const count = this._capturedPhotos.length;
    counter.textContent = count;
    strip.innerHTML = this._capturedPhotos.map((p, i) => `
      <div class="photo-strip-thumb${i === 0 ? ' is-primary' : ''}" data-idx="${i}">
        <img src="${p.objectUrl}" alt="Foto ${i + 1}">
        <button class="photo-strip-thumb-remove" data-idx="${i}" aria-label="Sil">&times;</button>
      </div>
    `).join('');

    strip.querySelectorAll('.photo-strip-thumb-remove').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        this._removePhotoAt(parseInt(btn.dataset.idx, 10));
      };
    });

    if (finishBtn) finishBtn.disabled = count === 0;
    if (captureBtn) {
      const atMax = count >= this.MAX_PHOTOS_PER_MESSAGE;
      captureBtn.disabled = atMax;
      captureBtn.classList.toggle('is-disabled', atMax);
    }
  },

  _removePhotoAt(idx) {
    if (idx < 0 || idx >= this._capturedPhotos.length) return;
    const removed = this._capturedPhotos.splice(idx, 1)[0];
    if (removed?.objectUrl) URL.revokeObjectURL(removed.objectUrl);
    if (this._capturedPhotos.length > 0) {
      this.capturedPhotoBlob = this._capturedPhotos[0].blob;
      this._capturedWidth = this._capturedPhotos[0].width;
      this._capturedHeight = this._capturedPhotos[0].height;
    } else {
      this.capturedPhotoBlob = null;
    }
    this._renderPhotoStrip();
  },

  _finishCapture() {
    if (this._capturedPhotos.length === 0) return;
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    this.showPhotoPreview();
  },

  // Crop any source (ImageBitmap) to target aspect ratio (center-crop, with rotation for portrait)
  _cropToAspect(source, targetW, targetH) {
    const srcW = source.width;
    const srcH = source.height;
    const needsRotation = targetW < targetH && srcW > srcH;
    const cropRatio = needsRotation ? (targetH / targetW) : (targetW / targetH);
    const srcRatio = srcW / srcH;

    let sx, sy, sw, sh;
    if (srcRatio > cropRatio) {
      sh = srcH;
      sw = Math.round(srcH * cropRatio);
      sx = Math.round((srcW - sw) / 2);
      sy = 0;
    } else {
      sw = srcW;
      sh = Math.round(srcW / cropRatio);
      sx = 0;
      sy = Math.round((srcH - sh) / 2);
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');

    if (needsRotation) {
      ctx.translate(targetW / 2, targetH / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(source, sx, sy, sw, sh, -targetH / 2, -targetW / 2, targetH, targetW);
    } else {
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, targetW, targetH);
    }

    return new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.92);
    });
  },

  // Canvas capture from video element, with optional portrait rotation
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

    // On mobile, videoWidth/Height are always the sensor's native (landscape) dims.
    // If targetW < targetH (portrait), we need to rotate the captured frame 90° CW.
    const needsRotation = targetW < targetH && vw > vh;

    // Source dimensions for cropping (before rotation)
    // If rotating, the target aspect ratio in source space is inverted
    const cropRatio = needsRotation ? (targetH / targetW) : (targetW / targetH);
    const srcRatio = vw / vh;

    let sx, sy, sw, sh;
    if (srcRatio > cropRatio) {
      sh = vh;
      sw = Math.round(vh * cropRatio);
      sx = Math.round((vw - sw) / 2);
      sy = 0;
    } else {
      sw = vw;
      sh = Math.round(vw / cropRatio);
      sx = 0;
      sy = Math.round((vh - sh) / 2);
    }

    // Capture at source resolution first (avoid mobile GPU limits)
    const captureW = Math.min(needsRotation ? targetH : targetW, sw);
    const captureH = Math.min(needsRotation ? targetW : targetH, sh);

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
      for (let i = 0; i < d.length; i += 16) {
        if (d[i] > 5 || d[i + 1] > 5 || d[i + 2] > 5) nonBlack++;
      }
      if (nonBlack === 0) {
        Logger.warn('[VideoMessage] Canvas captured all-black frame, retrying after delay');
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
      Logger.warn('[VideoMessage] Pixel check failed:', e);
    }

    // Final canvas: apply rotation if portrait + scale to target
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = targetW;
    finalCanvas.height = targetH;
    const fctx = finalCanvas.getContext('2d');

    if (needsRotation) {
      // Rotate 90° CW: translate to center, rotate, draw
      fctx.translate(targetW / 2, targetH / 2);
      fctx.rotate(Math.PI / 2);
      // After rotation, draw centered (swapped dimensions)
      fctx.drawImage(canvas, -targetH / 2, -targetW / 2, targetH, targetW);
    } else if (captureW < targetW || captureH < targetH) {
      // Scale up to target
      fctx.drawImage(canvas, 0, 0, targetW, targetH);
    } else {
      // No transform needed, use capture canvas directly
      return new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', 0.92);
      });
    }

    return new Promise((resolve) => {
      finalCanvas.toBlob(resolve, 'image/jpeg', 0.92);
    });
  },

  showPhotoPreview() {
    if (!this._modalEl) return;

    // Ensure _capturedPhotos has at least the legacy single blob
    if ((!this._capturedPhotos || this._capturedPhotos.length === 0) && this.capturedPhotoBlob) {
      this._capturedPhotos = [{
        blob: this.capturedPhotoBlob,
        width: this._capturedWidth || 0,
        height: this._capturedHeight || 0,
        objectUrl: URL.createObjectURL(this.capturedPhotoBlob)
      }];
    }
    if (!this._capturedPhotos || this._capturedPhotos.length === 0) return;

    this._previewActiveIdx = 0;
    const total = this._capturedPhotos.length;
    const firstUrl = this._capturedPhotos[0].objectUrl;

    this._modalEl.innerHTML = `
      <div class="video-msg-modal-content">
        <div class="video-msg-video-container photo-preview-container">
          <img id="vmsg-photo-preview" src="${firstUrl}" alt="Captured photo">
          <div class="vmsg-preview-carousel-overlay" data-total="${total}">
            <div class="vmsg-preview-counter"><span data-curr>1</span>/${total}</div>
            <button class="vmsg-preview-arrow vmsg-preview-prev" aria-label="Önceki" ${total <= 1 ? 'disabled' : ''}>‹</button>
            <button class="vmsg-preview-arrow vmsg-preview-next" aria-label="Sonraki" ${total <= 1 ? 'disabled' : ''}>›</button>
            <div class="vmsg-preview-dots">
              ${this._capturedPhotos.map((_, i) => `<span class="vmsg-preview-dot${i === 0 ? ' active' : ''}" data-idx="${i}"></span>`).join('')}
            </div>
          </div>
          <div class="vmsg-preview-thumbs">
            ${this._capturedPhotos.map((p, i) => `
              <div class="vmsg-preview-thumb${i === 0 ? ' active' : ''}" data-idx="${i}">
                <img src="${p.objectUrl}" alt="Foto ${i + 1}">
                <button class="vmsg-preview-thumb-remove" data-idx="${i}" aria-label="Sil">&times;</button>
              </div>
            `).join('')}
          </div>
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
            <button class="video-msg-action-btn danger" id="vmsg-cancel-send">Vazgeç</button>
            <button class="video-msg-action-btn secondary" id="vmsg-rerecord">Tekrar Çek</button>
            <button class="video-msg-action-btn primary" id="vmsg-select-location" disabled>Konum alınıyor...</button>
          </div>
        </div>
      </div>
    `;

    // Detect photo orientation (re-runs on each carousel switch)
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

    this._objectUrl = firstUrl;
    this._bindPreviewCarousel();
    this._bindSendPanel();
  },

  _bindPreviewCarousel() {
    if (!this._modalEl) return;
    const overlay = this._modalEl.querySelector('.vmsg-preview-carousel-overlay');
    if (!overlay) return;

    const setIdx = (idx) => {
      const total = this._capturedPhotos.length;
      if (total === 0) return;
      this._previewActiveIdx = ((idx % total) + total) % total;
      const photo = this._capturedPhotos[this._previewActiveIdx];
      const img = this._modalEl.querySelector('#vmsg-photo-preview');
      if (img && photo) img.src = photo.objectUrl;
      const curr = overlay.querySelector('[data-curr]');
      if (curr) curr.textContent = this._previewActiveIdx + 1;
      overlay.querySelectorAll('.vmsg-preview-dot').forEach((d, i) => {
        d.classList.toggle('active', i === this._previewActiveIdx);
      });
      this._modalEl.querySelectorAll('.vmsg-preview-thumb').forEach((t, i) => {
        t.classList.toggle('active', i === this._previewActiveIdx);
      });
    };

    overlay.querySelector('.vmsg-preview-prev').onclick = () => setIdx(this._previewActiveIdx - 1);
    overlay.querySelector('.vmsg-preview-next').onclick = () => setIdx(this._previewActiveIdx + 1);
    overlay.querySelectorAll('.vmsg-preview-dot').forEach(d => {
      d.onclick = () => setIdx(parseInt(d.dataset.idx, 10));
    });

    this._modalEl.querySelectorAll('.vmsg-preview-thumb').forEach(thumb => {
      thumb.onclick = (e) => {
        if (e.target.classList.contains('vmsg-preview-thumb-remove')) return;
        setIdx(parseInt(thumb.dataset.idx, 10));
      };
    });
    this._modalEl.querySelectorAll('.vmsg-preview-thumb-remove').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const removeIdx = parseInt(btn.dataset.idx, 10);
        if (this._capturedPhotos.length <= 1) return; // Keep at least 1
        const removed = this._capturedPhotos.splice(removeIdx, 1)[0];
        if (removed?.objectUrl) URL.revokeObjectURL(removed.objectUrl);
        this.capturedPhotoBlob = this._capturedPhotos[0].blob;
        this._capturedWidth = this._capturedPhotos[0].width;
        this._capturedHeight = this._capturedPhotos[0].height;
        // Re-render preview entirely (counter, dots, thumbs change)
        this.showPhotoPreview();
      };
    });

    // Touch swipe (mobile)
    const container = this._modalEl.querySelector('.photo-preview-container');
    if (container && this._capturedPhotos.length > 1) {
      let startX = 0, startY = 0, swiping = false;
      container.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        swiping = true;
      }, { passive: true });
      container.addEventListener('touchend', (e) => {
        if (!swiping) return;
        swiping = false;
        const t = e.changedTouches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          setIdx(this._previewActiveIdx + (dx < 0 ? 1 : -1));
        }
      }, { passive: true });
    }
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
            facingMode: !this._selectedCameraId ? { ideal: this.currentFacingMode } : undefined,
            focusMode: { ideal: 'continuous' }
          },
          audio: false
        });
        this.mediaStream.getTracks().forEach(t => t.stop());
        this.mediaStream = newStream;
        applyAutofocus(newStream);
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
