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

      // Set battery bar width via JS (CSP blocks inline styles)
      requestAnimationFrame(() => {
        const fill = self.popup?.getElement()?.querySelector('.tv-battery-fill');
        if (fill) fill.style.width = (props.soc ?? 0) + '%';
      });
    });
  },

  _buildHTML(props) {
    const soc = props.soc ?? 0;
    const gearMap = { 'P': 'Park', 'D': 'Drive', 'R': 'Reverse', 'N': 'Neutral' };
    const gearText = gearMap[props.gear] || props.gear || 'Park';
    const gearClass = props.gear === 'D' ? 'driving' : props.gear === 'R' ? 'reverse' : 'parked';
    const speed = Math.round(props.speed || 0);
    const displayName = escapeHtml(props.displayName || 'Tesla');
    const model = escapeHtml(props.model || 'Tesla');

    let batteryClass = 'green';
    if (soc < 20) batteryClass = 'red';
    else if (soc < 50) batteryClass = 'amber';

    // Range: Tesla sends miles, backend converts to km
    const estRange = props.estRange != null ? Math.round(props.estRange) : null;

    // Temps
    const insideTemp = props.insideTemp != null ? Math.round(props.insideTemp) : null;
    const outsideTemp = props.outsideTemp != null ? Math.round(props.outsideTemp) : null;

    // Locked & Sentry
    const locked = props.locked;
    const sentry = props.sentry;

    return `<div class="tv-card">
      <div class="tv-header">
        <div class="tv-logo">T</div>
        <div class="tv-title">
          <div class="tv-name">${displayName}</div>
          <div class="tv-model">${model}</div>
        </div>
      </div>
      <div class="tv-row">
        <div class="tv-battery">
          <div class="tv-battery-bar">
            <div class="tv-battery-fill tv-battery-${batteryClass}"></div>
          </div>
          <span class="tv-battery-pct">${soc}%</span>
        </div>
        ${estRange != null ? `<span class="tv-range">${estRange} km</span>` : ''}
      </div>
      ${insideTemp != null || outsideTemp != null ? `<div class="tv-row tv-temps">
        ${outsideTemp != null ? `<span class="tv-temp-item">Dis ${outsideTemp}&deg;</span>` : ''}
        ${insideTemp != null ? `<span class="tv-temp-item">Ic ${insideTemp}&deg;</span>` : ''}
      </div>` : ''}
      <div class="tv-row">
        <span class="tv-gear tv-gear-${gearClass}">${gearText}</span>
        ${speed > 0 ? `<span class="tv-speed">${speed} km/h</span>` : ''}
      </div>
      ${locked != null || sentry != null ? `<div class="tv-row tv-status">
        ${locked != null ? `<span class="tv-badge ${locked ? 'tv-badge-ok' : 'tv-badge-warn'}">${locked ? 'Kilitli' : 'Acik'}</span>` : ''}
        ${sentry != null && sentry ? `<span class="tv-badge tv-badge-blue">Nobetci</span>` : ''}
      </div>` : ''}
    </div>`;
  }
};
