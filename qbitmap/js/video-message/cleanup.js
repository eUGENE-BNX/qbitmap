import { Logger, escapeHtml, escapeHtmlAllowFormat } from "../utils.js";
import { Analytics } from "../analytics.js";
import * as AppState from '../state.js';
import { buildMessagePopupProps } from './props.js';

const CleanupMixin = {
  handleNewMessage(payload) {
    const msg = {
      message_id: payload.messageId,
      sender_id: payload.senderId,
      sender_name: payload.senderName,
      sender_avatar: payload.senderAvatar,
      recipient_id: payload.recipientId,
      lng: payload.lng,
      lat: payload.lat,
      duration_ms: payload.durationMs,
      mime_type: payload.mimeType,
      media_type: payload.mediaType || 'video',
      is_read: 0,
      created_at: payload.createdAt,
      view_count: 0,
      like_count: 0,
      liked: false,
      description: payload.description || '',
      ai_description: payload.aiDescription || '',
      tags: payload.tags || [],
      thumbnail_path: payload.thumbnailPath || '',
      photos: payload.photos || [],
      place_name: payload.placeName || ''
    };
    this.videoMessages.set(msg.message_id, msg);
    this.updateMapLayer();
  },

  handleDeletedMessage(payload) {
    this.videoMessages.delete(payload.messageId);
    this.updateMapLayer();
    // Close popup if it's showing this message
    if (this.currentPopup) {
      const el = this.currentPopup.getElement();
      if (el?.querySelector(`[data-message-id="${payload.messageId}"]`)) {
        this.closeMessagePopup();
      }
    }
  },

  handleTagsUpdated(payload) {
    const msg = this.videoMessages.get(payload.messageId);
    if (msg) msg.tags = payload.tags || [];
  },

  handleAiDescriptionReady(payload) {
    const { messageId, jobType, photoIdx, aiDescription, aiDescriptionLang } = payload || {};
    if (!messageId) return;

    const msg = this.videoMessages.get(messageId);

    // 1) In-memory cache update — per-photo for photos, parent for videos
    if (msg) {
      if (jobType === 'photo' && photoIdx != null && Array.isArray(msg.photos)) {
        const photo = msg.photos.find(p => p.idx === photoIdx);
        if (photo) {
          photo.ai_description = aiDescription;
          photo.ai_description_lang = aiDescriptionLang;
        }
        // Mirror primary to parent for FULLTEXT/legacy display paths
        if (photoIdx === 0) {
          msg.ai_description = aiDescription;
          msg.ai_description_lang = aiDescriptionLang;
        }
      } else {
        msg.ai_description = aiDescription;
        msg.ai_description_lang = aiDescriptionLang;
      }
      this.updateMapLayer();
    }

    // 2) Live popup update if it's open. Dispatch a custom event the popup
    //    listens for — popup decides whether the active photo matches and
    //    refreshes its own state Map accordingly.
    const popupRoot = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!popupRoot || !aiDescription) return;

    popupRoot.dispatchEvent(new CustomEvent('vmsg:ai-update', {
      detail: { photoIdx, jobType, aiDescription, aiDescriptionLang }
    }));
  },

  // ==================== HELPERS ====================

  formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    // Treat as UTC if no timezone suffix (server stores UTC without Z)
    const normalized = /Z|[+-]\d{2}:?\d{2}$/.test(dateStr) ? dateStr : dateStr + 'Z';
    const date = new Date(normalized);
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'Az önce';
    if (diffMin < 60) return `${diffMin} dk önce`;
    if (diffHour < 24) return `${diffHour} saat önce`;
    return date.toLocaleDateString('tr-TR') + ' - ' + date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  },

  // ==================== SEARCH ====================

  initSearch() {
    const bar = document.getElementById('vmsg-search-toggle');
    const input = document.getElementById('vmsg-search-bar-input');
    if (!bar || !input) return;

    // Click icon to expand
    bar.addEventListener('click', (e) => {
      if (!bar.classList.contains('expanded')) {
        e.preventDefault();
        bar.classList.add('expanded');
        input.focus();
      }
    });

    // Search on input
    input.addEventListener('input', () => {
      clearTimeout(this._searchDebounce);
      const query = input.value.trim();
      if (query.length < 2) {
        this._closeSearchResults();
        return;
      }
      this._searchDebounce = setTimeout(() => {
        Analytics.event('search_use', { query_length: query.length });
        this._ensureSearchPanel();
        this.performTagSearch(query);
      }, 400);
    });

    // ESC to close
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        input.blur();
        this._collapseSearchBar();
      }
    });

    // Collapse when clicking outside
    document.addEventListener('click', (e) => {
      if (!bar.contains(e.target) && !document.getElementById('vmsg-search-panel')?.contains(e.target)) {
        if (bar.classList.contains('expanded') && !input.value.trim()) {
          this._collapseSearchBar();
        }
        this._closeSearchResults();
      }
    });
  },

  _collapseSearchBar() {
    const bar = document.getElementById('vmsg-search-toggle');
    const input = document.getElementById('vmsg-search-bar-input');
    if (bar) bar.classList.remove('expanded');
    if (input) { input.value = ''; input.blur(); }
    this._closeSearchResults();
  },

  _ensureSearchPanel() {
    if (document.getElementById('vmsg-search-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'vmsg-search-panel';
    panel.className = 'vmsg-search-panel';
    panel.innerHTML = `
      <div class="vmsg-search-results" id="vmsg-search-results">
        <div class="vmsg-search-empty">Aranıyor...</div>
      </div>
    `;
    document.body.appendChild(panel);
  },

  _closeSearchResults() {
    const panel = document.getElementById('vmsg-search-panel');
    if (panel) panel.remove();
    this._searchDebounce = null;
  },

  async performTagSearch(query) {
    const resultsEl = document.getElementById('vmsg-search-results');
    if (!resultsEl) return;

    if (query.length < 2) {
      resultsEl.innerHTML = '<div class="vmsg-search-empty">Etiket yazarak video mesaj arayın</div>';
      return;
    }

    resultsEl.innerHTML = '<div class="vmsg-search-empty">Aranıyor...</div>';

    try {
      const response = await fetch(
        `${this.apiBase}/search?q=${encodeURIComponent(query)}&limit=20`,
        { credentials: 'include' }
      );
      if (!response.ok) throw new Error('Search failed');
      const data = await response.json();
      const messages = data.messages || [];

      if (messages.length === 0) {
        resultsEl.innerHTML = '<div class="vmsg-search-empty">Sonuç bulunamadı</div>';
        return;
      }

      resultsEl.innerHTML = messages.map(m => {
        const tags = (m.tags || []).map(t => `<span class="vmsg-search-tag">${escapeHtml(t)}</span>`).join('');
        const thumbUrl = m.thumbnail_path
          ? `${this.apiBase}/${encodeURIComponent(m.message_id)}/thumbnail`
          : '';
        const timeAgo = this.formatTimeAgo(m.created_at);

        return `
          <div class="vmsg-search-result" data-msg-id="${escapeHtml(m.message_id)}"
               data-lng="${m.lng}" data-lat="${m.lat}">
            <div class="vmsg-search-thumb">
              ${thumbUrl
                ? `<img src="${thumbUrl}" alt="" loading="lazy">`
                : '<div class="vmsg-search-thumb-placeholder"><svg width="20" height="16" viewBox="0 0 36 28"><rect x="1" y="2" width="24" height="24" rx="4" fill="#e67e22"/><polygon points="28,8 35,4 35,24 28,20" fill="#e67e22"/></svg></div>'}
            </div>
            <div class="vmsg-search-info">
              <div class="vmsg-search-sender">${escapeHtml(m.sender_name || 'Kullanıcı')} <span class="vmsg-search-time">${escapeHtml(timeAgo)}</span></div>
              ${m.description ? `<div class="vmsg-search-desc">${escapeHtml(m.description)}</div>` : ''}
              <div class="vmsg-search-tags">${tags}</div>
            </div>
          </div>
        `;
      }).join('');

      // CSP: replace inline onerror on thumb images
      resultsEl.querySelectorAll('.vmsg-search-thumb img').forEach(img => {
        img.addEventListener('error', () => {
          if (img.parentElement) img.parentElement.classList.add('no-thumb');
        });
      });

      // Click handler for results
      resultsEl.querySelectorAll('.vmsg-search-result').forEach(el => {
        el.addEventListener('click', () => {
          const msgId = el.dataset.msgId;
          const lng = parseFloat(el.dataset.lng);
          const lat = parseFloat(el.dataset.lat);

          // Close search panel
          const panel = document.getElementById('vmsg-search-panel');
          if (panel) panel.remove();

          // Fly to location
          if (AppState.map) {
            AppState.map.flyTo({ center: [lng, lat], zoom: Math.max(AppState.map.getZoom(), 16) });

            // Open popup after fly animation
            setTimeout(() => {
              const msg = this.videoMessages.get(msgId);
              if (msg) {
                this.openMessagePopup(buildMessagePopupProps(msg), [msg.lng, msg.lat]);
              }
            }, 1500);
          }
        });
      });

    } catch (error) {
      Logger.warn('[VideoMessage] Search failed:', error);
      resultsEl.innerHTML = '<div class="vmsg-search-empty">Arama başarısız</div>';
    }
  },

  // ==================== CLEANUP ====================

  cancelFlow() {
    this.cleanupAndClose();
  },

  cleanupAndClose() {
    // Stop recording if active
    if (this.isRecording) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
      this.isRecording = false;
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.onstop = null; // Prevent preview
        this.mediaRecorder.stop();
      }
    }

    // Stop camera stream and audio processing
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this._rawAudioTrack) {
      this._rawAudioTrack.stop();
      this._rawAudioTrack = null;
    }
    if (this._audioCtx) {
      this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
    }

    // Revoke object URL
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }

    // Revoke all captured photo object URLs
    if (Array.isArray(this._capturedPhotos)) {
      this._capturedPhotos.forEach(p => p?.objectUrl && URL.revokeObjectURL(p.objectUrl));
    }

    // Exit location selection
    if (this.isSelectingLocation) {
      this.exitLocationSelection();
    }

    // Close modal
    this.closeModal();

    // Reset state
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.recordedBlob = null;
    this.selectedLocation = null;
    this.selectedRecipient = null;
    this.isPrivate = false;
    this._durationMs = null;
    this._tags = [];
    this._nearbyPlaces = [];
    this._selectedPlace = null;
    this._cameras = [];
    this._selectedCameraId = null;

    // Reset photo/gallery state
    this.capturedPhotoBlob = null;
    this.isPhotoMode = false;
    this._isGalleryMode = false;
    this._photoZoomLevel = 1;
    this._photoResolution = 'high';
    this._flashEnabled = false;
    this._capturedWidth = 0;
    this._capturedHeight = 0;
    this._capturedPhotos = [];
    this._previewActiveIdx = 0;
  },

  closeModal() {
    if (this._orientationHandler) {
      window.removeEventListener('resize', this._orientationHandler);
      this._orientationHandler = null;
    }
    if (this._modalEl) {
      const modal = this._modalEl;
      modal.classList.add('closing');
      modal.addEventListener('animationend', () => modal.remove(), { once: true });
      this._modalEl = null;
    }
  }
};

export { CleanupMixin };
