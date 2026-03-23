/**
 * QBitmap My Cameras Dashboard
 * Manage user's cameras - claim, configure, set location
 */

const MyCamerasSystem = {
  cameras: [],
  sharedCameras: [], // Cameras shared with this user
  apiBase: QBitmapConfig.api.users,
  publicApiBase: QBitmapConfig.api.public,
  isOpen: false,
  isPickingLocation: false,
  editingCameraId: null,
  _isSubmitting: false, // Double-submit protection flag

  // Compact view state
  viewMode: 'compact',           // 'compact' | 'expanded'
  activeTypeFilter: 'all',       // 'all' | 'rtsp' | 'rtmp' | 'device' | 'city'
  activeStatusFilter: 'all',     // 'all' | 'online' | 'offline'
  expandedCardIds: new Set(),    // Track which cards are expanded in compact view

  /**
   * Initialize dashboard
   */
  init() {
    this.createDashboard();
    this.setupEventDelegation();

    // Listen for auth events
    window.addEventListener('auth:login', () => this.loadCameras());
    window.addEventListener('auth:logout', () => {
      this.cameras = [];
      this.close();
    });
  },

  /**
   * Setup event delegation for camera action buttons
   * This prevents XSS via inline onclick handlers
   */
  setupEventDelegation() {
    const dashboard = document.getElementById('my-cameras-dashboard');
    if (!dashboard) return;

    dashboard.addEventListener('click', (e) => {
      // Handle filter bar controls
      const viewBtn = e.target.closest('.view-btn');
      if (viewBtn) {
        this.setViewMode(viewBtn.dataset.view);
        return;
      }

      const filterChip = e.target.closest('.filter-chip');
      if (filterChip) {
        this.setTypeFilter(filterChip.dataset.type);
        return;
      }

      const statusBtn = e.target.closest('.status-btn');
      if (statusBtn) {
        this.setStatusFilter(statusBtn.dataset.status);
        return;
      }

      // Handle action buttons
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;
      const deviceId = btn.dataset.deviceId;
      const cameraId = btn.dataset.cameraId ? parseInt(btn.dataset.cameraId) : null;
      const lng = btn.dataset.lng ? parseFloat(btn.dataset.lng) : null;
      const lat = btn.dataset.lat ? parseFloat(btn.dataset.lat) : null;

      switch (action) {
        case 'toggle-expand':
          this.toggleCardExpand(cameraId);
          break;
        case 'watch':
          // Open camera popup on map
          if (deviceId) {
            const camera = this.cameras.find(c => c.device_id === deviceId);
            if (camera && camera.lng && camera.lat) {
              this.close();
              window.map?.flyTo({ center: [camera.lng, camera.lat], zoom: 18 });
              CameraSystem.openCameraPopup(camera, [camera.lng, camera.lat]);
            }
          }
          break;
        case 'voice':
          this.toggleVoiceCall(deviceId, btn);
          break;
        case 'recordings':
          this.openRecordings(deviceId);
          break;
        case 'face':
          this.openFaceRecognition(deviceId);
          break;
        case 'settings':
          this.openCameraSettings(deviceId, cameraId);
          break;
        case 'record':
          this.openAndRecord(deviceId, lng, lat);
          break;
        case 'location':
          this.pickCameraLocation(deviceId, cameraId);
          break;
        case 'share':
          this.openShareModal(cameraId);
          break;
        case 'delete':
          this.confirmDeleteCamera(cameraId, btn.dataset.cameraName, btn.dataset.cameraType);
          break;
        case 'view-shared':
          this.viewSharedCamera(deviceId, lng, lat);
          break;
        case 'watch-shared':
          this.openSharedCameraPopup(deviceId, lng, lat);
          break;
      }
    });
  },

  /**
   * Create dashboard HTML
   */
  createDashboard() {
    const dashboard = document.createElement('div');
    dashboard.id = 'my-cameras-dashboard';
    dashboard.className = 'my-cameras-dashboard';
    dashboard.innerHTML = `
      <div class="dashboard-overlay" onclick="MyCamerasSystem.close()"></div>
      <div class="dashboard-panel">
        <div class="dashboard-header">
          <h2>Kameralarım</h2>
          <button class="close-btn" onclick="MyCamerasSystem.close()">&times;</button>
        </div>
        <div class="dashboard-content">
          <div class="dashboard-loading">
            <div class="loading-spinner"></div>
            <p>Yükleniyor...</p>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(dashboard);
  },

  /**
   * Open dashboard
   */
  async open() {
    if (!AuthSystem.isLoggedIn()) {
      AuthSystem.showNotification('Önce giriş yapmalısınız', 'error');
      return;
    }

    const dashboard = document.getElementById('my-cameras-dashboard');
    dashboard.classList.add('active');
    this.isOpen = true;

    await this.loadCameras();
  },

  /**
   * Close dashboard
   */
  close() {
    const dashboard = document.getElementById('my-cameras-dashboard');
    dashboard.classList.remove('active');
    this.isOpen = false;
    this.cancelLocationPick();
  },

  /**
   * Get camera type string
   */
  getCameraType(camera) {
    if (camera.camera_type === 'whep') return 'rtsp';
    if (camera.camera_type === 'city') return 'city';
    if (camera.device_id?.startsWith('RTMP_')) return 'rtmp';
    return 'device';
  },

  /**
   * Check if camera is online
   */
  isCameraOnline(camera) {
    const isWhep = camera.camera_type === 'whep';
    const isCity = camera.camera_type === 'city';
    if (isWhep || isCity) return true;

    const lastActivity = camera.lastFrameAt || camera.last_seen;
    return lastActivity && (Date.now() - new Date(lastActivity).getTime() < 60000);
  },

  /**
   * Get filtered cameras based on current filter state
   */
  getFilteredCameras() {
    return this.cameras.filter(camera => {
      // Type filter
      if (this.activeTypeFilter !== 'all') {
        const cameraType = this.getCameraType(camera);
        if (cameraType !== this.activeTypeFilter) return false;
      }

      // Status filter
      if (this.activeStatusFilter !== 'all') {
        const isOnline = this.isCameraOnline(camera);
        if (this.activeStatusFilter === 'online' && !isOnline) return false;
        if (this.activeStatusFilter === 'offline' && isOnline) return false;
      }

      return true;
    });
  },

  /**
   * Get camera counts by type
   */
  getCameraCounts() {
    const counts = { all: 0, rtsp: 0, rtmp: 0, device: 0, city: 0 };

    for (const camera of this.cameras) {
      counts.all++;
      const type = this.getCameraType(camera);
      counts[type]++;
    }

    return counts;
  },

  /**
   * Set view mode
   */
  setViewMode(mode) {
    this.viewMode = mode;

    // Update button states
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === mode);
    });

    // Update list class
    const list = document.querySelector('.cameras-list');
    if (list) {
      list.classList.toggle('compact-view', mode === 'compact');
      list.classList.toggle('expanded-view', mode === 'expanded');
    }

    this.renderCameras();
  },

  /**
   * Set type filter
   */
  setTypeFilter(type) {
    this.activeTypeFilter = type;

    // Update chip states
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.type === type);
    });

    this.renderCameras();
  },

  /**
   * Set status filter
   */
  setStatusFilter(status) {
    this.activeStatusFilter = status;

    // Update button states
    document.querySelectorAll('.status-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.status === status);
    });

    this.renderCameras();
  },

  /**
   * Toggle card expansion in compact view
   */
  toggleCardExpand(cameraId) {
    const card = document.querySelector(`.camera-card[data-camera-id="${cameraId}"]`);
    if (!card) return;

    const expandBtn = card.querySelector('.expand-btn');

    if (this.expandedCardIds.has(cameraId)) {
      this.expandedCardIds.delete(cameraId);
      card.classList.remove('expanded');
      if (expandBtn) expandBtn.classList.remove('expanded');
    } else {
      this.expandedCardIds.add(cameraId);
      card.classList.add('expanded');
      if (expandBtn) expandBtn.classList.add('expanded');
    }
  },

  /**
   * Load user's cameras from API
   * [PERF] Uses Promise.allSettled for parallel fetching (100-300ms faster)
   */
  async loadCameras() {
    const content = document.querySelector('.dashboard-content');

    try {
      // [PERF] Fetch both endpoints in parallel
      const [camerasResult, sharedResult] = await Promise.allSettled([
        fetch(`${this.apiBase}/me/cameras`, { credentials: 'include' }),
        fetch(`${this.apiBase}/me/shared-cameras`, { credentials: 'include' })
      ]);

      // Process own cameras
      if (camerasResult.status === 'fulfilled' && camerasResult.value.ok) {
        const data = await camerasResult.value.json();
        this.cameras = data.cameras || [];
      } else {
        throw new Error('Failed to load cameras');
      }

      // Process shared cameras (optional - don't fail if it errors)
      if (sharedResult.status === 'fulfilled' && sharedResult.value.ok) {
        const sharedData = await sharedResult.value.json();
        this.sharedCameras = sharedData.cameras || [];
      } else {
        Logger.warn('[MyCameras] Could not load shared cameras');
        this.sharedCameras = [];
      }

      this.renderCameras();

    } catch (error) {
      Logger.error('[MyCameras] Load error:', error);
      content.innerHTML = '<div class="dashboard-error">Kameralar yüklenemedi</div>';
    }
  },

  /**
   * Render filter bar HTML
   */
  renderFilterBar() {
    const counts = this.getCameraCounts();
    const types = [
      { key: 'all', label: 'Tümü' },
      { key: 'rtsp', label: 'RTSP' },
      { key: 'rtmp', label: 'RTMP' },
      { key: 'device', label: 'Device' },
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
    const isExpanded = this.expandedCardIds.has(camera.id);
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
        <button class="btn-primary" onclick="MyCamerasSystem.showClaimModal()">
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

    // Load voice call states after rendering
    setTimeout(() => this.loadVoiceCallStates(), 100);
  },

  /**
   * Show claim camera modal - Unified camera addition
   */
  showClaimModal() {
    const modal = document.createElement('div');
    modal.id = 'claim-modal';
    modal.className = 'claim-modal active';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'claim-modal-title');
    modal.innerHTML = `
      <div class="modal-overlay" onclick="MyCamerasSystem.closeClaimModal()" aria-hidden="true"></div>
      <div class="modal-content" style="max-width: 500px;" role="document">
        <h3 id="claim-modal-title">Yeni Kamera Ekle</h3>

        <div class="form-group">
          <label for="claim-camera-type">Kamera Tipi</label>
          <select id="claim-camera-type" onchange="MyCamerasSystem.toggleCameraTypeInputs()" aria-describedby="camera-type-desc">
            <option value="rtsp">IP Kamera (RTSP)</option>
            <option value="rtmp">RTMP Kamera (GoPro, OBS)</option>
            <option value="device">ESP32-CAM (Device ID)</option>
            <option value="city" id="city-camera-option" style="display: none;">Şehir Kamerası (HLS)</option>
          </select>
          <span id="camera-type-desc" class="sr-only">Eklemek istediğiniz kamera tipini seçin</span>
        </div>

        <!-- RTSP/IP Camera Section -->
        <div id="rtsp-section" role="group" aria-labelledby="rtsp-section-label">
          <span id="rtsp-section-label" class="sr-only">RTSP Kamera Ayarları</span>
          <p class="modal-desc">IP kameranızın RTSP URL'sini girin. Sistem otomatik olarak WebRTC stream ve ONVIF bağlantısı oluşturacak.</p>

          <div class="form-group">
            <label for="rtsp-camera-name">Kamera Adı <span style="color: #999;">(opsiyonel)</span></label>
            <input type="text" id="rtsp-camera-name" placeholder="Örn: Salon Kamerası" autocomplete="off" maxlength="100" aria-describedby="camera-name-hint">
            <small id="camera-name-hint" style="color: #666;">Maksimum 100 karakter</small>
          </div>

          <div class="form-group">
            <label for="rtsp-url">RTSP URL <span style="color: #f44336;" aria-label="zorunlu alan">*</span></label>
            <input type="text" id="rtsp-url" placeholder="rtsp://kullanici:sifre@192.168.1.100:554/stream2" autocomplete="off" style="font-family: monospace; font-size: 12px;" required aria-required="true" aria-describedby="rtsp-url-hint rtsp-url-error" aria-invalid="false">
            <small id="rtsp-url-hint" style="color: #666;">Örn: rtsp://camera:12345678@92.44.163.139:554/stream2</small>
            <span id="rtsp-url-error" class="field-error" style="display: none; color: #f44336; font-size: 12px;" role="alert"></span>
          </div>

          <div id="rtsp-parsed-info" style="display: none; background: #f5f5f5; padding: 12px; border-radius: 6px; margin: 12px 0;">
            <div style="font-weight: 500; margin-bottom: 8px; color: #333; font-size: 13px;">Çıkarılan Bilgiler:</div>
            <div style="display: grid; grid-template-columns: 80px 1fr; gap: 4px; font-size: 12px; color: #666;">
              <span>Host:</span> <span id="parsed-host" style="font-family: monospace;">-</span>
              <span>Kullanıcı:</span> <span id="parsed-username" style="font-family: monospace;">-</span>
              <span>Şifre:</span> <span id="parsed-password" style="font-family: monospace;">***</span>
            </div>
          </div>

          <div class="form-group" style="margin-top: 12px;">
            <label style="display: flex; align-items: center; cursor: pointer;">
              <input type="checkbox" id="rtsp-enable-onvif" checked style="margin-right: 8px; width: 18px; height: 18px;" onchange="MyCamerasSystem.toggleOnvifOptions()">
              <span>ONVIF entegrasyonunu etkinleştir</span>
            </label>
            <small style="color: #666; margin-left: 26px;">Hareket ve insan algılama bildirimleri alın</small>
          </div>

          <div id="onvif-options" style="margin-top: 12px; padding: 12px; background: #f0f7ff; border-radius: 6px; border: 1px solid #cce5ff;" role="group" aria-labelledby="onvif-options-label">
            <span id="onvif-options-label" class="sr-only">ONVIF Seçenekleri</span>
            <div class="form-group" style="margin-bottom: 12px;">
              <label for="rtsp-onvif-profile">Kamera Profili</label>
              <select id="rtsp-onvif-profile" style="width: 100%;" onchange="MyCamerasSystem.onProfileChange()" aria-describedby="profile-hint">
                <option value="1">Generic ONVIF</option>
              </select>
              <small id="profile-hint" style="color: #666;">Kameranızın modeline göre profil seçin. Bu, hangi olayların algılanacağını belirler.</small>
            </div>

            <div class="form-group" style="margin-bottom: 0;">
              <label for="rtsp-onvif-port">ONVIF Port</label>
              <input type="number" id="rtsp-onvif-port" value="2020" min="1" max="65535" style="width: 100px;" aria-describedby="port-hint">
              <small id="port-hint" style="color: #666; margin-left: 8px;">Tapo: 2020 | Diğer: 80, 8080</small>
            </div>
          </div>
        </div>

        <!-- Device ID Section (ESP32-CAM) -->
        <div id="device-id-section" style="display: none;" role="group" aria-labelledby="device-section-label">
          <span id="device-section-label" class="sr-only">ESP32-CAM Cihaz Ayarları</span>
          <p class="modal-desc">ESP32-CAM cihazınızın Device ID'sini girin. Bu ID, kamera ilk bağlandığında serial monitörde görünür.</p>
          <label for="claim-device-id" class="sr-only">Device ID</label>
          <input type="text" id="claim-device-id" placeholder="Örn: 78EC2CEBD724" autocomplete="off" maxlength="20" pattern="[A-Za-z0-9]+" aria-describedby="device-id-hint device-id-error">
          <small id="device-id-hint" style="color: #666; display: block; margin-top: 4px;">12 haneli hexadecimal kod (örn: 78EC2CEBD724)</small>
          <span id="device-id-error" class="field-error" style="display: none; color: #f44336; font-size: 12px;" role="alert"></span>
        </div>

        <!-- RTMP Camera Section (GoPro, OBS, etc.) -->
        <div id="rtmp-section" style="display: none;" role="group" aria-labelledby="rtmp-section-label">
          <span id="rtmp-section-label" class="sr-only">RTMP Kamera Ayarları</span>
          <p class="modal-desc">GoPro, OBS veya RTMP destekli cihazlar için. Size verilen URL'yi cihazınızda kullanın.</p>

          <div class="form-group">
            <label for="rtmp-camera-name">Kamera Adı <span style="color: #999;">(opsiyonel)</span></label>
            <input type="text" id="rtmp-camera-name" placeholder="Örn: GoPro Hero 12" autocomplete="off" maxlength="100">
            <small style="color: #666;">Bu isim kamera listesinde görünecek</small>
          </div>

          <div style="background: #fff3e0; padding: 12px; border-radius: 6px; border: 1px solid #ffe0b2; margin-top: 12px;">
            <div style="display: flex; align-items: flex-start; gap: 8px;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f57c00" stroke-width="2" style="flex-shrink: 0; margin-top: 2px;">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <div style="font-size: 13px; color: #e65100;">
                <strong>Nasıl Çalışır?</strong><br>
                Kamerayı ekledikten sonra size bir RTMP URL'si verilecek. Bu URL'yi GoPro veya OBS ayarlarına girin.
              </div>
            </div>
          </div>
        </div>

        <!-- City Camera Section (HLS - Admin Only) -->
        <div id="city-section" style="display: none;" role="group" aria-labelledby="city-section-label">
          <span id="city-section-label" class="sr-only">Şehir Kamerası Ayarları</span>
          <p class="modal-desc">Belediye veya kamu kurumlarının HLS yayın URL'sini girin. Bu kameralar herkese açık olarak eklenir.</p>

          <div class="form-group">
            <label for="city-camera-name">Kamera Adı <span style="color: #999;">(opsiyonel)</span></label>
            <input type="text" id="city-camera-name" placeholder="Örn: Üsküdar Meydanı" autocomplete="off" maxlength="100">
            <small style="color: #666;">Bu isim haritada ve kamera listesinde görünecek</small>
          </div>

          <div class="form-group">
            <label for="city-hls-url">HLS URL <span style="color: #f44336;" aria-label="zorunlu alan">*</span></label>
            <input type="text" id="city-hls-url" placeholder="https://livestream.ibb.gov.tr/cam_turistik/b_uskudar.stream/chunklist.m3u8" autocomplete="off" style="font-family: monospace; font-size: 11px;" required aria-required="true" aria-describedby="hls-url-hint">
            <small id="hls-url-hint" style="color: #666;">URL .m3u8 dosyası içermelidir (query parametreleri olabilir)</small>
          </div>

          <div style="background: #e0f2fe; padding: 12px; border-radius: 6px; border: 1px solid #7dd3fc; margin-top: 12px;">
            <div style="display: flex; align-items: flex-start; gap: 8px;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0284c7" stroke-width="2" style="flex-shrink: 0; margin-top: 2px;">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
              <div style="font-size: 13px; color: #0369a1;">
                <strong>Şehir Kamerası</strong><br>
                Bu kamera herkese açık olarak eklenir ve haritada mavi ikon ile gösterilir.
              </div>
            </div>
          </div>
        </div>

        <div class="modal-actions">
          <button type="button" class="btn-secondary" onclick="MyCamerasSystem.closeClaimModal()" aria-label="İptal et ve kapat">İptal</button>
          <button type="submit" class="btn-primary" id="claim-submit-btn" onclick="MyCamerasSystem.claimCamera()" aria-describedby="claim-error">
            <span class="btn-text">Ekle</span>
            <span class="btn-loading" style="display: none;" aria-hidden="true">
              <svg class="spinner-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
                <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path>
              </svg>
              Ekleniyor...
            </span>
          </button>
        </div>
        <div id="claim-error" class="claim-error" role="alert" aria-live="polite"></div>
        <div id="claim-progress" style="display: none; margin-top: 12px; padding: 12px; background: #e3f2fd; border-radius: 6px; font-size: 13px;" role="status" aria-live="polite">
          <div style="display: flex; align-items: center;">
            <div class="spinner" style="width: 16px; height: 16px; border: 2px solid #2196F3; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; margin-right: 8px;" aria-hidden="true"></div>
            <span id="claim-progress-text">Kamera ekleniyor...</span>
          </div>
        </div>
      </div>
      <style>
        @keyframes spin { to { transform: rotate(360deg); } }
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
        .btn-loading .spinner-icon { animation: spin 1s linear infinite; }
        .field-error { margin-top: 4px; display: block; }
        input:invalid:not(:placeholder-shown) { border-color: #f44336; }
        input:valid:not(:placeholder-shown) { border-color: #4caf50; }
      </style>
    `;
    document.body.appendChild(modal);

    // Add RTSP URL parser listener
    document.getElementById('rtsp-url').addEventListener('input', (e) => {
      this.parseRtspUrlForModal(e.target.value);
    });

    // Load ONVIF profiles
    this.loadOnvifProfiles();

    // Check admin status to show city camera option
    this.checkAdminForCityCamera();

    document.getElementById('rtsp-camera-name').focus();
  },

  /**
   * Check if current user is admin and show city camera option
   */
  async checkAdminForCityCamera() {
    try {
      const response = await fetch(`${this.apiBase}/me`, { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        if (data.role === 'admin') {
          const cityOption = document.getElementById('city-camera-option');
          if (cityOption) {
            cityOption.style.display = '';
          }
        }
      }
    } catch (e) {
      Logger.error('[MyCameras] Failed to check admin status:', e);
    }
  },

  /**
   * Load ONVIF profiles from API
   */
  async loadOnvifProfiles() {
    try {
      const response = await fetch(`${QBitmapConfig.api.onvif}/templates`, {
        credentials: 'include'
      });

      if (!response.ok) return;

      const data = await response.json();
      const profiles = data.templates || [];

      const select = document.getElementById('rtsp-onvif-profile');
      if (!select) return;

      select.innerHTML = profiles.map(p =>
        `<option value="${p.id}" data-port="${p.onvifPort}">${p.manufacturer} - ${p.modelName}</option>`
      ).join('');

      // Store profiles for later use
      this._onvifProfiles = profiles;

    } catch (error) {
      Logger.error('[MyCameras] Failed to load ONVIF profiles:', error);
    }
  },

  /**
   * Toggle ONVIF options visibility
   */
  toggleOnvifOptions() {
    const enabled = document.getElementById('rtsp-enable-onvif').checked;
    const optionsDiv = document.getElementById('onvif-options');
    if (optionsDiv) {
      optionsDiv.style.display = enabled ? 'block' : 'none';
    }
  },

  /**
   * Handle profile change - auto-fill ONVIF port
   */
  onProfileChange() {
    const select = document.getElementById('rtsp-onvif-profile');
    const portInput = document.getElementById('rtsp-onvif-port');

    if (!select || !portInput) return;

    const selectedOption = select.options[select.selectedIndex];
    const defaultPort = selectedOption?.dataset?.port;

    if (defaultPort) {
      portInput.value = defaultPort;
    }
  },

  /**
   * Parse RTSP URL and show extracted info in modal
   */
  parseRtspUrlForModal(url) {
    const infoDiv = document.getElementById('rtsp-parsed-info');
    const hostSpan = document.getElementById('parsed-host');
    const usernameSpan = document.getElementById('parsed-username');
    const passwordSpan = document.getElementById('parsed-password');

    if (!url || !url.startsWith('rtsp://')) {
      infoDiv.style.display = 'none';
      return;
    }

    try {
      const withoutProtocol = url.replace('rtsp://', '');
      const atIndex = withoutProtocol.indexOf('@');

      if (atIndex === -1) {
        infoDiv.style.display = 'none';
        return;
      }

      // [SECURITY] Only extract host for display, never credentials
      const hostPart = withoutProtocol.substring(atIndex + 1).split('/')[0];
      const host = hostPart.split(':')[0];

      // Check if credentials exist without extracting them
      const credentialPart = withoutProtocol.substring(0, atIndex);
      const hasPassword = credentialPart.includes(':');

      if (!hasPassword) {
        infoDiv.style.display = 'none';
        return;
      }

      // Display masked info - never expose actual credentials
      hostSpan.textContent = host;
      usernameSpan.textContent = '(embedded)';
      passwordSpan.textContent = '********';
      infoDiv.style.display = 'block';

    } catch (e) {
      infoDiv.style.display = 'none';
    }
  },

  /**
   * Toggle camera type inputs visibility
   */
  toggleCameraTypeInputs() {
    const cameraType = document.getElementById('claim-camera-type').value;
    const deviceSection = document.getElementById('device-id-section');
    const rtspSection = document.getElementById('rtsp-section');
    const rtmpSection = document.getElementById('rtmp-section');
    const citySection = document.getElementById('city-section');

    // Hide all sections first
    deviceSection.style.display = 'none';
    rtspSection.style.display = 'none';
    rtmpSection.style.display = 'none';
    citySection.style.display = 'none';

    if (cameraType === 'rtsp') {
      rtspSection.style.display = 'block';
      document.getElementById('rtsp-camera-name').focus();
    } else if (cameraType === 'rtmp') {
      rtmpSection.style.display = 'block';
      document.getElementById('rtmp-camera-name').focus();
    } else if (cameraType === 'city') {
      citySection.style.display = 'block';
      document.getElementById('city-camera-name').focus();
    } else {
      deviceSection.style.display = 'block';
      document.getElementById('claim-device-id').focus();
    }
  },

  /**
   * Close claim modal
   */
  closeClaimModal() {
    // Prevent closing during async submission
    if (this._isSubmitting) {
      return;
    }
    const modal = document.getElementById('claim-modal');
    if (modal) modal.remove();
  },

  /**
   * Show RTMP URL modal after camera creation
   * @param {string} rtmpUrl - The RTMP URL for publishing
   * @param {string} cameraName - Camera name for display
   */
  showRtmpUrlModal(rtmpUrl, cameraName) {
    this._rtmpUrl = rtmpUrl;
    const modal = document.createElement('div');
    modal.id = 'rtmp-url-modal';
    modal.className = 'claim-modal active';
    modal.innerHTML = `
      <div class="modal-overlay" onclick="MyCamerasSystem.closeRtmpUrlModal()"></div>
      <div class="modal-content" style="max-width: 550px;">
        <h3>RTMP Kamera Oluşturuldu</h3>
        <p class="modal-desc"><strong>${escapeHtml(cameraName)}</strong> için RTMP URL'si:</p>

        <div style="background: #1a1a2e; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <code id="rtmp-url-display" style="color: #4fc3f7; font-size: 13px; word-break: break-all; display: block; user-select: all;">${escapeHtml(rtmpUrl)}</code>
        </div>

        <button class="btn-primary" onclick="MyCamerasSystem.copyRtmpUrl()" style="width: 100%;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px;">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          URL'yi Kopyala
        </button>

        <div style="margin-top: 16px; padding: 12px; background: #f5f5f5; border-radius: 6px; font-size: 13px;">
          <strong>GoPro Hero 12 için:</strong>
          <ol style="margin: 8px 0 0 0; padding-left: 20px; color: #555;">
            <li>GoPro uygulamasını açın</li>
            <li>Preferences > Connections > Live Stream</li>
            <li>"RTMP" seçin ve bu URL'yi yapıştırın</li>
            <li>Yayını başlatın</li>
          </ol>
        </div>

        <div style="margin-top: 12px; padding: 12px; background: #e3f2fd; border-radius: 6px; font-size: 13px;">
          <strong>OBS Studio için:</strong>
          <ol style="margin: 8px 0 0 0; padding-left: 20px; color: #555;">
            <li>Settings > Stream</li>
            <li>Service: Custom</li>
            <li>Server: Bu URL'yi yapıştırın</li>
            <li>Stream Key: Boş bırakın</li>
          </ol>
        </div>

        <div class="modal-actions" style="margin-top: 16px;">
          <button class="btn-secondary" onclick="MyCamerasSystem.closeRtmpUrlModal()">Kapat</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  },

  /**
   * Copy RTMP URL to clipboard
   */
  copyRtmpUrl() {
    if (this._rtmpUrl) {
      navigator.clipboard.writeText(this._rtmpUrl).then(() => {
        AuthSystem.showNotification('RTMP URL kopyalandı', 'success');
      }).catch(() => {
        AuthSystem.showNotification('Kopyalama başarısız', 'error');
      });
    }
  },

  /**
   * Close RTMP URL modal
   */
  closeRtmpUrlModal() {
    const modal = document.getElementById('rtmp-url-modal');
    if (modal) modal.remove();
    this._rtmpUrl = null;
  },

  /**
   * Claim a camera (RTSP or Device)
   */
  async claimCamera() {
    // Double-submit protection
    if (this._isSubmitting) {
      return;
    }

    const cameraType = document.getElementById('claim-camera-type').value;
    const errorDiv = document.getElementById('claim-error');
    const progressDiv = document.getElementById('claim-progress');
    const progressText = document.getElementById('claim-progress-text');
    const submitBtn = document.getElementById('claim-submit-btn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoading = submitBtn.querySelector('.btn-loading');

    // Helper: Show field error with ARIA
    const showFieldError = (fieldId, errorId, message) => {
      const field = document.getElementById(fieldId);
      const errorSpan = document.getElementById(errorId);
      if (field) {
        field.setAttribute('aria-invalid', 'true');
        field.focus();
      }
      if (errorSpan) {
        errorSpan.textContent = message;
        errorSpan.style.display = 'block';
      }
      errorDiv.textContent = message;
    };

    // Helper: Clear field error
    const clearFieldError = (fieldId, errorId) => {
      const field = document.getElementById(fieldId);
      const errorSpan = document.getElementById(errorId);
      if (field) field.setAttribute('aria-invalid', 'false');
      if (errorSpan) {
        errorSpan.textContent = '';
        errorSpan.style.display = 'none';
      }
    };

    // Helper: Set loading state
    const setLoading = (loading) => {
      submitBtn.disabled = loading;
      submitBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
      if (btnText) btnText.style.display = loading ? 'none' : 'inline';
      if (btnLoading) btnLoading.style.display = loading ? 'inline-flex' : 'none';
      progressDiv.style.display = loading ? 'block' : 'none';
    };

    errorDiv.textContent = '';
    clearFieldError('rtsp-url', 'rtsp-url-error');
    clearFieldError('claim-device-id', 'device-id-error');

    try {
      this._isSubmitting = true;
      let response;

      if (cameraType === 'rtsp') {
        // RTSP/IP Camera - Unified flow
        const name = document.getElementById('rtsp-camera-name').value.trim();
        const rtspUrl = document.getElementById('rtsp-url').value.trim();
        const onvifPort = parseInt(document.getElementById('rtsp-onvif-port').value) || 2020;
        const enableOnvif = document.getElementById('rtsp-enable-onvif').checked;
        const profileSelect = document.getElementById('rtsp-onvif-profile');
        const onvifTemplateId = profileSelect ? parseInt(profileSelect.value) : 1;

        if (!rtspUrl) {
          showFieldError('rtsp-url', 'rtsp-url-error', 'RTSP URL gerekli');
          return;
        }

        if (!rtspUrl.startsWith('rtsp://')) {
          showFieldError('rtsp-url', 'rtsp-url-error', 'URL rtsp:// ile başlamalı');
          return;
        }

        // Validate that URL has credentials
        if (!rtspUrl.includes('@')) {
          showFieldError('rtsp-url', 'rtsp-url-error', 'RTSP URL kullanıcı adı ve şifre içermeli (rtsp://user:pass@host)');
          return;
        }

        // Show progress with loading state
        setLoading(true);
        progressText.textContent = 'Stream sunucusuna ekleniyor...';

        // Clear sensitive data from DOM immediately after capturing
        // This prevents credentials from being visible in DevTools
        const rtspInput = document.getElementById('rtsp-url');
        if (rtspInput) rtspInput.value = '';

        response = await fetch(`${this.apiBase}/me/cameras/rtsp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            name: name || 'IP Kamera',
            rtsp_url: rtspUrl,
            onvif_port: onvifPort,
            enable_onvif: enableOnvif,
            onvif_template_id: enableOnvif ? onvifTemplateId : undefined
          })
        });
      } else if (cameraType === 'rtmp') {
        // RTMP Camera (GoPro, OBS, etc.)
        const name = document.getElementById('rtmp-camera-name').value.trim();

        setLoading(true);
        progressText.textContent = 'RTMP path oluşturuluyor...';

        response = await fetch(`${this.apiBase}/me/cameras/rtmp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            name: name || 'RTMP Kamera'
          })
        });
      } else if (cameraType === 'city') {
        // City Camera (HLS - Admin Only)
        const name = document.getElementById('city-camera-name').value.trim();
        const hlsUrl = document.getElementById('city-hls-url').value.trim();

        if (!hlsUrl) {
          errorDiv.textContent = 'HLS URL gerekli';
          return;
        }

        try {
          const urlObj = new URL(hlsUrl);
          if (!urlObj.pathname.endsWith('.m3u8')) {
            errorDiv.textContent = 'URL .m3u8 dosyasına işaret etmelidir';
            return;
          }
          if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
            errorDiv.textContent = 'URL http:// veya https:// ile başlamalı';
            return;
          }
        } catch (e) {
          errorDiv.textContent = 'Geçersiz URL formatı';
          return;
        }

        setLoading(true);
        progressText.textContent = 'Şehir kamerası ekleniyor...';

        response = await fetch(`${QBitmapConfig.api.admin}/cameras/city`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            name: name || 'Şehir Kamerası',
            hls_url: hlsUrl
          })
        });
      } else {
        // Device camera (ESP32-CAM)
        const input = document.getElementById('claim-device-id');
        const deviceId = input.value.trim().toUpperCase();

        if (!deviceId) {
          showFieldError('claim-device-id', 'device-id-error', 'Device ID gerekli');
          return;
        }

        // Validate device ID format (12 hex characters)
        if (!/^[A-F0-9]{12}$/.test(deviceId)) {
          showFieldError('claim-device-id', 'device-id-error', 'Device ID 12 haneli hexadecimal olmalı (örn: 78EC2CEBD724)');
          return;
        }

        setLoading(true);
        progressText.textContent = 'Cihaz ekleniyor...';

        response = await fetch(`${this.apiBase}/me/cameras/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ device_id: deviceId })
        });
      }

      const data = await response.json();

      if (!response.ok) {
        setLoading(false);
        // Show field-specific error if applicable
        if (cameraType === 'rtsp' && (data.error?.includes('URL') || data.error?.includes('RTSP') || data.error?.includes('IP'))) {
          showFieldError('rtsp-url', 'rtsp-url-error', data.error || data.details || 'Kamera eklenemedi');
        } else if (cameraType === 'device' && data.error?.includes('Device')) {
          showFieldError('claim-device-id', 'device-id-error', data.error || data.details || 'Cihaz eklenemedi');
        } else {
          errorDiv.textContent = data.error || data.details || 'Kamera eklenemedi';
        }
        return;
      }

      // Success - reset loading and submission flag before closing modal
      setLoading(false);
      this._isSubmitting = false;
      this.closeClaimModal();

      Analytics.event('camera_add', { camera_type: cameraType });

      // Show appropriate success message
      if (cameraType === 'rtsp') {
        const onvifStatus = data.camera?.onvif_linked ? ' (ONVIF bağlandı)' : '';
        AuthSystem.showNotification(`Kamera başarıyla eklendi${onvifStatus}`, 'success');
      } else if (cameraType === 'rtmp') {
        // Show RTMP URL modal for user to copy
        if (data.camera?.rtmp_url) {
          this.showRtmpUrlModal(data.camera.rtmp_url, data.camera.name);
        } else {
          AuthSystem.showNotification('RTMP kamera eklendi', 'success');
        }
      } else if (cameraType === 'city') {
        AuthSystem.showNotification('Şehir kamerası başarıyla eklendi', 'success');
      } else {
        AuthSystem.showNotification('Cihaz başarıyla eklendi', 'success');
      }

      await this.loadCameras();

    } catch (error) {
      Logger.error('[MyCameras] Claim error:', error);
      errorDiv.textContent = 'Bir hata oluştu: ' + error.message;
      // Reset loading state on error
      const submitBtn = document.getElementById('claim-submit-btn');
      const btnText = submitBtn?.querySelector('.btn-text');
      const btnLoading = submitBtn?.querySelector('.btn-loading');
      const progressDiv = document.getElementById('claim-progress');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.setAttribute('aria-busy', 'false');
      }
      if (btnText) btnText.style.display = 'inline';
      if (btnLoading) btnLoading.style.display = 'none';
      if (progressDiv) progressDiv.style.display = 'none';
    } finally {
      this._isSubmitting = false;
    }
  },

  /**
   * Open camera popup on map and start recording
   */
  async openAndRecord(deviceId, lng, lat) {
    // Close dashboard
    this.close();

    // Check if camera has coordinates
    if (!lng || !lat) {
      AuthSystem.showNotification('Kameranın konumu belirlenmemiş', 'error');
      return;
    }

    // Fly to camera location
    if (window.map) {
      window.map.flyTo({
        center: [lng, lat],
        zoom: 17,
        essential: true
      });

      // Wait for map to settle, then open popup and start recording
      setTimeout(() => {
        // Find camera in CameraSystem
        if (window.CameraSystem) {
          const camera = CameraSystem.cameras.find(c => c.device_id === deviceId);
          if (camera) {
            // Open popup
            CameraSystem.openCameraPopup(camera, [lng, lat]);

            // Start recording after popup opens
            setTimeout(() => {
              CameraSystem.toggleRecording(deviceId);
              AuthSystem.showNotification('Kayıt başlatıldı', 'success');
            }, 1000);
          } else {
            AuthSystem.showNotification('Kamera haritada bulunamadı', 'error');
          }
        }
      }, 1500);
    }
  },

  /**
   * Open recordings modal for WHEP camera
   */
  openRecordings(deviceId) {
    const camera = this.cameras.find(c => c.device_id === deviceId);
    if (!camera) {
      AuthSystem.showNotification('Kamera bulunamadı', 'error');
      return;
    }

    // Use CameraSystem's recordings modal but pass camera data
    if (window.CameraSystem && typeof CameraSystem.openRecordingsModalWithCamera === 'function') {
      CameraSystem.openRecordingsModalWithCamera(camera);
    } else if (window.CameraSystem && typeof CameraSystem.openRecordingsModal === 'function') {
      // Temporarily add camera to CameraSystem.cameras if not present
      const existingCamera = CameraSystem.cameras.find(c => c.device_id === deviceId);
      if (!existingCamera) {
        CameraSystem.cameras.push(camera);
      }
      CameraSystem.openRecordingsModal(deviceId);
    } else {
      AuthSystem.showNotification('Kayıtlar modülü yüklenemedi', 'error');
    }
  },

  /**
   * Open camera settings for WHEP camera
   */
  openCameraSettings(deviceId, cameraId = null) {
    if (window.CameraSystem && CameraSystem.openSettings) {
      CameraSystem.openSettings(deviceId, cameraId);
    } else {
      AuthSystem.showNotification('Ayarlar açılamadı', 'error');
    }
  },

  /**
   * Pick location from map for ID-based camera
   */
  async pickCameraLocation(deviceId, cameraId) {
    const self = this;

    // Close dashboard panel if open
    const dashboardPanel = document.querySelector('.dashboard-panel');
    if (dashboardPanel) {
      dashboardPanel.classList.remove('open');
    }

    // Show instruction toast
    AuthSystem.showNotification('Haritada bir noktaya tiklayarak kamera konumunu belirleyin. Iptal icin ESC tuslayın.', 'info', 5000);

    // Change cursor to crosshair
    if (window.map) {
      map.getCanvas().style.cursor = 'crosshair';
    }

    // Set picking state
    this._isPickingLocation = true;
    this._pickingDeviceId = deviceId;
    this._pickingCameraId = cameraId;

    // Handle map click
    const handleMapClick = async function(e) {
      if (!self._isPickingLocation) return;

      self._isPickingLocation = false;
      const lat = e.lngLat.lat;
      const lng = e.lngLat.lng;

      // Reset cursor
      if (window.map) {
        map.getCanvas().style.cursor = '';
      }

      // Remove listeners
      if (window.map) {
        map.off('click', handleMapClick);
      }
      document.removeEventListener('keydown', handleEscKey);

      // Save location to API
      try {
        const response = await fetch(`${QBitmapConfig.api.users}/me/cameras/${cameraId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ lat, lng })
        });

        if (response.ok) {
          AuthSystem.showNotification('Konum kaydedildi', 'success');
          // Update local camera data
          const camera = self.cameras.find(c => c.id === cameraId);
          if (camera) {
            camera.lat = lat;
            camera.lng = lng;
          }
          // Refresh cameras display
          self.renderCameras();
          // Update map layer if CameraSystem is available
          if (window.CameraSystem && CameraSystem.refreshCameras) {
            CameraSystem.refreshCameras();
          }
        } else {
          const data = await response.json();
          AuthSystem.showNotification(data.error || 'Konum kaydedilemedi', 'error');
        }
      } catch (err) {
        console.error('Error saving camera location:', err);
        AuthSystem.showNotification('Konum kaydedilemedi', 'error');
      }
    };

    // Handle ESC key to cancel
    const handleEscKey = function(e) {
      if (e.key === 'Escape' && self._isPickingLocation) {
        self._isPickingLocation = false;

        // Reset cursor
        if (window.map) {
          map.getCanvas().style.cursor = '';
          map.off('click', handleMapClick);
        }
        document.removeEventListener('keydown', handleEscKey);

        AuthSystem.showNotification('Konum secimi iptal edildi', 'info');
      }
    };

    // Register listeners
    if (window.map) {
      map.once('click', handleMapClick);
    }
    document.addEventListener('keydown', handleEscKey);
  },

  /**
   * Open face recognition modal for camera
   */
  async openFaceRecognition(deviceId) {
    const camera = this.cameras.find(c => c.device_id === deviceId);
    if (!camera) {
      AuthSystem.showNotification('Kamera bulunamadı', 'error');
      return;
    }

    this.faceRecognitionCameraId = deviceId;

    // Create modal
    let modal = document.getElementById('face-recognition-modal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'face-recognition-modal';
    modal.className = 'claim-modal active';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:3000;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div class="modal-overlay" onclick="MyCamerasSystem.closeFaceRecognitionModal()" style="position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);"></div>
      <div class="modal-content face-modal-content" style="position:relative;width:480px;max-width:calc(100% - 32px);max-height:90vh;overflow-y:auto;background:white;padding:24px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.2);z-index:1;">
        <div class="face-modal-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
          <h3 style="margin:0;font-size:18px;color:#202124;">Yüz Tanıma - ${escapeHtml(camera.name || camera.device_id)}</h3>
          <button class="close-btn" onclick="MyCamerasSystem.closeFaceRecognitionModal()" style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;background:none;border:none;font-size:24px;color:#5f6368;cursor:pointer;border-radius:50%;">&times;</button>
        </div>

        <div class="face-toggle-row" style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#f8f9fa;border-radius:8px;margin-bottom:20px;">
          <label class="toggle-label" style="display:flex;align-items:center;gap:12px;cursor:pointer;">
            <span style="font-size:14px;font-weight:500;color:#3c4043;">Yüz Algılama</span>
            <input type="checkbox" id="face-detection-toggle" onchange="MyCamerasSystem.toggleFaceDetection()">
          </label>
          <select id="face-detection-interval" onchange="MyCamerasSystem.updateFaceInterval()" style="padding:6px 12px;border:1px solid #dadce0;border-radius:6px;font-size:13px;background:white;">
            <option value="5">5 saniye</option>
            <option value="10" selected>10 saniye</option>
            <option value="30">30 saniye</option>
            <option value="60">60 saniye</option>
          </select>
        </div>

        <div class="face-section" style="margin-bottom:20px;">
          <h4 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#3c4043;">Referans Yüzler</h4>
          <div class="faces-hint" style="font-size:11px;color:#9aa0a6;margin-bottom:10px;">🔔 işaretli yüzler algılandığında alarm verilir</div>
          <div class="faces-grid" id="faces-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,80px));gap:12px;">
            <div class="face-loading">Yükleniyor...</div>
          </div>
        </div>

        <div class="face-section" style="margin-bottom:20px;">
          <h4 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#3c4043;">Yeni Yüz Ekle</h4>
          <div class="add-face-form" style="display:flex;gap:6px;align-items:center;">
            <input type="text" id="face-name-input" placeholder="İsim" maxlength="50" style="flex:1;padding:6px 10px;border:1px solid #dadce0;border-radius:4px;font-size:12px;">
            <div class="face-upload-area" id="face-upload-area" onclick="document.getElementById('face-file-input').click()" style="display:flex;align-items:center;gap:4px;padding:6px 10px;border:1px dashed #dadce0;border-radius:4px;cursor:pointer;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5f6368" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="17 8 12 3 7 8"></polyline>
                <line x1="12" y1="3" x2="12" y2="15"></line>
              </svg>
              <span style="font-size:11px;color:#5f6368;">Fotoğraf Seç</span>
            </div>
            <input type="file" id="face-file-input" accept="image/jpeg,image/png" style="display:none" onchange="MyCamerasSystem.handleFaceFileSelect(event)">
            <button class="btn-primary btn-sm" id="add-face-btn" onclick="MyCamerasSystem.addFace()" disabled style="padding:6px 12px;background:#333;color:white;border:none;border-radius:4px;font-size:13px;cursor:pointer;">Ekle</button>
          </div>
          <div id="face-preview-container" class="face-preview-container" style="display:none;margin-top:6px;">
            <img id="face-preview-img" alt="Preview" style="width:40px;height:40px;object-fit:cover;border-radius:6px;">
            <button class="face-preview-remove" onclick="MyCamerasSystem.clearFacePreview()" style="width:20px;height:20px;background:#f1f3f4;border:none;border-radius:50%;cursor:pointer;">&times;</button>
          </div>
        </div>

        <div class="face-section" style="margin-bottom:20px;">
          <h4 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#3c4043;">Son Algılamalar</h4>
          <div class="detection-log" id="detection-log" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:12px;background:rgba(0,0,0,0.02);border-radius:12px;">
            <div class="detection-empty" style="grid-column:1/-1;padding:30px;text-align:center;color:#9aa0a6;font-size:12px;">Henüz algılama yok</div>
          </div>
        </div>

        <div id="face-error" class="claim-error"></div>
      </div>
    `;
    document.body.appendChild(modal);

    // Load settings and faces
    await this.loadFaceRecognitionData(deviceId);
  },

  /**
   * Load face recognition settings and faces
   */
  async loadFaceRecognitionData(deviceId) {
    try {
      // Load settings
      const settingsRes = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/settings`, {
        credentials: 'include'
      });
      if (settingsRes.ok) {
        const settings = await settingsRes.json();
        document.getElementById('face-detection-toggle').checked = settings.enabled;
        document.getElementById('face-detection-interval').value = settings.interval || 10;
      }

      // Load faces
      const facesRes = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/faces`, {
        credentials: 'include'
      });
      if (facesRes.ok) {
        const data = await facesRes.json();
        this.renderFacesGrid(data.faces || []);
      }

      // Load logs (8 items for 4x2 grid)
      const logsRes = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/logs?limit=8`, {
        credentials: 'include'
      });
      if (logsRes.ok) {
        const data = await logsRes.json();
        this.renderDetectionLog(data.logs || []);
      }
    } catch (error) {
      Logger.error('[FaceRecognition] Load error:', error);
    }
  },

  /**
   * Render faces grid
   */
  renderFacesGrid(faces) {
    const grid = document.getElementById('faces-grid');
    if (!grid) return;

    if (faces.length === 0) {
      grid.innerHTML = `
        <div class="face-empty">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="8" r="4"></circle>
            <path d="M20 21a8 8 0 0 0-16 0"></path>
          </svg>
          <span>Referans yüz yok</span>
        </div>
      `;
      return;
    }

    // Show last 8 faces (4x2 grid)
    const displayFaces = faces.slice(-8);
    grid.innerHTML = displayFaces.map(face => `
      <div class="face-thumbnail ${face.trigger_alarm ? 'alarm-active' : ''}" data-face-id="${face.id}">
        <img src="${escapeHtml(face.face_image_url || '')}" alt="${escapeHtml(face.name)}" onerror="this.onerror=null;this.outerHTML='<div class=\\'face-placeholder\\'>👤</div>';">
        <span class="face-name">${escapeHtml(face.name)}</span>
        <label class="face-alarm-toggle" title="Alarm Ver">
          <input type="checkbox" ${face.trigger_alarm ? 'checked' : ''} onchange="MyCamerasSystem.toggleFaceAlarm(${face.id}, this.checked)">
          <span class="alarm-icon">🔔</span>
        </label>
        <button class="face-remove-btn" onclick="MyCamerasSystem.removeFace(${face.id})" title="Sil">&times;</button>
      </div>
    `).join('');
  },

  /**
   * Render detection log
   */
  renderDetectionLog(logs) {
    const logEl = document.getElementById('detection-log');
    if (!logEl) return;

    if (logs.length === 0) {
      logEl.innerHTML = '<div class="detection-empty">Henüz algılama yok</div>';
      return;
    }

    // Show last 8 logs (4x2 grid with thumbnails)
    logEl.innerHTML = logs.slice(0, 8).map(log => {
      const date = new Date(log.detected_at);
      const timeStr = date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      const dateStr = date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
      const name = log.person_name || log.name || 'Bilinmeyen';
      const thumbHtml = log.face_image_url
        ? `<img src="${log.face_image_url}" alt="${escapeHtml(name)}" class="detection-thumb" onerror="this.onerror=null;this.outerHTML='<div class=\\'detection-thumb-placeholder\\'>👤</div>';">`
        : `<div class="detection-thumb-placeholder">👤</div>`;
      return `
        <div class="detection-item">
          ${thumbHtml}
          <div class="detection-info">
            <span class="detection-name">${escapeHtml(name)}</span>
            <span class="detection-score">Skor: ${Math.round(log.confidence)}</span>
            <span class="detection-time">${dateStr} ${timeStr}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  /**
   * Toggle face detection
   */
  async toggleFaceDetection() {
    const enabled = document.getElementById('face-detection-toggle').checked;
    const interval = parseInt(document.getElementById('face-detection-interval').value);

    try {
      // Update backend settings
      await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${this.faceRecognitionCameraId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled, interval })
      });

      // Start/stop face detection loop in browser
      if (window.CameraSystem) {
        if (enabled) {
          // Ensure camera is in CameraSystem.cameras before starting face detection
          const myCamera = this.cameras.find(c => c.device_id === this.faceRecognitionCameraId);

          if (!Array.isArray(CameraSystem.cameras)) {
            CameraSystem.cameras = [];
          }

          if (myCamera && !CameraSystem.cameras.find(c => c.device_id === this.faceRecognitionCameraId)) {
            CameraSystem.cameras.push(myCamera);
          }

          await CameraSystem.startFaceDetection(this.faceRecognitionCameraId, interval);
          AuthSystem.showNotification('Yüz algılama aktif', 'success');
        } else {
          await CameraSystem.stopFaceDetection(this.faceRecognitionCameraId);
          AuthSystem.showNotification('Yüz algılama durduruldu', 'info');
        }
      }
    } catch (error) {
      Logger.error('[FaceRecognition] Toggle error:', error);
    }
  },

  /**
   * Update face detection interval
   */
  async updateFaceInterval() {
    const interval = parseInt(document.getElementById('face-detection-interval').value);
    const enabled = document.getElementById('face-detection-toggle').checked;

    try {
      // Update backend settings
      await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${this.faceRecognitionCameraId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled, interval })
      });

      // Restart face detection with new interval if running
      if (window.CameraSystem && enabled) {
        // [FIX] Ensure camera is in CameraSystem.cameras
        const myCamera = this.cameras.find(c => c.device_id === this.faceRecognitionCameraId);
        if (!Array.isArray(CameraSystem.cameras)) {
          CameraSystem.cameras = [];
        }
        if (myCamera && !CameraSystem.cameras.find(c => c.device_id === this.faceRecognitionCameraId)) {
          CameraSystem.cameras.push(myCamera);
          Logger.log(`[FaceRecognition] Added camera for interval update:`, myCamera.device_id);
        }
        await CameraSystem.updateFaceDetectionSettings(this.faceRecognitionCameraId, enabled, interval);
      }
    } catch (error) {
      Logger.error('[FaceRecognition] Interval update error:', error);
    }
  },

  /**
   * Toggle alarm for a face
   */
  async toggleFaceAlarm(faceId, enabled) {
    try {
      const response = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${this.faceRecognitionCameraId}/faces/${faceId}/alarm`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ trigger_alarm: enabled })
      });

      if (response.ok) {
        // Update thumbnail class
        const thumb = document.querySelector(`.face-thumbnail[data-face-id="${faceId}"]`);
        if (thumb) {
          thumb.classList.toggle('alarm-active', enabled);
        }
        AuthSystem.showNotification(enabled ? 'Alarm aktif' : 'Alarm kapatıldı', 'success');
      }
    } catch (error) {
      Logger.error('[FaceRecognition] Toggle alarm error:', error);
    }
  },

  /**
   * Handle face file selection
   */
  handleFaceFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    this.selectedFaceFile = file;

    // Show preview
    const reader = new FileReader();
    reader.onload = (e) => {
      document.getElementById('face-preview-img').src = e.target.result;
      document.getElementById('face-preview-container').style.display = 'flex';
      document.getElementById('face-upload-area').style.display = 'none';
      document.getElementById('add-face-btn').disabled = !document.getElementById('face-name-input').value.trim();
    };
    reader.readAsDataURL(file);

    // Enable button if name is filled
    document.getElementById('face-name-input').addEventListener('input', () => {
      document.getElementById('add-face-btn').disabled = !document.getElementById('face-name-input').value.trim() || !this.selectedFaceFile;
    });
  },

  /**
   * Clear face preview
   */
  clearFacePreview() {
    this.selectedFaceFile = null;
    document.getElementById('face-file-input').value = '';
    document.getElementById('face-preview-container').style.display = 'none';
    document.getElementById('face-upload-area').style.display = 'flex';
    document.getElementById('add-face-btn').disabled = true;
  },

  /**
   * Add new reference face
   */
  async addFace() {
    const name = document.getElementById('face-name-input').value.trim();
    const errorDiv = document.getElementById('face-error');
    errorDiv.textContent = '';

    if (!name) {
      errorDiv.textContent = 'İsim gerekli';
      return;
    }

    if (!this.selectedFaceFile) {
      errorDiv.textContent = 'Fotoğraf seçin';
      return;
    }

    const formData = new FormData();
    formData.append('name', name);
    formData.append('image', this.selectedFaceFile);

    try {
      const response = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${this.faceRecognitionCameraId}/faces`, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      const data = await response.json();

      if (!response.ok) {
        errorDiv.textContent = data.error || 'Yüz eklenemedi';
        return;
      }

      // Clear form
      document.getElementById('face-name-input').value = '';
      this.clearFacePreview();

      // Reload faces
      const facesRes = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${this.faceRecognitionCameraId}/faces`, {
        credentials: 'include'
      });
      if (facesRes.ok) {
        const facesData = await facesRes.json();
        this.renderFacesGrid(facesData.faces || []);
      }

      AuthSystem.showNotification('Yüz eklendi', 'success');
    } catch (error) {
      Logger.error('[FaceRecognition] Add face error:', error);
      errorDiv.textContent = 'Bir hata oluştu';
    }
  },

  /**
   * Remove reference face
   */
  async removeFace(faceId) {
    if (!confirm('Bu yüzü silmek istediğinize emin misiniz?')) return;

    try {
      const response = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${this.faceRecognitionCameraId}/faces/${faceId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Delete failed');
      }

      // Remove from grid
      const thumb = document.querySelector(`.face-thumbnail[data-face-id="${faceId}"]`);
      if (thumb) thumb.remove();

      // Check if grid is empty
      const grid = document.getElementById('faces-grid');
      if (grid && !grid.querySelector('.face-thumbnail')) {
        this.renderFacesGrid([]);
      }

      AuthSystem.showNotification('Yüz silindi', 'success');
    } catch (error) {
      Logger.error('[FaceRecognition] Remove face error:', error);
      AuthSystem.showNotification('Yüz silinemedi', 'error');
    }
  },

  /**
   * Close face recognition modal
   */
  closeFaceRecognitionModal() {
    const modal = document.getElementById('face-recognition-modal');
    if (modal) modal.remove();
    this.faceRecognitionCameraId = null;
    this.selectedFaceFile = null;
  },

  /**
   * Start location picking mode
   */
  pickLocation(cameraId) {
    this.editingCameraId = cameraId;
    this.isPickingLocation = true;

    // Close dashboard completely for better map access
    const dashboard = document.getElementById('my-cameras-dashboard');
    if (dashboard) dashboard.classList.remove('active');

    // Show instruction
    const instruction = document.createElement('div');
    instruction.id = 'pick-location-instruction';
    instruction.className = 'pick-location-instruction';
    instruction.innerHTML = `
      <span>Haritada konumu seçmek için tıklayın</span>
      <button onclick="MyCamerasSystem.cancelLocationPick()">İptal</button>
    `;
    document.body.appendChild(instruction);

    // Add map click handler with high priority
    if (window.map) {
      window.map.getCanvas().style.cursor = 'crosshair';

      // Store the handler reference for removal
      this._locationPickHandler = (e) => {
        // Prevent CameraSystem from handling this click
        e.preventDefault && e.preventDefault();
        this.handleLocationPick(e);
      };

      // Use 'click' on map itself (not on layers) for location picking
      window.map.on('click', this._locationPickHandler);
    }
  },

  /**
   * Handle map click for location pick
   */
  async handleLocationPick(e) {
    const { lng, lat } = e.lngLat;

    try {
      const response = await fetch(`${this.apiBase}/me/cameras/${this.editingCameraId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ lng, lat })
      });

      if (!response.ok) {
        throw new Error('Failed to update location');
      }

      AuthSystem.showNotification('Konum güncellendi', 'success');
      await this.loadCameras();

      // Refresh map cameras
      if (typeof CameraSystem !== 'undefined') {
        CameraSystem.loadCameras();
      }

    } catch (error) {
      Logger.error('[MyCameras] Location update error:', error);
      AuthSystem.showNotification('Konum güncellenemedi', 'error');
    }

    this.cancelLocationPick();
  },

  /**
   * Cancel location picking
   */
  cancelLocationPick() {
    this.isPickingLocation = false;

    // Remove click handler
    if (window.map && this._locationPickHandler) {
      window.map.off('click', this._locationPickHandler);
      this._locationPickHandler = null;
    }

    // Restore cursor
    if (window.map) {
      window.map.getCanvas().style.cursor = '';
    }

    // Remove instruction
    const instruction = document.getElementById('pick-location-instruction');
    if (instruction) instruction.remove();

    // Reopen dashboard if we have a camera being edited
    if (this.editingCameraId) {
      const dashboard = document.getElementById('my-cameras-dashboard');
      if (dashboard) dashboard.classList.add('active');
    }

    this.editingCameraId = null;
  },

  /**
   * Show delete confirmation modal
   */
  confirmDeleteCamera(cameraId, cameraName, cameraType) {
    const isWhep = cameraType === 'whep';

    const modal = document.createElement('div');
    modal.id = 'delete-modal';
    modal.className = 'claim-modal active';
    modal.innerHTML = `
      <div class="modal-overlay" onclick="MyCamerasSystem.closeDeleteModal()"></div>
      <div class="modal-content">
        <h3>Kamerayı Sil</h3>
        <p class="modal-desc"><strong>${escapeHtml(cameraName)}</strong> kamerasını silmek istediğinize emin misiniz?</p>

        ${isWhep ? `
        <div class="delete-options">
          <label class="delete-option">
            <input type="checkbox" id="delete-recordings" checked>
            <span>Kayıtları da sil (MediaMTX)</span>
          </label>
          <label class="delete-option">
            <input type="checkbox" id="delete-mediamtx-path" checked>
            <span>MediaMTX path yapılandırmasını sil</span>
          </label>
        </div>
        ` : ''}

        <p class="delete-warning">Bu işlem geri alınamaz!</p>

        <div class="modal-actions">
          <button class="btn-secondary" onclick="MyCamerasSystem.closeDeleteModal()">İptal</button>
          <button class="btn-danger" onclick="MyCamerasSystem.deleteCamera(${cameraId}, ${isWhep})">Sil</button>
        </div>
        <div id="delete-error" class="claim-error"></div>
      </div>
    `;
    document.body.appendChild(modal);
  },

  /**
   * Close delete modal
   */
  closeDeleteModal() {
    const modal = document.getElementById('delete-modal');
    if (modal) modal.remove();
  },

  /**
   * Delete camera
   */
  async deleteCamera(cameraId, isWhep) {
    const errorDiv = document.getElementById('delete-error');

    // Get options for WHEP cameras
    let deleteRecordings = false;
    let deleteMediaMtxPath = false;

    if (isWhep) {
      const recordingsCheckbox = document.getElementById('delete-recordings');
      const pathCheckbox = document.getElementById('delete-mediamtx-path');
      deleteRecordings = recordingsCheckbox ? recordingsCheckbox.checked : false;
      deleteMediaMtxPath = pathCheckbox ? pathCheckbox.checked : false;
    }

    try {
      const response = await fetch(`${this.apiBase}/me/cameras/${cameraId}/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          deleteRecordings,
          deleteMediaMtxPath
        })
      });

      const data = await response.json();

      if (!response.ok) {
        errorDiv.textContent = data.error || 'Kamera silinemedi';
        return;
      }

      this.closeDeleteModal();
      AuthSystem.showNotification('Kamera silindi', 'success');
      await this.loadCameras();

      // Refresh map cameras
      if (typeof CameraSystem !== 'undefined') {
        CameraSystem.loadCameras();
      }

    } catch (error) {
      Logger.error('[MyCameras] Delete error:', error);
      errorDiv.textContent = 'Bir hata oluştu';
    }
  },

  /**
   * Toggle voice call enabled state for camera card
   */
  async toggleVoiceCall(deviceId, voiceBtn) {
    try {
      // Check if user is logged in
      if (!AuthSystem.isLoggedIn()) {
        AuthSystem.showNotification('Bu özellik için giriş yapmanız gerekiyor', 'error');
        return;
      }

      // Get current state from button class
      const currentEnabled = voiceBtn.classList.contains('active');
      const newEnabled = !currentEnabled;

      // Optimistic UI update
      this.updateVoiceButtonState(voiceBtn, newEnabled);

      const response = await fetch(`${QBitmapConfig.api.public}/cameras/${deviceId}/voice-call`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ enabled: newEnabled })
      });

      if (!response.ok) {
        // Revert on error
        this.updateVoiceButtonState(voiceBtn, currentEnabled);
        const error = await response.json().catch(() => ({}));
        AuthSystem.showNotification(error.error || 'Sesli arama ayarı güncellenemedi', 'error');
        return;
      }

      const data = await response.json();
      Logger.log('[VoiceCall] State updated:', data.voiceCallEnabled);
      AuthSystem.showNotification(newEnabled ? 'Sesli arama açıldı' : 'Sesli arama kapatıldı', 'success');

    } catch (error) {
      Logger.error('[VoiceCall] Toggle error:', error);
      AuthSystem.showNotification('Sesli arama ayarı güncellenemedi', 'error');
    }
  },

  /**
   * Update voice button visual state
   */
  updateVoiceButtonState(voiceBtn, enabled) {
    if (enabled) {
      voiceBtn.classList.add('active');
      voiceBtn.title = 'Sesli Arama (Açık)';
    } else {
      voiceBtn.classList.remove('active');
      voiceBtn.title = 'Sesli Arama (Kapalı)';
    }
  },

  /**
   * Load voice call states for all camera cards
   */
  async loadVoiceCallStates() {
    const voiceButtons = document.querySelectorAll('.btn-voice[data-device-id]');

    for (const btn of voiceButtons) {
      const deviceId = btn.dataset.deviceId;
      try {
        const response = await fetch(`${QBitmapConfig.api.public}/cameras/${deviceId}/voice-call`, {
          credentials: 'include'
        });

        if (response.ok) {
          const data = await response.json();
          this.updateVoiceButtonState(btn, data.voiceCallEnabled);
        }
      } catch (error) {
        Logger.error('[VoiceCall] Load state error for', deviceId, error);
      }
    }
  },

  // ==================== CAMERA SHARING ====================

  /**
   * Open share modal for camera
   */
  async openShareModal(cameraId) {
    const camera = this.cameras.find(c => c.id === cameraId);
    if (!camera) return;

    this.sharingCameraId = cameraId;

    const modal = document.createElement('div');
    modal.id = 'share-modal';
    modal.className = 'claim-modal active';
    modal.innerHTML = `
      <div class="modal-overlay" onclick="MyCamerasSystem.closeShareModal()"></div>
      <div class="modal-content">
        <h3>Kamera Paylaş</h3>
        <p class="modal-desc"><strong>${escapeHtml(camera.name)}</strong> kamerasını paylaş</p>

        <div class="share-form">
          <input type="email" id="share-email" placeholder="Email adresi girin" autocomplete="off">
          <button class="btn-primary" onclick="MyCamerasSystem.shareCamera()">Paylaş</button>
        </div>
        <div id="share-error" class="claim-error"></div>

        <div class="share-section">
          <h4>Paylaşılan Kişiler</h4>
          <div class="shares-list" id="shares-list">
            <div class="shares-loading">Yükleniyor...</div>
          </div>
        </div>

        <div class="share-info">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          <span>Paylaşılan kişiler kamerayı sadece izleyebilir</span>
        </div>

        <div class="modal-actions">
          <button class="btn-secondary" onclick="MyCamerasSystem.closeShareModal()">Kapat</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Focus email input
    document.getElementById('share-email').focus();

    // Load current shares
    await this.loadShares(cameraId);
  },

  /**
   * Close share modal
   */
  closeShareModal() {
    const modal = document.getElementById('share-modal');
    if (modal) modal.remove();
    this.sharingCameraId = null;
  },

  /**
   * Load shares for camera
   */
  async loadShares(cameraId) {
    const sharesList = document.getElementById('shares-list');

    try {
      const response = await fetch(`${this.apiBase}/me/cameras/${cameraId}/shares`, {
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed to load shares');

      const data = await response.json();
      const shares = data.shares || [];

      if (shares.length === 0) {
        sharesList.innerHTML = '<div class="shares-empty">Henüz kimseyle paylaşılmadı</div>';
        return;
      }

      sharesList.innerHTML = shares.map(share => `
        <div class="share-item" data-share-id="${share.id}">
          <div class="share-user">
            ${share.shared_with_avatar
              ? `<img src="${escapeHtml(share.shared_with_avatar)}" alt="" class="share-avatar">`
              : `<div class="share-avatar-placeholder">${(share.shared_with_name || share.shared_with_email || '?')[0].toUpperCase()}</div>`
            }
            <div class="share-user-info">
              <span class="share-name">${escapeHtml(share.shared_with_name || share.shared_with_email)}</span>
              ${share.shared_with_name ? `<span class="share-email">${escapeHtml(share.shared_with_email)}</span>` : ''}
            </div>
          </div>
          <button class="btn-danger btn-sm" onclick="MyCamerasSystem.removeShare(${share.id})">Kaldır</button>
        </div>
      `).join('');

    } catch (error) {
      Logger.error('[Share] Load shares error:', error);
      sharesList.innerHTML = '<div class="shares-error">Paylaşımlar yüklenemedi</div>';
    }
  },

  /**
   * Share camera with email
   */
  async shareCamera() {
    const emailInput = document.getElementById('share-email');
    const errorDiv = document.getElementById('share-error');
    const email = emailInput.value.trim();

    errorDiv.textContent = '';

    if (!email) {
      errorDiv.textContent = 'Email adresi gerekli';
      return;
    }

    // Basic email validation
    if (!email.includes('@') || !email.includes('.')) {
      errorDiv.textContent = 'Geçerli bir email adresi girin';
      return;
    }

    try {
      const response = await fetch(`${this.apiBase}/me/cameras/${this.sharingCameraId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email })
      });

      const data = await response.json();

      if (!response.ok) {
        errorDiv.textContent = data.error || 'Paylaşım başarısız';
        return;
      }

      // Clear input and reload shares
      emailInput.value = '';
      await this.loadShares(this.sharingCameraId);
      Analytics.event('camera_share');
      AuthSystem.showNotification('Kamera paylaşıldı', 'success');

    } catch (error) {
      Logger.error('[Share] Share camera error:', error);
      errorDiv.textContent = 'Bir hata oluştu';
    }
  },

  /**
   * Remove share
   */
  async removeShare(shareId) {
    try {
      const response = await fetch(`${this.apiBase}/me/cameras/${this.sharingCameraId}/shares/${shareId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to remove share');
      }

      // Remove from list
      const shareItem = document.querySelector(`.share-item[data-share-id="${shareId}"]`);
      if (shareItem) shareItem.remove();

      // Check if list is empty
      const sharesList = document.getElementById('shares-list');
      if (sharesList && !sharesList.querySelector('.share-item')) {
        sharesList.innerHTML = '<div class="shares-empty">Henüz kimseyle paylaşılmadı</div>';
      }

      AuthSystem.showNotification('Paylaşım kaldırıldı', 'success');

    } catch (error) {
      Logger.error('[Share] Remove share error:', error);
      AuthSystem.showNotification('Paylaşım kaldırılamadı', 'error');
    }
  },

  // ==================== SHARED CAMERA ACTIONS ====================

  /**
   * View shared camera on map (fly to location)
   */
  viewSharedCamera(deviceId, lng, lat) {
    if (!lng || !lat) {
      AuthSystem.showNotification('Kameranın konumu belirlenmemiş', 'error');
      return;
    }

    // Close dashboard
    this.close();

    // Fly to camera location
    if (window.map) {
      window.map.flyTo({
        center: [lng, lat],
        zoom: 17,
        essential: true
      });
    }
  },

  /**
   * Open shared camera popup
   */
  openSharedCameraPopup(deviceId, lng, lat) {
    if (!lng || !lat) {
      AuthSystem.showNotification('Kameranın konumu belirlenmemiş', 'error');
      return;
    }

    // Close dashboard
    this.close();

    // Fly to camera location and open popup
    if (window.map) {
      window.map.flyTo({
        center: [lng, lat],
        zoom: 17,
        essential: true
      });

      // Wait for map to settle, then open popup
      setTimeout(() => {
        if (window.CameraSystem) {
          const camera = CameraSystem.cameras.find(c => c.device_id === deviceId);
          if (camera) {
            CameraSystem.openCameraPopup(camera, [lng, lat]);
          } else {
            AuthSystem.showNotification('Kamera haritada bulunamadı', 'error');
          }
        }
      }, 1500);
    }
  }
};

// Initialize on DOM ready (handle lazy-load after DOMContentLoaded)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => MyCamerasSystem.init());
} else {
  MyCamerasSystem.init();
}
