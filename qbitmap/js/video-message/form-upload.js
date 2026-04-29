import { QBitmapConfig } from "../config.js";
import { Logger, escapeHtml, sanitize } from "../utils.js";
import { AuthSystem } from "../auth.js";
import { Analytics } from "../analytics.js";
import { _haptic } from "./photo-capture.js";
import * as AppState from '../state.js';
import { LocationService } from '../services/location-service.js';

const FormUploadMixin = {
  showPreview() {
    if (!this._modalEl || !this.recordedBlob) return;

    const durationMs = this._durationMs || Math.min(Date.now() - (this.recordingStartTime || Date.now()), this.MAX_DURATION_MS);
    const objectUrl = URL.createObjectURL(this.recordedBlob);

    this._modalEl.innerHTML = `
      <div class="video-msg-modal-content">
        <div class="video-msg-video-container">
          <video id="vmsg-playback" controls playsinline src="${objectUrl}"></video>
        </div>
        <div class="video-msg-send-panel">
          <input type="text" class="video-msg-description-input" id="vmsg-description"
                 placeholder="Bir başlık girin..." maxlength="200" autocomplete="off">
          <div class="video-msg-tag-input-container">
            <div class="video-msg-tag-chips" id="vmsg-tag-chips"></div>
            <input type="text" class="video-msg-tag-input" id="vmsg-tag-input"
                   placeholder="Etiket ekleyin (Enter ile)..." maxlength="100" autocomplete="off">
          </div>
          <div class="video-msg-place-section" id="vmsg-place-section" style="display:none;">
            <div class="video-msg-place-label">
              <svg class="video-msg-place-pin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <span>Yakındaki Mekanlar</span>
              <span class="video-msg-place-loading" id="vmsg-place-loading">...</span>
            </div>
            <div class="video-msg-place-list" id="vmsg-place-list"></div>
            <div class="video-msg-selected-place" id="vmsg-selected-place" style="display:none;"></div>
          </div>
          <div class="video-msg-privacy-toggle">
            <button class="video-msg-privacy-option active" data-mode="public">Herkese Açık</button>
            <button class="video-msg-privacy-option" data-mode="private">Kişiye Özel</button>
          </div>
          <div class="video-msg-recipient-search" id="vmsg-recipient-search">
            <div id="vmsg-selected-recipient"></div>
            <input type="text" class="video-msg-recipient-input" id="vmsg-recipient-input"
                   placeholder="İsim veya email ile ara..." autocomplete="off">
            <div class="video-msg-recipient-results" id="vmsg-recipient-results"></div>
          </div>
          <div class="video-msg-progress" id="vmsg-progress" style="display:none;">
            <div class="video-msg-progress-bar" id="vmsg-progress-bar"></div>
          </div>
          <div class="video-msg-progress-text" id="vmsg-progress-text" style="display:none;"></div>
          <div class="video-msg-actions">
            <button class="video-msg-action-btn danger" id="vmsg-cancel-send">Vazgeç</button>
            <button class="video-msg-action-btn secondary" id="vmsg-rerecord">Tekrar Kaydet</button>
            <button class="video-msg-action-btn primary" id="vmsg-select-location" disabled>Konum alınıyor...</button>
          </div>
        </div>
      </div>
    `;

    // Detect orientation of recorded video
    const playbackVideo = this._modalEl.querySelector('#vmsg-playback');
    const previewContainer = this._modalEl.querySelector('.video-msg-video-container');
    this._applyVideoOrientation(previewContainer, null, playbackVideo);

    // Store duration for upload
    this._durationMs = durationMs;
    this._objectUrl = objectUrl;

    this._bindSendPanel();
  },

  // Shared send panel bindings for both video and photo preview
  _bindSendPanel() {
    if (!this._modalEl) return;

    // Privacy toggle
    const toggleBtns = this._modalEl.querySelectorAll('.video-msg-privacy-option');
    toggleBtns.forEach(btn => {
      btn.onclick = () => {
        toggleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.isPrivate = btn.dataset.mode === 'private';
        const searchEl = this._modalEl.querySelector('#vmsg-recipient-search');
        if (this.isPrivate) {
          searchEl.classList.add('visible');
        } else {
          searchEl.classList.remove('visible');
          this.selectedRecipient = null;
        }
      };
    });

    // Tag chip input
    const tagInput = this._modalEl.querySelector('#vmsg-tag-input');
    const tagChips = this._modalEl.querySelector('#vmsg-tag-chips');
    this._tags = [];
    const addTagFromInput = () => {
      const val = tagInput.value.trim().replace(/,/g, '');
      if (val && this._tags.length < 5 && !this._tags.includes(val)) {
        this._tags.push(val);
        this._renderTagChips(tagChips);
      }
      tagInput.value = '';
    };
    tagInput.onkeydown = (e) => {
      if ((e.key === 'Enter' || e.key === ',') && tagInput.value.trim()) {
        e.preventDefault();
        addTagFromInput();
      }
      if (e.key === 'Backspace' && !tagInput.value && this._tags.length > 0) {
        this._tags.pop();
        this._renderTagChips(tagChips);
      }
    };
    // Also handle input event for mobile comma entry
    tagInput.oninput = () => {
      if (tagInput.value.includes(',')) {
        addTagFromInput();
      }
    };
    // Add remaining text as tag on blur
    tagInput.onblur = () => {
      if (tagInput.value.trim()) addTagFromInput();
    };

    // Recipient search
    const input = this._modalEl.querySelector('#vmsg-recipient-input');
    input.oninput = () => {
      clearTimeout(this._searchDebounce);
      this._searchDebounce = setTimeout(() => this.searchUsers(input.value), 300);
    };

    // Cancel / exit entirely
    const cancelBtn = this._modalEl.querySelector('#vmsg-cancel-send');
    if (cancelBtn) {
      cancelBtn.onclick = () => this.cleanupAndClose();
    }

    // Re-record / re-capture
    this._modalEl.querySelector('#vmsg-rerecord').onclick = () => {
      if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
      if (Array.isArray(this._capturedPhotos)) {
        this._capturedPhotos.forEach(p => p?.objectUrl && URL.revokeObjectURL(p.objectUrl));
      }
      this._capturedPhotos = [];
      this._previewActiveIdx = 0;
      this.recordedBlob = null;
      this.capturedPhotoBlob = null;
      this.selectedRecipient = null;
      this.isPrivate = false;
      this._tags = [];
      this._nearbyPlaces = [];
      this._selectedPlace = null;
      this.closeModal();
      if (this._isGalleryMode && this.isPhotoMode) {
        this.startGalleryPhotoFlow();
      } else if (this.isPhotoMode) {
        this.startPhotoFlow();
      } else {
        this.startFlow();
      }
    };

    // Try auto GPS location
    const locationBtn = this._modalEl.querySelector('#vmsg-select-location');
    this._tryAutoLocation(locationBtn);
  },

  _tryAutoLocation(btn) {
    LocationService.get({
      purpose: 'video-upload',
      acceptThresholdM: 25,
      approximateMaxM: 100
    })
      .then((loc) => {
        if (loc.quality === 'precise') {
          // Good GPS — auto-set and show Send
          this.selectedLocation = {
            lng: loc.lng,
            lat: loc.lat,
            accuracy_radius_m: loc.accuracy_radius_m,
            source: loc.source
          };
          btn.disabled = false;
          btn.textContent = 'Gönder';
          btn.onclick = () => {
            if (this.isPrivate && !this.selectedRecipient) {
              AuthSystem.showNotification('Önce alıcı seçin', 'error');
              return;
            }
            this.uploadMessage();
          };
          this.fetchNearbyPlaces(loc.lat, loc.lng);
        } else {
          // Approximate / coarse → make user pick on map
          btn.disabled = false;
          btn.textContent = 'Konumu Seç';
          this._bindLocationBtn(btn);
        }
      })
      .catch(() => {
        btn.disabled = false;
        btn.textContent = 'Konumu Seç';
        this._bindLocationBtn(btn);
      });
  },

  _bindLocationBtn(btn) {
    btn.onclick = () => {
      if (this.isPrivate && !this.selectedRecipient) {
        AuthSystem.showNotification('Önce alıcı seçin', 'error');
        return;
      }
      this.enterLocationSelection();
    };
  },

  // ==================== USER SEARCH ====================

  async searchUsers(query) {
    const resultsEl = this._modalEl?.querySelector('#vmsg-recipient-results');
    if (!resultsEl) return;

    query = query.trim();
    if (query.length < 2) {
      resultsEl.innerHTML = '';
      return;
    }

    try {
      const response = await fetch(`${this.apiBase}/users/search?q=${encodeURIComponent(query)}`, {
        credentials: 'include'
      });
      if (!response.ok) return;

      const data = await response.json();
      const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

      resultsEl.innerHTML = (data.users || []).map(u => `
        <div class="video-msg-recipient-item" data-id="${u.id}" data-email="${esc(u.email)}" data-name="${esc(u.display_name)}">
          <img src="${esc(u.avatar_url || '')}" alt="" data-onerror="hide">
          <div>
            <div class="name">${esc(u.display_name)}</div>
            <div class="email">${esc(u.email)}</div>
          </div>
        </div>
      `).join('');

      resultsEl.querySelectorAll('.video-msg-recipient-item').forEach(item => {
        item.onclick = () => {
          this.selectedRecipient = {
            id: parseInt(item.dataset.id),
            email: item.dataset.email,
            name: item.dataset.name
          };
          this.showSelectedRecipient();
        };
      });
    } catch (error) {
      Logger.error('[VideoMessage] User search error:', error);
    }
  },

  showSelectedRecipient() {
    const container = this._modalEl?.querySelector('#vmsg-selected-recipient');
    const input = this._modalEl?.querySelector('#vmsg-recipient-input');
    const results = this._modalEl?.querySelector('#vmsg-recipient-results');
    if (!container) return;

    const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
    const r = this.selectedRecipient;

    container.innerHTML = `
      <div class="video-msg-selected-recipient">
        <img src="${esc(r.email)}" alt="" style="display:none;">
        <span>${esc(r.name)} (${esc(r.email)})</span>
        <span class="remove" id="vmsg-remove-recipient">&times;</span>
      </div>
    `;

    if (input) input.style.display = 'none';
    if (results) results.innerHTML = '';

    container.querySelector('#vmsg-remove-recipient').onclick = () => {
      this.selectedRecipient = null;
      container.innerHTML = '';
      if (input) { input.style.display = ''; input.value = ''; }
    };
  },

  // ==================== LOCATION SELECTION ====================

  enterLocationSelection() {
    // Hide modal (shrink to allow map interaction)
    if (this._modalEl) {
      this._modalEl.style.display = 'none';
    }

    this.isSelectingLocation = true;
    const map = AppState.map;
    if (!map) return;

    map.getCanvas().style.cursor = 'crosshair';

    // Show hint overlay
    const hint = document.createElement('div');
    hint.className = 'video-msg-location-hint';
    hint.id = 'vmsg-location-hint';
    hint.innerHTML = `
      <span class="hint-icon">📍</span>
      <span>Konumu seçin</span>
      <button class="hint-cancel" id="vmsg-hint-cancel">İptal</button>
    `;
    document.body.appendChild(hint);

    hint.querySelector('#vmsg-hint-cancel').onclick = () => this.exitLocationSelection();

    // One-time map click handler
    this._locationClickHandler = (e) => {
      this.selectedLocation = { lng: e.lngLat.lng, lat: e.lngLat.lat, source: 'manual' };
      this.exitLocationSelection();
      // Show modal again with Send button and fetch nearby places
      if (this._modalEl) {
        this._modalEl.style.display = '';
        const locationBtn = this._modalEl.querySelector('#vmsg-select-location');
        if (locationBtn) {
          locationBtn.textContent = 'Gönder';
          locationBtn.disabled = false;
          locationBtn.onclick = () => {
            if (this.isPrivate && !this.selectedRecipient) {
              AuthSystem.showNotification('Önce alıcı seçin', 'error');
              return;
            }
            this.uploadMessage();
          };
        }
        this.fetchNearbyPlaces(e.lngLat.lat, e.lngLat.lng);
      }
    };

    map.once('click', this._locationClickHandler);
  },

  exitLocationSelection() {
    this.isSelectingLocation = false;

    const map = AppState.map;
    if (map) {
      map.getCanvas().style.cursor = '';
      if (this._locationClickHandler) {
        map.off('click', this._locationClickHandler);
        this._locationClickHandler = null;
      }
    }

    const hint = document.getElementById('vmsg-location-hint');
    if (hint) hint.remove();

    // Show modal again if upload hasn't started
    if (this._modalEl && !this.selectedLocation) {
      this._modalEl.style.display = '';
    }
  },

  _renderTagChips(container) {
    const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
    container.innerHTML = this._tags.map((tag, i) => `
      <span class="video-msg-tag-chip">
        ${esc(tag)}
        <span class="video-msg-tag-chip-remove" data-tag-index="${i}">&times;</span>
      </span>
    `).join('');
    container.querySelectorAll('.video-msg-tag-chip-remove').forEach(btn => {
      btn.onclick = () => {
        this._tags.splice(parseInt(btn.dataset.tagIndex), 1);
        this._renderTagChips(container);
      };
    });
  },

  // ==================== PLACE TAGGING ====================

  async fetchNearbyPlaces(lat, lng) {
    const section = this._modalEl?.querySelector('#vmsg-place-section');
    const loading = this._modalEl?.querySelector('#vmsg-place-loading');
    const list = this._modalEl?.querySelector('#vmsg-place-list');
    if (!section || !list) return;

    section.style.display = '';
    if (loading) loading.style.display = '';
    this._nearbyPlaces = [];
    this._selectedPlace = null;

    try {
      const response = await fetch(
        `${this.apiBase}/nearby-places?lat=${lat}&lng=${lng}`,
        { credentials: 'include' }
      );
      if (!response.ok) throw new Error('Failed');

      const data = await response.json();
      this._nearbyPlaces = data.places || [];

      if (loading) loading.style.display = 'none';

      if (this._nearbyPlaces.length === 0) {
        section.style.display = 'none';
        return;
      }

      const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
      list.innerHTML = this._nearbyPlaces.map(p => {
        return `
          <div class="video-msg-place-item" data-place-id="${p.id}" data-place-name="${esc(p.display_name)}">
            <span class="video-msg-place-name">${esc(p.display_name)}</span>
            ${p.formatted_address ? `<span class="video-msg-place-address">${esc(p.formatted_address)}</span>` : ''}
          </div>
        `;
      }).join('');

      list.querySelectorAll('.video-msg-place-item').forEach(item => {
        item.onclick = () => {
          this._selectedPlace = {
            id: parseInt(item.dataset.placeId),
            name: item.dataset.placeName
          };
          this._showSelectedPlace();
        };
      });

    } catch (err) {
      Logger.warn('[VideoMessage] Nearby places fetch failed:', err);
      if (section) section.style.display = 'none';
    }
  },

  _showSelectedPlace() {
    const list = this._modalEl?.querySelector('#vmsg-place-list');
    const selected = this._modalEl?.querySelector('#vmsg-selected-place');
    if (!selected || !this._selectedPlace) return;

    const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
    selected.style.display = '';
    if (list) list.style.display = 'none';

    selected.innerHTML = `
      <div class="video-msg-place-chip">
        <svg class="video-msg-place-pin-chip" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
        <span>${esc(this._selectedPlace.name)}</span>
        <span class="video-msg-place-remove" id="vmsg-remove-place">&times;</span>
      </div>
    `;

    selected.querySelector('#vmsg-remove-place').onclick = () => {
      this._selectedPlace = null;
      selected.style.display = 'none';
      selected.innerHTML = '';
      if (list) list.style.display = '';
    };
  },

  // ==================== UPLOAD ====================

  async uploadMessage() {
    const photos = this.isPhotoMode
      ? (this._capturedPhotos && this._capturedPhotos.length > 0
          ? this._capturedPhotos
          : (this.capturedPhotoBlob ? [{ blob: this.capturedPhotoBlob, width: this._capturedWidth, height: this._capturedHeight }] : []))
      : null;
    const blob = this.isPhotoMode ? (photos[0]?.blob || null) : this.recordedBlob;
    if (!blob || !this.selectedLocation) return;

    // Client-side file size check (max 20MB per file)
    const MAX_SIZE = 20 * 1024 * 1024;
    if (this.isPhotoMode) {
      for (const p of photos) {
        if (p.blob.size > MAX_SIZE) {
          AuthSystem.showNotification(`Bir fotoğraf çok büyük (${(p.blob.size / 1024 / 1024).toFixed(1)}MB). Maksimum 20MB.`, 'error');
          return;
        }
      }
    } else if (blob.size > MAX_SIZE) {
      AuthSystem.showNotification(`Dosya çok büyük (${(blob.size / 1024 / 1024).toFixed(1)}MB). Maksimum 20MB.`, 'error');
      return;
    }

    // Show modal with progress
    if (this._modalEl) {
      this._modalEl.style.display = '';
    }

    const formData = new FormData();
    // Fields MUST come before file for @fastify/multipart request.file() to parse them
    formData.append('lng', this.selectedLocation.lng);
    formData.append('lat', this.selectedLocation.lat);
    if (Number.isFinite(this.selectedLocation.accuracy_radius_m)) {
      formData.append('accuracy_radius_m', String(this.selectedLocation.accuracy_radius_m));
    }
    if (this.selectedLocation.source) {
      formData.append('location_source', this.selectedLocation.source);
    }
    if (!this.isPhotoMode) {
      formData.append('duration_ms', this._durationMs);
    }
    if (this.isPrivate && this.selectedRecipient) {
      formData.append('recipient_email', this.selectedRecipient.email);
    }
    const descInput = this._modalEl?.querySelector('#vmsg-description');
    if (descInput && descInput.value.trim()) {
      formData.append('description', descInput.value.trim());
    }
    // Grab any remaining text in tag input before upload
    const tagInputEl = this._modalEl?.querySelector('#vmsg-tag-input');
    if (tagInputEl && tagInputEl.value.trim()) {
      const val = tagInputEl.value.trim().replace(/,/g, '');
      if (val && (!this._tags || this._tags.length < 5) && !(this._tags || []).includes(val)) {
        if (!this._tags) this._tags = [];
        this._tags.push(val);
      }
    }
    if (this._tags && this._tags.length > 0) {
      formData.append('tags', this._tags.join(','));
    }
    if (this._selectedPlace) {
      formData.append('place_id', this._selectedPlace.id);
    }
    if (this.isPhotoMode) {
      // Per-photo metadata array (kapak = idx=0, taşıdığı capture-time settings cover-only fields'a uygulanır)
      const photoMetas = photos.map((p, i) => ({
        width: p.width,
        height: p.height,
        zoom: i === 0 ? this._photoZoomLevel : null,
        flash: i === 0 ? this._flashEnabled : null,
        resolution: this._photoResolution,
        is_primary: i === 0
      }));
      formData.append('photo_metadata', JSON.stringify(photoMetas));
      formData.append('photo_count', String(photos.length));
      formData.append('primary_idx', '0');
      photos.forEach((p, i) => {
        const ext = p.blob.type === 'image/png' ? 'png' : p.blob.type === 'image/webp' ? 'webp' : 'jpg';
        // Backend reads files via request.files() iterator; field name is consistent
        formData.append('photos', p.blob, `photo_${i}.${ext}`);
      });
    } else {
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      formData.append('video', blob, `message.${ext}`);
    }

    // Show progress UI
    const progressEl = this._modalEl?.querySelector('#vmsg-progress');
    const progressBar = this._modalEl?.querySelector('#vmsg-progress-bar');
    const progressText = this._modalEl?.querySelector('#vmsg-progress-text');
    const actions = this._modalEl?.querySelector('.video-msg-actions');

    if (progressEl) progressEl.style.display = '';
    if (progressText) { progressText.style.display = ''; progressText.textContent = 'Yükleniyor...'; }
    if (actions) actions.style.display = 'none';

    // Retry on transient network errors. 4xx stays fatal (validation /
    // auth / payload size), 5xx + offline + timeout + rate-limit get
    // retried up to twice with 5s and 15s backoffs. XHR instance is
    // recreated each attempt so upload progress starts fresh.
    const RETRYABLE_STATUSES = new Set([0, 408, 429, 500, 502, 503, 504]);
    const BACKOFF_MS = [0, 5000, 15000]; // 1st, 2nd, 3rd attempt

    const doOneUpload = () => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const uploadStartTime = Date.now();
      xhr.open('POST', this.apiBase, true);
      xhr.withCredentials = true;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && progressBar) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressBar.style.width = pct + '%';
          if (progressText) {
            const elapsed = (Date.now() - uploadStartTime) / 1000;
            if (pct > 0 && pct < 100 && elapsed > 1) {
              const speed = e.loaded / elapsed;
              const remaining = Math.ceil((e.total - e.loaded) / speed);
              const eta = remaining < 60 ? `${remaining}s` : `${Math.floor(remaining / 60)}dk ${remaining % 60}s`;
              progressText.textContent = `Yükleniyor... ${pct}% (${eta} kaldı)`;
            } else {
              progressText.textContent = `Yükleniyor... ${pct}%`;
            }
          }
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { resolve({ status: 'ok' }); }
        } else {
          let msg = `HTTP ${xhr.status}`;
          try {
            const parsed = JSON.parse(xhr.responseText);
            const candidate = parsed.error ?? parsed.message;
            if (typeof candidate === 'string' && candidate) {
              msg = candidate;
            } else if (candidate) {
              msg = JSON.stringify(candidate);
            } else if (xhr.responseText) {
              msg = `HTTP ${xhr.status}: ${xhr.responseText.slice(0, 200)}`;
            }
          } catch {
            if (xhr.responseText) msg = `HTTP ${xhr.status}: ${xhr.responseText.slice(0, 200)}`;
          }
          Logger.error('[VideoMessage] Upload failed', { status: xhr.status, body: xhr.responseText?.slice(0, 500) });
          const err = new Error(msg);
          err.__retryable = RETRYABLE_STATUSES.has(xhr.status);
          err.__status = xhr.status;
          reject(err);
        }
      };

      xhr.onerror = () => {
        // navigator.onLine=false or DNS / TCP / TLS flake. Always retryable.
        const err = new Error(navigator.onLine ? 'Bağlantı hatası' : 'Bağlantı kesildi');
        err.__retryable = true;
        err.__status = 0;
        reject(err);
      };

      xhr.send(formData);
    });

    try {
      let result;
      let lastErr;
      for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
        if (attempt > 0) {
          if (progressText) {
            progressText.textContent = `Bağlantı yenileniyor... (${attempt + 1}/${BACKOFF_MS.length})`;
          }
          if (progressBar) progressBar.style.width = '0%';
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
        }
        try {
          result = await doOneUpload();
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (!err.__retryable || attempt === BACKOFF_MS.length - 1) throw err;
          Logger.warn?.('[VideoMessage] Upload retryable failure, will retry', { status: err.__status, attempt: attempt + 1 });
        }
      }
      if (lastErr) throw lastErr;

      // Success
      if (result.message) {
        const msg = result.message;
        this.videoMessages.set(msg.message_id, msg);
        this.updateMapLayer();
      }

      _haptic('success');
      const mediaType = this.isPhotoMode ? 'photo' : 'video';
      Analytics.event('video_message_create', { type: mediaType, has_location: !!this.selectedLocation, is_private: !!this.isPrivate });
      AuthSystem.showNotification(mediaType === 'photo' ? 'Foto mesaj gönderildi' : 'Video mesaj gönderildi', 'success');
      // [PWA] sending a message is a strong engagement signal.
      window.dispatchEvent(new CustomEvent('qbitmap:video-message-opened'));
      this.cleanupAndClose();

      // Fly to location
      if (AppState.map && this.selectedLocation) {
        AppState.map.flyTo({
          center: [this.selectedLocation.lng, this.selectedLocation.lat],
          zoom: Math.max(AppState.map.getZoom(), 14)
        });
      }

    } catch (error) {
      Logger.error('[VideoMessage] Upload error:', error);

      // If all in-page retries exhausted on a transient (retryable)
      // failure, hand the payload off to the outbox instead of losing it.
      // The outbox retries on `online` and on app reload.
      if (error?.__retryable) {
        try {
          const fields = {};
          for (const [k, v] of formData.entries()) {
            if (typeof v === 'string') fields[k] = v;
          }
          const files = [];
          for (const [k, v] of formData.entries()) {
            if (v instanceof Blob) {
              files.push({ fieldName: k, filename: v.name || (k + '.bin'), blob: v });
            }
          }
          const { enqueue } = await import('../services/upload-outbox.js');
          await enqueue({ endpoint: this.apiBase, fields, files });
          AuthSystem.showNotification('Bağlantı yok — mesajınız kuyruğa alındı, bağlantı gelince otomatik gönderilecek', 'info', 6000);
          _haptic?.('warn');
          this.cleanupAndClose();
          return;
        } catch (enqueueErr) {
          Logger.error('[VideoMessage] Outbox enqueue failed', enqueueErr);
          // fall through to normal error path
        }
      }

      const rawMsg = error?.message ?? error;
      const msg = typeof rawMsg === 'string' ? rawMsg : (() => { try { return JSON.stringify(rawMsg); } catch { return 'Yükleme başarısız'; } })();
      AuthSystem.showNotification(msg || 'Yükleme başarısız', 'error');

      // Restore actions
      if (progressEl) progressEl.style.display = 'none';
      if (progressText) progressText.style.display = 'none';
      if (actions) actions.style.display = '';
      this.selectedLocation = null;
    }
  },
};

export { FormUploadMixin };
