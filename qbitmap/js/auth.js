import { QBitmapConfig } from './config.js';
import { Logger, escapeHtml } from './utils.js';
import { Analytics } from './analytics.js';

/**
 * QBitmap Authentication System
 * Handles Google OAuth login and JWT token management
 * Uses HttpOnly cookies for secure token storage
 */

const AuthSystem = {
  user: null,
  apiBase: QBitmapConfig.api.base,

  /**
   * Initialize auth system - check for login state via cookie
   */
  init() {
    // Check for error in URL (from OAuth callback)
    const urlParams = new URLSearchParams(window.location.search);
    const error = urlParams.get('error');

    if (error) {
      Logger.error('[Auth] OAuth error:', error);
      this.showNotification('Giriş başarısız oldu', 'error');
      window.history.replaceState({}, document.title, window.location.pathname);
      return;
    }

    // Clean URL if redirected from OAuth (token is now in cookie)
    if (window.location.search) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    // Check if logged in via cookie by calling /auth/me
    this.verifyAndLoadUser();
  },

  /**
   * Verify token (via cookie) and load user info
   */
  async verifyAndLoadUser() {
    try {
      const response = await fetch(`${this.apiBase}/auth/verify`, {
        credentials: 'include'
      });

      const data = await response.json();

      if (data.valid) {
        await this.loadUserInfo();
      } else {
        this.user = null;
        this.updateUI();
      }
    } catch (error) {
      Logger.error('[Auth] Token verification error:', error);
      this.user = null;
      this.updateUI();
    }
  },

  /**
   * Load user info from API
   */
  async loadUserInfo() {
    try {
      const response = await fetch(`${this.apiBase}/auth/me`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to load user info');
      }

      this.user = await response.json();
      Logger.log('[Auth] User loaded:', this.user.email);
      this.updateUI();

      // Analytics
      Analytics.setUser(this.user);
      Analytics.event('login', { method: 'google' });

      // Dispatch event for other modules (with slight delay to ensure listeners are ready)
      setTimeout(() => window.dispatchEvent(new CustomEvent("auth:login", { detail: this.user })), 500);

    } catch (error) {
      Logger.error('[Auth] Load user error:', error);
      this.user = null;
      this.updateUI();
    }
  },

  /**
   * Start Google OAuth login flow
   */
  login() {
    window.location.href = `${this.apiBase}/auth/google`;
  },

  /**
   * Logout user
   */
  async logout() {
    try {
      await fetch(`${this.apiBase}/auth/logout`, {
        method: 'POST',
        credentials: 'include'
      });
    } catch (error) {
      Logger.error('[Auth] Logout API error:', error);
    }

    Analytics.event('logout');
    Analytics.clearUser();

    this.user = null;
    this.updateUI();

    // Dispatch event for other modules (with slight delay to ensure listeners are ready)
    window.dispatchEvent(new CustomEvent('auth:logout'));

    this.showNotification('Çıkış yapıldı', 'success');
  },

  /**
   * Check if user is logged in
   */
  isLoggedIn() {
    return !!this.user;
  },

  /**
   * Get current logged in user
   * @returns {Object|null} User object or null if not logged in
   */
  getCurrentUser() {
    return this.user;
  },

  /**
   * Update UI based on auth state
   */
  updateUI() {
    const container = document.getElementById('auth-container');
    if (!container) return;

    if (this.isLoggedIn()) {
      container.innerHTML = `
        <div class="auth-buttons">
          <div class="user-menu">
          <button class="user-button" aria-label="Kullanıcı menüsü" aria-haspopup="true" aria-expanded="false">
            <img src="${escapeHtml(this.user.avatarUrl)}" alt="" class="user-avatar">
            <span class="user-name">${escapeHtml(this.user.displayName)}</span>
            <span class="video-msg-badge" id="video-msg-badge" style="display:none;">0</span>
            <svg class="dropdown-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <div class="user-dropdown" id="user-dropdown" role="menu" aria-label="Kullanıcı menüsü">
            <div class="dropdown-header">
              <img src="${escapeHtml(this.user.avatarUrl)}" alt="" class="dropdown-avatar">
              <div>
                <div class="dropdown-name">${escapeHtml(this.user.displayName)}</div>
                <div class="dropdown-email">${escapeHtml(this.user.email)}</div>
              </div>
            </div>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item" id="profile-menu-btn" role="menuitem">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
              Profilim
            </button>
            <button class="dropdown-item" id="mycameras-menu-btn" role="menuitem">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                <circle cx="12" cy="13" r="4"></circle>
              </svg>
              Kameralarım
            </button>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item" id="video-msg-button" role="menuitem">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
              </svg>
              Video Mesaj
            </button>
            <button class="dropdown-item" id="photo-msg-button" role="menuitem">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
              </svg>
              Foto Mesaj
            </button>
            <button class="dropdown-item" id="broadcast-dropdown-item" role="menuitem">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="12" cy="12" r="3"/>
                <path d="M8.59 16.59a5.5 5.5 0 0 1 0-9.18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                <path d="M15.41 16.59a5.5 5.5 0 0 0 0-9.18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                <path d="M5.64 19.36a9.5 9.5 0 0 1 0-14.72" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                <path d="M18.36 19.36a9.5 9.5 0 0 0 0-14.72" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              </svg>
              Canlı Yayın
            </button>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item" id="logout-menu-btn" role="menuitem">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                <polyline points="16 17 21 12 16 7"></polyline>
                <line x1="21" y1="12" x2="9" y2="12"></line>
              </svg>
              Çıkış Yap
            </button>
          </div>
        </div>
        </div>
      `;
      // Bind logged-in menu handlers
      container.querySelector('.user-button')?.addEventListener('click', () => AuthSystem.toggleDropdown());
      document.getElementById('profile-menu-btn')?.addEventListener('click', () => AuthSystem._openProfile());
      document.getElementById('mycameras-menu-btn')?.addEventListener('click', () => AuthSystem._openMyCameras());
      document.getElementById('broadcast-dropdown-item')?.addEventListener('click', () => { import('/js/live-broadcast/index.js').then(m => { if (m.LiveBroadcast) m.LiveBroadcast.toggleBroadcast(); }); AuthSystem.toggleDropdown(); });
      document.getElementById('logout-menu-btn')?.addEventListener('click', () => AuthSystem.logout());
    } else {
      container.innerHTML = `
        <div class="auth-buttons">
          <button class="login-button" aria-label="Google ile giriş yap">
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Google ile Giriş
          </button>
        </div>
      `;
      // Bind login button handler
      container.querySelector('.login-button')?.addEventListener('click', () => AuthSystem.login());
    }

    // Create right-side menu (toggle + dropdown panel with all buttons)
    this._createRightSideMenu();

    // Rebind mic button after dynamic HTML creation
    import('/js/voice-control.js').then(m => {
      if (m.VoiceControl?.bindMicButton) m.VoiceControl.bindMicButton();
    }).catch(() => {});
    // Lazy-load map features (visible to everyone)
    import('/js/video-message/index.js').then(m => {
      if (m.VideoMessage) {
        m.VideoMessage.init();
        if (this.isLoggedIn()) { m.VideoMessage.bindButton(); m.VideoMessage.bindPhotoButton(); }
      }
    }).catch(err => console.error('[Auth] video-message load failed:', err));
    import('/js/comments.js').then(m => {
      if (m.CommentWidget) m.CommentWidget.init();
    }).catch(err => console.error('[Auth] comments load failed:', err));
    // Broadcast only for logged-in users
    if (this.isLoggedIn()) {
      import('/js/live-broadcast/index.js').then(m => {
        if (m.LiveBroadcast) { m.LiveBroadcast.init(); m.LiveBroadcast.bindButton(); }
      }).catch(err => console.error('[Auth] broadcast load failed:', err));
    }
  },

  /**
   * Create right-side menu: toggle button + dropdown panel with all controls
   */
  _createRightSideMenu() {
    if (document.getElementById('right-menu-toggle')) return;

    // Get or create the shared right-side container
    let container = document.getElementById('right-side-controls');
    if (!container) {
      container = document.createElement('div');
      container.id = 'right-side-controls';
      container.className = 'right-side-controls';
      document.body.appendChild(container);
    }

    // Toggle button (hamburger)
    const toggle = document.createElement('button');
    toggle.id = 'right-menu-toggle';
    toggle.className = 'mic-button-right';
    toggle.title = 'Menü';
    toggle.setAttribute('aria-label', 'Araç menüsü');
    toggle.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <line x1="4" y1="6" x2="20" y2="6"/>
        <line x1="4" y1="12" x2="20" y2="12"/>
        <line x1="4" y1="18" x2="20" y2="18"/>
      </svg>
    `;
    container.appendChild(toggle);

    // Dropdown panel
    const panel = document.createElement('div');
    panel.id = 'right-menu-panel';
    container.appendChild(panel);

    // --- Move maplibre controls into our panel ---
    const mlCtrl = document.querySelector('.maplibregl-ctrl-top-right');
    if (mlCtrl) {
      // Move all control groups (fullscreen, nav, S, L, A, grid) into panel
      const groups = Array.from(mlCtrl.children);
      groups.forEach(group => panel.appendChild(group));
      mlCtrl.style.display = 'none';

      // Extract fullscreen control out of panel, place it above hamburger
      const fullscreenCtrl = panel.querySelector('.maplibregl-ctrl-fullscreen');
      if (fullscreenCtrl) {
        container.insertBefore(fullscreenCtrl.closest('.maplibregl-ctrl-group') || fullscreenCtrl, toggle);
      }

      // Extract layers dropdown out of panel, place it directly below hamburger
      const layersCtrl = panel.querySelector('.layers-dropdown-wrapper');
      if (layersCtrl) {
        container.insertBefore(layersCtrl, panel);
      }
    }

    // --- Auth-specific buttons ---

    // Mic button
    const micBtn = document.createElement('button');
    micBtn.id = 'mic-button';
    micBtn.className = 'mic-button-right';
    micBtn.title = 'Sesli Komut';
    micBtn.setAttribute('aria-label', 'Sesli komut');
    micBtn.setAttribute('aria-pressed', 'false');
    micBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
      </svg>
    `;
    panel.appendChild(micBtn);

    // Broadcast float controls
    const floatContainer = document.createElement('div');
    floatContainer.id = 'broadcast-float-controls';
    floatContainer.className = 'broadcast-float-controls';

    const broadcastBtn = document.createElement('button');
    broadcastBtn.id = 'broadcast-button';
    broadcastBtn.className = 'mic-button-right';
    broadcastBtn.title = 'Canlı Yayın';
    broadcastBtn.setAttribute('aria-label', 'Canlı yayın');
    broadcastBtn.setAttribute('aria-pressed', 'false');
    broadcastBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="12" cy="12" r="3"/>
        <path d="M8.59 16.59a5.5 5.5 0 0 1 0-9.18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M15.41 16.59a5.5 5.5 0 0 0 0-9.18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M5.64 19.36a9.5 9.5 0 0 1 0-14.72" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M18.36 19.36a9.5 9.5 0 0 0 0-14.72" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    `;
    floatContainer.appendChild(broadcastBtn);
    panel.appendChild(floatContainer);

    // Locate me button
    const locateBtn = document.createElement('button');
    locateBtn.id = 'locate-me-button';
    locateBtn.className = 'mic-button-right';
    locateBtn.title = 'Konumumu Bul';
    locateBtn.setAttribute('aria-label', 'Konumumu bul');
    locateBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4"/>
        <line x1="12" y1="2" x2="12" y2="6"/>
        <line x1="12" y1="18" x2="12" y2="22"/>
        <line x1="2" y1="12" x2="6" y2="12"/>
        <line x1="18" y1="12" x2="22" y2="12"/>
      </svg>
    `;
    locateBtn.addEventListener('click', () => {
      import('/js/user-location.js').then(m => { if (m.UserLocationSystem) m.UserLocationSystem.locateMe(); }).catch(() => {});
    });
    panel.appendChild(locateBtn);

    // Toggle behavior
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.toggle('open');
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target) && !panel.classList.contains('broadcast-active')) {
        panel.classList.remove('open');
      }
    });

    // Close on ESC
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.classList.contains('broadcast-active')) {
        panel.classList.remove('open');
      }
    });
  },

  /**
   * Toggle user dropdown menu
   */
  toggleDropdown() {
    const dropdown = document.getElementById('user-dropdown');
    const button = document.querySelector('.user-button');
    if (dropdown) {
      const isActive = dropdown.classList.toggle('active');
      if (button) {
        button.setAttribute('aria-expanded', isActive);
      }
    }
  },

  /**
   * Close dropdown when clicking outside
   */
  closeDropdown(event) {
    const dropdown = document.getElementById('user-dropdown');
    const button = document.querySelector('.user-button');

    if (dropdown && button && !button.contains(event.target) && !dropdown.contains(event.target)) {
      dropdown.classList.remove('active');
      button.setAttribute('aria-expanded', 'false');
    }
  },

  /**
   * Show notification toast
   */
  showNotification(message, type = 'info') {
    const existing = document.querySelector('.auth-notification');
    if (existing) existing.remove();

    const notification = document.createElement('div');
    notification.className = `auth-notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => notification.classList.add('show'), 10);
    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  AuthSystem.init();
});

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  AuthSystem.closeDropdown(e);
});

// Lazy-load helpers for onclick handlers (Vite can analyze these import() calls)
AuthSystem._openProfile = function() {
  import('./user-profile.js').then(m => m.UserProfileSystem.open());
  AuthSystem.toggleDropdown();
};

AuthSystem._openMyCameras = function() {
  import('./my-cameras/index.js').then(m => m.MyCamerasSystem.open());
  AuthSystem.toggleDropdown();
};

// ES module export + backward compat
export { AuthSystem };
