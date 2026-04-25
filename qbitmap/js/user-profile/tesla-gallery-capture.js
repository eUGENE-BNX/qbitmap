import { QBitmapConfig } from '../config.js';
import { Logger } from '../utils.js';
import { initialFocus, bindTapToFocus, refocusCenter, getSavedCameraId, saveCameraId } from '../video-message/media.js';

const TARGET_W = 1920;
const TARGET_H = 1080;

function haptic(style = 'medium') {
  if (!navigator.vibrate) return;
  const p = { light: 10, medium: 20, heavy: 30 };
  navigator.vibrate(p[style] || 10);
}

async function openCameraStream() {
  const savedId = getSavedCameraId();
  const baseConstraints = {
    width: { ideal: TARGET_W },
    height: { ideal: TARGET_H }
  };
  const tries = [];
  if (savedId) tries.push({ ...baseConstraints, deviceId: { exact: savedId } });
  tries.push({ ...baseConstraints, facingMode: { ideal: 'environment' } });
  tries.push({ facingMode: { ideal: 'environment' } });
  tries.push(true);

  let lastErr = null;
  for (const video of tries) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Kamera açılamadı');
}

function captureFrame(videoEl) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return null;

  const canvas = document.createElement('canvas');
  canvas.width = TARGET_W;
  canvas.height = TARGET_H;
  const ctx = canvas.getContext('2d');

  // Center-crop to landscape 16:9, even if source is portrait.
  const targetAspect = TARGET_W / TARGET_H;
  const srcAspect = vw / vh;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (srcAspect > targetAspect) {
    sw = vh * targetAspect;
    sx = (vw - sw) / 2;
  } else {
    sh = vw / targetAspect;
    sy = (vh - sh) / 2;
  }
  ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, TARGET_W, TARGET_H);

  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

const ICONS = {
  capture: '<div class="capture-inner"></div>',
  close: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  retry: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  check: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
};

