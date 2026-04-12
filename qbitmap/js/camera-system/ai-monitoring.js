import { QBitmapConfig } from '../config.js';
import { Logger, TimerManager, escapeHtml } from '../utils.js';
import { Analytics } from '../analytics.js';

/**
 * QBitmap Camera System - AI Monitoring Module
 * Handles AI fall detection, alarms, and ONVIF events
 */

// Global AI request queue - limits concurrent AI requests across cameras
// Prevents rate limit (429) errors when too many cameras analyze simultaneously
const aiRequestQueue = {
  queue: [],
  active: 0,
  maxConcurrent: 3,

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processNext();
    });
  },

  async processNext() {
    if (this.active >= this.maxConcurrent || this.queue.length === 0) return;
    this.active++;
    const { fn, resolve, reject } = this.queue.shift();
    try {
      resolve(await fn());
    } catch (e) {
      reject(e);
    } finally {
      this.active--;
      this.processNext();
    }
  }
};

const AIMonitoringMixin = {
  /**
   * Toggle fall detection for a device
   */
  async toggleFallDetection(deviceId, enabled) {
    Analytics.event('ai_monitor_toggle', { camera_id: deviceId, enabled });

    if (enabled) {
      // Notify backend to start monitoring
      try {
        const response = await fetch(`${QBitmapConfig.api.monitoring}/cameras/${deviceId}/monitoring`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ enabled: true })
        });

        if (!response.ok) {
          throw new Error('Backend monitoring start failed');
        }

        Logger.log('[SYS] AI monitoring backend\'e kaydedildi.');

        // Backend will broadcast via WebSocket, which will trigger handleMonitoringChanged
        // But start immediately for this client if popup is open
        const popupData = this.popups.get(deviceId);
        if (popupData) {
          await this.startLocalAIInterval(deviceId);
        }

      } catch (error) {
        Logger.error('[AI] Failed to start monitoring:', error);
        Logger.log('[ERR] Backend baglantisi basarisiz');
      }
    } else {
      // Stop monitoring
      try {
        await fetch(`${QBitmapConfig.api.monitoring}/cameras/${deviceId}/monitoring`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ enabled: false })
        });

        Logger.log('[SYS] AI monitoring durduruldu.');
        await this.stopAIMonitoring(deviceId);

      } catch (error) {
        Logger.error('[AI] Failed to stop monitoring:', error);
        Logger.log('[ERR] Durdurma basarisiz');
      }
    }
  },

  /**
   * Start local AI interval for this client (only if popup is open)
   */
  async startLocalAIInterval(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return; // No popup open, skip

    // Check if already starting/started (prevent duplicate calls from WebSocket + local)
    let aiState = this.aiMonitoring.get(deviceId);
    if (aiState?.intervalId || aiState?.isStarting) {
      Logger.log(`[AI] Already running/starting for ${deviceId}, skipping duplicate start`);
      return;
    }

    // Set starting flag to prevent concurrent calls
    if (!aiState) {
      aiState = {};
      this.aiMonitoring.set(deviceId, aiState);
    }
    aiState.isStarting = true;

    // [MI-4] Get capture interval from settings (cached 5min in localStorage)
    let intervalMs = 3000;
    try {
      const cacheKey = `qb_settings_${deviceId}`;
      const cached = localStorage.getItem(cacheKey);
      let data;
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.time < 300000) { data = parsed.data; }
      }
      if (!data) {
        const resp = await fetch(`${this.apiSettings}/${deviceId}`);
        data = await resp.json();
        try { localStorage.setItem(cacheKey, JSON.stringify({ data, time: Date.now() })); } catch (e) {}
      }
      if (data.settings?.ai_capture_interval_ms) {
        intervalMs = data.settings.ai_capture_interval_ms;
      }
    } catch (e) {}

    // For WHEP cameras, start capture service
    let streamId = null;
    if (popupData.isWhep) {
      const popupEl = popupData.popup.getElement();
      const whepUrl = popupEl?.querySelector('.camera-popup-content')?.dataset.whepUrl;
      streamId = this.extractStreamIdFromWhepUrl(whepUrl);

      if (streamId) {
        Logger.log(`[SYS] Capture servisi başlatılıyor (${streamId}, ${intervalMs}ms)...`);
        await this.startCaptureService(streamId, intervalMs);
        await new Promise(resolve => setTimeout(resolve, 1500));
      } else {
        Logger.log('[ERR] Stream ID alınamadı!');
      }
    }

    // Update or create global AI state
    aiState = aiState || {};

    // Clear any existing interval first
    if (aiState.intervalId) {
      clearInterval(aiState.intervalId);
    }

    aiState.intervalId = setInterval(() => this.analyzeFrameForFall(deviceId), intervalMs);
    aiState.isAnalyzing = false;
    aiState.recentResults = [];
    aiState.streamId = streamId;
    aiState.enabled = true;
    aiState.isStarting = false; // Clear starting flag

    this.aiMonitoring.set(deviceId, aiState);

    // Update popup title and camera icon
    this.updatePopupTitle(deviceId);
    this.updateCameraIcon(deviceId);

    // Run first analysis after a delay to allow capture service to start
    setTimeout(() => this.analyzeFrameForFall(deviceId), 2000);

    Logger.log(`[AI] Local analysis started for ${deviceId} (interval: ${intervalMs}ms, streamId: ${streamId})`);
  },

  /**
   * Stop AI monitoring (local + global state)
   */
  async stopAIMonitoring(deviceId) {
    const aiState = this.aiMonitoring.get(deviceId);

    if (aiState?.intervalId) {
      clearInterval(aiState.intervalId);
    }

    // Stop capture service for WHEP cameras
    if (aiState?.streamId) {
      await this.stopCaptureService(aiState.streamId);
    }

    // Clear global state
    this.aiMonitoring.delete(deviceId);

    // Clear any active alarm for this camera
    if (this.activeAlarms.has(deviceId)) {
      this.activeAlarms.delete(deviceId);
      this.dismissAlarm();
    }

    // Update popup title if open
    this.updatePopupTitle(deviceId);

    // Update icon
    this.updateCameraIcon(deviceId);

    Logger.log(`[AI] Monitoring stopped for ${deviceId}`);
  },

  /**
   * Update popup title (removed AI indicator - now using AI button)
   */
  updatePopupTitle(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const titleSpan = popupEl.querySelector('.camera-id');
    if (!titleSpan) return;

    const camera = this.cameras.find(c => c.device_id === deviceId);
    const baseName = camera?.name || deviceId;

    titleSpan.textContent = baseName;

    // Update AI button visibility
    this.updatePopupAiButton(deviceId);
  },

  /**
   * Update AI button visibility and animation
   */
  updatePopupAiButton(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const aiBtn = popupEl.querySelector('.ai-btn');
    if (!aiBtn) return;

    const aiState = this.aiMonitoring.get(deviceId);
    if (aiState?.enabled) {
      // Show AI button with pulsing animation
      aiBtn.style.display = 'flex';
      aiBtn.classList.add('ai-pulse');
    } else {
      // Hide AI button
      aiBtn.style.display = 'none';
      aiBtn.classList.remove('ai-pulse');
    }
  },

  /**
   * Stop AI when clicking indicator in title
   */
  async stopAIFromTitle(deviceId) {
    await this.toggleFallDetection(deviceId);
    Logger.log('[SYS] AI monitoring durduruldu (title tiklamasi).');
  },

  /**
   * Get effective AI settings for a camera (per-camera overrides global)
   * Returns: { model, monitoringPrompt, searchPrompt, maxTokens, temperature }
   */
  async getEffectiveAiSettings(deviceId) {
    const global = this.aiSettings || {};
    const effective = {
      model: global.model || 'qwen3-vl:32b-instruct',
      monitoringPrompt: global.monitoringPrompt || AI_VISION_PROMPT,
      searchPrompt: global.searchPrompt || 'bu resimde ne goruyorsun maksimum birkac cumle ile acikla ve sadece emin olduklarini yaz',
      maxTokens: global.maxTokens || 1024,
      temperature: global.temperature || 0.7
    };

    try {
      const resp = await fetch(`${this.apiSettings}/${deviceId}`);
      if (resp.ok) {
        const data = await resp.json();
        const s = data.settings || {};
        if (s.ai_vision_model) effective.model = s.ai_vision_model;
        if (s.ai_detection_rules?.length) {
          effective.monitoringPrompt = buildPromptFromRules(s.ai_detection_rules);
        } else if (s.ai_monitoring_prompt) {
          effective.monitoringPrompt = s.ai_monitoring_prompt;
        }
        if (s.ai_search_prompt) effective.searchPrompt = s.ai_search_prompt;
        if (s.ai_max_tokens) effective.maxTokens = parseInt(s.ai_max_tokens);
        if (s.ai_temperature) effective.temperature = parseFloat(s.ai_temperature);
      }
    } catch (e) {
      // Silently fall back to global
    }

    return effective;
  },

  /**
   * Analyze frame for AI Vision
   * [FE-004] Added promise lock to prevent race conditions
   */
  async analyzeFrameForFall(deviceId) {
    // Check global AI state instead of popup state
    const aiState = this.aiMonitoring.get(deviceId);
    if (!aiState?.enabled) return;

    // Get popup data (might be null if popup closed)
    const popupData = this.popups.get(deviceId);

    // [FE-004] Promise-based lock - wait for previous analysis to complete
    // This prevents race conditions when multiple calls happen before isAnalyzing is set
    if (aiState.analysisPromise) {
      Logger.log(`[AI] Analysis already in progress for ${deviceId}, waiting...`);
      try {
        await aiState.analysisPromise;
      } catch (e) {
        // Ignore errors from previous analysis
      }
      // After waiting, check if still enabled
      if (!aiState?.enabled) return;
    }

    // Skip if already analyzing (double-check after await)
    if (aiState.isAnalyzing) return;
    aiState.isAnalyzing = true;

    // Create a promise that resolves when this analysis completes
    // [FE-004] Added 90 second timeout to prevent hung promises
    let resolveAnalysis;
    let analysisTimeout;
    aiState.analysisPromise = new Promise(resolve => {
      resolveAnalysis = resolve;
      // Timeout after 90 seconds to prevent memory leaks from hung promises
      analysisTimeout = setTimeout(() => {
        Logger.warn(`[AI] Analysis timeout for ${deviceId}, forcing completion`);
        resolve();
      }, 90000);
    });

    // Get frame source based on camera type
    let base64;

    // For WHEP cameras - get frame from capture service (works even when popup closed)
    if (aiState.streamId) {
      base64 = await this.getFrameFromCapture(aiState.streamId);
    }

    // Fallback to popup-based capture if no base64 yet
    if (!base64 && popupData) {
      const popupEl = popupData.popup.getElement();
      // Try WHEP video element first (class is camera-video)
      const videoEl = popupEl?.querySelector('.camera-video');
      if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        base64 = this.videoToBase64(videoEl);
        Logger.log(`[AI] Frame captured from video element (fallback)`);
      } else {
        // Try MJPEG/snapshot image
        const frameImg = popupEl?.querySelector('.camera-frame');
        if (frameImg?.complete && frameImg.naturalWidth > 0) {
          base64 = this.imageToBase64(frameImg);
          Logger.log(`[AI] Frame captured from image element`);
        }
      }
    }

    // No frame available - skip this cycle
    if (!base64) {
      aiState.isAnalyzing = false;
      // [FE-004] Must resolve promise to prevent blocking other calls
      if (analysisTimeout) clearTimeout(analysisTimeout);
      if (resolveAnalysis) resolveAnalysis();
      aiState.analysisPromise = null;
      return;
    }

    try {
      // AI ayarlarini al (cache'den veya API'den) - per-camera with global fallback
      let threshold = 70;
      let requiredFrames = 3;
      let captureInterval = 3000;
      const globalAi = this.aiSettings || {};
      let model = globalAi.model || 'qwen3-vl:32b-instruct';
      let prompt = globalAi.monitoringPrompt || AI_VISION_PROMPT;
      let maxTokens = globalAi.maxTokens || 1024;
      let temperature = globalAi.temperature || 0.7;

      try {
        const settingsResp = await fetch(`${this.apiSettings}/${deviceId}`);
        if (settingsResp.ok) {
          const settingsData = await settingsResp.json();
          const s = settingsData.settings || {};
          threshold = s.ai_confidence_threshold ?? 70;
          requiredFrames = s.ai_consecutive_frames ?? 3;
          captureInterval = s.ai_capture_interval_ms ?? 3000;
          // Per-camera AI vision overrides
          if (s.ai_vision_model) model = s.ai_vision_model;
          if (s.ai_detection_rules?.length) {
            prompt = buildPromptFromRules(s.ai_detection_rules);
          } else if (s.ai_monitoring_prompt) {
            prompt = s.ai_monitoring_prompt;
          }
          if (s.ai_max_tokens) maxTokens = parseInt(s.ai_max_tokens);
          if (s.ai_temperature) temperature = parseFloat(s.ai_temperature);
        }
      } catch (e) {}

      // Send to AI API via backend proxy (queued to prevent 429 rate limit errors)
      const requestBody = JSON.stringify({
        model: model,
        prompt: prompt,
        images: [base64],
        stream: false,
        options: {
          num_predict: maxTokens,
          temperature: temperature
        }
      });

      // [ARCH-11] credentials:'include' was missing — /api/ai/analyze requires auth.
      const response = await aiRequestQueue.enqueue(async () => {
        const resp = await fetch(`${QBitmapConfig.api.ai}/analyze`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody
        });
        // Retry once on 429 after waiting
        if (resp.status === 429) {
          const retryAfter = parseInt(resp.headers.get('Retry-After')) || 5;
          Logger.warn(`[AI] Rate limited for ${deviceId}, retrying in ${retryAfter}s`);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          return fetch(`${QBitmapConfig.api.ai}/analyze`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: requestBody
          });
        }
        return resp;
      });

      const data = await response.json();
      let responseText = data.response || '';
      // Strip <think> tags (some models wrap reasoning in them)
      // Also handle unclosed <think> blocks (when model runs out of tokens mid-think)
      responseText = responseText.replace(/<think>[\s\S]*?<\/think>/g, '');
      responseText = responseText.replace(/<think>[\s\S]*/g, '');
      responseText = responseText.trim();
      const result = this.parseOllamaResponse(responseText);
      const confidence = result?.confidence || 0;

      // recentResults dizisini baslat (yoksa)
      if (!aiState.recentResults) {
        aiState.recentResults = [];
      }

      // Sadece alarm=true olan sonuclari degerlendir
      if (result?.alarm) {
        // Son sonuclara ekle
        aiState.recentResults.push(confidence);

        // Sadece son N kareyi tut
        while (aiState.recentResults.length > requiredFrames) {
          aiState.recentResults.shift();
        }

        // Ortalama hesapla
        const avgConfidence = aiState.recentResults.reduce((a, b) => a + b, 0)
          / aiState.recentResults.length;

        // Esigi gecti mi kontrol et
        if (avgConfidence >= threshold) {
          // Yeterli kare toplandiysa alarm ver
          if (aiState.recentResults.length >= requiredFrames) {
            // Resize image for alarm snapshot (360px width, ~10-20KB)
            const thumbnail = await this.resizeBase64Image(base64, 360);

            // Send alarm to backend
            try {
              await fetch(`${QBitmapConfig.api.monitoring}/cameras/${deviceId}/alarms`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                  tasvir: result.tasvir,
                  confidence: avgConfidence / 100, // Convert 0-100 to 0-1 for backend
                  timestamp: new Date().toISOString(),
                  snapshot: thumbnail  // Resized image for alarm display
                })
              });
              Logger.log('[AI] Alarm sent to backend');
            } catch (error) {
              Logger.error('[AI] Failed to send alarm to backend:', error);
            }

            // Local alarm display (will also be triggered by WebSocket broadcast)
            Logger.log(`[ALARM] ${result.tasvir} (avg: ${avgConfidence.toFixed(0)}%)`);
            aiState.recentResults = []; // Reset after alarm
          } else {
            // Henuz yeterli kare yok
            Logger.log(`[${confidence}%] ${result.tasvir || 'Analiz...'} (${aiState.recentResults.length}/${requiredFrames})`);
          }
        } else {
          // Esik altinda
          Logger.log(`[${confidence}%] ${result.tasvir || 'Analiz...'} (avg: ${avgConfidence.toFixed(0)}% < ${threshold}% esik)`);
        }
      } else {
        // Normal durum - alarm yok, recentResults'i sifirla
        aiState.recentResults = [];
        // Kullaniciya AI'in calistigini goster
        Logger.log(`[Normal] ${result?.tasvir || 'Tehlikeli durum tespit edilmedi'} (${confidence}%)`);
      }

      Logger.log(`[AI] Analysis result:`, result, `| avg threshold: ${threshold}, frames: ${requiredFrames}`);

    } catch (error) {
      Logger.error('[AI] Analysis error:', error);
      Logger.log(`[HATA] AI analiz hatasi: ${error.message}`);
    } finally {
      aiState.isAnalyzing = false;
      // [FE-004] Clear timeout and resolve the promise lock
      if (analysisTimeout) clearTimeout(analysisTimeout);
      if (resolveAnalysis) resolveAnalysis();
      aiState.analysisPromise = null;
    }
  },

  /**
   * Convert image element to base64
   */
  imageToBase64(imgElement) {
    const canvas = document.createElement('canvas');
    canvas.width = imgElement.naturalWidth;
    canvas.height = imgElement.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgElement, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  },

  /**
   * Convert video element to base64 (for WHEP cameras - fallback)
   */
  videoToBase64(videoElement) {
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  },

  // ==================== Capture Service Methods ====================

  /**
   * Extract stream ID from WHEP URL
   */
  extractStreamIdFromWhepUrl(whepUrl) {
    if (!whepUrl) return null;
    const match = whepUrl.match(/\/([^\/]+)\/whep$/);
    return match ? match[1] : null;
  },

  /**
   * Start capture service for a stream
   */
  async startCaptureService(streamId, interval = null) {
    try {
      const body = { streamId };
      if (interval) {
        body.interval = interval;
      }
      const response = await fetch(`${CAPTURE_SERVICE_URL}/capture/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      Logger.log(`[Capture] Started capture for ${streamId} (interval: ${interval || 'default'}ms):`, data);
      return data;
    } catch (error) {
      Logger.error(`[Capture] Failed to start capture for ${streamId}:`, error);
      return null;
    }
  },

  /**
   * Get frame from capture service as base64
   */
  async getFrameFromCapture(streamId) {
    try {
      const response = await fetch(`${CAPTURE_SERVICE_URL}/frame/${streamId}/base64`);
      if (!response.ok) {
        Logger.warn(`[Capture] No frame available for ${streamId}`);
        return null;
      }
      const data = await response.json();
      return data.base64;
    } catch (error) {
      Logger.error(`[Capture] Failed to get frame for ${streamId}:`, error);
      return null;
    }
  },

  /**
   * Stop capture service for a stream
   */
  async stopCaptureService(streamId) {
    try {
      const response = await fetch(`${CAPTURE_SERVICE_URL}/capture/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId })
      });

      if (response.ok) {
        const data = await response.json();
        Logger.log(`[Capture] Stopped capture for ${streamId}`);
        return data;
      } else if (response.status === 404) {
        Logger.log(`[Capture] Stream ${streamId} already stopped`);
        return { message: 'Already stopped' };
      }

      Logger.warn(`[Capture] Unexpected status ${response.status} for ${streamId}`);
      return null;
    } catch (error) {
      Logger.log(`[Capture] Could not reach capture service (${streamId})`);
      return null;
    }
  },

  /**
   * Parse Ollama response text to JSON
   */
  parseOllamaResponse(responseText) {
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      Logger.warn('[AI] Could not parse response:', responseText);
    }
    return null;
  },

  // ==================== Alarm Methods ====================

  /**
   * Resize base64 image to max width (for alarm snapshot)
   * @param {string} base64 - Original base64 image
   * @param {number} maxWidth - Maximum width (default: 360 = alarm card width)
   * @returns {Promise<string>} Resized base64 image
   */
  async resizeBase64Image(base64, maxWidth = 360) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = Math.round(height * (maxWidth / width));
          width = maxWidth;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Export as JPEG with 80% quality (~10-20KB)
        resolve(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
      };
      img.onerror = () => resolve(null);
      img.src = `data:image/jpeg;base64,${base64}`;
    });
  },

  /**
   * Show alarm popup
   */
  showAlarmPopup(deviceId, result, cameraName) {
    // Remove existing alarm if any
    const existing = document.getElementById('ai-alarm-popup');
    if (existing) existing.remove();

    // Create alarm popup
    const alarm = document.createElement('div');
    alarm.id = 'ai-alarm-popup';
    alarm.dataset.deviceId = deviceId;
    alarm.className = 'ai-alarm active';
    alarm.innerHTML = `
      <div class="ai-alarm-header">
        <span class="ai-alarm-icon">🚨</span>
        <span class="ai-alarm-title">ACIL DURUM</span>
        <button class="ai-alarm-close">&times;</button>
      </div>
      <div class="ai-alarm-body">
        <div class="ai-alarm-desc">${escapeHtml(result.tasvir) || 'Acil durum tespit edildi!'}</div>
        ${result.snapshot ? `
          <div class="ai-alarm-snapshot">
            <img src="data:image/jpeg;base64,${result.snapshot}" alt="Alarm snapshot">
          </div>
        ` : ''}
        <div class="ai-alarm-meta">
          <span>Kamera: ${escapeHtml(cameraName) || escapeHtml(deviceId.substring(0, 8))}</span>
          <span>${new Date().toLocaleTimeString('tr-TR')}</span>
        </div>
      </div>
    `;

    document.body.appendChild(alarm);
    alarm.querySelector('.ai-alarm-close').addEventListener('click', () => this.clearAlarmClick(deviceId));
  },

  /**
   * Play alarm sound using Web Audio API
   */
  playAlarmSound() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      oscillator.frequency.value = 800;
      oscillator.type = 'square';
      gainNode.gain.value = 0.3;

      oscillator.start();

      // 3 beeps
      let count = 0;
      const beep = setInterval(() => {
        gainNode.gain.value = gainNode.gain.value > 0 ? 0 : 0.3;
        count++;
        if (count >= 6) {
          clearInterval(beep);
          oscillator.stop();
        }
      }, 200);
    } catch (e) {
      Logger.warn('[AI] Could not play alarm sound:', e);
    }
  },

  /**
   * Clear alarm when user clicks X button
   */
  async clearAlarmClick(deviceId) {
    const alarm = this.activeAlarms.get(deviceId);
    if (!alarm) {
      this.dismissAlarm();
      return;
    }

    try {
      await fetch(`${QBitmapConfig.api.monitoring}/alarms/${alarm.id}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      Logger.log('[Alarm] Cleared alarm:', alarm.id);
    } catch (error) {
      Logger.error('[Alarm] Failed to clear:', error);
      this.dismissAlarm();
    }
  },

  /**
   * Auto-open camera popup on alarm if setting enabled
   */
  async maybeAutoOpenCamera(deviceId) {
    try {
      const resp = await fetch(`${this.apiSettings}/${deviceId}`);
      const data = await resp.json();

      if (data.settings?.auto_popup_enabled) {
        const camera = this.cameras.find(c => c.device_id === deviceId);
        if (camera && camera.lng && camera.lat) {
          if (!this.popups.has(deviceId)) {
            this.openCameraPopup(camera, [camera.lng, camera.lat]);

            this.map.flyTo({
              center: [camera.lng, camera.lat],
              zoom: 16,
              duration: 2000
            });

            Logger.log('[Alarm] Auto-opened camera:', deviceId);
          }
        }
      }
    } catch (error) {
      Logger.error('[Alarm] Failed to check auto-open setting:', error);
    }
  },

  /**
   * Dismiss alarm popup
   */
  dismissAlarm() {
    const alarm = document.getElementById('ai-alarm-popup');
    if (alarm) {
      alarm.classList.remove('active');
      setTimeout(() => alarm.remove(), 300);
    }
  },

  // ==================== ONVIF Event Handlers ====================

  /**
   * Handle ONVIF event from WebSocket
   */
  handleOnvifEvent(payload) {
    const { deviceId, eventType, eventState } = payload;
    Logger.log('[ONVIF] Event received:', deviceId, eventType, eventState);

    if (eventState) {
      switch (eventType) {
        case 'motion':
          this.triggerCameraBlink(deviceId);
          this.showEventNotification(deviceId, 'motion-icon', 'Motion');
          break;
        case 'human':
          this.showEventNotification(deviceId, 'person-icon', 'Human');
          break;
        case 'pet':
          this.showEventNotification(deviceId, 'pet-icon', 'Pet');
          break;
        case 'vehicle':
          this.showEventNotification(deviceId, 'vehicle-icon', 'Vehicle');
          break;
        case 'line_crossing':
          this.showEventNotification(deviceId, 'warning-icon', 'Line Crossing');
          break;
        case 'tamper':
          this.showEventNotification(deviceId, 'warning-icon', 'Tamper');
          break;
      }
    }
  },

  /**
   * Trigger camera icon blink effect for motion detection
   */
  triggerCameraBlink(deviceId) {
    const camera = this.cameras.find(c => c.device_id === deviceId);
    if (!camera) return;

    const markerId = `camera-${camera.device_id}`;
    const markerElement = document.getElementById(markerId);

    if (markerElement) {
      markerElement.classList.add('camera-blink');
      setTimeout(() => {
        markerElement.classList.remove('camera-blink');
      }, 3000);
    }
  },

  /**
   * SVG icons for ONVIF events
   */
  eventIcons: {
    'person-icon': `<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
    'pet-icon': `<svg viewBox="0 0 24 24"><path d="M4.5 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm5-2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm5 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm5 2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM12 11.5c-2.5 0-4.5 2-4.5 4.5 0 1.5.5 2.5 1 3.5.5 1 1.5 2 2 2.5.5.5 1 .5 1.5.5s1 0 1.5-.5c.5-.5 1.5-1.5 2-2.5.5-1 1-2 1-3.5 0-2.5-2-4.5-4.5-4.5z"/></svg>`,
    'vehicle-icon': `<svg viewBox="0 0 24 24"><path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/></svg>`,
    'warning-icon': `<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
    'motion-icon': `<svg viewBox="0 0 24 24"><path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L6 8.3V13h2V9.6l1.8-.7"/></svg>`
  },

  /**
   * Show event notification with icon near camera
   */
  showEventNotification(deviceId, iconClass, message) {
    const camera = this.cameras.find(c => c.device_id === deviceId);
    if (!camera || !camera.lng || !camera.lat || !this.map) return;

    const notificationId = `onvif-notification-${deviceId}`;

    // Remove existing notification
    const existingNotification = document.getElementById(notificationId);
    if (existingNotification) {
      existingNotification.remove();
    }

    const svgIcon = this.eventIcons[iconClass] || this.eventIcons['warning-icon'];

    const notificationEl = document.createElement('div');
    notificationEl.id = notificationId;
    notificationEl.className = `onvif-notification ${iconClass}`;
    notificationEl.innerHTML = `<div class="notification-icon">${svgIcon}</div>`;

    try {
      const point = this.map.project([camera.lng, camera.lat]);
      const mapContainer = this.map.getContainer();
      const mapRect = mapContainer.getBoundingClientRect();

      // Calculate position relative to map
      let left = mapRect.left + point.x + 25;
      let top = mapRect.top + point.y - 25;

      // Clamp to screen bounds
      left = Math.max(10, Math.min(left, window.innerWidth - 50));
      top = Math.max(10, Math.min(top, window.innerHeight - 50));

      notificationEl.style.left = left + 'px';
      notificationEl.style.top = top + 'px';

      document.body.appendChild(notificationEl);
    } catch (err) {
      return;
    }

    // Remove after 5 seconds
    setTimeout(() => {
      if (notificationEl.parentNode) {
        notificationEl.remove();
      }
    }, 5000);

    Logger.log(`[ONVIF] Notification shown: ${message} for ${deviceId}`);
  }
};

export { AIMonitoringMixin };
