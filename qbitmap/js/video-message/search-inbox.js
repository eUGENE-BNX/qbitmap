import { QBitmapConfig } from "../config.js";
import { Logger, escapeHtml } from "../utils.js";
import { AuthSystem } from "../auth.js";
import { Analytics } from "../analytics.js";

const SearchInboxMixin = {
  async fetchUnreadCount() {
    if (!AuthSystem.isLoggedIn()) return;
    try {
      const response = await fetch(`${this.apiBase}/unread-count`, { credentials: 'include' });
      if (!response.ok) return;
      const data = await response.json();
      this.updateBadgeCount(data.count);
    } catch {}
  },

  updateBadgeCount(count) {
    this.unreadCount = count;
    const badge = document.getElementById('video-msg-badge');
    if (badge) {
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
  },

  // ==================== INBOX ====================

  async openInbox() {
    if (!AuthSystem.isLoggedIn()) return;

    // Remove existing
    const existing = document.getElementById('vmsg-inbox-overlay');
    if (existing) existing.remove();
    const existingInbox = document.getElementById('vmsg-inbox');
    if (existingInbox) existingInbox.remove();

    // Fetch private messages for current user
    let messages = [];
    try {
      const response = await fetch(`${this.apiBase}?limit=50`, { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        const userId = AuthSystem.getCurrentUser()?.id;
        messages = (data.messages || []).filter(m => m.recipient_id === userId);
      }
    } catch {}

    const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'video-msg-inbox-overlay';
    overlay.id = 'vmsg-inbox-overlay';
    overlay.onclick = () => this.closeInbox();
    document.body.appendChild(overlay);

    // Create inbox
    const inbox = document.createElement('div');
    inbox.className = 'video-msg-inbox';
    inbox.id = 'vmsg-inbox';

    inbox.innerHTML = `
      <div class="video-msg-inbox-header">
        <span class="video-msg-inbox-title">Video Mesajlar</span>
        <button class="video-msg-inbox-close" id="vmsg-inbox-close">&times;</button>
      </div>
      <div class="video-msg-inbox-list" id="vmsg-inbox-list">
        ${messages.length === 0 ? '<div class="video-msg-inbox-empty">Henüz video mesajınız yok</div>' :
          messages.map(m => `
            <div class="video-msg-inbox-item ${m.is_read ? '' : 'unread'}" data-message-id="${esc(m.message_id)}" data-lng="${m.lng}" data-lat="${m.lat}">
              <img src="${esc(m.sender_avatar || '')}" alt="" onerror="this.style.display='none'">
              <div class="video-msg-inbox-item-info">
                <div class="video-msg-inbox-item-name">${esc(m.sender_name || 'Kullanıcı')}</div>
                <div class="video-msg-inbox-item-time">${esc(this.formatTimeAgo(m.created_at))}</div>
              </div>
              ${!m.is_read ? '<div class="video-msg-inbox-item-unread-dot"></div>' : ''}
            </div>
          `).join('')}
      </div>
    `;

    document.body.appendChild(inbox);

    inbox.querySelector('#vmsg-inbox-close').onclick = () => this.closeInbox();

    // Click on message -> fly to location and open popup
    inbox.querySelectorAll('.video-msg-inbox-item').forEach(item => {
      item.onclick = () => {
        const msgId = item.dataset.messageId;
        const lng = parseFloat(item.dataset.lng);
        const lat = parseFloat(item.dataset.lat);

        this.closeInbox();

        if (window.map) {
          window.map.flyTo({ center: [lng, lat], zoom: Math.max(window.map.getZoom(), 16) });

          // Open popup after fly animation
          setTimeout(() => {
            const msg = this.videoMessages.get(msgId);
            if (msg) {
              this.openMessagePopup({
                messageId: msg.message_id,
                senderId: msg.sender_id,
                senderName: msg.sender_name,
                senderAvatar: msg.sender_avatar,
                recipientId: msg.recipient_id,
                durationMs: msg.duration_ms,
                mimeType: msg.mime_type,
                mediaType: msg.media_type || 'video',
                isRead: msg.is_read,
                createdAt: msg.created_at,
                viewCount: msg.view_count || 0,
                likeCount: msg.like_count || 0,
                liked: msg.liked ? 'true' : 'false',
                description: msg.description || '',
                aiDescription: msg.ai_description || '',
                tags: JSON.stringify(msg.tags || []),
                thumbnailPath: msg.thumbnail_path || ''
              }, [msg.lng, msg.lat]);
            }
          }, 1500);
        }
      };
    });
  },

  closeInbox() {
    const overlay = document.getElementById('vmsg-inbox-overlay');
    if (overlay) overlay.remove();
    const inbox = document.getElementById('vmsg-inbox');
    if (inbox) inbox.remove();
  },

  // ==================== WEBSOCKET HANDLERS ====================

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

      const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

      resultsEl.innerHTML = messages.map(m => {
        const tags = (m.tags || []).map(t => `<span class="vmsg-search-tag">${esc(t)}</span>`).join('');
        const thumbUrl = m.thumbnail_path
          ? `${this.apiBase}/${encodeURIComponent(m.message_id)}/thumbnail`
          : '';
        const timeAgo = this.formatTimeAgo(m.created_at);

        return `
          <div class="vmsg-search-result" data-msg-id="${esc(m.message_id)}"
               data-lng="${m.lng}" data-lat="${m.lat}">
            <div class="vmsg-search-thumb">
              ${thumbUrl
                ? `<img src="${thumbUrl}" alt="" loading="lazy" onerror="this.parentElement.classList.add('no-thumb')">`
                : '<div class="vmsg-search-thumb-placeholder"><svg width="20" height="16" viewBox="0 0 36 28"><rect x="1" y="2" width="24" height="24" rx="4" fill="#e67e22"/><polygon points="28,8 35,4 35,24 28,20" fill="#e67e22"/></svg></div>'}
            </div>
            <div class="vmsg-search-info">
              <div class="vmsg-search-sender">${esc(m.sender_name || 'Kullanıcı')} <span class="vmsg-search-time">${esc(timeAgo)}</span></div>
              ${m.description ? `<div class="vmsg-search-desc">${esc(m.description)}</div>` : ''}
              <div class="vmsg-search-tags">${tags}</div>
            </div>
          </div>
        `;
      }).join('');

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
          if (window.map) {
            window.map.flyTo({ center: [lng, lat], zoom: Math.max(window.map.getZoom(), 16) });

            // Open popup after fly animation
            setTimeout(() => {
              const msg = this.videoMessages.get(msgId);
              if (msg) {
                this.openMessagePopup({
                  messageId: msg.message_id,
                  senderId: msg.sender_id,
                  senderName: msg.sender_name,
                  senderAvatar: msg.sender_avatar,
                  recipientId: msg.recipient_id,
                  durationMs: msg.duration_ms,
                  mimeType: msg.mime_type,
                  mediaType: msg.media_type || 'video',
                  isRead: msg.is_read,
                  createdAt: msg.created_at,
                  viewCount: msg.view_count || 0,
                  likeCount: msg.like_count || 0,
                  liked: msg.liked ? 'true' : 'false',
                  description: msg.description || '',
                  aiDescription: msg.ai_description || '',
                  tags: JSON.stringify(msg.tags || []),
                  thumbnailPath: msg.thumbnail_path || ''
                }, [msg.lng, msg.lat]);
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
};

export { SearchInboxMixin };
