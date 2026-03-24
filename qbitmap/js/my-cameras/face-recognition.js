import { QBitmapConfig } from "../config.js";
import { Logger, escapeHtml } from "../utils.js";
import { AuthSystem } from "../auth.js";

const FaceRecognitionMixin = {
  async openFaceRecognition(deviceId) {
    const camera = this.cameras.find(c => c.device_id === deviceId);
    if (!camera) {
      AuthSystem.showNotification('Kamera bulunamadı', 'error');
      return;
    }

    this.faceRecognitionCameraId = deviceId;

    // Create modal
    let modal = document.getElementById('face-recognition-modal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'face-recognition-modal';
    modal.className = 'claim-modal active';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:3000;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div class="modal-overlay" onclick="MyCamerasSystem.closeFaceRecognitionModal()" style="position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);"></div>
      <div class="modal-content face-modal-content" style="position:relative;width:480px;max-width:calc(100% - 32px);max-height:90vh;overflow-y:auto;background:white;padding:24px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.2);z-index:1;">
        <div class="face-modal-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
          <h3 style="margin:0;font-size:18px;color:#202124;">Yüz Tanıma - ${escapeHtml(camera.name || camera.device_id)}</h3>
          <button class="close-btn" onclick="MyCamerasSystem.closeFaceRecognitionModal()" style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;background:none;border:none;font-size:24px;color:#5f6368;cursor:pointer;border-radius:50%;">&times;</button>
        </div>

        <div class="face-toggle-row" style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#f8f9fa;border-radius:8px;margin-bottom:20px;">
          <label class="toggle-label" style="display:flex;align-items:center;gap:12px;cursor:pointer;">
            <span style="font-size:14px;font-weight:500;color:#3c4043;">Yüz Algılama</span>
            <input type="checkbox" id="face-detection-toggle" onchange="MyCamerasSystem.toggleFaceDetection()">
          </label>
          <select id="face-detection-interval" onchange="MyCamerasSystem.updateFaceInterval()" style="padding:6px 12px;border:1px solid #dadce0;border-radius:6px;font-size:13px;background:white;">
            <option value="5">5 saniye</option>
            <option value="10" selected>10 saniye</option>
            <option value="30">30 saniye</option>
            <option value="60">60 saniye</option>
          </select>
        </div>

        <div class="face-section" style="margin-bottom:20px;">
          <h4 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#3c4043;">Referans Yüzler</h4>
          <div class="faces-hint" style="font-size:11px;color:#9aa0a6;margin-bottom:10px;">🔔 işaretli yüzler algılandığında alarm verilir</div>
          <div class="faces-grid" id="faces-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,80px));gap:12px;">
            <div class="face-loading">Yükleniyor...</div>
          </div>
        </div>

        <div class="face-section" style="margin-bottom:20px;">
          <h4 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#3c4043;">Yeni Yüz Ekle</h4>
          <div class="add-face-form" style="display:flex;gap:6px;align-items:center;">
            <input type="text" id="face-name-input" placeholder="İsim" maxlength="50" style="flex:1;padding:6px 10px;border:1px solid #dadce0;border-radius:4px;font-size:12px;">
            <div class="face-upload-area" id="face-upload-area" onclick="document.getElementById('face-file-input').click()" style="display:flex;align-items:center;gap:4px;padding:6px 10px;border:1px dashed #dadce0;border-radius:4px;cursor:pointer;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5f6368" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="17 8 12 3 7 8"></polyline>
                <line x1="12" y1="3" x2="12" y2="15"></line>
              </svg>
              <span style="font-size:11px;color:#5f6368;">Fotoğraf Seç</span>
            </div>
            <input type="file" id="face-file-input" accept="image/jpeg,image/png" style="display:none" onchange="MyCamerasSystem.handleFaceFileSelect(event)">
            <button class="btn-primary btn-sm" id="add-face-btn" onclick="MyCamerasSystem.addFace()" disabled style="padding:6px 12px;background:#333;color:white;border:none;border-radius:4px;font-size:13px;cursor:pointer;">Ekle</button>
          </div>
          <div id="face-preview-container" class="face-preview-container" style="display:none;margin-top:6px;">
            <img id="face-preview-img" alt="Preview" style="width:40px;height:40px;object-fit:cover;border-radius:6px;">
            <button class="face-preview-remove" onclick="MyCamerasSystem.clearFacePreview()" style="width:20px;height:20px;background:#f1f3f4;border:none;border-radius:50%;cursor:pointer;">&times;</button>
          </div>
        </div>

        <div class="face-section" style="margin-bottom:20px;">
          <h4 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#3c4043;">Son Algılamalar</h4>
          <div class="detection-log" id="detection-log" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:12px;background:rgba(0,0,0,0.02);border-radius:12px;">
            <div class="detection-empty" style="grid-column:1/-1;padding:30px;text-align:center;color:#9aa0a6;font-size:12px;">Henüz algılama yok</div>
          </div>
        </div>

        <div id="face-error" class="claim-error"></div>
      </div>
    `;
    document.body.appendChild(modal);

    // Load settings and faces
    await this.loadFaceRecognitionData(deviceId);
  },

  /**
   * Load face recognition settings and faces
   */
  async loadFaceRecognitionData(deviceId) {
    try {
      // Load settings
      const settingsRes = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/settings`, {
        credentials: 'include'
      });
      if (settingsRes.ok) {
        const settings = await settingsRes.json();
        document.getElementById('face-detection-toggle').checked = settings.enabled;
        document.getElementById('face-detection-interval').value = settings.interval || 10;
      }

      // Load faces
      const facesRes = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/faces`, {
        credentials: 'include'
      });
      if (facesRes.ok) {
        const data = await facesRes.json();
        this.renderFacesGrid(data.faces || []);
      }

      // Load logs (8 items for 4x2 grid)
      const logsRes = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/logs?limit=8`, {
        credentials: 'include'
      });
      if (logsRes.ok) {
        const data = await logsRes.json();
        this.renderDetectionLog(data.logs || []);
      }
    } catch (error) {
      Logger.error('[FaceRecognition] Load error:', error);
    }
  },

  /**
   * Render faces grid
   */
  renderFacesGrid(faces) {
    const grid = document.getElementById('faces-grid');
    if (!grid) return;

    if (faces.length === 0) {
      grid.innerHTML = `
        <div class="face-empty">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="8" r="4"></circle>
            <path d="M20 21a8 8 0 0 0-16 0"></path>
          </svg>
          <span>Referans yüz yok</span>
        </div>
      `;
      return;
    }

    // Show last 8 faces (4x2 grid)
    const displayFaces = faces.slice(-8);
    grid.innerHTML = displayFaces.map(face => `
      <div class="face-thumbnail ${face.trigger_alarm ? 'alarm-active' : ''}" data-face-id="${face.id}">
        <img src="${escapeHtml(face.face_image_url || '')}" alt="${escapeHtml(face.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
        <div class="face-placeholder" style="display:none;">👤</div>
        <span class="face-name">${escapeHtml(face.name)}</span>
        <label class="face-alarm-toggle" title="Alarm Ver">
          <input type="checkbox" ${face.trigger_alarm ? 'checked' : ''} onchange="MyCamerasSystem.toggleFaceAlarm(${face.id}, this.checked)">
          <span class="alarm-icon">🔔</span>
        </label>
        <button class="face-remove-btn" onclick="MyCamerasSystem.removeFace(${face.id})" title="Sil">&times;</button>
      </div>
    `).join('');
  },

  /**
   * Render detection log
   */
  renderDetectionLog(logs) {
    const logEl = document.getElementById('detection-log');
    if (!logEl) return;

    if (logs.length === 0) {
      logEl.innerHTML = '<div class="detection-empty">Henüz algılama yok</div>';
      return;
    }

    // Show last 8 logs (4x2 grid with thumbnails)
    logEl.innerHTML = logs.slice(0, 8).map(log => {
      const date = new Date(log.detected_at);
      const timeStr = date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      const dateStr = date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
      const name = log.person_name || log.name || 'Bilinmeyen';
      const thumbHtml = log.face_image_url
        ? `<img src="${escapeHtml(log.face_image_url)}" alt="${escapeHtml(name)}" class="detection-thumb" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><div class="detection-thumb-placeholder" style="display:none;">👤</div>`
        : `<div class="detection-thumb-placeholder">👤</div>`;
      return `
        <div class="detection-item">
          ${thumbHtml}
          <div class="detection-info">
            <span class="detection-name">${escapeHtml(name)}</span>
            <span class="detection-score">Skor: ${Math.round(log.confidence)}</span>
            <span class="detection-time">${dateStr} ${timeStr}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  /**
   * Toggle face detection
   */
  async toggleFaceDetection() {
    const enabled = document.getElementById('face-detection-toggle').checked;
    const interval = parseInt(document.getElementById('face-detection-interval').value);

    try {
      // Update backend settings
      await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${this.faceRecognitionCameraId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled, interval })
      });

      // Start/stop face detection loop in browser
      if (window.CameraSystem) {
        if (enabled) {
          // Ensure camera is in CameraSystem.cameras before starting face detection
          const myCamera = this.cameras.find(c => c.device_id === this.faceRecognitionCameraId);

          if (!Array.isArray(CameraSystem.cameras)) {
            CameraSystem.cameras = [];
          }

          if (myCamera && !CameraSystem.cameras.find(c => c.device_id === this.faceRecognitionCameraId)) {
            CameraSystem.cameras.push(myCamera);
          }

          await CameraSystem.startFaceDetection(this.faceRecognitionCameraId, interval);
          AuthSystem.showNotification('Yüz algılama aktif', 'success');
        } else {
          await CameraSystem.stopFaceDetection(this.faceRecognitionCameraId);
          AuthSystem.showNotification('Yüz algılama durduruldu', 'info');
        }
      }
    } catch (error) {
      Logger.error('[FaceRecognition] Toggle error:', error);
    }
  },

  /**
   * Update face detection interval
   */
  async updateFaceInterval() {
    const interval = parseInt(document.getElementById('face-detection-interval').value);
    const enabled = document.getElementById('face-detection-toggle').checked;

    try {
      // Update backend settings
      await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${this.faceRecognitionCameraId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled, interval })
      });

      // Restart face detection with new interval if running
      if (window.CameraSystem && enabled) {
        // [FIX] Ensure camera is in CameraSystem.cameras
        const myCamera = this.cameras.find(c => c.device_id === this.faceRecognitionCameraId);
        if (!Array.isArray(CameraSystem.cameras)) {
          CameraSystem.cameras = [];
        }
        if (myCamera && !CameraSystem.cameras.find(c => c.device_id === this.faceRecognitionCameraId)) {
          CameraSystem.cameras.push(myCamera);
          Logger.log(`[FaceRecognition] Added camera for interval update:`, myCamera.device_id);
        }
        await CameraSystem.updateFaceDetectionSettings(this.faceRecognitionCameraId, enabled, interval);
      }
    } catch (error) {
      Logger.error('[FaceRecognition] Interval update error:', error);
    }
  },

  /**
   * Toggle alarm for a face
   */
  async toggleFaceAlarm(faceId, enabled) {
    try {
      const response = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${this.faceRecognitionCameraId}/faces/${faceId}/alarm`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ trigger_alarm: enabled })
      });

      if (response.ok) {
        // Update thumbnail class
        const thumb = document.querySelector(`.face-thumbnail[data-face-id="${faceId}"]`);
        if (thumb) {
          thumb.classList.toggle('alarm-active', enabled);
        }
        AuthSystem.showNotification(enabled ? 'Alarm aktif' : 'Alarm kapatıldı', 'success');
      }
    } catch (error) {
      Logger.error('[FaceRecognition] Toggle alarm error:', error);
    }
  },

  /**
   * Handle face file selection
   */
  handleFaceFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    this.selectedFaceFile = file;

    // Show preview
    const reader = new FileReader();
    reader.onload = (e) => {
      document.getElementById('face-preview-img').src = e.target.result;
      document.getElementById('face-preview-container').style.display = 'flex';
      document.getElementById('face-upload-area').style.display = 'none';
      document.getElementById('add-face-btn').disabled = !document.getElementById('face-name-input').value.trim();
    };
    reader.readAsDataURL(file);

    // Enable button if name is filled
    document.getElementById('face-name-input').addEventListener('input', () => {
      document.getElementById('add-face-btn').disabled = !document.getElementById('face-name-input').value.trim() || !this.selectedFaceFile;
    });
  },

  /**
   * Clear face preview
   */
  clearFacePreview() {
    this.selectedFaceFile = null;
    document.getElementById('face-file-input').value = '';
    document.getElementById('face-preview-container').style.display = 'none';
    document.getElementById('face-upload-area').style.display = 'flex';
    document.getElementById('add-face-btn').disabled = true;
  },

  /**
   * Add new reference face
   */
  async addFace() {
    const name = document.getElementById('face-name-input').value.trim();
    const errorDiv = document.getElementById('face-error');
    errorDiv.textContent = '';

    if (!name) {
      errorDiv.textContent = 'İsim gerekli';
      return;
    }

    if (!this.selectedFaceFile) {
      errorDiv.textContent = 'Fotoğraf seçin';
      return;
    }

    const formData = new FormData();
    formData.append('name', name);
    formData.append('image', this.selectedFaceFile);

    try {
      const response = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${this.faceRecognitionCameraId}/faces`, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      const data = await response.json();

      if (!response.ok) {
        errorDiv.textContent = data.error || 'Yüz eklenemedi';
        return;
      }

      // Clear form
      document.getElementById('face-name-input').value = '';
      this.clearFacePreview();

      // Reload faces
      const facesRes = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${this.faceRecognitionCameraId}/faces`, {
        credentials: 'include'
      });
      if (facesRes.ok) {
        const facesData = await facesRes.json();
        this.renderFacesGrid(facesData.faces || []);
      }

      AuthSystem.showNotification('Yüz eklendi', 'success');
    } catch (error) {
      Logger.error('[FaceRecognition] Add face error:', error);
      errorDiv.textContent = 'Bir hata oluştu';
    }
  },

  /**
   * Remove reference face
   */
  async removeFace(faceId) {
    if (!confirm('Bu yüzü silmek istediğinize emin misiniz?')) return;

    try {
      const response = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${this.faceRecognitionCameraId}/faces/${faceId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Delete failed');
      }

      // Remove from grid
      const thumb = document.querySelector(`.face-thumbnail[data-face-id="${faceId}"]`);
      if (thumb) thumb.remove();

      // Check if grid is empty
      const grid = document.getElementById('faces-grid');
      if (grid && !grid.querySelector('.face-thumbnail')) {
        this.renderFacesGrid([]);
      }

      AuthSystem.showNotification('Yüz silindi', 'success');
    } catch (error) {
      Logger.error('[FaceRecognition] Remove face error:', error);
      AuthSystem.showNotification('Yüz silinemedi', 'error');
    }
  },

  /**
   * Close face recognition modal
   */
  closeFaceRecognitionModal() {
    const modal = document.getElementById('face-recognition-modal');
    if (modal) modal.remove();
    this.faceRecognitionCameraId = null;
    this.selectedFaceFile = null;
  },

  /**
   * Start location picking mode
   */
};

export { FaceRecognitionMixin };
