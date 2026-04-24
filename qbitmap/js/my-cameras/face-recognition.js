import { QBitmapConfig } from "../config.js";
import { Logger, escapeHtml } from "../utils.js";
import { AuthSystem } from "../auth.js";
import { CameraSystem } from '../camera-system/index.js';

// Base API URL resolves to /api/face-detection etc. The original code
// did string manipulation on public path; keep the same convention.
const API = () => QBitmapConfig.api.public.replace('/public', '');

const DAYS_TR = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

function formatTimeShort(t) {
  if (!t) return '';
  // "HH:MM:SS" → "HH:MM"
  return String(t).slice(0, 5);
}

function maskToLabels(mask) {
  const n = Number(mask) || 0;
  if (n === 0x7f) return 'Her gün';
  const parts = [];
  for (let i = 0; i < 7; i++) if (n & (1 << i)) parts.push(DAYS_TR[i]);
  return parts.length ? parts.join(', ') : '—';
}

const FaceRecognitionMixin = {
  async openFaceRecognition(deviceId) {
    const camera = this.cameras.find(c => c.device_id === deviceId);
    if (!camera) {
      AuthSystem.showNotification('Kamera bulunamadı', 'error');
      return;
    }

    this.faceRecognitionCameraId = deviceId;
    this._frData = { settings: null, library: [], logs: [], rules: [] };

    // Create modal
    let modal = document.getElementById('face-recognition-modal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'face-recognition-modal';
    modal.className = 'claim-modal active fr-modal';
    modal.innerHTML = `
      <div class="modal-overlay"></div>
      <div class="modal-content fr-modal-content">
        <div class="fr-header">
          <div>
            <h3 class="fr-title">Yüz Tanıma</h3>
            <div class="fr-subtitle">${escapeHtml(camera.name || camera.device_id)} · kütüphane ve kurallar tüm kameralarında kullanılır</div>
          </div>
          <button class="fr-close" aria-label="Kapat">&times;</button>
        </div>

        <div class="fr-tabs" role="tablist">
          <button class="fr-tab active" data-tab="camera" role="tab">Bu Kamera</button>
          <button class="fr-tab" data-tab="library" role="tab">Yüz Kütüphanesi</button>
          <button class="fr-tab" data-tab="rules" role="tab">Yokluk Kuralları</button>
        </div>

        <div class="fr-body">
          <section class="fr-panel active" data-panel="camera">
            <div class="fr-row">
              <label class="fr-toggle-label">
                <span>Yüz Algılama</span>
                <input type="checkbox" id="fr-detection-toggle">
              </label>
              <select id="fr-interval">
                <option value="5">5 sn</option>
                <option value="10" selected>10 sn</option>
                <option value="30">30 sn</option>
                <option value="60">60 sn</option>
              </select>
            </div>
            <div class="fr-slider-row">
              <label class="fr-slider-label">Eşleşme Eşiği</label>
              <input type="range" id="fr-threshold" min="50" max="95" value="70">
              <span class="fr-threshold-value" id="fr-threshold-value">70</span>
            </div>
            <div class="fr-slider-hint">Daha yüksek = daha az yanlış alarm, ama bazı gerçek eşleşmeler kaçabilir.</div>

            <h4 class="fr-section-title">Son Algılamalar (bu kamera)</h4>
            <div class="fr-detections" id="fr-detections">
              <div class="fr-empty">Yükleniyor…</div>
            </div>
          </section>

          <section class="fr-panel" data-panel="library">
            <div class="fr-hint">🔔 işaretli yüzler herhangi bir kamerada görüldüğünde alarm verir.</div>
            <button class="fr-primary-btn" id="fr-add-face-btn-open">+ Yeni Yüz Ekle</button>

            <div class="fr-add-face-form" id="fr-add-face-form" hidden>
              <input type="text" id="fr-face-name" placeholder="İsim" maxlength="50">
              <input type="file" id="fr-face-file" accept="image/jpeg,image/png" hidden>
              <button class="fr-secondary-btn" id="fr-face-file-btn">Fotoğraf Seç</button>
              <span class="fr-file-name" id="fr-file-name"></span>
              <button class="fr-primary-btn" id="fr-add-face-submit" disabled>Ekle</button>
              <button class="fr-link-btn" id="fr-add-face-cancel">İptal</button>
            </div>

            <div class="fr-faces-grid" id="fr-faces-grid">
              <div class="fr-empty">Yükleniyor…</div>
            </div>
          </section>

          <section class="fr-panel" data-panel="rules">
            <div class="fr-hint">Seçili yüz belirtilen zaman aralığında HİÇBİR kameranda görülmezse alarm verilir.</div>
            <button class="fr-primary-btn" id="fr-add-rule-btn-open">+ Yeni Kural</button>

            <div class="fr-add-rule-form" id="fr-add-rule-form" hidden>
              <div class="fr-rule-row">
                <label>Yüz</label>
                <select id="fr-rule-face"></select>
              </div>
              <div class="fr-rule-row">
                <label>Etiket (opsiyonel)</label>
                <input type="text" id="fr-rule-label" placeholder="Ör: Ahmet sabah mesaisi" maxlength="100">
              </div>
              <div class="fr-rule-row">
                <label>Başlangıç</label>
                <input type="time" id="fr-rule-start" value="09:00">
                <label>Bitiş</label>
                <input type="time" id="fr-rule-end" value="10:00">
              </div>
              <div class="fr-rule-row">
                <label>Günler</label>
                <div class="fr-days" id="fr-rule-days"></div>
              </div>
              <div class="fr-rule-row">
                <label class="fr-toggle-label"><span>Sesli arama</span><input type="checkbox" id="fr-rule-voice"></label>
              </div>
              <div class="fr-rule-actions">
                <button class="fr-primary-btn" id="fr-rule-save">Kaydet</button>
                <button class="fr-link-btn" id="fr-rule-cancel">İptal</button>
              </div>
            </div>

            <div class="fr-rules-list" id="fr-rules-list">
              <div class="fr-empty">Yükleniyor…</div>
            </div>
          </section>
        </div>

        <div id="fr-error" class="fr-error"></div>
      </div>
    `;
    document.body.appendChild(modal);

    this._bindModalEvents(modal);
    await this._loadAllData(deviceId);
  },

  _bindModalEvents(modal) {
    const self = this;

    modal.querySelector('.modal-overlay').addEventListener('click', () => self.closeFaceRecognitionModal());
    modal.querySelector('.fr-close').addEventListener('click', () => self.closeFaceRecognitionModal());

    modal.querySelectorAll('.fr-tab').forEach(btn => {
      btn.addEventListener('click', () => self._switchTab(btn.dataset.tab));
    });

    // Camera tab bindings
    modal.querySelector('#fr-detection-toggle').addEventListener('change', () => self._toggleDetection());
    modal.querySelector('#fr-interval').addEventListener('change', () => self._updateSettings());
    const thrSlider = modal.querySelector('#fr-threshold');
    const thrValue = modal.querySelector('#fr-threshold-value');
    thrSlider.addEventListener('input', () => { thrValue.textContent = thrSlider.value; });
    thrSlider.addEventListener('change', () => self._updateSettings());

    // Library tab bindings
    modal.querySelector('#fr-add-face-btn-open').addEventListener('click', () => self._toggleAddFaceForm(true));
    modal.querySelector('#fr-add-face-cancel').addEventListener('click', () => self._toggleAddFaceForm(false));
    modal.querySelector('#fr-face-file-btn').addEventListener('click', () => modal.querySelector('#fr-face-file').click());
    modal.querySelector('#fr-face-file').addEventListener('change', (e) => self._handleFaceFilePick(e));
    modal.querySelector('#fr-face-name').addEventListener('input', () => self._updateAddFaceButton());
    modal.querySelector('#fr-add-face-submit').addEventListener('click', () => self._submitAddFace());

    // Rules tab bindings
    modal.querySelector('#fr-add-rule-btn-open').addEventListener('click', () => self._toggleAddRuleForm(true));
    modal.querySelector('#fr-rule-cancel').addEventListener('click', () => self._toggleAddRuleForm(false));
    modal.querySelector('#fr-rule-save').addEventListener('click', () => self._submitAddRule());

    // Build day checkboxes
    const daysContainer = modal.querySelector('#fr-rule-days');
    daysContainer.innerHTML = DAYS_TR.map((d, i) => `
      <label class="fr-day-check">
        <input type="checkbox" value="${i}" ${i < 5 ? 'checked' : ''}>
        <span>${d}</span>
      </label>
    `).join('');
  },

  _switchTab(tab) {
    const modal = document.getElementById('face-recognition-modal');
    if (!modal) return;
    modal.querySelectorAll('.fr-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    modal.querySelectorAll('.fr-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
  },

  async _loadAllData(deviceId) {
    try {
      const base = API();
      const [settingsRes, libraryRes, logsRes, rulesRes] = await Promise.all([
        fetch(`${base}/face-detection/${deviceId}/settings`, { credentials: 'include' }),
        fetch(`${base}/face-detection/library`, { credentials: 'include' }),
        fetch(`${base}/face-detection/${deviceId}/logs?limit=8`, { credentials: 'include' }),
        fetch(`${base}/face-absence/rules`, { credentials: 'include' })
      ]);

      if (settingsRes.ok) this._frData.settings = await settingsRes.json();
      if (libraryRes.ok) this._frData.library = (await libraryRes.json()).faces || [];
      if (logsRes.ok) this._frData.logs = (await logsRes.json()).logs || [];
      if (rulesRes.ok) this._frData.rules = (await rulesRes.json()).rules || [];

      this._renderCameraTab();
      this._renderLibraryTab();
      this._renderRulesTab();
    } catch (e) {
      Logger.error('[FaceRecognition] Load error:', e);
    }
  },

  _renderCameraTab() {
    const s = this._frData.settings || {};
    const modal = document.getElementById('face-recognition-modal');
    if (!modal) return;

    modal.querySelector('#fr-detection-toggle').checked = !!s.enabled;
    modal.querySelector('#fr-interval').value = s.interval || 10;
    const t = s.match_threshold || 70;
    modal.querySelector('#fr-threshold').value = t;
    modal.querySelector('#fr-threshold-value').textContent = t;

    const logEl = modal.querySelector('#fr-detections');
    const logs = this._frData.logs;
    if (!logs.length) {
      logEl.innerHTML = `<div class="fr-empty">Henüz algılama yok</div>`;
      return;
    }
    logEl.innerHTML = logs.slice(0, 8).map(log => {
      const d = new Date(log.detected_at);
      const timeStr = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      const dateStr = d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
      const name = log.person_name || 'Bilinmeyen';
      const thumb = log.face_image_url
        ? `<img class="fr-detection-thumb" src="${escapeHtml(log.face_image_url)}" alt="${escapeHtml(name)}"><div class="fr-detection-thumb-fallback" hidden>👤</div>`
        : `<div class="fr-detection-thumb-fallback">👤</div>`;
      return `
        <div class="fr-detection-item">
          ${thumb}
          <div class="fr-detection-info">
            <span class="fr-detection-name">${escapeHtml(name)}</span>
            <span class="fr-detection-meta">Skor ${Math.round(log.confidence || 0)} · ${dateStr} ${timeStr}</span>
          </div>
        </div>
      `;
    }).join('');

    logEl.querySelectorAll('img.fr-detection-thumb').forEach(img => {
      img.addEventListener('error', () => {
        img.hidden = true;
        if (img.nextElementSibling) img.nextElementSibling.hidden = false;
      });
    });
  },

  _renderLibraryTab() {
    const modal = document.getElementById('face-recognition-modal');
    if (!modal) return;
    const grid = modal.querySelector('#fr-faces-grid');
    const library = this._frData.library;

    if (!library.length) {
      grid.innerHTML = `<div class="fr-empty">Henüz referans yüz yok. "+ Yeni Yüz Ekle" ile başla.</div>`;
    } else {
      grid.innerHTML = library.map(f => `
        <div class="fr-face-card ${f.trigger_alarm ? 'alarm-on' : ''}" data-face-id="${f.id}">
          <div class="fr-face-img-wrap">
            <img src="${escapeHtml(f.face_image_url || '')}" alt="${escapeHtml(f.name)}" class="fr-face-img">
            <div class="fr-face-fallback" hidden>👤</div>
            <button class="fr-face-remove" data-face-id="${f.id}" title="Sil" aria-label="Sil">&times;</button>
          </div>
          <div class="fr-face-name">${escapeHtml(f.name)}</div>
          <button class="fr-face-alarm-btn" data-face-id="${f.id}" title="Alarm">
            <span class="fr-bell">🔔</span>
            <span class="fr-alarm-state">${f.trigger_alarm ? 'Açık' : 'Kapalı'}</span>
          </button>
        </div>
      `).join('');

      grid.querySelectorAll('img.fr-face-img').forEach(img => {
        img.addEventListener('error', () => {
          img.hidden = true;
          if (img.nextElementSibling) img.nextElementSibling.hidden = false;
        });
      });
      grid.querySelectorAll('.fr-face-alarm-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const fid = Number(btn.dataset.faceId);
          const face = this._frData.library.find(f => f.id === fid);
          if (face) this._toggleFaceAlarm(fid, !face.trigger_alarm);
        });
      });
      grid.querySelectorAll('.fr-face-remove').forEach(btn => {
        btn.addEventListener('click', () => this._removeFace(Number(btn.dataset.faceId)));
      });
    }

    // Also refresh the rule-form face dropdown since library is the source.
    this._renderRuleFormFaces();
  },

  _renderRuleFormFaces() {
    const modal = document.getElementById('face-recognition-modal');
    if (!modal) return;
    const sel = modal.querySelector('#fr-rule-face');
    const lib = this._frData.library;
    if (!lib.length) {
      sel.innerHTML = `<option value="">(Kütüphane boş — önce yüz ekle)</option>`;
      sel.disabled = true;
    } else {
      sel.innerHTML = lib.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
      sel.disabled = false;
    }
  },

  _renderRulesTab() {
    const modal = document.getElementById('face-recognition-modal');
    if (!modal) return;
    const list = modal.querySelector('#fr-rules-list');
    const rules = this._frData.rules;

    if (!rules.length) {
      list.innerHTML = `<div class="fr-empty">Henüz kural yok.</div>`;
      return;
    }

    list.innerHTML = rules.map(r => `
      <div class="fr-rule-card" data-rule-id="${r.id}">
        <div class="fr-rule-face">
          ${r.face_image_url
            ? `<img src="${escapeHtml(r.face_image_url)}" alt="${escapeHtml(r.face_name)}" class="fr-rule-avatar"><div class="fr-rule-avatar-fallback" hidden>👤</div>`
            : `<div class="fr-rule-avatar-fallback">👤</div>`}
        </div>
        <div class="fr-rule-info">
          <div class="fr-rule-name">${escapeHtml(r.face_name || '—')}</div>
          <div class="fr-rule-meta">
            ${formatTimeShort(r.start_time)}–${formatTimeShort(r.end_time)} · ${escapeHtml(maskToLabels(r.day_of_week_mask))}
            ${r.label ? ` · <em>${escapeHtml(r.label)}</em>` : ''}
          </div>
        </div>
        <label class="fr-toggle-label fr-rule-toggle">
          <input type="checkbox" data-rule-id="${r.id}" ${r.enabled ? 'checked' : ''}>
        </label>
        <button class="fr-link-btn fr-rule-delete" data-rule-id="${r.id}" title="Sil">🗑</button>
      </div>
    `).join('');

    list.querySelectorAll('img.fr-rule-avatar').forEach(img => {
      img.addEventListener('error', () => {
        img.hidden = true;
        if (img.nextElementSibling) img.nextElementSibling.hidden = false;
      });
    });
    list.querySelectorAll('.fr-rule-toggle input').forEach(cb => {
      cb.addEventListener('change', () => this._toggleRuleEnabled(Number(cb.dataset.ruleId), cb.checked));
    });
    list.querySelectorAll('.fr-rule-delete').forEach(btn => {
      btn.addEventListener('click', () => this._deleteRule(Number(btn.dataset.ruleId)));
    });
  },

  // --- Camera tab actions ---

  async _toggleDetection() {
    const modal = document.getElementById('face-recognition-modal');
    const enabled = modal.querySelector('#fr-detection-toggle').checked;
    const interval = parseInt(modal.querySelector('#fr-interval').value, 10);
    const match_threshold = parseInt(modal.querySelector('#fr-threshold').value, 10);

    try {
      await fetch(`${API()}/face-detection/${this.faceRecognitionCameraId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled, interval, match_threshold })
      });

      if (CameraSystem) {
        if (enabled) {
          const myCamera = this.cameras.find(c => c.device_id === this.faceRecognitionCameraId);
          if (!Array.isArray(CameraSystem.cameras)) CameraSystem.cameras = [];
          if (myCamera && !CameraSystem.cameras.find(c => c.device_id === this.faceRecognitionCameraId)) {
            CameraSystem.cameras.push(myCamera);
          }
          await CameraSystem.startFaceDetection(this.faceRecognitionCameraId, interval);
          AuthSystem.showNotification('Yüz algılama aktif', 'success');
        } else {
          await CameraSystem.stopFaceDetection(this.faceRecognitionCameraId);
          AuthSystem.showNotification('Yüz algılama durduruldu', 'info');
        }
      }
    } catch (e) {
      Logger.error('[FaceRecognition] Toggle error:', e);
    }
  },

  async _updateSettings() {
    const modal = document.getElementById('face-recognition-modal');
    const enabled = modal.querySelector('#fr-detection-toggle').checked;
    const interval = parseInt(modal.querySelector('#fr-interval').value, 10);
    const match_threshold = parseInt(modal.querySelector('#fr-threshold').value, 10);

    try {
      await fetch(`${API()}/face-detection/${this.faceRecognitionCameraId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled, interval, match_threshold })
      });

      if (CameraSystem && enabled) {
        const myCamera = this.cameras.find(c => c.device_id === this.faceRecognitionCameraId);
        if (!Array.isArray(CameraSystem.cameras)) CameraSystem.cameras = [];
        if (myCamera && !CameraSystem.cameras.find(c => c.device_id === this.faceRecognitionCameraId)) {
          CameraSystem.cameras.push(myCamera);
        }
        await CameraSystem.updateFaceDetectionSettings(this.faceRecognitionCameraId, enabled, interval);
      }
    } catch (e) {
      Logger.error('[FaceRecognition] Settings update error:', e);
    }
  },

  // --- Library tab actions ---

  _toggleAddFaceForm(show) {
    const modal = document.getElementById('face-recognition-modal');
    const form = modal.querySelector('#fr-add-face-form');
    form.hidden = !show;
    if (!show) {
      modal.querySelector('#fr-face-name').value = '';
      modal.querySelector('#fr-face-file').value = '';
      modal.querySelector('#fr-file-name').textContent = '';
      this._selectedFaceFile = null;
      this._updateAddFaceButton();
    }
  },

  _handleFaceFilePick(ev) {
    const f = ev.target.files?.[0];
    if (!f) return;
    this._selectedFaceFile = f;
    const modal = document.getElementById('face-recognition-modal');
    modal.querySelector('#fr-file-name').textContent = f.name;
    this._updateAddFaceButton();
  },

  _updateAddFaceButton() {
    const modal = document.getElementById('face-recognition-modal');
    if (!modal) return;
    const name = modal.querySelector('#fr-face-name').value.trim();
    modal.querySelector('#fr-add-face-submit').disabled = !name || !this._selectedFaceFile;
  },

  async _submitAddFace() {
    const modal = document.getElementById('face-recognition-modal');
    const name = modal.querySelector('#fr-face-name').value.trim();
    if (!name || !this._selectedFaceFile) return;

    const fd = new FormData();
    fd.append('name', name);
    fd.append('image', this._selectedFaceFile);

    const errDiv = modal.querySelector('#fr-error');
    errDiv.textContent = '';

    try {
      const res = await fetch(`${API()}/face-detection/library`, {
        method: 'POST',
        credentials: 'include',
        body: fd
      });
      const data = await res.json();
      if (!res.ok) {
        errDiv.textContent = (data.error?.message ?? data.error) || 'Yüz eklenemedi';
        return;
      }
      this._toggleAddFaceForm(false);
      AuthSystem.showNotification('Yüz eklendi', 'success');

      const libRes = await fetch(`${API()}/face-detection/library`, { credentials: 'include' });
      if (libRes.ok) this._frData.library = (await libRes.json()).faces || [];
      this._renderLibraryTab();

      if (CameraSystem && typeof CameraSystem._reloadFaceLibrary === 'function') {
        await CameraSystem._reloadFaceLibrary();
      }
    } catch (e) {
      Logger.error('[FaceRecognition] Add face error:', e);
      errDiv.textContent = 'Bir hata oluştu';
    }
  },

  async _removeFace(faceId) {
    if (!confirm('Bu yüzü kütüphaneden silmek istediğine emin misin?')) return;
    try {
      const res = await fetch(`${API()}/face-detection/library/${faceId}`, {
        method: 'DELETE', credentials: 'include'
      });
      if (!res.ok) throw new Error('Delete failed');

      this._frData.library = this._frData.library.filter(f => f.id !== faceId);
      this._renderLibraryTab();
      AuthSystem.showNotification('Yüz silindi', 'success');

      if (CameraSystem && typeof CameraSystem._reloadFaceLibrary === 'function') {
        await CameraSystem._reloadFaceLibrary();
      }
    } catch (e) {
      Logger.error('[FaceRecognition] Remove face error:', e);
      AuthSystem.showNotification('Yüz silinemedi', 'error');
    }
  },

  async _toggleFaceAlarm(faceId, enabled) {
    try {
      const res = await fetch(`${API()}/face-detection/library/${faceId}/alarm`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ trigger_alarm: enabled })
      });
      if (!res.ok) throw new Error('Failed');

      const face = this._frData.library.find(f => f.id === faceId);
      if (face) face.trigger_alarm = enabled ? 1 : 0;
      this._renderLibraryTab();

      if (CameraSystem && typeof CameraSystem._reloadFaceLibrary === 'function') {
        await CameraSystem._reloadFaceLibrary();
      }
      AuthSystem.showNotification(enabled ? 'Alarm aktif' : 'Alarm kapatıldı', 'success');
    } catch (e) {
      Logger.error('[FaceRecognition] Alarm toggle error:', e);
    }
  },

  // --- Rules tab actions ---

  _toggleAddRuleForm(show) {
    const modal = document.getElementById('face-recognition-modal');
    const form = modal.querySelector('#fr-add-rule-form');
    form.hidden = !show;
    if (show) this._renderRuleFormFaces();
  },

  async _submitAddRule() {
    const modal = document.getElementById('face-recognition-modal');
    const user_face_id = parseInt(modal.querySelector('#fr-rule-face').value, 10);
    const label = modal.querySelector('#fr-rule-label').value.trim();
    const start_time = modal.querySelector('#fr-rule-start').value;
    const end_time = modal.querySelector('#fr-rule-end').value;
    const voice_call_enabled = modal.querySelector('#fr-rule-voice').checked;

    let mask = 0;
    modal.querySelectorAll('#fr-rule-days input[type=checkbox]').forEach(cb => {
      if (cb.checked) mask |= (1 << parseInt(cb.value, 10));
    });

    const errDiv = modal.querySelector('#fr-error');
    errDiv.textContent = '';

    if (!user_face_id) { errDiv.textContent = 'Önce bir yüz seç'; return; }
    if (!start_time || !end_time) { errDiv.textContent = 'Başlangıç/bitiş saati gerekli'; return; }
    if (start_time >= end_time) { errDiv.textContent = 'Bitiş saati başlangıçtan sonra olmalı'; return; }
    if (mask === 0) { errDiv.textContent = 'En az bir gün seç'; return; }

    try {
      const res = await fetch(`${API()}/face-absence/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          user_face_id, label, start_time, end_time,
          day_of_week_mask: mask, enabled: true, voice_call_enabled
        })
      });
      const data = await res.json();
      if (!res.ok) {
        errDiv.textContent = (data.error?.message ?? data.error) || 'Kural oluşturulamadı';
        return;
      }
      this._toggleAddRuleForm(false);
      AuthSystem.showNotification('Kural oluşturuldu', 'success');

      const listRes = await fetch(`${API()}/face-absence/rules`, { credentials: 'include' });
      if (listRes.ok) this._frData.rules = (await listRes.json()).rules || [];
      this._renderRulesTab();
    } catch (e) {
      Logger.error('[FaceRecognition] Add rule error:', e);
      errDiv.textContent = 'Bir hata oluştu';
    }
  },

  async _toggleRuleEnabled(ruleId, enabled) {
    try {
      await fetch(`${API()}/face-absence/rules/${ruleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled })
      });
      const r = this._frData.rules.find(x => x.id === ruleId);
      if (r) r.enabled = enabled ? 1 : 0;
    } catch (e) {
      Logger.error('[FaceRecognition] Rule toggle error:', e);
    }
  },

  async _deleteRule(ruleId) {
    if (!confirm('Bu kuralı silmek istediğine emin misin?')) return;
    try {
      const res = await fetch(`${API()}/face-absence/rules/${ruleId}`, {
        method: 'DELETE', credentials: 'include'
      });
      if (!res.ok) throw new Error('Delete failed');
      this._frData.rules = this._frData.rules.filter(r => r.id !== ruleId);
      this._renderRulesTab();
      AuthSystem.showNotification('Kural silindi', 'success');
    } catch (e) {
      Logger.error('[FaceRecognition] Delete rule error:', e);
      AuthSystem.showNotification('Kural silinemedi', 'error');
    }
  },

  closeFaceRecognitionModal() {
    const modal = document.getElementById('face-recognition-modal');
    if (modal) modal.remove();
    this.faceRecognitionCameraId = null;
    this._selectedFaceFile = null;
    this._frData = null;
  }
};

