import { Logger } from '../utils.js';
import * as AppState from '../state.js';

const MapLayerMixin = {
  /**
   * Initialize map layer (retry until map is ready)
   */
  initMapLayer() {
    if (AppState.map && AppState.map.isStyleLoaded()) {
      this.addBroadcastLayer(AppState.map);
    } else if (AppState.map) {
      AppState.map.on('load', () => this.addBroadcastLayer(AppState.map));
    } else {
      setTimeout(() => this.initMapLayer(), 500);
    }
  },

  /**
   * Update the broadcasts map layer
   */
  updateMapLayer() {
    const map = AppState.map;
    if (!map) return;

    const geojson = {
      type: 'FeatureCollection',
      features: Array.from(this.activeBroadcasts.values()).map(b => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [b.lng, b.lat] },
        properties: {
          broadcastId: b.broadcast_id,
          displayName: b.display_name || 'User',
          avatarUrl: b.avatar_url || '',
          whepUrl: b.whep_url
        }
      }))
    };

    const source = map.getSource('live-broadcasts');
    if (source) {
      source.setData(geojson);
    }
  },

  /**
   * Add broadcast layer to map
   */
  addBroadcastLayer(map) {
    // Guard: don't add if already exists
    if (map.getSource('live-broadcasts')) {
      this.updateMapLayer();
      return;
    }

    this.loadBroadcastIcon(map, () => {
      // Double-check after async icon load
      if (map.getSource('live-broadcasts')) {
        this.updateMapLayer();
        return;
      }

      map.addSource('live-broadcasts', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      map.addLayer({
        id: 'live-broadcasts',
        type: 'symbol',
        source: 'live-broadcasts',
        layout: {
          'icon-image': 'broadcast-icon-live',
          'icon-size': 0.6,
          'icon-allow-overlap': true
        }
      });

      // Click to watch
      map.on('click', 'live-broadcasts', (e) => {
        if (e.features && e.features.length > 0) {
          const feature = e.features[0];
          const coords = feature.geometry.coordinates.slice();
          const props = feature.properties;

          while (Math.abs(e.lngLat.lng - coords[0]) > 180) {
            coords[0] += e.lngLat.lng > coords[0] ? 360 : -360;
          }

          this.openBroadcastPopup(props, coords);
        }
      });

      map.on('mouseenter', 'live-broadcasts', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'live-broadcasts', () => {
        map.getCanvas().style.cursor = '';
      });

      // Load initial data
      this.updateMapLayer();
    });
  },

  /**
   * Load broadcast icon
   */
  loadBroadcastIcon(map, callback) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="46" height="18" viewBox="0 0 46 18">
        <rect x="0" y="0" width="46" height="18" rx="4" fill="#d93025"/>
        <polygon points="6,4 6,14 13,9" fill="white"/>
        <text x="16" y="13" font-family="Arial,sans-serif" font-size="10" font-weight="bold" fill="white">LIVE</text>
      </svg>
    `;

    const base64 = 'data:image/svg+xml;base64,' + btoa(svg);
    const img = new Image(46, 18);
    img.onload = () => {
      if (!map.hasImage('broadcast-icon-live')) {
        map.addImage('broadcast-icon-live', img);
      }
      callback();
    };
    img.onerror = () => {
      Logger.warn('[LiveBroadcast] Icon load failed, using fallback');
      callback();
    };
    img.src = base64;
  },
};

export { MapLayerMixin };
