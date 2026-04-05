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

    // Sentinel values: -999 = no data (temp), -1 = no data (range/lock)
    const estRange = props.estRange > 0 ? Math.round(props.estRange) : null;
    const insideTemp = props.insideTemp > -900 ? Math.round(props.insideTemp) : null;
    const outsideTemp = props.outsideTemp > -900 ? Math.round(props.outsideTemp) : null;
    const locked = props.locked >= 0 ? props.locked : null;
    const sentry = props.sentry >= 0 ? props.sentry : null;

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
        ${estRange ? `<span class="tv-range">${estRange} km</span>` : ''}
      </div>
      ${insideTemp || outsideTemp ? `<div class="tv-row tv-temps">
        ${outsideTemp ? `<span class="tv-temp-item">Dis ${outsideTemp}&deg;</span>` : ''}
        ${insideTemp ? `<span class="tv-temp-item">Ic ${insideTemp}&deg;</span>` : ''}
      </div>` : ''}
      <div class="tv-row">
        <span class="tv-gear tv-gear-${gearClass}">${gearText}</span>
        ${speed > 0 ? `<span class="tv-speed">${speed} km/h</span>` : ''}
      </div>
      ${locked || sentry ? `<div class="tv-row tv-status">
        ${locked ? `<span class="tv-badge tv-badge-ok">Kilitli</span>` : locked === false || locked === 0 ? `<span class="tv-badge tv-badge-warn">Acik</span>` : ''}
        ${sentry ? `<span class="tv-badge tv-badge-blue">Nobetci</span>` : ''}
      </div>` : ''}
    </div>`;
  }
};
