import { QBitmapConfig } from '../config.js';
import { Logger, escapeHtml } from '../utils.js';
import * as AppState from '../state.js';

const REFRESH_INTERVAL_MS = 60000;
let _refreshTimer = null;
let _initialized = false;

/**
 * Past Broadcast Recordings Map Layer
 * Shows saved broadcast recordings on the map with purple icons
 */
const PastBroadcastLayer = {

  recordings: [],

  async show(map) {
    if (!map) map = AppState.map;
    if (!map) return;

    if (!_initialized) {
      await this._initLayer(map);
      _initialized = true;
    }

    await this._loadRecordings(map);

    if (map.getLayer('past-broadcasts')) {
      map.setLayoutProperty('past-broadcasts', 'visibility', 'visible');
    }

    // Start periodic refresh
    this._startRefresh(map);
  },

  hide(map) {
    if (!map) map = AppState.map;
    if (!map) return;

    if (map.getLayer('past-broadcasts')) {
      map.setLayoutProperty('past-broadcasts', 'visibility', 'none');
    }

    this._stopRefresh();
  },

  async _initLayer(map) {
    // Load purple broadcast icon
    await this._loadIcon(map);

    if (map.getSource('past-broadcasts')) return;

    map.addSource('past-broadcasts', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });

    map.addLayer({
      id: 'past-broadcasts',
      type: 'symbol',
      source: 'past-broadcasts',
      layout: {
        'icon-image': 'broadcast-icon-past',
        'icon-size': [
          'interpolate', ['linear'], ['zoom'],
          5, 0.18,
          10, 0.28,
          14, 0.4,
          18, 0.55
        ],
        'icon-allow-overlap': true,
        'visibility': 'visible'
      }
    });

    // Click handler → open recording popup
    map.on('click', 'past-broadcasts', (e) => {
      if (e.features && e.features.length > 0) {
        const props = e.features[0].properties;
        this._openRecordingPopup(props, e.features[0].geometry.coordinates.slice());
      }
    });

    map.on('mouseenter', 'past-broadcasts', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'past-broadcasts', () => {
      map.getCanvas().style.cursor = '';
    });
  },

  _loadIcon(map) {
    return new Promise((resolve) => {
      if (map.hasImage('broadcast-icon-past')) {
        resolve();
        return;
      }

      // Purple version of the broadcast icon
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="6" fill="#7c3aed"/>
          <path d="M15 15a12.7 12.7 0 0 0 0 18" stroke="#7c3aed" stroke-width="3.5" stroke-linecap="round" fill="none"/>
          <path d="M9 9a21.2 21.2 0 0 0 0 30" stroke="#7c3aed" stroke-width="3.5" stroke-linecap="round" fill="none"/>
          <path d="M33 15a12.7 12.7 0 0 1 0 18" stroke="#7c3aed" stroke-width="3.5" stroke-linecap="round" fill="none"/>
          <path d="M39 9a21.2 21.2 0 0 1 0 30" stroke="#7c3aed" stroke-width="3.5" stroke-linecap="round" fill="none"/>
        </svg>
      `;

      const base64 = 'data:image/svg+xml;base64,' + btoa(svg);
      const img = new Image(48, 48);
      img.onload = () => {
        if (!map.hasImage('broadcast-icon-past')) {
          map.addImage('broadcast-icon-past', img);
        }
        resolve();
      };
      img.onerror = () => {
        Logger.warn('[PastBroadcasts] Icon load failed');
        resolve();
      };
      img.src = base64;
    });
  },

  async _loadRecordings(map) {
    try {
      const res = await fetch(`${QBitmapConfig.api.base}/api/broadcast-recordings/public-map`);
      if (!res.ok) return;

      const data = await res.json();
      this.recordings = data.recordings || [];

      const geojson = {
        type: 'FeatureCollection',
        features: this.recordings.map(rec => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [rec.lng, rec.lat] },
          properties: {
            recordingId: rec.recording_id,
            displayName: rec.display_name || 'User',
            avatarUrl: rec.avatar_url || '',
            durationMs: rec.duration_ms,
            createdAt: rec.created_at,
            orientation: rec.orientation
          }
        }))
      };

      const source = map.getSource('past-broadcasts');
      if (source) {
        source.setData(geojson);
      }
    } catch (err) {
      Logger.warn('[PastBroadcasts] Failed to load recordings:', err);
    }
  },

  _openRecordingPopup(props, coordinates) {
    const map = AppState.map;
    if (!map) return;

    // Close existing recording popup
    if (this._currentPopup) {
      this._currentPopup.remove();
      this._currentPopup = null;
    }

    const recordingId = props.recordingId;
    const displayName = props.displayName || 'User';
    const durationMs = props.durationMs || 0;
    const durationSec = Math.round(durationMs / 1000);
    const min = Math.floor(durationSec / 60);
    const sec = durationSec % 60;
    const durationLabel = `${min}:${sec.toString().padStart(2, '0')}`;
    const createdAt = props.createdAt ? new Date(props.createdAt).toLocaleDateString('tr-TR') : '';
    const videoUrl = `${QBitmapConfig.api.base}/api/broadcast-recordings/${encodeURIComponent(recordingId)}/video`;

    const html = `
      <div class="broadcast-popup-content past-recording-popup">
        <div class="camera-popup-header">
          <div class="camera-popup-title">
            <div class="camera-title-line1">
              <span class="camera-id">${escapeHtml(displayName)}</span>
              <span class="past-rec-badge">${durationLabel} · ${createdAt}</span>
            </div>
          </div>
          <div class="camera-popup-buttons">
            <button class="cam-btn close-btn" title="Kapat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        <div class="camera-popup-body">
          <div class="camera-frame-container" style="aspect-ratio:16/9;background:#000;">
            <video controls playsinline preload="metadata" src="${videoUrl}"
                   style="width:100%;height:100%;display:block;"></video>
          </div>
        </div>
      </div>
    `;

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: 'none',
      className: 'camera-popup-wrapper',
      anchor: 'bottom'
    })
      .setLngLat(coordinates)
      .setHTML(html)
      .addTo(map);

    this._currentPopup = popup;

    // Bind close button
    setTimeout(() => {
      const el = popup.getElement();
      if (!el) return;
      const closeBtn = el.querySelector('.close-btn');
      if (closeBtn) closeBtn.onclick = () => {
        popup.remove();
        this._currentPopup = null;
      };
    }, 50);
  },

  _startRefresh(map) {
    this._stopRefresh();
    _refreshTimer = setInterval(() => {
      if (AppState.layers.pastBroadcastsVisible) {
        this._loadRecordings(map);
      }
    }, REFRESH_INTERVAL_MS);
  },

  _stopRefresh() {
    if (_refreshTimer) {
      clearInterval(_refreshTimer);
      _refreshTimer = null;
    }
  }
};

export { PastBroadcastLayer };
