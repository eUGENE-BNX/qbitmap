import { QBitmapConfig } from "../config.js";
import { Logger, escapeHtml, sanitize } from "../utils.js";
import { AuthSystem } from "../auth.js";
import { Analytics } from "../analytics.js";
import * as AppState from '../state.js';

const PopupMixin = {
  openMessagePopup(props, coordinates) {
    const map = AppState.map;
    if (!map) return;

    Analytics.event('video_message_view', { media_type: props.mediaType || 'video' });
    this.closeMessagePopup();

    const messageId = String(props.messageId || '');
    const senderName = props.senderName || 'Kullanıcı';
    const senderAvatar = props.senderAvatar || '';
    const recipientId = props.recipientId ? parseInt(props.recipientId) : null;
    const createdAt = props.createdAt;
    const isRead = parseInt(props.isRead) || 0;

    const timeAgo = this.formatTimeAgo(createdAt);
    const isOwn = AuthSystem.isLoggedIn() && AuthSystem.getCurrentUser()?.id === parseInt(props.senderId);
    const isPrivateMsg = recipientId !== null;

    const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

    const videoUrl = `${this.apiBase}/${encodeURIComponent(messageId)}/video`;

    const viewCount = parseInt(props.viewCount) || 0;
    const likeCount = parseInt(props.likeCount) || 0;
    const liked = props.liked === 'true' || props.liked === true;
    const isLoggedIn = AuthSystem.isLoggedIn();
    const description = props.description || '';
    const aiDescription = props.aiDescription || '';
    const placeName = props.placeName || '';
    const tags = props.tags ? (typeof props.tags === 'string' ? JSON.parse(props.tags) : props.tags) : [];
    const mediaType = props.mediaType || (messageId.startsWith('pmsg_') ? 'photo' : 'video');
    const isPhoto = mediaType === 'photo';

    const mediaBodyHtml = isPhoto
      ? `<img class="vmsg-popup-photo" alt="Foto mesaj" data-photo-src="${videoUrl}">
         <button class="vmsg-photo-expand-btn" data-action="expand-photo" title="Büyük görüntüle">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
             <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
           </svg>
         </button>`
      : `<video controls playsinline preload="metadata" crossorigin="use-credentials">
            <source src="${videoUrl}" type="${esc(props.mimeType || 'video/mp4')}">
          </video>`;

    const html = `
      <div class="video-msg-popup" data-message-id="${esc(messageId)}">
        <div class="video-msg-popup-header">
          <img class="video-msg-popup-avatar" src="${esc(senderAvatar)}" alt="" onerror="this.style.display='none'">
          <div class="video-msg-popup-sender">
            <div class="video-msg-popup-name">
              ${esc(senderName)}
              ${isPrivateMsg ? '<span class="video-msg-popup-private">Özel</span>' : ''}
            </div>
            <div class="video-msg-popup-time">
              ${esc(timeAgo)}
              <span class="video-msg-view-count" data-view-count>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                <span data-view-count-num>${viewCount}</span>
              </span>
            </div>
          </div>
          ${isLoggedIn ? `
          <button class="video-msg-like-btn${liked ? ' liked' : ''}" data-action="toggle-like" title="Beğen">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            <span data-like-count-num>${likeCount}</span>
          </button>
          ` : (likeCount > 0 ? `
          <span class="video-msg-like-btn disabled" title="Beğeni">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            <span data-like-count-num>${likeCount}</span>
          </span>
          ` : '')}
          <button class="video-msg-popup-close" title="Kapat">&times;</button>
        </div>
        <div class="video-msg-popup-body">
          ${mediaBodyHtml}
        </div>
        ${description || aiDescription || placeName || tags.length > 0 || isOwn ? `
        <div class="video-msg-popup-meta">
          ${description ? `<div class="video-msg-popup-title">${esc(description)}</div>` : ''}
          ${placeName ? `<div class="video-msg-popup-place"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg> ${esc(placeName)}</div>` : ''}
          ${aiDescription ? `<div class="video-msg-popup-ai-description">${esc(aiDescription)}</div>` : ''}
          <div class="video-msg-popup-tags" data-tags-container>
            ${tags.map(t => `<span class="video-msg-popup-tag">${esc(t)}${isOwn ? '<button class="video-msg-tag-remove" data-tag="' + esc(t) + '">&times;</button>' : ''}</span>`).join('')}
            ${isOwn ? `<button class="video-msg-tag-add" data-action="add-tag" title="Etiket ekle">+</button>` : ''}
          </div>
        </div>
        ` : ''}
        <div data-comments-container></div>
        <div class="video-msg-popup-footer">
          ${isOwn ? `<button class="video-msg-popup-action delete" data-action="delete">Sil</button>` : ''}
          ${!isPrivateMsg ? `
          <div class="video-msg-share-buttons">
            <button class="video-msg-share-btn whatsapp" data-action="share-whatsapp" title="WhatsApp'ta Paylaş">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              <span>Paylaş</span>
            </button>
            <button class="video-msg-share-btn twitter" data-action="share-twitter" title="X'te Paylaş">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              <span>Paylaş</span>
            </button>
          </div>
          ` : ''}
        </div>
      </div>
    `;

    // Pan map so popup (which opens above the marker) is fully visible
    // Offset pushes the marker to the lower third of the screen
    const offsetY = Math.round(map.getContainer().clientHeight * 0.3);
    map.easeTo({ center: coordinates, offset: [0, offsetY], duration: 300 });

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: 'none',
      anchor: 'bottom',
      className: 'camera-popup'
    })
    .setLngLat(coordinates)
    .setHTML(html)
    .addTo(map);

    this.currentPopup = popup;

    // Wire up after DOM insertion
    setTimeout(() => {
      const popupEl = popup.getElement();
      if (!popupEl) return;

      // Close button
      const closeBtn = popupEl.querySelector('.video-msg-popup-close');
      if (closeBtn) closeBtn.onclick = () => this.closeMessagePopup();

      // Delete button
      const deleteBtn = popupEl.querySelector('[data-action="delete"]');
      if (deleteBtn) deleteBtn.onclick = () => this.deleteMessage(messageId);

      // Mark as read if private and unread
      if (isPrivateMsg && !isRead && !isOwn && AuthSystem.isLoggedIn()) {
        this.markAsRead(messageId);
      }

      // Set media credentials
      if (isPhoto) {
        const imgEl = popupEl.querySelector('.vmsg-popup-photo');
        if (imgEl) {
          this.loadPhotoWithCredentials(imgEl, videoUrl);

          // Click on photo or expand button → open fullscreen overlay
          const expandBtn = popupEl.querySelector('[data-action="expand-photo"]');
          const openOverlay = () => {
            if (imgEl.src && imgEl.src.startsWith('blob:')) {
              this.openPhotoOverlay(imgEl.src);
            }
          };
          imgEl.style.cursor = 'pointer';
          imgEl.onclick = openOverlay;
          if (expandBtn) expandBtn.onclick = openOverlay;
        }
      } else {
        const videoEl = popupEl.querySelector('video');
        if (videoEl) {
          this.loadVideoWithCredentials(videoEl, videoUrl);
        }
      }

      // Increment view count (once per session per message)
      if (!this.viewedMessages.has(messageId)) {
        this.viewedMessages.add(messageId);
        this.incrementViewCount(messageId, popupEl);
      }

      // Like button
      const likeBtn = popupEl.querySelector('[data-action="toggle-like"]');
      if (likeBtn) likeBtn.onclick = () => this.toggleLike(messageId, likeBtn);

      // Share buttons
      const whatsappBtn = popupEl.querySelector('[data-action="share-whatsapp"]');
      if (whatsappBtn) whatsappBtn.onclick = () => this.shareOnWhatsApp(messageId);

      const twitterBtn = popupEl.querySelector('[data-action="share-twitter"]');
      if (twitterBtn) twitterBtn.onclick = () => this.shareOnTwitter(messageId);

      // Tag add/remove handlers
      const addTagBtn = popupEl.querySelector('[data-action="add-tag"]');
      if (addTagBtn) {
        addTagBtn.onclick = () => {
          const container = popupEl.querySelector('[data-tags-container]');
          if (container.querySelector('.video-msg-tag-input')) return;
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'video-msg-tag-input';
          input.style.cssText = 'color:#222!important;background:#fff!important;-webkit-text-fill-color:#222;';
          input.placeholder = 'Etiket...';
          input.maxLength = 30;
          container.insertBefore(input, addTagBtn);
          input.focus();
          const commit = () => {
            const val = input.value.trim();
            if (val) this.updateMessageTags(messageId, popupEl, val, 'add');
            input.remove();
          };
          input.onkeydown = (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') input.remove(); };
          input.onblur = commit;
        };
      }
      popupEl.querySelectorAll('.video-msg-tag-remove').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          this.updateMessageTags(messageId, popupEl, btn.dataset.tag, 'remove');
        };
      });

      // Render comments
      const commentsContainer = popupEl.querySelector('[data-comments-container]');
      if (commentsContainer && typeof CommentWidget !== 'undefined') {
        CommentWidget.render(commentsContainer, 'video_message', messageId);
      }
    }, 0);
  },

  async loadVideoWithCredentials(videoEl, url) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) return;
      const blob = await response.blob();
      videoEl.src = URL.createObjectURL(blob);
    } catch (e) {
      Logger.warn('[VideoMessage] Video load failed:', e);
    }
  },

  async loadPhotoWithCredentials(imgEl, url) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) return;
      const blob = await response.blob();
      imgEl.src = URL.createObjectURL(blob);
    } catch (e) {
      Logger.warn('[VideoMessage] Photo load failed:', e);
    }
  },

  openPhotoOverlay(blobUrl) {
    // Remove existing overlay if any
    document.querySelector('.vmsg-photo-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'vmsg-photo-overlay';
    overlay.innerHTML = `
      <div class="vmsg-photo-overlay-toolbar">
        <button class="vmsg-photo-overlay-btn" data-action="zoom-in" title="Yakınlaştır">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button class="vmsg-photo-overlay-btn" data-action="zoom-out" title="Uzaklaştır">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button class="vmsg-photo-overlay-btn" data-action="zoom-reset" title="Sıfırla">1:1</button>
        <button class="vmsg-photo-overlay-btn close" data-action="close-overlay" title="Kapat">&times;</button>
      </div>
      <div class="vmsg-photo-overlay-container">
        <img src="${blobUrl}" alt="Foto mesaj" draggable="false">
      </div>
    `;
    document.body.appendChild(overlay);

    const img = overlay.querySelector('img');
    const container = overlay.querySelector('.vmsg-photo-overlay-container');
    let scale = 1;
    let panX = 0, panY = 0;
    let isPanning = false, startX = 0, startY = 0;

    const applyTransform = () => {
      img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    };

    // Zoom buttons
    overlay.querySelector('[data-action="zoom-in"]').onclick = () => {
      scale = Math.min(scale * 1.3, 8);
      applyTransform();
    };
    overlay.querySelector('[data-action="zoom-out"]').onclick = () => {
      scale = Math.max(scale / 1.3, 0.5);
      if (scale <= 1) { panX = 0; panY = 0; }
      applyTransform();
    };
    overlay.querySelector('[data-action="zoom-reset"]').onclick = () => {
      scale = 1; panX = 0; panY = 0;
      applyTransform();
    };

    // Close
    const closeOverlay = () => overlay.remove();
    overlay.querySelector('[data-action="close-overlay"]').onclick = closeOverlay;
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay(); });

    // Click on backdrop to close (but not on image)
    overlay.onclick = (e) => { if (e.target === overlay || e.target === container) closeOverlay(); };

    // Mouse wheel zoom
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      scale = Math.min(Math.max(scale * delta, 0.5), 8);
      if (scale <= 1) { panX = 0; panY = 0; }
      applyTransform();
    }, { passive: false });

    // Pan with mouse drag
    img.addEventListener('mousedown', (e) => {
      if (scale <= 1) return;
      isPanning = true;
      startX = e.clientX - panX;
      startY = e.clientY - panY;
      img.style.cursor = 'grabbing';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function handler(e) {
      if (!isPanning) return;
      panX = e.clientX - startX;
      panY = e.clientY - startY;
      applyTransform();
    });
    document.addEventListener('mouseup', function handler() {
      isPanning = false;
      if (img.parentNode) img.style.cursor = scale > 1 ? 'grab' : 'pointer';
    });

    // Touch pinch zoom & pan
    let lastTouchDist = 0;
    let lastTouchX = 0, lastTouchY = 0;
    container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        lastTouchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      } else if (e.touches.length === 1 && scale > 1) {
        isPanning = true;
        lastTouchX = e.touches[0].clientX - panX;
        lastTouchY = e.touches[0].clientY - panY;
      }
    }, { passive: true });
    container.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (lastTouchDist > 0) {
          scale = Math.min(Math.max(scale * (dist / lastTouchDist), 0.5), 8);
          if (scale <= 1) { panX = 0; panY = 0; }
          applyTransform();
        }
        lastTouchDist = dist;
      } else if (e.touches.length === 1 && isPanning) {
        e.preventDefault();
        panX = e.touches[0].clientX - lastTouchX;
        panY = e.touches[0].clientY - lastTouchY;
        applyTransform();
      }
    }, { passive: false });
    let lastTapTime = 0;
    container.addEventListener('touchend', (e) => {
      isPanning = false;
      lastTouchDist = 0;
      // Double-tap to zoom
      if (e.touches.length === 0) {
        const now = Date.now();
        if (now - lastTapTime < 300) {
          e.preventDefault();
          if (scale > 1) { scale = 1; panX = 0; panY = 0; } else { scale = 2.5; }
          applyTransform();
        }
        lastTapTime = now;
      }
    }, { passive: false });

    // Focus for keyboard events
    overlay.tabIndex = -1;
    overlay.focus();
  },

  async incrementViewCount(messageId, popupEl) {
    try {
      await fetch(`${QBitmapConfig.api.base}/api/views/video_message/${encodeURIComponent(messageId)}`, {
        method: 'POST',
        credentials: 'include'
      });
      // Update displayed count
      const countEl = popupEl?.querySelector('[data-view-count-num]');
      if (countEl) {
        countEl.textContent = parseInt(countEl.textContent || '0') + 1;
      }
      // Update local cache so next popup open shows correct count
      const cached = this.videoMessages.get(messageId);
      if (cached) {
        cached.view_count = (cached.view_count || 0) + 1;
      }
    } catch (e) {
      // Silently ignore - view count is non-critical
    }
  },

  async toggleLike(messageId, btnEl) {
    if (!AuthSystem.isLoggedIn()) return;

    // Optimistic UI update
    const isLiked = btnEl.classList.contains('liked');
    const countEl = btnEl.querySelector('[data-like-count-num]');
    const svgEl = btnEl.querySelector('svg');
    const currentCount = parseInt(countEl?.textContent || '0');

    btnEl.classList.toggle('liked');
    if (svgEl) svgEl.setAttribute('fill', isLiked ? 'none' : 'currentColor');
    if (countEl) countEl.textContent = isLiked ? Math.max(currentCount - 1, 0) : currentCount + 1;

    try {
      const res = await fetch(`${QBitmapConfig.api.base}/api/likes/video_message/${encodeURIComponent(messageId)}`, {
        method: 'POST',
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        // Reconcile with server state
        if (countEl) countEl.textContent = data.likeCount;
        if (data.liked) {
          btnEl.classList.add('liked');
          if (svgEl) svgEl.setAttribute('fill', 'currentColor');
        } else {
          btnEl.classList.remove('liked');
          if (svgEl) svgEl.setAttribute('fill', 'none');
        }
        // Update local cache
        const cached = this.videoMessages.get(messageId);
        if (cached) {
          cached.like_count = data.likeCount;
          cached.liked = data.liked;
        }
      }
    } catch (e) {
      // Revert on error
      if (isLiked) {
        btnEl.classList.add('liked');
        if (svgEl) svgEl.setAttribute('fill', 'currentColor');
      } else {
        btnEl.classList.remove('liked');
        if (svgEl) svgEl.setAttribute('fill', 'none');
      }
      if (countEl) countEl.textContent = currentCount;
    }
  },

  shareOnWhatsApp(messageId) {
    const url = `https://qbitmap.com/?vmsg=${encodeURIComponent(messageId)}`;
    const text = encodeURIComponent(`Bu video mesaji izle!\n${url}`);
    window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
  },

  shareOnTwitter(messageId) {
    const url = encodeURIComponent(`https://qbitmap.com/?vmsg=${encodeURIComponent(messageId)}`);
    const text = encodeURIComponent('Bu video mesaji izle!');
    window.open(`https://twitter.com/intent/tweet?url=${url}&text=${text}`, '_blank');
  },

  closeMessagePopup() {
    if (typeof CommentWidget !== 'undefined') CommentWidget.destroy();
    if (this.currentPopup) {
      this.currentPopup.remove();
      this.currentPopup = null;
    }
  },

  // ==================== MESSAGE ACTIONS ====================

  async markAsRead(messageId) {
    try {
      await fetch(`${this.apiBase}/${encodeURIComponent(messageId)}/read`, {
        method: 'POST',
        credentials: 'include'
      });
      // Update local state
      const msg = this.videoMessages.get(messageId);
      if (msg) msg.is_read = 1;
    } catch (e) {
      Logger.warn('[VideoMessage] Mark read failed');
    }
  },

  async deleteMessage(messageId) {
    try {
      const response = await fetch(`${this.apiBase}/${encodeURIComponent(messageId)}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Delete failed');
      }

      this.videoMessages.delete(messageId);
      this.updateMapLayer();
      this.closeMessagePopup();
      AuthSystem.showNotification('Mesaj silindi', 'success');
    } catch (error) {
      AuthSystem.showNotification(error.message || 'Silme başarısız', 'error');
    }
  },

  async updateMessageTags(messageId, popupEl, tagValue, action) {
    try {
      const msg = this.videoMessages.get(messageId);
      let currentTags = msg?.tags ? (typeof msg.tags === 'string' ? JSON.parse(msg.tags) : [...msg.tags]) : [];

      if (action === 'add' && !currentTags.includes(tagValue)) {
        currentTags.push(tagValue);
      } else if (action === 'remove') {
        currentTags = currentTags.filter(t => t !== tagValue);
      }
      currentTags = currentTags.slice(0, 5);

      const response = await fetch(`${this.apiBase}/${encodeURIComponent(messageId)}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tags: currentTags })
      });
      if (!response.ok) throw new Error('Tag update failed');

      // Update local data
      if (msg) msg.tags = currentTags;

      // Re-render tags in popup
      const container = popupEl.querySelector('[data-tags-container]');
      if (container) {
        const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
        container.innerHTML = currentTags.map(t =>
          `<span class="video-msg-popup-tag">${esc(t)}<button class="video-msg-tag-remove" data-tag="${esc(t)}">&times;</button></span>`
        ).join('') + `<button class="video-msg-tag-add" data-action="add-tag" title="Etiket ekle">+</button>`;

        // Re-bind events
        container.querySelector('[data-action="add-tag"]').onclick = () => {
          if (container.querySelector('.video-msg-tag-input')) return;
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'video-msg-tag-input';
          input.style.cssText = 'color:#222!important;background:#fff!important;-webkit-text-fill-color:#222;';
          input.placeholder = 'Etiket...';
          input.maxLength = 30;
          container.insertBefore(input, container.querySelector('[data-action="add-tag"]'));
          input.focus();
          const commit = () => {
            const val = input.value.trim();
            if (val) this.updateMessageTags(messageId, popupEl, val, 'add');
            input.remove();
          };
          input.onkeydown = (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') input.remove(); };
          input.onblur = commit;
        };
        container.querySelectorAll('.video-msg-tag-remove').forEach(btn => {
          btn.onclick = (e) => {
            e.stopPropagation();
            this.updateMessageTags(messageId, popupEl, btn.dataset.tag, 'remove');
          };
        });
      }

      this.updateMapLayer();
    } catch (error) {
      AuthSystem.showNotification('Etiket güncellenemedi', 'error');
    }
  },
};

export { PopupMixin };
