import * as AppState from '../state.js';

// NOTE: GPS sampling moved to services/location-service.js (LocationService.get()).
// This mixin now only owns the UX bits — accuracy confirmation dialog and map picker.

const GeoMixin = {
  /**
   * Show dialog when GPS accuracy is poor (> 25m)
   * Returns { lng, lat } if user accepts, null if user wants map pick
   */
  _showLocationDialog(accuracy, lng, lat) {
    return new Promise((resolve) => {
      const dialog = document.createElement('div');
      dialog.className = 'broadcast-location-dialog';
      dialog.innerHTML = `
        <div class="location-dialog-content">
          <div class="location-dialog-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#4caf50" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
            </svg>
          </div>
          <div class="location-dialog-text">
            Konum dogruluğu: ±${Math.round(accuracy)}m
          </div>
          <div class="location-dialog-hint">
            Daha doğru konum için haritadan seçebilirsiniz
          </div>
          <div class="location-dialog-actions">
            <button class="location-dialog-btn primary" data-action="use">
              Bu Konumu Kullan
            </button>
            <button class="location-dialog-btn secondary" data-action="pick">
              Haritadan Seç
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(dialog);

      dialog.querySelector('[data-action="use"]').onclick = () => {
        dialog.remove();
        resolve({ lng, lat });
      };

      dialog.querySelector('[data-action="pick"]').onclick = () => {
        dialog.remove();
        resolve(null);
      };
    });
  },

  /**
   * Let user pick broadcast location by clicking on the map
   * Returns { lng, lat } or rejects on cancel/ESC
   */
  _pickLocationFromMap() {
    return new Promise((resolve, reject) => {
      const map = AppState.map;
      if (!map) return reject(new Error('Map not available'));

      map.getCanvas().style.cursor = 'crosshair';

      const hint = document.createElement('div');
      hint.className = 'broadcast-location-hint';
      hint.id = 'broadcast-location-hint';
      hint.innerHTML = `
        <span class="hint-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
          </svg>
        </span>
        <span>Yayın konumunu seçin</span>
        <button class="hint-cancel" id="broadcast-hint-cancel">İptal</button>
      `;
      document.body.appendChild(hint);

      const cleanup = () => {
        map.getCanvas().style.cursor = '';
        map.off('click', clickHandler);
        document.removeEventListener('keydown', escHandler);
        const el = document.getElementById('broadcast-location-hint');
        if (el) el.remove();
      };

      const clickHandler = (e) => {
        cleanup();
        resolve({ lng: e.lngLat.lng, lat: e.lngLat.lat });
      };

      const escHandler = (e) => {
        if (e.key === 'Escape') {
          cleanup();
          reject(new Error('cancelled'));
        }
      };

      hint.querySelector('#broadcast-hint-cancel').onclick = () => {
        cleanup();
        reject(new Error('cancelled'));
      };

      document.addEventListener('keydown', escHandler);
      map.once('click', clickHandler);
    });
  }
};

export { GeoMixin };
