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

        // Check for vehicles without Fleet Telemetry
        const noTelemetry = data.vehicles.filter(v => !v.telemetryEnabled);
        if (noTelemetry.length > 0) {
          this._showTelemetryPrompt(noTelemetry);
        }
      } else {
        showNotification('Herhangi bir Tesla aracınız bağlı değil.', 'info');
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
  },

  _showTelemetryPrompt(vehicles) {
    // Remove existing modal
    const existing = document.getElementById('tesla-vk-modal');
    if (existing) existing.remove();

    const vehicleNames = vehicles.map(v => v.displayName).join(', ');
    const vkUrl = 'https://tesla.com/_ak/telemetry.qbitmap.com';
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(vkUrl)}&bgcolor=1a1a2e&color=ffffff`;

    // Build modal
    const overlay = document.createElement('div');
    overlay.id = 'tesla-vk-modal';
    overlay.className = 'tesla-vk-overlay';

    const modal = document.createElement('div');
    modal.className = 'tesla-vk-modal';

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tesla-vk-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => overlay.remove());

    // Header
    const header = document.createElement('div');
    header.className = 'tesla-vk-header';
    const logoSpan = document.createElement('span');
    logoSpan.className = 'tesla-popup-logo-t';
    logoSpan.textContent = 'T';
    const title = document.createElement('span');
    title.className = 'tesla-vk-title';
    title.textContent = 'Qbitmap Tesla Community';
    header.append(logoSpan, title);

    // Description
    const desc = document.createElement('p');
    desc.className = 'tesla-vk-desc';
    desc.textContent = 'Tesla uygulamanizdan "virtual key" onaylamaniz gerekiyor.';

    // QR Code
    const qrSection = document.createElement('div');
    qrSection.className = 'tesla-vk-qr';
    const qrImg = document.createElement('img');
    qrImg.src = qrUrl;
    qrImg.alt = 'QR Code';
    qrImg.width = 200;
    qrImg.height = 200;
    const qrLabel = document.createElement('p');
    qrLabel.className = 'tesla-vk-qr-label';
    qrLabel.textContent = 'Cep telefonunuzdan bu QR kodu okutun';
    qrSection.append(qrImg, qrLabel);

    // Or link
    const orDiv = document.createElement('div');
    orDiv.className = 'tesla-vk-or';
    orDiv.textContent = 'veya asagidaki linki tiklayin';

    const linkEl = document.createElement('a');
    linkEl.className = 'tesla-vk-link';
    linkEl.href = vkUrl;
    linkEl.target = '_blank';
    linkEl.rel = 'noopener';
    linkEl.textContent = vkUrl;

    // Warning
    const warning = document.createElement('p');
    warning.className = 'tesla-vk-warning';
    warning.textContent = 'Aracınızın yakınında olmanız gerekiyor (Bluetooth pairing)';

    // Enable button
    const enableBtn = document.createElement('button');
    enableBtn.className = 'tesla-vk-enable';
    enableBtn.textContent = 'Onayladim, Etkinlestir';
    enableBtn.addEventListener('click', async () => {
      enableBtn.disabled = true;
      enableBtn.textContent = 'Etkinlestiriliyor...';

      let allSuccess = true;
      for (const v of vehicles) {
        try {
          const res = await fetch(`${QBitmapConfig.api.base}/api/tesla/vehicles/${v.vehicleId}/enable-telemetry`, {
            method: 'POST',
            credentials: 'include',
          });
          const data = await res.json();
          if (!data.telemetryEnabled) {
            allSuccess = false;
            console.warn('Enable failed:', data.error, data.detail);
          }
        } catch (err) {
          allSuccess = false;
          console.warn('Enable error:', err);
        }
      }

      if (allSuccess) {
        overlay.remove();
        showNotification('Fleet Telemetry basariyla etkinlestirildi!', 'success');
      } else {
        enableBtn.disabled = false;
        enableBtn.textContent = 'Tekrar Dene';
        showNotification('Telemetry etkinlestirme basarisiz. Virtual key onayladiniz mi?', 'error');
      }
    });

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    modal.append(closeBtn, header, desc, qrSection, orDiv, linkEl, warning, enableBtn);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }
};

