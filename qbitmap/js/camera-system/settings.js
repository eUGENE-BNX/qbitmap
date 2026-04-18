import { QBitmapConfig } from '../config.js';
import { Logger, escapeHtml, sanitize, fetchWithTimeout, TimerManager, showNotification } from '../utils.js';
import { AuthSystem } from '../auth.js';
import * as AppState from '../state.js';
import { OnvifMixin } from './settings/onvif.js';
import { LocationMixin } from './settings/location.js';
import { ActionsMixin } from './settings/actions.js';
import { buildPromptFromRules } from './ai-prompt.js';

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
   * Render settings form.
   * For WHEP cameras, show all settings consolidated
   * For City cameras, show admin settings
   */
  renderSettingsForm(s, isWhep = false, isCity = false, camera = null) {
    const deviceId = this.settingsCache?.deviceId || '[device_id]';
    const cameraId = this.settingsCache?.cameraId;

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

    return '<div class="settings-error">Bu kamera tipi için ayar yok</div>';
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
      preview.value = buildPromptFromRules(rules);
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

  // Spread sub-module methods
  ...OnvifMixin,
  ...LocationMixin,
  ...ActionsMixin,
};

export { SettingsMixin };
