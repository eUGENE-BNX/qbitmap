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

      const props = features[0].properties;
      const coords = features[0].geometry.coordinates.slice();

      if (self.popup) self.popup.remove();

      const soc = props.soc ?? 0;
      const gearMap = { 'P': 'Park', 'D': 'Sürüş', 'R': 'Geri', 'N': 'Nötr' };
      const gear = gearMap[props.gear] || props.gear || '-';
      const speed = Math.round(props.speed || 0);
      const name = props.displayName || 'Tesla';
      const model = props.model || 'Tesla';
      const owner = props.ownerName || '';

      let text = `🚗 ${name} — ${model}\n🔋 ${soc}%  ⚙️ ${gear}`;
      if (speed > 0) text += `  🏎️ ${speed} km/h`;
      if (owner) text += `\n👤 ${owner}`;

      self.popup = new maplibregl.Popup({ offset: [0, -15], closeButton: true, maxWidth: '280px' })
        .setLngLat(coords)
        .setText(text)
        .addTo(self.map);
    });
  }
};
