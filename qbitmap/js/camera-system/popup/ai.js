import { QBitmapConfig } from "../../config.js";
import { Logger } from "../../utils.js";
import { AuthSystem } from "../../auth.js";

const AiMixin = {
  toggleAiSearchMode(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    popupData.aiSearchMode = !popupData.aiSearchMode;

    if (popupData.aiSearchMode) {
      this.enterAiSearchMode(deviceId);
    } else {
      this.exitAiSearchMode(deviceId);
    }
  },

  /**
   * Enter AI search mode
   */
  enterAiSearchMode(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const aiSearchBtn = popupEl?.querySelector('.ai-search-btn');
    const frameContainer = popupEl?.querySelector('.camera-frame-container');
    const videoEl = popupEl?.querySelector('.camera-video');

    if (!aiSearchBtn || !frameContainer || !videoEl) return;

    // Activate button
    aiSearchBtn.classList.add('active');
    frameContainer.classList.add('ai-search-mode');
    frameContainer.style.cursor = 'crosshair';

    // Create selection overlay
    this.createAiSearchOverlay(deviceId);

    // Add mouse handlers
    popupData.aiSearchMouseDown = (e) => this.handleAiSearchMouseDown(deviceId, e);
    popupData.aiSearchMouseMove = (e) => this.handleAiSearchMouseMove(deviceId, e);
    popupData.aiSearchMouseUp = (e) => this.handleAiSearchMouseUp(deviceId, e);

    videoEl.addEventListener('mousedown', popupData.aiSearchMouseDown);
    document.addEventListener('mousemove', popupData.aiSearchMouseMove);
    document.addEventListener('mouseup', popupData.aiSearchMouseUp);

    Logger.log('[AISearch] Mode activated');
  },

  /**
   * Exit AI search mode
   */
  exitAiSearchMode(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const aiSearchBtn = popupEl?.querySelector('.ai-search-btn');
    const frameContainer = popupEl?.querySelector('.camera-frame-container');
    const videoEl = popupEl?.querySelector('.camera-video');

    popupData.aiSearchMode = false;

    if (aiSearchBtn) aiSearchBtn.classList.remove('active');
    if (frameContainer) {
      frameContainer.classList.remove('ai-search-mode');
      frameContainer.style.cursor = popupData.zoomLevel === 0 ? 'zoom-in' : 'zoom-out';
    }

    // Remove overlay
    const overlay = popupEl?.querySelector('.ai-search-overlay');
    if (overlay) overlay.remove();

    // Remove event listeners
    if (videoEl && popupData.aiSearchMouseDown) {
      videoEl.removeEventListener('mousedown', popupData.aiSearchMouseDown);
    }
    if (popupData.aiSearchMouseMove) {
      document.removeEventListener('mousemove', popupData.aiSearchMouseMove);
    }
    if (popupData.aiSearchMouseUp) {
      document.removeEventListener('mouseup', popupData.aiSearchMouseUp);
    }

    // Clear selection state
    popupData.aiSearchSelection = null;

    // Dismiss result card if open
    this.dismissAiSearchCard();

    Logger.log('[AISearch] Mode deactivated');
  },

  /**
   * Create AI search overlay for rectangle selection
   */
  createAiSearchOverlay(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const container = popupEl.querySelector('.camera-frame-container');
    if (!container) return;

    const overlay = document.createElement('div');
    overlay.className = 'ai-search-overlay';
    overlay.innerHTML = `<div class="ai-search-rect"></div>`;
    container.appendChild(overlay);
  },

  /**
   * Handle mouse down for AI search rectangle
   */
  handleAiSearchMouseDown(deviceId, e) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.aiSearchMode) return;

    e.preventDefault();
    e.stopPropagation();

    const popupEl = popupData.popup.getElement();
    const videoEl = popupEl.querySelector('.camera-video');
    const rect = videoEl.getBoundingClientRect();

    popupData.aiSearchSelection = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      endX: e.clientX - rect.left,
      endY: e.clientY - rect.top,
      isDrawing: true,
      videoRect: rect
    };

    this.updateAiSearchRect(deviceId);
  },

  /**
   * Handle mouse move for AI search rectangle
   */
  handleAiSearchMouseMove(deviceId, e) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.aiSearchSelection?.isDrawing) return;

    const { videoRect } = popupData.aiSearchSelection;

    // Clamp to video bounds
    popupData.aiSearchSelection.endX = Math.max(0, Math.min(
      videoRect.width,
      e.clientX - videoRect.left
    ));
    popupData.aiSearchSelection.endY = Math.max(0, Math.min(
      videoRect.height,
      e.clientY - videoRect.top
    ));

    this.updateAiSearchRect(deviceId);
  },

  /**
   * Handle mouse up for AI search rectangle
   */
  handleAiSearchMouseUp(deviceId, e) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.aiSearchSelection?.isDrawing) return;

    popupData.aiSearchSelection.isDrawing = false;

    // Check if selection is large enough (at least 50x50 pixels)
    const { startX, startY, endX, endY } = popupData.aiSearchSelection;
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    if (width >= 50 && height >= 50) {
      // Process the selection
      this.processAiSearchSelection(deviceId);
    } else {
      // Too small, reset
      Logger.log('[AISearch] Selection too small, ignoring');
      const popupEl = popupData.popup.getElement();
      const rectEl = popupEl?.querySelector('.ai-search-rect');
      if (rectEl) rectEl.style.display = 'none';
    }
  },

  /**
   * Update AI search rectangle visual
   */
  updateAiSearchRect(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.aiSearchSelection) return;

    const popupEl = popupData.popup.getElement();
    const rectEl = popupEl?.querySelector('.ai-search-rect');
    if (!rectEl) return;

    const { startX, startY, endX, endY, videoRect } = popupData.aiSearchSelection;

    // Calculate rect bounds (handle negative selection direction)
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    // Convert to percentages
    rectEl.style.left = (left / videoRect.width * 100) + '%';
    rectEl.style.top = (top / videoRect.height * 100) + '%';
    rectEl.style.width = (width / videoRect.width * 100) + '%';
    rectEl.style.height = (height / videoRect.height * 100) + '%';
    rectEl.style.display = 'block';
  },

  /**
   * Process AI search selection - crop and send to API
   */
  async processAiSearchSelection(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.aiSearchSelection) return;

    const popupEl = popupData.popup.getElement();
    const videoEl = popupEl.querySelector('.camera-video');
    if (!videoEl) return;

    const { startX, startY, endX, endY, videoRect } = popupData.aiSearchSelection;

    // Calculate coordinates
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    // Scale to video's actual dimensions
    const scaleX = videoEl.videoWidth / videoRect.width;
    const scaleY = videoEl.videoHeight / videoRect.height;

    const cropX = left * scaleX;
    const cropY = top * scaleY;
    const cropWidth = width * scaleX;
    const cropHeight = height * scaleY;

    // Create canvas and crop
    const canvas = document.createElement('canvas');
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(
      videoEl,
      cropX, cropY, cropWidth, cropHeight,  // Source rect
      0, 0, cropWidth, cropHeight            // Dest rect
    );

    // Convert to base64
    const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];

    // Show loading card
    this.showAiSearchCard(deviceId, { loading: true });

    // Send to API
    await this.sendToAiSearch(deviceId, base64);
  },

  /**
   * Send cropped image to AI API
   */
  async sendToAiSearch(deviceId, base64) {
    // Get effective AI settings (per-camera > global fallback)
    const aiSettings = await this.getEffectiveAiSettings(deviceId);

    try {
      const response = await fetch(`${QBitmapConfig.api.ai}/analyze`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: aiSettings.model,
          prompt: aiSettings.searchPrompt,
          images: [base64],
          stream: false,
          options: {
            num_predict: aiSettings.maxTokens,
            temperature: aiSettings.temperature
          }
        })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();

      // Extract response text (strip thinking tags from qwen)
      let responseText = data.response || '';
      responseText = responseText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      this.showAiSearchCard(deviceId, {
        loading: false,
        success: true,
        response: responseText
      });

      Logger.log('[AISearch] Analysis complete');

    } catch (error) {
      Logger.error('[AISearch] API error:', error);
      this.showAiSearchCard(deviceId, {
        loading: false,
        error: true,
        message: error.message
      });
    }
  },

  /**
   * Show AI search result card (positioned to the right of popup)
   */
  showAiSearchCard(deviceId, options) {
    const { loading, success, error, response, message } = options;

    // Remove existing card
    this.dismissAiSearchCard();

    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const card = document.createElement('div');
    card.id = 'ai-search-card';
    card.className = 'ai-search-card';
    card.dataset.deviceId = deviceId;

    if (loading) {
      card.innerHTML = `
        <div class="asc-header">
          <span class="asc-title">AI</span>
          <span>Analiz</span>
        </div>
        <div class="asc-body asc-loading">
          <div class="asc-spinner"></div>
          <span>Analiz ediliyor...</span>
        </div>
      `;
    } else if (error) {
      card.innerHTML = `
        <div class="asc-header asc-error-header">
          <span class="asc-title">AI</span>
          <span>Hata</span>
          <button class="asc-close">&times;</button>
        </div>
        <div class="asc-body">
          <p class="asc-error-text">${escapeHtml(message || 'Analiz tamamlanamadı')}</p>
        </div>
      `;
    } else {
      card.innerHTML = `
        <div class="asc-header">
          <span class="asc-title">AI</span>
          <span>Analiz</span>
          <button class="asc-close">&times;</button>
        </div>
        <div class="asc-body">
          <p class="asc-response">${this.escapeHtmlAiSearch(response || '')}</p>
        </div>
      `;
    }

    // Append to body and position to the right of popup
    document.body.appendChild(card);

    // Position card to the right of popup
    const popupRect = popupEl.getBoundingClientRect();
    card.style.position = 'fixed';
    card.style.left = (popupRect.right + 10) + 'px';
    card.style.top = popupRect.top + 'px';

    // Ensure card stays within viewport
    requestAnimationFrame(() => {
      const cardRect = card.getBoundingClientRect();
      if (cardRect.right > window.innerWidth - 10) {
        // Move to left side of popup if no space on right
        card.style.left = (popupRect.left - cardRect.width - 10) + 'px';
      }
      if (cardRect.bottom > window.innerHeight - 10) {
        card.style.top = (window.innerHeight - cardRect.height - 10) + 'px';
      }
    });

    // Add close handler
    const closeBtn = card.querySelector('.asc-close');
    if (closeBtn) {
      closeBtn.onclick = () => this.dismissAiSearchCard();
    }

    // Auto-dismiss after 20 seconds (if not loading)
    if (!loading) {
      popupData.aiSearchCardTimeout = setTimeout(() => {
        this.dismissAiSearchCard();
      }, 20000);
    }
  },

  /**
   * Dismiss AI search result card
   */
  dismissAiSearchCard() {
    const card = document.getElementById('ai-search-card');
    if (card) card.remove();

    // Clear auto-dismiss timeout and selection rect
    for (const [, popupData] of this.popups) {
      if (popupData.aiSearchCardTimeout) {
        clearTimeout(popupData.aiSearchCardTimeout);
        popupData.aiSearchCardTimeout = null;
      }
    }

    // Clear selection rectangle
    const rectEl = document.querySelector('.ai-search-rect');
    if (rectEl) rectEl.style.display = 'none';
  },

  /**
   * Escape HTML for AI search response
   */
  escapeHtmlAiSearch(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  /**
   * Toggle AI analyze on/off (periodic analysis while active)
   */
  async toggleAiAnalyze(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    if (popupData.aiAnalyzeActive) {
      // Stop
      this.stopAiAnalyze(deviceId);
    } else {
      // Start
      await this.startAiAnalyze(deviceId);
    }
  },

  /**
   * Start periodic AI analysis
   */
  async startAiAnalyze(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const btn = popupEl?.querySelector('.ai-analyze-btn');

    popupData.aiAnalyzeActive = true;
    popupData.aiAnalyzeResults = [];

    // Activate button visual
    if (btn) {
      btn.classList.add('ai-analyzing');
      btn.title = 'AI Analiz Durdur';
    }

    // Get settings from per-camera settings
    let intervalMs = 3000;
    try {
      const resp = await fetch(`${this.apiSettings}/${deviceId}`);
      if (resp.ok) {
        const data = await resp.json();
        const s = data.settings || {};
        intervalMs = s.ai_capture_interval_ms ?? 3000;
        popupData.aiAnalyzeThreshold = s.ai_confidence_threshold ?? 70;
        popupData.aiAnalyzeRequiredFrames = s.ai_consecutive_frames ?? 3;
      }
    } catch (e) {}
    if (!popupData.aiAnalyzeThreshold) popupData.aiAnalyzeThreshold = 70;
    if (!popupData.aiAnalyzeRequiredFrames) popupData.aiAnalyzeRequiredFrames = 3;

    // Show initial loading
    this.showAiAnalyzeCard(deviceId, { loading: true });

    // Run first analysis immediately
    await this.doAiAnalyzeFrame(deviceId);

    // Start periodic interval (only if still active - user might have stopped during first analysis)
    if (popupData.aiAnalyzeActive) {
      popupData.aiAnalyzeIntervalId = setInterval(() => this.doAiAnalyzeFrame(deviceId), intervalMs);
      Logger.log(`[AI Analyze] Started periodic analysis for ${deviceId} (interval: ${intervalMs}ms)`);
    }
  },

  /**
   * Stop periodic AI analysis
   */
  stopAiAnalyze(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    popupData.aiAnalyzeActive = false;

    // Clear interval
    if (popupData.aiAnalyzeIntervalId) {
      clearInterval(popupData.aiAnalyzeIntervalId);
      popupData.aiAnalyzeIntervalId = null;
    }

    // Clear typewriter timer
    if (popupData.aiTypewriteTimer) {
      clearInterval(popupData.aiTypewriteTimer);
      popupData.aiTypewriteTimer = null;
    }

    // Reset button
    const popupEl = popupData.popup.getElement();
    const btn = popupEl?.querySelector('.ai-analyze-btn');
    if (btn) {
      btn.classList.remove('ai-analyzing');
      btn.title = 'AI Analiz';
    }

    // Clear any active alarm for this camera
    if (this.activeAlarms.has(deviceId)) {
      this.activeAlarms.delete(deviceId);
      this.dismissAlarm();
      this.updateCameraIcon(deviceId);
    }

    // Remove card
    this.dismissAiAnalyzeCard(deviceId);

    Logger.log(`[AI Analyze] Stopped for ${deviceId}`);
  },

  /**
   * Analyze a single frame (called by interval)
   */
  async doAiAnalyzeFrame(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.aiAnalyzeActive) return;

    // Prevent overlapping analyses
    if (popupData.aiAnalyzeProcessing) return;
    popupData.aiAnalyzeProcessing = true;

    const popupEl = popupData.popup.getElement();
    const videoEl = popupEl?.querySelector('.camera-video');

    try {
      // Capture frame
      let base64;
      if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        base64 = this.videoToBase64(videoEl);
      }
      if (!base64) {
        this.showAiAnalyzeCard(deviceId, { error: true, message: 'Frame yakalanamadi' });
        return;
      }

      // Get effective AI settings
      const aiSettings = await this.getEffectiveAiSettings(deviceId);

      // Send to API
      const response = await fetch(`${QBitmapConfig.api.ai}/analyze`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: aiSettings.model,
          prompt: aiSettings.monitoringPrompt,
          images: [base64],
          stream: false,
          options: {
            num_predict: aiSettings.maxTokens,
            temperature: aiSettings.temperature
          }
        })
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      let responseText = data.response || '';
      responseText = responseText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      const parsed = this.parseOllamaResponse(responseText);
      const confidence = parsed?.confidence || 0;
      const threshold = popupData.aiAnalyzeThreshold || 70;
      const requiredFrames = popupData.aiAnalyzeRequiredFrames || 3;

      if (parsed?.alarm) {
        // Add to consecutive results
        popupData.aiAnalyzeResults.push(confidence);
        while (popupData.aiAnalyzeResults.length > requiredFrames) {
          popupData.aiAnalyzeResults.shift();
        }

        const avgConfidence = popupData.aiAnalyzeResults.reduce((a, b) => a + b, 0) / popupData.aiAnalyzeResults.length;

        if (avgConfidence >= threshold && popupData.aiAnalyzeResults.length >= requiredFrames) {
          // Consecutive frames met - trigger alarm
          const thumbnail = await this.resizeBase64Image(base64, 360);
          const alarmPayload = {
            tasvir: parsed.tasvir,
            confidence: avgConfidence / 100,
            timestamp: new Date().toISOString(),
            snapshot: thumbnail
          };

          // Send alarm to backend (also broadcasts via WebSocket to other clients)
          try {
            const alarmResp = await fetch(`${QBitmapConfig.api.monitoring}/cameras/${deviceId}/alarms`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify(alarmPayload)
            });
            if (alarmResp.ok) {
              const alarmResult = await alarmResp.json();
              // Store in activeAlarms so dismiss works
              this.activeAlarms.set(deviceId, {
                id: alarmResult.alarmId,
                deviceId,
                cameraName: popupData.camera?.name || deviceId,
                data: alarmPayload
              });
            }
          } catch (e) {
            Logger.error('[AI Analyze] Failed to send alarm:', e);
          }

          // Show alarm popup + sound directly (inline, no mixin dependency)
          const cameraName = popupData.camera?.name || deviceId;
          try {
            // Remove existing alarm popup
            const existingAlarm = document.getElementById('ai-alarm-popup');
            if (existingAlarm) existingAlarm.remove();

            // Create floating alarm popup
            const alarmEl = document.createElement('div');
            alarmEl.id = 'ai-alarm-popup';
            alarmEl.dataset.deviceId = deviceId;
            alarmEl.className = 'ai-alarm active';
            alarmEl.innerHTML = `
              <div class="ai-alarm-header">
                <span class="ai-alarm-icon">\u{1F6A8}</span>
                <span class="ai-alarm-title">ACIL DURUM</span>
                <button class="ai-alarm-close">&times;</button>
              </div>
              <div class="ai-alarm-body">
                <div class="ai-alarm-desc">${escapeHtml(alarmPayload.tasvir) || 'Acil durum tespit edildi!'}</div>
                ${alarmPayload.snapshot ? `
                  <div class="ai-alarm-snapshot">
                    <img src="data:image/jpeg;base64,${alarmPayload.snapshot}" alt="Alarm snapshot">
                  </div>
                ` : ''}
                <div class="ai-alarm-meta">
                  <span>Kamera: ${escapeHtml(cameraName)}</span>
                  <span>${new Date().toLocaleTimeString('tr-TR')}</span>
                </div>
              </div>
            `;
            document.body.appendChild(alarmEl);
            alarmEl.querySelector('.ai-alarm-close').addEventListener('click', () => this.clearAlarmClick(deviceId));

            // Play alarm sound
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            oscillator.frequency.value = 800;
            oscillator.type = 'square';
            gainNode.gain.value = 0.3;
            oscillator.start();
            let beepCount = 0;
            const beepInterval = setInterval(() => {
              gainNode.gain.value = gainNode.gain.value > 0 ? 0 : 0.3;
              beepCount++;
              if (beepCount >= 6) {
                clearInterval(beepInterval);
                oscillator.stop();
              }
            }, 200);
          } catch (alarmUiErr) {
            Logger.error('[AI Analyze] Alarm UI error:', alarmUiErr);
          }

          this.showAiAnalyzeCard(deviceId, {
            alarm: true,
            text: parsed.tasvir || responseText,
            confidence: avgConfidence
          });
          popupData.aiAnalyzeResults = []; // Reset after alarm
        } else {
          // Still collecting frames
          this.showAiAnalyzeCard(deviceId, {
            success: true,
            text: `${parsed.tasvir || responseText} (${popupData.aiAnalyzeResults.length}/${requiredFrames})`,
            confidence: confidence
          });
        }
      } else {
        // No alarm - reset counter
        popupData.aiAnalyzeResults = [];
        this.showAiAnalyzeCard(deviceId, {
          success: true,
          text: parsed?.tasvir || responseText,
          confidence: parsed?.confidence
        });
      }

    } catch (error) {
      Logger.error('[AI Analyze] Error:', error);
      this.showAiAnalyzeCard(deviceId, { error: true, message: error.message });
    } finally {
      popupData.aiAnalyzeProcessing = false;
    }
  },

  /**
   * Show AI analyze result card (attached to popup, not floating)
   */
  showAiAnalyzeCard(deviceId, options) {
    const { loading, success, alarm, error, text, message, confidence } = options;

    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const popupContent = popupEl?.querySelector('.camera-popup-content');
    if (!popupContent) return;

    // Remove existing card within this popup
    const existing = popupContent.querySelector('.ai-analyze-card');
    if (existing) existing.remove();

    const card = document.createElement('div');
    card.className = 'ai-analyze-card';

    if (loading) {
      card.innerHTML = `
        <div class="aac-header">
          <span class="aac-title">AI</span>
          <span>Analiz</span>
        </div>
        <div class="aac-body aac-loading">
          <div class="asc-spinner"></div>
          <span>AI analiz ediliyor...</span>
        </div>
      `;
    } else if (error) {
      card.innerHTML = `
        <div class="aac-header aac-error-header">
          <span class="aac-title">AI</span>
          <span>Hata</span>
        </div>
        <div class="aac-body">
          <p class="aac-error-text">${this.escapeHtmlAiSearch(message || 'Analiz tamamlanamadi')}</p>
        </div>
      `;
    } else if (alarm) {
      card.innerHTML = `
        <div class="aac-header aac-alarm-header">
          <span class="aac-title">AI</span>
          <span class="aac-badge aac-badge-alarm">ALARM${confidence ? ` (${confidence}%)` : ''}</span>
        </div>
        <div class="aac-body">
          <p class="aac-response aac-alarm-text"></p>
        </div>
      `;
    } else {
      card.innerHTML = `
        <div class="aac-header">
          <span class="aac-title">AI</span>
          <span class="aac-badge aac-badge-ok">OK${confidence ? ` (${confidence}%)` : ''}</span>
        </div>
        <div class="aac-body">
          <p class="aac-response"></p>
        </div>
      `;
    }

    // Append inside popup content (after popup body)
    popupContent.appendChild(card);

    // Typewriter effect for success/alarm text
    if ((success || alarm) && text) {
      const responseEl = card.querySelector('.aac-response');
      if (responseEl) {
        this.typewriteAiResponse(deviceId, responseEl, text);
      }
    }
  },

  /**
   * Typewriter effect for AI response text
   */
  typewriteAiResponse(deviceId, element, text) {
    const popupData = this.popups.get(deviceId);

    // Clear any previous typewriter for this device
    if (popupData?.aiTypewriteTimer) {
      clearInterval(popupData.aiTypewriteTimer);
      popupData.aiTypewriteTimer = null;
    }

    const escaped = this.escapeHtmlAiSearch(text);
    let charIndex = 0;
    const speed = 20; // ms per character

    // Add blinking cursor
    const cursor = document.createElement('span');
    cursor.className = 'aac-cursor';
    element.textContent = '';
    element.appendChild(cursor);

    const timer = setInterval(() => {
      if (charIndex >= escaped.length || !element.isConnected) {
        clearInterval(timer);
        if (popupData) popupData.aiTypewriteTimer = null;
        // Remove cursor when done
        cursor.remove();
        return;
      }
      // Insert text before cursor
      cursor.before(escaped[charIndex]);
      charIndex++;
    }, speed);

    if (popupData) popupData.aiTypewriteTimer = timer;
  },

  /**
   * Dismiss AI analyze result card
   */
  dismissAiAnalyzeCard(deviceId) {
    if (deviceId) {
      const popupData = this.popups.get(deviceId);
      if (popupData) {
        const popupEl = popupData.popup.getElement();
        const card = popupEl?.querySelector('.ai-analyze-card');
        if (card) card.remove();
      }
    } else {
      // Remove all ai-analyze-cards (cleanup)
      document.querySelectorAll('.ai-analyze-card').forEach(c => c.remove());
    }
  },
};

export { AiMixin };
