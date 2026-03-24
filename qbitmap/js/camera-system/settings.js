import { QBitmapConfig } from '../config.js';
import { Logger, escapeHtml, sanitize, fetchWithTimeout, TimerManager, showNotification } from '../utils.js';
import { AuthSystem } from '../auth.js';

/**
 * QBitmap Camera System - Settings Module
 * Handles settings drawer, camera settings form, and ONVIF integration
 */

const SettingsMixin = {
  /**
   * Create settings drawer
   */
  createSettingsDrawer() {
    const drawer = document.createElement('div');
    drawer.id = 'settings-drawer';
    drawer.className = 'settings-drawer';
    drawer.innerHTML = `
      <div class="settings-overlay"></div>
      <div class="settings-panel">
        <div class="settings-header">
          <h2>Kamera Ayarlari</h2>
          <button class="close-btn">&times;</button>
        </div>
        <div class="settings-body"></div>
        <div class="settings-footer">
          <button class="btn-secondary cancel-btn">Iptal</button>
          <button class="btn-primary save-btn">Kaydet</button>
        </div>
      </div>
    `;
    document.body.appendChild(drawer);

    drawer.querySelector('.settings-overlay').onclick = () => this.closeSettings();
    drawer.querySelector('.settings-header .close-btn').onclick = () => this.closeSettings();
    drawer.querySelector('.cancel-btn').onclick = () => this.closeSettings();
    drawer.querySelector('.save-btn').onclick = () => this.saveSettings();
  },

  /**
   * Open settings
   */
  async openSettings(deviceId, cameraId = null) {
    Logger.log('[Settings] openSettings called with deviceId:', deviceId, 'cameraId:', cameraId);
    if (!deviceId) return;

    const drawer = document.getElementById('settings-drawer');
    const body = drawer.querySelector('.settings-body');

    drawer.classList.add('active');
    body.innerHTML = '<div class="settings-loading"><div class="spinner"></div><p>Yukleniyor...</p></div>';

    // Detect camera type from popup data, cameras array, or device ID prefix
    const popupData = this.popups.get(deviceId);
    const camera = this.cameras.find(c => c.device_id === deviceId);
    const isWhep = popupData?.isWhep || camera?.camera_type === 'whep' || deviceId.startsWith('WHEP_');
    const isCity = popupData?.isCity || camera?.camera_type === 'city' || deviceId.startsWith('CITY_');
    Logger.log('[Settings] isWhep:', isWhep, 'isCity:', isCity, 'camera_type:', camera?.camera_type);

    // Get camera ID if not provided
    if (!cameraId && camera) {
      cameraId = camera.id;
    }

    try {
      const response = await fetch(`${this.apiSettings}/${deviceId}`, { credentials: 'include' });
      Logger.log('[Settings] API response status:', response.status);
      if (!response.ok) throw new Error('Failed');

      const data = await response.json();
      const settings = data.settings || {};

      this.settingsCache = { deviceId, cameraId, settings, configVersion: data.config_version, isWhep, isCity, camera };
      body.innerHTML = this.renderSettingsForm(settings, isWhep, isCity, camera);
      Logger.log('[Settings] Form rendered, calling initSettingsForm');
      this.initSettingsForm();

    } catch (error) {
      Logger.error('[Settings] Error:', error);
      body.innerHTML = '<div class="settings-error">Ayarlar yuklenemedi</div>';
    }
  },

  /**
   * Close settings
   */
  closeSettings() {
    document.getElementById('settings-drawer').classList.remove('active');
  },

  /**
   * Render settings form - Full OV5640 settings from firmware
   * For WHEP cameras, show all settings consolidated
   * For City cameras, show admin settings
   */
  renderSettingsForm(s, isWhep = false, isCity = false, camera = null) {
    const deviceId = this.settingsCache?.deviceId || '[device_id]';
    const cameraId = this.settingsCache?.cameraId;
    // [CC-007] Escape URL for XSS protection
    const streamUrl = escapeHtml(`${QBitmapConfig.api.public}/stream/${deviceId}`);

    // City cameras - admin settings only
    if (isCity) {
      const cameraName = camera?.name || '';
      const lat = camera?.lat || '';
      const lng = camera?.lng || '';

      // Source URL from admin API (rtsp_source_url) or HLS URL
      const hlsUrl = camera?.rtsp_source_url || camera?.hls_url || '';

      return `
        <div class="settings-form">
          <!-- Temel Bilgiler -->
          <div class="settings-section">
            <h3>Şehir Kamerası Bilgileri</h3>
            <div class="form-group form-group-h">
              <label for="settings-name">Kamera Adı</label>
              <input type="text" id="settings-name" name="camera_name" value="${escapeHtml(cameraName)}" placeholder="Kamera adı" maxlength="100">
            </div>
          </div>

          <!-- Konum -->
          <div class="settings-section">
            <h3>Harita Konumu</h3>
            <div class="form-row">
              <div class="form-group half">
                <label for="settings-lat">Enlem (Lat)</label>
                <input type="number" id="settings-lat" name="lat" value="${lat}" step="0.000001" placeholder="40.9876">
              </div>
              <div class="form-group half">
                <label for="settings-lng">Boylam (Lng)</label>
                <input type="number" id="settings-lng" name="lng" value="${lng}" step="0.000001" placeholder="29.1234">
              </div>
            </div>
            <button type="button" id="pick-location-btn" class="btn-pick-location">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                <circle cx="12" cy="10" r="3"/>
              </svg>
              Haritadan Sec
            </button>
          </div>

          <!-- HLS URL (read-only) -->
          <div class="settings-section">
            <h3>Kaynak URL</h3>
            <div class="form-group form-group-h">
              <label>HLS URL</label>
              <input type="text" value="${escapeHtml(hlsUrl)}" readonly style="font-family: monospace; font-size: 11px; background: #f5f5f5; color: #333;">
            </div>
          </div>

          <!-- Kaydet -->
          <div class="settings-section">
            <button type="button" id="settings-save" class="btn btn-primary btn-block">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
                <polyline points="7 3 7 8 15 8"/>
              </svg>
              Kaydet
            </button>
          </div>

          <!-- Tehlikeli Bölge -->
          <div class="settings-section danger-zone">
            <h3>Tehlikeli Bölge</h3>
            <div class="form-group">
              <button type="button" id="delete-camera" class="btn btn-danger btn-block">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
                Kamerayı Sil
              </button>
              <p class="help-text" style="color: #f44336; margin-top: 8px;">Bu işlem geri alınamaz!</p>
            </div>
          </div>
        </div>
      `;
    }

    // WHEP cameras - consolidated settings
    if (isWhep) {
      const cameraName = camera?.name || '';
      const isPublic = camera?.is_public || false;
      const lat = camera?.lat || '';
      const lng = camera?.lng || '';
      const isRtmp = deviceId?.startsWith('RTMP_');
      const rtmpUrl = isRtmp && camera?.mediamtx_path ? `rtmp://rtmp.qbitmap.com:1935/${camera.mediamtx_path}` : null;

      return `
        <div class="settings-form">
          <!-- Temel Bilgiler -->
          <div class="settings-section">
            <h3>Temel Bilgiler</h3>
            <div class="form-group form-group-h">
              <label for="settings-name">Kamera Adi</label>
              <input type="text" id="settings-name" name="camera_name" value="${escapeHtml(cameraName)}" placeholder="Kamera adi" maxlength="100">
            </div>
            <div class="form-group form-group-h">
              <label for="settings-visibility">Gorunurluk</label>
              <select id="settings-visibility" name="camera_visibility">
                <option value="0" ${!isPublic ? 'selected' : ''}>Gizli (Sadece ben)</option>
                <option value="1" ${isPublic ? 'selected' : ''}>Herkese Acik</option>
              </select>
            </div>
            <div class="form-row" style="display: flex; gap: 12px;">
              <div class="form-group" style="flex: 1;">
                <label for="settings-lat">Enlem (Lat)</label>
                <input type="number" id="settings-lat" name="camera_lat" value="${lat}" step="0.0001" placeholder="40.9833">
              </div>
              <div class="form-group" style="flex: 1;">
                <label for="settings-lng">Boylam (Lng)</label>
                <input type="number" id="settings-lng" name="camera_lng" value="${lng}" step="0.0001" placeholder="29.1167">
              </div>
            </div>
            <button type="button" class="btn-pick-location" onclick="CameraSystem.pickLocationFromSettings();">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                <circle cx="12" cy="10" r="3"></circle>
              </svg>
              Haritadan Sec
            </button>
          </div>

          ${rtmpUrl ? `
          <!-- RTMP URL (GoPro, OBS) -->
          <div class="settings-section">
            <h3>RTMP Yayin URL</h3>
            <p style="font-size: 13px; color: #666; margin-bottom: 12px;">Bu URL'yi GoPro veya OBS ayarlarinda kullanin.</p>
            <div style="background: #1a1a2e; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
              <code id="rtmp-url-settings" style="color: #4fc3f7; font-size: 12px; word-break: break-all; display: block; user-select: all;">${escapeHtml(rtmpUrl)}</code>
            </div>
            <button type="button" class="btn-secondary" data-copy-url="${escapeHtml(rtmpUrl)}" onclick="navigator.clipboard.writeText(this.dataset.copyUrl).then(() => AuthSystem.showNotification('RTMP URL kopyalandi', 'success')).catch(() => AuthSystem.showNotification('Kopyalama basarisiz', 'error'))">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              URL'yi Kopyala
            </button>
          </div>
          ` : ''}

          <!-- Stream Cozunurlugu -->
          <div class="settings-section">
            <h3>Stream Ayarlari</h3>
            <div class="form-group form-group-h">
              <label for="settings-resolution">Cozunurluk</label>
              <select id="settings-resolution" name="stream_resolution">
                <option value="720" ${(s.stream_resolution ?? 720) == 720 ? 'selected' : ''}>HD 720p</option>
                <option value="1080" ${s.stream_resolution == 1080 ? 'selected' : ''}>FHD 1080p</option>
                <option value="1440" ${s.stream_resolution == 1440 ? 'selected' : ''}>2K 1440p</option>
                <option value="2160" ${s.stream_resolution == 2160 ? 'selected' : ''}>4K 2160p</option>
              </select>
            </div>
          </div>

          <!-- ONVIF Profili -->
          <div class="settings-section">
            <h3>ONVIF Profili</h3>
            <div class="onvif-profile-container" data-device-id="${escapeHtml(deviceId)}" data-camera-id="${escapeHtml(cameraId)}">
              <div class="onvif-loading" style="padding: 12px; text-align: center; color: #666;">
                <div class="spinner" style="width: 20px; height: 20px; margin: 0 auto 8px;"></div>
                <p style="margin: 0; font-size: 13px;">ONVIF profil bilgisi yukleniyor...</p>
              </div>
            </div>
          </div>

          <!-- AI Algilama -->
          <div class="settings-section ai-section">
            <h3>AI Algilama Ayarlari</h3>
            <div class="form-group">
              <label>Confidence Esigi: <span class="val">${s.ai_confidence_threshold ?? 70}</span>%</label>
              <input type="range" name="ai_confidence_threshold" min="0" max="100" value="${s.ai_confidence_threshold ?? 70}">
            </div>
            <div class="form-group">
              <label>Dogrulama Kare Sayisi: <span class="val">${s.ai_consecutive_frames ?? 3}</span></label>
              <input type="range" name="ai_consecutive_frames" min="1" max="10" value="${s.ai_consecutive_frames ?? 3}">
            </div>
            <div class="form-group">
              <label>Frame Yakalama Araligi: <span class="val">${Math.round((s.ai_capture_interval_ms ?? 3000) / 1000)}</span> sn</label>
              <input type="range" name="ai_capture_interval_ms" min="1000" max="10000" step="1000" value="${s.ai_capture_interval_ms ?? 3000}" data-display-divisor="1000">
            </div>
            <div class="ai-info" style="margin-top: 12px; padding: 10px; background: #f5f5f5; border-radius: 6px; font-size: 13px; color: #666;">
              <p style="margin: 0;">Son N karenin confidence <strong>ortalamasi</strong> esigi gecerse alarm verilir.</p>
            </div>
            ${this._renderDetectionRulesHTML(s.ai_detection_rules)}
          </div>

          <!-- Tehlikeli Islemler -->
          <div class="settings-section danger-zone">
            <h3 style="color: #c62828;">Tehlikeli Islemler</h3>
            <div style="padding: 12px; background: #ffebee; border-radius: 6px; margin-bottom: 12px;">
              <p style="margin: 0 0 12px 0; font-size: 13px; color: #666;">Bu islemler geri alinamaz. Dikkatli olun.</p>
              <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                <button type="button" class="btn-warning" onclick="CameraSystem.releaseCameraFromSettings()" style="background: #ff9800; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px;">
                  Kamerayi Birak
                </button>
                <button type="button" class="btn-danger" onclick="CameraSystem.deleteCameraFromSettings()" style="background: #f44336; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px;">
                  Kamerayi Sil
                </button>
              </div>
              <div style="font-size: 11px; color: #999; margin-top: 8px;">
                <strong>Birak:</strong> Kamera havuza geri doner, verileri korunur.<br>
                <strong>Sil:</strong> Kamera ve tum verileri kalici olarak silinir.
              </div>
            </div>
          </div>
        </div>
      `;
    }

    // Device cameras - full firmware settings
    const cameraName = camera?.name || '';
    const isPublic = camera?.is_public || false;
    const lat = camera?.lat || '';
    const lng = camera?.lng || '';

    return `
      <div class="settings-form">
        <!-- Temel Bilgiler -->
        <div class="settings-section">
          <h3>Temel Bilgiler</h3>
          <div class="form-group form-group-h">
            <label for="settings-name">Kamera Adi</label>
            <input type="text" id="settings-name" name="camera_name" value="${escapeHtml(cameraName)}" placeholder="Kamera adi" maxlength="100">
          </div>
          <div class="form-group form-group-h">
            <label for="settings-visibility">Gorunurluk</label>
            <select id="settings-visibility" name="camera_visibility">
              <option value="0" ${!isPublic ? 'selected' : ''}>Gizli (Sadece ben)</option>
              <option value="1" ${isPublic ? 'selected' : ''}>Herkese Acik</option>
            </select>
          </div>
          <div class="form-row" style="display: flex; gap: 12px;">
            <div class="form-group" style="flex: 1;">
              <label for="settings-lat">Enlem (Lat)</label>
              <input type="number" id="settings-lat" name="camera_lat" value="${lat}" step="0.0001" placeholder="40.9833">
            </div>
            <div class="form-group" style="flex: 1;">
              <label for="settings-lng">Boylam (Lng)</label>
              <input type="number" id="settings-lng" name="camera_lng" value="${lng}" step="0.0001" placeholder="29.1167">
            </div>
          </div>
          <button type="button" class="btn-pick-location" onclick="CameraSystem.pickLocationFromSettings();">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
              <circle cx="12" cy="10" r="3"></circle>
            </svg>
            Haritadan Sec
          </button>
        </div>

        <div class="settings-section collapsible">
          <h3>Goruntu Kalitesi</h3>
          <div class="section-content">
            <div class="form-group form-group-h">
              <label>Cozunurluk</label>
              <select name="frame_size">
                <option value="QQVGA" ${s.frame_size === 'QQVGA' ? 'selected' : ''}>QQVGA (160x120)</option>
                <option value="QVGA" ${s.frame_size === 'QVGA' ? 'selected' : ''}>QVGA (320x240)</option>
                <option value="VGA" ${s.frame_size === 'VGA' || !s.frame_size ? 'selected' : ''}>VGA (640x480)</option>
                <option value="SVGA" ${s.frame_size === 'SVGA' ? 'selected' : ''}>SVGA (800x600)</option>
                <option value="XGA" ${s.frame_size === 'XGA' ? 'selected' : ''}>XGA (1024x768)</option>
                <option value="HD" ${s.frame_size === 'HD' ? 'selected' : ''}>HD (1280x720)</option>
                <option value="SXGA" ${s.frame_size === 'SXGA' ? 'selected' : ''}>SXGA (1280x1024)</option>
                <option value="UXGA" ${s.frame_size === 'UXGA' ? 'selected' : ''}>UXGA (1600x1200)</option>
                <option value="FHD" ${s.frame_size === 'FHD' ? 'selected' : ''}>FHD (1920x1080)</option>
                <option value="QXGA" ${s.frame_size === 'QXGA' ? 'selected' : ''}>QXGA (2048x1536)</option>
                <option value="5MP" ${s.frame_size === '5MP' ? 'selected' : ''}>5MP (2592x1944)</option>
              </select>
            </div>
            <div class="form-group">
              <label>JPEG Kalitesi: <span class="val">${s.quality ?? 15}</span></label>
              <input type="range" name="quality" min="4" max="63" value="${s.quality ?? 15}">
            </div>
            <div class="form-group form-group-h">
              <label>Cekim Araligi</label>
              <input type="number" name="captureIntervalSec" value="${(s.capture_interval_ms || 5000) / 1000}" min="0.5" max="300" step="0.5" style="max-width: 80px;"> <span style="font-size: 12px; color: #999;">sn</span>
            </div>
          </div>
        </div>

        <div class="settings-section collapsible collapsed">
          <h3>Renk Ayarlari</h3>
          <div class="section-content">
            <div class="form-group">
              <label>Parlaklik: <span class="val">${s.brightness ?? 0}</span></label>
              <input type="range" name="brightness" min="-3" max="3" value="${s.brightness ?? 0}">
            </div>
            <div class="form-group">
              <label>Kontrast: <span class="val">${s.contrast ?? 0}</span></label>
              <input type="range" name="contrast" min="-3" max="3" value="${s.contrast ?? 0}">
            </div>
            <div class="form-group">
              <label>Doygunluk: <span class="val">${s.saturation ?? 0}</span></label>
              <input type="range" name="saturation" min="-4" max="4" value="${s.saturation ?? 0}">
            </div>
            <div class="form-group">
              <label>Keskinlik: <span class="val">${s.sharpness ?? 0}</span></label>
              <input type="range" name="sharpness" min="-3" max="3" value="${s.sharpness ?? 0}">
            </div>
            <div class="form-group">
              <label>Gurultu Azaltma: <span class="val">${s.denoise ?? 0}</span></label>
              <input type="range" name="denoise" min="0" max="8" value="${s.denoise ?? 0}">
            </div>
            <div class="form-group form-group-h">
              <label>Ozel Efekt</label>
              <select name="special_effect">
                <option value="0" ${(s.special_effect ?? 0) == 0 ? 'selected' : ''}>Normal</option>
                <option value="1" ${s.special_effect == 1 ? 'selected' : ''}>Negatif</option>
                <option value="2" ${s.special_effect == 2 ? 'selected' : ''}>Gri Tonlama</option>
                <option value="3" ${s.special_effect == 3 ? 'selected' : ''}>Kirmizi Ton</option>
                <option value="4" ${s.special_effect == 4 ? 'selected' : ''}>Yesil Ton</option>
                <option value="5" ${s.special_effect == 5 ? 'selected' : ''}>Mavi Ton</option>
                <option value="6" ${s.special_effect == 6 ? 'selected' : ''}>Sepya</option>
              </select>
            </div>
          </div>
        </div>

        <div class="settings-section collapsible collapsed">
          <h3>Beyaz Dengesi</h3>
          <div class="section-content">
            <div class="form-group checkbox">
              <label><input type="checkbox" name="awb" ${s.awb !== false ? 'checked' : ''}> Otomatik Beyaz Dengesi (AWB)</label>
            </div>
            <div class="form-group checkbox">
              <label><input type="checkbox" name="awb_gain" ${s.awb_gain !== false ? 'checked' : ''}> AWB Kazanci</label>
            </div>
            <div class="form-group form-group-h">
              <label>Mod</label>
              <select name="white_balance">
                <option value="0" ${(s.white_balance ?? 0) == 0 ? 'selected' : ''}>Otomatik</option>
                <option value="1" ${s.white_balance == 1 ? 'selected' : ''}>Gunesli</option>
                <option value="2" ${s.white_balance == 2 ? 'selected' : ''}>Bulutlu</option>
                <option value="3" ${s.white_balance == 3 ? 'selected' : ''}>Ofis</option>
                <option value="4" ${s.white_balance == 4 ? 'selected' : ''}>Ev</option>
              </select>
            </div>
          </div>
        </div>

        <div class="settings-section collapsible collapsed">
          <h3>Pozlama</h3>
          <div class="section-content">
            <div class="form-group checkbox">
              <label><input type="checkbox" name="aec" ${s.aec !== false ? 'checked' : ''}> Otomatik Pozlama (AEC)</label>
            </div>
            <div class="form-group checkbox">
              <label><input type="checkbox" name="night_mode" ${s.night_mode !== false ? 'checked' : ''}> Gece Modu</label>
            </div>
            <div class="form-group">
              <label>Pozlama Seviyesi: <span class="val">${s.ae_level ?? 0}</span></label>
              <input type="range" name="ae_level" min="-5" max="5" value="${s.ae_level ?? 0}">
            </div>
            <div class="form-group">
              <label>Manuel Pozlama: <span class="val">${s.aec_value ?? 0}</span></label>
              <input type="range" name="aec_value" min="0" max="1200" value="${s.aec_value ?? 0}">
            </div>
          </div>
        </div>

        <div class="settings-section collapsible collapsed">
          <h3>Kazanc (Gain)</h3>
          <div class="section-content">
            <div class="form-group checkbox">
              <label><input type="checkbox" name="agc" ${s.agc !== false ? 'checked' : ''}> Otomatik Kazanc (AGC)</label>
            </div>
            <div class="form-group">
              <label>Manuel Kazanc: <span class="val">${s.agc_gain ?? 0}</span></label>
              <input type="range" name="agc_gain" min="0" max="64" value="${s.agc_gain ?? 0}">
            </div>
            <div class="form-group">
              <label>Kazanc Tavani: <span class="val">${s.gain_ceiling ?? 128}</span></label>
              <input type="range" name="gain_ceiling" min="0" max="511" value="${s.gain_ceiling ?? 128}">
            </div>
          </div>
        </div>

        <div class="settings-section collapsible collapsed">
          <h3>Goruntu Duzeltme</h3>
          <div class="section-content">
            <div class="form-group checkbox">
              <label><input type="checkbox" name="bpc" ${s.bpc ? 'checked' : ''}> Siyah Piksel Duzeltme (BPC)</label>
            </div>
            <div class="form-group checkbox">
              <label><input type="checkbox" name="wpc" ${s.wpc !== false ? 'checked' : ''}> Beyaz Piksel Duzeltme (WPC)</label>
            </div>
            <div class="form-group checkbox">
              <label><input type="checkbox" name="raw_gma" ${s.raw_gma !== false ? 'checked' : ''}> Gamma Duzeltme</label>
            </div>
            <div class="form-group checkbox">
              <label><input type="checkbox" name="lenc" ${s.lenc !== false ? 'checked' : ''}> Lens Duzeltme</label>
            </div>
            <div class="form-group checkbox">
              <label><input type="checkbox" name="dcw" ${s.dcw !== false ? 'checked' : ''}> Downsize (DCW)</label>
            </div>
          </div>
        </div>

        <div class="settings-section collapsible collapsed">
          <h3>Yonlendirme</h3>
          <div class="section-content">
            <div class="form-group checkbox">
              <label><input type="checkbox" name="hmirror" ${s.hmirror ? 'checked' : ''}> Yatay Ayna</label>
            </div>
            <div class="form-group checkbox">
              <label><input type="checkbox" name="vflip" ${s.vflip ? 'checked' : ''}> Dikey Cevir</label>
            </div>
            <div class="form-group checkbox">
              <label><input type="checkbox" name="colorbar" ${s.colorbar ? 'checked' : ''}> Test Cubugu</label>
            </div>
          </div>
        </div>

        <div class="settings-section collapsible collapsed">
          <h3>Otomatik Odaklama (OV5640)</h3>
          <div class="section-content">
            <div class="form-group checkbox">
              <label><input type="checkbox" name="ov5640_af_enabled" ${s.ov5640_af_enabled !== false ? 'checked' : ''}> AF Etkin</label>
            </div>
            <div class="form-group checkbox">
              <label><input type="checkbox" name="ov5640_af_trigger" ${s.ov5640_af_trigger ? 'checked' : ''}> Odakla (Tek Seferlik)</label>
            </div>
            <div class="form-group">
              <label>AF Yenileme (frame): <span class="val">${s.ov5640_af_refresh_frames ?? 0}</span></label>
              <input type="range" name="ov5640_af_refresh_frames" min="0" max="500" value="${s.ov5640_af_refresh_frames ?? 0}">
            </div>
          </div>
        </div>

        <div class="settings-section collapsible collapsed">
          <h3>MJPEG Canli Yayin</h3>
          <div class="section-content">
            <div class="form-group checkbox">
              <label><input type="checkbox" name="mjpeg_enabled" ${s.mjpeg_enabled ? 'checked' : ''}> MJPEG Stream Etkin</label>
            </div>
            <div class="form-group">
              <label>FPS: <span class="val">${s.mjpeg_fps ?? 10}</span></label>
              <input type="range" name="mjpeg_fps" min="1" max="15" value="${s.mjpeg_fps ?? 10}">
            </div>
            <div class="form-group">
              <label>Kalite: <span class="val">${s.mjpeg_quality ?? 12}</span></label>
              <input type="range" name="mjpeg_quality" min="4" max="63" value="${s.mjpeg_quality ?? 12}">
            </div>
            <div class="form-group form-group-h">
              <label>Cozunurluk</label>
              <select name="mjpeg_width">
                <option value="320" ${(s.mjpeg_width ?? 640) == 320 ? 'selected' : ''}>QVGA (320x240)</option>
                <option value="640" ${(s.mjpeg_width ?? 640) == 640 ? 'selected' : ''}>VGA 16:9 (640x360)</option>
              </select>
            </div>
            <div class="mjpeg-info" style="margin-top: 8px; padding: 8px; background: #f5f5f5; border-radius: 4px; font-size: 12px; color: #666;">
              <p style="margin: 0 0 4px 0;"><strong>Not:</strong> MJPEG stream acikken normal kare yakalama durur.</p>
              <p style="margin: 0;">Stream URL: <code class="stream-url" style="background: #e0e0e0; padding: 2px 6px; border-radius: 3px; word-break: break-all; font-size: 11px;">${escapeHtml(streamUrl)}</code></p>
              <button type="button" class="copy-stream-url" style="margin-top: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer; border: 1px solid #ccc; border-radius: 3px; background: #fff;" data-copy-url="${escapeHtml(streamUrl)}" onclick="navigator.clipboard.writeText(this.dataset.copyUrl); this.textContent='Kopyalandi!'; setTimeout(() => this.textContent='URL Kopyala', 1500);">URL Kopyala</button>
            </div>
          </div>
        </div>

        <div class="settings-section ai-section collapsible">
          <h3>AI Algilama Ayarlari</h3>
          <div class="section-content">
            <div class="form-group">
              <label>Confidence Esigi: <span class="val">${s.ai_confidence_threshold ?? 70}</span>%</label>
              <input type="range" name="ai_confidence_threshold" min="0" max="100" value="${s.ai_confidence_threshold ?? 70}">
            </div>
            <div class="form-group">
              <label>Dogrulama Kare Sayisi: <span class="val">${s.ai_consecutive_frames ?? 3}</span></label>
              <input type="range" name="ai_consecutive_frames" min="1" max="10" value="${s.ai_consecutive_frames ?? 3}">
            </div>
            <div class="form-group">
              <label>Frame Yakalama Araligi: <span class="val">${Math.round((s.ai_capture_interval_ms ?? 3000) / 1000)}</span> sn</label>
              <input type="range" name="ai_capture_interval_ms" min="1000" max="10000" step="1000" value="${s.ai_capture_interval_ms ?? 3000}" data-display-divisor="1000">
            </div>
            <div class="ai-info" style="margin-top: 8px; padding: 8px; background: #f5f5f5; border-radius: 4px; font-size: 12px; color: #666;">
              <p style="margin: 0;">Son N karenin confidence <strong>ortalamasi</strong> esigi gecerse alarm verilir.</p>
            </div>
            ${this._renderDetectionRulesHTML(s.ai_detection_rules)}
          </div>
        </div>

      </div>
    `;
  },

  // Generate detection rules editor HTML from settings
  _renderDetectionRulesHTML(rules) {
    const items = rules || [];
    let rowsHtml = items.map((r, i) => `
      <div class="detection-rule-row" data-index="${i}">
        <input type="text" class="detection-rule-text" value="${escapeHtml(r.text || '')}" placeholder="Tespit edilecek durum...">
        <label class="detection-rule-alarm" title="Isaretliyse alarm verilir, degilse sadece raporlanir">
          <input type="checkbox" class="detection-rule-alarm-cb" ${r.alarm ? 'checked' : ''}> Alarm
        </label>
        <button type="button" class="detection-rule-delete" title="Sil">&times;</button>
      </div>`).join('');

    return `
      <div class="detection-rules-container">
        <label style="font-weight:600;margin-bottom:8px;display:block;">Algilama Kurallari</label>
        <div style="font-size:11px;color:#999;margin-bottom:8px;">Her satira tespit edilecek bir durum yazin. Alarm kutusu isaretliyse alarm verilir, degilse sadece terminal'de raporlanir.</div>
        <div class="detection-rules-list">${rowsHtml}</div>
        <button type="button" class="detection-rule-add" style="margin-top:6px;padding:4px 12px;font-size:12px;border:1px dashed #ccc;background:none;border-radius:4px;cursor:pointer;color:#666;">+ Kural Ekle</button>
        <details style="margin-top:10px;">
          <summary style="font-size:11px;color:#999;cursor:pointer;">Olusturulan Prompt (onizleme)</summary>
          <textarea class="detection-rules-preview" rows="8" readonly style="width:100%;font-size:11px;font-family:monospace;padding:8px;border:1px solid #eee;border-radius:4px;background:#f9f9f9;color:#666;margin-top:6px;resize:vertical;"></textarea>
        </details>
      </div>`;
  },

  // Initialize detection rules editor event handlers
  _initDetectionRules() {
    const container = document.querySelector('.detection-rules-container');
    if (!container) return;

    const list = container.querySelector('.detection-rules-list');
    const addBtn = container.querySelector('.detection-rule-add');
    const preview = container.querySelector('.detection-rules-preview');

    const updatePreview = () => {
      const rules = this._collectDetectionRules();
      if (typeof buildPromptFromRules === 'function') {
        preview.value = buildPromptFromRules(rules);
      }
    };

    const addRow = (text = '', alarm = true) => {
      const idx = list.children.length;
      const row = document.createElement('div');
      row.className = 'detection-rule-row';
      row.dataset.index = idx;
      row.innerHTML = `
        <input type="text" class="detection-rule-text" value="${escapeHtml(text)}" placeholder="Tespit edilecek durum...">
        <label class="detection-rule-alarm" title="Isaretliyse alarm verilir, degilse sadece raporlanir">
          <input type="checkbox" class="detection-rule-alarm-cb" ${alarm ? 'checked' : ''}> Alarm
        </label>
        <button type="button" class="detection-rule-delete" title="Sil">&times;</button>`;
      list.appendChild(row);
      row.querySelector('.detection-rule-text').focus();
      updatePreview();
    };

    addBtn.onclick = () => addRow();

    list.addEventListener('click', (e) => {
      if (e.target.classList.contains('detection-rule-delete')) {
        e.target.closest('.detection-rule-row').remove();
        updatePreview();
      }
    });

    list.addEventListener('input', updatePreview);
    list.addEventListener('change', updatePreview);

    updatePreview();
  },

  // Collect detection rules from DOM
  _collectDetectionRules() {
    const rows = document.querySelectorAll('.detection-rule-row');
    const rules = [];
    rows.forEach(row => {
      const text = row.querySelector('.detection-rule-text')?.value?.trim();
      if (text) {
        rules.push({
          text,
          alarm: row.querySelector('.detection-rule-alarm-cb')?.checked ?? true
        });
      }
    });
    return rules;
  },

  /**
   * Initialize settings form listeners
   */
  initSettingsForm() {
    document.querySelectorAll('.settings-form input[type="range"]').forEach(input => {
      input.oninput = () => {
        const divisor = parseFloat(input.dataset.displayDivisor) || 1;
        input.previousElementSibling.querySelector('.val').textContent = Math.round(input.value / divisor);
      };
    });

    // Collapsible section toggles
    document.querySelectorAll('.settings-section.collapsible h3').forEach(h3 => {
      h3.onclick = () => h3.parentElement.classList.toggle('collapsed');
    });

    // Initialize detection rules editor
    this._initDetectionRules();

    // Load ONVIF profile (new consolidated view)
    if (document.querySelector('.onvif-profile-container')) {
      this.loadOnvifProfile();
    }

    // City camera specific handlers
    if (this.settingsCache?.isCity) {
      // Save button for city cameras
      const saveBtn = document.getElementById('settings-save');
      if (saveBtn) {
        saveBtn.onclick = () => this.saveCityCameraSettings();
      }

      // Delete button for city cameras
      const deleteBtn = document.getElementById('delete-camera');
      if (deleteBtn) {
        deleteBtn.onclick = () => this.deleteCityCamera();
      }

      // Pick location button for city cameras
      const pickLocationBtn = document.getElementById('pick-location-btn');
      if (pickLocationBtn) {
        pickLocationBtn.onclick = () => this.pickLocationFromSettings();
      }
    }
  },

  /**
   * Save settings
   */
  async saveSettings() {
    if (!this.settingsCache.deviceId) return;

    // City cameras use different save function
    if (this.settingsCache.isCity) {
      return this.saveCityCameraSettings();
    }

    const form = document.querySelector('.settings-form');
    const settings = {};

    form.querySelectorAll('input[type="range"], input[type="number"]:not([name^="camera_"]), select:not([name^="camera_"])').forEach(el => {
      // Skip ONVIF select and camera fields - they're handled separately
      if (el.id === 'onvif-camera-id-select' || el.id === 'onvif-profile-select') return;
      if (el.name === 'captureIntervalSec') {
        settings.capture_interval_ms = Math.round(parseFloat(el.value) * 1000);
      } else if (el.name && !el.name.startsWith('camera_')) {
        settings[el.name] = el.type === 'number' || el.type === 'range' ? parseInt(el.value) : el.value;
      }
    });

    form.querySelectorAll('input[type="checkbox"]').forEach(el => {
      settings[el.name] = el.checked;
    });

    // Collect textarea fields (ai_search_prompt - monitoring prompt is now rules-based)
    form.querySelectorAll('textarea').forEach(el => {
      if (el.name && el.value.trim() && !el.classList.contains('detection-rules-preview')) {
        settings[el.name] = el.value.trim();
      }
    });

    // Collect detection rules
    const detectionRules = this._collectDetectionRules();
    if (detectionRules.length > 0) {
      settings.ai_detection_rules = detectionRules;
    }

    const saveBtn = document.querySelector('.settings-footer .save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Kaydediliyor...';

    try {
      // Save camera info (name, visibility, location) for both WHEP and ID-based cameras
      if (this.settingsCache.cameraId) {
        const cameraId = this.settingsCache.cameraId;

        // Get camera field values
        const nameInput = document.getElementById('settings-name');
        const visibilitySelect = document.getElementById('settings-visibility');
        const latInput = document.getElementById('settings-lat');
        const lngInput = document.getElementById('settings-lng');

        const cameraData = {};
        if (nameInput) cameraData.name = nameInput.value.trim();
        if (visibilitySelect) cameraData.is_public = visibilitySelect.value === '1';
        if (latInput && latInput.value) cameraData.lat = parseFloat(latInput.value);
        if (lngInput && lngInput.value) cameraData.lng = parseFloat(lngInput.value);

        // Save camera info
        const cameraResponse = await fetch(`${QBitmapConfig.api.users}/me/cameras/${cameraId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(cameraData)
        });

        if (!cameraResponse.ok) {
          const error = await cameraResponse.json();
          throw new Error(error.error || 'Kamera bilgileri kaydedilemedi');
        }
        Logger.log('[Settings] Camera info saved');
      }

      // Save device settings (AI settings etc)
      const response = await fetch(`${this.apiSettings}/${this.settingsCache.deviceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(settings)
      });

      if (!response.ok) throw new Error('Failed');

      saveBtn.textContent = 'Kaydedildi!';
      setTimeout(() => {
        this.closeSettings();
        saveBtn.textContent = 'Kaydet';
        saveBtn.disabled = false;

        // Refresh camera list if on my-cameras page
        if (typeof MyCamerasSystem !== 'undefined') {
          MyCamerasSystem.loadCameras();
        }
        // Refresh map cameras
        this.loadCameras();
      }, 1000);

    } catch (error) {
      alert('Kaydetme basarisiz: ' + error.message);
      saveBtn.textContent = 'Kaydet';
      saveBtn.disabled = false;
    }
  },

  /**
   * Toggle MJPEG stream on/off
   */
  async toggleMjpeg(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const mjpegBtn = popupEl?.querySelector('.mjpeg-btn');
    if (!mjpegBtn) return;

    // Disable button during operation
    mjpegBtn.disabled = true;
    mjpegBtn.style.opacity = '0.5';

    try {
      // Get current settings
      const response = await fetch(`${this.apiSettings}/${deviceId}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to get settings');

      const data = await response.json();
      const settings = data.settings || {};
      const currentlyEnabled = settings.mjpeg_enabled || false;

      // Toggle MJPEG
      settings.mjpeg_enabled = !currentlyEnabled;

      // Save settings
      const saveResponse = await fetch(`${this.apiSettings}/${deviceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(settings)
      });

      if (!saveResponse.ok) throw new Error('Failed to save settings');

      // Update button appearance
      if (settings.mjpeg_enabled) {
        mjpegBtn.classList.add('active');
        mjpegBtn.title = 'MJPEG Stream (Acik)';
        Logger.log(`[Cameras] MJPEG enabled for ${deviceId}`);
      } else {
        mjpegBtn.classList.remove('active');
        mjpegBtn.title = 'MJPEG Stream (Kapali)';
        Logger.log(`[Cameras] MJPEG disabled for ${deviceId}`);
      }

      // Restart the refresh to switch modes
      await this.restartRefresh(deviceId);

    } catch (error) {
      Logger.error('[Cameras] MJPEG toggle error:', error);
      alert('MJPEG durumu degistirilemedi');
    } finally {
      mjpegBtn.disabled = false;
      mjpegBtn.style.opacity = '';
    }
  },

  // ==================== ONVIF Integration ====================

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
            <button id="change-profile-btn" onclick="CameraSystem.changeOnvifProfile(${cameraId})" style="margin-top: 8px; padding: 6px 12px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">
              Profili Degistir
            </button>
          </div>

          <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #c8e6c9;">
            <button class="onvif-unlink-btn" onclick="CameraSystem.unlinkOnvif(${cameraId})" style="padding: 6px 12px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">
              Baglantıyi Kaldir
            </button>
          </div>
        </div>
      `;
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
              <button class="onvif-link-btn" onclick="CameraSystem.linkOnvif(${cameraId})" style="padding: 8px 16px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500;">
                Bagla
              </button>
            ` : ''}
            <button onclick="CameraSystem.showAddOnvifCameraModal()" style="padding: 8px 16px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500;">
              + Yeni Kamera Ekle
            </button>
          </div>
        </div>
      `;
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
        throw new Error(data.error || 'Profil degistirilemedi');
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
          <button type="button" onclick="document.getElementById('add-onvif-camera-modal').remove()" style="flex: 1; padding: 12px; background: #9E9E9E; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500;">
            Iptal
          </button>
        </div>
      </form>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

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
          <button type="button" id="change-profile-btn" onclick="CameraSystem.changeOnvifProfile(${cameraId})" style="margin-top: 8px; padding: 6px 12px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
            Profili Degistir
          </button>
        </div>
      `;
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

  /**
   * Pick location from map for settings
   */
  pickLocationFromSettings() {
    const cache = this.settingsCache;
    if (!cache) {
      console.error('[Settings] No cache found');
      return;
    }

    // Check if map is available
    if (!window.map) {
      alert('Harita bulunamadi');
      return;
    }

    // Store cache values before closing
    const deviceId = cache.deviceId;
    const cameraId = cache.cameraId;
    console.log('[Settings] Starting location pick for:', { deviceId, cameraId });

    // Close settings drawer temporarily
    this.closeSettings();

    // Also close my-cameras sidebar if open
    if (typeof MyCamerasSystem !== 'undefined' && MyCamerasSystem.close) {
      MyCamerasSystem.close();
    }

    // Show instruction toast
    this.showLocationPickToast();

    // Set crosshair cursor
    window.map.getCanvas().style.cursor = 'crosshair';

    // Flag to prevent double handling
    this._isPickingLocation = true;

    // Create click handler
    const self = this;
    const handleMapClick = function(e) {
      console.log('[Settings] Map clicked!', e.lngLat);

      // Prevent if already handled
      if (!self._isPickingLocation) {
        console.log('[Settings] Already handled, ignoring');
        return;
      }
      self._isPickingLocation = false;

      const lat = e.lngLat.lat;
      const lng = e.lngLat.lng;
      console.log('[Settings] Coordinates:', { lat, lng });

      // Store the picked coordinates
      self._pickedLocation = { lat, lng };

      // Clean up immediately
      self.cleanupLocationPick();
      console.log('[Settings] Cleaned up, reopening settings...');

      // Reopen settings with new coordinates
      setTimeout(() => {
        console.log('[Settings] Calling openSettings with:', deviceId, cameraId);
        self.openSettings(deviceId, cameraId);
        // Update the coordinate inputs after form renders
        setTimeout(() => {
          const latInput = document.getElementById('settings-lat');
          const lngInput = document.getElementById('settings-lng');
          console.log('[Settings] Found inputs:', { latInput: !!latInput, lngInput: !!lngInput });
          if (latInput) latInput.value = lat.toFixed(6);
          if (lngInput) lngInput.value = lng.toFixed(6);
        }, 500);
      }, 200);
    };

    // Store handler reference for cleanup
    this._locationPickHandler = handleMapClick;

    // Add click listener - try both methods
    window.map.once('click', handleMapClick);
    console.log('[Settings] Click listener added via map.once');

    // Also add via canvas directly as fallback
    const canvas = window.map.getCanvas();
    this._canvasClickHandler = (e) => {
      console.log('[Settings] Canvas clicked directly!');
      // Get coordinates from map
      const rect = canvas.getBoundingClientRect();
      const point = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
      const lngLat = window.map.unproject(point);
      console.log('[Settings] Canvas lngLat:', lngLat);

      // Create fake event for handler
      handleMapClick({ lngLat });

      // Remove this handler
      canvas.removeEventListener('click', this._canvasClickHandler);
    };
    canvas.addEventListener('click', this._canvasClickHandler, { once: true, capture: true });
    console.log('[Settings] Canvas click listener also added (capture phase)');

    // Add escape key handler to cancel
    this._escapeHandler = (e) => {
      if (e.key === 'Escape') {
        console.log('[Settings] Escape pressed, canceling');
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
    if (window.map) {
      window.map.getCanvas().style.cursor = '';
      if (this._locationPickHandler) {
        window.map.off('click', this._locationPickHandler);
        this._locationPickHandler = null;
      }
      // Also remove canvas click handler
      if (this._canvasClickHandler) {
        window.map.getCanvas().removeEventListener('click', this._canvasClickHandler);
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

  /**
   * Release camera from settings
   */
  async releaseCameraFromSettings() {
    const cameraId = this.settingsCache?.cameraId;
    const camera = this.settingsCache?.camera;

    if (!cameraId) {
      alert('Kamera ID bulunamadi');
      return;
    }

    const cameraName = camera?.name || 'Bu kamera';
    if (!confirm(`"${cameraName}" kamerasini birakmak istediginizden emin misiniz?\n\nKamera havuza geri donecek ve baska bir kullanici tarafindan sahiplenilebilir.`)) {
      return;
    }

    try {
      const response = await fetch(`${QBitmapConfig.api.users}/me/cameras/${cameraId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Kamera birakilamadi');
      }

      alert('Kamera basariyla birakildi');
      this.closeSettings();

      // Refresh camera list
      if (typeof MyCamerasSystem !== 'undefined') {
        MyCamerasSystem.loadCameras();
      }
      // Refresh map
      this.loadCameras();

    } catch (error) {
      Logger.error('[Settings] Release camera error:', error);
      alert('Hata: ' + error.message);
    }
  },

  /**
   * Delete camera permanently from settings
   */
  async deleteCameraFromSettings() {
    const cameraId = this.settingsCache?.cameraId;
    const camera = this.settingsCache?.camera;

    if (!cameraId) {
      alert('Kamera ID bulunamadi');
      return;
    }

    const cameraName = camera?.name || 'Bu kamera';
    if (!confirm(`"${cameraName}" kamerasini KALICI OLARAK silmek istediginizden emin misiniz?\n\nBu islem geri alinamaz! Tum kamera verileri silinecek.`)) {
      return;
    }

    // Double confirmation for delete
    if (!confirm('UYARI: Bu islem geri alinamaz!\n\nDevam etmek icin tekrar "Tamam" a basin.')) {
      return;
    }

    try {
      const response = await fetch(`${QBitmapConfig.api.users}/me/cameras/${cameraId}/delete`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Kamera silinemedi');
      }

      alert('Kamera kalici olarak silindi');
      this.closeSettings();

      // Refresh camera list
      if (typeof MyCamerasSystem !== 'undefined') {
        MyCamerasSystem.loadCameras();
      }
      // Refresh map
      this.loadCameras();

    } catch (error) {
      Logger.error('[Settings] Delete camera error:', error);
      alert('Hata: ' + error.message);
    }
  },

  /**
   * Save city camera settings
   */
  async saveCityCameraSettings() {
    const cameraId = this.settingsCache?.cameraId;
    if (!cameraId) {
      alert('Kamera ID bulunamadi');
      return;
    }

    const saveBtn = document.getElementById('settings-save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="spinner" style="width: 16px; height: 16px; display: inline-block; margin-right: 6px;"></span>Kaydediliyor...';
    }

    try {
      // Get form values
      const nameInput = document.getElementById('settings-name');
      const latInput = document.getElementById('settings-lat');
      const lngInput = document.getElementById('settings-lng');

      // Get AI settings
      const form = document.querySelector('.settings-form');
      const aiConfidence = form?.querySelector('input[name="ai_confidence_threshold"]');
      const aiFrames = form?.querySelector('input[name="ai_consecutive_frames"]');
      const aiInterval = form?.querySelector('input[name="ai_capture_interval_ms"]');
      const data = {};
      if (nameInput && nameInput.value.trim()) data.name = nameInput.value.trim();
      if (latInput && latInput.value) data.lat = parseFloat(latInput.value);
      if (lngInput && lngInput.value) data.lng = parseFloat(lngInput.value);

      // Add AI settings
      if (aiConfidence) data.ai_confidence_threshold = parseInt(aiConfidence.value);
      if (aiFrames) data.ai_consecutive_frames = parseInt(aiFrames.value);
      if (aiInterval) data.ai_capture_interval_ms = parseInt(aiInterval.value);

      // Add detection rules
      const detectionRules = this._collectDetectionRules();
      if (detectionRules.length > 0) data.ai_detection_rules = detectionRules;

      if (Object.keys(data).length === 0) {
        alert('Degisiklik yok');
        return;
      }

      // Call admin API
      const response = await fetch(`${QBitmapConfig.api.admin}/cameras/city/${cameraId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Kaydetme basarisiz');
      }

      Logger.log('[Settings] City camera saved:', data);

      if (saveBtn) {
        saveBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Kaydedildi!`;
      }

      setTimeout(() => {
        this.closeSettings();
        // Refresh map cameras
        this.loadCameras();
      }, 1000);

    } catch (error) {
      Logger.error('[Settings] City camera save error:', error);
      alert('Hata: ' + error.message);
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
            <polyline points="17 21 17 13 7 13 7 21"/>
            <polyline points="7 3 7 8 15 8"/>
          </svg>
          Kaydet`;
      }
    }
  },

  /**
   * Delete city camera
   */
  async deleteCityCamera() {
    const cameraId = this.settingsCache?.cameraId;
    const camera = this.settingsCache?.camera;

    if (!cameraId) {
      alert('Kamera ID bulunamadi');
      return;
    }

    const cameraName = camera?.name || 'Bu kamera';
    if (!confirm(`"${cameraName}" sehir kamerasini silmek istediginizden emin misiniz?\n\nBu islem geri alinamaz!`)) {
      return;
    }

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/cameras/city/${cameraId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Kamera silinemedi');
      }

      alert('Sehir kamerasi silindi');
      this.closeSettings();

      // Refresh map cameras
      this.loadCameras();

    } catch (error) {
      Logger.error('[Settings] Delete city camera error:', error);
      alert('Hata: ' + error.message);
    }
  }
};

export { SettingsMixin };
