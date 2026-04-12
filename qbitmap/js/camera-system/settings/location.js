import { Logger } from '../../utils.js';
import * as AppState from '../../state.js';

const LocationMixin = {
  /**
   * Pick location from map for settings
   */
  pickLocationFromSettings() {
    const cache = this.settingsCache;
    if (!cache) {
      Logger.error('[Settings] No cache found');
      return;
    }

    // Check if map is available
    if (!AppState.map) {
      alert('Harita bulunamadi');
      return;
    }

    // Store cache values before closing
    const deviceId = cache.deviceId;
    const cameraId = cache.cameraId;
    Logger.log('[Settings] Starting location pick for:', { deviceId, cameraId });

    // Close settings drawer temporarily
    this.closeSettings();

    // Also close my-cameras sidebar if open
    if (typeof MyCamerasSystem !== 'undefined' && MyCamerasSystem.close) {
      MyCamerasSystem.close();
    }

    // Show instruction toast
    this.showLocationPickToast();

    // Set crosshair cursor
    AppState.map.getCanvas().style.cursor = 'crosshair';

    // Flag to prevent double handling
    this._isPickingLocation = true;

    // Create click handler
    const self = this;
    const handleMapClick = function(e) {
      Logger.log('[Settings] Map clicked!', e.lngLat);

      // Prevent if already handled
      if (!self._isPickingLocation) {
        Logger.log('[Settings] Already handled, ignoring');
        return;
      }
      self._isPickingLocation = false;

      const lat = e.lngLat.lat;
      const lng = e.lngLat.lng;
      Logger.log('[Settings] Coordinates:', { lat, lng });

      // Store the picked coordinates
      self._pickedLocation = { lat, lng };

      // Clean up immediately
      self.cleanupLocationPick();
      Logger.log('[Settings] Cleaned up, reopening settings...');

      // Reopen settings with new coordinates
      setTimeout(() => {
        Logger.log('[Settings] Calling openSettings with:', deviceId, cameraId);
        self.openSettings(deviceId, cameraId);
        // Update the coordinate inputs after form renders
        setTimeout(() => {
          const latInput = document.getElementById('settings-lat');
          const lngInput = document.getElementById('settings-lng');
          Logger.log('[Settings] Found inputs:', { latInput: !!latInput, lngInput: !!lngInput });
          if (latInput) latInput.value = lat.toFixed(6);
          if (lngInput) lngInput.value = lng.toFixed(6);
        }, 500);
      }, 200);
    };

    // Store handler reference for cleanup
    this._locationPickHandler = handleMapClick;

    // Add click listener - try both methods
    AppState.map.once('click', handleMapClick);
    Logger.log('[Settings] Click listener added via map.once');

    // Also add via canvas directly as fallback
    const canvas = AppState.map.getCanvas();
    this._canvasClickHandler = (e) => {
      Logger.log('[Settings] Canvas clicked directly!');
      // Get coordinates from map
      const rect = canvas.getBoundingClientRect();
      const point = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
      const lngLat = AppState.map.unproject(point);
      Logger.log('[Settings] Canvas lngLat:', lngLat);

      // Create fake event for handler
      handleMapClick({ lngLat });

      // Remove this handler
      canvas.removeEventListener('click', this._canvasClickHandler);
    };
    canvas.addEventListener('click', this._canvasClickHandler, { once: true, capture: true });
    Logger.log('[Settings] Canvas click listener also added (capture phase)');

    // Add escape key handler to cancel
    this._escapeHandler = (e) => {
      if (e.key === 'Escape') {
        Logger.log('[Settings] Escape pressed, canceling');
        this._isPickingLocation = false;
        this.cleanupLocationPick();
        // Reopen settings without changes
        setTimeout(() => {
          this.openSettings(deviceId, cameraId);
        }, 200);
      }
    };
    document.addEventListener('keydown', this._escapeHandler);
  },

  /**
   * Show toast instruction for location picking
   */
  showLocationPickToast() {
    // Remove existing toast if any
    const existingToast = document.querySelector('.location-pick-toast');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = 'location-pick-toast';
    toast.innerHTML = `
      <span>📍 Haritada bir noktaya tıklayın</span>
      <small>İptal için ESC tuşuna basın</small>
    `;
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #1a1a2e;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(toast);
  },

  /**
   * Clean up location pick mode
   */
  cleanupLocationPick() {
    // Reset cursor
    if (AppState.map) {
      AppState.map.getCanvas().style.cursor = '';
      if (this._locationPickHandler) {
        AppState.map.off('click', this._locationPickHandler);
        this._locationPickHandler = null;
      }
      // Also remove canvas click handler
      if (this._canvasClickHandler) {
        AppState.map.getCanvas().removeEventListener('click', this._canvasClickHandler);
        this._canvasClickHandler = null;
      }
    }

    // Remove escape handler
    if (this._escapeHandler) {
      document.removeEventListener('keydown', this._escapeHandler);
      this._escapeHandler = null;
    }

    // Remove toast
    const toast = document.querySelector('.location-pick-toast');
    if (toast) toast.remove();
  },
};

export { LocationMixin };
