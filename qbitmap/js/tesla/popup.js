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
      const html = self._buildHTML(props);

      self.popup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        maxWidth: 'none',
        anchor: 'bottom',
        className: 'tesla-vehicle-popup'
      })
      .setLngLat(coords)
      .setHTML(html)
      .addTo(self.map);
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
    const ownerName = escapeHtml(props.ownerName || '');

    let batteryClass = 'green';
    if (soc < 20) batteryClass = 'red';
    else if (soc < 50) batteryClass = 'amber';

    return `<div class="tv-card">
      <div class="tv-header">
        <div class="tv-logo">T</div>
        <div class="tv-title">
          <div class="tv-name">${displayName}</div>
          <div class="tv-model">${model}</div>
        </div>
      </div>
      <div class="tv-stats">
        <div class="tv-stat">
          <div class="tv-stat-label">Pil</div>
          <div class="tv-battery">
            <div class="tv-battery-bar">
              <div class="tv-battery-fill tv-battery-${batteryClass}" style="width:${soc}%"></div>
            </div>
            <span class="tv-battery-pct">${soc}%</span>
          </div>
        </div>
        <div class="tv-stat">
          <div class="tv-stat-label">Durum</div>
          <div class="tv-gear tv-gear-${gearClass}">${gearText}${speed > 0 ? ' - ' + speed + ' km/h' : ''}</div>
        </div>
      </div>
    </div>`;
  }
};
