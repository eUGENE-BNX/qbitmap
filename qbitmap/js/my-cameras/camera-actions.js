import { QBitmapConfig } from "../config.js";
import { Logger, escapeHtml, showNotification } from "../utils.js";
import { AuthSystem } from "../auth.js";
import { CameraSystem } from '../camera-system/index.js';
import * as AppState from '../state.js';

const CameraActionsMixin = {
  async openAndRecord(deviceId, lng, lat) {
    // Close dashboard
    this.close();

    // Check if camera has coordinates
    if (!lng || !lat) {
      AuthSystem.showNotification('Kameranın konumu belirlenmemiş', 'error');
      return;
    }

    // Fly to camera location
    if (AppState.map) {
      AppState.map.flyTo({
        center: [lng, lat],
        zoom: 17,
        essential: true
      });

      // Wait for map to settle, then open popup and start recording
      setTimeout(() => {
        // Find camera in CameraSystem
        if (CameraSystem) {
          const camera = CameraSystem.cameras.find(c => c.device_id === deviceId);
          if (camera) {
            // Open popup
            CameraSystem.openCameraPopup(camera, [lng, lat]);

            // Start recording after popup opens
            setTimeout(() => {
              CameraSystem.toggleRecording(deviceId);
              AuthSystem.showNotification('Kayıt başlatıldı', 'success');
            }, 1000);
          } else {
            AuthSystem.showNotification('Kamera haritada bulunamadı', 'error');
          }
        }
      }, 1500);
    }
  },

  /**
   * Open recordings modal for WHEP camera
   */
  openRecordings(deviceId) {
    const camera = this.cameras.find(c => c.device_id === deviceId);
    if (!camera) {
      AuthSystem.showNotification('Kamera bulunamadı', 'error');
      return;
    }

    // Use CameraSystem's recordings modal but pass camera data
    if (CameraSystem && typeof CameraSystem.openRecordingsModalWithCamera === 'function') {
      CameraSystem.openRecordingsModalWithCamera(camera);
    } else if (CameraSystem && typeof CameraSystem.openRecordingsModal === 'function') {
      // Temporarily add camera to CameraSystem.cameras if not present
      const existingCamera = CameraSystem.cameras.find(c => c.device_id === deviceId);
      if (!existingCamera) {
        CameraSystem.cameras.push(camera);
      }
      CameraSystem.openRecordingsModal(deviceId);
    } else {
      AuthSystem.showNotification('Kayıtlar modülü yüklenemedi', 'error');
    }
  },

  /**
   * Open camera settings for WHEP camera
   */
  openCameraSettings(deviceId, cameraId = null) {
    if (CameraSystem && CameraSystem.openSettings) {
      CameraSystem.openSettings(deviceId, cameraId);
    } else {
      AuthSystem.showNotification('Ayarlar açılamadı', 'error');
    }
  },

  /**
   * Pick location from map for ID-based camera
   */
  async pickCameraLocation(deviceId, cameraId) {
    const self = this;

    // Close dashboard panel if open
    const dashboardPanel = document.querySelector('.dashboard-panel');
    if (dashboardPanel) {
      dashboardPanel.classList.remove('open');
    }

    // Show instruction toast
    AuthSystem.showNotification('Haritada bir noktaya tiklayarak kamera konumunu belirleyin. Iptal icin ESC tuslayın.', 'info', 5000);

    // Change cursor to crosshair
    if (AppState.map) {
      map.getCanvas().style.cursor = 'crosshair';
    }

    // Set picking state
    this._isPickingLocation = true;
    this._pickingDeviceId = deviceId;
    this._pickingCameraId = cameraId;

    // Handle map click
    const handleMapClick = async function(e) {
      if (!self._isPickingLocation) return;

      self._isPickingLocation = false;
      const lat = e.lngLat.lat;
      const lng = e.lngLat.lng;

      // Reset cursor
      if (AppState.map) {
        map.getCanvas().style.cursor = '';
      }

      // Remove listeners
      if (AppState.map) {
        map.off('click', handleMapClick);
      }
      document.removeEventListener('keydown', handleEscKey);

      // Save location to API
      try {
        const response = await fetch(`${QBitmapConfig.api.users}/me/cameras/${cameraId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ lat, lng })
        });

        if (response.ok) {
          AuthSystem.showNotification('Konum kaydedildi', 'success');
          // Update local camera data
          const camera = self.cameras.find(c => String(c.id) === String(cameraId));
          if (camera) {
            camera.lat = lat;
            camera.lng = lng;
          }
          // Refresh cameras display
          self.renderCameras();
          // Update map layer if CameraSystem is available
          if (CameraSystem && CameraSystem.refreshCameras) {
            CameraSystem.refreshCameras();
          }
        } else {
          const data = await response.json();
          AuthSystem.showNotification((data.error?.message ?? data.error) || 'Konum kaydedilemedi', 'error');
        }
      } catch (err) {
        console.error('Error saving camera location:', err);
        AuthSystem.showNotification('Konum kaydedilemedi', 'error');
      }
    };

    // Handle ESC key to cancel
    const handleEscKey = function(e) {
      if (e.key === 'Escape' && self._isPickingLocation) {
        self._isPickingLocation = false;

        // Reset cursor
        if (AppState.map) {
          map.getCanvas().style.cursor = '';
          map.off('click', handleMapClick);
        }
        document.removeEventListener('keydown', handleEscKey);

        AuthSystem.showNotification('Konum secimi iptal edildi', 'info');
      }
    };

    // Register listeners
    if (AppState.map) {
      map.once('click', handleMapClick);
    }
    document.addEventListener('keydown', handleEscKey);
  },

  /**
   * Open face recognition modal for camera
   */

  pickLocation(cameraId) {
    this.editingCameraId = cameraId;
    this.isPickingLocation = true;

    // Close dashboard completely for better map access
    const dashboard = document.getElementById('my-cameras-dashboard');
    if (dashboard) dashboard.classList.remove('active');

    // Show instruction
    const instruction = document.createElement('div');
    instruction.id = 'pick-location-instruction';
    instruction.className = 'pick-location-instruction';
    instruction.innerHTML = `
      <span>Haritada konumu seçmek için tıklayın</span>
      <button class="cancel-pick-btn">İptal</button>
    `;
    instruction.querySelector('.cancel-pick-btn').addEventListener('click', () => this.cancelLocationPick());
    document.body.appendChild(instruction);

    // Add map click handler with high priority
    if (AppState.map) {
      AppState.map.getCanvas().style.cursor = 'crosshair';

      // Store the handler reference for removal
      this._locationPickHandler = (e) => {
        // Prevent CameraSystem from handling this click
        e.preventDefault && e.preventDefault();
        this.handleLocationPick(e);
      };

      // Use 'click' on map itself (not on layers) for location picking
      AppState.map.on('click', this._locationPickHandler);
    }
  },

  /**
   * Handle map click for location pick
   */
  async handleLocationPick(e) {
    const { lng, lat } = e.lngLat;

    try {
      const response = await fetch(`${this.apiBase}/me/cameras/${this.editingCameraId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ lng, lat })
      });

      if (!response.ok) {
        throw new Error('Failed to update location');
      }

      AuthSystem.showNotification('Konum güncellendi', 'success');
      await this.loadCameras();

      // Refresh map cameras
      if (typeof CameraSystem !== 'undefined') {
        CameraSystem.loadCameras();
      }

    } catch (error) {
      Logger.error('[MyCameras] Location update error:', error);
      AuthSystem.showNotification('Konum güncellenemedi', 'error');
    }

    this.cancelLocationPick();
  },

  /**
   * Cancel location picking
   */
  cancelLocationPick() {
    this.isPickingLocation = false;

    // Remove click handler
    if (AppState.map && this._locationPickHandler) {
      AppState.map.off('click', this._locationPickHandler);
      this._locationPickHandler = null;
    }

    // Restore cursor
    if (AppState.map) {
      AppState.map.getCanvas().style.cursor = '';
    }

    // Remove instruction
    const instruction = document.getElementById('pick-location-instruction');
    if (instruction) instruction.remove();

    // Reopen dashboard if we have a camera being edited
    if (this.editingCameraId) {
      const dashboard = document.getElementById('my-cameras-dashboard');
      if (dashboard) dashboard.classList.add('active');
    }

    this.editingCameraId = null;
  },

  /**
   * Show delete confirmation modal
   */
  confirmDeleteCamera(cameraId, cameraName, cameraType) {
    const isWhep = cameraType === 'whep';

    const modal = document.createElement('div');
    modal.id = 'delete-modal';
    modal.className = 'claim-modal active';
    modal.innerHTML = `
      <div class="modal-overlay"></div>
      <div class="modal-content">
        <h3>Kamerayı Sil</h3>
        <p class="modal-desc"><strong>${escapeHtml(cameraName)}</strong> kamerasını silmek istediğinize emin misiniz?</p>

        ${isWhep ? `
        <div class="delete-options">
          <label class="delete-option">
            <input type="checkbox" id="delete-recordings" checked>
            <span>Kayıtları da sil (MediaMTX)</span>
          </label>
          <label class="delete-option">
            <input type="checkbox" id="delete-mediamtx-path" checked>
            <span>MediaMTX path yapılandırmasını sil</span>
          </label>
        </div>
        ` : ''}

        <p class="delete-warning">Bu işlem geri alınamaz!</p>

        <div class="modal-actions">
          <button class="btn-secondary delete-cancel-btn">İptal</button>
          <button class="btn-danger delete-confirm-btn">Sil</button>
        </div>
        <div id="delete-error" class="claim-error"></div>
      </div>
    `;
    modal.querySelector('.modal-overlay').addEventListener('click', () => this.closeDeleteModal());
    modal.querySelector('.delete-cancel-btn').addEventListener('click', () => this.closeDeleteModal());
    modal.querySelector('.delete-confirm-btn').addEventListener('click', () => this.deleteCamera(cameraId, isWhep));
    document.body.appendChild(modal);
  },

  /**
   * Close delete modal
   */
  closeDeleteModal() {
    const modal = document.getElementById('delete-modal');
    if (modal) modal.remove();
  },

  /**
   * Delete camera
   */
  async deleteCamera(cameraId, isWhep) {
    const errorDiv = document.getElementById('delete-error');

    // Get options for WHEP cameras
    let deleteRecordings = false;
    let deleteMediaMtxPath = false;

    if (isWhep) {
      const recordingsCheckbox = document.getElementById('delete-recordings');
      const pathCheckbox = document.getElementById('delete-mediamtx-path');
      deleteRecordings = recordingsCheckbox ? recordingsCheckbox.checked : false;
      deleteMediaMtxPath = pathCheckbox ? pathCheckbox.checked : false;
    }

    try {
      const response = await fetch(`${this.apiBase}/me/cameras/${cameraId}/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          deleteRecordings,
          deleteMediaMtxPath
        })
      });

      const data = await response.json();

      if (!response.ok) {
        errorDiv.textContent = (data.error?.message ?? data.error) || 'Kamera silinemedi';
        return;
      }

      this.closeDeleteModal();
      AuthSystem.showNotification('Kamera silindi', 'success');
      await this.loadCameras();

      // Refresh map cameras
      if (typeof CameraSystem !== 'undefined') {
        CameraSystem.loadCameras();
      }

    } catch (error) {
      Logger.error('[MyCameras] Delete error:', error);
      errorDiv.textContent = 'Bir hata oluştu';
    }
  },

  /**
   * Toggle voice call enabled state for camera card
   */
  async toggleVoiceCall(deviceId, voiceBtn) {
    try {
      // Check if user is logged in
      if (!AuthSystem.isLoggedIn()) {
        AuthSystem.showNotification('Bu özellik için giriş yapmanız gerekiyor', 'error');
        return;
      }

      // Get current state from button class
      const currentEnabled = voiceBtn.classList.contains('active');
      const newEnabled = !currentEnabled;

      // Optimistic UI update
      this.updateVoiceButtonState(voiceBtn, newEnabled);

      const response = await fetch(`${QBitmapConfig.api.public}/cameras/${deviceId}/voice-call`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ enabled: newEnabled })
      });

      if (!response.ok) {
        // Revert on error
        this.updateVoiceButtonState(voiceBtn, currentEnabled);
        const error = await response.json().catch(() => ({}));
        AuthSystem.showNotification(error.error || 'Sesli arama ayarı güncellenemedi', 'error');
        return;
      }

      const data = await response.json();
      Logger.log('[VoiceCall] State updated:', data.voiceCallEnabled);
      AuthSystem.showNotification(newEnabled ? 'Sesli arama açıldı' : 'Sesli arama kapatıldı', 'success');

    } catch (error) {
      Logger.error('[VoiceCall] Toggle error:', error);
      AuthSystem.showNotification('Sesli arama ayarı güncellenemedi', 'error');
    }
  },

  /**
   * Update voice button visual state
   */
  updateVoiceButtonState(voiceBtn, enabled) {
    if (enabled) {
      voiceBtn.classList.add('active');
      voiceBtn.title = 'Sesli Arama (Açık)';
    } else {
      voiceBtn.classList.remove('active');
      voiceBtn.title = 'Sesli Arama (Kapalı)';
    }
  },

  /**
   * Load voice call states for all camera cards
   */
  async loadVoiceCallStates() {
    const voiceButtons = document.querySelectorAll('.btn-voice[data-device-id]');

    for (const btn of voiceButtons) {
      const deviceId = btn.dataset.deviceId;
      try {
        const response = await fetch(`${QBitmapConfig.api.public}/cameras/${deviceId}/voice-call`, {
          credentials: 'include'
        });

        if (response.ok) {
          const data = await response.json();
          this.updateVoiceButtonState(btn, data.voiceCallEnabled);
        }
      } catch (error) {
        Logger.error('[VoiceCall] Load state error for', deviceId, error);
      }
    }
  },

};

export { CameraActionsMixin };
