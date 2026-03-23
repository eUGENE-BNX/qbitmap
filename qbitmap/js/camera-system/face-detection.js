import { QBitmapConfig } from '../config.js';
import { Logger, escapeHtml } from '../utils.js';

/**
 * QBitmap Camera System - Face Detection Module
 * Handles background face detection and recognition alerts
 */

const FaceDetectionMixin = {
  // Face detection state per camera
  faceDetectionState: new Map(), // deviceId -> { enabled, intervalId, interval, faces, isProcessing }

  // Face recognition API URL (from config)
  get FACE_API_URL() { return QBitmapConfig.api.faceMatcher; },

  /**
   * Initialize face detection on startup (loads cameras with detection enabled)
   */
  async initFaceDetection() {
    try {
      const response = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/active`, {
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();
        // Start detection for each camera that has it enabled
        for (const camera of (data.cameras || [])) {
          if (camera.face_detection_enabled) {
            await this.startFaceDetection(camera.device_id, camera.face_detection_interval || 10);
          }
        }
      }
    } catch (error) {
      Logger.warn('[FaceDetection] Init error:', error);
    }
  },

  /**
   * Start face detection for a camera
   */
  async startFaceDetection(deviceId, intervalSeconds = 10) {
    Logger.log(`[FaceDetection] Starting for ${deviceId}, interval: ${intervalSeconds}s`);

    // Check if already running
    let state = this.faceDetectionState.get(deviceId);
    if (state?.intervalId) {
      return;
    }

    // Find camera to get WHEP URL
    const camera = this.cameras.find(c => c.device_id === deviceId);
    if (!camera || camera.camera_type !== 'whep') {
      return;
    }

    // Load reference faces
    let faces = [];
    try {
      const facesRes = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/faces`, {
        credentials: 'include'
      });
      if (facesRes.ok) {
        const data = await facesRes.json();
        faces = data.faces || [];
      }
    } catch (e) {
      Logger.warn('[FaceDetection] Failed to load faces:', e);
    }

    if (faces.length === 0) {
      return;
    }

    // Extract stream ID from WHEP URL
    const streamId = this.extractStreamIdFromWhepUrl(camera.whep_url);
    if (!streamId) {
      return;
    }

    // Start capture service
    try {
      await this.startCaptureService(streamId, intervalSeconds * 1000);
    } catch (e) {
      Logger.warn('[FaceDetection] Failed to start capture service:', e);
    }

    // Wait for capture service to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Create state
    state = {
      enabled: true,
      intervalId: null,
      interval: intervalSeconds,
      faces: faces,
      streamId: streamId,
      isProcessing: false,
      lastDetection: null
    };

    // Start interval
    const intervalMs = intervalSeconds * 1000;
    state.intervalId = setInterval(() => this.processFaceDetection(deviceId), intervalMs);

    this.faceDetectionState.set(deviceId, state);

    // Run first detection
    setTimeout(() => this.processFaceDetection(deviceId), 3000);

    Logger.log(`[FaceDetection] Started for ${deviceId} (interval: ${intervalSeconds}s, faces: ${faces.length})`);
  },

  /**
   * Stop face detection for a camera
   */
  async stopFaceDetection(deviceId) {
    const state = this.faceDetectionState.get(deviceId);
    if (!state) return;

    if (state.intervalId) {
      clearInterval(state.intervalId);
    }

    // Stop capture service
    if (state.streamId) {
      try {
        await this.stopCaptureService(state.streamId);
      } catch (e) {}
    }

    this.faceDetectionState.delete(deviceId);
    Logger.log(`[FaceDetection] Stopped for ${deviceId}`);
  },

  /**
   * Process face detection for a camera
   */
  async processFaceDetection(deviceId) {
    const state = this.faceDetectionState.get(deviceId);
    if (!state || state.isProcessing) {
      return;
    }

    state.isProcessing = true;

    try {
      // Get latest frame from capture service
      const frameUrl = `${this.CAPTURE_SERVICE_URL}/frame/${state.streamId}`;
      const frameResponse = await fetch(frameUrl);

      if (!frameResponse.ok) {
        state.isProcessing = false;
        return;
      }

      const frameBlob = await frameResponse.blob();

      // Get person IDs from faces
      const personIds = state.faces.map(f => f.person_id).filter(Boolean);
      if (personIds.length === 0) {
        state.isProcessing = false;
        return;
      }

      // Send to backend for recognition
      const formData = new FormData();
      formData.append('image', frameBlob, 'frame.jpg');

      const recognizeResponse = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/recognize`, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      if (!recognizeResponse.ok) {
        state.isProcessing = false;
        return;
      }

      const result = await recognizeResponse.json();

      // Check for matches
      if (result.success && Array.isArray(result.result) && result.result.length > 0) {
        for (const match of result.result) {
          if (!match.isMatchFound || match.score < 70) {
            continue;
          }

          // Find face by name (case-insensitive for Turkish chars)
          let matchedFace = state.faces.find(f =>
            f.name?.localeCompare(match.name, 'tr', { sensitivity: 'base' }) === 0
          );

          // Fallback: If only 1 face registered and name didn't match, use that face
          if (!matchedFace && state.faces.length === 1) {
            matchedFace = state.faces[0];
          }

          // Fallback 2: Try partial match (first word matches)
          if (!matchedFace) {
            const matchFirstName = match.name?.split(' ')[0]?.toLowerCase();
            matchedFace = state.faces.find(f => {
              const faceFirstName = f.name?.split(' ')[0]?.toLowerCase();
              return matchFirstName && faceFirstName && matchFirstName === faceFirstName;
            });
          }

          const faceName = matchedFace?.name || match.name || 'Bilinmeyen';

          Logger.log(`[FaceDetection] Match: ${faceName} (score: ${match.score})`);

          // Log to backend
          try {
            await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/log`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                face_id: matchedFace?.id,
                person_id: matchedFace?.person_id,
                name: faceName,
                confidence: match.score
              })
            });
          } catch (e) {
            Logger.warn('[FaceDetection] Failed to log detection:', e);
          }

          // Only show alert if trigger_alarm is enabled
          if (!matchedFace?.trigger_alarm) {
            continue;
          }

          // Prevent duplicate alerts (30s cooldown)
          const now = Date.now();
          const lastKey = `${deviceId}_${faceName}`;
          if (state.lastDetection?.key === lastKey && (now - state.lastDetection.time) < 30000) {
            continue;
          }
          state.lastDetection = { key: lastKey, time: now };

          // Show alert
          const faceImageUrl = matchedFace?.face_image_url || null;
          await this.showFaceDetectionAlert(deviceId, faceName, match.score, faceImageUrl);
        }
      }

    } catch (error) {
      Logger.error('[FaceDetection] Process error:', error);
    }

    state.isProcessing = false;
  },

  /**
   * Show face detection alert
   */
  async showFaceDetectionAlert(deviceId, faceName, confidence, faceImageUrl) {
    const camera = this.cameras.find(c => c.device_id === deviceId);
    const cameraName = camera?.name || deviceId;

    // Play alert sound
    if (typeof this.playAlarmSound === 'function') {
      this.playAlarmSound();
    }

    // Show notification popup
    let alertEl = document.getElementById('face-detection-alert');
    if (!alertEl) {
      alertEl = document.createElement('div');
      alertEl.id = 'face-detection-alert';
      alertEl.className = 'face-detection-alert';
      document.body.appendChild(alertEl);
    }

    // Build alert HTML
    alertEl.innerHTML = `
      <div class="face-alert-content">
        <div class="face-alert-image" id="face-alert-image-container"></div>
        <div class="face-alert-info">
          <div class="face-alert-label">YÜZ ALGILANDI</div>
          <div class="face-alert-name">${escapeHtml(faceName)}</div>
          <div class="face-alert-camera">${escapeHtml(cameraName)}</div>
          <div class="face-alert-confidence">Eşleşme Skoru: ${Math.round(confidence)}</div>
        </div>
        <button class="face-alert-close">&times;</button>
      </div>
    `;

    // Add close button handler
    alertEl.querySelector('.face-alert-close').onclick = () => alertEl.classList.remove('show');

    // Add image or fallback icon
    const imageContainer = alertEl.querySelector('#face-alert-image-container');
    if (faceImageUrl) {
      const img = document.createElement('img');
      img.src = faceImageUrl;
      img.alt = faceName;
      img.className = 'face-alert-thumb';
      img.onerror = () => {
        imageContainer.innerHTML = `<div class="face-alert-icon-fallback"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4 4-6 8-6s8 2 8 6"></path></svg></div>`;
      };
      imageContainer.appendChild(img);
    } else {
      imageContainer.innerHTML = `<div class="face-alert-icon-fallback"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4 4-6 8-6s8 2 8 6"></path></svg></div>`;
    }

    alertEl.classList.add('show');

    // Auto hide after 30 seconds
    setTimeout(() => {
      alertEl.classList.remove('show');
    }, 30000);

    Logger.log(`[FaceDetection] Alert: ${faceName} detected on ${cameraName} (${confidence}%)`);
  },

  /**
   * Update face detection when settings change
   */
  async updateFaceDetectionSettings(deviceId, enabled, interval) {
    if (enabled) {
      // Stop if running with different settings
      const state = this.faceDetectionState.get(deviceId);
      if (state?.intervalId) {
        await this.stopFaceDetection(deviceId);
      }
      // Start with new settings
      await this.startFaceDetection(deviceId, interval);
    } else {
      await this.stopFaceDetection(deviceId);
    }
  },

  /**
   * Refresh faces for a camera (called when faces are added/removed)
   */
  async refreshFaceDetectionFaces(deviceId) {
    const state = this.faceDetectionState.get(deviceId);
    if (!state) return;

    try {
      const facesRes = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/faces`, {
        credentials: 'include'
      });
      if (facesRes.ok) {
        const data = await facesRes.json();
        state.faces = data.faces || [];
        Logger.log(`[FaceDetection] Refreshed faces for ${deviceId}: ${state.faces.length}`);
      }
    } catch (e) {
      Logger.warn('[FaceDetection] Failed to refresh faces:', e);
    }
  }
};

// Add CSS for alert popup
const faceDetectionStyles = document.createElement('style');
faceDetectionStyles.textContent = `
.face-detection-alert {
  position: fixed;
  top: 20px;
  right: 60px;
  z-index: 10000;
  transform: translateX(120%);
  transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}

.face-detection-alert.show {
  transform: translateX(0);
  pointer-events: auto;
}

.face-alert-content {
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  background: rgba(200, 200, 200, 0.4);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12);
  min-width: 320px;
  max-width: 380px;
}

.face-alert-image {
  flex-shrink: 0;
}

.face-alert-thumb {
  width: 72px;
  height: 72px;
  border-radius: 10px;
  object-fit: cover;
  border: 2px solid #b8d4e3;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.face-alert-icon-fallback {
  width: 72px;
  height: 72px;
  border-radius: 10px;
  background: #e8f4f8;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
  border: 2px solid #b8d4e3;
}

.face-alert-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.face-alert-label {
  font-size: 10px;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 1.2px;
  font-weight: 600;
  margin-bottom: 4px;
}

.face-alert-name {
  font-size: 18px;
  font-weight: 600;
  color: #1e293b;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.face-alert-camera {
  font-size: 13px;
  color: #64748b;
  margin-bottom: 6px;
}

.face-alert-confidence {
  display: inline-block;
  font-size: 12px;
  color: #475569;
  font-weight: 500;
  background: #e2e8f0;
  padding: 4px 10px;
  border-radius: 6px;
  margin-top: 4px;
}

.face-alert-close {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: #94a3b8;
  font-size: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.face-alert-close:hover {
  background: #f1f5f9;
  color: #475569;
}

/* Animation for entry */
.face-detection-alert.show .face-alert-content {
  animation: alertPulse 0.4s ease-out;
}

@keyframes alertPulse {
  0% { transform: scale(0.96); opacity: 0; }
  100% { transform: scale(1); opacity: 1; }
}
`;
document.head.appendChild(faceDetectionStyles);

export { FaceDetectionMixin };
