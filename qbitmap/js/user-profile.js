import '../css/user-profile.css';
import { QBitmapConfig } from './config.js';
import { Logger, escapeHtml } from './utils.js';
import { AuthSystem } from './auth.js';
import { Analytics } from './analytics.js';
import { UserLocationSystem } from './user-location.js';
import { VideoMessage } from './video-message/index.js';
import * as AppState from './state.js';

/**
 * QBitmap User Profile Panel
 * Manage user profile, stats, recent media, and face recognition
 */

const UserProfileSystem = {
  apiBase: QBitmapConfig.api.users,
  isOpen: false,
  isLoading: false,
  hasFaceRegistered: false,

  init() {
    this.createPanel();
    window.addEventListener('auth:login', () => this.checkFaceStatus());
    window.addEventListener('auth:logout', () => {
      this.hasFaceRegistered = false;
      this.close();
    });
  },

  createPanel() {
    const panel = document.createElement('div');
    panel.id = 'profile-panel-overlay';
    panel.className = 'profile-panel-overlay';
    panel.onclick = (e) => {
      if (e.target === panel) this.close();
    };
    panel.innerHTML = `
      <div class="profile-panel">
        <div class="profile-panel-header">
          <h2>Profilim</h2>
          <button class="profile-panel-close">&times;</button>
        </div>
        <div class="profile-panel-content">
          <div class="profile-face-loading">
            <div class="spinner"></div>
            <p>Yükleniyor...</p>
          </div>
        </div>
      </div>
    `;
    panel.querySelector('.profile-panel-close').addEventListener('click', () => UserProfileSystem.close());
    document.body.appendChild(panel);
  },

  async open() {
    if (!AuthSystem.isLoggedIn()) {
      AuthSystem.showNotification('Önce giriş yapmalısınız', 'error');
      return;
    }
    const panel = document.getElementById('profile-panel-overlay');
    panel.classList.add('active');
    this.isOpen = true;
    await this.loadProfile();
  },

  close() {
    const panel = document.getElementById('profile-panel-overlay');
    panel.classList.remove('active');
    this.isOpen = false;
  },

  async loadProfile() {
    const content = document.querySelector('.profile-panel-content');

    try {
      const response = await fetch(`${this.apiBase}/me`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load profile');
      const user = await response.json();
      this.hasFaceRegistered = user.hasFaceRegistered;

      // Fetch extra stats in parallel
      const [cameraStats, recentMessages, landStats, teslaVehicle] = await Promise.all([
        this.fetchCameraStats(),
        this.fetchRecentMessages(),
        this.fetchLandStats(user.id),
        this.fetchTeslaVehicle()
      ]);

      this.renderProfile(user, { cameraStats, recentMessages, landStats, teslaVehicle });
    } catch (error) {
      Logger.error('[Profile] Load error:', error);
      content.innerHTML = '<div class="profile-face-error"><p>Profil yüklenemedi</p></div>';
    }
  },

  async fetchCameraStats() {
    try {
      const res = await fetch(`${this.apiBase}/me/camera-stats`, { credentials: 'include' });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  },

  async fetchRecentMessages() {
    try {
      const res = await fetch(`${QBitmapConfig.api.base}/api/video-messages/my-recent?limit=10`, { credentials: 'include' });
      return res.ok ? (await res.json()).messages : [];
    } catch { return []; }
  },

  async fetchLandStats(userId) {
    try {
      const res = await fetch(`${QBitmapConfig.api.h3}/hexagons/user-stats/${userId}`);
      return res.ok ? await res.json() : null;
    } catch { return null; }
  },

  async fetchTeslaVehicle() {
    try {
      const res = await fetch(`${QBitmapConfig.api.base}/api/tesla/vehicles`, { credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json();
      return data.vehicles && data.vehicles.length > 0 ? data.vehicles[0] : null;
    } catch { return null; }
  },

  async checkFaceStatus() {
    try {
      const response = await fetch(`${this.apiBase}/me`, { credentials: 'include' });
      if (response.ok) {
        const user = await response.json();
        this.hasFaceRegistered = user.hasFaceRegistered;
      }
    } catch (error) {
      Logger.error('[Profile] Status check error:', error);
    }
  },

  renderProfile(user, extras) {
    const content = document.querySelector('.profile-panel-content');
    const { cameraStats, recentMessages, landStats, teslaVehicle } = extras;

    content.innerHTML = `
      ${this.renderHeaderCard(user, cameraStats, landStats)}
      ${this.renderInfoRow(user.location, user.hasFaceRegistered)}
      ${this.renderRecentMessages(recentMessages)}
      ${teslaVehicle ? this.renderTeslaSection(teslaVehicle) : ''}
    `;

    this.setupEventListeners();
    this.setupLocationListeners(user.location);
    this.setupTeslaListeners(content);

    // Bind media card click handlers
    content.querySelectorAll('.media-card[data-message-id]').forEach(card => {
      card.addEventListener('click', () => UserProfileSystem.openMessage(card.dataset.messageId));
    });
  },

  renderHeaderCard(user, cameraStats, landStats) {
    const memberSince = this.formatMemberSince(user.createdAt);
    const camTotal = cameraStats?.owned?.total ?? '--';
    const camShared = cameraStats?.sharedWithMe ?? '--';
    const areaM2 = landStats?.totalAreaM2 != null ? this.formatArea(landStats.totalAreaM2) : '--';
    const points = landStats?.totalPoints != null ? landStats.totalPoints.toLocaleString('tr-TR') : '--';
    const rank = landStats?.rank ? `#${landStats.rank}` : null;

    return `
      <div class="profile-header-card">
        <div class="profile-header-left">
          <img src="${escapeHtml(user.avatarUrl || '/default-avatar.png')}" alt="" class="profile-user-avatar">
          <div class="profile-user-details">
            <h3>${escapeHtml(user.displayName || 'Kullanıcı')}</h3>
            <p>${escapeHtml(user.email)}</p>
            ${memberSince ? `<span class="profile-member-since">Üye: ${memberSince}</span>` : ''}
            <span class="profile-qbits">Qbits: ${points}</span>
          </div>
        </div>
        <div class="profile-header-stats">
          ${rank ? `<div class="profile-stat-mini profile-stat-rank"><span class="stat-value">${rank}</span><span class="stat-label">Sıralama</span></div>` : ''}
          <div class="profile-stat-mini"><span class="stat-value">${camTotal}</span><span class="stat-label">Kamera</span></div>
          <div class="profile-stat-mini"><span class="stat-value">${camShared}</span><span class="stat-label">Paylaşılan</span></div>
          <div class="profile-stat-mini"><span class="stat-value">${areaM2}</span><span class="stat-label">Arazi</span></div>
        </div>
      </div>
    `;
  },

  renderTeslaSection(vehicle) {
    const v = (x) => (x != null && x !== 'null' && x !== '' && x !== -999 && x !== -1) ? x : null;

    const model = escapeHtml(vehicle.model || 'Tesla');
    const color = v(vehicle.color);
    const licensePlate = v(vehicle.licensePlate);
    const vehicleId = vehicle.vehicleId;
    const soc = vehicle.soc ?? 0;
    const estRange = v(vehicle.estRange) ? Math.round(vehicle.estRange) : null;
    const insideTemp = v(vehicle.insideTemp) != null ? Math.round(vehicle.insideTemp) : null;
    const outsideTemp = v(vehicle.outsideTemp) != null ? Math.round(vehicle.outsideTemp) : null;
    const locked = v(vehicle.locked);
    const sentry = v(vehicle.sentry);
    const carVersion = v(vehicle.carVersion);
    const odometer = v(vehicle.odometer) ? Math.round(vehicle.odometer).toLocaleString('tr-TR') : null;
    const speed = Math.round(vehicle.speed || 0);

    const rawGear = speed === 0 ? 'P' : (vehicle.gear || 'P');
    const gearMap = { 'P': 'Park', 'D': 'Drive', 'R': 'Reverse', 'N': 'Neutral' };
    const gearText = gearMap[rawGear] || rawGear;
    const gearClass = rawGear === 'D' ? 'driving' : rawGear === 'R' ? 'reverse' : 'parked';

    let tpms = null;
    try {
      const raw = vehicle.tpms;
      tpms = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (tpms && !tpms.fl) tpms = null;
    } catch { tpms = null; }

    let batteryClass = 'green';
    if (soc < 20) batteryClass = 'red';
    else if (soc < 50) batteryClass = 'amber';

    const tempIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M15 13V5c0-1.66-1.34-3-3-3S9 3.34 9 5v8c-1.21.91-2 2.37-2 4 0 2.76 2.24 5 5 5s5-2.24 5-5c0-1.63-.79-3.09-2-4zm-4-8c0-.55.45-1 1-1s1 .45 1 1v3h-2V5z"/></svg>';
    const tireIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>';
    const batteryIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="18" height="12" rx="2" ry="2"/><line x1="23" y1="13" x2="23" y2="11"/></svg>';
    const rangeIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

    return `
      <div class="profile-tesla-section">
        ${outsideTemp != null || insideTemp != null ? `
          <span class="profile-tesla-temp-corner">
            ${tempIcon}
            ${outsideTemp != null ? `Dış ${outsideTemp}°` : ''}${outsideTemp != null && insideTemp != null ? ' / ' : ''}${insideTemp != null ? `İç ${insideTemp}°` : ''}
          </span>
        ` : ''}
        <div class="profile-tesla-header">
          <div class="profile-tesla-logo">T</div>
          <div class="profile-tesla-title">
            <div class="profile-tesla-plate-row" data-vehicle-id="${escapeHtml(vehicleId)}">
              ${licensePlate
                ? `<span class="profile-tesla-plate">${escapeHtml(licensePlate)}</span>
                   <button class="profile-tesla-plate-edit" title="Düzenle">
                     <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                   </button>`
                : `<input type="text" class="profile-tesla-plate-input" placeholder="Plaka girin" maxlength="20">
                   <button class="profile-tesla-plate-save" title="Kaydet">
                     <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                   </button>`
              }
            </div>
            <div>
              <span class="profile-tesla-model">${model}</span>
              ${color ? `<span class="profile-tesla-color"> · ${escapeHtml(color)}</span>` : ''}
            </div>
          </div>
        </div>

        <div class="profile-tesla-battery">
          <span class="profile-tesla-battery-icon">${batteryIcon}</span>
          <div class="profile-tesla-battery-bar">
            <div class="profile-tesla-battery-fill profile-tesla-battery-${batteryClass}" style="width:${soc}%"></div>
          </div>
          <span class="profile-tesla-battery-pct">${soc}%</span>
          ${estRange ? `<span class="profile-tesla-range">${rangeIcon} ${estRange} Km</span>` : ''}
        </div>

        <div class="profile-tesla-status">
          ${tpms ? `
            <span class="profile-tesla-tpms-inline">
              ${tireIcon} FL ${tpms.fl} bar · ${tireIcon} FR ${tpms.fr} bar · ${tireIcon} RL ${tpms.rl} bar · ${tireIcon} RR ${tpms.rr} bar
            </span>
          ` : ''}
          <span class="profile-tesla-tags-right">
            <span class="profile-tesla-gear profile-tesla-gear-${gearClass}">${gearText}${speed > 0 ? ` ${speed}km/h` : ''}</span>
            ${locked != null ? `<span class="profile-tesla-tag ${locked ? 'profile-tesla-tag-green' : 'profile-tesla-tag-red'}">${locked ? 'Kilitli' : 'Açık'}</span>` : ''}
            ${sentry ? `<span class="profile-tesla-tag profile-tesla-tag-blue">Nöbetçi</span>` : ''}
          </span>
        </div>

        <div class="profile-tesla-footer">
          ${odometer ? `<span class="profile-tesla-odo">odometer:${odometer}km</span>` : ''}
          ${carVersion ? `<span class="profile-tesla-version">v${escapeHtml(carVersion)}</span>` : ''}
        </div>

        <div class="profile-tesla-actions">
          <button class="profile-tesla-disconnect">Tesla Bağlantısını Kes</button>
          <button class="profile-tesla-mesh-toggle ${vehicle.meshVisible === false ? 'is-offline' : 'is-online'}"
                  data-vehicle-id="${escapeHtml(vehicleId)}"
                  data-visible="${vehicle.meshVisible === false ? '0' : '1'}"
                  title="Aracın haritada diğer kullanıcılara görünürlüğü">
            <span class="profile-tesla-mesh-dot"></span>
            <span class="profile-tesla-mesh-label">${vehicle.meshVisible === false ? 'Offline' : 'Online'}</span>
          </button>
        </div>
      </div>
    `;
  },

  setupTeslaListeners(content) {
    // Disconnect
    const disconnectBtn = content.querySelector('.profile-tesla-disconnect');
    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', async () => {
        if (!confirm('Tesla hesabınızı ayırmak istediğinize emin misiniz?')) return;
        try {
          await fetch(`${QBitmapConfig.api.base}/api/tesla/disconnect`, {
            method: 'POST', credentials: 'include'
          });
          AuthSystem.showNotification('Tesla hesabı ayrıldı', 'info');
          setTimeout(() => location.reload(), 1000);
        } catch {
          AuthSystem.showNotification('Bağlantı kesilemedi', 'error');
        }
      });
    }

    // Mesh visibility toggle
    const meshBtn = content.querySelector('.profile-tesla-mesh-toggle');
    if (meshBtn) {
      meshBtn.addEventListener('click', async () => {
        const vid = meshBtn.dataset.vehicleId;
        const newVisible = meshBtn.dataset.visible !== '1';
        meshBtn.disabled = true;
        try {
          const res = await fetch(`${QBitmapConfig.api.base}/api/tesla/vehicles/${vid}/mesh-visible`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visible: newVisible }),
          });
          if (!res.ok) throw new Error('http ' + res.status);
          meshBtn.dataset.visible = newVisible ? '1' : '0';
          meshBtn.classList.toggle('is-online', newVisible);
          meshBtn.classList.toggle('is-offline', !newVisible);
          const lbl = meshBtn.querySelector('.profile-tesla-mesh-label');
          if (lbl) lbl.textContent = newVisible ? 'Online' : 'Offline';
          AuthSystem.showNotification(newVisible ? 'Aracınız haritada görünür' : 'Aracınız haritada gizli', 'info');
        } catch {
          AuthSystem.showNotification('Görünürlük değiştirilemedi', 'error');
        } finally {
          meshBtn.disabled = false;
        }
      });
    }

    // License plate save (new input)
    const plateRow = content.querySelector('.profile-tesla-plate-row');
    if (!plateRow) return;
    const vehicleId = plateRow.dataset.vehicleId;

    const saveBtn = content.querySelector('.profile-tesla-plate-save');
    const plateInput = content.querySelector('.profile-tesla-plate-input');
    if (saveBtn && plateInput) {
      const savePlate = async () => {
        const plate = plateInput.value.trim();
        if (!plate) return;
        try {
          await fetch(`${QBitmapConfig.api.base}/api/tesla/vehicles/${vehicleId}/license-plate`, {
            method: 'PATCH', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ licensePlate: plate })
          });
          AuthSystem.showNotification('Plaka kaydedildi', 'success');
          await this.loadProfile();
        } catch {
          AuthSystem.showNotification('Plaka kaydedilemedi', 'error');
        }
      };
      saveBtn.addEventListener('click', savePlate);
      plateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') savePlate(); });
    }

    // License plate edit (existing plate)
    const editBtn = content.querySelector('.profile-tesla-plate-edit');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        const currentPlate = plateRow.querySelector('.profile-tesla-plate')?.textContent || '';
        plateRow.innerHTML = `
          <input type="text" class="profile-tesla-plate-input" value="${escapeHtml(currentPlate)}" maxlength="20">
          <button class="profile-tesla-plate-save" title="Kaydet">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
        `;
        const input = plateRow.querySelector('.profile-tesla-plate-input');
        const save = plateRow.querySelector('.profile-tesla-plate-save');
        input.focus();
        const savePlate = async () => {
          const plate = input.value.trim();
          if (!plate) return;
          try {
            await fetch(`${QBitmapConfig.api.base}/api/tesla/vehicles/${vehicleId}/license-plate`, {
              method: 'PATCH', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ licensePlate: plate })
            });
            AuthSystem.showNotification('Plaka kaydedildi', 'success');
            await this.loadProfile();
          } catch {
            AuthSystem.showNotification('Plaka kaydedilemedi', 'error');
          }
        };
        save.addEventListener('click', savePlate);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') savePlate(); });
      });
    }
  },

  renderInfoRow(location, hasFaceRegistered) {
    const hasLocation = location && location.lat && location.lng;
    const showOnMap = location?.showOnMap || false;

    // Location chip
    const locationChip = hasLocation ? `
      <div class="profile-info-chip">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
        </svg>
        <span class="chip-text">${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}</span>
        ${location.accuracy ? `<span class="chip-meta">±${Math.round(location.accuracy)}m</span>` : ''}
        <label class="toggle-switch-sm">
          <input type="checkbox" id="location-visibility-toggle" ${showOnMap ? 'checked' : ''}>
          <span class="toggle-slider-sm"></span>
        </label>
        <button class="chip-action-btn" data-action="find-location" title="Konumu güncelle">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
      </div>
    ` : `
      <div class="profile-info-chip profile-info-chip--empty">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
        </svg>
        <span class="chip-text">Konum yok</span>
        <button class="chip-action-btn chip-action-btn--primary" data-action="find-location">Bul</button>
      </div>
    `;

    // Face chip
    const faceChip = hasFaceRegistered ? `
      <div class="profile-info-chip profile-info-chip--success">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <span class="chip-text">Yüz kayıtlı</span>
        <button class="profile-face-delete-btn chip-action-btn chip-action-btn--danger">Sil</button>
      </div>
    ` : `
      <div class="profile-info-chip profile-info-chip--upload" id="face-upload-area">
        <input type="file" id="face-file-input" accept="image/jpeg,image/png">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
        </svg>
        <span class="chip-text">Yüz tanıma</span>
        <span class="chip-action-btn chip-action-btn--primary">Yükle</span>
      </div>
    `;

    return `
      <div class="profile-info-row">
        ${locationChip}
        ${faceChip}
      </div>
    `;
  },

  renderRecentMessages(messages) {
    const header = `
      <h4>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="2" width="20" height="20" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        Son Paylaşımlar
      </h4>
    `;

    if (!messages || messages.length === 0) {
      return `<div class="profile-recent-section">${header}<div class="profile-recent-empty">Henüz paylaşım yok</div></div>`;
    }

    const thumbs = messages.map(msg => {
      const badge = msg.media_type === 'video' ? '▶' : '📷';
      const thumbUrl = `${QBitmapConfig.api.base}/api/video-messages/${encodeURIComponent(msg.message_id)}/thumbnail`;
      const timeAgo = this.formatTimeAgo(msg.created_at);
      return `
        <div class="media-card" data-message-id="${escapeHtml(msg.message_id)}">
          <div class="media-card-thumb">
            <img src="${thumbUrl}" alt="" loading="lazy">
            <span class="media-type-badge">${badge}</span>
          </div>
          <span class="media-card-time">${timeAgo}</span>
        </div>
      `;
    }).join('');

    return `<div class="profile-recent-section">${header}<div class="profile-media-grid">${thumbs}</div></div>`;
  },

  formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'dk';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'sa';
    const days = Math.floor(hours / 24);
    if (days < 30) return days + 'g';
    return Math.floor(days / 30) + 'ay';
  },

  async openMessage(messageId) {
    try {
      const base = QBitmapConfig.api.base + '/api/video-messages';
      const res = await fetch(`${base}/${encodeURIComponent(messageId)}`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      const msg = data.message || data;
      this.close();

      if (AppState.map && msg.lat && msg.lng) {
        AppState.map.flyTo({ center: [msg.lng, msg.lat], zoom: 17, duration: 1000 });
      }

      if (msg.message_id) {
        const coord = msg.lat && msg.lng ? [msg.lng, msg.lat] : null;
        VideoMessage.openMessagePopup({
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
          description: msg.description || '',
          aiDescription: msg.ai_description || '',
          tags: JSON.stringify(msg.tags || []),
          thumbnailPath: msg.thumbnail_path || ''
        }, coord);
      }
    } catch (error) {
      Logger.error('[Profile] Open message error:', error);
    }
  },

  // Location rendering is now handled by renderInfoRow

  setupLocationListeners(location) {
    const toggle = document.getElementById('location-visibility-toggle');
    if (toggle) {
      toggle.addEventListener('change', async (e) => {
        const result = await UserLocationSystem.setLocationVisibility(e.target.checked);
        if (result) {
          AuthSystem.showNotification(
            e.target.checked ? 'Konumunuz haritada görünür' : 'Konumunuz haritadan gizlendi',
            'success'
          );
          if (UserLocationSystem) {
            UserLocationSystem.refreshPublicLocations();
          }
        }
      });
    }

    // Bind find location buttons
    document.querySelectorAll('[data-action="find-location"]').forEach(btn => {
      btn.addEventListener('click', () => UserProfileSystem.findLocation());
    });
  },

  async findLocation() {
    this.close();
    if (!navigator.geolocation) {
      AuthSystem.showNotification('Konum servisi desteklenmiyor', 'error');
      return;
    }
    AuthSystem.showNotification('Konum aranıyor...', 'info');

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        if (UserLocationSystem) {
          await UserLocationSystem.showLocation(longitude, latitude, accuracy);
        }
        if (AppState.map) {
          AppState.map.flyTo({ center: [longitude, latitude], zoom: 17, duration: 1000 });
        }
        if (AuthSystem) {
          AuthSystem.showNotification(`Konum belirlendi (±${Math.round(accuracy)}m)`, 'success');
        }
      },
      (error) => {
        Logger.error('[Profile] Geolocation error:', error);
        AuthSystem.showNotification('Konum alınamadı', 'error');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  },

  formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleString('tr-TR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  },

  formatMemberSince(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleString('tr-TR', { month: 'long', year: 'numeric' });
  },

  formatArea(m2) {
    if (m2 >= 1000000) return (m2 / 1000000).toFixed(1) + ' km²';
    if (m2 >= 1000) return (m2 / 1000).toFixed(1) + 'K m²';
    return m2.toLocaleString('tr-TR') + ' m²';
  },

  // Face upload/registered rendering is now handled by renderInfoRow

  setupEventListeners() {
    const uploadArea = document.getElementById('face-upload-area');
    const fileInput = document.getElementById('face-file-input');
    if (!uploadArea || !fileInput) return;

    uploadArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) this.uploadFace(e.target.files[0]);
    });
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) this.uploadFace(e.dataTransfer.files[0]);
    });

    // Bind face delete button
    const deleteBtn = document.querySelector('.profile-face-delete-btn');
    if (deleteBtn) deleteBtn.addEventListener('click', () => UserProfileSystem.deleteFace());
  },

  async uploadFace(file) {
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      AuthSystem.showNotification('Sadece JPEG ve PNG dosyaları kabul edilir', 'error');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      AuthSystem.showNotification('Dosya boyutu 2MB\'dan küçük olmalı', 'error');
      return;
    }
    const isValidSize = await this.validateImageSize(file);
    if (!isValidSize) {
      AuthSystem.showNotification('Görsel en fazla 1920x1080 piksel olabilir', 'error');
      return;
    }

    this.showLoading('Yüz kaydediliyor...');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${this.apiBase}/me/face`, {
        method: 'PUT', credentials: 'include', body: formData
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Yüz kaydedilemedi');

      this.hasFaceRegistered = true;
      AuthSystem.showNotification('Yüzünüz başarıyla kaydedildi!', 'success');
      await this.loadProfile();
    } catch (error) {
      Logger.error('[Profile] Upload error:', error);
      AuthSystem.showNotification(error.message || 'Yüz kaydedilemedi', 'error');
      await this.loadProfile();
    }
  },

  validateImageSize(file) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(img.src); resolve(img.width <= 1920 && img.height <= 1080); };
      img.onerror = () => resolve(false);
      img.src = URL.createObjectURL(file);
    });
  },

  async deleteFace() {
    if (!confirm('Yüz kaydınızı silmek istediğinize emin misiniz?')) return;

    this.showLoading('Kayıt siliniyor...');
    try {
      const response = await fetch(`${this.apiBase}/me/face`, {
        method: 'DELETE', credentials: 'include'
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Kayıt silinemedi');

      this.hasFaceRegistered = false;
      AuthSystem.showNotification('Yüz kaydı silindi', 'success');
      await this.loadProfile();
    } catch (error) {
      Logger.error('[Profile] Delete error:', error);
      AuthSystem.showNotification(error.message || 'Kayıt silinemedi', 'error');
      await this.loadProfile();
    }
  },

  showLoading(message) {
    const faceChip = document.querySelector('.profile-info-chip--success, .profile-info-chip--upload');
    if (faceChip) {
      faceChip.innerHTML = `
        <div class="spinner spinner-sm"></div>
        <span class="chip-text">${escapeHtml(message)}</span>
      `;
    }
  }
};

// Init immediately (this file is lazy-loaded after DOMContentLoaded)
UserProfileSystem.init();

export { UserProfileSystem };

