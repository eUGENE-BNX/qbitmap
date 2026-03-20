/**
 * QBitmap Admin Panel
 * User and Plan Management
 */

// Safe avatar URL - only allow https:// URLs, fallback to default
function safeAvatarUrl(url) {
  if (!url) return '/img/default-avatar.png';
  if (/^https:\/\//.test(url)) return url;
  return '/img/default-avatar.png';
}

const AdminPanel = {
  currentUser: null,
  users: [],
  plans: [],
  onvifTemplates: [],
  pagination: { page: 1, limit: 20, total: 0 },
  filters: {},
  editingUserId: null,
  editingPlanId: null,
  editingOnvifId: null,
  messages: [],
  messagesPagination: { page: 1, limit: 20, total: 0 },

  /**
   * Initialize admin panel
   */
  async init() {
    // Check authentication first (before showing any content)
    const authed = await this.checkAuth();
    if (!authed) {
      window.location.href = '/';
      return;
    }

    // Show admin panel only after successful auth
    document.querySelector('.admin-container').style.display = '';

    this.bindEvents();
    await this.loadStats();
    await this.loadPlans();
    await this.loadUsers();
  },

  /**
   * Check if user is authenticated and is admin
   */
  async checkAuth() {
    try {
      const response = await fetch(`${QBitmapConfig.api.users}/me`, {
        credentials: 'include'
      });

      if (!response.ok) {
        return false;
      }

      const user = await response.json();
      if (user.role !== 'admin') {
        this.showToast('Admin access required', 'error');
        return false;
      }

      this.currentUser = user;
      document.getElementById('user-email').textContent = user.email;
      return true;
    } catch (error) {
      console.error('[Admin] Auth check failed:', error);
      return false;
    }
  },

  /**
   * Bind event listeners
   */
  bindEvents() {
    // Tabs
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });

    // Search and filters
    document.getElementById('user-search').addEventListener('input',
      this.debounce(() => this.loadUsers(), 300));
    document.getElementById('plan-filter').addEventListener('change', () => this.loadUsers());
    document.getElementById('status-filter').addEventListener('change', () => this.loadUsers());

    // Logout
    document.getElementById('logout-btn').addEventListener('click', () => this.logout());

    // User modal
    document.getElementById('user-modal-close').addEventListener('click', () => this.closeUserModal());
    document.getElementById('user-modal-cancel').addEventListener('click', () => this.closeUserModal());
    document.getElementById('user-modal-save').addEventListener('click', () => this.saveUser());
    document.getElementById('clear-overrides-btn').addEventListener('click', () => this.clearOverrides());

    // Plan modal
    document.getElementById('plan-modal-close').addEventListener('click', () => this.closePlanModal());
    document.getElementById('plan-modal-cancel').addEventListener('click', () => this.closePlanModal());
    document.getElementById('plan-modal-save').addEventListener('click', () => this.savePlan());
    document.getElementById('delete-plan-btn').addEventListener('click', () => this.deletePlan());
    document.getElementById('add-plan-btn').addEventListener('click', () => this.openPlanModal());

    // ONVIF modal
    document.getElementById('onvif-modal-close').addEventListener('click', () => this.closeOnvifModal());
    document.getElementById('onvif-modal-cancel').addEventListener('click', () => this.closeOnvifModal());
    document.getElementById('onvif-modal-save').addEventListener('click', () => this.saveOnvifTemplate());
    document.getElementById('delete-onvif-btn').addEventListener('click', () => this.deleteOnvifTemplate());
    document.getElementById('add-onvif-btn').addEventListener('click', () => this.openOnvifModal());

    // AI Settings
    document.getElementById('save-ai-settings-btn').addEventListener('click', () => this.saveAiSettings());

    // Voice Call Settings
    document.getElementById('save-voice-settings-btn').addEventListener('click', () => this.saveVoiceSettings());

    // Messages
    document.getElementById('msg-search').addEventListener('input',
      this.debounce(() => { this.messagesPagination.page = 1; this.loadMessages(); }, 300));
    document.getElementById('msg-type-filter').addEventListener('change', () => {
      this.messagesPagination.page = 1;
      this.loadMessages();
    });

    // Close modals on overlay click
    document.getElementById('user-modal').addEventListener('click', (e) => {
      if (e.target.id === 'user-modal') this.closeUserModal();
    });
    document.getElementById('plan-modal').addEventListener('click', (e) => {
      if (e.target.id === 'plan-modal') this.closePlanModal();
    });
    document.getElementById('onvif-modal').addEventListener('click', (e) => {
      if (e.target.id === 'onvif-modal') this.closeOnvifModal();
    });
  },

  /**
   * Load dashboard stats
   */
  async loadStats() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/stats`, {
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed to load stats');

      const stats = await response.json();

      document.getElementById('stat-users').textContent = stats.total_users;
      document.getElementById('stat-active').textContent = stats.active_users;
      document.getElementById('stat-cameras').textContent = stats.total_cameras;
      document.getElementById('stat-online').textContent = stats.online_cameras;
      document.getElementById('stat-ai').textContent = stats.today_ai_queries;
      document.getElementById('stat-videos').textContent = stats.total_videos;
      document.getElementById('stat-photos').textContent = stats.total_photos;
    } catch (error) {
      console.error('[Admin] Failed to load stats:', error);
    }
  },

  /**
   * Load plans
   */
  async loadPlans() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/plans`, {
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed to load plans');

      this.plans = await response.json();
      this.renderPlanFilter();
      this.renderPlans();
    } catch (error) {
      console.error('[Admin] Failed to load plans:', error);
    }
  },

  /**
   * Render plan filter dropdown
   */
  renderPlanFilter() {
    const select = document.getElementById('plan-filter');
    const options = ['<option value="">All Plans</option>'];

    this.plans.forEach(plan => {
      options.push(`<option value="${plan.id}">${escapeHtml(plan.display_name)}</option>`);
    });

    select.innerHTML = options.join('');
  },

  /**
   * Render plans grid
   */
  renderPlans() {
    const grid = document.getElementById('plans-grid');

    grid.innerHTML = this.plans.map(plan => `
      <div class="plan-card" data-plan-id="${plan.id}">
        <div class="plan-header">
          <span class="plan-name">${escapeHtml(plan.display_name)}</span>
          <span class="plan-users">${plan.user_count} users</span>
        </div>
        <div class="plan-features">
          <div class="plan-feature">
            <span class="plan-feature-name">Cameras</span>
            <span class="plan-feature-value">${plan.max_cameras === -1 ? '∞' : plan.max_cameras}</span>
          </div>
          <div class="plan-feature">
            <span class="plan-feature-name">WHEP</span>
            <span class="plan-feature-value">${plan.max_whep_cameras === -1 ? '∞' : plan.max_whep_cameras}</span>
          </div>
          <div class="plan-feature">
            <span class="plan-feature-name">AI Daily</span>
            <span class="plan-feature-value ${plan.ai_analysis_enabled ? 'enabled' : 'disabled'}">
              ${plan.ai_analysis_enabled ? (plan.ai_daily_limit === -1 ? '∞' : plan.ai_daily_limit) : '-'}
            </span>
          </div>
          <div class="plan-feature">
            <span class="plan-feature-name">Face Recognition</span>
            <span class="plan-feature-value ${plan.face_recognition_enabled ? 'enabled' : 'disabled'}">
              ${plan.face_recognition_enabled ? (plan.max_faces_per_camera === -1 ? '∞' : plan.max_faces_per_camera + '/cam') : '-'}
            </span>
          </div>
          <div class="plan-feature">
            <span class="plan-feature-name">Recording</span>
            <span class="plan-feature-value ${plan.recording_enabled ? 'enabled' : 'disabled'}">
              ${plan.recording_enabled ? (plan.max_recording_hours === -1 ? '∞' : plan.max_recording_hours + 'h') : '-'}
            </span>
          </div>
          <div class="plan-feature">
            <span class="plan-feature-name">Voice Call</span>
            <span class="plan-feature-value ${plan.voice_call_enabled ? 'enabled' : 'disabled'}">
              ${plan.voice_call_enabled ? 'Yes' : '-'}
            </span>
          </div>
        </div>
      </div>
    `).join('');

    // Bind click events
    grid.querySelectorAll('.plan-card').forEach(card => {
      card.addEventListener('click', () => {
        this.openPlanModal(parseInt(card.dataset.planId));
      });
    });
  },

  /**
   * Load users
   */
  async loadUsers() {
    const search = document.getElementById('user-search').value;
    const planId = document.getElementById('plan-filter').value;
    const isActive = document.getElementById('status-filter').value;

    try {
      let url = `${QBitmapConfig.api.admin}/users?page=${this.pagination.page}&limit=${this.pagination.limit}`;

      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (planId) url += `&plan_id=${planId}`;
      if (isActive) url += `&is_active=${isActive}`;

      const response = await fetch(url, { credentials: 'include' });

      if (!response.ok) throw new Error('Failed to load users');

      const data = await response.json();
      this.users = data.items;
      this.pagination = data.pagination;

      this.renderUsers();
      this.renderPagination();
    } catch (error) {
      console.error('[Admin] Failed to load users:', error);
    }
  },

  /**
   * Render users table
   */
  renderUsers() {
    const tbody = document.getElementById('users-tbody');

    if (this.users.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="empty-state">
            <h3>No users found</h3>
            <p>Try adjusting your filters</p>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = this.users.map(user => `
      <tr>
        <td>
          <div class="user-cell">
            <img src="${safeAvatarUrl(user.avatar_url)}" alt="" class="user-avatar">
            <div class="user-info">
              <span class="user-name">${escapeHtml(user.display_name || 'No Name')}</span>
              <span class="user-email-cell">${escapeHtml(user.email)}</span>
            </div>
          </div>
        </td>
        <td>
          <span class="badge badge-${escapeHtml(user.plan_name || 'free')}">${escapeHtml(user.plan_display_name || 'Free')}</span>
          ${user.role === 'admin' ? '<span class="badge badge-admin">Admin</span>' : ''}
        </td>
        <td>${user.camera_count}</td>
        <td>
          <span class="status-dot ${user.is_active ? 'active' : 'inactive'}"></span>
          ${user.is_active ? 'Active' : 'Inactive'}
        </td>
        <td>
          <span class="time-ago">${user.last_login ? this.timeAgo(user.last_login) : 'Never'}</span>
        </td>
        <td>
          <button class="btn btn-small btn-ghost" onclick="AdminPanel.openUserModal(${user.id})">Edit</button>
        </td>
      </tr>
    `).join('');
  },

  /**
   * Render pagination
   */
  renderPagination() {
    const container = document.getElementById('users-pagination');
    const { page, totalPages } = this.pagination;

    if (totalPages <= 1) {
      container.innerHTML = '';
      return;
    }

    let html = '';

    // Previous button
    html += `<button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="AdminPanel.goToPage(${page - 1})">Prev</button>`;

    // Page numbers
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
        html += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="AdminPanel.goToPage(${i})">${i}</button>`;
      } else if (i === page - 2 || i === page + 2) {
        html += `<span class="page-btn">...</span>`;
      }
    }

    // Next button
    html += `<button class="page-btn" ${page >= totalPages ? 'disabled' : ''} onclick="AdminPanel.goToPage(${page + 1})">Next</button>`;

    container.innerHTML = html;
  },

  /**
   * Go to page
   */
  goToPage(page) {
    this.pagination.page = page;
    this.loadUsers();
  },

  /**
   * Switch tab
   */
  switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');

    // Load ONVIF templates when switching to onvif tab
    if (tabName === 'onvif' && this.onvifTemplates.length === 0) {
      this.loadOnvifTemplates();
    }

    // Load AI settings when switching to ai tab
    if (tabName === 'ai') {
      this.loadAiSettings();
    }

    // Load Voice settings when switching to voice tab
    if (tabName === 'voice') {
      this.loadVoiceSettings();
    }

    // Load messages when switching to messages tab
    if (tabName === 'messages') {
      this.loadMessages();
    }

    // Load places when switching to places tab
    if (tabName === 'places') {
      this.loadPlacesTab();
    }
  },

  /**
   * Open user edit modal
   */
  async openUserModal(userId) {
    this.editingUserId = userId;

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/users/${userId}`, {
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed to load user');

      const user = await response.json();

      // Populate modal
      document.getElementById('modal-avatar').style.backgroundImage =
        user.avatar_url ? `url(${safeAvatarUrl(user.avatar_url)})` : 'none';
      document.getElementById('modal-user-name').textContent = user.display_name || 'No Name';
      document.getElementById('modal-user-email').textContent = user.email;

      // Populate plan select
      const planSelect = document.getElementById('modal-plan');
      planSelect.innerHTML = this.plans.map(p =>
        `<option value="${p.id}" ${p.id === user.plan_id ? 'selected' : ''}>${escapeHtml(p.display_name)}</option>`
      ).join('');

      document.getElementById('modal-role').value = user.role || 'user';
      document.getElementById('modal-active').checked = user.is_active !== 0;
      document.getElementById('modal-notes').value = user.notes || '';

      // Populate overrides
      const overrides = user.overrides || {};
      document.getElementById('override-cameras-enabled').checked = overrides.max_cameras != null;
      document.getElementById('override-cameras').value = overrides.max_cameras ?? '';
      document.getElementById('override-whep-enabled').checked = overrides.max_whep_cameras != null;
      document.getElementById('override-whep').value = overrides.max_whep_cameras ?? '';
      document.getElementById('override-ai-enabled').checked = overrides.ai_daily_limit != null;
      document.getElementById('override-ai').value = overrides.ai_daily_limit ?? '';
      document.getElementById('override-face-enabled').checked = overrides.max_faces_per_camera != null;
      document.getElementById('override-faces').value = overrides.max_faces_per_camera ?? '';
      document.getElementById('override-recording-enabled').checked = overrides.max_recording_hours != null;
      document.getElementById('override-recording').value = overrides.max_recording_hours ?? '';
      document.getElementById('override-voice-call').checked = !!overrides.voice_call_enabled;
      document.getElementById('override-voice-control').checked = !!overrides.voice_control_enabled;
      document.getElementById('override-public-sharing').checked = !!overrides.public_sharing_enabled;

      // Populate usage
      const usage = user.usage || {};
      document.getElementById('modal-usage').innerHTML = `
        <div class="usage-item">
          <span class="usage-label">Cameras</span>
          <span class="usage-value">${user.camera_count}</span>
        </div>
        <div class="usage-item">
          <span class="usage-label">AI Today</span>
          <span class="usage-value">${usage.ai_analysis_count || 0}</span>
        </div>
        <div class="usage-item">
          <span class="usage-label">Recording</span>
          <span class="usage-value">${usage.recording_minutes || 0} min</span>
        </div>
        <div class="usage-item">
          <span class="usage-label">Voice Calls</span>
          <span class="usage-value">${usage.voice_call_count || 0}</span>
        </div>
      `;

      // Show modal
      document.getElementById('user-modal').classList.add('active');
    } catch (error) {
      console.error('[Admin] Failed to load user:', error);
      this.showToast('Failed to load user', 'error');
    }
  },

  /**
   * Close user modal
   */
  closeUserModal() {
    document.getElementById('user-modal').classList.remove('active');
    this.editingUserId = null;
  },

  /**
   * Save user changes
   */
  async saveUser() {
    if (!this.editingUserId) return;

    const data = {
      plan_id: parseInt(document.getElementById('modal-plan').value),
      role: document.getElementById('modal-role').value,
      is_active: document.getElementById('modal-active').checked,
      notes: document.getElementById('modal-notes').value
    };

    try {
      // Save basic info
      const response = await fetch(`${QBitmapConfig.api.admin}/users/${this.editingUserId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save user');
      }

      // Save overrides
      const overrides = {};

      if (document.getElementById('override-cameras-enabled').checked) {
        overrides.max_cameras = parseInt(document.getElementById('override-cameras').value) || 0;
      }
      if (document.getElementById('override-whep-enabled').checked) {
        overrides.max_whep_cameras = parseInt(document.getElementById('override-whep').value) || 0;
      }
      if (document.getElementById('override-ai-enabled').checked) {
        overrides.ai_analysis_enabled = 1;
        overrides.ai_daily_limit = parseInt(document.getElementById('override-ai').value) || 0;
      }
      if (document.getElementById('override-face-enabled').checked) {
        overrides.face_recognition_enabled = 1;
        overrides.max_faces_per_camera = parseInt(document.getElementById('override-faces').value) || 0;
      }
      if (document.getElementById('override-recording-enabled').checked) {
        overrides.recording_enabled = 1;
        overrides.max_recording_hours = parseInt(document.getElementById('override-recording').value) || 0;
      }
      if (document.getElementById('override-voice-call').checked) {
        overrides.voice_call_enabled = 1;
      }
      if (document.getElementById('override-voice-control').checked) {
        overrides.voice_control_enabled = 1;
      }
      if (document.getElementById('override-public-sharing').checked) {
        overrides.public_sharing_enabled = 1;
      }

      if (Object.keys(overrides).length > 0) {
        await fetch(`${QBitmapConfig.api.admin}/users/${this.editingUserId}/overrides`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(overrides)
        });
      }

      this.showToast('User saved successfully', 'success');
      this.closeUserModal();
      this.loadUsers();
    } catch (error) {
      console.error('[Admin] Failed to save user:', error);
      this.showToast(error.message, 'error');
    }
  },

  /**
   * Clear user overrides
   */
  async clearOverrides() {
    if (!this.editingUserId) return;

    try {
      await fetch(`${QBitmapConfig.api.admin}/users/${this.editingUserId}/overrides`, {
        method: 'DELETE',
        credentials: 'include'
      });

      this.showToast('Overrides cleared', 'success');
      this.openUserModal(this.editingUserId); // Refresh modal
    } catch (error) {
      console.error('[Admin] Failed to clear overrides:', error);
      this.showToast('Failed to clear overrides', 'error');
    }
  },

  /**
   * Open plan edit modal
   */
  openPlanModal(planId = null) {
    this.editingPlanId = planId;

    const modal = document.getElementById('plan-modal');
    const title = document.getElementById('plan-modal-title');
    const deleteBtn = document.getElementById('delete-plan-btn');

    if (planId) {
      const plan = this.plans.find(p => p.id === planId);
      if (!plan) return;

      title.textContent = 'Edit Plan';
      deleteBtn.style.display = planId > 4 ? 'block' : 'none'; // Can't delete default plans

      document.getElementById('plan-name').value = plan.name;
      document.getElementById('plan-name').disabled = planId <= 4;
      document.getElementById('plan-display-name').value = plan.display_name;
      document.getElementById('plan-max-cameras').value = plan.max_cameras;
      document.getElementById('plan-max-whep').value = plan.max_whep_cameras;
      document.getElementById('plan-ai-enabled').checked = !!plan.ai_analysis_enabled;
      document.getElementById('plan-ai-limit').value = plan.ai_daily_limit;
      document.getElementById('plan-face-enabled').checked = !!plan.face_recognition_enabled;
      document.getElementById('plan-max-faces').value = plan.max_faces_per_camera;
      document.getElementById('plan-recording-enabled').checked = !!plan.recording_enabled;
      document.getElementById('plan-max-recording').value = plan.max_recording_hours;
      document.getElementById('plan-retention-days').value = plan.recording_retention_days;
      document.getElementById('plan-voice-call').checked = !!plan.voice_call_enabled;
      document.getElementById('plan-voice-control').checked = !!plan.voice_control_enabled;
      document.getElementById('plan-public-sharing').checked = !!plan.public_sharing_enabled;
      document.getElementById('plan-priority-support').checked = !!plan.priority_support;
    } else {
      title.textContent = 'New Plan';
      deleteBtn.style.display = 'none';

      document.getElementById('plan-name').value = '';
      document.getElementById('plan-name').disabled = false;
      document.getElementById('plan-display-name').value = '';
      document.getElementById('plan-max-cameras').value = 2;
      document.getElementById('plan-max-whep').value = 1;
      document.getElementById('plan-ai-enabled').checked = false;
      document.getElementById('plan-ai-limit').value = 0;
      document.getElementById('plan-face-enabled').checked = false;
      document.getElementById('plan-max-faces').value = 0;
      document.getElementById('plan-recording-enabled').checked = false;
      document.getElementById('plan-max-recording').value = 0;
      document.getElementById('plan-retention-days').value = 7;
      document.getElementById('plan-voice-call').checked = false;
      document.getElementById('plan-voice-control').checked = false;
      document.getElementById('plan-public-sharing').checked = false;
      document.getElementById('plan-priority-support').checked = false;
    }

    modal.classList.add('active');
  },

  /**
   * Close plan modal
   */
  closePlanModal() {
    document.getElementById('plan-modal').classList.remove('active');
    this.editingPlanId = null;
  },

  /**
   * Save plan
   */
  async savePlan() {
    const data = {
      name: document.getElementById('plan-name').value,
      display_name: document.getElementById('plan-display-name').value,
      max_cameras: parseInt(document.getElementById('plan-max-cameras').value),
      max_whep_cameras: parseInt(document.getElementById('plan-max-whep').value),
      ai_analysis_enabled: document.getElementById('plan-ai-enabled').checked,
      ai_daily_limit: parseInt(document.getElementById('plan-ai-limit').value),
      face_recognition_enabled: document.getElementById('plan-face-enabled').checked,
      max_faces_per_camera: parseInt(document.getElementById('plan-max-faces').value),
      recording_enabled: document.getElementById('plan-recording-enabled').checked,
      max_recording_hours: parseInt(document.getElementById('plan-max-recording').value),
      recording_retention_days: parseInt(document.getElementById('plan-retention-days').value),
      voice_call_enabled: document.getElementById('plan-voice-call').checked,
      voice_control_enabled: document.getElementById('plan-voice-control').checked,
      public_sharing_enabled: document.getElementById('plan-public-sharing').checked,
      priority_support: document.getElementById('plan-priority-support').checked
    };

    try {
      const url = this.editingPlanId
        ? `${QBitmapConfig.api.admin}/plans/${this.editingPlanId}`
        : `${QBitmapConfig.api.admin}/plans`;

      const response = await fetch(url, {
        method: this.editingPlanId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save plan');
      }

      this.showToast('Plan saved successfully', 'success');
      this.closePlanModal();
      this.loadPlans();
    } catch (error) {
      console.error('[Admin] Failed to save plan:', error);
      this.showToast(error.message, 'error');
    }
  },

  /**
   * Delete plan
   */
  async deletePlan() {
    if (!this.editingPlanId) return;

    if (!confirm('Are you sure you want to delete this plan?')) return;

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/plans/${this.editingPlanId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete plan');
      }

      this.showToast('Plan deleted', 'success');
      this.closePlanModal();
      this.loadPlans();
    } catch (error) {
      console.error('[Admin] Failed to delete plan:', error);
      this.showToast(error.message, 'error');
    }
  },

  /**
   * Logout
   */
  async logout() {
    try {
      await fetch(`${QBitmapConfig.api.base}/auth/logout`, {
        method: 'POST',
        credentials: 'include'
      });
    } catch (e) {}

    window.location.href = '/';
  },

  /**
   * Show toast notification
   */
  showToast(message, type = 'success') {
    // Remove existing toasts
    document.querySelectorAll('.toast').forEach(t => t.remove());

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        ${type === 'success'
          ? '<path d="M20 6L9 17l-5-5"/>'
          : '<path d="M18 6L6 18M6 6l12 12"/>'}
      </svg>
      <span>${escapeHtml(message)}</span>
    `;

    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
  },

  /**
   * Format time ago
   */
  timeAgo(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;

    return date.toLocaleDateString();
  },

  /**
   * Debounce helper
   */
  debounce(fn, delay) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), delay);
    };
  },

  // ==================== ONVIF TEMPLATES ====================

  /**
   * Load ONVIF templates
   */
  async loadOnvifTemplates() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/onvif-templates`, {
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed to load ONVIF templates');

      const data = await response.json();
      this.onvifTemplates = data.templates || [];
      this.renderOnvifTemplates();
    } catch (error) {
      console.error('[Admin] Failed to load ONVIF templates:', error);
    }
  },

  /**
   * Render ONVIF templates table
   */
  renderOnvifTemplates() {
    const tbody = document.getElementById('onvif-tbody');
    if (!tbody) return;

    tbody.innerHTML = this.onvifTemplates.map(template => `
      <tr>
        <td>${template.id}</td>
        <td><strong>${escapeHtml(template.modelName)}</strong></td>
        <td>${escapeHtml(template.manufacturer)}</td>
        <td>${template.onvifPort}</td>
        <td>
          <div class="event-tags">
            ${(template.supportedEvents || []).map(e =>
              `<span class="event-tag event-${escapeHtml(e)}">${escapeHtml(e)}</span>`
            ).join('')}
          </div>
        </td>
        <td>
          <button class="btn btn-sm btn-ghost" onclick="AdminPanel.openOnvifModal(${template.id})">Edit</button>
        </td>
      </tr>
    `).join('');
  },

  /**
   * Open ONVIF template modal
   */
  openOnvifModal(templateId = null) {
    this.editingOnvifId = templateId;

    const modal = document.getElementById('onvif-modal');
    const deleteBtn = document.getElementById('delete-onvif-btn');

    // Reset form
    document.getElementById('onvif-model-name').value = '';
    document.getElementById('onvif-manufacturer').value = '';
    document.getElementById('onvif-port').value = '2020';

    // Reset checkboxes
    ['motion', 'human', 'pet', 'vehicle', 'tamper', 'line'].forEach(event => {
      const checkbox = document.getElementById(`onvif-event-${event}`);
      if (checkbox) checkbox.checked = (event === 'motion');
    });

    if (templateId) {
      // Edit mode
      const template = this.onvifTemplates.find(t => t.id === templateId);
      if (template) {
        document.getElementById('onvif-modal-title').textContent = 'Edit ONVIF Profile';
        document.getElementById('onvif-model-name').value = template.modelName || '';
        document.getElementById('onvif-manufacturer').value = template.manufacturer || '';
        document.getElementById('onvif-port').value = template.onvifPort || 2020;

        // Set event checkboxes
        const events = template.supportedEvents || [];
        ['motion', 'human', 'pet', 'vehicle', 'tamper', 'line'].forEach(event => {
          const checkbox = document.getElementById(`onvif-event-${event}`);
          if (checkbox) {
            checkbox.checked = events.includes(event) || events.includes(event.replace('line', 'line_crossing'));
          }
        });

        // Show delete button (but not for default template)
        deleteBtn.style.display = templateId === 1 ? 'none' : 'block';
      }
    } else {
      // Create mode
      document.getElementById('onvif-modal-title').textContent = 'New ONVIF Profile';
      deleteBtn.style.display = 'none';
    }

    modal.classList.add('active');
  },

  /**
   * Close ONVIF modal
   */
  closeOnvifModal() {
    document.getElementById('onvif-modal').classList.remove('active');
    this.editingOnvifId = null;
  },

  /**
   * Save ONVIF template
   */
  async saveOnvifTemplate() {
    const modelName = document.getElementById('onvif-model-name').value.trim();
    const manufacturer = document.getElementById('onvif-manufacturer').value.trim();
    const onvifPort = parseInt(document.getElementById('onvif-port').value) || 2020;

    if (!modelName || !manufacturer) {
      this.showToast('Model name and manufacturer are required', 'error');
      return;
    }

    // Collect supported events
    const supportedEvents = [];
    if (document.getElementById('onvif-event-motion')?.checked) supportedEvents.push('motion');
    if (document.getElementById('onvif-event-human')?.checked) supportedEvents.push('human');
    if (document.getElementById('onvif-event-pet')?.checked) supportedEvents.push('pet');
    if (document.getElementById('onvif-event-vehicle')?.checked) supportedEvents.push('vehicle');
    if (document.getElementById('onvif-event-tamper')?.checked) supportedEvents.push('tamper');
    if (document.getElementById('onvif-event-line')?.checked) supportedEvents.push('line_crossing');

    try {
      let response;

      if (this.editingOnvifId) {
        // Update
        response = await fetch(`${QBitmapConfig.api.admin}/onvif-templates/${this.editingOnvifId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ modelName, manufacturer, onvifPort, supportedEvents })
        });
      } else {
        // Create
        response = await fetch(`${QBitmapConfig.api.admin}/onvif-templates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ modelName, manufacturer, onvifPort, supportedEvents })
        });
      }

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save template');
      }

      this.showToast('ONVIF profile saved', 'success');
      this.closeOnvifModal();
      this.loadOnvifTemplates();
    } catch (error) {
      console.error('[Admin] Failed to save ONVIF template:', error);
      this.showToast(error.message, 'error');
    }
  },

  /**
   * Delete ONVIF template
   */
  async deleteOnvifTemplate() {
    if (!this.editingOnvifId || this.editingOnvifId === 1) return;

    if (!confirm('Are you sure you want to delete this ONVIF profile?')) return;

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/onvif-templates/${this.editingOnvifId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete template');
      }

      this.showToast('ONVIF profile deleted', 'success');
      this.closeOnvifModal();
      this.loadOnvifTemplates();
    } catch (error) {
      console.error('[Admin] Failed to delete ONVIF template:', error);
      this.showToast(error.message, 'error');
    }
  },

  // ==================== AI SETTINGS ====================

  /**
   * Load AI and Voice Call settings from backend
   */
  async loadAiSettings() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/settings`, {
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed to load settings');

      const data = await response.json();
      const settings = data.settings || [];

      // Helper to get setting value
      const getSetting = (key) => settings.find(s => s.key === key)?.value || '';

      // Populate AI form fields
      document.getElementById('ai-service-url').value = getSetting('ai_service_url');
      document.getElementById('ai-vision-model').value = getSetting('ai_vision_model');
      document.getElementById('ai-monitoring-prompt').value = getSetting('ai_monitoring_prompt') || this.getDefaultMonitoringPrompt();
      document.getElementById('ai-search-prompt').value = getSetting('ai_search_prompt') || 'bu resimde ne görüyorsun maksimum birkaç cümle ile açıkla ve sadece emin olduklarını yaz';
      document.getElementById('ai-max-tokens').value = getSetting('ai_max_tokens') || '1024';
      document.getElementById('ai-temperature').value = getSetting('ai_temperature') || '0.7';

    } catch (error) {
      console.error('[Admin] Failed to load AI settings:', error);
      this.showToast('Failed to load AI settings', 'error');
    }
  },

  /**
   * Load Voice Call settings from backend
   */
  async loadVoiceSettings() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/settings`, {
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed to load settings');

      const data = await response.json();
      const settings = data.settings || [];

      // Helper to get setting value
      const getSetting = (key) => settings.find(s => s.key === key)?.value || '';

      // Populate Voice Call form fields (sensitive values must come from backend)
      const vd = QBitmapConfig.voiceDefaults;
      document.getElementById('voice-api-url').value = getSetting('voice_api_url') || '';
      document.getElementById('voice-room-id').value = getSetting('voice_room_id') || '';
      document.getElementById('voice-target-user').value = getSetting('voice_target_user') || '';
      document.getElementById('voice-sample-type').value = getSetting('voice_sample_type') || vd.sampleType;
      document.getElementById('voice-cooldown').value = getSetting('voice_cooldown') || vd.cooldown;
      document.getElementById('voice-auto-hangup').value = getSetting('voice_auto_hangup') || vd.autoHangup;
      document.getElementById('voice-call-timeout').value = getSetting('voice_call_timeout') || vd.callTimeout;

    } catch (error) {
      console.error('[Admin] Failed to load voice settings:', error);
      this.showToast('Failed to load voice settings', 'error');
    }
  },

  /**
   * Save AI settings
   */
  async saveAiSettings() {
    const aiServiceUrl = document.getElementById('ai-service-url').value.trim();
    const aiVisionModel = document.getElementById('ai-vision-model').value.trim();
    const aiMonitoringPrompt = document.getElementById('ai-monitoring-prompt').value.trim();
    const aiSearchPrompt = document.getElementById('ai-search-prompt').value.trim();
    const aiMaxTokens = document.getElementById('ai-max-tokens').value.trim();
    const aiTemperature = document.getElementById('ai-temperature').value.trim();
    const statusEl = document.getElementById('ai-save-status');

    if (!aiServiceUrl || !aiVisionModel) {
      this.showToast('Service URL and Model are required', 'error');
      return;
    }

    statusEl.textContent = 'Saving...';
    statusEl.className = 'save-status saving';

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          ai_service_url: aiServiceUrl,
          ai_vision_model: aiVisionModel,
          ai_monitoring_prompt: aiMonitoringPrompt,
          ai_search_prompt: aiSearchPrompt,
          ai_max_tokens: aiMaxTokens,
          ai_temperature: aiTemperature
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save settings');
      }

      statusEl.textContent = 'Saved!';
      statusEl.className = 'save-status success';
      this.showToast('AI settings saved', 'success');

      setTimeout(() => {
        statusEl.textContent = '';
        statusEl.className = 'save-status';
      }, 3000);

    } catch (error) {
      console.error('[Admin] Failed to save AI settings:', error);
      statusEl.textContent = 'Error!';
      statusEl.className = 'save-status error';
      this.showToast(error.message, 'error');
    }
  },

  /**
   * Save Voice Call settings
   */
  async saveVoiceSettings() {
    const apiUrl = document.getElementById('voice-api-url').value.trim();
    const roomId = document.getElementById('voice-room-id').value.trim();
    const targetUser = document.getElementById('voice-target-user').value.trim();
    const sampleType = document.getElementById('voice-sample-type').value;
    const cooldown = document.getElementById('voice-cooldown').value;
    const autoHangup = document.getElementById('voice-auto-hangup').value;
    const callTimeout = document.getElementById('voice-call-timeout').value;
    const statusEl = document.getElementById('voice-save-status');

    if (!apiUrl || !roomId || !targetUser) {
      this.showToast('API URL, Room ID and Target User are required', 'error');
      return;
    }

    statusEl.textContent = 'Saving...';
    statusEl.className = 'save-status saving';

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          voice_api_url: apiUrl,
          voice_room_id: roomId,
          voice_target_user: targetUser,
          voice_sample_type: sampleType,
          voice_cooldown: cooldown,
          voice_auto_hangup: autoHangup,
          voice_call_timeout: callTimeout
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save settings');
      }

      statusEl.textContent = 'Saved!';
      statusEl.className = 'save-status success';
      this.showToast('Voice settings saved', 'success');

      setTimeout(() => {
        statusEl.textContent = '';
        statusEl.className = 'save-status';
      }, 3000);

    } catch (error) {
      console.error('[Admin] Failed to save voice settings:', error);
      statusEl.textContent = 'Error!';
      statusEl.className = 'save-status error';
      this.showToast(error.message, 'error');
    }
  },

  // ==================== VIDEO/PHOTO MESSAGES ====================

  async loadMessages() {
    const search = document.getElementById('msg-search').value.trim();
    const mediaType = document.getElementById('msg-type-filter').value;

    try {
      let url = `${QBitmapConfig.api.admin}/messages?page=${this.messagesPagination.page}&limit=${this.messagesPagination.limit}`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (mediaType) url += `&media_type=${mediaType}`;

      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load messages');

      const data = await response.json();
      this.messages = data.items;
      this.messagesPagination = { ...this.messagesPagination, ...data.pagination };

      this.renderMessages();
      this.renderMessagesPagination();
    } catch (error) {
      console.error('[Admin] Failed to load messages:', error);
      this.showToast('Failed to load messages', 'error');
    }
  },

  renderMessages() {
    const tbody = document.getElementById('messages-tbody');

    if (this.messages.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><h3>No messages found</h3><p>Try adjusting your filters</p></td></tr>';
      return;
    }

    tbody.innerHTML = this.messages.map(msg => {
      const isVideo = msg.media_type === 'video';
      const thumbHtml = msg.thumbnail_path
        ? `<img src="/uploads/${msg.thumbnail_path.replace(/^uploads\//, '')}" class="msg-thumbnail" alt="" loading="lazy">`
        : `<div class="msg-thumbnail-placeholder">${isVideo ? 'VID' : 'IMG'}</div>`;

      const sizeStr = this.formatFileSize(msg.file_size);
      const durationStr = isVideo && msg.duration_ms ? ` / ${(msg.duration_ms / 1000).toFixed(1)}s` : '';

      const visibility = msg.recipient_id
        ? '<span class="badge badge-private">Private</span>'
        : '<span class="badge badge-public">Public</span>';

      const tagsHtml = (msg.tags || []).map(t =>
        `<span class="msg-tag">${escapeHtml(t)}</span>`
      ).join('') || '<span class="msg-meta">-</span>';

      const aiSnippet = msg.ai_description
        ? `<div class="msg-ai-desc" title="${escapeHtml(msg.ai_description)}">AI: ${escapeHtml(msg.ai_description)}</div>`
        : '';

      return `<tr>
        <td>${thumbHtml}</td>
        <td>
          <div class="msg-desc" title="${escapeHtml(msg.description || '')}">${escapeHtml(msg.description || 'No description')}</div>
          ${aiSnippet}
        </td>
        <td>
          <div class="user-cell">
            <img src="${safeAvatarUrl(msg.sender_avatar)}" alt="" class="user-avatar" style="width:24px;height:24px;">
            <span class="user-name" style="font-size:12px;">${escapeHtml(msg.sender_name || 'Unknown')}</span>
          </div>
        </td>
        <td>
          <span class="badge badge-${msg.media_type}">${msg.media_type}</span>
          ${visibility}
        </td>
        <td><span class="msg-meta">${sizeStr}${durationStr}</span></td>
        <td><span class="msg-meta">${msg.view_count}</span></td>
        <td><div class="msg-tags">${tagsHtml}</div></td>
        <td><span class="time-ago">${this.timeAgo(msg.created_at)}</span></td>
        <td><button class="btn btn-small btn-danger" onclick="AdminPanel.deleteMessage('${msg.message_id}')">Delete</button></td>
      </tr>`;
    }).join('');
  },

  renderMessagesPagination() {
    const container = document.getElementById('messages-pagination');
    const { page, totalPages } = this.messagesPagination;

    if (!totalPages || totalPages <= 1) {
      container.innerHTML = '';
      return;
    }

    let html = `<button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="AdminPanel.goToMessagesPage(${page - 1})">Prev</button>`;

    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
        html += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="AdminPanel.goToMessagesPage(${i})">${i}</button>`;
      } else if (i === page - 2 || i === page + 2) {
        html += '<span class="page-btn">...</span>';
      }
    }

    html += `<button class="page-btn" ${page >= totalPages ? 'disabled' : ''} onclick="AdminPanel.goToMessagesPage(${page + 1})">Next</button>`;
    container.innerHTML = html;
  },

  goToMessagesPage(page) {
    this.messagesPagination.page = page;
    this.loadMessages();
  },

  async deleteMessage(messageId) {
    if (!confirm('Bu mesajı silmek istediğinize emin misiniz? Dosya da diskten silinecek.')) return;

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/messages/${messageId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete');
      }

      this.showToast('Message deleted', 'success');
      this.loadMessages();
      this.loadStats();
    } catch (error) {
      console.error('[Admin] Delete message error:', error);
      this.showToast(error.message, 'error');
    }
  },

  formatFileSize(bytes) {
    if (!bytes) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  },

  // ==================== PLACES ====================

  placesData: [],
  placesPagination: { page: 1, limit: 20, total: 0, totalPages: 0 },

  async loadPlacesTab() {
    await Promise.all([
      this.loadPlacesSettings(),
      this.loadPlacesStats(),
      this.loadPlaces()
    ]);
    this.bindPlacesEvents();
  },

  _placesEventsBound: false,
  bindPlacesEvents() {
    if (this._placesEventsBound) return;
    this._placesEventsBound = true;

    document.getElementById('save-places-settings-btn')?.addEventListener('click', () => this.savePlacesSettings());
    document.getElementById('clear-places-cache-btn')?.addEventListener('click', () => this.clearPlacesCache());
    document.getElementById('places-search')?.addEventListener('input',
      this.debounce(() => { this.placesPagination.page = 1; this.loadPlaces(); }, 300));
  },

  async loadPlacesSettings() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/settings`, { credentials: 'include' });
      if (!response.ok) return;
      const data = await response.json();

      const settings = {};
      for (const s of (data.settings || data)) {
        settings[s.key] = s.value;
      }

      const radiusEl = document.getElementById('places-radius');
      const maxResultsEl = document.getElementById('places-max-results');
      const typesEl = document.getElementById('places-included-types');
      const fallbackEl = document.getElementById('places-fallback-types');

      if (radiusEl && settings.places_radius) radiusEl.value = settings.places_radius;
      if (maxResultsEl && settings.places_max_results) maxResultsEl.value = settings.places_max_results;
      if (typesEl && settings.places_included_types) {
        try {
          const arr = JSON.parse(settings.places_included_types);
          typesEl.value = arr.join(', ');
        } catch { typesEl.value = settings.places_included_types; }
      }
      if (fallbackEl && settings.places_fallback_types) {
        try {
          const arr = JSON.parse(settings.places_fallback_types);
          fallbackEl.value = arr.join(', ');
        } catch { fallbackEl.value = settings.places_fallback_types; }
      }
    } catch (e) {
      console.error('[Admin] Load places settings error:', e);
    }
  },

  async savePlacesSettings() {
    const statusEl = document.getElementById('places-settings-status');
    try {
      const radius = document.getElementById('places-radius')?.value || '30';
      const maxResults = document.getElementById('places-max-results')?.value || '10';
      const typesRaw = document.getElementById('places-included-types')?.value || '';
      const typesArr = typesRaw.split(',').map(t => t.trim()).filter(t => t);
      const typesJson = JSON.stringify(typesArr);
      const fallbackRaw = document.getElementById('places-fallback-types')?.value || '';
      const fallbackArr = fallbackRaw.split(',').map(t => t.trim()).filter(t => t);
      const fallbackJson = JSON.stringify(fallbackArr);

      const response = await fetch(`${QBitmapConfig.api.admin}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          places_radius: radius,
          places_max_results: maxResults,
          places_included_types: typesJson,
          places_fallback_types: fallbackJson
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed');
      }

      if (statusEl) { statusEl.textContent = 'Kaydedildi!'; statusEl.className = 'save-status success'; }
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
    } catch (error) {
      console.error('[Admin] Save places settings error:', error);
      if (statusEl) { statusEl.textContent = 'Hata: ' + error.message; statusEl.className = 'save-status error'; }
    }
  },

  async loadPlacesStats() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/places/stats`, { credentials: 'include' });
      if (!response.ok) return;
      const data = await response.json();

      const el = document.getElementById('places-stats');
      if (el) {
        el.innerHTML = `
          <div class="places-stat-item"><span class="stat-value">${data.totalPlaces}</span><span class="stat-label">Toplam Mekan</span></div>
          <div class="places-stat-item"><span class="stat-value">${data.totalCells}</span><span class="stat-label">Cache Hucre</span></div>
          <div class="places-stat-item"><span class="stat-value">${data.taggedMessages}</span><span class="stat-label">Etiketli Mesaj</span></div>
        `;
      }
    } catch (e) {
      console.error('[Admin] Load places stats error:', e);
    }
  },

  async loadPlaces() {
    try {
      const search = document.getElementById('places-search')?.value || '';
      const { page, limit } = this.placesPagination;

      const params = new URLSearchParams({ page, limit });
      if (search) params.set('search', search);

      const response = await fetch(`${QBitmapConfig.api.admin}/places?${params}`, { credentials: 'include' });
      if (!response.ok) return;
      const data = await response.json();

      this.placesData = data.places || [];
      this.placesPagination = data.pagination || this.placesPagination;
      this.renderPlaces();
      this.renderPlacesPagination();
    } catch (e) {
      console.error('[Admin] Load places error:', e);
    }
  },

  renderPlaces() {
    const tbody = document.getElementById('places-tbody');
    if (!tbody) return;

    if (this.placesData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;">Henuz cache\'lenmis mekan yok</td></tr>';
      return;
    }

    const esc = (t) => { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; };

    tbody.innerHTML = this.placesData.map(p => {
      const types = typeof p.types === 'string' ? JSON.parse(p.types || '[]') : (p.types || []);
      const typesHtml = types.slice(0, 3).map(t => `<span class="type-badge">${esc(t)}</span>`).join('');
      const iconHtml = p.icon_url
        ? `<img src="${esc(p.icon_url)}" class="place-icon" alt="">`
        : `<span class="place-icon-placeholder">📍</span>`;
      return `<tr>
        <td>${iconHtml}</td>
        <td><strong>${esc(p.display_name)}</strong></td>
        <td><span class="msg-meta" style="font-family:monospace;font-size:11px">${p.lat ? `${Number(p.lat).toFixed(4)}, ${Number(p.lng).toFixed(4)}` : '-'}</span></td>
        <td>${typesHtml}</td>
        <td>${p.tag_count || 0}</td>
        <td>
          <button class="btn btn-small" onclick="AdminPanel.editPlaceIcon(${p.id})">Ikon</button>
          <button class="btn btn-small btn-danger" onclick="AdminPanel.deletePlace(${p.id})">Sil</button>
        </td>
      </tr>`;
    }).join('');
  },

  renderPlacesPagination() {
    const container = document.getElementById('places-pagination');
    if (!container) return;
    const { page, totalPages } = this.placesPagination;

    if (!totalPages || totalPages <= 1) { container.innerHTML = ''; return; }

    let html = `<button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="AdminPanel.goToPlacesPage(${page - 1})">Prev</button>`;
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
        html += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="AdminPanel.goToPlacesPage(${i})">${i}</button>`;
      } else if (i === page - 2 || i === page + 2) {
        html += '<span class="page-btn">...</span>';
      }
    }
    html += `<button class="page-btn" ${page >= totalPages ? 'disabled' : ''} onclick="AdminPanel.goToPlacesPage(${page + 1})">Next</button>`;
    container.innerHTML = html;
  },

  goToPlacesPage(page) {
    this.placesPagination.page = page;
    this.loadPlaces();
  },

  async editPlaceIcon(placeId) {
    const iconUrl = prompt('Ikon URL girin (bos birakmak icin Cancel):', '');
    if (iconUrl === null) return;

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/places/${placeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ icon_url: iconUrl || null })
      });

      if (!response.ok) throw new Error('Failed');
      this.showToast('Ikon guncellendi', 'success');
      this.loadPlaces();
    } catch (e) {
      this.showToast('Ikon guncellenemedi', 'error');
    }
  },

  async deletePlace(placeId) {
    if (!confirm('Bu mekani silmek istediginize emin misiniz?')) return;

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/places/${placeId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed');
      this.showToast('Mekan silindi', 'success');
      this.loadPlaces();
      this.loadPlacesStats();
    } catch (e) {
      this.showToast('Mekan silinemedi', 'error');
    }
  },

  async clearPlacesCache() {
    if (!confirm('Tum places cache\'ini temizlemek istediginize emin misiniz? Yeni sorgularda Google API tekrar cagirilacak.')) return;

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/places/cache`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed');
      this.showToast('Cache temizlendi', 'success');
      this.loadPlacesStats();
      this.loadPlaces();
    } catch (e) {
      this.showToast('Cache temizlenemedi', 'error');
    }
  },

  /**
   * Get default AI monitoring prompt
   */
  getDefaultMonitoringPrompt() {
    return `Sen bir acil durum algılama asistanısın. Sana verilen görüntüyü analiz et ve sadece JSON formatında yanıt ver.

Tespit etmen gereken durumlar:
- Düşmüş kişi (yerde yatan, bilinçsiz görünen)
- Yangın veya duman
- Kavga veya şiddet
- Panik hali veya kaçış
- Tıbbi acil durum belirtileri

JSON formatı:
{
  "alarm": true/false,
  "confidence": 0-100,
  "tasvir": "kısa açıklama"
}

Önemli:
- Normal aktiviteler için alarm: false
- Sadece gerçek acil durumlar için alarm: true
- Emin değilsen düşük confidence ver
- Yanıt SADECE JSON olmalı, başka metin yok`;
  }
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  AdminPanel.init();
});
