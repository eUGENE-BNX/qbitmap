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

    content.innerHTML = `
      ${this.renderHeaderCard(user, cameraStats, landStats)}
      ${this.renderInfoRow(user.location, user.hasFaceRegistered)}
      ${this.renderRecentMessages(recentMessages)}
    `;

    this.setupEventListeners();
    this.setupLocationListeners(user.location);

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

