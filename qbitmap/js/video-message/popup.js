import { QBitmapConfig } from "../config.js";
import { Logger, escapeHtml, escapeHtmlAllowFormat, sanitize } from "../utils.js";
import { AuthSystem } from "../auth.js";
import { Analytics } from "../analytics.js";
import { ReportSystem } from "../report.js";
import { CommentWidget } from "../comments.js";
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
    const isAdmin = AuthSystem.isLoggedIn() && AuthSystem.getCurrentUser()?.role === 'admin';
    const isPrivateMsg = recipientId !== null;

    const esc = escapeHtml;
    const escFmt = escapeHtmlAllowFormat;

    const videoUrl = `${this.apiBase}/${encodeURIComponent(messageId)}/video`;

    // Build photo list for carousel (BC: empty/legacy → fallback to single video URL)
    let photoList = [];
    try {
      const raw = props.photos;
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) photoList = parsed;
      }
    } catch { photoList = []; }
    if (photoList.length === 0) {
      photoList = [{ idx: 0, is_primary: 1 }];
    }
    const photoUrls = photoList.map((p) => {
      const i = Number(p.idx) || 0;
      return {
        idx: i,
        // idx=0 uses legacy /video endpoint (parent file_path mirror) for BC;
        // higher indices use the new per-photo endpoint
        url: i === 0
          ? videoUrl
          : `${this.apiBase}/${encodeURIComponent(messageId)}/photos/${i}`,
        originalUrl: i === 0
          ? `${this.apiBase}/${encodeURIComponent(messageId)}/original`
          : `${this.apiBase}/${encodeURIComponent(messageId)}/photos/${i}/original`
      };
    });
    const photoCount = photoUrls.length;

    const viewCount = parseInt(props.viewCount) || 0;
    const likeCount = parseInt(props.likeCount) || 0;
    const liked = props.liked === 'true' || props.liked === true;
    const isLoggedIn = AuthSystem.isLoggedIn();
    const description = props.description || '';
    // For multi-photo messages, AI description comes from the active photo
    // (initial = idx=0). Falls back to legacy parent ai_description for BC.
    const aiDescription = (photoList[0]?.ai_description) || props.aiDescription || '';
    const aiDescriptionLang = ((photoList[0]?.ai_description_lang) || props.aiDescriptionLang || 'tr').toLowerCase();
    const SUPPORTED_LANGS = [
      { code: 'en', label: 'English' },
      { code: 'de', label: 'Deutsch' },
      { code: 'fr', label: 'Français' },
      { code: 'tr', label: 'Türkçe' },
      { code: 'es', label: 'Español' },
      { code: 'zh', label: '中文' },
      { code: 'ru', label: 'Русский' },
      { code: 'ar', label: 'العربية' },
    ];
    const placeName = props.placeName || '';
    const tags = props.tags ? (typeof props.tags === 'string' ? JSON.parse(props.tags) : props.tags) : [];
    const mediaType = props.mediaType || (messageId.startsWith('pmsg_') ? 'photo' : 'video');
    const isPhoto = mediaType === 'photo';

    const shimmerHtml = `<div class="vmsg-media-shimmer"><div class="vmsg-shimmer-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>`;

    const mediaBodyHtml = isPhoto
      ? `<div class="vmsg-popup-carousel" data-active-idx="0" data-total="${photoCount}">
           ${shimmerHtml}
           <img class="vmsg-popup-photo" alt="Foto mesaj" data-photo-idx="0">
           <div class="vmsg-popup-counter"><span data-curr>1</span>/${photoCount}</div>
           <button class="vmsg-popup-arrow vmsg-popup-prev" aria-label="Önceki" ${photoCount <= 1 ? 'disabled' : ''}>
             <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
           </button>
           <button class="vmsg-popup-arrow vmsg-popup-next" aria-label="Sonraki" ${photoCount <= 1 ? 'disabled' : ''}>
             <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
           </button>
           <div class="vmsg-popup-dots">
             ${photoUrls.map((_, i) => `<span class="vmsg-popup-dot${i === 0 ? ' active' : ''}" data-idx="${i}"></span>`).join('')}
           </div>
           <button class="vmsg-photo-expand-btn" data-action="expand-photo" title="Büyük görüntüle">
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
               <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
               <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
             </svg>
           </button>
         </div>`
      : `<video controls playsinline preload="none" poster="${this.apiBase}/${encodeURIComponent(messageId)}/thumbnail?size=preview">
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
          ${isLoggedIn && !isOwn ? ReportSystem.getMsgBtnHtml() : ''}
          <button class="video-msg-popup-close" title="Kapat">&times;</button>
        </div>
        <div class="video-msg-popup-body">
          ${mediaBodyHtml}
        </div>
        ${description || aiDescription || placeName || tags.length > 0 || isOwn || isPhoto ? `
        <div class="video-msg-popup-meta">
          ${(description || aiDescription || isPhoto) ? `<div class="video-msg-popup-title-row">${description ? `<div class="video-msg-popup-title">${esc(description)}</div>` : '<div class="video-msg-popup-title-spacer"></div>'}${(aiDescription || isPhoto) ? `<div class="video-msg-ai-lang-wrap"><button type="button" class="video-msg-ai-lang-btn" data-ai-lang-btn title="Dil seç" aria-label="Dil seç"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></button><div class="video-msg-ai-lang-menu" data-ai-lang-menu hidden>${SUPPORTED_LANGS.map(l => `<button type="button" class="video-msg-ai-lang-item${l.code === aiDescriptionLang ? ' active' : ''}" data-lang="${l.code}">${l.label}</button>`).join('')}</div></div>` : ''}</div>` : ''}
          ${(aiDescription || isPhoto) ? `<div class="video-msg-ai-wrap"><div class="video-msg-popup-ai-description" data-ai-desc>${aiDescription ? escFmt(aiDescription) : '<em class="vmsg-ai-pending">Açıklama hazırlanıyor…</em>'}</div><div class="video-msg-ai-fade" data-ai-fade><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></div>${isAdmin ? `<button class="video-msg-ai-edit-btn" data-action="edit-ai-desc" title="AI açıklamayı düzenle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>` : ''}</div>` : ''}
          ${placeName ? `<div class="video-msg-popup-place"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg> ${esc(placeName)}</div>` : ''}
          <div class="video-msg-popup-tags" data-tags-container>
            ${tags.map(t => `<span class="video-msg-popup-tag">${esc(t)}${isOwn ? '<button class="video-msg-tag-remove" data-tag="' + esc(t) + '">&times;</button>' : ''}</span>`).join('')}
            ${isOwn ? `<button class="video-msg-tag-add" data-action="add-tag" title="Etiket ekle">+</button>` : ''}
          </div>
        </div>
        ` : ''}
        <div data-comments-container></div>
        <div class="video-msg-popup-footer">
          ${isOwn ? `<button class="video-msg-popup-action delete" data-action="delete-message">Sil</button>` : ''}
          ${!isPrivateMsg ? `
          <div class="video-msg-share-buttons">
            <button class="video-msg-share-btn native" data-action="share-native" title="Paylaş" hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
              <span>Paylaş</span>
            </button>
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

    // [PWA] Signal "meaningful engagement" so the install prompt can fire.
    window.dispatchEvent(new CustomEvent('qbitmap:video-message-opened'));

    // Wire up after DOM insertion
    setTimeout(() => {
      const popupEl = popup.getElement();
      if (!popupEl) return;

      // Close button
      const closeBtn = popupEl.querySelector('.video-msg-popup-close');
      if (closeBtn) closeBtn.onclick = () => this.closeMessagePopup();

      // [PWA] Media Session — lock-screen / tray controls. Uses the
      // defer-until-playing pattern (see src/pwa/media-session.js
      // header) so Chrome Android's native <video> play path isn't
      // locked by a pre-play setActionHandler call.
      if (!isPhoto) {
        this._wireMediaSession(popupEl.querySelector('video'), {
          messageId, senderName, description,
        });
      }

      // Delete button
      const deleteBtn = popupEl.querySelector('[data-action="delete-message"]');
      if (deleteBtn) deleteBtn.onclick = () => this.deleteMessage(messageId);

      // Mark as read if private and unread
      if (isPrivateMsg && !isRead && !isOwn && AuthSystem.isLoggedIn()) {
        this.markAsRead(messageId);
      }

      // Per-photo AI state (popup-scoped). Shared by carousel switch + lang dropdown.
      // photoAiState: idx → { text, lang }   currently displayed text+lang per photo
      // langCache: `${idx}:${lang}` → text   client-side translation cache
      // currentActiveIdx: index of the photo whose AI text is currently in the DOM
      const photoAiState = new Map();
      const langCache = new Map();
      let currentActiveIdx = 0;
      photoList.forEach((p, i) => {
        if (p.ai_description) {
          const lng = (p.ai_description_lang || 'tr').toLowerCase();
          photoAiState.set(i, { text: p.ai_description, lang: lng });
          langCache.set(`${i}:${lng}`, p.ai_description);
        }
      });

      // AI description DOM refs (used by carousel switch + lang dropdown + admin edit)
      const aiDesc = popupEl.querySelector('[data-ai-desc]');
      const aiFade = popupEl.querySelector('[data-ai-fade]');
      const langMenu = popupEl.querySelector('[data-ai-lang-menu]');
      const langItems = langMenu ? langMenu.querySelectorAll('[data-lang]') : [];
      const checkScroll = () => {
        if (!aiDesc || !aiFade) return;
        const atBottom = aiDesc.scrollHeight - aiDesc.scrollTop - aiDesc.clientHeight < 4;
        aiFade.classList.toggle('hidden', atBottom || aiDesc.scrollHeight <= aiDesc.clientHeight);
      };
      const renderAiForActive = () => {
        if (!aiDesc) return;
        // Prefer popup-local Map (holds in-flight translations) over global cache.
        // Lazy seed from in-memory videoMessages cache so background AI completions
        // (that arrived after popup open) are picked up on next photo switch.
        let state = photoAiState.get(currentActiveIdx);
        if (!state) {
          const cachedMsg = this.videoMessages.get(messageId);
          const photo = cachedMsg?.photos?.find(p => p.idx === currentActiveIdx);
          if (photo?.ai_description) {
            state = { text: photo.ai_description, lang: (photo.ai_description_lang || 'tr').toLowerCase() };
            photoAiState.set(currentActiveIdx, state);
          }
        }
        if (state && state.text) {
          aiDesc.innerHTML = escFmt(state.text);
          if (langItems && langItems.length) {
            langItems.forEach(b => b.classList.toggle('active', b.dataset.lang === state.lang));
          }
        } else {
          aiDesc.innerHTML = '<em class="vmsg-ai-pending">Açıklama hazırlanıyor…</em>';
        }
        aiDesc.scrollTop = 0;
        checkScroll();
      };

      // Listen for AI-ready custom events dispatched by cleanup.handleAiDescriptionReady.
      // Eagerly persist text+lang from the event payload into photoAiState so the
      // user can navigate away and back without losing the description (race-proof
      // against any re-fetch of videoMessages cache).
      const aiReadyHandler = (e) => {
        const idx = e.detail?.photoIdx;
        const text = e.detail?.aiDescription;
        const lng = (e.detail?.aiDescriptionLang || 'tr').toLowerCase();
        if (idx != null && text) {
          photoAiState.set(idx, { text, lang: lng });
          langCache.set(`${idx}:${lng}`, text);
        }
        if (idx == null || idx === currentActiveIdx) {
          renderAiForActive();
        }
      };
      popupEl.addEventListener('vmsg:ai-update', aiReadyHandler);
      popup.on('close', () => popupEl.removeEventListener('vmsg:ai-update', aiReadyHandler));

      // Set media credentials
      if (isPhoto) {
        const imgEl = popupEl.querySelector('.vmsg-popup-photo');
        const carousel = popupEl.querySelector('.vmsg-popup-carousel');
        if (imgEl && carousel) {
          let activeIdx = 0;

          imgEl.onload = () => {
            if (imgEl.naturalHeight > imgEl.naturalWidth) {
              const body = imgEl.closest('.video-msg-popup-body');
              if (body && !body.classList.contains('vmsg-portrait-photo-wrap')) {
                body.classList.add('vmsg-portrait-photo-wrap');
              }
            }
            carousel.querySelector('.vmsg-media-shimmer')?.remove();
          };

          const prefetch = (idx) => {
            const entry = photoUrls[idx];
            if (entry) { const i = new Image(); i.src = entry.url; }
          };

          const setActive = (newIdx) => {
            if (photoCount === 0) return;
            activeIdx = ((newIdx % photoCount) + photoCount) % photoCount;
            currentActiveIdx = activeIdx;
            carousel.dataset.activeIdx = String(activeIdx);
            const counter = carousel.querySelector('[data-curr]');
            if (counter) counter.textContent = activeIdx + 1;
            carousel.querySelectorAll('.vmsg-popup-dot').forEach((d, i) => d.classList.toggle('active', i === activeIdx));
            renderAiForActive();
            const entry = photoUrls[activeIdx];
            if (entry) imgEl.src = entry.url;
            if (photoCount > 1) {
              prefetch((activeIdx + 1) % photoCount);
              prefetch((activeIdx - 1 + photoCount) % photoCount);
            }
          };

          // Initial load
          setActive(0);

          // Prev/next buttons (no-op when single)
          const prevBtn = carousel.querySelector('.vmsg-popup-prev');
          const nextBtn = carousel.querySelector('.vmsg-popup-next');
          if (prevBtn && photoCount > 1) prevBtn.onclick = () => setActive(activeIdx - 1);
          if (nextBtn && photoCount > 1) nextBtn.onclick = () => setActive(activeIdx + 1);

          // Dot clicks
          carousel.querySelectorAll('.vmsg-popup-dot').forEach(d => {
            d.onclick = () => setActive(parseInt(d.dataset.idx, 10));
          });

          // Touch swipe
          if (photoCount > 1) {
            let startX = 0, startY = 0, swiping = false;
            carousel.addEventListener('touchstart', (e) => {
              if (e.touches.length !== 1) return;
              startX = e.touches[0].clientX;
              startY = e.touches[0].clientY;
              swiping = true;
            }, { passive: true });
            carousel.addEventListener('touchend', (e) => {
              if (!swiping) return;
              swiping = false;
              const t = e.changedTouches[0];
              const dx = t.clientX - startX;
              const dy = t.clientY - startY;
              if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                setActive(activeIdx + (dx < 0 ? 1 : -1));
              }
            }, { passive: true });
          }

          // Keyboard (popup-scoped)
          const keyHandler = (e) => {
            if (photoCount <= 1) return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); setActive(activeIdx - 1); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); setActive(activeIdx + 1); }
          };
          document.addEventListener('keydown', keyHandler);

          // Cleanup on popup close
          popup.on('close', () => {
            document.removeEventListener('keydown', keyHandler);
          });

          // Expand → carousel-aware fullscreen overlay
          const expandBtn = popupEl.querySelector('[data-action="expand-photo"]');
          const openOverlay = () => {
            this.openPhotoOverlay(imgEl.src, photoUrls[activeIdx]?.originalUrl || null, {
              photos: photoUrls,
              startIdx: activeIdx
            });
          };
          imgEl.style.cursor = 'pointer';
          imgEl.onclick = openOverlay;
          if (expandBtn) expandBtn.onclick = openOverlay;
        }
      }

      // Increment view count (once per session per message)
      if (!this.viewedMessages.has(messageId)) {
        this.viewedMessages.add(messageId);
        this.incrementViewCount(messageId, popupEl);
      }

      // Report button
      const reportBtn = popupEl.querySelector('[data-action="report-content"]');
      if (reportBtn) reportBtn.onclick = () => ReportSystem.showReportDialog('video_message', messageId);

      // Like button
      const likeBtn = popupEl.querySelector('[data-action="toggle-like"]');
      if (likeBtn) likeBtn.onclick = () => this.toggleLike(messageId, likeBtn);

      // Share buttons
      const whatsappBtn = popupEl.querySelector('[data-action="share-whatsapp"]');
      if (whatsappBtn) whatsappBtn.onclick = () => this.shareOnWhatsApp(messageId);

      const twitterBtn = popupEl.querySelector('[data-action="share-twitter"]');
      if (twitterBtn) twitterBtn.onclick = () => this.shareOnTwitter(messageId);

      // Native share — only unhide when the browser supports navigator.share.
      // File-share (upgraded path) requires navigator.canShare; we detect
      // per-click so platforms that support URL-only share still get the
      // button.
      const nativeBtn = popupEl.querySelector('[data-action="share-native"]');
      if (nativeBtn && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        nativeBtn.hidden = false;
        nativeBtn.onclick = () => this.shareNative(messageId, nativeBtn, {
          senderName,
          isPhoto,
          videoUrl,
          photoUrls,
          mimeType: props.mimeType,
        });
      }

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

      // AI description scroll fade listener (uses checkScroll defined above)
      if (aiDesc && aiFade) {
        aiDesc.addEventListener('scroll', checkScroll);
        checkScroll();
      }

      // Admin: AI description edit (operates on the currently active photo's text)
      const editAiBtn = popupEl.querySelector('[data-action="edit-ai-desc"]');
      if (editAiBtn && aiDesc) {
        editAiBtn.onclick = () => {
          const wrap = aiDesc.closest('.video-msg-ai-wrap');
          if (wrap.querySelector('.video-msg-ai-edit-area')) return;
          const currentState = photoAiState.get(currentActiveIdx);
          const currentText = currentState?.text || '';
          const currentLang = currentState?.lang || aiDescriptionLang;
          aiDesc.style.display = 'none';
          if (aiFade) aiFade.style.display = 'none';
          editAiBtn.style.display = 'none';

          const editArea = document.createElement('div');
          editArea.className = 'video-msg-ai-edit-area';
          const textarea = document.createElement('textarea');
          textarea.className = 'video-msg-ai-edit-textarea';
          textarea.value = currentText;
          textarea.rows = 4;
          const btnRow = document.createElement('div');
          btnRow.className = 'video-msg-ai-edit-actions';
          btnRow.innerHTML = '<button class="video-msg-ai-edit-save">Kaydet</button><button class="video-msg-ai-edit-cancel">İptal</button>';
          editArea.appendChild(textarea);
          editArea.appendChild(btnRow);
          wrap.insertBefore(editArea, editAiBtn);
          textarea.focus();

          const cancel = () => {
            editArea.remove();
            aiDesc.style.display = '';
            if (aiFade) aiFade.style.display = '';
            editAiBtn.style.display = '';
          };

          btnRow.querySelector('.video-msg-ai-edit-cancel').onclick = cancel;
          btnRow.querySelector('.video-msg-ai-edit-save').onclick = async () => {
            const newText = textarea.value.trim();
            if (!newText) return;
            textarea.disabled = true;
            btnRow.querySelectorAll('button').forEach(b => b.disabled = true);
            try {
              const res = await fetch(`${QBitmapConfig.api.admin}/messages/${encodeURIComponent(messageId)}/ai-description`, {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: newText, lang: currentLang })
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              aiDesc.innerHTML = escFmt(newText);
              photoAiState.set(currentActiveIdx, { text: newText, lang: currentLang });
              langCache.set(`${currentActiveIdx}:${currentLang}`, newText);
              cancel();
              checkScroll();
            } catch (err) {
              Logger.warn('[VideoMessage] AI description edit failed:', err);
              AuthSystem.showNotification('Kaydetme başarısız', 'error');
              textarea.disabled = false;
              btnRow.querySelectorAll('button').forEach(b => b.disabled = false);
            }
          };

          textarea.onkeydown = (e) => {
            if (e.key === 'Escape') cancel();
          };
        };
      }

      // AI description language dropdown — operates on currently active photo
      const langBtn = popupEl.querySelector('[data-ai-lang-btn]');
      if (langBtn && langMenu && aiDesc) {
        // Monotonic request id: lets us ignore stale responses when the user
        // clicks A→B→A rapidly and an earlier in-flight fetch resolves last.
        let langReqSeq = 0;

        const onDocClick = (e) => { if (!langMenu.contains(e.target) && e.target !== langBtn) closeMenu(); };
        const closeMenu = () => { langMenu.hidden = true; document.removeEventListener('click', onDocClick, true); };
        // Popup close ≠ menu close — guarantee the document listener is removed
        // even if the popup is dismissed while the menu is still open.
        popup.on('close', () => document.removeEventListener('click', onDocClick, true));

        langBtn.onclick = (e) => {
          e.stopPropagation();
          if (langMenu.hidden) {
            langMenu.hidden = false;
            setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
          } else {
            closeMenu();
          }
        };

        langItems.forEach(item => {
          item.onclick = async (e) => {
            e.stopPropagation();
            const target = item.dataset.lang;
            closeMenu();
            // No-op if already on this lang for this photo
            const stateNow = photoAiState.get(currentActiveIdx);
            if (stateNow && stateNow.lang === target) return;
            // Capture which photo this request was for — guards against the
            // user switching photos while a translation fetch is in-flight.
            const idxForReq = currentActiveIdx;
            langItems.forEach(b => b.classList.remove('active'));
            item.classList.add('active');

            const cacheKey = `${idxForReq}:${target}`;
            if (langCache.has(cacheKey)) {
              const cached = langCache.get(cacheKey);
              photoAiState.set(idxForReq, { text: cached, lang: target });
              if (idxForReq === currentActiveIdx) {
                aiDesc.innerHTML = escFmt(cached);
                aiDesc.scrollTop = 0;
                checkScroll();
              }
              return;
            }

            const mySeq = ++langReqSeq;
            const prevState = stateNow;
            aiDesc.style.opacity = '0.5';
            try {
              const res = await fetch(`${this.apiBase}/${encodeURIComponent(messageId)}/photos/${idxForReq}/description?lang=${target}`, {
                credentials: 'include'
              });
              if (mySeq !== langReqSeq) return;
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const data = await res.json();
              if (mySeq !== langReqSeq) return;
              langCache.set(cacheKey, data.text);
              photoAiState.set(idxForReq, { text: data.text, lang: target });
              if (idxForReq === currentActiveIdx) {
                aiDesc.innerHTML = escFmt(data.text);
                aiDesc.scrollTop = 0;
                checkScroll();
              }
            } catch (err) {
              if (mySeq !== langReqSeq) return;
              Logger.warn('[VideoMessage] Translation fetch failed:', err);
              AuthSystem.showNotification('Çeviri alınamadı', 'error');
              if (idxForReq === currentActiveIdx) {
                aiDesc.innerHTML = prevState ? escFmt(prevState.text) : '<em class="vmsg-ai-pending">Açıklama hazırlanıyor…</em>';
                langItems.forEach(b => b.classList.toggle('active', prevState && b.dataset.lang === prevState.lang));
              }
            } finally {
              if (mySeq === langReqSeq) aiDesc.style.opacity = '';
            }
          };
        });
      }

      // Render comments
      const commentsContainer = popupEl.querySelector('[data-comments-container]');
      if (commentsContainer) {
        CommentWidget.render(commentsContainer, 'video_message', messageId);
      }
    }, 0);
  },

  openPhotoOverlay(previewUrl, originalUrl, opts = {}) {
    // Remove existing overlay if any
    document.querySelector('.vmsg-photo-overlay')?.remove();

    const photos = Array.isArray(opts.photos) ? opts.photos : null;
    const photoCount = photos ? photos.length : 1;
    let activeIdx = Number.isFinite(opts.startIdx) ? opts.startIdx : 0;

    const overlay = document.createElement('div');
    overlay.className = 'vmsg-photo-overlay';
    overlay.innerHTML = `
      <div class="vmsg-photo-overlay-toolbar">
        ${photoCount > 1 ? `<span class="vmsg-photo-overlay-counter"><span data-curr>${activeIdx + 1}</span>/${photoCount}</span>` : ''}
        <button class="vmsg-photo-overlay-btn" data-action="zoom-in" title="Yakınlaştır">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button class="vmsg-photo-overlay-btn" data-action="zoom-out" title="Uzaklaştır">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button class="vmsg-photo-overlay-btn" data-action="zoom-reset" title="Sıfırla">1:1</button>
        <button class="vmsg-photo-overlay-btn close" data-action="close-overlay" title="Kapat">&times;</button>
      </div>
      ${photoCount > 1 ? `
        <button class="vmsg-photo-overlay-arrow vmsg-photo-overlay-prev" aria-label="Önceki">‹</button>
        <button class="vmsg-photo-overlay-arrow vmsg-photo-overlay-next" aria-label="Sonraki">›</button>
      ` : ''}
      <div class="vmsg-photo-overlay-container">
        <img src="${previewUrl}" alt="Foto mesaj" draggable="false">
      </div>
    `;
    document.body.appendChild(overlay);

    const img = overlay.querySelector('img');

    // Preload original in background, swap in once fully cached
    const loadOriginal = (url) => {
      if (!url) return;
      const pre = new Image();
      pre.onload = () => { img.src = url; };
      pre.src = url;
    };
    loadOriginal(originalUrl);

    const container = overlay.querySelector('.vmsg-photo-overlay-container');
    let scale = 1;
    let panX = 0, panY = 0;
    let isPanning = false, startX = 0, startY = 0;
    const applyTransform = () => {
      img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    };

    // Switch active photo (carousel mode only)
    const switchTo = (newIdx) => {
      if (!photos) return;
      activeIdx = ((newIdx % photoCount) + photoCount) % photoCount;
      const p = photos[activeIdx];
      // Reset zoom/pan for clean view of new photo
      scale = 1; panX = 0; panY = 0;
      applyTransform();
      // Show preview immediately (browser cache hit if already loaded by popup carousel)
      img.src = p.url;
      loadOriginal(p.originalUrl);
      const counter = overlay.querySelector('[data-curr]');
      if (counter) counter.textContent = activeIdx + 1;
    };

    if (photos && photoCount > 1) {
      overlay.querySelector('.vmsg-photo-overlay-prev').onclick = (e) => {
        e.stopPropagation();
        switchTo(activeIdx - 1);
      };
      overlay.querySelector('.vmsg-photo-overlay-next').onclick = (e) => {
        e.stopPropagation();
        switchTo(activeIdx + 1);
      };
    }

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
    const closeOverlay = () => {
      overlay.remove();
      document.removeEventListener('keydown', overlayKeyHandler);
    };
    const overlayKeyHandler = (e) => {
      if (e.key === 'Escape') { closeOverlay(); return; }
      if (photos && photoCount > 1) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); switchTo(activeIdx - 1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); switchTo(activeIdx + 1); }
      }
    };
    overlay.querySelector('[data-action="close-overlay"]').onclick = closeOverlay;
    document.addEventListener('keydown', overlayKeyHandler);

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
    let panRaf = 0;
    document.addEventListener('mousemove', function handler(e) {
      if (!isPanning) return;
      panX = e.clientX - startX;
      panY = e.clientY - startY;
      if (panRaf) return;
      panRaf = requestAnimationFrame(() => {
        panRaf = 0;
        if (isPanning) applyTransform();
      });
    });
    document.addEventListener('mouseup', function handler() {
      isPanning = false;
      if (img.parentNode) img.style.cursor = scale > 1 ? 'grab' : 'pointer';
    });

    // Touch pinch zoom & pan + carousel swipe (carousel-only, when scale==1)
    let lastTouchDist = 0;
    let lastTouchX = 0, lastTouchY = 0;
    let swipeStartX = 0, swipeStartY = 0, swipeTracking = false;
    container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        lastTouchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        swipeTracking = false;
      } else if (e.touches.length === 1 && scale > 1) {
        isPanning = true;
        lastTouchX = e.touches[0].clientX - panX;
        lastTouchY = e.touches[0].clientY - panY;
        swipeTracking = false;
      } else if (e.touches.length === 1 && photos && photoCount > 1 && scale === 1) {
        swipeStartX = e.touches[0].clientX;
        swipeStartY = e.touches[0].clientY;
        swipeTracking = true;
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
      // Carousel swipe (only when no zoom)
      if (swipeTracking && photos && photoCount > 1) {
        swipeTracking = false;
        const t = e.changedTouches[0];
        const dx = t.clientX - swipeStartX;
        const dy = t.clientY - swipeStartY;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          switchTo(activeIdx + (dx < 0 ? 1 : -1));
          return;
        }
      }
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

  // Native Web Share — opens the OS share sheet (AirDrop, WhatsApp,
  // Messages, Mail, Notes, anything the user has installed). Tries to
  // upgrade to a file-share (actual MP4 / JPG attachments) when the
  // platform supports it; otherwise falls back to URL-only.
  //
  // The button is hidden on platforms without navigator.share.
  async shareNative(messageId, btn, ctx) {
    const url = `https://qbitmap.com/?vmsg=${encodeURIComponent(messageId)}`;
    const kind = ctx.isPhoto ? 'fotoğraf' : 'video';
    const text = `${ctx.senderName} ${kind} mesaj gönderdi`;
    const baseShare = { title: 'QBitmap', text, url };

    const labelEl = btn.querySelector('span');
    const originalLabel = labelEl?.textContent ?? 'Paylaş';
    const setLabel = (t) => { if (labelEl) labelEl.textContent = t; };

    btn.disabled = true;
    setLabel('Hazırlanıyor…');

    // Try to collect the real media files so the share sheet shows
    // "Send photo/video" on Android and AirDrops the actual file on iOS.
    // If anything goes wrong (CORS, unsupported MIME, oversized blob) we
    // silently drop back to URL-only.
    let files = null;
    try {
      if (typeof navigator.canShare === 'function') {
        const collected = await this._collectShareFiles(ctx);
        if (collected.length && navigator.canShare({ files: collected })) {
          files = collected;
        }
      }
    } catch (err) {
      console.warn('[share-native] could not prepare files, falling back to URL', err);
    }

    try {
      await navigator.share(files ? { ...baseShare, files } : baseShare);
      Analytics.event('video_message_share', { medium: 'native', with_files: !!files });
    } catch (err) {
      if (err.name === 'AbortError') return; // user dismissed the sheet
      // Upgraded share failed (target app rejected files?) — give the user
      // a URL-only retry so they still see the share sheet.
      if (files) {
        try { await navigator.share(baseShare); } catch { /* silent */ }
      } else {
        console.warn('[share-native] share failed', err);
      }
    } finally {
      btn.disabled = false;
      setLabel(originalLabel);
    }
  },

  async _wireMediaSession(videoEl, ctx) {
    if (!videoEl) return;
    const { wireMediaSession } = await import('../../src/pwa/media-session.js');
    const poster = videoEl.getAttribute('poster')
      || `${this.apiBase}/${encodeURIComponent(ctx.messageId)}/thumbnail?size=preview`;
    this._mediaSessionCleanup = wireMediaSession(videoEl, {
      title: ctx.description || 'Video Mesaj',
      artist: ctx.senderName || 'QBitmap',
      album: 'QBitmap',
      posterUrl: poster,
      live: false,
    });
  },

  async _collectShareFiles(ctx) {
    const fetchBlob = async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) throw new Error(`fetch ${u} → ${r.status}`);
      return r.blob();
    };
    const extFromType = (t) => {
      if (!t) return '';
      const sub = t.split('/')[1];
      return sub ? sub.split(';')[0] : '';
    };

    if (!ctx.isPhoto) {
      const blob = await fetchBlob(ctx.videoUrl);
      const mime = blob.type || ctx.mimeType || 'video/mp4';
      const ext = extFromType(mime) || 'mp4';
      return [new File([blob], `qbitmap-video.${ext}`, { type: mime })];
    }

    // Photo message — share every photo (cap at 5 to keep the payload
    // manageable for the share target). Full-res `originalUrl` so the
    // recipient doesn't get a compressed preview.
    const urls = (ctx.photoUrls || []).slice(0, 5);
    const blobs = await Promise.all(urls.map(async (p, i) => {
      try {
        const blob = await fetchBlob(p.originalUrl || p.url);
        const mime = blob.type || 'image/jpeg';
        const ext = extFromType(mime) || 'jpg';
        return new File([blob], `qbitmap-foto-${i + 1}.${ext}`, { type: mime });
      } catch {
        return null;
      }
    }));
    return blobs.filter(Boolean);
  },

  closeMessagePopup() {
    CommentWidget.destroy();
    if (typeof this._mediaSessionCleanup === 'function') {
      this._mediaSessionCleanup();
    }
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
        throw new Error((err.error?.message ?? err.error) || 'Delete failed');
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
        const esc = escapeHtml;
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
