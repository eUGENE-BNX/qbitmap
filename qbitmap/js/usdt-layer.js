import { loadDeckAndH3 } from './vendor-loader.js';
import * as AppState from './state.js';

const SOURCE_ID = 'usdt-markers';
const LAYER_ID = 'usdt-markers';
const TOTAL_TARGET = 200;
const MAX_PER_HEX = 3;
const H3_RESOLUTION = 13;

// Ataşehir bounding polygon [lat, lng] order (matches h3-grid.js convention)
const ATASEHIR_POLYGON = [
  [40.9724, 29.0896], [41.0095, 29.0896],
  [41.0095, 29.1584], [40.9724, 29.1584],
  [40.9724, 29.0896]
];

export const UsdtLayer = {
  _initialized: false,
  _geojson: null,

  async show(map) {
    map = map || AppState.map;
    if (!map) return;

    if (!this._initialized) {
      await this._init(map);
    }

    if (map.getLayer(LAYER_ID)) {
      map.setLayoutProperty(LAYER_ID, 'visibility', 'visible');
    }
  },

  hide(map) {
    map = map || AppState.map;
    if (!map) return;

    if (map.getLayer(LAYER_ID)) {
      map.setLayoutProperty(LAYER_ID, 'visibility', 'none');
    }
  },

  async _init(map) {
    await loadDeckAndH3();
    await this._loadIcon(map);
    this._geojson = this._generateMarkers();

    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: this._geojson
    });

    map.addLayer({
      id: LAYER_ID,
      type: 'symbol',
      source: SOURCE_ID,
      layout: {
        'icon-image': 'usdt-icon',
        'icon-size': ['interpolate', ['linear'], ['zoom'],
          10, 0.06,
          14, 0.10,
          17, 0.16,
          20, 0.22
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'visibility': 'visible'
      },
      paint: {
        'icon-opacity': 0.7
      }
    });

    this._initialized = true;
  },

  _loadIcon(map) {
    return new Promise((resolve) => {
      if (map.hasImage('usdt-icon')) { resolve(); return; }
      const img = new Image();
      img.onload = () => {
        if (!map.hasImage('usdt-icon')) map.addImage('usdt-icon', img);
        resolve();
      };
      img.onerror = resolve;
      img.src = '/assets/usdt.png';
    });
  },

  _generateMarkers() {
    const cells = h3.polygonToCells(ATASEHIR_POLYGON, H3_RESOLUTION);

    // Fisher-Yates shuffle
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }

    const features = [];
    let total = 0;

    for (let i = 0; i < cells.length && total < TOTAL_TARGET; i++) {
      const count = Math.min(
        1 + Math.floor(Math.random() * MAX_PER_HEX),
        TOTAL_TARGET - total
      );
      const [lat, lng] = h3.cellToLatLng(cells[i]);

      for (let j = 0; j < count; j++) {
        // Small offset so multiple markers in same hex don't stack
        const offsetLat = count > 1 ? (Math.random() - 0.5) * 0.00006 : 0;
        const offsetLng = count > 1 ? (Math.random() - 0.5) * 0.00006 : 0;

        features.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [lng + offsetLng, lat + offsetLat]
          },
          properties: {}
        });
      }

      total += count;
    }

    return { type: 'FeatureCollection', features };
  }
};
