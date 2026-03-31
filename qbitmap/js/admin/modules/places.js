import { QBitmapConfig } from '../../config.js';

export const PlacesMixin = {
  placesData: [],
  placesPagination: { page: 1, limit: 20, total: 0, totalPages: 0 },

  async loadPlacesTab() {
    await Promise.all([this.loadPlacesSettings(), this.loadPlacesStats(), this.loadPlaces()]);
    this.bindPlacesEvents();
  },

  _placesEventsBound: false,
  bindPlacesEvents() {
    if (this._placesEventsBound) return;
    this._placesEventsBound = true;
    document.getElementById('save-places-settings-btn')?.addEventListener('click', () => this.savePlacesSettings());
    document.getElementById('clear-places-cache-btn')?.addEventListener('click', () => this.clearPlacesCache());
    document.getElementById('places-search')?.addEventListener('input', this.debounce(() => { this.placesPagination.page = 1; this.loadPlaces(); }, 300));
  },

  async loadPlacesSettings() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/settings`, { credentials: 'include' });
      if (!response.ok) return;
      const data = await response.json();
      const settings = {};
      for (const s of (data.settings || data)) { settings[s.key] = s.value; }

      const radiusEl = document.getElementById('places-radius');
      const maxResultsEl = document.getElementById('places-max-results');
      const typesEl = document.getElementById('places-included-types');
      const fallbackEl = document.getElementById('places-fallback-types');

      if (radiusEl && settings.places_radius) radiusEl.value = settings.places_radius;
      if (maxResultsEl && settings.places_max_results) maxResultsEl.value = settings.places_max_results;
      if (typesEl && settings.places_included_types) { try { typesEl.value = JSON.parse(settings.places_included_types).join(', '); } catch { typesEl.value = settings.places_included_types; } }
      if (fallbackEl && settings.places_fallback_types) { try { fallbackEl.value = JSON.parse(settings.places_fallback_types).join(', '); } catch { fallbackEl.value = settings.places_fallback_types; } }
    } catch (e) { console.error('[Admin] Load places settings error:', e); }
  },

  async savePlacesSettings() {
    const statusEl = document.getElementById('places-settings-status');
    try {
      const radius = document.getElementById('places-radius')?.value || '30';
      const maxResults = document.getElementById('places-max-results')?.value || '10';
      const typesRaw = document.getElementById('places-included-types')?.value || '';
      const typesJson = JSON.stringify(typesRaw.split(',').map(t => t.trim()).filter(t => t));
      const fallbackRaw = document.getElementById('places-fallback-types')?.value || '';
      const fallbackJson = JSON.stringify(fallbackRaw.split(',').map(t => t.trim()).filter(t => t));

      const response = await fetch(`${QBitmapConfig.api.admin}/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ places_radius: radius, places_max_results: maxResults, places_included_types: typesJson, places_fallback_types: fallbackJson })
      });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Failed'); }
      if (statusEl) { statusEl.textContent = 'Kaydedildi!'; statusEl.className = 'save-status success'; }
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
    } catch (error) {
      console.error('[Admin] Save places settings error:', error);
      if (statusEl) { statusEl.textContent = 'Hata: ' + error.message; statusEl.className = 'save-status error'; }
    }
  },

  async loadPlacesStats() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/places/stats`, { credentials: 'include' });
      if (!response.ok) return;
      const data = await response.json();
      const el = document.getElementById('places-stats');
      if (el) {
        el.innerHTML = `
          <div class="places-stat-item"><span class="stat-value">${data.totalPlaces}</span><span class="stat-label">Toplam Mekan</span></div>
          <div class="places-stat-item"><span class="stat-value">${data.totalCells}</span><span class="stat-label">Cache Hucre</span></div>
          <div class="places-stat-item"><span class="stat-value">${data.taggedMessages}</span><span class="stat-label">Etiketli Mesaj</span></div>
        `;
      }
    } catch (e) { console.error('[Admin] Load places stats error:', e); }
  },

  async loadPlaces() {
    try {
      const search = document.getElementById('places-search')?.value || '';
      const { page, limit } = this.placesPagination;
      const params = new URLSearchParams({ page, limit });
      if (search) params.set('search', search);

      const response = await fetch(`${QBitmapConfig.api.admin}/places?${params}`, { credentials: 'include' });
      if (!response.ok) return;
      const data = await response.json();
      this.placesData = data.places || [];
      this.placesPagination = data.pagination || this.placesPagination;
      this.renderPlaces();
      this.renderPlacesPagination();
    } catch (e) { console.error('[Admin] Load places error:', e); }
  },

  renderPlaces() {
    const tbody = document.getElementById('places-tbody');
    if (!tbody) return;
    if (this.placesData.length === 0) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;">Henuz cache\'lenmis mekan yok</td></tr>'; return; }

    const esc = (t) => { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; };
    tbody.innerHTML = this.placesData.map(p => {
      const types = typeof p.types === 'string' ? JSON.parse(p.types || '[]') : (p.types || []);
      const typesHtml = types.slice(0, 3).map(t => `<span class="type-badge">${esc(t)}</span>`).join('');
      const iconHtml = p.icon_url ? `<img src="${esc(p.icon_url)}" class="place-icon" alt="">` : '<span class="place-icon-placeholder">📍</span>';
      return `<tr>
        <td>${iconHtml}</td>
        <td><strong>${esc(p.display_name)}</strong></td>
        <td><span class="msg-meta" style="font-family:monospace;font-size:11px">${p.lat ? `${Number(p.lat).toFixed(4)}, ${Number(p.lng).toFixed(4)}` : '-'}</span></td>
        <td>${typesHtml}</td>
        <td>${p.tag_count || 0}</td>
        <td><button class="btn btn-small" data-action="edit-place-icon" data-id="${p.id}">Ikon</button><button class="btn btn-small btn-danger" data-action="delete-place" data-id="${p.id}">Sil</button></td>
      </tr>`;
    }).join('');
  },

  renderPlacesPagination() {
    const container = document.getElementById('places-pagination');
    if (!container) return;
    const { page, totalPages } = this.placesPagination;
    if (!totalPages || totalPages <= 1) { container.innerHTML = ''; return; }

    let html = `<button class="page-btn" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">Prev</button>`;
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
        html += `<button class="page-btn ${i === page ? 'active' : ''}" data-page="${i}">${i}</button>`;
      } else if (i === page - 2 || i === page + 2) { html += '<span class="page-btn">...</span>'; }
    }
    html += `<button class="page-btn" ${page >= totalPages ? 'disabled' : ''} data-page="${page + 1}">Next</button>`;
    container.innerHTML = html;
  },

  goToPlacesPage(page) { this.placesPagination.page = page; this.loadPlaces(); },

  async editPlaceIcon(placeId) {
    const iconUrl = prompt('Ikon URL girin (bos birakmak icin Cancel):', '');
    if (iconUrl === null) return;
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/places/${placeId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ icon_url: iconUrl || null })
      });
      if (!response.ok) throw new Error('Failed');
      this.showToast('Ikon guncellendi', 'success'); this.loadPlaces();
    } catch (e) { this.showToast('Ikon guncellenemedi', 'error'); }
  },

  async deletePlace(placeId) {
    if (!confirm('Bu mekani silmek istediginize emin misiniz?')) return;
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/places/${placeId}`, { method: 'DELETE', credentials: 'include' });
      if (!response.ok) throw new Error('Failed');
      this.showToast('Mekan silindi', 'success'); this.loadPlaces(); this.loadPlacesStats();
    } catch (e) { this.showToast('Mekan silinemedi', 'error'); }
  },

  async clearPlacesCache() {
    if (!confirm('Tum places cache\'ini temizlemek istediginize emin misiniz?')) return;
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/places/cache`, { method: 'DELETE', credentials: 'include' });
      if (!response.ok) throw new Error('Failed');
      this.showToast('Cache temizlendi', 'success'); this.loadPlacesStats(); this.loadPlaces();
    } catch (e) { this.showToast('Cache temizlenemedi', 'error'); }
  },
};
