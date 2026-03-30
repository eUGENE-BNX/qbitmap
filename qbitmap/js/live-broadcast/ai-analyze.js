import { QBitmapConfig } from '../config.js';
import { Logger, escapeHtml } from '../utils.js';
import { CameraSystem } from '../camera-system/index.js';

const AiAnalyzeMixin = {
  toggleBroadcastAiAnalyze(popupEl) {
    if (this._broadcastAiAnalyzeActive) {
      this.stopBroadcastAiAnalyze(popupEl);
    } else {
      this.startBroadcastAiAnalyze(popupEl);
    }
  },

  async startBroadcastAiAnalyze(popupEl) {
    this._broadcastAiAnalyzeActive = true;

    const btn = popupEl?.querySelector('.broadcast-ai-analyze-btn');
    if (btn) {
      btn.classList.add('ai-analyzing');
      btn.title = 'AI Analiz Durdur';
    }

    // Get interval from admin AI settings (same source as WHEP cameras)
    const aiSettings = CameraSystem?.aiSettings || {};
    const intervalMs = aiSettings.broadcastInterval || 3000;

    this.showBroadcastAiAnalyzeCard(popupEl, { loading: true });

    // Run first analysis immediately (same pattern as WHEP doAiAnalyzeFrame)
    await this.doBroadcastAiAnalyzeFrame(popupEl);

    // Start periodic interval (only if still active)
    if (this._broadcastAiAnalyzeActive) {
      this._broadcastAiAnalyzeIntervalId = setInterval(() => this.doBroadcastAiAnalyzeFrame(popupEl), intervalMs);
      Logger.log(`[LiveBroadcast] AI Analyze started (interval: ${intervalMs}ms)`);
    }
  },

  stopBroadcastAiAnalyze(popupEl) {
    this._broadcastAiAnalyzeActive = false;

    if (this._broadcastAiAnalyzeIntervalId) {
      clearInterval(this._broadcastAiAnalyzeIntervalId);
      this._broadcastAiAnalyzeIntervalId = null;
    }

    if (this._broadcastAiTypewriteTimer) {
      clearInterval(this._broadcastAiTypewriteTimer);
      this._broadcastAiTypewriteTimer = null;
    }

    const btn = popupEl?.querySelector('.broadcast-ai-analyze-btn');
    if (btn) {
      btn.classList.remove('ai-analyzing');
      btn.title = 'AI Analiz';
    }

    this.dismissBroadcastAiAnalyzeCard(popupEl);
    Logger.log('[LiveBroadcast] AI Analyze stopped');
  },

  /**
   * Analyze a single frame — mirrors WHEP camera doAiAnalyzeFrame exactly
   */
  async doBroadcastAiAnalyzeFrame(popupEl) {
    if (!this._broadcastAiAnalyzeActive) return;
    if (this._broadcastAiAnalyzeProcessing) return;
    this._broadcastAiAnalyzeProcessing = true;

    const videoEl = popupEl?.querySelector('.camera-video');

    try {
      // Capture frame — same as WHEP videoToBase64
      let base64;
      if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        canvas.getContext('2d').drawImage(videoEl, 0, 0);
        base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
      }
      if (!base64) {
        this.showBroadcastAiAnalyzeCard(popupEl, { error: true, message: 'Frame yakalanamadi' });
        return;
      }

      // Get AI settings — same as WHEP getEffectiveAiSettings
      const aiSettings = CameraSystem?.aiSettings || {};

      // Send to API — identical to WHEP doAiAnalyzeFrame (with sane defaults)
      const response = await fetch(`${QBitmapConfig.api.ai}/analyze`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: aiSettings.model || 'qwen3-vl:32b-instruct',
          prompt: aiSettings.broadcastPrompt || aiSettings.monitoringPrompt || 'Bu goruntuyu analiz et ve onemli olan her seyi bildir.',
          images: [base64],
          stream: false,
          options: {
            num_predict: aiSettings.maxTokens || 1024,
            temperature: aiSettings.temperature || 0.7
          }
        })
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      let responseText = data.response || '';
      responseText = responseText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      // Parse response — same as WHEP
      let parsed = null;
      if (CameraSystem?.parseOllamaResponse) {
        parsed = CameraSystem.parseOllamaResponse(responseText);
      }

      if (parsed?.alarm) {
        this.showBroadcastAiAnalyzeCard(popupEl, {
          alarm: true,
          text: parsed.tasvir || responseText,
          confidence: parsed.confidence
        });
      } else {
        this.showBroadcastAiAnalyzeCard(popupEl, {
          success: true,
          text: parsed?.tasvir || responseText,
          confidence: parsed?.confidence
        });
      }
    } catch (error) {
      Logger.error('[LiveBroadcast] AI Analyze error:', error);
      this.showBroadcastAiAnalyzeCard(popupEl, { error: true, message: error.message });
    } finally {
      this._broadcastAiAnalyzeProcessing = false;
    }
  },

  showBroadcastAiAnalyzeCard(popupEl, options) {
    const { loading, success, alarm, error, text, message, confidence } = options;

    const popupContent = popupEl?.querySelector('.broadcast-popup-content');
    if (!popupContent) return;

    const existing = popupContent.querySelector('.ai-analyze-card');
    if (existing) existing.remove();

    const card = document.createElement('div');
    card.className = 'ai-analyze-card';

    if (loading) {
      card.innerHTML = `
        <div class="aac-header"><span class="aac-title">AI</span><span>Analiz</span></div>
        <div class="aac-body aac-loading"><div class="asc-spinner"></div><span>AI analiz ediliyor...</span></div>
      `;
    } else if (error) {
      card.innerHTML = `
        <div class="aac-header aac-error-header"><span class="aac-title">AI</span><span>Hata</span></div>
        <div class="aac-body"><p class="aac-error-text">${escapeHtml(message || 'Analiz tamamlanamadi')}</p></div>
      `;
    } else if (alarm) {
      card.innerHTML = `
        <div class="aac-header aac-alarm-header"><span class="aac-title">AI</span><span class="aac-badge aac-badge-alarm">ALARM${confidence ? ` (${confidence}%)` : ''}</span></div>
        <div class="aac-body"><p class="aac-response aac-alarm-text"></p></div>
      `;
    } else {
      card.innerHTML = `
        <div class="aac-header"><span class="aac-title">AI</span><span class="aac-badge aac-badge-ok">OK${confidence ? ` (${confidence}%)` : ''}</span></div>
        <div class="aac-body"><p class="aac-response"></p></div>
      `;
    }

    popupContent.appendChild(card);

    // Typewriter effect — same as WHEP typewriteAiResponse
    if ((success || alarm) && text) {
      const responseEl = card.querySelector('.aac-response');
      if (responseEl) {
        this.typewriteBroadcastAiResponse(responseEl, escapeHtml(text));
      }
    }
  },

  typewriteBroadcastAiResponse(element, text) {
    if (this._broadcastAiTypewriteTimer) {
      clearInterval(this._broadcastAiTypewriteTimer);
      this._broadcastAiTypewriteTimer = null;
    }

    let charIndex = 0;
    const cursor = document.createElement('span');
    cursor.className = 'aac-cursor';
    element.textContent = '';
    element.appendChild(cursor);

    this._broadcastAiTypewriteTimer = setInterval(() => {
      if (charIndex >= text.length || !element.isConnected) {
        clearInterval(this._broadcastAiTypewriteTimer);
        this._broadcastAiTypewriteTimer = null;
        cursor.remove();
        return;
      }
      cursor.before(text[charIndex]);
      charIndex++;
    }, 20);
  },

  dismissBroadcastAiAnalyzeCard(popupEl) {
    if (popupEl) {
      const card = popupEl.querySelector('.ai-analyze-card');
      if (card) card.remove();
    }
  },
};

export { AiAnalyzeMixin };
