import { QBitmapConfig } from '../config.js';
import { Logger } from '../utils.js';

/**
 * QBitmap Camera System - Recording Module
 * Handles video recording - server-side recording for WHEP cameras
 */

const RecordingMixin = {
  // Maximum recording size in bytes (500MB) to prevent memory exhaustion
  MAX_RECORDING_SIZE: 500 * 1024 * 1024,

  /**
   * Show recording info popup before starting
   */
  showRecordingInfoPopup() {
    return new Promise((resolve) => {
      // Check if already shown this session
      if (sessionStorage.getItem('recordingInfoShown')) {
        resolve(true);
        return;
      }

      const overlay = document.createElement('div');
      overlay.className = 'recording-info-overlay';
      overlay.innerHTML = `
        <div class="recording-info-popup">
          <div class="recording-info-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <h3>Kayıt Bilgisi</h3>
          <p>Tarayıcınızı kapatsanız bile kaydın devam edebilmesi için kamera bağlantınız yeniden kurulacaktır.</p>
          <p class="recording-info-note">Bu işlem birkaç saniye sürebilir.</p>
          <div class="recording-info-buttons">
            <button class="recording-info-cancel">İptal</button>
            <button class="recording-info-confirm">Anladım, Devam Et</button>
          </div>
          <label class="recording-info-remember">
            <input type="checkbox" id="dontShowAgain"> Bir daha gösterme
          </label>
        </div>
      `;

      document.body.appendChild(overlay);

      // Add styles if not already added
      if (!document.getElementById('recording-info-styles')) {
        const style = document.createElement('style');
        style.id = 'recording-info-styles';
        style.textContent = `
          .recording-info-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            animation: fadeIn 0.2s ease;
          }
          .recording-info-popup {
            background: #1a1a2e;
            border: 1px solid #333;
            border-radius: 12px;
            padding: 24px;
            max-width: 380px;
            text-align: center;
            box-shadow: 0 20px 40px rgba(0,0,0,0.5);
          }
          .recording-info-icon {
            margin-bottom: 16px;
          }
          .recording-info-popup h3 {
            color: #fff;
            margin: 0 0 12px 0;
            font-size: 18px;
          }
          .recording-info-popup p {
            color: #ccc;
            margin: 0 0 8px 0;
            font-size: 14px;
            line-height: 1.5;
          }
          .recording-info-note {
            color: #888 !important;
            font-size: 12px !important;
            margin-top: 8px !important;
          }
          .recording-info-buttons {
            display: flex;
            gap: 12px;
            margin-top: 20px;
          }
          .recording-info-buttons button {
            flex: 1;
            padding: 10px 16px;
            border-radius: 6px;
            border: none;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.2s;
          }
          .recording-info-cancel {
            background: #333;
            color: #ccc;
          }
          .recording-info-cancel:hover {
            background: #444;
          }
          .recording-info-confirm {
            background: #dc2626;
            color: white;
          }
          .recording-info-confirm:hover {
            background: #b91c1c;
          }
          .recording-info-remember {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            margin-top: 16px;
            color: #888;
            font-size: 12px;
            cursor: pointer;
          }
          .recording-info-remember input {
            cursor: pointer;
          }
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        `;
        document.head.appendChild(style);
      }

      const cancelBtn = overlay.querySelector('.recording-info-cancel');
      const confirmBtn = overlay.querySelector('.recording-info-confirm');
      const checkbox = overlay.querySelector('#dontShowAgain');

      cancelBtn.onclick = () => {
        overlay.remove();
        resolve(false);
      };

      confirmBtn.onclick = () => {
        if (checkbox.checked) {
          sessionStorage.setItem('recordingInfoShown', 'true');
        }
        overlay.remove();
        resolve(true);
      };

      // Close on overlay click
      overlay.onclick = (e) => {
        if (e.target === overlay) {
          overlay.remove();
          resolve(false);
        }
      };
    });
  },

  /**
   * Toggle recording for a camera
   */
  async toggleRecording(deviceId) {
    const camera = this.cameras.find(c => c.device_id === deviceId);
    if (!camera) return;

    const popupData = this.popups.get(deviceId);
    const popupEl = popupData?.popup.getElement();
    const btn = popupEl?.querySelector('.record-btn');

    await this.toggleServerRecording(deviceId, btn);
  },

  /**
   * Toggle server-side recording (for WHEP cameras)
   */
  async toggleServerRecording(deviceId, btn) {
    try {
      // Check current status
      const statusRes = await fetch(`${QBitmapConfig.api.users.replace('/users', '')}/recordings/${deviceId}/status`, {
        credentials: 'include'
      });

      if (!statusRes.ok) {
        if (statusRes.status === 403) {
          Logger.warn('[Recording] Not authorized - login required');
          return;
        }
        throw new Error('Status check failed');
      }

      const status = await statusRes.json();

      if (status.isRecording) {
        // Stop recording
        const stopRes = await fetch(`${QBitmapConfig.api.users.replace('/users', '')}/recordings/${deviceId}/stop`, {
          method: 'POST',
          credentials: 'include'
        });

        if (stopRes.ok) {
          if (btn) btn.classList.remove('recording');
          this.isRecording = false;
          this.recordingDeviceId = null;

          // Kayıt takibini güncelle
          this.recordingCameras.delete(deviceId);
          this.saveRecordingState(); // localStorage'ı güncelle
          this.updateCameraIcon(deviceId);

          // Kayıt kalmadıysa blink'i durdur
          if (this.recordingCameras.size === 0) {
            this.stopRecordingBlink();
          }

          Logger.log('[Recording] Server recording stopped');

          // Reconnect WebRTC stream (sourceOnDemand change may interrupt it)
          this.reconnectWhepStream(deviceId);
        }
      } else {
        // Show info popup before starting recording
        const confirmed = await this.showRecordingInfoPopup();
        if (!confirmed) {
          Logger.log('[Recording] User cancelled recording');
          return;
        }

        // Start recording
        const startRes = await fetch(`${QBitmapConfig.api.users.replace('/users', '')}/recordings/${deviceId}/start`, {
          method: 'POST',
          credentials: 'include'
        });

        if (startRes.ok) {
          if (btn) btn.classList.add('recording');
          this.isRecording = true;
          this.recordingDeviceId = deviceId;

          // Kayıt takibini güncelle
          this.recordingCameras.add(deviceId);
          this.saveRecordingState(); // localStorage'a kaydet
          this.updateCameraIcon(deviceId);

          // Blink'i başlat (henüz başlamadıysa)
          this.startRecordingBlink();

          Logger.log('[Recording] Server recording started');

          // Show max duration warning
          const data = await startRes.json();
          const maxMins = Math.floor((data.maxDurationMs || 3600000) / 60000);
          Logger.log(`[Recording] Max duration: ${maxMins} minutes`);

          // Reconnect WebRTC stream (sourceOnDemand change may interrupt it)
          this.reconnectWhepStream(deviceId);
        }
      }
    } catch (error) {
      Logger.error('[Recording] Server recording error:', error);
    }
  },

  /**
   * Reconnect WHEP stream after recording state change
   * MediaMTX sourceOnDemand change can interrupt active WebRTC connections
   */
  async reconnectWhepStream(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData || !popupData.isWhep) return;

    const camera = this.cameras.find(c => c.device_id === deviceId);

    Logger.log('[Recording] Reconnecting stream after recording toggle...');

    // Cleanup current HLS instance
    if (popupData.hlsInstance) {
      popupData.hlsInstance.destroy();
      popupData.hlsInstance = null;
    }

    // Close existing peer connection
    if (popupData.peerConnection) {
      try {
        popupData.peerConnection.close();
      } catch (e) {
        // Ignore close errors
      }
      popupData.peerConnection = null;
    }

    // Clear stats interval
    if (popupData.clockInterval) {
      clearInterval(popupData.clockInterval);
      popupData.clockInterval = null;
    }

    // Show loading state
    const popupEl = popupData.popup.getElement();
    if (popupEl) {
      const frameContainer = popupEl.querySelector('.camera-frame-container');
      if (frameContainer) {
        frameContainer.classList.add('loading');
        frameContainer.classList.remove('loaded', 'error');
      }
    }

    // Wait a moment for MediaMTX to stabilize after config change
    await new Promise(resolve => setTimeout(resolve, 500));

    // Reconnect using current stream mode
    if (popupData.streamMode === 'hls' && camera?.hls_url) {
      await this.startHlsPlayback(deviceId, camera.hls_url);
    } else if (camera?.whep_url) {
      await this.startWhepStream(deviceId, camera.whep_url);
    }
  },

  /**
   * Check if a WHEP camera is currently recording (for popup state sync)
   */
  async checkRecordingStatus(deviceId) {
    try {
      const statusRes = await fetch(`${QBitmapConfig.api.users.replace('/users', '')}/recordings/${deviceId}/status`, {
        credentials: 'include'
      });

      if (statusRes.ok) {
        const status = await statusRes.json();
        return status.isRecording;
      }
      // 401/403 is expected when not logged in - silently return false
    } catch (e) {
      // Network error - silently fail
    }
    return false;
  },

  /**
   * Save recording state to localStorage
   */
  saveRecordingState() {
    try {
      const recordingIds = Array.from(this.recordingCameras);
      localStorage.setItem('qbitmap_recording_cameras', JSON.stringify(recordingIds));
      Logger.log('[Recording] State saved to localStorage:', recordingIds);
    } catch (e) {
      Logger.warn('[Recording] Could not save state to localStorage');
    }
  },

  /**
   * Load recording state from localStorage and verify with server
   */
  async loadRecordingState() {
    try {
      const saved = localStorage.getItem('qbitmap_recording_cameras');
      if (!saved) return;

      const savedIds = JSON.parse(saved);
      if (!Array.isArray(savedIds) || savedIds.length === 0) return;

      Logger.log('[Recording] Restoring state from localStorage:', savedIds);

      // Verify each camera's recording status with the server
      for (const deviceId of savedIds) {
        const isRecording = await this.checkRecordingStatus(deviceId);
        if (isRecording) {
          this.recordingCameras.add(deviceId);
          this.updateCameraIcon(deviceId);
          Logger.log(`[Recording] Restored recording state for: ${deviceId}`);
        }
      }

      // Start blink animation if any cameras are recording
      if (this.recordingCameras.size > 0) {
        this.startRecordingBlink();
      }

      // Update localStorage with verified state
      this.saveRecordingState();

    } catch (e) {
      Logger.warn('[Recording] Could not load state from localStorage:', e);
    }
  }
};

export { RecordingMixin };
