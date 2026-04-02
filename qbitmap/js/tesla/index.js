import '../../css/tesla.css';
import { TeslaLayer } from './layer.js';
import { TeslaPopup } from './popup.js';
import { TeslaWebSocket } from './websocket.js';
import { map, layers } from '../state.js';
import { showNotification } from '../utils.js';
import { QBitmapConfig } from '../config.js';

export const TeslaSystem = {
  initialized: false,
  connected: null, // null = unknown, true/false after check

  async handleButtonClick() {
    // Check qbitmap login
    const authModule = await import('/js/auth.js');
    const user = authModule.default?.user || authModule.AuthSystem?.user;
    if (!user) {
      showNotification('Tesla bağlantısı için giriş yapmanız gerekiyor', 'warning');
      return;
    }

    // Check Tesla connection status
    try {
      const res = await fetch(`${QBitmapConfig.api.base}/api/tesla/status`, { credentials: 'include' });
      const data = await res.json();
      this.connected = data.connected;
    } catch {
      showNotification('Tesla durumu kontrol edilemedi', 'error');
      return;
    }

    if (!this.connected) {
      // Redirect to Tesla OAuth
      window.location.href = `${QBitmapConfig.api.base}/auth/tesla`;
      return;
    }

    // Toggle Tesla layer
    layers.teslaVehiclesVisible = !layers.teslaVehiclesVisible;
    const btn = document.getElementById('tesla-button');
    if (btn) btn.classList.toggle('active', layers.teslaVehiclesVisible);

    // Sync layers dropdown toggle if exists
    const layersControl = document.querySelector('.layers-dropdown-wrapper');
    if (layersControl?.__control) {
      layersControl.__control.syncToggleState('tesla-vehicles', layers.teslaVehiclesVisible);
    }

    if (layers.teslaVehiclesVisible) {
      await this.show();
    } else {
      this.hide();
    }
  },

  async init() {
    if (this.initialized || !map) return;
    this.initialized = true;

    await TeslaLayer.init(map);
    TeslaPopup.init(map);
    TeslaWebSocket.init((vehicles) => {
      TeslaLayer.updateVehicles(vehicles);
    }, (update) => {
      TeslaLayer.updateSingleVehicle(update);
    });
  },

  async show() {
    await this.init();

    // Fetch vehicles
    try {
      const res = await fetch(`${QBitmapConfig.api.base}/api/tesla/vehicles`, { credentials: 'include' });
      const data = await res.json();
      if (data.vehicles && data.vehicles.length > 0) {
        TeslaLayer.updateVehicles(data.vehicles);
        TeslaLayer.show();

        // Fly to first vehicle with location
        const first = data.vehicles.find(v => v.lat && v.lng);
        if (first) {
          map.flyTo({ center: [first.lng, first.lat], zoom: 14 });
        }
      } else {
        showNotification('Henüz Tesla aracı bulunamadı', 'info');
      }
    } catch (err) {
      console.error('Tesla vehicles fetch error:', err);
    }

    // Subscribe to WebSocket updates
    TeslaWebSocket.subscribe();
  },

  hide() {
    TeslaLayer.hide();
    TeslaWebSocket.unsubscribe();
  }
};

