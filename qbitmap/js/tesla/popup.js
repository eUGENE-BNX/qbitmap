import { escapeHtml } from '../utils.js';

export const TeslaPopup = {
  map: null,
  popup: null,

  init(mapInstance) {
    this.map = mapInstance;
    const self = this;

    this.map.on('mousemove', function(e) {
      if (!self.map.getLayer('tesla-fleet-vehicles')) return;
      const features = self.map.queryRenderedFeatures(e.point, { layers: ['tesla-fleet-vehicles'] });
      self.map.getCanvas().style.cursor = features.length ? 'pointer' : '';
    });

    this.map.on('click', function(e) {
      if (!self.map.getLayer('tesla-fleet-vehicles')) return;
      const features = self.map.queryRenderedFeatures(e.point, { layers: ['tesla-fleet-vehicles'] });
      if (!features.length) return;

      if (self.popup) {
        self.popup.remove();
        self.popup = null;
      }

      const props = features[0].properties;
      const coords = features[0].geometry.coordinates.slice();

      self.popup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        maxWidth: 'none',
        anchor: 'bottom',
        className: 'tesla-vehicle-popup'
      })
      .setLngLat(coords)
      .setHTML(self._buildHTML(props))
      .addTo(self.map);

      // Set battery bar width via JS (CSP)
      requestAnimationFrame(() => {
        const fill = self.popup?.getElement()?.querySelector('.tv-battery-fill');
        if (fill) fill.style.width = (props.soc ?? 0) + '%';
      });
    });
  },

  _buildHTML(p) {
    const v = (x) => (x != null && x !== 'null' && x !== '' && x !== -999 && x !== -1) ? x : null;

    const soc = p.soc ?? 0;
    const gearMap = { 'P': 'Park', 'D': 'Drive', 'R': 'Reverse', 'N': 'Neutral' };
    const gearText = gearMap[p.gear] || p.gear || 'Park';
    const gearClass = p.gear === 'D' ? 'driving' : p.gear === 'R' ? 'reverse' : 'parked';
    const speed = Math.round(p.speed || 0);
    const name = escapeHtml(p.displayName || 'Tesla');
    const model = escapeHtml(p.model || 'Tesla');
    const color = v(p.color);
    const carVersion = v(p.carVersion);
    const odometer = v(p.odometer) ? Math.round(p.odometer).toLocaleString('tr-TR') : null;
    const estRange = v(p.estRange) ? Math.round(p.estRange) : null;
    const insideTemp = v(p.insideTemp) != null ? Math.round(p.insideTemp) : null;
    const outsideTemp = v(p.outsideTemp) != null ? Math.round(p.outsideTemp) : null;
    const locked = v(p.locked);
    const sentry = v(p.sentry);

    let tpms = null;
    try { tpms = p.tpms && p.tpms !== '' ? JSON.parse(p.tpms) : null; } catch {}

    let batteryClass = 'green';
    if (soc < 20) batteryClass = 'red';
    else if (soc < 50) batteryClass = 'amber';

    return `<div class="tv-card">
      <div class="tv-header">
        <div class="tv-logo">T</div>
        <div class="tv-title">
          <div class="tv-name">${name}</div>
          <div class="tv-model">${model}${color ? ' · ' + escapeHtml(color) : ''}</div>
        </div>
      </div>

      <div class="tv-section">
        <div class="tv-row">
          <div class="tv-battery">
            <div class="tv-battery-bar">
              <div class="tv-battery-fill tv-battery-${batteryClass}"></div>
            </div>
            <span class="tv-battery-pct">${soc}%</span>
          </div>
          ${estRange ? `<span class="tv-range">${estRange} km</span>` : ''}
        </div>
      </div>

      <div class="tv-section">
        <div class="tv-row">
          <span class="tv-gear tv-gear-${gearClass}">${gearText}</span>
          ${speed > 0 ? `<span class="tv-speed">${speed} km/h</span>` : ''}
          ${locked != null ? `<span class="tv-badge ${locked ? 'tv-badge-ok' : 'tv-badge-warn'}">${locked ? 'Kilitli' : 'Acik'}</span>` : ''}
          ${sentry ? `<span class="tv-badge tv-badge-blue">Nobetci</span>` : ''}
        </div>
      </div>

      ${insideTemp != null || outsideTemp != null ? `<div class="tv-section">
        <div class="tv-row tv-temps">
          ${outsideTemp != null ? `<span class="tv-temp-item">Dis ${outsideTemp}&deg;C</span>` : ''}
          ${insideTemp != null ? `<span class="tv-temp-item">Ic ${insideTemp}&deg;C</span>` : ''}
        </div>
      </div>` : ''}

      ${tpms ? `<div class="tv-section">
        <div class="tv-tpms">
          <div class="tv-tpms-grid">
            <span class="tv-tpms-val">${tpms.fl}</span>
            <span class="tv-tpms-val">${tpms.fr}</span>
            <span class="tv-tpms-val">${tpms.rl}</span>
            <span class="tv-tpms-val">${tpms.rr}</span>
          </div>
          <span class="tv-tpms-unit">bar</span>
        </div>
      </div>` : ''}

      <div class="tv-footer">
        ${odometer ? `<span class="tv-meta">${odometer} km</span>` : ''}
        ${carVersion ? `<span class="tv-meta">v${escapeHtml(carVersion)}</span>` : ''}
      </div>
    </div>`;
  }
};
