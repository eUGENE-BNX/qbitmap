import { Logger } from '../utils.js';
import * as AppState from '../state.js';

const MapLayerMixin = {
  /**
   * Initialize map layer once the map style is ready.
   */
  initMapLayer() {
    AppState.mapReady.then(map => this.addBroadcastLayer(map));
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
          'icon-size': [
            'interpolate', ['linear'], ['zoom'],
            5, 0.2,
            10, 0.33,
            14, 0.45,
            18, 0.65
          ],
          'icon-allow-overlap': true
        }
      });

      // Pulse animation - oscillate opacity
      this._broadcastPulse = setInterval(() => {
        if (!map.getLayer('live-broadcasts')) {
          clearInterval(this._broadcastPulse);
          return;
        }
        const t = (Math.sin(Date.now() / 400) + 1) / 2; // 0..1 sinusoidal
        map.setPaintProperty('live-broadcasts', 'icon-opacity', 0.4 + t * 0.6); // 0.4..1.0
      }, 50);

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
    // Red broadcast icon - center dot with signal waves on both sides
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="6" fill="#d93025"/>
        <path d="M15 15a12.7 12.7 0 0 0 0 18" stroke="#d93025" stroke-width="3.5" stroke-linecap="round" fill="none"/>
        <path d="M9 9a21.2 21.2 0 0 0 0 30" stroke="#d93025" stroke-width="3.5" stroke-linecap="round" fill="none"/>
        <path d="M33 15a12.7 12.7 0 0 1 0 18" stroke="#d93025" stroke-width="3.5" stroke-linecap="round" fill="none"/>
        <path d="M39 9a21.2 21.2 0 0 1 0 30" stroke="#d93025" stroke-width="3.5" stroke-linecap="round" fill="none"/>
      </svg>
    `;

    const base64 = 'data:image/svg+xml;base64,' + btoa(svg);
    const img = new Image(48, 48);
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
