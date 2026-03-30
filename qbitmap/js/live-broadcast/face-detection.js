import { Logger } from '../utils.js';
import { AuthSystem } from '../auth.js';

const FaceDetectionMixin = {
  toggleBroadcastFaceDetection(btn, popupEl) {
    if (this.faceDetectionActive) {
      this.stopBroadcastFaceDetection();
    } else {
      this.startBroadcastFaceDetection(btn, popupEl);
    }
  },

  async startBroadcastFaceDetection(btn, popupEl) {
    try {
      const response = await fetch(`${this.apiBase}/faces`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load faces');
      const data = await response.json();
      this.faceDetectionFaces = data.faces || [];

      if (this.faceDetectionFaces.length === 0) {
        AuthSystem.showNotification('Kayıtlı yüz bulunamadı. Önce kamera ayarlarından yüz ekleyin.', 'error');
        return;
      }

      this.faceDetectionActive = true;
      if (btn) btn.classList.add('active');

      this.faceDetectionInterval = setInterval(() => {
        this.processBroadcastFaceDetection(popupEl);
      }, 10000);

      setTimeout(() => this.processBroadcastFaceDetection(popupEl), 3000);

      Logger.log('[FaceDetection] Started on broadcast');
    } catch (error) {
      Logger.error('[FaceDetection] Start error:', error);
      AuthSystem.showNotification('Yüz tanıma başlatılamadı', 'error');
    }
  },

  stopBroadcastFaceDetection() {
    if (this.faceDetectionInterval) {
      clearInterval(this.faceDetectionInterval);
      this.faceDetectionInterval = null;
    }
    this.faceDetectionActive = false;
    this._lastFaceDetection = null;

    if (this._faceDetectionBtn) {
      this._faceDetectionBtn.classList.remove('active');
    }
    Logger.log('[FaceDetection] Stopped on broadcast');
  },

  async processBroadcastFaceDetection(popupEl) {
    if (!this.faceDetectionActive || !popupEl) return;

    const videoEl = popupEl.querySelector('.camera-video');
    if (!videoEl || videoEl.videoWidth === 0) return;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(videoEl, 0, 0);

      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      if (!blob) return;

      const formData = new FormData();
      formData.append('image', blob, 'frame.jpg');

      const response = await fetch(`${this.apiBase}/face-recognize`, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      if (!response.ok) return;

      const result = await response.json();

      if (result.success && Array.isArray(result.result) && result.result.length > 0) {
        for (const match of result.result) {
          if (!match.isMatchFound || match.score < 70) continue;

          let matchedFace = this.faceDetectionFaces.find(f =>
            f.name?.localeCompare(match.name, 'tr', { sensitivity: 'base' }) === 0
          );
          if (!matchedFace && this.faceDetectionFaces.length === 1) {
            matchedFace = this.faceDetectionFaces[0];
          }
          if (!matchedFace) {
            const matchFirstName = match.name?.split(' ')[0]?.toLowerCase();
            matchedFace = this.faceDetectionFaces.find(f => {
              const faceFirstName = f.name?.split(' ')[0]?.toLowerCase();
              return matchFirstName && faceFirstName && matchFirstName === faceFirstName;
            });
          }

          const faceName = matchedFace?.name || match.name || 'Bilinmeyen';

          const now = Date.now();
          const lastKey = `broadcast_${faceName}`;
          if (this._lastFaceDetection?.key === lastKey && (now - this._lastFaceDetection.time) < 30000) {
            continue;
          }
          this._lastFaceDetection = { key: lastKey, time: now };

          if (matchedFace && matchedFace.trigger_alarm === 0) continue;

          const faceImageUrl = matchedFace?.face_image_url || null;
          this.showBroadcastFaceAlert(faceName, match.score, faceImageUrl);
        }
      }
    } catch (error) {
      Logger.error('[FaceDetection] Process error:', error);
    }
  },

  showBroadcastFaceAlert(faceName, confidence, faceImageUrl) {
    if (typeof CameraSystem !== 'undefined' && typeof CameraSystem.playAlarmSound === 'function') {
      CameraSystem.playAlarmSound();
    }

    let alertEl = document.getElementById('face-detection-alert');
    if (!alertEl) {
      alertEl = document.createElement('div');
      alertEl.id = 'face-detection-alert';
      alertEl.className = 'face-detection-alert';
      document.body.appendChild(alertEl);
    }

    const escHtml = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

    alertEl.innerHTML = `
      <div class="face-alert-content">
        <div class="face-alert-image" id="face-alert-image-container"></div>
        <div class="face-alert-info">
          <div class="face-alert-label">YÜZ ALGILANDI</div>
          <div class="face-alert-name">${escHtml(faceName)}</div>
          <div class="face-alert-camera">Canlı Yayın</div>
          <div class="face-alert-confidence">Eşleşme Skoru: ${Math.round(confidence)}</div>
        </div>
        <button class="face-alert-close">&times;</button>
      </div>
    `;

    alertEl.querySelector('.face-alert-close').onclick = () => alertEl.classList.remove('show');

    const imageContainer = alertEl.querySelector('#face-alert-image-container');
    if (faceImageUrl) {
      const img = document.createElement('img');
      img.src = faceImageUrl;
      img.alt = faceName;
      img.className = 'face-alert-thumb';
      img.onerror = () => {
        imageContainer.innerHTML = '<div class="face-alert-icon-fallback"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4 4-6 8-6s8 2 8 6"></path></svg></div>';
      };
      imageContainer.appendChild(img);
    } else {
      imageContainer.innerHTML = '<div class="face-alert-icon-fallback"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4 4-6 8-6s8 2 8 6"></path></svg></div>';
    }

    alertEl.classList.add('show');
    setTimeout(() => alertEl.classList.remove('show'), 30000);

    Logger.log(`[FaceDetection] Alert: ${faceName} detected on broadcast (${confidence}%)`);
  },
};

export { FaceDetectionMixin };
