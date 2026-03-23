import { QBitmapConfig } from './config.js';
import { Logger } from './utils.js';
import { AuthSystem } from './auth.js';
import { Analytics } from './analytics.js';

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
          <button class="profile-panel-close" onclick="UserProfileSystem.close()">&times;</button>
        </div>
        <div class="profile-panel-content">
          <div class="profile-face-loading">
            <div class="spinner"></div>
            <p>Yükleniyor...</p>
          </div>
        </div>
      </div>
    `;
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
      const [cameraStats, recentMessages, landStats] = await Promise.all([
        this.fetchCameraStats(),
        this.fetchRecentMessages(),
        this.fetchLandStats(user.id)
      ]);

      this.renderProfile(user, { cameraStats, recentMessages, landStats });
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
    const { cameraStats, recentMessages, landStats } = extras;

    const faceSection = `
      <div class="profile-face-section">
        <h4>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
          Yüz Tanıma
        </h4>
        ${user.hasFaceRegistered ? this.renderRegisteredFace() : this.renderUploadArea()}
      </div>
    `;

    content.innerHTML = `
      ${this.renderUserInfo(user)}
      ${this.renderRankBar(landStats)}
      ${this.renderStatsGrid(cameraStats, landStats)}
      ${this.renderRecentMessages(recentMessages)}
      <div class="profile-bottom-row">
        ${this.renderLocationSection(user.location)}
        ${faceSection}
      </div>
    `;

    this.setupEventListeners();
    this.setupLocationListeners(user.location);
  },

  renderUserInfo(user) {
    const memberSince = this.formatMemberSince(user.createdAt);
    return `
      <div class="profile-user-info">
        <img src="${escapeHtml(user.avatarUrl || '/default-avatar.png')}" alt="" class="profile-user-avatar">
        <div class="profile-user-details">
          <h3>${escapeHtml(user.displayName || 'Kullanıcı')}</h3>
          <p>${escapeHtml(user.email)}</p>
          ${memberSince ? `<span class="profile-member-since">Üye: ${memberSince}</span>` : ''}
        </div>
      </div>
    `;
  },

  renderStatsGrid(cameraStats, landStats) {
    const camTotal = cameraStats?.owned?.total ?? '--';
    const camShared = cameraStats?.sharedWithMe ?? '--';
    const areaM2 = landStats?.totalAreaM2 != null ? this.formatArea(landStats.totalAreaM2) : '--';
    const points = landStats?.totalPoints != null ? landStats.totalPoints.toLocaleString('tr-TR') : '--';

    return `
      <div class="profile-stats-grid">
        <div class="profile-stat-card">
          <span class="stat-value">${camTotal}</span>
          <span class="stat-label">Kameralarım</span>
        </div>
        <div class="profile-stat-card">
          <span class="stat-value">${camShared}</span>
          <span class="stat-label">Paylaşılan</span>
        </div>
        <div class="profile-stat-card">
          <span class="stat-value">${areaM2}</span>
          <span class="stat-label">Dijital Arazi</span>
        </div>
        <div class="profile-stat-card">
          <span class="stat-value">${points}</span>
          <span class="stat-label">Qbit Puan</span>
        </div>
      </div>
    `;
  },

  renderRankBar(landStats) {
    if (!landStats || !landStats.rank) return '';
    return `
      <div class="profile-rank-bar">
        <span>🏆</span>
        <span>Sıralama: <span class="rank-position">#${landStats.rank}</span></span>
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
        <div class="media-card" onclick="UserProfileSystem.openMessage('${escapeHtml(msg.message_id)}')">
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

      if (window.map && msg.lat && msg.lng) {
        map.flyTo({ center: [msg.lng, msg.lat], zoom: 17, duration: 1000 });
      }

      if (window.VideoMessage && msg.message_id) {
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

  renderLocationSection(location) {
    const hasLocation = location && location.lat && location.lng;
    const showOnMap = location?.showOnMap || false;

    return `
      <div class="profile-location-section">
        <h4>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
          Konum
        </h4>

        ${hasLocation ? `
          <div class="profile-location-info">
            <div class="profile-location-coords">
              <span class="location-label">Son konum:</span>
              <span class="location-value">${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}</span>
              ${location.accuracy ? `<span class="location-accuracy">(±${Math.round(location.accuracy)}m)</span>` : ''}
            </div>
            ${location.updatedAt ? `
              <div class="profile-location-time">
                <span class="location-label">Güncelleme:</span>
                <span class="location-value">${this.formatDate(location.updatedAt)}</span>
              </div>
            ` : ''}
            <div class="profile-location-actions">
              <div class="profile-location-toggle">
                <label class="toggle-switch">
                  <input type="checkbox" id="location-visibility-toggle" ${showOnMap ? 'checked' : ''}>
                  <span class="toggle-slider"></span>
                </label>
                <span class="toggle-label">Haritada göster</span>
              </div>
              <button class="profile-location-find-btn" onclick="UserProfileSystem.findLocation()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
                  <circle cx="12" cy="12" r="8" fill="none"/>
                </svg>
                Güncelle
              </button>
            </div>
          </div>
        ` : `
          <div class="profile-location-empty">
            <p>Konum bilgisi yok</p>
            <button class="profile-location-find-btn" onclick="UserProfileSystem.findLocation()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
                <circle cx="12" cy="12" r="8" fill="none"/>
              </svg>
              Konumumu Bul
            </button>
          </div>
          <div class="profile-location-toggle">
            <label class="toggle-switch">
              <input type="checkbox" id="location-visibility-toggle" disabled>
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label">Haritada göster</span>
          </div>
        `}
      </div>
    `;
  },

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
          if (window.UserLocationSystem) {
            UserLocationSystem.refreshPublicLocations();
          }
        }
      });
    }
  },

  async findLocation() {
    this.close();
    if (!navigator.geolocation) {
      if (window.AuthSystem) AuthSystem.showNotification('Konum servisi desteklenmiyor', 'error');
      return;
    }
    if (window.AuthSystem) AuthSystem.showNotification('Konum aranıyor...', 'info');

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        if (window.UserLocationSystem) {
          await UserLocationSystem.showLocation(longitude, latitude, accuracy);
        }
        if (window.map) {
          map.flyTo({ center: [longitude, latitude], zoom: 17, duration: 1000 });
        }
        if (window.AuthSystem) {
          AuthSystem.showNotification(`Konum belirlendi (±${Math.round(accuracy)}m)`, 'success');
        }
      },
      (error) => {
        Logger.error('[Profile] Geolocation error:', error);
        if (window.AuthSystem) AuthSystem.showNotification('Konum alınamadı', 'error');
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

  renderUploadArea() {
    return `
      <div class="profile-face-tips">
        <p>İyi bir tanıma için:</p>
        <ul>
          <li>Yüzünüz net görünmeli</li>
          <li>Cepheden çekilmiş olmalı</li>
          <li>İyi aydınlatılmış olmalı</li>
        </ul>
      </div>
      <div class="profile-face-upload" id="face-upload-area">
        <input type="file" id="face-file-input" accept="image/jpeg,image/png">
        <svg class="profile-face-upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <p>Fotoğraf Seç</p>
        <span>veya sürükleyip bırakın (Max: 2MB, 1920x1080)</span>
      </div>
    `;
  },

  renderRegisteredFace() {
    return `
      <div class="profile-face-registered">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4caf50" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <div class="profile-face-registered-info">
          <p>Yüzünüz kayıtlı</p>
          <button class="profile-face-delete-btn" onclick="UserProfileSystem.deleteFace()">
            Kaydı Sil
          </button>
        </div>
      </div>
    `;
  },

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
    const faceSection = document.querySelector('.profile-face-section');
    if (faceSection) {
      faceSection.innerHTML = `
        <h4>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
          Yüz Tanıma
        </h4>
        <div class="profile-face-loading">
          <div class="spinner"></div>
          <p>${message}</p>
        </div>
      `;
    }
  }
};

// Init immediately (this file is lazy-loaded after DOMContentLoaded)
UserProfileSystem.init();

window.UserProfileSystem = UserProfileSystem;
