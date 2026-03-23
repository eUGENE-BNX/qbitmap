import { QBitmapConfig } from '../config.js';
import { Logger } from '../utils.js';
import { AuthSystem } from '../auth.js';
import { DashboardMixin } from './dashboard.js';
import { ClaimMixin } from './claim.js';
import { FaceRecognitionMixin } from './face-recognition.js';
import { CameraActionsMixin } from './camera-actions.js';
import { SharingMixin } from './sharing.js';

/**
 * QBitmap My Cameras Dashboard
 * Manage user's cameras - claim, configure, set location
 */

const MyCamerasSystem = {
  cameras: [],
  sharedCameras: [],
  apiBase: QBitmapConfig.api.users,
  publicApiBase: QBitmapConfig.api.public,
  isOpen: false,
  isPickingLocation: false,
  editingCameraId: null,
  _isSubmitting: false,

  // Compact view state
  viewMode: 'compact',
  activeTypeFilter: 'all',
  activeStatusFilter: 'all',
  expandedCardIds: new Set(),

  init() {
    this.createDashboard();
    this.setupEventDelegation();

    window.addEventListener('auth:login', () => this.loadCameras());
    window.addEventListener('auth:logout', () => {
      this.cameras = [];
      this.sharedCameras = [];
      if (this.isOpen) this.close();
    });

    Logger.log('[MyCameras] Dashboard initialized');
  },

  setupEventDelegation() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;

      const action = target.dataset.action;
      const deviceId = target.dataset.deviceId || target.closest('[data-device-id]')?.dataset.deviceId;
      const cameraId = target.dataset.cameraId || target.closest('[data-camera-id]')?.dataset.cameraId;

      switch (action) {
        case 'expand-card': this.toggleCardExpand(deviceId || cameraId); break;
        case 'open-popup': {
          const lng = parseFloat(target.dataset.lng);
          const lat = parseFloat(target.dataset.lat);
          if (window.CameraSystem && lng && lat) {
            this.close();
            window.map?.flyTo({ center: [lng, lat], zoom: 17 });
            setTimeout(() => CameraSystem.openCameraPopup(deviceId, [lng, lat]), 500);
          }
          break;
        }
        case 'open-recordings': this.openRecordings(deviceId); break;
        case 'open-settings': this.openCameraSettings(deviceId, cameraId); break;
        case 'pick-location': this.pickCameraLocation(deviceId, cameraId); break;
        case 'open-face-recognition': this.openFaceRecognition(deviceId); break;
        case 'delete-camera': {
          const name = target.dataset.cameraName || '';
          const type = target.dataset.cameraType || '';
          this.confirmDeleteCamera(cameraId, name, type);
          break;
        }
        case 'toggle-voice-call': this.toggleVoiceCall(deviceId, target); break;
        case 'open-and-record': {
          const lng = parseFloat(target.dataset.lng);
          const lat = parseFloat(target.dataset.lat);
          this.openAndRecord(deviceId, lng, lat);
          break;
        }
        case 'share-camera': this.openShareModal(cameraId); break;
        case 'view-shared': {
          const lng = parseFloat(target.dataset.lng);
          const lat = parseFloat(target.dataset.lat);
          this.viewSharedCamera(deviceId, lng, lat);
          break;
        }
        case 'open-shared-popup': {
          const lng = parseFloat(target.dataset.lng);
          const lat = parseFloat(target.dataset.lat);
          this.openSharedCameraPopup(deviceId, lng, lat);
          break;
        }
      }
    });
  },

  createDashboard() {
    // Dashboard DOM creation handled by mixin methods
  },

  async open() {
    if (this.isOpen) return;
    this.isOpen = true;
    await this.loadCameras();
    const panel = document.getElementById('my-cameras-panel');
    if (panel) {
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
    }
  },

  close() {
    this.isOpen = false;
    const panel = document.getElementById('my-cameras-panel');
    if (panel) {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    }
  },

  getCameraType(camera) {
    if (camera.camera_type === 'city') return 'city';
    if (camera.camera_type === 'rtmp') return 'rtmp';
    if (camera.is_whep) return 'rtsp';
    return 'device';
  },

  isCameraOnline(camera) {
    if (camera.camera_type === 'city') return true;
    if (camera.is_whep) {
      if (!camera.last_seen) return false;
      const diff = Date.now() - new Date(camera.last_seen).getTime();
      return diff < 120000;
    }
    return camera.is_online || false;
  },

  getFilteredCameras() {
    let filtered = [...this.cameras];
    if (this.activeTypeFilter !== 'all') {
      filtered = filtered.filter(c => this.getCameraType(c) === this.activeTypeFilter);
    }
    if (this.activeStatusFilter !== 'all') {
      const wantOnline = this.activeStatusFilter === 'online';
      filtered = filtered.filter(c => this.isCameraOnline(c) === wantOnline);
    }
    return filtered;
  },

  getCameraCounts() {
    const counts = { all: this.cameras.length, rtsp: 0, rtmp: 0, device: 0, city: 0, online: 0, offline: 0 };
    for (const c of this.cameras) {
      const type = this.getCameraType(c);
      counts[type] = (counts[type] || 0) + 1;
      if (this.isCameraOnline(c)) counts.online++; else counts.offline++;
    }
    return counts;
  },

  setViewMode(mode) {
    this.viewMode = mode;
    this.renderCameras();
    document.querySelectorAll('.my-cameras-view-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === mode);
    });
  },

  setTypeFilter(type) {
    this.activeTypeFilter = type;
    this.renderCameras();
  },

  setStatusFilter(status) {
    this.activeStatusFilter = status;
    this.renderCameras();
  },

  toggleCardExpand(cameraId) {
    if (this.expandedCardIds.has(cameraId)) {
      this.expandedCardIds.delete(cameraId);
    } else {
      this.expandedCardIds.add(cameraId);
    }
    this.renderCameras();
  },

  async loadCameras() {
    try {
      const [ownedRes, sharedRes] = await Promise.allSettled([
        fetch(`${this.apiBase}/me/cameras`, { credentials: 'include' }),
        fetch(`${this.apiBase}/me/shared-cameras`, { credentials: 'include' })
      ]);
      if (ownedRes.status === 'fulfilled' && ownedRes.value.ok) {
        const data = await ownedRes.value.json();
        this.cameras = data.cameras || [];
      }
      if (sharedRes.status === 'fulfilled' && sharedRes.value.ok) {
        const data = await sharedRes.value.json();
        this.sharedCameras = data.cameras || [];
      }
      if (this.isOpen) this.renderCameras();
    } catch (err) {
      Logger.error('[MyCameras] loadCameras error:', err);
    }
  },
};

// Merge all mixins
Object.assign(MyCamerasSystem,
  DashboardMixin, ClaimMixin, FaceRecognitionMixin, CameraActionsMixin, SharingMixin
);

export { MyCamerasSystem };
window.MyCamerasSystem = MyCamerasSystem;
