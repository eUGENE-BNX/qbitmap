import { escapeHtml, showNotification } from '../utils.js';
import { QBitmapConfig } from '../config.js';
import { getTeslaIconUrl } from './icon.js';

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

      if (self.popup) { self.popup.remove(); self.popup = null; }

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

      requestAnimationFrame(() => {
        const fill = self.popup?.getElement()?.querySelector('.tv-battery-fill');
        if (fill) fill.style.width = (props.soc ?? 0) + '%';
      });
    });
  },

  _buildHTML(p) {
    const v = (x) => (x != null && x !== 'null' && x !== '' && x !== -999 && x !== -1) ? x : null;

    const soc = p.soc ?? 0;
    const speed = Math.round(p.speed || 0);
    const name = escapeHtml(p.displayName || 'Tesla');
    const model = escapeHtml(p.model || 'Tesla');
    const color = v(p.color);
    const carVersion = (() => { const x = v(p.carVersion); return x ? String(x).trim() || null : null; })();
    const odometer = v(p.odometer) ? Math.round(p.odometer).toLocaleString('tr-TR') : null;
    const estRange = v(p.estRange) ? Math.round(p.estRange) : null;
    const insideTemp = v(p.insideTemp) != null ? Math.round(p.insideTemp) : null;
    const outsideTemp = v(p.outsideTemp) != null ? Math.round(p.outsideTemp) : null;
    const locked = v(p.locked);
    const sentry = v(p.sentry);
    const teslaAvatar = v(p.teslaAvatar);

    const rawGear = speed === 0 ? 'P' : (p.gear || 'P');
    const gearMap = { 'P': 'Park', 'D': 'Drive', 'R': 'Reverse', 'N': 'Neutral' };
    const gearText = gearMap[rawGear] || rawGear;
    const gearClass = rawGear === 'D' ? 'driving' : rawGear === 'R' ? 'reverse' : 'parked';

    let tpms = null;
    try { tpms = p.tpms && p.tpms !== '' ? JSON.parse(p.tpms) : null; } catch {}

    let batteryClass = 'green';
    if (soc < 20) batteryClass = 'red';
    else if (soc < 50) batteryClass = 'amber';

    // Temperature icon SVG (thermometer)
    const tempIcon = '<svg class="tv-temp-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M15 13V5c0-1.66-1.34-3-3-3S9 3.34 9 5v8c-1.21.91-2 2.37-2 4 0 2.76 2.24 5 5 5s5-2.24 5-5c0-1.63-.79-3.09-2-4zm-4-8c0-.55.45-1 1-1s1 .45 1 1v3h-2V5z"/></svg>';

    const carIcon = getTeslaIconUrl(p);

    return `<div class="tv-card">
      <div class="tv-header">
        <div class="tv-title">
          <div class="tv-name">${name}</div>
          <div class="tv-sub">${model}${color ? ` \u00b7 ${escapeHtml(color)}` : ''}</div>
        </div>
        ${carIcon
          ? `<img class="tv-car-icon" src="${escapeHtml(carIcon)}" alt="${escapeHtml(p.color || '')}" />`
          : (teslaAvatar
            ? `<img class="tv-avatar" src="${escapeHtml(teslaAvatar)}" alt="" />`
            : `<div class="tv-logo">T</div>`)}
      </div>

      <div class="tv-battery-row">
        <div class="tv-battery">
          <div class="tv-battery-bar">
            <div class="tv-battery-fill tv-battery-${batteryClass}"></div>
          </div>
        </div>
        <span class="tv-battery-pct">${soc}%</span>
        ${estRange ? `<span class="tv-range">Menzil: ${estRange}km</span>` : ''}
      </div>

      ${insideTemp != null || outsideTemp != null ? `
      <div class="tv-temp-row">
        ${outsideTemp != null ? `<span class="tv-temp">${tempIcon} D\u0131\u015f ${outsideTemp}\u00b0</span>` : ''}
        ${insideTemp != null ? `<span class="tv-temp">${tempIcon} \u0130\u00e7 ${insideTemp}\u00b0</span>` : ''}
      </div>` : ''}

      <div class="tv-main-row">
        <div class="tv-left">
          ${tpms ? `
          <div class="tv-tpms-mini">
            <span>FL: ${tpms.fl} bar</span><span>FR: ${tpms.fr} bar</span>
            <span>RL: ${tpms.rl} bar</span><span>RR: ${tpms.rr} bar</span>
          </div>` : ''}
        </div>
        <div class="tv-right">
          <span class="tv-gear tv-gear-${gearClass}">${gearText}${speed > 0 ? ` ${speed}km/h` : ''}</span>
          ${locked != null ? `<span class="tv-tag ${locked ? 'tv-tag-green' : 'tv-tag-red'}">${locked ? 'Kilitli' : 'A\u00e7\u0131k'}</span>` : ''}
          ${sentry ? `<span class="tv-tag tv-tag-blue">N\u00f6bet\u00e7i</span>` : ''}
        </div>
      </div>

      <div class="tv-footer">
        ${odometer ? `<span class="tv-footer-odo">Odometer: ${odometer} km</span>` : ''}
        ${carVersion ? `<span class="tv-footer-version">v${escapeHtml(carVersion)}</span>` : ''}
      </div>
    </div>`;
  }
};
