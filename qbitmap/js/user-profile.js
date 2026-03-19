/**
 * QBitmap User Profile Panel
 * Manage user profile and face recognition registration
 */

const UserProfileSystem = {
  apiBase: 'https://stream.qbitmap.com/api/users',
  isOpen: false,
  isLoading: false,
  hasFaceRegistered: false,

  /**
   * Initialize profile panel
   */
  init() {
    this.createPanel();

    // Listen for auth events
    window.addEventListener('auth:login', () => this.checkFaceStatus());
    window.addEventListener('auth:logout', () => {
      this.hasFaceRegistered = false;
      this.close();
    });
  },

  /**
   * Create panel HTML
   */
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

  /**
   * Open profile panel
   */
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

  /**
   * Close profile panel
   */
  close() {
    const panel = document.getElementById('profile-panel-overlay');
    panel.classList.remove('active');
    this.isOpen = false;
  },

  /**
   * Load user profile
   */
  async loadProfile() {
    const content = document.querySelector('.profile-panel-content');

    try {
      const response = await fetch(`${this.apiBase}/me`, {
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed to load profile');

      const user = await response.json();
      this.hasFaceRegistered = user.hasFaceRegistered;

      this.renderProfile(user);

    } catch (error) {
      Logger.error('[Profile] Load error:', error);
      content.innerHTML = '<div class="profile-face-error"><p>Profil yüklenemedi</p></div>';
    }
  },

  /**
   * Check face registration status
   */
  async checkFaceStatus() {
    try {
      const response = await fetch(`${this.apiBase}/me`, {
        credentials: 'include'
      });

      if (response.ok) {
        const user = await response.json();
        this.hasFaceRegistered = user.hasFaceRegistered;
      }
    } catch (error) {
      Logger.error('[Profile] Status check error:', error);
    }
  },

  /**
   * Render profile content
   */
  renderProfile(user) {
    const content = document.querySelector('.profile-panel-content');

    content.innerHTML = `
      <div class="profile-user-info">
        <img src="${escapeHtml(user.avatarUrl || '/default-avatar.png')}" alt="" class="profile-user-avatar">
        <div class="profile-user-details">
          <h3>${escapeHtml(user.displayName || 'Kullanıcı')}</h3>
          <p>${escapeHtml(user.email)}</p>
        </div>
      </div>

      ${this.renderLocationSection(user.location)}

      <div class="profile-face-section">
        <h4>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
          Yüz Tanıma
        </h4>

        ${user.hasFaceRegistered ? this.renderRegisteredFace() : this.renderUploadArea()}
      </div>
    `;

    // Setup event listeners
    this.setupEventListeners();
    this.setupLocationListeners(user.location);
  },

  /**
   * Render location section
   */
  renderLocationSection(location) {
    const hasLocation = location && location.lat && location.lng;
    const showOnMap = location?.showOnMap || false;

    return `
      <div class="profile-location-section">
        <h4>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
            <button class="profile-location-find-btn" onclick="UserProfileSystem.findLocation()" style="margin-top: 8px;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
                <circle cx="12" cy="12" r="8" fill="none"/>
              </svg>
              Konumu Guncelle
            </button>
          </div>
        ` : `
          <div class="profile-location-empty">
            <p>Konum bilgisi yok</p>
            <button class="profile-location-find-btn" onclick="UserProfileSystem.findLocation()">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
                <circle cx="12" cy="12" r="8" fill="none"/>
              </svg>
              Konumumu Bul
            </button>
          </div>
        `}

        <div class="profile-location-toggle">
          <label class="toggle-switch">
            <input type="checkbox" id="location-visibility-toggle" ${showOnMap ? 'checked' : ''} ${!hasLocation ? 'disabled' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <span class="toggle-label">Konumumu haritada göster</span>
        </div>
      </div>
    `;
  },

  /**
   * Setup location event listeners
   */
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
          // Refresh public locations on the map
          if (window.UserLocationSystem) {
            UserLocationSystem.refreshPublicLocations();
          }
        }
      });
    }
  },

  /**
   * Find user location from profile
   */
  async findLocation() {
    // Close profile panel
    this.close();

    // Check if geolocation is supported
    if (!navigator.geolocation) {
      if (window.AuthSystem) {
        AuthSystem.showNotification('Konum servisi desteklenmiyor', 'error');
      }
      return;
    }

    // Show searching notification
    if (window.AuthSystem) {
      AuthSystem.showNotification('Konum aranıyor...', 'info');
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude, accuracy } = position.coords;

        // Show location on map via UserLocationSystem
        if (window.UserLocationSystem) {
          await UserLocationSystem.showLocation(longitude, latitude, accuracy);
        }

        // Fly to location on map
        if (window.map) {
          map.flyTo({
            center: [longitude, latitude],
            zoom: 17,
            duration: 1000
          });
        }

        if (window.AuthSystem) {
          AuthSystem.showNotification(`Konum belirlendi (±${Math.round(accuracy)}m)`, 'success');
        }
      },
      (error) => {
        Logger.error('[Profile] Geolocation error:', error);
        if (window.AuthSystem) {
          AuthSystem.showNotification('Konum alinamadi', 'error');
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
  },

  /**
   * Format date for display
   */
  formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleString('tr-TR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  },

  /**
   * Render upload area (no face registered)
   */
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

  /**
   * Render registered face preview
   */
  renderRegisteredFace() {
    return `
      <div class="profile-face-registered">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#4caf50" stroke-width="2">
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

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    const uploadArea = document.getElementById('face-upload-area');
    const fileInput = document.getElementById('face-file-input');

    if (!uploadArea || !fileInput) return;

    // Click to select file
    uploadArea.addEventListener('click', () => fileInput.click());

    // File selected
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        this.uploadFace(e.target.files[0]);
      }
    });

    // Drag and drop
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        this.uploadFace(e.dataTransfer.files[0]);
      }
    });
  },

  /**
   * Upload face image
   */
  async uploadFace(file) {
    // Validate file type
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      AuthSystem.showNotification('Sadece JPEG ve PNG dosyaları kabul edilir', 'error');
      return;
    }

    // Validate file size (2MB)
    if (file.size > 2 * 1024 * 1024) {
      AuthSystem.showNotification('Dosya boyutu 2MB\'dan küçük olmalı', 'error');
      return;
    }

    // Validate image dimensions
    const isValidSize = await this.validateImageSize(file);
    if (!isValidSize) {
      AuthSystem.showNotification('Görsel en fazla 1920x1080 piksel olabilir', 'error');
      return;
    }

    // Show loading
    this.showLoading('Yüz kaydediliyor...');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`${this.apiBase}/me/face`, {
        method: 'PUT',
        credentials: 'include',
        body: formData
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Yüz kaydedilemedi');
      }

      this.hasFaceRegistered = true;
      AuthSystem.showNotification('Yüzünüz başarıyla kaydedildi!', 'success');

      // Reload profile
      await this.loadProfile();

    } catch (error) {
      Logger.error('[Profile] Upload error:', error);
      AuthSystem.showNotification(error.message || 'Yüz kaydedilemedi', 'error');
      await this.loadProfile();
    }
  },

  /**
   * Validate image dimensions
   */
  validateImageSize(file) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(img.src);
        resolve(img.width <= 1920 && img.height <= 1080);
      };
      img.onerror = () => resolve(false);
      img.src = URL.createObjectURL(file);
    });
  },

  /**
   * Delete face registration
   */
  async deleteFace() {
    if (!confirm('Yüz kaydınızı silmek istediğinize emin misiniz?')) {
      return;
    }

    this.showLoading('Kayıt siliniyor...');

    try {
      const response = await fetch(`${this.apiBase}/me/face`, {
        method: 'DELETE',
        credentials: 'include'
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Kayıt silinemedi');
      }

      this.hasFaceRegistered = false;
      AuthSystem.showNotification('Yüz kaydı silindi', 'success');

      // Reload profile
      await this.loadProfile();

    } catch (error) {
      Logger.error('[Profile] Delete error:', error);
      AuthSystem.showNotification(error.message || 'Kayıt silinemedi', 'error');
      await this.loadProfile();
    }
  },

  /**
   * Show loading state
   */
  showLoading(message) {
    const content = document.querySelector('.profile-panel-content');
    const faceSection = document.querySelector('.profile-face-section');

    if (faceSection) {
      faceSection.innerHTML = `
        <h4>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  UserProfileSystem.init();
});
