import '../css/user-profile.css';
import { QBitmapConfig } from './config.js';
import { Logger, escapeHtml } from './utils.js';
import { AuthSystem } from './auth.js';
import { Analytics } from './analytics.js';
import { UserLocationSystem } from './user-location.js';
import { VideoMessage } from './video-message/index.js';
import * as AppState from './state.js';
import { getTeslaIconUrl } from './tesla/icon.js';
import { LocationService } from './services/location-service.js';

/**
 * QBitmap User Profile Panel
 * Manage user profile, stats, recent media, and location
 */

const UserProfileSystem = {
  apiBase: QBitmapConfig.api.users,
  isOpen: false,
  isLoading: false,

  init() {
    this.createPanel();
    window.addEventListener('auth:logout', () => this.close());
    window.addEventListener('sidemenu:open', (e) => {
      if (e.detail?.id !== 'profile') this.close();
    });
  },

  createPanel() {
    const panel = document.createElement('div');
    panel.id = 'profile-panel-overlay';
    panel.className = 'profile-panel-overlay';
    panel.innerHTML = `
      <div class="profile-panel-backdrop"></div>
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
    panel.querySelector('.profile-panel-backdrop').addEventListener('click', () => UserProfileSystem.close());
    panel.querySelector('.profile-panel-close').addEventListener('click', () => UserProfileSystem.close());
    document.body.appendChild(panel);
  },

  async open() {
    if (!AuthSystem.isLoggedIn()) {
      AuthSystem.showNotification('Önce giriş yapmalısınız', 'error');
      return;
    }
    window.dispatchEvent(new CustomEvent('sidemenu:open', { detail: { id: 'profile' } }));
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

      // Fetch extra stats in parallel
      const [cameraStats, recentMessages, landStats, teslaVehicles, broadcastRecordings] = await Promise.all([
        this.fetchCameraStats(),
        this.fetchRecentMessages(),
        this.fetchLandStats(user.id),
        this.fetchTeslaVehicles(),
        this.fetchBroadcastRecordings()
      ]);

      this.renderProfile(user, { cameraStats, recentMessages, landStats, teslaVehicles, broadcastRecordings });
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

  async fetchTeslaVehicles() {
    try {
      const res = await fetch(`${QBitmapConfig.api.base}/api/tesla/vehicles`, { credentials: 'include' });
      if (!res.ok) return [];
      const data = await res.json();
      return data.vehicles || [];
    } catch { return []; }
  },

  async fetchBroadcastRecordings() {
    try {
      const res = await fetch(`${QBitmapConfig.api.base}/api/broadcast-recordings/my`, { credentials: 'include' });
      if (!res.ok) return [];
      const data = await res.json();
      return data.recordings || [];
    } catch { return []; }
  },

  renderProfile(user, extras) {
    const content = document.querySelector('.profile-panel-content');
    const { cameraStats, recentMessages, landStats, teslaVehicles, broadcastRecordings } = extras;

    content.innerHTML = `
      ${this.renderHeaderCard(user, cameraStats, landStats)}
      ${this.renderRecentMessages(recentMessages)}
      ${this.renderBroadcastRecordings(broadcastRecordings)}
      ${teslaVehicles.length > 0 ? teslaVehicles.map(v => this.renderTeslaSection(v)).join('') : this.renderTeslaConnectCard()}
    `;

    this.setupLocationListeners(user.location);
    this.setupTeslaListeners(content);

    // Bind media card click handlers
    content.querySelectorAll('.media-card[data-message-id]').forEach(card => {
      card.addEventListener('click', () => UserProfileSystem.openMessage(card.dataset.messageId));
    });

    // Bind broadcast recording card handlers
    this.setupBroadcastRecordingListeners(content);
  },

  renderHeaderCard(user, cameraStats, landStats) {
    const memberSince = this.formatMemberSince(user.createdAt);
    const areaM2 = landStats?.totalAreaM2 != null ? this.formatArea(landStats.totalAreaM2) : '--';
    const points = landStats?.totalPoints != null ? landStats.totalPoints.toLocaleString('tr-TR') : '--';
    const rank = landStats?.rank ? `#${landStats.rank}` : null;

    return `
      <div class="profile-header-card">
        <div class="profile-header-top">
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
            <div class="profile-stat-mini"><span class="stat-value">${areaM2}</span><span class="stat-label">Arazi</span></div>
          </div>
        </div>
        ${this.renderLocationChip(user.location)}
      </div>
    `;
  },

  renderTeslaConnectCard() {
    return `
      <div class="profile-tesla-section profile-tesla-cta">
        <span class="profile-tesla-section-label">TESLA</span>
        <div class="profile-tesla-cta-row">
          <div class="profile-tesla-logo">T</div>
          <div class="profile-tesla-cta-text">
            <div class="profile-tesla-cta-title">Tesla Connect</div>
            <div class="profile-tesla-cta-desc">Aracını "Tesla Community"'e dahil et. Diğer Tesla kullanıcıları ile bir araya gel.</div>
          </div>
        </div>
        <button class="profile-tesla-connect-btn">Tesla Connect</button>
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

    const telemetryOff = vehicle.telemetryEnabled === false;

    return `
      <div class="profile-tesla-section">
        <span class="profile-tesla-section-label">TESLA</span>
        ${telemetryOff ? `
          <div class="profile-tesla-banner" data-vehicle-id="${escapeHtml(vehicleId)}">
            <div class="profile-tesla-banner-text">
              <strong>Telemetry henüz aktif değil</strong>
              <span>Aracın konumu paylaşılmıyor. QR kodu okutarak virtual key onayla.</span>
            </div>
            <button class="profile-tesla-show-qr">QR Kodu Göster</button>
          </div>
        ` : ''}
        <div class="profile-tesla-header">
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
          ${(() => { const u = getTeslaIconUrl(vehicle); return u
            ? `<img class="profile-tesla-car-icon" src="${escapeHtml(u)}" alt="${escapeHtml(vehicle.color || '')}" />`
            : `<div class="profile-tesla-logo">T</div>`; })()}
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
          ${odometer ? `<span class="profile-tesla-odo">Odometer: ${odometer} km</span>` : ''}
          ${(outsideTemp != null || insideTemp != null) ? `
            <span class="profile-tesla-temp">
              ${tempIcon}
              ${outsideTemp != null ? `Dış ${outsideTemp}°` : ''}${outsideTemp != null && insideTemp != null ? ' / ' : ''}${insideTemp != null ? `İç ${insideTemp}°` : ''}
            </span>
          ` : ''}
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

        <div class="profile-tesla-shares" data-vehicle-id="${escapeHtml(vehicleId)}">
          <div class="profile-tesla-shares-header">Paylaşılan Kişiler</div>
          <div class="profile-tesla-shares-hint">Araç gizliyken yalnızca siz ve aşağıdaki kişiler aracı haritada görür. Yakınlık uyarısı işaretli kişilerle 250m çapına girdiğinizde popup gösterilir.</div>
          <div class="profile-tesla-shares-list" data-vehicle-id="${escapeHtml(vehicleId)}">Yükleniyor…</div>
          <div class="profile-tesla-shares-add">
            <input type="email" class="profile-tesla-share-email" placeholder="E-posta adresi" data-vehicle-id="${escapeHtml(vehicleId)}">
            <button class="profile-tesla-share-add-btn" data-vehicle-id="${escapeHtml(vehicleId)}">Ekle</button>
          </div>
        </div>
      </div>
    `;
  },

  async loadTeslaShares(vehicleId, listEl) {
    if (!listEl) return;
    try {
      const res = await fetch(`${QBitmapConfig.api.base}/api/tesla/vehicles/${vehicleId}/shares`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      this.renderTeslaShares(listEl, data.shares || []);
    } catch {
      listEl.textContent = 'Paylaşımlar yüklenemedi';
    }
  },

  renderTeslaShares(listEl, shares) {
    listEl.textContent = '';
    if (shares.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'profile-tesla-shares-empty';
      empty.textContent = 'Henüz paylaşım yok';
      listEl.appendChild(empty);
      return;
    }
    for (const s of shares) {
      const row = document.createElement('div');
      row.className = 'profile-tesla-share-row';
      row.dataset.userId = s.userId;

      const avatar = document.createElement('div');
      avatar.className = 'profile-tesla-share-avatar';
      if (s.avatarUrl) {
        const img = document.createElement('img');
        img.src = s.avatarUrl;
        img.alt = '';
        avatar.appendChild(img);
      } else {
        avatar.textContent = (s.displayName || s.email || '?').charAt(0).toUpperCase();
      }

      const meta = document.createElement('div');
      meta.className = 'profile-tesla-share-meta';
      const name = document.createElement('div');
      name.className = 'profile-tesla-share-name';
      name.textContent = s.displayName || s.email;
      const email = document.createElement('div');
      email.className = 'profile-tesla-share-email-text';
      email.textContent = s.email;
      meta.appendChild(name);
      meta.appendChild(email);

      const alertLabel = document.createElement('label');
      alertLabel.className = 'profile-tesla-share-alert';
      alertLabel.title = 'Bu kişiyle 250m yakınlığa girdiğinizde popup göster';
      const alertInput = document.createElement('input');
      alertInput.type = 'checkbox';
      alertInput.className = 'profile-tesla-share-alert-input';
      alertInput.checked = !!s.proximityAlertEnabled;
      const alertText = document.createElement('span');
      alertText.textContent = 'Yakınlık uyarısı';
      alertLabel.appendChild(alertInput);
      alertLabel.appendChild(alertText);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'profile-tesla-share-remove';
      removeBtn.type = 'button';
      removeBtn.title = 'Paylaşımı kaldır';
      removeBtn.textContent = '×';

      row.appendChild(avatar);
      row.appendChild(meta);
      row.appendChild(alertLabel);
      row.appendChild(removeBtn);
      listEl.appendChild(row);
    }
  },

  setupTeslaListeners(content) {
    // Connect CTA (empty state)
    const connectBtn = content.querySelector('.profile-tesla-connect-btn');
    if (connectBtn) {
      connectBtn.addEventListener('click', () => {
        window.location.href = `${QBitmapConfig.api.base}/auth/tesla`;
      });
    }

    // Re-show QR modal (telemetry-off banner)
    content.querySelectorAll('.profile-tesla-show-qr').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const res = await fetch(`${QBitmapConfig.api.base}/api/tesla/vehicles`, { credentials: 'include' });
          const data = await res.json();
          const noTelemetry = (data.vehicles || []).filter(v => !v.telemetryEnabled);
          if (noTelemetry.length === 0) {
            AuthSystem.showNotification('Telemetry zaten aktif', 'info');
            return;
          }
          const teslaModule = await import('./tesla/index.js');
          teslaModule.TeslaSystem.showTelemetryPrompt(noTelemetry);
        } catch (err) {
          Logger.error('[Profile] Show QR failed:', err);
          AuthSystem.showNotification('QR gösterilemedi', 'error');
        }
      });
    });

    // Disconnect (any disconnect button disconnects the whole Tesla account)
    content.querySelectorAll('.profile-tesla-disconnect').forEach(btn => {
      btn.addEventListener('click', async () => {
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
    });

    // Mesh visibility toggle (per vehicle)
    content.querySelectorAll('.profile-tesla-mesh-toggle').forEach(meshBtn => {
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
    });

    // License plate (per vehicle)
    content.querySelectorAll('.profile-tesla-plate-row').forEach(plateRow => {
      const vehicleId = plateRow.dataset.vehicleId;

      const bindPlateSave = (container) => {
        const saveBtn = container.querySelector('.profile-tesla-plate-save');
        const plateInput = container.querySelector('.profile-tesla-plate-input');
        if (!saveBtn || !plateInput) return;
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
      };

      // New plate input (no existing plate)
      bindPlateSave(plateRow);

      // Edit existing plate
      const editBtn = plateRow.querySelector('.profile-tesla-plate-edit');
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
          input.focus();
          bindPlateSave(plateRow);
        });
      }
    });

    // Per-user vehicle shares
    content.querySelectorAll('.profile-tesla-shares').forEach(section => {
      const vehicleId = section.dataset.vehicleId;
      const listEl = section.querySelector('.profile-tesla-shares-list');
      const emailInput = section.querySelector('.profile-tesla-share-email');
      const addBtn = section.querySelector('.profile-tesla-share-add-btn');

      this.loadTeslaShares(vehicleId, listEl);

      const addShare = async () => {
        const email = emailInput.value.trim();
        if (!email) return;
        addBtn.disabled = true;
        try {
          const res = await fetch(`${QBitmapConfig.api.base}/api/tesla/vehicles/${vehicleId}/shares`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Eklenemedi');
          emailInput.value = '';
          await this.loadTeslaShares(vehicleId, listEl);
          AuthSystem.showNotification('Paylaşım eklendi', 'success');
        } catch (err) {
          AuthSystem.showNotification(err.message || 'Paylaşım eklenemedi', 'error');
        } finally {
          addBtn.disabled = false;
        }
      };
      addBtn.addEventListener('click', addShare);
      emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addShare(); });

      // Event delegation for remove + proximity toggle
      listEl.addEventListener('click', async (e) => {
        const row = e.target.closest('.profile-tesla-share-row');
        if (!row) return;
        const userId = row.dataset.userId;
        if (e.target.classList.contains('profile-tesla-share-remove')) {
          if (!confirm('Bu paylaşımı kaldırmak istediğinize emin misiniz?')) return;
          try {
            const res = await fetch(`${QBitmapConfig.api.base}/api/tesla/vehicles/${vehicleId}/shares/${userId}`, {
              method: 'DELETE', credentials: 'include',
            });
            if (!res.ok) throw new Error('http ' + res.status);
            await this.loadTeslaShares(vehicleId, listEl);
            AuthSystem.showNotification('Paylaşım kaldırıldı', 'info');
          } catch {
            AuthSystem.showNotification('Paylaşım kaldırılamadı', 'error');
          }
        }
      });

      listEl.addEventListener('change', async (e) => {
        if (!e.target.classList.contains('profile-tesla-share-alert-input')) return;
        const row = e.target.closest('.profile-tesla-share-row');
        if (!row) return;
        const userId = row.dataset.userId;
        const enabled = e.target.checked;
        try {
          const res = await fetch(`${QBitmapConfig.api.base}/api/tesla/vehicles/${vehicleId}/shares/${userId}`, {
            method: 'PATCH', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proximityAlertEnabled: enabled }),
          });
          if (!res.ok) throw new Error('http ' + res.status);
        } catch {
          e.target.checked = !enabled;
          AuthSystem.showNotification('Uyarı ayarı kaydedilemedi', 'error');
        }
      });
    });
  },

  renderLocationChip(location) {
    const hasLocation = location && location.lat && location.lng;
    const showOnMap = location?.showOnMap || false;

    return hasLocation ? `
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
  },

  renderRecentMessages(messages) {
    const header = `<h4>Son Paylaşımlar</h4>`;

    if (!messages || messages.length === 0) {
      return `<div class="profile-recent-section">${header}<div class="profile-recent-empty">Henüz paylaşım yok</div></div>`;
    }

    const thumbs = messages.slice(0, 6).map(msg => {
      const isVideo = msg.media_type === 'video';
      const thumbUrl = `${QBitmapConfig.api.base}/api/video-messages/${encodeURIComponent(msg.message_id)}/thumbnail`;
      const timeAgo = this.formatTimeAgo(msg.created_at);
      return `
        <div class="media-card" data-message-id="${escapeHtml(msg.message_id)}">
          <div class="media-card-thumb">
            <img src="${thumbUrl}" alt="" loading="lazy">
            ${isVideo ? '<span class="media-type-badge">▶</span>' : ''}
          </div>
          <span class="media-card-time">${timeAgo}</span>
        </div>
      `;
    }).join('');

    return `<div class="profile-recent-section">${header}<div class="profile-media-grid">${thumbs}</div></div>`;
  },

  renderBroadcastRecordings(recordings) {
    const header = `<h4>Son Canlı Yayınlar</h4>`;

    if (!recordings || recordings.length === 0) {
      return `<div class="profile-recent-section">${header}<div class="profile-recent-empty">Henüz kayıtlı yayın yok</div></div>`;
    }

    // Show last 6 (single row)
    const items = recordings.slice(0, 6);
    const cards = items.map(rec => {
      const thumbUrl = `${QBitmapConfig.api.base}/api/broadcast-recordings/${encodeURIComponent(rec.recording_id)}/thumbnail`;
      const timeAgo = this.formatTimeAgo(rec.created_at);
      const durationSec = Math.round((rec.duration_ms || 0) / 1000);
      const min = Math.floor(durationSec / 60);
      const sec = durationSec % 60;
      const durationLabel = `${min}:${sec.toString().padStart(2, '0')}`;
      const isPublic = rec.show_on_map && rec.is_public;

      return `
        <div class="media-card broadcast-rec-card" data-recording-id="${escapeHtml(rec.recording_id)}" data-lng="${rec.lng}" data-lat="${rec.lat}">
          <div class="media-card-thumb">
            <img src="${thumbUrl}" alt="" loading="lazy">
            <span class="media-type-badge broadcast-duration-badge">${durationLabel}</span>
          </div>
          <div class="broadcast-rec-actions">
            <button class="broadcast-rec-visibility-btn${isPublic ? ' active' : ''}" title="${isPublic ? 'Haritadan kaldır' : 'Haritada göster'}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            <button class="broadcast-rec-delete-btn" title="Sil">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
            </button>
          </div>
          <span class="media-card-time">${timeAgo}</span>
        </div>
      `;
    }).join('');

    return `<div class="profile-recent-section">${header}<div class="profile-media-grid">${cards}</div></div>`;
  },

  setupBroadcastRecordingListeners(content) {
    // Click on card → fly to location & play recording
    content.querySelectorAll('.broadcast-rec-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.broadcast-rec-visibility-btn') || e.target.closest('.broadcast-rec-delete-btn')) return;
        const recordingId = card.dataset.recordingId;
        const lng = parseFloat(card.dataset.lng);
        const lat = parseFloat(card.dataset.lat);
        this.close();
        if (AppState.map && lng && lat) {
          AppState.map.flyTo({ center: [lng, lat], zoom: 15, duration: 1000 });
        }
        setTimeout(() => this.openRecordingPopup(recordingId, lng, lat), 1200);
      });
    });

    // Visibility toggle
    content.querySelectorAll('.broadcast-rec-visibility-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const card = btn.closest('.broadcast-rec-card');
        const recordingId = card.dataset.recordingId;
        const isActive = btn.classList.contains('active');
        const newState = !isActive;

        try {
          const res = await fetch(`${QBitmapConfig.api.base}/api/broadcast-recordings/${encodeURIComponent(recordingId)}/visibility`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ showOnMap: newState, isPublic: newState })
          });
          if (res.ok) {
            btn.classList.toggle('active', newState);
            btn.title = newState ? 'Haritadan kaldır' : 'Haritada göster';
          }
        } catch (err) {
          Logger.error('[Profile] Visibility toggle error:', err);
        }
      });
    });

    // Delete button
    content.querySelectorAll('.broadcast-rec-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Bu yayın kaydını silmek istediğinizden emin misiniz?')) return;

        const card = btn.closest('.broadcast-rec-card');
        const recordingId = card.dataset.recordingId;

        try {
          const res = await fetch(`${QBitmapConfig.api.base}/api/broadcast-recordings/${encodeURIComponent(recordingId)}`, {
            method: 'DELETE',
            credentials: 'include'
          });
          if (res.ok) {
            card.remove();
          }
        } catch (err) {
          Logger.error('[Profile] Delete recording error:', err);
        }
      });
    });
  },

  openRecordingPopup(recordingId, lng, lat) {
    const map = AppState.map;
    if (!map) return;

    // Remove existing recording popup if any
    if (this._recordingPopup) {
      this._recordingPopup.remove();
      this._recordingPopup = null;
    }

    const videoUrl = `${QBitmapConfig.api.base}/api/broadcast-recordings/${encodeURIComponent(recordingId)}/video`;

    const html = `
      <div class="broadcast-popup-content past-recording-popup">
        <div class="camera-popup-header">
          <div class="camera-popup-title">
            <div class="camera-title-line1">
              <span class="camera-id">Yayın Kaydı</span>
            </div>
          </div>
          <div class="camera-popup-buttons">
            <button class="cam-btn close-btn" title="Kapat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        <div class="camera-popup-body">
          <div class="camera-frame-container" style="aspect-ratio:16/9;background:#000;">
            <video controls playsinline preload="metadata" src="${videoUrl}"
                   style="width:100%;height:100%;display:block;"></video>
          </div>
        </div>
      </div>
    `;

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: 'none',
      className: 'camera-popup-wrapper',
      anchor: 'bottom'
    })
      .setLngLat([lng, lat])
      .setHTML(html)
      .addTo(map);

    this._recordingPopup = popup;

    setTimeout(() => {
      const el = popup.getElement();
      if (!el) return;
      const closeBtn = el.querySelector('.close-btn');
      if (closeBtn) closeBtn.onclick = () => {
        popup.remove();
        this._recordingPopup = null;
      };
    }, 50);
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
    AuthSystem.showNotification('Konum aranıyor...', 'info');

    try {
      const loc = await LocationService.get({
        purpose: 'profile',
        sampleWindowMs: 15000,
        acceptThresholdM: 25,
        approximateMaxM: 200,
        noCache: true
      });
      if (UserLocationSystem) {
        await UserLocationSystem.showLocation(loc.lng, loc.lat, loc.accuracy_radius_m);
      }
      if (AppState.map) {
        const zoom = loc.quality === 'precise' ? 17 : (loc.quality === 'approximate' ? 14 : 11);
        AppState.map.flyTo({ center: [loc.lng, loc.lat], zoom, duration: 1000 });
      }
      if (AuthSystem) {
        const label = loc.source === 'ip' ? 'yaklaşık (IP)' : `±${loc.accuracy_radius_m}m`;
        AuthSystem.showNotification(`Konum belirlendi (${label})`, 'success');
      }
    } catch (error) {
      Logger.error('[Profile] LocationService error:', error);
      AuthSystem.showNotification('Konum alınamadı', 'error');
    }
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

};

// Init immediately (this file is lazy-loaded after DOMContentLoaded)
UserProfileSystem.init();

export { UserProfileSystem };

