import { QBitmapConfig } from '../../config.js';
import { Logger } from '../../utils.js';

const ActionsMixin = {
  /**
   * Release camera from settings
   */
  async releaseCameraFromSettings() {
    const cameraId = this.settingsCache?.cameraId;
    const camera = this.settingsCache?.camera;

    if (!cameraId) {
      alert('Kamera ID bulunamadi');
      return;
    }

    const cameraName = camera?.name || 'Bu kamera';
    if (!confirm(`"${cameraName}" kamerasini birakmak istediginizden emin misiniz?\n\nKamera havuza geri donecek ve baska bir kullanici tarafindan sahiplenilebilir.`)) {
      return;
    }

    try {
      const response = await fetch(`${QBitmapConfig.api.users}/me/cameras/${cameraId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Kamera birakilamadi');
      }

      alert('Kamera basariyla birakildi');
      this.closeSettings();

      // Refresh camera list
      if (typeof MyCamerasSystem !== 'undefined') {
        MyCamerasSystem.loadCameras();
      }
      // Refresh map
      this.loadCameras();

    } catch (error) {
      Logger.error('[Settings] Release camera error:', error);
      alert('Hata: ' + error.message);
    }
  },

  /**
   * Delete camera permanently from settings
   */
  async deleteCameraFromSettings() {
    const cameraId = this.settingsCache?.cameraId;
    const camera = this.settingsCache?.camera;

    if (!cameraId) {
      alert('Kamera ID bulunamadi');
      return;
    }

    const cameraName = camera?.name || 'Bu kamera';
    if (!confirm(`"${cameraName}" kamerasini KALICI OLARAK silmek istediginizden emin misiniz?\n\nBu islem geri alinamaz! Tum kamera verileri silinecek.`)) {
      return;
    }

    // Double confirmation for delete
    if (!confirm('UYARI: Bu islem geri alinamaz!\n\nDevam etmek icin tekrar "Tamam" a basin.')) {
      return;
    }

    try {
      const response = await fetch(`${QBitmapConfig.api.users}/me/cameras/${cameraId}/delete`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Kamera silinemedi');
      }

      alert('Kamera kalici olarak silindi');
      this.closeSettings();

      // Refresh camera list
      if (typeof MyCamerasSystem !== 'undefined') {
        MyCamerasSystem.loadCameras();
      }
      // Refresh map
      this.loadCameras();

    } catch (error) {
      Logger.error('[Settings] Delete camera error:', error);
      alert('Hata: ' + error.message);
    }
  },

  /**
   * Save city camera settings
   */
  async saveCityCameraSettings() {
    const cameraId = this.settingsCache?.cameraId;
    if (!cameraId) {
      alert('Kamera ID bulunamadi');
      return;
    }

    const saveBtn = document.getElementById('settings-save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="spinner" style="width: 16px; height: 16px; display: inline-block; margin-right: 6px;"></span>Kaydediliyor...';
    }

    try {
      // Get form values
      const nameInput = document.getElementById('settings-name');
      const latInput = document.getElementById('settings-lat');
      const lngInput = document.getElementById('settings-lng');

      // Get AI settings
      const form = document.querySelector('.settings-form');
      const aiConfidence = form?.querySelector('input[name="ai_confidence_threshold"]');
      const aiFrames = form?.querySelector('input[name="ai_consecutive_frames"]');
      const aiInterval = form?.querySelector('input[name="ai_capture_interval_ms"]');
      const data = {};
      if (nameInput && nameInput.value.trim()) data.name = nameInput.value.trim();
      if (latInput && latInput.value) data.lat = parseFloat(latInput.value);
      if (lngInput && lngInput.value) data.lng = parseFloat(lngInput.value);

      // Add AI settings
      if (aiConfidence) data.ai_confidence_threshold = parseInt(aiConfidence.value);
      if (aiFrames) data.ai_consecutive_frames = parseInt(aiFrames.value);
      if (aiInterval) data.ai_capture_interval_ms = parseInt(aiInterval.value);

      // Add detection rules
      const detectionRules = this._collectDetectionRules();
      if (detectionRules.length > 0) data.ai_detection_rules = detectionRules;

      if (Object.keys(data).length === 0) {
        alert('Degisiklik yok');
        return;
      }

      // Call admin API
      const response = await fetch(`${QBitmapConfig.api.admin}/cameras/city/${cameraId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Kaydetme basarisiz');
      }

      Logger.log('[Settings] City camera saved:', data);

      if (saveBtn) {
        saveBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Kaydedildi!`;
      }

      setTimeout(() => {
        this.closeSettings();
        // Refresh map cameras
        this.loadCameras();
      }, 1000);

    } catch (error) {
      Logger.error('[Settings] City camera save error:', error);
      alert('Hata: ' + error.message);
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
            <polyline points="17 21 17 13 7 13 7 21"/>
            <polyline points="7 3 7 8 15 8"/>
          </svg>
          Kaydet`;
      }
    }
  },

  /**
   * Delete city camera
   */
  async deleteCityCamera() {
    const cameraId = this.settingsCache?.cameraId;
    const camera = this.settingsCache?.camera;

    if (!cameraId) {
      alert('Kamera ID bulunamadi');
      return;
    }

    const cameraName = camera?.name || 'Bu kamera';
    if (!confirm(`"${cameraName}" sehir kamerasini silmek istediginizden emin misiniz?\n\nBu islem geri alinamaz!`)) {
      return;
    }

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/cameras/city/${cameraId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Kamera silinemedi');
      }

      alert('Sehir kamerasi silindi');
      this.closeSettings();

      // Refresh map cameras
      this.loadCameras();

    } catch (error) {
      Logger.error('[Settings] Delete city camera error:', error);
      alert('Hata: ' + error.message);
    }
  },
};

export { ActionsMixin };
