import { QBitmapConfig } from "../config.js";
import { Logger, escapeHtml } from "../utils.js";

const DashboardMixin = {
  renderFilterBar() {
    const counts = this.getCameraCounts();
    const types = [
      { key: 'all', label: 'Tümü' },
      { key: 'rtsp', label: 'RTSP' },
      { key: 'rtmp', label: 'RTMP' },
      { key: 'city', label: 'City' }
    ];

    return `
      <div class="cameras-filter-bar">
        <div class="view-toggle">
          <button class="view-btn ${this.viewMode === 'compact' ? 'active' : ''}" data-view="compact" title="Kompakt Görünüm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>
          <button class="view-btn ${this.viewMode === 'expanded' ? 'active' : ''}" data-view="expanded" title="Genişletilmiş Görünüm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="7" height="7"></rect>
              <rect x="14" y="3" width="7" height="7"></rect>
              <rect x="3" y="14" width="7" height="7"></rect>
              <rect x="14" y="14" width="7" height="7"></rect>
            </svg>
          </button>
        </div>
        <div class="filter-chips">
          ${types.filter(t => counts[t.key] > 0 || t.key === 'all').map(t => `
            <button class="filter-chip ${this.activeTypeFilter === t.key ? 'active' : ''}" data-type="${t.key}">
              ${t.label}<span class="chip-count">${counts[t.key]}</span>
            </button>
          `).join('')}
        </div>
        <div class="status-filter">
          <button class="status-btn ${this.activeStatusFilter === 'all' ? 'active' : ''}" data-status="all">Tümü</button>
          <button class="status-btn ${this.activeStatusFilter === 'online' ? 'active' : ''}" data-status="online">
            <span class="status-dot online"></span>Online
          </button>
          <button class="status-btn ${this.activeStatusFilter === 'offline' ? 'active' : ''}" data-status="offline">
            <span class="status-dot offline"></span>Offline
          </button>
        </div>
      </div>
    `;
  },

  /**
   * Render compact camera card
   */
  renderCompactCard(camera) {
    const type = this.getCameraType(camera);
    const isOnline = this.isCameraOnline(camera);
    const isExpanded = this.expandedCardIds.has(String(camera.id));
    const isWhep = camera.camera_type === 'whep';
    const isCity = camera.camera_type === 'city';
    const locationText = camera.lng && camera.lat
      ? `${camera.lat.toFixed(4)}, ${camera.lng.toFixed(4)}`
      : 'Konum belirlenmedi';

    return `
      <div class="camera-card compact ${isExpanded ? 'expanded' : ''}"
           data-camera-id="${escapeHtml(camera.id)}"
           data-type="${type}"
           data-status="${isOnline ? 'online' : 'offline'}">
        <div class="camera-compact-row">
          <div class="camera-status-indicator ${isOnline ? 'online' : 'offline'}"></div>
          <span class="camera-name-compact">${escapeHtml(camera.name)}</span>
          <span class="camera-type-badge-compact ${type}">${type.toUpperCase()}</span>
          <div class="camera-quick-actions">
            ${camera.lng && camera.lat ? `
            <button class="quick-action-btn" data-action="watch" data-device-id="${escapeHtml(camera.device_id)}" data-lng="${camera.lng}" data-lat="${camera.lat}" title="Haritada Göster">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </button>
            ` : ''}
            <button class="quick-action-btn expand-btn ${isExpanded ? 'expanded' : ''}" data-action="toggle-expand" data-camera-id="${camera.id}" title="Detaylar">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </button>
          </div>
        </div>
        <div class="camera-details-panel">
          <div class="camera-info-compact">
            <span class="info-item-compact">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                <circle cx="12" cy="10" r="3"></circle>
              </svg>
              ${locationText}
            </span>
            <span class="info-item-compact">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              ${camera.is_public ? 'Herkese Açık' : 'Gizli'}
            </span>
            ${isWhep && camera.onvif_camera_id ? `
            <span class="info-item-compact" style="color: #4caf50;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              ONVIF Bağlı
            </span>
            ` : ''}
          </div>
          <div class="camera-actions-expanded">
            ${isCity ? `
              <button class="btn-secondary btn-sm" data-action="settings" data-device-id="${escapeHtml(camera.device_id)}" data-camera-id="${escapeHtml(camera.id)}">Ayarlar</button>
              <button class="btn-danger btn-sm" data-action="delete" data-camera-id="${escapeHtml(camera.id)}" data-camera-name="${escapeHtml(camera.name)}" data-camera-type="${escapeHtml(camera.camera_type)}">Sil</button>
            ` : isWhep ? `
              <button class="btn-secondary btn-sm btn-voice" data-action="voice" data-device-id="${escapeHtml(camera.device_id)}">Sesli Arama</button>
              <button class="btn-secondary btn-sm" data-action="recordings" data-device-id="${escapeHtml(camera.device_id)}">Kayıtlar</button>
              <button class="btn-secondary btn-sm" data-action="face" data-device-id="${escapeHtml(camera.device_id)}">Yüz Tanıma</button>
              <button class="btn-secondary btn-sm" data-action="settings" data-device-id="${escapeHtml(camera.device_id)}" data-camera-id="${escapeHtml(camera.id)}">Ayarlar</button>
              <button class="btn-secondary btn-sm" data-action="share" data-camera-id="${escapeHtml(camera.id)}">Paylaş</button>
              <button class="btn-danger btn-sm" data-action="delete" data-camera-id="${escapeHtml(camera.id)}" data-camera-name="${escapeHtml(camera.name)}" data-camera-type="${escapeHtml(camera.camera_type)}">Sil</button>
            ` : `
              <button class="btn-secondary btn-sm" data-action="record" data-device-id="${escapeHtml(camera.device_id)}" data-lng="${camera.lng || ''}" data-lat="${camera.lat || ''}">Kayıt</button>
              <button class="btn-secondary btn-sm" data-action="location" data-device-id="${escapeHtml(camera.device_id)}" data-camera-id="${escapeHtml(camera.id)}">Konum</button>
              <button class="btn-secondary btn-sm" data-action="settings" data-device-id="${escapeHtml(camera.device_id)}" data-camera-id="${escapeHtml(camera.id)}">Ayarlar</button>
              <button class="btn-secondary btn-sm" data-action="share" data-camera-id="${escapeHtml(camera.id)}">Paylaş</button>
              <button class="btn-danger btn-sm" data-action="delete" data-camera-id="${escapeHtml(camera.id)}" data-camera-name="${escapeHtml(camera.name)}" data-camera-type="${escapeHtml(camera.camera_type)}">Sil</button>
            `}
          </div>
        </div>
      </div>
    `;
  },

  /**
   * Render expanded camera card (original style)
   */
  renderExpandedCard(camera) {
    const isWhep = camera.camera_type === 'whep';
    const isCity = camera.camera_type === 'city';
    const isRtmp = camera.device_id?.startsWith('RTMP_');
    const isOnline = this.isCameraOnline(camera);
    const statusClass = isOnline ? 'online' : 'offline';
    const statusText = isRtmp ? 'RTMP Stream' : (isCity ? 'Şehir Kamerası' : (isWhep ? 'RTSP Stream' : (isOnline ? 'Çevrimiçi' : 'Çevrimdışı')));
    const cameraTypeLabel = isRtmp ? 'RTMP' : (isCity ? 'CITY' : (isWhep ? 'RTSP' : escapeHtml(camera.device_id)));
    const locationText = camera.lng && camera.lat
      ? `${camera.lat.toFixed(4)}, ${camera.lng.toFixed(4)}`
      : 'Konum belirlenmedi';

    return `
      <div class="camera-card" data-camera-id="${escapeHtml(camera.id)}">
        <div class="camera-header">
          <div class="camera-status ${statusClass}"></div>
          <span class="camera-name">${escapeHtml(camera.name)}</span>
          <span class="camera-device-id">${cameraTypeLabel}</span>
        </div>
        <div class="camera-info">
          <div class="info-row">
            <span class="info-label">Durum:</span>
            <span class="info-value ${statusClass}">${statusText}</span>
          </div>
          ${isWhep && camera.onvif_camera_id ? `
          <div class="info-row">
            <span class="info-label">ONVIF:</span>
            <span class="info-value" style="color: #4caf50;">Bağlı</span>
          </div>
          ` : isWhep ? `
          <div class="info-row">
            <span class="info-label">ONVIF:</span>
            <span class="info-value" style="color: #999;">Bağlı değil</span>
          </div>
          ` : ''}
          <div class="info-row">
            <span class="info-label">Konum:</span>
            <span class="info-value">${locationText}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Görünürlük:</span>
            <span class="info-value">${camera.is_public ? 'Herkese Açık' : 'Gizli'}</span>
          </div>
        </div>
        <div class="camera-actions">
          ${isCity ? `
          <button class="btn-secondary btn-sm btn-icon btn-settings" data-action="settings" data-device-id="${escapeHtml(camera.device_id)}" data-camera-id="${escapeHtml(camera.id)}" title="Ayarlar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </button>
          <button class="btn-danger btn-sm btn-icon btn-delete" data-action="delete" data-camera-id="${escapeHtml(camera.id)}" data-camera-name="${escapeHtml(camera.name)}" data-camera-type="${escapeHtml(camera.camera_type)}" title="Sil">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
          </button>
          ` : isWhep ? `
          <button class="btn-secondary btn-sm btn-icon btn-voice" data-action="voice" data-device-id="${escapeHtml(camera.device_id)}" title="Sesli Arama"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg></button>
          <button class="btn-secondary btn-sm btn-icon btn-recordings" data-action="recordings" data-device-id="${escapeHtml(camera.device_id)}" title="Kayıtlar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></button>
          <button class="btn-secondary btn-sm btn-icon btn-face" data-action="face" data-device-id="${escapeHtml(camera.device_id)}" title="Yüz Tanıma"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="10" r="3"/><path d="M7 21v-2a5 5 0 0 1 10 0v2"/></svg></button>
          <button class="btn-secondary btn-sm btn-icon btn-settings" data-action="settings" data-device-id="${escapeHtml(camera.device_id)}" data-camera-id="${escapeHtml(camera.id)}" title="Ayarlar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg></button>
          <button class="btn-secondary btn-sm btn-icon btn-share" data-action="share" data-camera-id="${escapeHtml(camera.id)}" title="Paylaş"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg></button>
          <button class="btn-danger btn-sm btn-icon btn-delete" data-action="delete" data-camera-id="${escapeHtml(camera.id)}" data-camera-name="${escapeHtml(camera.name)}" data-camera-type="${escapeHtml(camera.camera_type)}" title="Sil"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>
          ` : `
          <button class="btn-secondary btn-sm btn-icon btn-record" data-action="record" data-device-id="${escapeHtml(camera.device_id)}" data-lng="${camera.lng || ''}" data-lat="${camera.lat || ''}" title="Kayıt"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4" fill="currentColor"></circle></svg></button>
          <button class="btn-secondary btn-sm btn-icon btn-location" data-action="location" data-device-id="${escapeHtml(camera.device_id)}" data-camera-id="${escapeHtml(camera.id)}" title="Konum Belirle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg></button>
          <button class="btn-secondary btn-sm btn-icon btn-settings" data-action="settings" data-device-id="${escapeHtml(camera.device_id)}" data-camera-id="${escapeHtml(camera.id)}" title="Ayarlar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg></button>
          <button class="btn-secondary btn-sm btn-icon btn-share" data-action="share" data-camera-id="${escapeHtml(camera.id)}" title="Paylaş"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg></button>
          <button class="btn-danger btn-sm btn-icon btn-delete" data-action="delete" data-camera-id="${escapeHtml(camera.id)}" data-camera-name="${escapeHtml(camera.name)}" data-camera-type="${escapeHtml(camera.camera_type)}" title="Sil"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>
          `}
        </div>
      </div>
    `;
  },

  /**
   * Render cameras list
   */
  renderCameras() {
    const content = document.querySelector('.dashboard-content');
    const filteredCameras = this.getFilteredCameras();

    let html = `
      <div class="cameras-actions">
        <button class="btn-primary add-camera-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Yeni Kamera Ekle
        </button>
      </div>
    `;

    if (this.cameras.length === 0) {
      html += `
        <div class="cameras-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" stroke-width="1.5">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
            <circle cx="12" cy="13" r="4"></circle>
          </svg>
          <p>Henüz kameranız yok</p>
          <span>Yukarıdaki butona tıklayarak kamera ekleyin</span>
        </div>
      `;
    } else {
      // Add filter bar
      html += this.renderFilterBar();

      // Check if filtered results are empty
      if (filteredCameras.length === 0) {
        html += `
          <div class="cameras-no-results">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              <line x1="8" y1="11" x2="14" y2="11"></line>
            </svg>
            <p>Filtreye uygun kamera bulunamadı</p>
          </div>
        `;
      } else {
        html += `<div class="cameras-list ${this.viewMode === 'compact' ? 'compact-view' : ''}">`;

        for (const camera of filteredCameras) {
          if (this.viewMode === 'compact') {
            html += this.renderCompactCard(camera);
          } else {
            html += this.renderExpandedCard(camera);
          }
        }

        html += '</div>';
      }
    }

    // Render shared cameras section
    if (this.sharedCameras.length > 0) {
      html += `
        <div class="shared-cameras-section">
          <h3 class="shared-cameras-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="18" cy="5" r="3"></circle>
              <circle cx="6" cy="12" r="3"></circle>
              <circle cx="18" cy="19" r="3"></circle>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
            </svg>
            Benimle Paylaşılanlar
          </h3>
          <div class="cameras-list shared-list">
      `;

      for (const camera of this.sharedCameras) {
        const isWhep = camera.camera_type === 'whep';
        const locationText = camera.lng && camera.lat
          ? `${camera.lat.toFixed(4)}, ${camera.lng.toFixed(4)}`
          : 'Konum belirlenmedi';
        const ownerText = camera.owner_name || camera.owner_email || 'Bilinmeyen';

        html += `
          <div class="camera-card shared-camera" data-camera-id="${escapeHtml(camera.id)}">
            <div class="camera-header">
              <div class="camera-status shared"></div>
              <span class="camera-name">${escapeHtml(camera.name)}</span>
              <span class="camera-device-id">${isWhep ? 'RTSP' : escapeHtml(camera.device_id)}</span>
            </div>
            <div class="camera-info">
              <div class="info-row">
                <span class="info-label">Sahip:</span>
                <span class="info-value">${escapeHtml(ownerText)}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Yetki:</span>
                <span class="info-value">${camera.permission === 'view' ? 'Sadece İzleme' : camera.permission}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Konum:</span>
                <span class="info-value">${locationText}</span>
              </div>
            </div>
            <div class="camera-actions">
              <button class="btn-secondary btn-sm btn-icon" data-action="view-shared" data-device-id="${escapeHtml(camera.device_id)}" data-lng="${camera.lng || ''}" data-lat="${camera.lat || ''}" title="Haritada Göster">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                  <circle cx="12" cy="10" r="3"></circle>
                </svg>
              </button>
              <button class="btn-secondary btn-sm btn-icon" data-action="watch-shared" data-device-id="${escapeHtml(camera.device_id)}" data-lng="${camera.lng || ''}" data-lat="${camera.lat || ''}" title="İzle">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                </svg>
              </button>
            </div>
          </div>
        `;
      }

      html += '</div></div>';
    }

    content.innerHTML = html;

    content.querySelector('.add-camera-btn')?.addEventListener('click', () => this.showClaimModal());

    // Load voice call states after rendering
    setTimeout(() => this.loadVoiceCallStates(), 100);
  },

  /**
   * Show claim camera modal - Unified camera addition
   */
};

export { DashboardMixin };
