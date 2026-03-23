import { QBitmapConfig } from "../config.js";
import { Logger, escapeHtml, showNotification } from "../utils.js";
import { AuthSystem } from "../auth.js";

const ClaimMixin = {
  showClaimModal() {
    const modal = document.createElement('div');
    modal.id = 'claim-modal';
    modal.className = 'claim-modal active';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'claim-modal-title');
    modal.innerHTML = `
      <div class="modal-overlay" onclick="MyCamerasSystem.closeClaimModal()" aria-hidden="true"></div>
      <div class="modal-content" style="max-width: 500px;" role="document">
        <h3 id="claim-modal-title">Yeni Kamera Ekle</h3>

        <div class="form-group">
          <label for="claim-camera-type">Kamera Tipi</label>
          <select id="claim-camera-type" onchange="MyCamerasSystem.toggleCameraTypeInputs()" aria-describedby="camera-type-desc">
            <option value="rtsp">IP Kamera (RTSP)</option>
            <option value="rtmp">RTMP Kamera (GoPro, OBS)</option>
            <option value="device">ESP32-CAM (Device ID)</option>
            <option value="city" id="city-camera-option" style="display: none;">Şehir Kamerası (HLS)</option>
          </select>
          <span id="camera-type-desc" class="sr-only">Eklemek istediğiniz kamera tipini seçin</span>
        </div>

        <!-- RTSP/IP Camera Section -->
        <div id="rtsp-section" role="group" aria-labelledby="rtsp-section-label">
          <span id="rtsp-section-label" class="sr-only">RTSP Kamera Ayarları</span>
          <p class="modal-desc">IP kameranızın RTSP URL'sini girin. Sistem otomatik olarak WebRTC stream ve ONVIF bağlantısı oluşturacak.</p>

          <div class="form-group">
            <label for="rtsp-camera-name">Kamera Adı <span style="color: #999;">(opsiyonel)</span></label>
            <input type="text" id="rtsp-camera-name" placeholder="Örn: Salon Kamerası" autocomplete="off" maxlength="100" aria-describedby="camera-name-hint">
            <small id="camera-name-hint" style="color: #666;">Maksimum 100 karakter</small>
          </div>

          <div class="form-group">
            <label for="rtsp-url">RTSP URL <span style="color: #f44336;" aria-label="zorunlu alan">*</span></label>
            <input type="text" id="rtsp-url" placeholder="rtsp://kullanici:sifre@192.168.1.100:554/stream2" autocomplete="off" style="font-family: monospace; font-size: 12px;" required aria-required="true" aria-describedby="rtsp-url-hint rtsp-url-error" aria-invalid="false">
            <small id="rtsp-url-hint" style="color: #666;">Örn: rtsp://camera:12345678@92.44.163.139:554/stream2</small>
            <span id="rtsp-url-error" class="field-error" style="display: none; color: #f44336; font-size: 12px;" role="alert"></span>
          </div>

          <div id="rtsp-parsed-info" style="display: none; background: #f5f5f5; padding: 12px; border-radius: 6px; margin: 12px 0;">
            <div style="font-weight: 500; margin-bottom: 8px; color: #333; font-size: 13px;">Çıkarılan Bilgiler:</div>
            <div style="display: grid; grid-template-columns: 80px 1fr; gap: 4px; font-size: 12px; color: #666;">
              <span>Host:</span> <span id="parsed-host" style="font-family: monospace;">-</span>
              <span>Kullanıcı:</span> <span id="parsed-username" style="font-family: monospace;">-</span>
              <span>Şifre:</span> <span id="parsed-password" style="font-family: monospace;">***</span>
            </div>
          </div>

          <div class="form-group" style="margin-top: 12px;">
            <label style="display: flex; align-items: center; cursor: pointer;">
              <input type="checkbox" id="rtsp-enable-onvif" checked style="margin-right: 8px; width: 18px; height: 18px;" onchange="MyCamerasSystem.toggleOnvifOptions()">
              <span>ONVIF entegrasyonunu etkinleştir</span>
            </label>
            <small style="color: #666; margin-left: 26px;">Hareket ve insan algılama bildirimleri alın</small>
          </div>

          <div id="onvif-options" style="margin-top: 12px; padding: 12px; background: #f0f7ff; border-radius: 6px; border: 1px solid #cce5ff;" role="group" aria-labelledby="onvif-options-label">
            <span id="onvif-options-label" class="sr-only">ONVIF Seçenekleri</span>
            <div class="form-group" style="margin-bottom: 12px;">
              <label for="rtsp-onvif-profile">Kamera Profili</label>
              <select id="rtsp-onvif-profile" style="width: 100%;" onchange="MyCamerasSystem.onProfileChange()" aria-describedby="profile-hint">
                <option value="1">Generic ONVIF</option>
              </select>
              <small id="profile-hint" style="color: #666;">Kameranızın modeline göre profil seçin. Bu, hangi olayların algılanacağını belirler.</small>
            </div>

            <div class="form-group" style="margin-bottom: 0;">
              <label for="rtsp-onvif-port">ONVIF Port</label>
              <input type="number" id="rtsp-onvif-port" value="2020" min="1" max="65535" style="width: 100px;" aria-describedby="port-hint">
              <small id="port-hint" style="color: #666; margin-left: 8px;">Tapo: 2020 | Diğer: 80, 8080</small>
            </div>
          </div>
        </div>

        <!-- Device ID Section (ESP32-CAM) -->
        <div id="device-id-section" style="display: none;" role="group" aria-labelledby="device-section-label">
          <span id="device-section-label" class="sr-only">ESP32-CAM Cihaz Ayarları</span>
          <p class="modal-desc">ESP32-CAM cihazınızın Device ID'sini girin. Bu ID, kamera ilk bağlandığında serial monitörde görünür.</p>
          <label for="claim-device-id" class="sr-only">Device ID</label>
          <input type="text" id="claim-device-id" placeholder="Örn: 78EC2CEBD724" autocomplete="off" maxlength="20" pattern="[A-Za-z0-9]+" aria-describedby="device-id-hint device-id-error">
          <small id="device-id-hint" style="color: #666; display: block; margin-top: 4px;">12 haneli hexadecimal kod (örn: 78EC2CEBD724)</small>
          <span id="device-id-error" class="field-error" style="display: none; color: #f44336; font-size: 12px;" role="alert"></span>
        </div>

        <!-- RTMP Camera Section (GoPro, OBS, etc.) -->
        <div id="rtmp-section" style="display: none;" role="group" aria-labelledby="rtmp-section-label">
          <span id="rtmp-section-label" class="sr-only">RTMP Kamera Ayarları</span>
          <p class="modal-desc">GoPro, OBS veya RTMP destekli cihazlar için. Size verilen URL'yi cihazınızda kullanın.</p>

          <div class="form-group">
            <label for="rtmp-camera-name">Kamera Adı <span style="color: #999;">(opsiyonel)</span></label>
            <input type="text" id="rtmp-camera-name" placeholder="Örn: GoPro Hero 12" autocomplete="off" maxlength="100">
            <small style="color: #666;">Bu isim kamera listesinde görünecek</small>
          </div>

          <div style="background: #fff3e0; padding: 12px; border-radius: 6px; border: 1px solid #ffe0b2; margin-top: 12px;">
            <div style="display: flex; align-items: flex-start; gap: 8px;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f57c00" stroke-width="2" style="flex-shrink: 0; margin-top: 2px;">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <div style="font-size: 13px; color: #e65100;">
                <strong>Nasıl Çalışır?</strong><br>
                Kamerayı ekledikten sonra size bir RTMP URL'si verilecek. Bu URL'yi GoPro veya OBS ayarlarına girin.
              </div>
            </div>
          </div>
        </div>

        <!-- City Camera Section (HLS - Admin Only) -->
        <div id="city-section" style="display: none;" role="group" aria-labelledby="city-section-label">
          <span id="city-section-label" class="sr-only">Şehir Kamerası Ayarları</span>
          <p class="modal-desc">Belediye veya kamu kurumlarının HLS yayın URL'sini girin. Bu kameralar herkese açık olarak eklenir.</p>

          <div class="form-group">
            <label for="city-camera-name">Kamera Adı <span style="color: #999;">(opsiyonel)</span></label>
            <input type="text" id="city-camera-name" placeholder="Örn: Üsküdar Meydanı" autocomplete="off" maxlength="100">
            <small style="color: #666;">Bu isim haritada ve kamera listesinde görünecek</small>
          </div>

          <div class="form-group">
            <label for="city-hls-url">HLS URL <span style="color: #f44336;" aria-label="zorunlu alan">*</span></label>
            <input type="text" id="city-hls-url" placeholder="https://livestream.ibb.gov.tr/cam_turistik/b_uskudar.stream/chunklist.m3u8" autocomplete="off" style="font-family: monospace; font-size: 11px;" required aria-required="true" aria-describedby="hls-url-hint">
            <small id="hls-url-hint" style="color: #666;">URL .m3u8 dosyası içermelidir (query parametreleri olabilir)</small>
          </div>

          <div style="background: #e0f2fe; padding: 12px; border-radius: 6px; border: 1px solid #7dd3fc; margin-top: 12px;">
            <div style="display: flex; align-items: flex-start; gap: 8px;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0284c7" stroke-width="2" style="flex-shrink: 0; margin-top: 2px;">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
              <div style="font-size: 13px; color: #0369a1;">
                <strong>Şehir Kamerası</strong><br>
                Bu kamera herkese açık olarak eklenir ve haritada mavi ikon ile gösterilir.
              </div>
            </div>
          </div>
        </div>

        <div class="modal-actions">
          <button type="button" class="btn-secondary" onclick="MyCamerasSystem.closeClaimModal()" aria-label="İptal et ve kapat">İptal</button>
          <button type="submit" class="btn-primary" id="claim-submit-btn" onclick="MyCamerasSystem.claimCamera()" aria-describedby="claim-error">
            <span class="btn-text">Ekle</span>
            <span class="btn-loading" style="display: none;" aria-hidden="true">
              <svg class="spinner-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
                <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path>
              </svg>
              Ekleniyor...
            </span>
          </button>
        </div>
        <div id="claim-error" class="claim-error" role="alert" aria-live="polite"></div>
        <div id="claim-progress" style="display: none; margin-top: 12px; padding: 12px; background: #e3f2fd; border-radius: 6px; font-size: 13px;" role="status" aria-live="polite">
          <div style="display: flex; align-items: center;">
            <div class="spinner" style="width: 16px; height: 16px; border: 2px solid #2196F3; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; margin-right: 8px;" aria-hidden="true"></div>
            <span id="claim-progress-text">Kamera ekleniyor...</span>
          </div>
        </div>
      </div>
      <style>
        @keyframes spin { to { transform: rotate(360deg); } }
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
        .btn-loading .spinner-icon { animation: spin 1s linear infinite; }
        .field-error { margin-top: 4px; display: block; }
        input:invalid:not(:placeholder-shown) { border-color: #f44336; }
        input:valid:not(:placeholder-shown) { border-color: #4caf50; }
      </style>
    `;
    document.body.appendChild(modal);

    // Add RTSP URL parser listener
    document.getElementById('rtsp-url').addEventListener('input', (e) => {
      this.parseRtspUrlForModal(e.target.value);
    });

    // Load ONVIF profiles
    this.loadOnvifProfiles();

    // Check admin status to show city camera option
    this.checkAdminForCityCamera();

    document.getElementById('rtsp-camera-name').focus();
  },

  /**
   * Check if current user is admin and show city camera option
   */
  async checkAdminForCityCamera() {
    try {
      const response = await fetch(`${this.apiBase}/me`, { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        if (data.role === 'admin') {
          const cityOption = document.getElementById('city-camera-option');
          if (cityOption) {
            cityOption.style.display = '';
          }
        }
      }
    } catch (e) {
      Logger.error('[MyCameras] Failed to check admin status:', e);
    }
  },

  /**
   * Load ONVIF profiles from API
   */
  async loadOnvifProfiles() {
    try {
      const response = await fetch(`${QBitmapConfig.api.onvif}/templates`, {
        credentials: 'include'
      });

      if (!response.ok) return;

      const data = await response.json();
      const profiles = data.templates || [];

      const select = document.getElementById('rtsp-onvif-profile');
      if (!select) return;

      select.innerHTML = profiles.map(p =>
        `<option value="${p.id}" data-port="${p.onvifPort}">${p.manufacturer} - ${p.modelName}</option>`
      ).join('');

      // Store profiles for later use
      this._onvifProfiles = profiles;

    } catch (error) {
      Logger.error('[MyCameras] Failed to load ONVIF profiles:', error);
    }
  },

  /**
   * Toggle ONVIF options visibility
   */
  toggleOnvifOptions() {
    const enabled = document.getElementById('rtsp-enable-onvif').checked;
    const optionsDiv = document.getElementById('onvif-options');
    if (optionsDiv) {
      optionsDiv.style.display = enabled ? 'block' : 'none';
    }
  },

  /**
   * Handle profile change - auto-fill ONVIF port
   */
  onProfileChange() {
    const select = document.getElementById('rtsp-onvif-profile');
    const portInput = document.getElementById('rtsp-onvif-port');

    if (!select || !portInput) return;

    const selectedOption = select.options[select.selectedIndex];
    const defaultPort = selectedOption?.dataset?.port;

    if (defaultPort) {
      portInput.value = defaultPort;
    }
  },

  /**
   * Parse RTSP URL and show extracted info in modal
   */
  parseRtspUrlForModal(url) {
    const infoDiv = document.getElementById('rtsp-parsed-info');
    const hostSpan = document.getElementById('parsed-host');
    const usernameSpan = document.getElementById('parsed-username');
    const passwordSpan = document.getElementById('parsed-password');

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

      // [SECURITY] Only extract host for display, never credentials
      const hostPart = withoutProtocol.substring(atIndex + 1).split('/')[0];
      const host = hostPart.split(':')[0];

      // Check if credentials exist without extracting them
      const credentialPart = withoutProtocol.substring(0, atIndex);
      const hasPassword = credentialPart.includes(':');

      if (!hasPassword) {
        infoDiv.style.display = 'none';
        return;
      }

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
   * Toggle camera type inputs visibility
   */
  toggleCameraTypeInputs() {
    const cameraType = document.getElementById('claim-camera-type').value;
    const deviceSection = document.getElementById('device-id-section');
    const rtspSection = document.getElementById('rtsp-section');
    const rtmpSection = document.getElementById('rtmp-section');
    const citySection = document.getElementById('city-section');

    // Hide all sections first
    deviceSection.style.display = 'none';
    rtspSection.style.display = 'none';
    rtmpSection.style.display = 'none';
    citySection.style.display = 'none';

    if (cameraType === 'rtsp') {
      rtspSection.style.display = 'block';
      document.getElementById('rtsp-camera-name').focus();
    } else if (cameraType === 'rtmp') {
      rtmpSection.style.display = 'block';
      document.getElementById('rtmp-camera-name').focus();
    } else if (cameraType === 'city') {
      citySection.style.display = 'block';
      document.getElementById('city-camera-name').focus();
    } else {
      deviceSection.style.display = 'block';
      document.getElementById('claim-device-id').focus();
    }
  },

  /**
   * Close claim modal
   */
  closeClaimModal() {
    // Prevent closing during async submission
    if (this._isSubmitting) {
      return;
    }
    const modal = document.getElementById('claim-modal');
    if (modal) modal.remove();
  },

  /**
   * Show RTMP URL modal after camera creation
   * @param {string} rtmpUrl - The RTMP URL for publishing
   * @param {string} cameraName - Camera name for display
   */
  showRtmpUrlModal(rtmpUrl, cameraName) {
    this._rtmpUrl = rtmpUrl;
    const modal = document.createElement('div');
    modal.id = 'rtmp-url-modal';
    modal.className = 'claim-modal active';
    modal.innerHTML = `
      <div class="modal-overlay" onclick="MyCamerasSystem.closeRtmpUrlModal()"></div>
      <div class="modal-content" style="max-width: 550px;">
        <h3>RTMP Kamera Oluşturuldu</h3>
        <p class="modal-desc"><strong>${escapeHtml(cameraName)}</strong> için RTMP URL'si:</p>

        <div style="background: #1a1a2e; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <code id="rtmp-url-display" style="color: #4fc3f7; font-size: 13px; word-break: break-all; display: block; user-select: all;">${escapeHtml(rtmpUrl)}</code>
        </div>

        <button class="btn-primary" onclick="MyCamerasSystem.copyRtmpUrl()" style="width: 100%;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px;">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          URL'yi Kopyala
        </button>

        <div style="margin-top: 16px; padding: 12px; background: #f5f5f5; border-radius: 6px; font-size: 13px;">
          <strong>GoPro Hero 12 için:</strong>
          <ol style="margin: 8px 0 0 0; padding-left: 20px; color: #555;">
            <li>GoPro uygulamasını açın</li>
            <li>Preferences > Connections > Live Stream</li>
            <li>"RTMP" seçin ve bu URL'yi yapıştırın</li>
            <li>Yayını başlatın</li>
          </ol>
        </div>

        <div style="margin-top: 12px; padding: 12px; background: #e3f2fd; border-radius: 6px; font-size: 13px;">
          <strong>OBS Studio için:</strong>
          <ol style="margin: 8px 0 0 0; padding-left: 20px; color: #555;">
            <li>Settings > Stream</li>
            <li>Service: Custom</li>
            <li>Server: Bu URL'yi yapıştırın</li>
            <li>Stream Key: Boş bırakın</li>
          </ol>
        </div>

        <div class="modal-actions" style="margin-top: 16px;">
          <button class="btn-secondary" onclick="MyCamerasSystem.closeRtmpUrlModal()">Kapat</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  },

  /**
   * Copy RTMP URL to clipboard
   */
  copyRtmpUrl() {
    if (this._rtmpUrl) {
      navigator.clipboard.writeText(this._rtmpUrl).then(() => {
        AuthSystem.showNotification('RTMP URL kopyalandı', 'success');
      }).catch(() => {
        AuthSystem.showNotification('Kopyalama başarısız', 'error');
      });
    }
  },

  /**
   * Close RTMP URL modal
   */
  closeRtmpUrlModal() {
    const modal = document.getElementById('rtmp-url-modal');
    if (modal) modal.remove();
    this._rtmpUrl = null;
  },

  /**
   * Claim a camera (RTSP or Device)
   */
  async claimCamera() {
    // Double-submit protection
    if (this._isSubmitting) {
      return;
    }

    const cameraType = document.getElementById('claim-camera-type').value;
    const errorDiv = document.getElementById('claim-error');
    const progressDiv = document.getElementById('claim-progress');
    const progressText = document.getElementById('claim-progress-text');
    const submitBtn = document.getElementById('claim-submit-btn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoading = submitBtn.querySelector('.btn-loading');

    // Helper: Show field error with ARIA
    const showFieldError = (fieldId, errorId, message) => {
      const field = document.getElementById(fieldId);
      const errorSpan = document.getElementById(errorId);
      if (field) {
        field.setAttribute('aria-invalid', 'true');
        field.focus();
      }
      if (errorSpan) {
        errorSpan.textContent = message;
        errorSpan.style.display = 'block';
      }
      errorDiv.textContent = message;
    };

    // Helper: Clear field error
    const clearFieldError = (fieldId, errorId) => {
      const field = document.getElementById(fieldId);
      const errorSpan = document.getElementById(errorId);
      if (field) field.setAttribute('aria-invalid', 'false');
      if (errorSpan) {
        errorSpan.textContent = '';
        errorSpan.style.display = 'none';
      }
    };

    // Helper: Set loading state
    const setLoading = (loading) => {
      submitBtn.disabled = loading;
      submitBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
      if (btnText) btnText.style.display = loading ? 'none' : 'inline';
      if (btnLoading) btnLoading.style.display = loading ? 'inline-flex' : 'none';
      progressDiv.style.display = loading ? 'block' : 'none';
    };

    errorDiv.textContent = '';
    clearFieldError('rtsp-url', 'rtsp-url-error');
    clearFieldError('claim-device-id', 'device-id-error');

    try {
      this._isSubmitting = true;
      let response;

      if (cameraType === 'rtsp') {
        // RTSP/IP Camera - Unified flow
        const name = document.getElementById('rtsp-camera-name').value.trim();
        const rtspUrl = document.getElementById('rtsp-url').value.trim();
        const onvifPort = parseInt(document.getElementById('rtsp-onvif-port').value) || 2020;
        const enableOnvif = document.getElementById('rtsp-enable-onvif').checked;
        const profileSelect = document.getElementById('rtsp-onvif-profile');
        const onvifTemplateId = profileSelect ? parseInt(profileSelect.value) : 1;

        if (!rtspUrl) {
          showFieldError('rtsp-url', 'rtsp-url-error', 'RTSP URL gerekli');
          return;
        }

        if (!rtspUrl.startsWith('rtsp://')) {
          showFieldError('rtsp-url', 'rtsp-url-error', 'URL rtsp:// ile başlamalı');
          return;
        }

        // Validate that URL has credentials
        if (!rtspUrl.includes('@')) {
          showFieldError('rtsp-url', 'rtsp-url-error', 'RTSP URL kullanıcı adı ve şifre içermeli (rtsp://user:pass@host)');
          return;
        }

        // Show progress with loading state
        setLoading(true);
        progressText.textContent = 'Stream sunucusuna ekleniyor...';

        // Clear sensitive data from DOM immediately after capturing
        // This prevents credentials from being visible in DevTools
        const rtspInput = document.getElementById('rtsp-url');
        if (rtspInput) rtspInput.value = '';

        response = await fetch(`${this.apiBase}/me/cameras/rtsp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            name: name || 'IP Kamera',
            rtsp_url: rtspUrl,
            onvif_port: onvifPort,
            enable_onvif: enableOnvif,
            onvif_template_id: enableOnvif ? onvifTemplateId : undefined
          })
        });
      } else if (cameraType === 'rtmp') {
        // RTMP Camera (GoPro, OBS, etc.)
        const name = document.getElementById('rtmp-camera-name').value.trim();

        setLoading(true);
        progressText.textContent = 'RTMP path oluşturuluyor...';

        response = await fetch(`${this.apiBase}/me/cameras/rtmp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            name: name || 'RTMP Kamera'
          })
        });
      } else if (cameraType === 'city') {
        // City Camera (HLS - Admin Only)
        const name = document.getElementById('city-camera-name').value.trim();
        const hlsUrl = document.getElementById('city-hls-url').value.trim();

        if (!hlsUrl) {
          errorDiv.textContent = 'HLS URL gerekli';
          return;
        }

        try {
          const urlObj = new URL(hlsUrl);
          if (!urlObj.pathname.endsWith('.m3u8')) {
            errorDiv.textContent = 'URL .m3u8 dosyasına işaret etmelidir';
            return;
          }
          if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
            errorDiv.textContent = 'URL http:// veya https:// ile başlamalı';
            return;
          }
        } catch (e) {
          errorDiv.textContent = 'Geçersiz URL formatı';
          return;
        }

        setLoading(true);
        progressText.textContent = 'Şehir kamerası ekleniyor...';

        response = await fetch(`${QBitmapConfig.api.admin}/cameras/city`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            name: name || 'Şehir Kamerası',
            hls_url: hlsUrl
          })
        });
      } else {
        // Device camera (ESP32-CAM)
        const input = document.getElementById('claim-device-id');
        const deviceId = input.value.trim().toUpperCase();

        if (!deviceId) {
          showFieldError('claim-device-id', 'device-id-error', 'Device ID gerekli');
          return;
        }

        // Validate device ID format (12 hex characters)
        if (!/^[A-F0-9]{12}$/.test(deviceId)) {
          showFieldError('claim-device-id', 'device-id-error', 'Device ID 12 haneli hexadecimal olmalı (örn: 78EC2CEBD724)');
          return;
        }

        setLoading(true);
        progressText.textContent = 'Cihaz ekleniyor...';

        response = await fetch(`${this.apiBase}/me/cameras/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ device_id: deviceId })
        });
      }

      const data = await response.json();

      if (!response.ok) {
        setLoading(false);
        // Show field-specific error if applicable
        if (cameraType === 'rtsp' && (data.error?.includes('URL') || data.error?.includes('RTSP') || data.error?.includes('IP'))) {
          showFieldError('rtsp-url', 'rtsp-url-error', data.error || data.details || 'Kamera eklenemedi');
        } else if (cameraType === 'device' && data.error?.includes('Device')) {
          showFieldError('claim-device-id', 'device-id-error', data.error || data.details || 'Cihaz eklenemedi');
        } else {
          errorDiv.textContent = data.error || data.details || 'Kamera eklenemedi';
        }
        return;
      }

      // Success - reset loading and submission flag before closing modal
      setLoading(false);
      this._isSubmitting = false;
      this.closeClaimModal();

      Analytics.event('camera_add', { camera_type: cameraType });

      // Show appropriate success message
      if (cameraType === 'rtsp') {
        const onvifStatus = data.camera?.onvif_linked ? ' (ONVIF bağlandı)' : '';
        AuthSystem.showNotification(`Kamera başarıyla eklendi${onvifStatus}`, 'success');
      } else if (cameraType === 'rtmp') {
        // Show RTMP URL modal for user to copy
        if (data.camera?.rtmp_url) {
          this.showRtmpUrlModal(data.camera.rtmp_url, data.camera.name);
        } else {
          AuthSystem.showNotification('RTMP kamera eklendi', 'success');
        }
      } else if (cameraType === 'city') {
        AuthSystem.showNotification('Şehir kamerası başarıyla eklendi', 'success');
      } else {
        AuthSystem.showNotification('Cihaz başarıyla eklendi', 'success');
      }

      await this.loadCameras();

    } catch (error) {
      Logger.error('[MyCameras] Claim error:', error);
      errorDiv.textContent = 'Bir hata oluştu: ' + error.message;
      // Reset loading state on error
      const submitBtn = document.getElementById('claim-submit-btn');
      const btnText = submitBtn?.querySelector('.btn-text');
      const btnLoading = submitBtn?.querySelector('.btn-loading');
      const progressDiv = document.getElementById('claim-progress');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.setAttribute('aria-busy', 'false');
      }
      if (btnText) btnText.style.display = 'inline';
      if (btnLoading) btnLoading.style.display = 'none';
      if (progressDiv) progressDiv.style.display = 'none';
    } finally {
      this._isSubmitting = false;
    }
  },

  /**
   * Open camera popup on map and start recording
   */
};

export { ClaimMixin };
