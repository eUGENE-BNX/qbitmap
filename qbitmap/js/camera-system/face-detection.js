import { QBitmapConfig } from '../config.js';
import { Logger, escapeHtml } from '../utils.js';

/**
 * QBitmap Camera System - Face Detection Module
 * Handles background face detection and recognition alerts
 */

const FaceDetectionMixin = {
  // Face detection state per camera
  faceDetectionState: new Map(), // deviceId -> { enabled, intervalId, interval, isProcessing, streamId, lastDetection }

  // Cached global face library shared across all cameras (user-level).
  // Refreshed on start, on add/remove, and on settings changes.
  _faceLibrary: [],

  // Face recognition API URL (from config)
  get FACE_API_URL() { return QBitmapConfig.api.faceMatcher; },

  async _reloadFaceLibrary() {
    try {
      const res = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/library`, {
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        this._faceLibrary = data.faces || [];
        Logger.log(`[FaceDetection] Library reloaded: ${this._faceLibrary.length} face(s)`, this._faceLibrary.map(f => ({ id: f.id, name: f.name, trigger_alarm: f.trigger_alarm })));
      } else {
        Logger.warn(`[FaceDetection] /library returned ${res.status}`);
      }
    } catch (e) {
      Logger.warn('[FaceDetection] Failed to reload library:', e);
    }
    return this._faceLibrary;
  },

  /**
   * Initialize face detection on startup (loads cameras with detection enabled)
   */
  async initFaceDetection() {
    Logger.log('[FaceDetection] init() called');
    try {
      // Prime the global library once up-front so per-camera starts skip
      // N identical /library fetches.
      await this._reloadFaceLibrary();

      const response = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/active`, {
        credentials: 'include'
      });

      if (!response.ok) {
        Logger.warn(`[FaceDetection] /active returned HTTP ${response.status} — no auto-start`);
        return;
      }

      const data = await response.json();
      const cams = data.cameras || [];
      Logger.log(`[FaceDetection] /active returned ${cams.length} camera(s):`, cams.map(c => ({ device_id: c.device_id, enabled: c.face_detection_enabled, interval: c.face_detection_interval, type: c.camera_type })));
      if (cams.length === 0) {
        Logger.warn('[FaceDetection] No cameras have face_detection_enabled=1 — toggle aç.');
      }
      for (const camera of cams) {
        if (camera.face_detection_enabled) {
          await this.startFaceDetection(camera.device_id, camera.face_detection_interval || 10);
        } else {
          Logger.warn(`[FaceDetection] Camera ${camera.device_id} in active list but face_detection_enabled=${camera.face_detection_enabled}, skipping`);
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
      Logger.warn(`[FaceDetection] Already running for ${deviceId}, skipping start`);
      return;
    }

    // Find camera to get WHEP URL
    const camera = this.cameras.find(c => c.device_id === deviceId);
    if (!camera) {
      Logger.warn(`[FaceDetection] Camera ${deviceId} not found in this.cameras (cameras count: ${this.cameras?.length ?? 0})`);
      return;
    }
    if (camera.camera_type !== 'whep') {
      Logger.warn(`[FaceDetection] Camera ${deviceId} is not WHEP type (got: "${camera.camera_type}") — face detection only supports WHEP`);
      return;
    }

    // Ensure global library + per-camera threshold are loaded.
    // No per-camera face list any more: detection matches against the
    // user's entire library and alarms fire for any face with trigger_alarm.
    if (this._faceLibrary.length === 0) {
      await this._reloadFaceLibrary();
    }
    if (this._faceLibrary.length === 0) {
      Logger.warn(`[FaceDetection] Face library is empty — no reference faces to match against. Aborting start for ${deviceId}`);
      return;
    }

    let matchThreshold = 70;
    try {
      const sRes = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/settings`, {
        credentials: 'include'
      });
      if (sRes.ok) {
        const sData = await sRes.json();
        if (sData.match_threshold) matchThreshold = parseInt(sData.match_threshold, 10) || 70;
      }
    } catch (e) { /* fall back to 70 */ }

    // Extract stream ID from WHEP URL
    const streamId = this.extractStreamIdFromWhepUrl(camera.whep_url);
    if (!streamId) {
      Logger.warn(`[FaceDetection] Could not extract streamId from whep_url: "${camera.whep_url}" for ${deviceId}`);
      return;
    }
    Logger.log(`[FaceDetection] streamId="${streamId}" for ${deviceId}, threshold=${matchThreshold}`);

    // Start capture service
    try {
      Logger.log(`[FaceDetection] Starting capture service for ${streamId} @ ${intervalSeconds}s`);
      await this.startCaptureService(streamId, intervalSeconds * 1000);
      Logger.log(`[FaceDetection] Capture service start OK for ${streamId}`);
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
      streamId: streamId,
      isProcessing: false,
      lastDetection: null,
      matchThreshold
    };

    // Start interval
    const intervalMs = intervalSeconds * 1000;
    state.intervalId = setInterval(() => this.processFaceDetection(deviceId), intervalMs);

    this.faceDetectionState.set(deviceId, state);

    // Run first detection
    setTimeout(() => this.processFaceDetection(deviceId), 3000);

    Logger.log(`[FaceDetection] Started for ${deviceId} (interval: ${intervalSeconds}s, library: ${this._faceLibrary.length}, threshold: ${matchThreshold}) — first frame in 3s`);
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
    if (!state) {
      Logger.warn(`[FaceDetection] process() called for ${deviceId} but no state exists`);
      return;
    }
    if (state.isProcessing) {
      Logger.log(`[FaceDetection] ${deviceId} still processing previous tick, skipping`);
      return;
    }

    state.isProcessing = true;
    const tickStart = Date.now();
    Logger.log(`[FaceDetection] [${deviceId}] tick start, streamId=${state.streamId}`);

    try {
      const frameUrl = `${this.CAPTURE_SERVICE_URL}/frame/${state.streamId}`;
      Logger.log(`[FaceDetection] [${deviceId}] GET ${frameUrl}`);
      const frameResponse = await fetch(frameUrl);
      if (!frameResponse.ok) {
        Logger.warn(`[FaceDetection] [${deviceId}] frame fetch failed: HTTP ${frameResponse.status} ${frameResponse.statusText}`);
        state.isProcessing = false;
        return;
      }

      const frameBlob = await frameResponse.blob();
      Logger.log(`[FaceDetection] [${deviceId}] got frame: ${frameBlob.size} bytes (${frameBlob.type})`);
      const library = this._faceLibrary;
      if (!library || library.length === 0) {
        Logger.warn(`[FaceDetection] [${deviceId}] library empty at process time — skipping recognize`);
        state.isProcessing = false;
        return;
      }

      const formData = new FormData();
      formData.append('image', frameBlob, 'frame.jpg');

      const recognizeUrl = `${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/recognize`;
      Logger.log(`[FaceDetection] [${deviceId}] POST ${recognizeUrl}`);
      const recognizeResponse = await fetch(recognizeUrl, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      if (!recognizeResponse.ok) {
        const errText = await recognizeResponse.text().catch(() => '(no body)');
        Logger.warn(`[FaceDetection] [${deviceId}] recognize failed: HTTP ${recognizeResponse.status} — ${errText.slice(0, 300)}`);
        state.isProcessing = false;
        return;
      }

      const result = await recognizeResponse.json();
      const threshold = state.matchThreshold || 70;
      const elapsedMs = Date.now() - tickStart;
      Logger.log(`[FaceDetection] [${deviceId}] recognize response (${elapsedMs}ms), threshold=${threshold}:`, result);

      if (!result.success) {
        Logger.warn(`[FaceDetection] [${deviceId}] recognize returned success=false:`, result);
      } else if (!Array.isArray(result.result) || result.result.length === 0) {
        Logger.log(`[FaceDetection] [${deviceId}] no faces detected in frame`);
      }

      if (result.success && Array.isArray(result.result) && result.result.length > 0) {
        Logger.log(`[FaceDetection] [${deviceId}] ${result.result.length} candidate(s):`, result.result.map(m => ({ name: m.name, score: m.score, isMatchFound: m.isMatchFound })));
        for (const match of result.result) {
          if (!match.isMatchFound) {
            Logger.log(`[FaceDetection] [${deviceId}] candidate "${match.name}" score=${match.score} → isMatchFound=false, skip`);
            continue;
          }
          if (match.score < threshold) {
            Logger.log(`[FaceDetection] [${deviceId}] candidate "${match.name}" score=${match.score} < threshold=${threshold}, skip`);
            continue;
          }

          // Match against the full user library (post-refactor: a face added
          // on any camera is valid for any camera). name-based fallback still
          // kicks in because matcher returns names, not person_ids.
          let matchedFace = library.find(f =>
            f.name?.localeCompare(match.name, 'tr', { sensitivity: 'base' }) === 0
          );

          if (!matchedFace && library.length === 1) {
            matchedFace = library[0];
          }

          if (!matchedFace) {
            const matchFirstName = match.name?.split(' ')[0]?.toLowerCase();
            matchedFace = library.find(f => {
              const faceFirstName = f.name?.split(' ')[0]?.toLowerCase();
              return matchFirstName && faceFirstName && matchFirstName === faceFirstName;
            });
          }

          const faceName = matchedFace?.name || match.name || 'Bilinmeyen';

          Logger.log(`[FaceDetection] [${deviceId}] ✓ MATCH: ${faceName} (score: ${match.score}, trigger_alarm=${matchedFace?.trigger_alarm ?? 'n/a'})`);

          try {
            await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/log`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                person_id: matchedFace?.person_id,
                name: faceName,
                confidence: match.score
              })
            });
          } catch (e) {
            Logger.warn('[FaceDetection] Failed to log detection:', e);
          }

          if (!matchedFace?.trigger_alarm) {
            Logger.log(`[FaceDetection] [${deviceId}] "${faceName}" matched but trigger_alarm=OFF → DB'ye yazdı, popup yok`);
            continue;
          }

          const now = Date.now();
          const lastKey = `${deviceId}_${faceName}`;
          if (state.lastDetection?.key === lastKey && (now - state.lastDetection.time) < 30000) {
            Logger.log(`[FaceDetection] [${deviceId}] "${faceName}" dedup window (30s), alarm atlandı`);
            continue;
          }
          state.lastDetection = { key: lastKey, time: now };

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
   * Refresh faces for a camera (called when faces are added/removed).
   * Library is now user-global so we refresh the shared cache; deviceId
   * is kept for call-site compatibility.
   */
  async refreshFaceDetectionFaces(_deviceId) {
    await this._reloadFaceLibrary();
    Logger.log(`[FaceDetection] Refreshed global library: ${this._faceLibrary.length}`);
  },

  /**
   * Show absence alarm popup. Triggered by server WebSocket push when a
   * configured time window closes without any of the user's cameras having
   * seen the watched face.
   */
  async showFaceAbsenceAlert(payload) {
    const { faceName, faceImageUrl, label, startTime, endTime } = payload || {};

    if (typeof this.playAlarmSound === 'function') {
      this.playAlarmSound();
    }

    let alertEl = document.getElementById('face-absence-alert');
    if (!alertEl) {
      alertEl = document.createElement('div');
      alertEl.id = 'face-absence-alert';
      alertEl.className = 'face-detection-alert face-absence-alert';
      document.body.appendChild(alertEl);
    }

    const windowStr = startTime && endTime
      ? `${startTime.slice(0, 5)}–${endTime.slice(0, 5)}`
      : '';

    alertEl.innerHTML = `
      <div class="face-alert-content face-absence-content">
        <div class="face-alert-image" id="face-absence-image-container"></div>
        <div class="face-alert-info">
          <div class="face-alert-label face-absence-label">YÜZ GÖRÜLMEDİ</div>
          <div class="face-alert-name">${escapeHtml(faceName || 'Bilinmeyen')}</div>
          ${label ? `<div class="face-alert-camera">${escapeHtml(label)}</div>` : ''}
          <div class="face-alert-confidence face-absence-window">${escapeHtml(windowStr)}</div>
        </div>
        <button class="face-alert-close">&times;</button>
      </div>
    `;

    alertEl.querySelector('.face-alert-close').onclick = () => alertEl.classList.remove('show');

    const imageContainer = alertEl.querySelector('#face-absence-image-container');
    if (faceImageUrl) {
      const img = document.createElement('img');
      img.src = faceImageUrl;
      img.alt = faceName || '';
      img.className = 'face-alert-thumb';
      img.onerror = () => {
        imageContainer.innerHTML = `<div class="face-alert-icon-fallback"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4 4-6 8-6s8 2 8 6"></path></svg></div>`;
      };
      imageContainer.appendChild(img);
    } else {
      imageContainer.innerHTML = `<div class="face-alert-icon-fallback"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4 4-6 8-6s8 2 8 6"></path></svg></div>`;
    }

    alertEl.classList.add('show');
    setTimeout(() => alertEl.classList.remove('show'), 30000);

    Logger.log(`[FaceDetection] Absence alert: ${faceName} missing in window ${windowStr}`);
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

/* Absence variant: red accent so the user can tell at a glance it's a
   "not seen" alarm, not a regular "face detected" alarm. */
.face-absence-alert {
  top: 80px; /* stacks below the regular detection alert */
}
.face-absence-content {
  background: rgba(255, 220, 220, 0.55) !important;
  border-color: rgba(200, 40, 40, 0.25) !important;
}
.face-absence-label {
  color: #b42020 !important;
}
.face-absence-window {
  background: #fde0e0 !important;
  color: #7a1515 !important;
}

/* Mobile: center horizontally, anchor 150px from top. Slide in from above
   instead of from the right, so it lands visibly in the viewport. */
@media (max-width: 560px) {
  .face-detection-alert {
    top: 150px;
    right: auto;
    left: 50%;
    transform: translate(-50%, -30px);
    opacity: 0;
    transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.35s ease-out;
  }
  .face-detection-alert.show {
    transform: translate(-50%, 0);
    opacity: 1;
  }
  .face-absence-alert {
    top: 240px; /* stacks below the main alert on mobile */
  }
  .face-alert-content {
    min-width: 0;
    width: calc(100vw - 92px);
    max-width: calc(100vw - 92px);
  }
}
`;
document.head.appendChild(faceDetectionStyles);

export { FaceDetectionMixin };
