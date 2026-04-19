import '../../css/my-cameras.css';
import { QBitmapConfig } from '../config.js';
import { Logger } from '../utils.js';
import { AuthSystem } from '../auth.js';
import { CameraSystem } from '../camera-system/index.js';
import { DashboardMixin } from './dashboard.js';
import { ClaimMixin } from './claim.js';
import { FaceRecognitionMixin } from './face-recognition.js';
import { CameraActionsMixin } from './camera-actions.js';
import { SharingMixin } from './sharing.js';
import * as AppState from '../state.js';

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

  init() {
    this.createDashboard();
    this.setupEventDelegation();

    window.addEventListener('auth:login', () => this.loadCameras());
    window.addEventListener('auth:logout', () => {
      this.cameras = [];
      this.sharedCameras = [];
      if (this.isOpen) this.close();
    });
    window.addEventListener('sidemenu:open', (e) => {
      if (e.detail?.id !== 'my-cameras' && this.isOpen) this.close();
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
        case 'watch': {
          const lng = parseFloat(target.dataset.lng);
          const lat = parseFloat(target.dataset.lat);
          if (CameraSystem && lng && lat) {
            this.close();
            AppState.map?.flyTo({ center: [lng, lat], zoom: 17 });
            setTimeout(() => CameraSystem.openCameraPopup(deviceId, [lng, lat]), 500);
          }
          break;
        }
        case 'recordings': this.openRecordings(deviceId); break;
        case 'settings': this.openCameraSettings(deviceId, cameraId); break;
        case 'location': this.pickCameraLocation(deviceId, cameraId); break;
        case 'face': this.openFaceRecognition(deviceId); break;
        case 'delete': {
          const name = target.dataset.cameraName || '';
          const type = target.dataset.cameraType || '';
          this.confirmDeleteCamera(cameraId, name, type);
          break;
        }
        case 'voice': this.toggleVoiceCall(deviceId, target); break;
        case 'record': {
          const lng = parseFloat(target.dataset.lng);
          const lat = parseFloat(target.dataset.lat);
          this.openAndRecord(deviceId, lng, lat);
          break;
        }
        case 'share': this.openShareModal(cameraId); break;
        case 'view-shared': {
          const lng = parseFloat(target.dataset.lng);
          const lat = parseFloat(target.dataset.lat);
          this.viewSharedCamera(deviceId, lng, lat);
          break;
        }
        case 'watch-shared': {
          const lng = parseFloat(target.dataset.lng);
          const lat = parseFloat(target.dataset.lat);
          this.openSharedCameraPopup(deviceId, lng, lat);
          break;
        }
      }
    });
  },

  createDashboard() {
    const dashboard = document.createElement('div');
    dashboard.id = 'my-cameras-dashboard';
    dashboard.className = 'my-cameras-dashboard';
    dashboard.innerHTML = `
      <div class="dashboard-overlay"></div>
      <div class="dashboard-panel">
        <div class="dashboard-header">
          <h2>Kameralarım</h2>
          <button class="close-btn">&times;</button>
        </div>
        <div class="dashboard-content">
          <div class="dashboard-loading">
            <div class="loading-spinner"></div>
            <p>Yükleniyor...</p>
          </div>
        </div>
      </div>
    `;
    dashboard.querySelector('.dashboard-overlay').addEventListener('click', () => MyCamerasSystem.close());
    dashboard.querySelector('.close-btn').addEventListener('click', () => MyCamerasSystem.close());
    document.body.appendChild(dashboard);
  },

  async open() {
    if (!AuthSystem.isLoggedIn()) {
      AuthSystem.showNotification('Önce giriş yapmalısınız', 'error');
      return;
    }

    window.dispatchEvent(new CustomEvent('sidemenu:open', { detail: { id: 'my-cameras' } }));
    const dashboard = document.getElementById('my-cameras-dashboard');
    dashboard.classList.add('active');
    this.isOpen = true;

    await this.loadCameras();
  },

  close() {
    const dashboard = document.getElementById('my-cameras-dashboard');
    dashboard.classList.remove('active');
    this.isOpen = false;
    if (this.cancelLocationPick) this.cancelLocationPick();
  },

  isCameraOnline(camera) {
    return true;
  },

  async loadCameras() {
    const content = document.querySelector('.dashboard-content');
    try {
      const [camerasResult, sharedResult] = await Promise.allSettled([
        fetch(`${this.apiBase}/me/cameras`, { credentials: 'include' }),
        fetch(`${this.apiBase}/me/shared-cameras`, { credentials: 'include' })
      ]);
      if (camerasResult.status === 'fulfilled' && camerasResult.value.ok) {
        const data = await camerasResult.value.json();
        this.cameras = data.cameras || [];
      } else {
        throw new Error('Failed to load cameras');
      }
      if (sharedResult.status === 'fulfilled' && sharedResult.value.ok) {
        const sharedData = await sharedResult.value.json();
        this.sharedCameras = sharedData.cameras || [];
      } else {
        this.sharedCameras = [];
      }
      this.renderCameras();
    } catch (error) {
      Logger.error('[MyCameras] Load error:', error);
      if (content) content.innerHTML = '<div class="dashboard-error">Kameralar yüklenemedi</div>';
    }
  },
};

// Merge all mixins
Object.assign(MyCamerasSystem,
  DashboardMixin, ClaimMixin, FaceRecognitionMixin, CameraActionsMixin, SharingMixin
);

// Init immediately (this module is lazy-loaded after DOMContentLoaded)
MyCamerasSystem.init();

export { MyCamerasSystem };
