import { QBitmapConfig } from '../config.js';
import { UtilsMixin } from './modules/utils.js';
import { PlansMixin } from './modules/plans.js';
import { UsersMixin } from './modules/users.js';
import { OnvifMixin } from './modules/onvif.js';
import { AiVoiceMixin } from './modules/ai-voice.js';
import { MessagesMixin } from './modules/messages.js';
import { PlacesMixin } from './modules/places.js';
import { CityCamerasMixin } from './modules/city-cameras.js';
import { ReportsMixin } from './modules/reports.js';

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
  cityCameras: [],
  editingCityCameraId: null,
  reports: [],
  reportsPagination: { page: 1, limit: 20, total: 0 },

  async init() {
    const authed = await this.checkAuth();
    if (!authed) { window.location.href = '/'; return; }
    document.querySelector('.admin-container').style.display = '';
    this.bindEvents();
    await this.loadStats();
    await this.loadPlans();
    await this.loadUsers();
  },

  async checkAuth() {
    try {
      const response = await fetch(`${QBitmapConfig.api.users}/me`, { credentials: 'include' });
      if (!response.ok) return false;
      const user = await response.json();
      if (user.role !== 'admin') { this.showToast('Admin access required', 'error'); return false; }
      this.currentUser = user;
      document.getElementById('user-email').textContent = user.email;
      return true;
    } catch (error) { console.error('[Admin] Auth check failed:', error); return false; }
  },

  bindEvents() {
    // Tabs
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });

    // Search and filters
    document.getElementById('user-search').addEventListener('input', this.debounce(() => this.loadUsers(), 300));
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

    // AI & Voice Settings
    document.getElementById('save-ai-settings-btn').addEventListener('click', () => this.saveAiSettings());
    document.getElementById('save-voice-settings-btn').addEventListener('click', () => this.saveVoiceSettings());

    // Messages
    document.getElementById('msg-search').addEventListener('input', this.debounce(() => { this.messagesPagination.page = 1; this.loadMessages(); }, 300));
    document.getElementById('msg-type-filter').addEventListener('change', () => { this.messagesPagination.page = 1; this.loadMessages(); });

    // Reports
    document.getElementById('report-search').addEventListener('input', this.debounce(() => { this.reportsPagination.page = 1; this.loadReports(); }, 300));
    document.getElementById('report-status-filter').addEventListener('change', () => { this.reportsPagination.page = 1; this.loadReports(); });
    document.getElementById('report-type-filter').addEventListener('change', () => { this.reportsPagination.page = 1; this.loadReports(); });

    // Close modals on overlay click
    document.getElementById('user-modal').addEventListener('click', (e) => { if (e.target.id === 'user-modal') this.closeUserModal(); });
    document.getElementById('plan-modal').addEventListener('click', (e) => { if (e.target.id === 'plan-modal') this.closePlanModal(); });
    document.getElementById('onvif-modal').addEventListener('click', (e) => { if (e.target.id === 'onvif-modal') this.closeOnvifModal(); });

    // Event delegation for dynamic tables
    document.getElementById('users-tbody').addEventListener('click', (e) => { const btn = e.target.closest('[data-action="edit-user"]'); if (btn) this.openUserModal(Number(btn.dataset.id)); });
    document.getElementById('users-pagination').addEventListener('click', (e) => { const btn = e.target.closest('button[data-page]'); if (btn && !btn.disabled) this.goToPage(Number(btn.dataset.page)); });
    document.getElementById('onvif-tbody').addEventListener('click', (e) => { const btn = e.target.closest('[data-action="edit-onvif"]'); if (btn) this.openOnvifModal(Number(btn.dataset.id)); });
    document.getElementById('messages-tbody').addEventListener('click', (e) => { const btn = e.target.closest('[data-action="delete-message"]'); if (btn) this.deleteMessage(btn.dataset.id); });
    document.getElementById('messages-pagination').addEventListener('click', (e) => { const btn = e.target.closest('button[data-page]'); if (btn && !btn.disabled) this.goToMessagesPage(Number(btn.dataset.page)); });
    document.getElementById('places-tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]'); if (!btn) return;
      const id = Number(btn.dataset.id);
      if (btn.dataset.action === 'edit-place-icon') this.editPlaceIcon(id);
      else if (btn.dataset.action === 'delete-place') this.deletePlace(id);
    });
    document.getElementById('places-pagination').addEventListener('click', (e) => { const btn = e.target.closest('button[data-page]'); if (btn && !btn.disabled) this.goToPlacesPage(Number(btn.dataset.page)); });
    document.getElementById('city-cameras-tbody').addEventListener('click', (e) => { const btn = e.target.closest('[data-action="edit-city-camera"]'); if (btn) this.openCityCameraModal(Number(btn.dataset.id)); });
    document.getElementById('reports-tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]'); if (!btn) return;
      if (btn.dataset.action === 'goto-content') {
        this.gotoReportedContent(btn.dataset.lat, btn.dataset.lng, btn.dataset.entityId, btn.dataset.entityType);
      } else {
        const id = Number(btn.dataset.id);
        if (btn.dataset.action === 'delete-reported-content') this.deleteReportedContent(id);
        else if (btn.dataset.action === 'dismiss-report') this.dismissReport(id);
      }
    });
    document.getElementById('reports-pagination').addEventListener('click', (e) => { const btn = e.target.closest('button[data-page]'); if (btn && !btn.disabled) this.goToReportsPage(Number(btn.dataset.page)); });
  },

  async loadStats() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/stats`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load stats');
      const stats = await response.json();
      document.getElementById('stat-users').textContent = stats.total_users;
      document.getElementById('stat-active').textContent = stats.active_users;
      document.getElementById('stat-cameras').textContent = stats.total_cameras;
      document.getElementById('stat-online').textContent = stats.online_cameras;
      document.getElementById('stat-ai').textContent = stats.today_ai_queries;
      document.getElementById('stat-videos').textContent = stats.total_videos;
      document.getElementById('stat-photos').textContent = stats.total_photos;
    } catch (error) { console.error('[Admin] Failed to load stats:', error); }
  },

  switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');

    if (tabName === 'onvif' && this.onvifTemplates.length === 0) this.loadOnvifTemplates();
    if (tabName === 'ai') this.loadAiSettings();
    if (tabName === 'voice') this.loadVoiceSettings();
    if (tabName === 'messages') this.loadMessages();
    if (tabName === 'places') this.loadPlacesTab();
    if (tabName === 'city-cameras') this.loadCityCameras();
    if (tabName === 'reports') this.loadReports();
  },

  async logout() {
    try { await fetch(`${QBitmapConfig.api.base}/auth/logout`, { method: 'POST', credentials: 'include' }); } catch (e) {}
    window.location.href = '/';
  },
};

// Apply all mixins
Object.assign(AdminPanel, UtilsMixin, PlansMixin, UsersMixin, OnvifMixin, AiVoiceMixin, MessagesMixin, PlacesMixin, CityCamerasMixin, ReportsMixin);

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  AdminPanel.init();

  // City camera modal listeners
  document.getElementById('add-city-camera-btn')?.addEventListener('click', () => AdminPanel.openCityCameraModal());
  document.getElementById('city-camera-modal-close')?.addEventListener('click', () => AdminPanel.closeCityCameraModal());
  document.getElementById('city-camera-modal-cancel')?.addEventListener('click', () => AdminPanel.closeCityCameraModal());
  document.getElementById('city-cam-save-btn')?.addEventListener('click', () => AdminPanel.saveCityCamera());
  document.getElementById('city-cam-delete-btn')?.addEventListener('click', () => AdminPanel.deleteCityCamera());
  document.getElementById('city-camera-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'city-camera-modal') AdminPanel.closeCityCameraModal();
  });
});