// Modal-local CSS: injected once, scoped via .fr-modal / .fr-* classes.
if (!document.getElementById('fr-modal-styles')) {
  const style = document.createElement('style');
  style.id = 'fr-modal-styles';
  style.textContent = `
.fr-modal { position: fixed; inset: 0; z-index: 3000; display: flex; align-items: center; justify-content: center; }
.fr-modal .modal-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.5); }
.fr-modal-content { position: relative; width: 640px; max-width: calc(100% - 32px); max-height: 90vh; overflow-y: auto; background: #fff; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.2); z-index: 1; }
.fr-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 20px 24px 12px; gap: 16px; }
.fr-title { margin: 0; font-size: 18px; color: #202124; }
.fr-subtitle { font-size: 12px; color: #80868b; margin-top: 4px; }
.fr-close { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: none; border: none; font-size: 24px; color: #5f6368; cursor: pointer; border-radius: 50%; }
.fr-close:hover { background: #f1f3f4; }

.fr-tabs { display: flex; gap: 4px; padding: 0 16px; border-bottom: 1px solid #e8eaed; }
.fr-tab { flex: 1; padding: 10px 12px; background: none; border: none; font-size: 13px; color: #5f6368; cursor: pointer; border-bottom: 2px solid transparent; font-weight: 500; }
.fr-tab:hover { color: #202124; }
.fr-tab.active { color: #1a73e8; border-bottom-color: #1a73e8; }

.fr-body { padding: 16px 24px 24px; }
.fr-panel { display: none; }
.fr-panel.active { display: block; }
.fr-section-title { margin: 20px 0 10px; font-size: 13px; font-weight: 600; color: #3c4043; }
.fr-hint { font-size: 12px; color: #80868b; margin-bottom: 10px; }

/* Camera tab */
.fr-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; background: #f8f9fa; border-radius: 8px; margin-bottom: 8px; }
.fr-toggle-label { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 500; color: #3c4043; cursor: pointer; }
.fr-slider-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: #f8f9fa; border-radius: 8px; }
.fr-slider-label { font-size: 13px; color: #3c4043; flex: 0 0 110px; }
.fr-slider-row input[type=range] { flex: 1; }
.fr-threshold-value { min-width: 28px; text-align: right; font-weight: 600; color: #1a73e8; }
.fr-slider-hint { font-size: 11px; color: #9aa0a6; margin-top: 4px; padding: 0 12px; }

.fr-detections { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; background: rgba(0,0,0,0.02); border-radius: 10px; padding: 10px; }
.fr-detection-item { display: flex; flex-direction: column; gap: 6px; align-items: center; text-align: center; }
.fr-detection-thumb, .fr-detection-thumb-fallback { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; background: #e8eaed; display: flex; align-items: center; justify-content: center; font-size: 22px; }
.fr-detection-thumb-fallback[hidden], .fr-face-fallback[hidden], .fr-rule-avatar-fallback[hidden] { display: none; }
.fr-detection-name { font-size: 12px; color: #3c4043; font-weight: 500; max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fr-detection-meta { font-size: 10px; color: #80868b; }
.fr-empty { grid-column: 1 / -1; padding: 20px; text-align: center; color: #9aa0a6; font-size: 12px; }

/* Library tab */
.fr-faces-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 12px; max-height: 360px; overflow-y: auto; padding: 4px; }
.fr-face-card { border: 1px solid #e8eaed; border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; transition: border-color 0.15s; }
.fr-face-card.alarm-on { border-color: #f4b400; background: #fffbea; }
.fr-face-img-wrap { position: relative; }
.fr-face-img { width: 100%; aspect-ratio: 1; border-radius: 8px; object-fit: cover; background: #e8eaed; }
.fr-face-fallback { width: 100%; aspect-ratio: 1; border-radius: 8px; background: #e8eaed; display: flex; align-items: center; justify-content: center; font-size: 28px; }
.fr-face-remove { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border-radius: 50%; border: none; background: rgba(0,0,0,0.5); color: #fff; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.fr-face-name { font-size: 12px; font-weight: 600; color: #3c4043; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fr-face-alarm-btn { display: flex; align-items: center; justify-content: center; gap: 4px; padding: 4px 6px; border: 1px solid #e8eaed; background: #fff; border-radius: 6px; font-size: 11px; color: #5f6368; cursor: pointer; }
.fr-face-card.alarm-on .fr-face-alarm-btn { border-color: #f4b400; color: #b06a00; background: #fff4d6; }
.fr-bell { font-size: 12px; }

.fr-add-face-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px; background: #f1f3f4; border-radius: 8px; margin-bottom: 10px; }
.fr-add-face-form input[type=text] { flex: 1; min-width: 140px; padding: 6px 10px; border: 1px solid #dadce0; border-radius: 6px; font-size: 13px; }
.fr-file-name { font-size: 11px; color: #5f6368; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.fr-primary-btn { padding: 8px 14px; background: #1a73e8; color: #fff; border: none; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; }
.fr-primary-btn:disabled { background: #c0c4c9; cursor: not-allowed; }
.fr-secondary-btn { padding: 6px 12px; background: #fff; color: #1a73e8; border: 1px solid #dadce0; border-radius: 6px; font-size: 12px; cursor: pointer; }
.fr-link-btn { padding: 4px 8px; background: none; border: none; color: #5f6368; cursor: pointer; font-size: 12px; }
.fr-link-btn:hover { color: #d93025; }

/* Rules tab */
.fr-add-rule-form { padding: 12px; background: #f1f3f4; border-radius: 8px; margin: 10px 0; }
.fr-rule-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.fr-rule-row label { font-size: 12px; color: #3c4043; min-width: 70px; }
.fr-rule-row input[type=text], .fr-rule-row input[type=time], .fr-rule-row select { padding: 6px 8px; border: 1px solid #dadce0; border-radius: 6px; font-size: 13px; }
.fr-rule-row input[type=time] { width: 100px; }
.fr-rule-row select { flex: 1; min-width: 140px; }
.fr-days { display: flex; gap: 4px; flex-wrap: wrap; }
.fr-day-check { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; background: #fff; border: 1px solid #dadce0; border-radius: 6px; font-size: 12px; cursor: pointer; }
.fr-day-check input { margin: 0; }
.fr-rule-actions { display: flex; gap: 8px; margin-top: 10px; }

.fr-rules-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.fr-rule-card { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid #e8eaed; border-radius: 10px; background: #fff; }
.fr-rule-avatar, .fr-rule-avatar-fallback { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: #e8eaed; display: flex; align-items: center; justify-content: center; font-size: 20px; flex: 0 0 40px; }
.fr-rule-info { flex: 1; min-width: 0; }
.fr-rule-name { font-size: 14px; font-weight: 600; color: #3c4043; }
.fr-rule-meta { font-size: 11px; color: #80868b; margin-top: 2px; }
.fr-rule-toggle { margin: 0; }

.fr-error { min-height: 16px; color: #d93025; font-size: 12px; padding: 8px 24px 0; }

@media (max-width: 560px) {
  .fr-modal-content { width: calc(100% - 16px); }
  .fr-faces-grid, .fr-detections { grid-template-columns: repeat(3, 1fr); }
}
`;
  document.head.appendChild(style);
}

export { FaceRecognitionMixin };
