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
        img.src = '/car.png';
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
            4, 0.3,
            10, 0.5,
            14, 0.7,
            18, 1.0
          ],
          'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'visibility': 'none'
        },
        paint: {
          'icon-opacity': [
            'case',
            ['==', ['get', 'gear'], 'P'], 0.5,
            1.0
          ]
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
          ownerName: v.ownerName || '',
          ownerAvatar: v.ownerAvatar || '',
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
