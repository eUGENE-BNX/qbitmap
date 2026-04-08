import { QBitmapConfig } from '../config.js';
import { Logger } from '../utils.js';
import { CameraSystem } from '../camera-system/index.js';

const AiSearchMixin = {
  toggleBroadcastAiSearch(popupEl) {
    if (this._aiSearchMode) {
      this.exitBroadcastAiSearch(popupEl);
    } else {
      this.enterBroadcastAiSearch(popupEl);
    }
  },

  enterBroadcastAiSearch(popupEl) {
    const aiBtn = popupEl.querySelector('.broadcast-ai-btn');
    const frameContainer = popupEl.querySelector('.camera-frame-container');
    const videoEl = popupEl.querySelector('.camera-video');
    if (!aiBtn || !frameContainer || !videoEl) return;

    this._aiSearchMode = true;
    aiBtn.classList.add('active');
    frameContainer.classList.add('ai-search-mode');
    frameContainer.style.cursor = 'crosshair';

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'ai-search-overlay';
    overlay.innerHTML = '<div class="ai-search-rect"></div>';
    frameContainer.appendChild(overlay);

    // Mouse handlers (mousemove rAF-coalesced to one DOM update per frame)
    this._aiSearchMouseDown = (e) => this.handleBroadcastAiMouseDown(popupEl, e);
    let aiMoveRaf = 0;
    let aiLastMoveEvt = null;
    this._aiSearchMouseMove = (e) => {
      aiLastMoveEvt = e;
      if (aiMoveRaf) return;
      aiMoveRaf = requestAnimationFrame(() => {
        aiMoveRaf = 0;
        if (aiLastMoveEvt) this.handleBroadcastAiMouseMove(popupEl, aiLastMoveEvt);
      });
    };
    this._aiSearchMouseUp = (e) => {
      if (aiMoveRaf) { cancelAnimationFrame(aiMoveRaf); aiMoveRaf = 0; }
      this.handleBroadcastAiMouseUp(popupEl, e);
    };

    videoEl.addEventListener('mousedown', this._aiSearchMouseDown);
    document.addEventListener('mousemove', this._aiSearchMouseMove);
    document.addEventListener('mouseup', this._aiSearchMouseUp);

    // Touch handlers for mobile
    this._aiSearchTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const t = e.touches[0];
      this.handleBroadcastAiMouseDown(popupEl, { clientX: t.clientX, clientY: t.clientY, preventDefault() {}, stopPropagation() {} });
    };
    this._aiSearchTouchMove = (e) => {
      if (!this._aiSearchSelection?.isDrawing) return;
      e.preventDefault();
      const t = e.touches[0];
      this.handleBroadcastAiMouseMove(popupEl, { clientX: t.clientX, clientY: t.clientY });
    };
    this._aiSearchTouchEnd = (e) => {
      this.handleBroadcastAiMouseUp(popupEl, e);
    };

    videoEl.addEventListener('touchstart', this._aiSearchTouchStart, { passive: false });
    document.addEventListener('touchmove', this._aiSearchTouchMove, { passive: false });
    document.addEventListener('touchend', this._aiSearchTouchEnd);
  },

  exitBroadcastAiSearch(popupEl) {
    this._aiSearchMode = false;
    this._aiSearchSelection = null;

    const aiBtn = popupEl.querySelector('.broadcast-ai-btn');
    const frameContainer = popupEl.querySelector('.camera-frame-container');
    const videoEl = popupEl.querySelector('.camera-video');

    if (aiBtn) aiBtn.classList.remove('active');
    if (frameContainer) {
      frameContainer.classList.remove('ai-search-mode');
      frameContainer.style.cursor = '';
    }

    // Remove overlay
    const overlay = popupEl.querySelector('.ai-search-overlay');
    if (overlay) overlay.remove();

    // Remove listeners
    if (videoEl && this._aiSearchMouseDown) {
      videoEl.removeEventListener('mousedown', this._aiSearchMouseDown);
    }
    if (this._aiSearchMouseMove) {
      document.removeEventListener('mousemove', this._aiSearchMouseMove);
    }
    if (this._aiSearchMouseUp) {
      document.removeEventListener('mouseup', this._aiSearchMouseUp);
    }
    // Remove touch listeners
    if (videoEl && this._aiSearchTouchStart) {
      videoEl.removeEventListener('touchstart', this._aiSearchTouchStart);
    }
    if (this._aiSearchTouchMove) {
      document.removeEventListener('touchmove', this._aiSearchTouchMove);
    }
    if (this._aiSearchTouchEnd) {
      document.removeEventListener('touchend', this._aiSearchTouchEnd);
    }

    this.dismissBroadcastAiCard();
  },

  handleBroadcastAiMouseDown(popupEl, e) {
    if (!this._aiSearchMode) return;
    e.preventDefault();
    e.stopPropagation();

    const videoEl = popupEl.querySelector('.camera-video');
    const rect = videoEl.getBoundingClientRect();

    this._aiSearchSelection = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      endX: e.clientX - rect.left,
      endY: e.clientY - rect.top,
      isDrawing: true,
      videoRect: rect
    };
    this.updateBroadcastAiRect(popupEl);
  },

  handleBroadcastAiMouseMove(popupEl, e) {
    if (!this._aiSearchSelection?.isDrawing) return;
    const { videoRect } = this._aiSearchSelection;
    this._aiSearchSelection.endX = Math.max(0, Math.min(videoRect.width, e.clientX - videoRect.left));
    this._aiSearchSelection.endY = Math.max(0, Math.min(videoRect.height, e.clientY - videoRect.top));
    this.updateBroadcastAiRect(popupEl);
  },

  handleBroadcastAiMouseUp(popupEl, e) {
    if (!this._aiSearchSelection?.isDrawing) return;
    this._aiSearchSelection.isDrawing = false;

    const { startX, startY, endX, endY } = this._aiSearchSelection;
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    if (width >= 50 && height >= 50) {
      this.processBroadcastAiSelection(popupEl);
    } else {
      const rectEl = popupEl.querySelector('.ai-search-rect');
      if (rectEl) rectEl.style.display = 'none';
    }
  },

  updateBroadcastAiRect(popupEl) {
    if (!this._aiSearchSelection) return;
    const rectEl = popupEl.querySelector('.ai-search-rect');
    if (!rectEl) return;

    const { startX, startY, endX, endY, videoRect } = this._aiSearchSelection;
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    rectEl.style.left = (left / videoRect.width * 100) + '%';
    rectEl.style.top = (top / videoRect.height * 100) + '%';
    rectEl.style.width = (width / videoRect.width * 100) + '%';
    rectEl.style.height = (height / videoRect.height * 100) + '%';
    rectEl.style.display = 'block';
  },

  async processBroadcastAiSelection(popupEl) {
    if (!this._aiSearchSelection) return;
    const videoEl = popupEl.querySelector('.camera-video');
    if (!videoEl) return;

    const { startX, startY, endX, endY, videoRect } = this._aiSearchSelection;
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    const scaleX = videoEl.videoWidth / videoRect.width;
    const scaleY = videoEl.videoHeight / videoRect.height;

    const canvas = document.createElement('canvas');
    canvas.width = width * scaleX;
    canvas.height = height * scaleY;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoEl, left * scaleX, top * scaleY, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);

    const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];

    this.showBroadcastAiCard({ loading: true }, popupEl);
    await this.sendBroadcastAiSearch(base64, popupEl);
  },

  async sendBroadcastAiSearch(base64, popupEl) {
    const aiSettings = CameraSystem?.aiSettings || {};
    const searchPrompt = aiSettings.searchPrompt || 'bu resimde ne görüyorsun maksimum birkaç cümle ile açıkla ve sadece emin olduklarını yaz';

    try {
      const response = await fetch(`${QBitmapConfig.api.ai}/analyze`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: aiSettings.model || 'qwen3-vl:32b-instruct',
          prompt: searchPrompt,
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

      this.showBroadcastAiCard({ loading: false, success: true, response: responseText }, popupEl);
    } catch (error) {
      Logger.error('[AISearch] API error:', error);
      this.showBroadcastAiCard({ loading: false, error: true, message: error.message }, popupEl);
    }
  },

  showBroadcastAiCard(options, popupEl) {
    const { loading, success, error, response, message } = options;
    this.dismissBroadcastAiCard();

    if (!popupEl) return;

    const card = document.createElement('div');
    card.id = 'broadcast-ai-card';
    card.className = 'ai-search-card';

    const escText = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

    if (loading) {
      card.innerHTML = `
        <div class="asc-header"><span class="asc-title">AI</span><span>Analiz</span></div>
        <div class="asc-body asc-loading"><div class="asc-spinner"></div><span>Analiz ediliyor...</span></div>
      `;
    } else if (error) {
      card.innerHTML = `
        <div class="asc-header asc-error-header"><span class="asc-title">AI</span><span>Hata</span><button class="asc-close">&times;</button></div>
        <div class="asc-body"><p class="asc-error-text">${escText(message || 'Analiz tamamlanamadı')}</p></div>
      `;
    } else {
      card.innerHTML = `
        <div class="asc-header"><span class="asc-title">AI</span><span>Analiz</span><button class="asc-close">&times;</button></div>
        <div class="asc-body"><p class="asc-response">${escText(response || '')}</p></div>
      `;
    }

    document.body.appendChild(card);

    // Position card
    card.style.position = 'fixed';
    if (window.innerWidth < 700) {
      card.style.left = '8px';
      card.style.right = '8px';
      card.style.bottom = '8px';
      card.style.top = 'auto';
      card.style.width = 'auto';
      card.style.maxWidth = 'none';
      card.style.maxHeight = '40vh';
      card.style.overflowY = 'auto';
    } else {
      const popupRect = popupEl.getBoundingClientRect();
      card.style.left = (popupRect.right + 10) + 'px';
      card.style.top = popupRect.top + 'px';

      requestAnimationFrame(() => {
        const cardRect = card.getBoundingClientRect();
        if (cardRect.right > window.innerWidth - 10) {
          card.style.left = (popupRect.left - cardRect.width - 10) + 'px';
        }
        if (cardRect.bottom > window.innerHeight - 10) {
          card.style.top = (window.innerHeight - cardRect.height - 10) + 'px';
        }
      });
    }

    const closeBtn = card.querySelector('.asc-close');
    if (closeBtn) closeBtn.onclick = () => this.dismissBroadcastAiCard();

    if (!loading) {
      if (this._aiSearchCardTimeout) clearTimeout(this._aiSearchCardTimeout);
      this._aiSearchCardTimeout = setTimeout(() => this.dismissBroadcastAiCard(), 20000);
    }
  },

  dismissBroadcastAiCard() {
    const card = document.getElementById('broadcast-ai-card');
    if (card) card.remove();
    if (this._aiSearchCardTimeout) {
      clearTimeout(this._aiSearchCardTimeout);
      this._aiSearchCardTimeout = null;
    }
    const rectEl = document.querySelector('.broadcast-popup-content .ai-search-rect');
    if (rectEl) rectEl.style.display = 'none';
  },
};

export { AiSearchMixin };
