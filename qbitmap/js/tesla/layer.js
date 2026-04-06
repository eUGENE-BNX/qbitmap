export const TeslaLayer = {
  map: null,
  sourceId: 'tesla-fleet-vehicles',
  layerId: 'tesla-fleet-vehicles',
  vehicles: [],

  async init(mapInstance) {
    this.map = mapInstance;

    // Load Tesla car icon if not already loaded
    if (!this.map.hasImage('tesla-car-icon')) {
      await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          if (!this.map.hasImage('tesla-car-icon')) {
            this.map.addImage('tesla-car-icon', img);
          }
          resolve();
        };
        img.onerror = resolve;
        img.src = '/car4.png';
      });
    }

    // Add GeoJSON source
    if (!this.map.getSource(this.sourceId)) {
      this.map.addSource(this.sourceId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
    }

    // Add symbol layer using existing vehicle icons
    if (!this.map.getLayer(this.layerId)) {
      this.map.addLayer({
        id: this.layerId,
        type: 'symbol',
        source: this.sourceId,
        layout: {
          'icon-image': 'tesla-car-icon',
          'icon-size': [
            'interpolate', ['linear'], ['zoom'],
            4, 0.15,
            10, 0.25,
            14, 0.35,
            18, 0.5
          ],
          'icon-rotate': ['-', ['get', 'bearing'], 90],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'text-field': ['concat', ['to-string', ['get', 'speed']], ' km/h'],
          'text-font': ['Noto Sans Medium'],
          'text-size': 11,
          'text-offset': [0, 2.2],
          'text-anchor': 'top',
          'text-allow-overlap': true,
          'visibility': 'none'
        },
        paint: {
          'icon-opacity': [
            'case',
            ['==', ['get', 'gear'], 'P'], 0.5,
            1.0
          ],
          'text-color': '#22c55e',
          'text-halo-color': 'rgba(0,0,0,0.8)',
          'text-halo-width': 1.5
        },
        minzoom: 4,
        maxzoom: 22
      });
    }
  },

  updateVehicles(vehicles) {
    this.vehicles = vehicles;
    this._updateSource();
  },

  updateSingleVehicle(update) {
    const idx = this.vehicles.findIndex(v => v.vin === update.vin);
    if (idx >= 0) {
      Object.assign(this.vehicles[idx], update);
    } else {
      this.vehicles.push(update);
    }
    this._updateSource();
  },

  _updateSource() {
    const source = this.map?.getSource(this.sourceId);
    if (!source) return;

    const features = this.vehicles
      .filter(v => v.lat != null && v.lng != null)
      .map(v => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [v.lng, v.lat]
        },
        properties: {
          vin: v.vin,
          vehicleId: v.vehicleId,
          displayName: v.displayName || 'Tesla',
          model: v.model || 'Tesla',
          soc: v.soc ?? 0,
          gear: v.gear || 'P',
          bearing: v.bearing || 0,
          speed: v.speed || 0,
          isOnline: v.isOnline,
          insideTemp: v.insideTemp ?? -999,
          outsideTemp: v.outsideTemp ?? -999,
          estRange: v.estRange ?? -1,
          locked: v.locked != null ? (v.locked ? 1 : 0) : -1,
          sentry: v.sentry != null ? (v.sentry ? 1 : 0) : -1,
          color: v.color || '',
          carVersion: v.carVersion || '',
          odometer: v.odometer || 0,
          tpms: v.tpms ? JSON.stringify(v.tpms) : '',
        }
      }));

    source.setData({ type: 'FeatureCollection', features });
  },

  show() {
    if (this.map?.getLayer(this.layerId)) {
      this.map.setLayoutProperty(this.layerId, 'visibility', 'visible');
      // Move to top so it's above H3 grid and other fill layers
      this.map.moveLayer(this.layerId);
    }
  },

  hide() {
    if (this.map?.getLayer(this.layerId)) {
      this.map.setLayoutProperty(this.layerId, 'visibility', 'none');
    }
  }
};
