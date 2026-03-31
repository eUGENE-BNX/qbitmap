import { getPointAlongRoute } from './route-math.js';
import * as AppState from '../state.js';
const { layers } = AppState;

/**
 * Map layer and GeoJSON source management
 */
export const MapLayerMixin = {
  addVehicleLayers: function() {
    var self = this;
    var totalIcons = this.carIcons.length + 1;
    var loadedCount = 0;

    var checkAllLoaded = function() {
      loadedCount++;
      if (loadedCount === totalIcons) {
        self.addVehicleSource();
      }
    };

    this.carIcons.forEach(function(iconFile, index) {
      var img = new Image();
      img.onload = function() {
        var iconName = 'vehicle-icon-' + index;
        if (!self.map.hasImage(iconName)) {
          self.map.addImage(iconName, img);
        }
        checkAllLoaded();
      };
      img.onerror = function() {
        checkAllLoaded();
      };
      img.src = '/' + iconFile;
    });

    var truckImg = new Image();
    truckImg.onload = function() {
      if (!self.map.hasImage('truck-icon')) {
        self.map.addImage('truck-icon', truckImg);
      }
      checkAllLoaded();
    };
    truckImg.onerror = function() {
      checkAllLoaded();
    };
    truckImg.src = '/' + this.truckIcon;
  },

  addVehicleSource: function() {
    var self = this;
    var features = this.vehicles.map(function(v) {
      var coords = self.routes[v.route];
      var pos = getPointAlongRoute(coords, v.routeLength, v.progress);
      self.vehiclePositions[v.id] = pos;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pos },
        properties: {
          id: v.id,
          plate: v.plate,
          bearing: 0,
          iconIndex: v.iconIndex,
          vehicleType: v.type || 'car'
        }
      };
    });

    if (!this.map.getSource('vehicles')) {
      this.map.addSource('vehicles', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: features }
      });
    }

    if (!this.map.getLayer('vehicles')) {
      var vis = layers.vehiclesVisible ? 'visible' : 'none';
      this.map.addLayer({
        id: 'vehicles',
        type: 'symbol',
        source: 'vehicles',
        minzoom: 14,
        maxzoom: 17,
        layout: {
          'visibility': vis,
          'icon-image': [
            'case',
            ['==', ['get', 'vehicleType'], 'truck'], 'truck-icon',
            ['concat', 'vehicle-icon-', ['to-string', ['get', 'iconIndex']]]
          ],
          'icon-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            14, 0.25,
            17, 0.5
          ],
          'icon-allow-overlap': true,
          'icon-rotate': ['-', ['get', 'bearing'], 90],
          'icon-rotation-alignment': 'map'
        }
      });
    }
  },
};
