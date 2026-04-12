import { QBitmapConfig } from '../../config.js';
import { Logger, escapeHtml } from '../../utils.js';

// ==================== ONVIF Integration ====================

const OnvifMixin = {
  /**
   * Load ONVIF integration status
   */
  async loadOnvifIntegration() {
    Logger.log('[ONVIF] loadOnvifIntegration called');
    const container = document.querySelector('.onvif-link-container');
    Logger.log('[ONVIF] container:', container);
    if (!container) {
      Logger.log('[ONVIF] No container found, returning');
      return;
    }

    const deviceId = container.dataset.deviceId;
    Logger.log('[ONVIF] deviceId:', deviceId);

    try {
      // First, get camera ID from device_id
      const camera = this.cameras.find(c => c.device_id === deviceId);
      if (!camera || !camera.id) {
        container.innerHTML = '<div style="padding: 12px; color: #999;">Kamera bilgisi bulunamadi</div>';
        return;
      }

      const cameraId = camera.id;

      // Load templates and existing link in parallel
      const [templatesResp, linkResp] = await Promise.all([
        fetch(`${QBitmapConfig.api.onvif}/templates`, { credentials: 'include' }),
        fetch(`${QBitmapConfig.api.onvif}/link/${cameraId}`, { credentials: 'include' })
      ]);

      const templatesData = await templatesResp.json();
      const templates = templatesData.templates || [];

      let existingLink = null;
      if (linkResp.ok) {
        const linkData = await linkResp.json();
        Logger.log('[ONVIF] Link response for cameraId', cameraId, ':', linkData);
        if (linkData) {
          if (linkData.qbitmapCameraId) {
            existingLink = linkData;
          } else if (linkData.link && linkData.link.qbitmapCameraId) {
            existingLink = linkData.link;
          }
        }
        Logger.log('[ONVIF] existingLink:', existingLink);
      } else {
        Logger.log('[ONVIF] Link response not ok:', linkResp.status);
      }

      // Render UI
      this.renderOnvifUI(container, templates, existingLink, cameraId);

    } catch (error) {
      Logger.error('[ONVIF] Load error:', error);
      container.innerHTML = '<div style="padding: 12px; color: #f44336;">Yuklenemedi</div>';
    }
  },

  /**
   * Render ONVIF UI
   */
  async renderOnvifUI(container, templates, existingLink, cameraId) {
    if (existingLink) {
      // Show existing link with profile change option
      const supportedEvents = existingLink.supportedEvents || [];
      const currentTemplateId = existingLink.templateId;

      // Build profile options
      const profileOptions = templates.map(t =>
        `<option value="${t.id}" ${t.id === currentTemplateId ? 'selected' : ''}>${escapeHtml(t.manufacturer)} - ${escapeHtml(t.modelName)}</option>`
      ).join('');

      container.innerHTML = `
        <div style="padding: 12px; background: #e8f5e9; border-radius: 6px;">
          <div style="margin-bottom: 8px; font-weight: 500; color: #2e7d32;">ONVIF Bagli</div>
          <div style="font-size: 13px; color: #666; margin-bottom: 8px;">
            <strong>ONVIF ID:</strong> ${escapeHtml(existingLink.onvifCameraId)}
          </div>
          <div style="font-size: 13px; color: #666; margin-bottom: 8px;">
            <strong>Desteklenen Olaylar:</strong> ${supportedEvents.map(e => escapeHtml(e)).join(', ')}
          </div>

          <div style="margin: 12px 0; padding-top: 12px; border-top: 1px solid #c8e6c9;">
            <label style="display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500; color: #333;">Kamera Profili</label>
            <select id="onvif-profile-select" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px;">
              ${profileOptions}
            </select>
            <div style="font-size: 12px; color: #666; margin-top: 4px;">Profili degistirerek farkli event tiplerini destekleyebilirsin.</div>
            <button id="change-profile-btn" data-action="change-profile" style="margin-top: 8px; padding: 6px 12px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">
              Profili Degistir
            </button>
          </div>

          <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #c8e6c9;">
            <button class="onvif-unlink-btn" data-action="unlink-onvif" style="padding: 6px 12px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">
              Baglantıyi Kaldir
            </button>
          </div>
        </div>
      `;
      container.querySelector('[data-action="change-profile"]').addEventListener('click', () => this.changeOnvifProfile(cameraId));
      container.querySelector('[data-action="unlink-onvif"]').addEventListener('click', () => this.unlinkOnvif(cameraId));
    } else {
      // Fetch available cameras from ONVIF service
      let availableCameras = [];
      let fetchError = false;

      try {
        const camerasResp = await fetch(`${QBitmapConfig.api.onvif}/available-cameras`, { credentials: 'include' });
        if (camerasResp.ok) {
          const camerasData = await camerasResp.json();
          availableCameras = camerasData.cameras || [];
        } else {
          fetchError = true;
        }
      } catch (error) {
        Logger.error('[ONVIF] Failed to fetch available cameras:', error);
        fetchError = true;
      }

      // Show link form
      container.innerHTML = `
        <div style="padding: 12px;">
          <div style="margin-bottom: 12px; font-size: 13px; color: #666;">
            Bu kamerayi ONVIF servisindeki bir kamerayla eslestirerek hareket, insan algilama ve diger olaylari harita uzerinde gorebilirsin.
          </div>
          <div class="form-group" style="margin-bottom: 12px;">
            <label style="display: block; margin-bottom: 4px; font-size: 13px; font-weight: 500;">ONVIF Kamerasi</label>
            ${fetchError ? `
              <div style="padding: 12px; background: #ffebee; border-radius: 4px; color: #c62828; margin-bottom: 8px;">
                <strong>ONVIF servisi baglanti hatasi</strong>
                <p style="margin: 8px 0 0 0; font-size: 12px;">ONVIF servisine baglanılamadi. Lutfen daha sonra tekrar dene.</p>
              </div>
            ` : availableCameras.length > 0 ? `
              <select id="onvif-camera-id-select" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px;">
                <option value="">-- Kamera Sec --</option>
                ${availableCameras.map(cam => `<option value="${escapeHtml(cam.id)}">${escapeHtml(cam.name)} (${cam.connected ? '🟢' : '🔴'})</option>`).join('')}
              </select>
              <div style="font-size: 12px; color: #999; margin-top: 4px;">ONVIF servisine eklenmis kameralar</div>
            ` : `
              <div style="padding: 12px; background: #fff3cd; border-radius: 4px; color: #856404;">
                <strong>Henuz ONVIF kamerasi eklenmemis</strong>
                <p style="margin: 8px 0 0 0; font-size: 12px;">
                  ONVIF servisine kamera eklemek icin asagidaki butonu kullan.
                </p>
              </div>
            `}
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            ${availableCameras.length > 0 && !fetchError ? `
              <button class="onvif-link-btn" data-action="link-onvif" style="padding: 8px 16px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500;">
                Bagla
              </button>
            ` : ''}
            <button data-action="add-onvif-camera" style="padding: 8px 16px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500;">
              + Yeni Kamera Ekle
            </button>
          </div>
        </div>
      `;
      const linkBtn = container.querySelector('[data-action="link-onvif"]');
      if (linkBtn) linkBtn.addEventListener('click', () => this.linkOnvif(cameraId));
      container.querySelector('[data-action="add-onvif-camera"]').addEventListener('click', () => this.showAddOnvifCameraModal());
    }
  },

  /**
   * Link ONVIF camera
   */
  async linkOnvif(cameraId) {
    const onvifCameraId = document.getElementById('onvif-camera-id-select')?.value;

    if (!onvifCameraId) {
      alert('Lutfen bir ONVIF kamerasi secin');
      return;
    }

    try {
      const payload = {
        qbitmapCameraId: parseInt(cameraId),
        onvifCameraId
      };

      const response = await fetch(`${QBitmapConfig.api.onvif}/link`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Baglanti basarisiz');
      }

      alert('ONVIF kamera basariyla baglandi!');

      // Reload ONVIF integration UI
      this.loadOnvifIntegration();

    } catch (error) {
      Logger.error('[ONVIF] Link error:', error);
      alert('Hata: ' + error.message);
    }
  },

  /**
   * Unlink ONVIF camera
   */
  async unlinkOnvif(cameraId) {
    if (!confirm('ONVIF baglantisini kaldirmak istediginizden emin misiniz?')) {
      return;
    }

    try {
      const response = await fetch(`${QBitmapConfig.api.onvif}/link/${cameraId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Baglanti kaldirilamadi');
      }

      alert('ONVIF baglantisi kaldirildi');

      // Reload ONVIF integration UI
      this.loadOnvifIntegration();

    } catch (error) {
      Logger.error('[ONVIF] Unlink error:', error);
      alert('Hata: ' + error.message);
    }
  },

  /**
   * Change ONVIF profile for linked camera
   */
  async changeOnvifProfile(cameraId) {
    const select = document.getElementById('onvif-profile-select');
    const btn = document.getElementById('change-profile-btn');

    if (!select) {
      alert('Profil secimi bulunamadi');
      return;
    }

    const templateId = parseInt(select.value);
    if (!templateId) {
      alert('Lutfen bir profil secin');
      return;
    }

    // Disable button during request
    btn.disabled = true;
    btn.textContent = 'Degistiriliyor...';

    try {
      const response = await fetch(`${QBitmapConfig.api.onvif}/link/${cameraId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ templateId })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error((data.error?.message ?? data.error) || 'Profil degistirilemedi');
      }

      alert(`Profil degistirildi: ${data.template.manufacturer} - ${data.template.modelName}`);

      // Reload ONVIF integration UI to show updated info
      this.loadOnvifIntegration();

    } catch (error) {
      Logger.error('[ONVIF] Change profile error:', error);
      alert('Hata: ' + error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Profili Degistir';
    }
  },

  /**
   * Show modal to add new ONVIF camera
   */
  showAddOnvifCameraModal() {
    // Create modal backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'add-onvif-camera-modal';
    backdrop.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; align-items: center; justify-content: center;';

    // Create modal content
    const modal = document.createElement('div');
    modal.style.cssText = 'background: white; border-radius: 8px; padding: 24px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto;';

    modal.innerHTML = `
      <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #333;">Yeni ONVIF Kamera Ekle</h3>
      <div style="font-size: 13px; color: #666; margin-bottom: 20px;">
        RTSP URL'yi yapistirin, kullanici adi, sifre ve host otomatik cikarilacak.
      </div>

      <form id="add-onvif-camera-form" style="display: flex; flex-direction: column; gap: 16px;">
        <div>
          <label style="display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500; color: #555;">RTSP URL <span style="color: red;">*</span></label>
          <input type="text" id="onvif-cam-rtsp" required placeholder="rtsp://kullanici:sifre@192.168.1.100:554/stream" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; box-sizing: border-box; font-family: monospace;">
          <div style="font-size: 11px; color: #999; margin-top: 4px;">Ornek: rtsp://camera:12345678@192.168.1.100:554/stream2</div>
        </div>

        <div id="onvif-parsed-info" style="display: none; background: #f5f5f5; padding: 12px; border-radius: 4px; font-size: 12px;">
          <div style="font-weight: 500; margin-bottom: 8px; color: #333;">Cikarilan Bilgiler:</div>
          <div style="display: grid; grid-template-columns: 100px 1fr; gap: 4px; color: #666;">
            <span>Host:</span> <span id="parsed-host" style="font-family: monospace;">-</span>
            <span>Kullanici:</span> <span id="parsed-username" style="font-family: monospace;">-</span>
            <span>Sifre:</span> <span id="parsed-password" style="font-family: monospace;">***</span>
          </div>
        </div>

        <div>
          <label style="display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500; color: #555;">ONVIF Port <span style="color: red;">*</span></label>
          <input type="number" id="onvif-cam-port" required value="2020" placeholder="2020" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
          <div style="font-size: 11px; color: #999; margin-top: 4px;">Tapo kameralar: 2020 | Diger: 80 veya 8080</div>
        </div>

        <div>
          <label style="display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500; color: #555;">Kamera Adi <span style="color: red;">*</span></label>
          <input type="text" id="onvif-cam-name" required placeholder="orn: Salon Kamerasi" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
        </div>

        <div style="display: flex; gap: 12px; margin-top: 8px;">
          <button type="submit" style="flex: 1; padding: 12px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500;">
            Kamera Ekle
          </button>
          <button type="button" data-action="cancel-add-onvif" style="flex: 1; padding: 12px; background: #9E9E9E; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500;">
            Iptal
          </button>
        </div>
      </form>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Cancel button
    backdrop.querySelector('[data-action="cancel-add-onvif"]').addEventListener('click', () => {
      document.getElementById('add-onvif-camera-modal').remove();
    });

    // Add RTSP URL parser on input
    document.getElementById('onvif-cam-rtsp').addEventListener('input', (e) => {
      this.parseRtspUrl(e.target.value);
    });

    // Add form submit handler
    document.getElementById('add-onvif-camera-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitAddOnvifCamera();
    });

    // Close on backdrop click
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        backdrop.remove();
      }
    });
  },

  /**
   * Parse RTSP URL - only validate and extract host for display
   * [SECURITY] Credentials are NOT stored, only parsed at submit time
   */
  parseRtspUrl(url) {
    const infoDiv = document.getElementById('onvif-parsed-info');
    const hostSpan = document.getElementById('parsed-host');
    const usernameSpan = document.getElementById('parsed-username');
    const passwordSpan = document.getElementById('parsed-password');

    // Store only validity flag, not credentials
    this._rtspUrlValid = false;

    if (!url || !url.startsWith('rtsp://')) {
      infoDiv.style.display = 'none';
      return;
    }

    try {
      const withoutProtocol = url.replace('rtsp://', '');
      const atIndex = withoutProtocol.indexOf('@');

      if (atIndex === -1) {
        infoDiv.style.display = 'none';
        return;
      }

      // [SECURITY] Only extract host for display, never store credentials
      const hostPart = withoutProtocol.substring(atIndex + 1).split('/')[0];
      const host = hostPart.split(':')[0];

      // Check if credentials exist without extracting them
      const credentialPart = withoutProtocol.substring(0, atIndex);
      const hasPassword = credentialPart.includes(':');

      if (!hasPassword) {
        infoDiv.style.display = 'none';
        return;
      }

      // Mark as valid - credentials will be parsed fresh at submit time
      this._rtspUrlValid = true;

      // Display masked info - never expose actual credentials
      hostSpan.textContent = host;
      usernameSpan.textContent = '(embedded)';
      passwordSpan.textContent = '********';
      infoDiv.style.display = 'block';

    } catch (e) {
      infoDiv.style.display = 'none';
    }
  },

  /**
   * Submit add ONVIF camera form
   * [SECURITY] Credentials parsed fresh from input, never stored in memory
   */
  async submitAddOnvifCamera() {
    const name = document.getElementById('onvif-cam-name').value.trim();
    const port = document.getElementById('onvif-cam-port').value.trim();
    const rtspUrl = document.getElementById('onvif-rtsp-url').value.trim();

    if (!this._rtspUrlValid) {
      alert('Lutfen gecerli bir RTSP URL girin');
      return;
    }

    if (!name || !port) {
      alert('Lutfen tum alanlari doldurun');
      return;
    }

    // [SECURITY] Parse credentials fresh from input at submit time only
    let host, username, password;
    try {
      const withoutProtocol = rtspUrl.replace('rtsp://', '');
      const atIndex = withoutProtocol.indexOf('@');
      const credPart = withoutProtocol.substring(0, atIndex);
      const hostPart = withoutProtocol.substring(atIndex + 1).split('/')[0];
      const colonIndex = credPart.indexOf(':');

      username = credPart.substring(0, colonIndex);
      password = credPart.substring(colonIndex + 1);
      host = hostPart.split(':')[0];
    } catch (e) {
      alert('RTSP URL ayrıştırılamadı');
      return;
    }

    const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    try {
      const submitBtn = document.querySelector('#add-onvif-camera-form button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Ekleniyor...';

      const response = await fetch(`${QBitmapConfig.api.onvif}/cameras`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, host, port: parseInt(port), username, password })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Kamera eklenemedi');
      }

      alert('ONVIF kamerasi basariyla eklendi!');

      // Close modal
      document.getElementById('add-onvif-camera-modal').remove();

      // Reload ONVIF profile UI to show the new camera
      this.loadOnvifProfile();

    } catch (error) {
      Logger.error('[ONVIF] Add camera error:', error);
      alert('Hata: ' + error.message);

      const submitBtn = document.querySelector('#add-onvif-camera-form button[type="submit"]');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Kamera Ekle';
    }
  },

  // ==================== Consolidated Settings Functions ====================

  /**
   * Load ONVIF profile for connection settings section
   */
  async loadOnvifProfile() {
    const container = document.querySelector('.onvif-profile-container');
    if (!container) return;

    const cameraId = container.dataset.cameraId;
    if (!cameraId) {
      container.innerHTML = '<div style="padding: 12px; color: #999;">Kamera ID bulunamadi</div>';
      return;
    }

    try {
      // Load templates and existing link in parallel
      const [templatesResp, linkResp] = await Promise.all([
        fetch(`${QBitmapConfig.api.onvif}/templates`, { credentials: 'include' }),
        fetch(`${QBitmapConfig.api.onvif}/link/${cameraId}`, { credentials: 'include' })
      ]);

      const templatesData = await templatesResp.json();
      const templates = templatesData.templates || [];

      let existingLink = null;
      if (linkResp.ok) {
        const linkData = await linkResp.json();
        if (linkData?.qbitmapCameraId) {
          existingLink = linkData;
        } else if (linkData?.link?.qbitmapCameraId) {
          existingLink = linkData.link;
        }
      }

      // Render profile UI
      this.renderOnvifProfileUI(container, templates, existingLink, cameraId);

    } catch (error) {
      Logger.error('[ONVIF] Load profile error:', error);
      container.innerHTML = '<div style="padding: 12px; color: #f44336;">Profil bilgisi yuklenemedi</div>';
    }
  },

  /**
   * Render ONVIF profile UI in connection settings
   */
  renderOnvifProfileUI(container, templates, existingLink, cameraId) {
    if (existingLink) {
      const supportedEvents = existingLink.supportedEvents || [];
      const currentTemplateId = existingLink.templateId;

      const profileOptions = templates.map(t =>
        `<option value="${t.id}" ${t.id === currentTemplateId ? 'selected' : ''}>${escapeHtml(t.manufacturer)} - ${escapeHtml(t.modelName)}</option>`
      ).join('');

      container.innerHTML = `
        <div style="margin-top: 12px;">
          <label style="display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500;">ONVIF Profili</label>
          <select id="onvif-profile-select" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px;">
            ${profileOptions}
          </select>
          <div style="font-size: 11px; color: #999; margin-top: 4px;">
            Desteklenen olaylar: ${supportedEvents.map(e => escapeHtml(e)).join(', ') || 'Yok'}
          </div>
          <button type="button" id="change-profile-btn" data-action="change-profile" style="margin-top: 8px; padding: 6px 12px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
            Profili Degistir
          </button>
        </div>
      `;
      container.querySelector('[data-action="change-profile"]').addEventListener('click', () => this.changeOnvifProfile(cameraId));
    } else {
      container.innerHTML = `
        <div style="margin-top: 12px; padding: 12px; background: #fff3cd; border-radius: 6px;">
          <div style="font-size: 13px; color: #856404; margin-bottom: 8px;">
            <strong>ONVIF Bagli Degil</strong>
          </div>
          <div style="font-size: 12px; color: #666;">
            Bu kamera henuz ONVIF servisine baglanmamis. Hareket ve insan algilama olaylarini almak icin ONVIF bagla.
          </div>
        </div>
      `;
    }
  },
};

export { OnvifMixin };
