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
  _onvifTimers: {},

  // ONVIF event indicator icons. Same SVG set as the previous map-overlay
  // notifications, repurposed for the in-card indicator.
  onvifEventIcons: {
    'person-icon': `<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
    'pet-icon': `<svg viewBox="0 0 24 24"><path d="M4.5 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm5-2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm5 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm5 2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM12 11.5c-2.5 0-4.5 2-4.5 4.5 0 1.5.5 2.5 1 3.5.5 1 1.5 2 2 2.5.5.5 1 .5 1.5.5s1 0 1.5-.5c.5-.5 1.5-1.5 2-2.5.5-1 1-2 1-3.5 0-2.5-2-4.5-4.5-4.5z"/></svg>`,
    'vehicle-icon': `<svg viewBox="0 0 24 24"><path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/></svg>`,
    'warning-icon': `<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
    'motion-icon': `<svg viewBox="0 0 24 24"><path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L6 8.3V13h2V9.6l1.8-.7"/></svg>`
  },

  handleOnvifEvent(payload) {
    if (!payload?.eventState) return;
    const eventTypeToIcon = {
      motion: 'motion-icon', human: 'person-icon', pet: 'pet-icon',
      vehicle: 'vehicle-icon', line_crossing: 'warning-icon', tamper: 'warning-icon'
    };
    const iconKey = eventTypeToIcon[payload.eventType];
    if (!iconKey) return;

    const slots = document.querySelectorAll(`[data-onvif-indicator="${CSS.escape(payload.deviceId)}"]`);
    slots.forEach(slot => {
      slot.innerHTML = this.onvifEventIcons[iconKey];
      slot.className = `onvif-event-indicator active event-${payload.eventType}`;
      clearTimeout(this._onvifTimers[payload.deviceId]);
      this._onvifTimers[payload.deviceId] = setTimeout(() => {
        slot.classList.remove('active');
        slot.innerHTML = '';
      }, 3000);
    });
  },

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
    window.addEventListener('onvif:event', (e) => this.handleOnvifEvent(e.detail));

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
