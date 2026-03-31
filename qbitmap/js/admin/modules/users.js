import { QBitmapConfig } from '../../config.js';
import { escapeHtml } from '../../utils.js';
import { safeAvatarUrl } from './utils.js';

export const UsersMixin = {
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

  renderUsers() {
    const tbody = document.getElementById('users-tbody');

    if (this.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><h3>No users found</h3><p>Try adjusting your filters</p></td></tr>';
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
        <td><span class="status-dot ${user.is_active ? 'active' : 'inactive'}"></span>${user.is_active ? 'Active' : 'Inactive'}</td>
        <td><span class="time-ago">${user.last_login ? this.timeAgo(user.last_login) : 'Never'}</span></td>
        <td><button class="btn btn-small btn-ghost" data-action="edit-user" data-id="${user.id}">Edit</button></td>
      </tr>
    `).join('');
  },

  renderPagination() {
    const container = document.getElementById('users-pagination');
    const { page, totalPages } = this.pagination;

    if (totalPages <= 1) { container.innerHTML = ''; return; }

    let html = `<button class="page-btn" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">Prev</button>`;
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
        html += `<button class="page-btn ${i === page ? 'active' : ''}" data-page="${i}">${i}</button>`;
      } else if (i === page - 2 || i === page + 2) {
        html += '<span class="page-btn">...</span>';
      }
    }
    html += `<button class="page-btn" ${page >= totalPages ? 'disabled' : ''} data-page="${page + 1}">Next</button>`;
    container.innerHTML = html;
  },

  goToPage(page) {
    this.pagination.page = page;
    this.loadUsers();
  },

  async openUserModal(userId) {
    this.editingUserId = userId;
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/users/${userId}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load user');
      const user = await response.json();

      document.getElementById('modal-avatar').style.backgroundImage = user.avatar_url ? `url(${safeAvatarUrl(user.avatar_url)})` : 'none';
      document.getElementById('modal-user-name').textContent = user.display_name || 'No Name';
      document.getElementById('modal-user-email').textContent = user.email;

      const planSelect = document.getElementById('modal-plan');
      planSelect.innerHTML = this.plans.map(p =>
        `<option value="${p.id}" ${p.id === user.plan_id ? 'selected' : ''}>${escapeHtml(p.display_name)}</option>`
      ).join('');

      document.getElementById('modal-role').value = user.role || 'user';
      document.getElementById('modal-active').checked = user.is_active !== 0;
      document.getElementById('modal-notes').value = user.notes || '';

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

      const usage = user.usage || {};
      document.getElementById('modal-usage').innerHTML = `
        <div class="usage-item"><span class="usage-label">Cameras</span><span class="usage-value">${user.camera_count}</span></div>
        <div class="usage-item"><span class="usage-label">AI Today</span><span class="usage-value">${usage.ai_analysis_count || 0}</span></div>
        <div class="usage-item"><span class="usage-label">Recording</span><span class="usage-value">${usage.recording_minutes || 0} min</span></div>
        <div class="usage-item"><span class="usage-label">Voice Calls</span><span class="usage-value">${usage.voice_call_count || 0}</span></div>
      `;

      document.getElementById('user-modal').classList.add('active');
    } catch (error) {
      console.error('[Admin] Failed to load user:', error);
      this.showToast('Failed to load user', 'error');
    }
  },

  closeUserModal() {
    document.getElementById('user-modal').classList.remove('active');
    this.editingUserId = null;
  },

  async saveUser() {
    if (!this.editingUserId) return;

    const data = {
      plan_id: parseInt(document.getElementById('modal-plan').value),
      role: document.getElementById('modal-role').value,
      is_active: document.getElementById('modal-active').checked,
      notes: document.getElementById('modal-notes').value
    };

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/users/${this.editingUserId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(data)
      });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Failed to save user'); }

      const overrides = {};
      if (document.getElementById('override-cameras-enabled').checked) overrides.max_cameras = parseInt(document.getElementById('override-cameras').value) || 0;
      if (document.getElementById('override-whep-enabled').checked) overrides.max_whep_cameras = parseInt(document.getElementById('override-whep').value) || 0;
      if (document.getElementById('override-ai-enabled').checked) { overrides.ai_analysis_enabled = 1; overrides.ai_daily_limit = parseInt(document.getElementById('override-ai').value) || 0; }
      if (document.getElementById('override-face-enabled').checked) { overrides.face_recognition_enabled = 1; overrides.max_faces_per_camera = parseInt(document.getElementById('override-faces').value) || 0; }
      if (document.getElementById('override-recording-enabled').checked) { overrides.recording_enabled = 1; overrides.max_recording_hours = parseInt(document.getElementById('override-recording').value) || 0; }
      if (document.getElementById('override-voice-call').checked) overrides.voice_call_enabled = 1;
      if (document.getElementById('override-voice-control').checked) overrides.voice_control_enabled = 1;
      if (document.getElementById('override-public-sharing').checked) overrides.public_sharing_enabled = 1;

      if (Object.keys(overrides).length > 0) {
        await fetch(`${QBitmapConfig.api.admin}/users/${this.editingUserId}/overrides`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          credentials: 'include', body: JSON.stringify(overrides)
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

  async clearOverrides() {
    if (!this.editingUserId) return;
    try {
      await fetch(`${QBitmapConfig.api.admin}/users/${this.editingUserId}/overrides`, { method: 'DELETE', credentials: 'include' });
      this.showToast('Overrides cleared', 'success');
      this.openUserModal(this.editingUserId);
    } catch (error) {
      console.error('[Admin] Failed to clear overrides:', error);
      this.showToast('Failed to clear overrides', 'error');
    }
  },
};
