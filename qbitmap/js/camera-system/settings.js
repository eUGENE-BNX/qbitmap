import { QBitmapConfig } from '../config.js';
import { Logger, escapeHtml, sanitize, fetchWithTimeout, TimerManager, showNotification } from '../utils.js';
import { AuthSystem } from '../auth.js';
import * as AppState from '../state.js';
import { OnvifMixin } from './settings/onvif.js';
import { LocationMixin } from './settings/location.js';
import { ActionsMixin } from './settings/actions.js';

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
            <button type="button" class="btn-pick-location" data-action="pick-location">
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
            <button type="button" class="btn-secondary" data-copy-url="${escapeHtml(rtmpUrl)}" data-action="copy-url">
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
                <button type="button" class="btn-warning" data-action="release-camera" style="background: #ff9800; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px;">
                  Kamerayi Birak
                </button>
                <button type="button" class="btn-danger" data-action="delete-camera" style="background: #f44336; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px;">
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
          <button type="button" class="btn-pick-location" data-action="pick-location">
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
              <button type="button" class="copy-stream-url" style="margin-top: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer; border: 1px solid #ccc; border-radius: 3px; background: #fff;" data-copy-url="${escapeHtml(streamUrl)}" data-action="copy-stream-url">URL Kopyala</button>
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
        <div style="font-size:11px;color:#999;margin-bottom:8px;">Her satira tespit edilecek bir durum yazin. Alarm kutusu isaretliyse alarm verilir, degilse sadece loglanir.</div>
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

    // Event delegation for data-action buttons
    const settingsForm = document.querySelector('.settings-form');
    if (settingsForm) {
      settingsForm.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'pick-location') {
          this.pickLocationFromSettings();
        } else if (action === 'copy-url') {
          navigator.clipboard.writeText(btn.dataset.copyUrl)
            .then(() => AuthSystem.showNotification('RTMP URL kopyalandi', 'success'))
            .catch(() => AuthSystem.showNotification('Kopyalama basarisiz', 'error'));
        } else if (action === 'copy-stream-url') {
          navigator.clipboard.writeText(btn.dataset.copyUrl);
          btn.textContent = 'Kopyalandi!';
          setTimeout(() => btn.textContent = 'URL Kopyala', 1500);
        } else if (action === 'release-camera') {
          this.releaseCameraFromSettings();
        } else if (action === 'delete-camera') {
          this.deleteCameraFromSettings();
        }
      });
    }

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

  // Spread sub-module methods
  ...OnvifMixin,
  ...LocationMixin,
  ...ActionsMixin,
};

export { SettingsMixin };