export function captureTeslaPhoto({ vehicleId, slotIndex }) {
  return new Promise((resolve, reject) => {
    let mediaStream = null;
    let modal = null;
    let capturedBlob = null;
    let capturedUrl = null;

    const cleanup = () => {
      if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
      }
      if (capturedUrl) URL.revokeObjectURL(capturedUrl);
      if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
      window.removeEventListener('orientationchange', handleOrientation);
    };

    const cancel = () => { cleanup(); reject('cancelled'); };

    const setState = (state) => {
      const content = modal.querySelector('.video-msg-modal-content');
      content.dataset.state = state;
    };

    const handleOrientation = () => {
      if (!modal) return;
      const isPortrait = window.matchMedia('(orientation: portrait)').matches;
      modal.querySelector('.tesla-gallery-orient-hint')?.classList.toggle('is-visible', isPortrait);
    };

    const render = () => {
      modal = document.createElement('div');
      modal.className = 'video-msg-modal tesla-gallery-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.innerHTML = `
        <div class="video-msg-modal-content tesla-gallery-modal-content" data-state="live">
          <div class="tesla-gallery-title">Tesla Galeri — Slot ${slotIndex + 1}/8</div>

          <div class="video-msg-video-container tesla-gallery-video-wrap" data-state="live">
            <video id="tesla-gallery-preview" autoplay playsinline muted></video>
            <div class="tesla-gallery-orient-hint">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/></svg>
              <span>Lütfen telefonunuzu yatay tutun</span>
            </div>
          </div>

          <img class="tesla-gallery-preview-img" alt="" />

          <div class="tesla-gallery-uploading">
            <div class="spinner"></div>
            <p>Resminiz doğrulanıyor.</p>
          </div>

          <div class="tesla-gallery-rejected">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            <p class="tesla-gallery-rejected-msg"></p>
          </div>

          <div class="tesla-gallery-error">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <p class="tesla-gallery-error-msg">Bağlantı hatası, lütfen tekrar deneyin.</p>
          </div>

          <div class="tesla-gallery-controls" data-state="live">
            <button class="video-msg-btn video-msg-btn-cancel" data-action="cancel" title="İptal">${ICONS.close}</button>
            <button class="video-msg-btn video-msg-btn-capture" data-action="capture" title="Çek">${ICONS.capture}</button>
            <span class="tesla-gallery-spacer"></span>
          </div>

          <div class="tesla-gallery-controls-confirm" data-state="confirm">
            <button class="tesla-gallery-btn tesla-gallery-btn-secondary" data-action="retake">${ICONS.retry}<span>Yeniden Çek</span></button>
            <button class="tesla-gallery-btn tesla-gallery-btn-secondary" data-action="cancel">İptal</button>
            <button class="tesla-gallery-btn tesla-gallery-btn-primary" data-action="upload">${ICONS.check}<span>Onayla</span></button>
          </div>

          <div class="tesla-gallery-controls-rejected" data-state="rejected">
            <button class="tesla-gallery-btn tesla-gallery-btn-secondary" data-action="cancel">İptal</button>
            <button class="tesla-gallery-btn tesla-gallery-btn-primary" data-action="retake-from-reject">${ICONS.retry}<span>Yeniden Çek</span></button>
          </div>

          <div class="tesla-gallery-controls-error" data-state="error">
            <button class="tesla-gallery-btn tesla-gallery-btn-secondary" data-action="cancel">İptal</button>
            <button class="tesla-gallery-btn tesla-gallery-btn-primary" data-action="upload-retry">${ICONS.retry}<span>Tekrar Dene</span></button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    };

    const startLive = async () => {
      try {
        mediaStream = await openCameraStream();
        const track = mediaStream.getVideoTracks()[0];
        saveCameraId(track?.getSettings()?.deviceId || null);
        const video = modal.querySelector('#tesla-gallery-preview');
        video.srcObject = mediaStream;
        initialFocus(mediaStream);
        bindTapToFocus(video, mediaStream);
        setState('live');
        handleOrientation();
      } catch (e) {
        Logger.error('[TeslaGallery] camera open error', e);
        let msg = 'Kamera açılamadı';
        if (e?.name === 'NotAllowedError') msg = 'Kamera izni reddedildi';
        modal.querySelector('.tesla-gallery-error-msg').textContent = msg;
        setState('error');
      }
    };

    const doCapture = async () => {
      if (!mediaStream) return;
      const video = modal.querySelector('#tesla-gallery-preview');
      const captureBtn = modal.querySelector('[data-action="capture"]');
      captureBtn.disabled = true;
      try {
        await refocusCenter(mediaStream);
      } catch {}
      const blob = await captureFrame(video);
      captureBtn.disabled = false;
      if (!blob) {
        modal.querySelector('.tesla-gallery-error-msg').textContent = 'Fotoğraf çekilemedi, tekrar deneyin.';
        setState('error');
        return;
      }
      haptic('medium');
      capturedBlob = blob;
      if (capturedUrl) URL.revokeObjectURL(capturedUrl);
      capturedUrl = URL.createObjectURL(blob);
      modal.querySelector('.tesla-gallery-preview-img').src = capturedUrl;
      // Stop live stream tracks while in confirm state to free the camera light
      if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
      }
      setState('confirm');
    };

    const doUpload = async () => {
      if (!capturedBlob) return;
      setState('uploading');
      try {
        const fd = new FormData();
        fd.append('photo', capturedBlob, 'tesla.jpg');
        const res = await fetch(
          `${QBitmapConfig.api.base}/api/tesla/vehicles/${encodeURIComponent(vehicleId)}/photos/${slotIndex}`,
          { method: 'POST', credentials: 'include', body: fd }
        );

        if (res.ok) {
          haptic('heavy');
          cleanup();
          resolve();
          return;
        }

        const data = await res.json().catch(() => ({}));
        if (res.status === 422 && data.user_message_tr) {
          modal.querySelector('.tesla-gallery-rejected-msg').textContent = data.user_message_tr;
          setState('rejected');
          return;
        }
        modal.querySelector('.tesla-gallery-error-msg').textContent =
          data.user_message_tr || data.error || 'Yükleme başarısız.';
        setState('error');
      } catch (e) {
        Logger.error('[TeslaGallery] upload error', e);
        modal.querySelector('.tesla-gallery-error-msg').textContent = 'Bağlantı hatası, lütfen tekrar deneyin.';
        setState('error');
      }
    };

    const handleAction = async (action) => {
      switch (action) {
        case 'cancel':
          cancel();
          break;
        case 'capture':
          await doCapture();
          break;
        case 'retake':
        case 'retake-from-reject':
          capturedBlob = null;
          if (capturedUrl) { URL.revokeObjectURL(capturedUrl); capturedUrl = null; }
          await startLive();
          break;
        case 'upload':
          await doUpload();
          break;
        case 'upload-retry':
          if (capturedBlob) {
            await doUpload();
          } else {
            await startLive();
          }
          break;
      }
    };

    render();
    modal.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      ev.preventDefault();
      handleAction(btn.dataset.action);
    });
    window.addEventListener('orientationchange', handleOrientation);

    startLive();
  });
}
