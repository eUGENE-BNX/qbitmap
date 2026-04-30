import { QBitmapConfig } from "../config.js";
import { Logger, escapeHtml } from "../utils.js";
import { AuthSystem } from "../auth.js";
import * as AppState from '../state.js';
import { buildMessagePopupProps } from './props.js';
import { Spiderfy } from './spiderfy.js';

const MapLayerMixin = {
  initMapLayer() {
    AppState.mapReady.then(map => this.addVideoMessageLayer(map));
  },

  addVideoMessageLayer(map) {
    if (map.getSource('video-messages')) {
      this.updateMapLayer();
      return;
    }

    this.loadVideoMessageIcon(map, () => {
      this.loadPhotoMessageIcon(map, () => {
        if (map.getSource('video-messages')) {
          this.updateMapLayer();
          return;
        }

        const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

        // ---- Video messages source & layers ----
        // clusterMaxZoom extended to 22 + tighter radius (35px) so
        // genuinely-overlapping markers (e.g. two cafe tables) cluster
        // even at the highest zoom and can be spiderfied. Source maxzoom
        // must be strictly greater than clusterMaxZoom (default is 18,
        // which silently breaks supercluster's index).
        map.addSource('video-messages', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          cluster: true,
          clusterMaxZoom: 22,
          clusterRadius: 35,
          maxzoom: 24
        });

        map.addLayer({
          id: 'video-message-clusters',
          type: 'circle',
          source: 'video-messages',
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': ['step', ['get', 'point_count'], '#e8a87c', 10, '#d4946a', 30, '#c07f58'],
            'circle-radius': [
              'interpolate', ['linear'], ['zoom'],
              2, ['step', ['get', 'point_count'], 5, 10, 7, 30, 9],
              5, ['step', ['get', 'point_count'], 8, 10, 12, 30, 16],
              8, ['step', ['get', 'point_count'], 14, 10, 18, 30, 22]
            ],
            'circle-opacity': 0.75,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
            'circle-stroke-opacity': 0.85
          }
        });

        map.addLayer({
          id: 'video-message-cluster-count',
          type: 'symbol',
          source: 'video-messages',
          filter: ['has', 'point_count'],
          layout: {
            'text-field': '{point_count_abbreviated}',
            'text-font': ['Noto Sans Medium'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 2, 7, 5, 9, 8, 12]
          }
        });

        map.addLayer({
          id: 'video-messages',
          type: 'symbol',
          source: 'video-messages',
          filter: ['!', ['has', 'point_count']],
          layout: {
            'icon-image': 'video-message-icon',
            'icon-size': ['interpolate', ['linear'], ['zoom'],
              0, isMobile ? 0.35 : 0.4,
              19, isMobile ? 0.35 : 0.4,
              20, isMobile ? 0.3 : 0.35,
              21, isMobile ? 0.25 : 0.3,
              22, isMobile ? 0.24 : 0.3
            ],
            'icon-allow-overlap': true
          }
        });

        // ---- Photo messages source & layers ----
        map.addSource('photo-messages', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          cluster: true,
          clusterMaxZoom: 22,
          clusterRadius: 35,
          maxzoom: 24
        });

        map.addLayer({
          id: 'photo-message-clusters',
          type: 'circle',
          source: 'photo-messages',
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': ['step', ['get', 'point_count'], '#7cb3e8', 10, '#5a9ad4', 30, '#3d7ebf'],
            'circle-radius': [
              'interpolate', ['linear'], ['zoom'],
              2, ['step', ['get', 'point_count'], 5, 10, 7, 30, 9],
              5, ['step', ['get', 'point_count'], 8, 10, 12, 30, 16],
              8, ['step', ['get', 'point_count'], 14, 10, 18, 30, 22]
            ],
            'circle-opacity': 0.75,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
            'circle-stroke-opacity': 0.85
          }
        });

        map.addLayer({
          id: 'photo-message-cluster-count',
          type: 'symbol',
          source: 'photo-messages',
          filter: ['has', 'point_count'],
          layout: {
            'text-field': '{point_count_abbreviated}',
            'text-font': ['Noto Sans Medium'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 2, 7, 5, 9, 8, 12]
          }
        });

        map.addLayer({
          id: 'photo-messages',
          type: 'symbol',
          source: 'photo-messages',
          filter: ['!', ['has', 'point_count']],
          layout: {
            'icon-image': 'photo-message-icon',
            'icon-size': ['interpolate', ['linear'], ['zoom'],
              0, isMobile ? 0.35 : 0.4,
              19, isMobile ? 0.35 : 0.4,
              20, isMobile ? 0.3 : 0.35,
              21, isMobile ? 0.25 : 0.3,
              22, isMobile ? 0.24 : 0.3
            ],
            'icon-allow-overlap': true,
            'icon-offset': [10, -10]
          }
        });

        // ---- Spiderfy setup (handles overlap when zoom-to-expand can't
        // separate the cluster, e.g. two messages from the same cafe table) ----
        Spiderfy.setup(map, this);

        // ---- Event handlers for video layers ----
        map.on('click', 'video-message-clusters', (e) => {
          const f = e.features && e.features[0];
          if (!f) return;
          Spiderfy.tryHandleClusterClick(map, 'video-messages', f.properties.cluster_id, f.geometry.coordinates);
        });

        map.on('click', 'video-messages', (e) => {
          if (this.isSelectingLocation) return;
          this._handleMessageClick(e, map);
        });

        // ---- Event handlers for photo layers ----
        map.on('click', 'photo-message-clusters', (e) => {
          const f = e.features && e.features[0];
          if (!f) return;
          Spiderfy.tryHandleClusterClick(map, 'photo-messages', f.properties.cluster_id, f.geometry.coordinates);
        });

        map.on('click', 'photo-messages', (e) => {
          if (this.isSelectingLocation) return;
          this._handleMessageClick(e, map);
        });

        // ---- Cursor handlers ----
        map.on('mouseenter', 'video-message-clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'video-message-clusters', () => { map.getCanvas().style.cursor = ''; });
        map.on('mouseenter', 'video-messages', () => { if (!this.isSelectingLocation) map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'video-messages', () => { if (!this.isSelectingLocation) map.getCanvas().style.cursor = ''; });
        map.on('mouseenter', 'photo-message-clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'photo-message-clusters', () => { map.getCanvas().style.cursor = ''; });
        map.on('mouseenter', 'photo-messages', () => { if (!this.isSelectingLocation) map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'photo-messages', () => { if (!this.isSelectingLocation) map.getCanvas().style.cursor = ''; });

        this.updateMapLayer();
      });
    });
  },

  loadVideoMessageIcon(map, callback) {
    const size = 48;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10.5" fill="#e8a87c" stroke="white" stroke-width="1.5"/>
        <polygon points="10,7 10,17 18,12" fill="white"/>
      </svg>
    `;

    const base64 = 'data:image/svg+xml;base64,' + btoa(svg);
    const img = new Image(size, size);
    img.onload = () => {
      if (!map.hasImage('video-message-icon')) {
        map.addImage('video-message-icon', img);
      }
      callback();
    };
    img.onerror = () => {
      Logger.warn('[VideoMessage] Icon load failed');
      callback();
    };
    img.src = base64;
  },

  loadPhotoMessageIcon(map, callback) {
    const size = 48;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10.5" fill="#5a9ad4" stroke="white" stroke-width="1.5"/>
        <rect x="7" y="8.5" width="10" height="8" rx="1.2" fill="white"/>
        <circle cx="12" cy="12.5" r="2.2" fill="#5a9ad4"/>
        <circle cx="12" cy="12.5" r="1" fill="white"/>
        <rect x="9" y="7.5" width="3" height="1.5" rx="0.5" fill="white"/>
      </svg>
    `;

    const base64 = 'data:image/svg+xml;base64,' + btoa(svg);
    const img = new Image(size, size);
    img.onload = () => {
      if (!map.hasImage('photo-message-icon')) {
        map.addImage('photo-message-icon', img);
      }
      callback();
    };
    img.onerror = () => {
      Logger.warn('[VideoMessage] Photo icon load failed');
      callback();
    };
    img.src = base64;
  },

  _handleMessageClick(e, map) {
    if (!e.features || !e.features.length) return;

    const feature = e.features[0];
    const coords = feature.geometry.coordinates.slice();
    while (Math.abs(e.lngLat.lng - coords[0]) > 180) {
      coords[0] += e.lngLat.lng > coords[0] ? 360 : -360;
    }
    this.openMessagePopup(feature.properties, coords);
  },

  updateMapLayer() {
    const map = AppState.map;
    if (!map) return;

    const allMessages = Array.from(this.videoMessages.values());
    const toFeature = (m) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [m.lng, m.lat] },
      properties: {
        messageId: m.message_id,
        senderId: m.sender_id,
        senderName: m.sender_name || '',
        senderAvatar: m.sender_avatar || '',
        recipientId: m.recipient_id,
        durationMs: m.duration_ms,
        mimeType: m.mime_type,
        mediaType: m.media_type || (m.message_id.startsWith('pmsg_') ? 'photo' : 'video'),
        isRead: m.is_read,
        createdAt: m.created_at,
        viewCount: m.view_count || 0,
        likeCount: m.like_count || 0,
        liked: m.liked ? 'true' : 'false',
        description: m.description || '',
        aiDescription: m.ai_description || '',
        aiDescriptionLang: m.ai_description_lang || '',
        tags: JSON.stringify(m.tags || []),
        thumbnailPath: m.thumbnail_path || '',
        photos: JSON.stringify(m.photos || []),
        placeName: m.place_name || ''
      }
    });

    const videoFeatures = allMessages.filter(m => (m.media_type || 'video') === 'video' && !m.message_id.startsWith('pmsg_')).map(toFeature);
    const photoFeatures = allMessages.filter(m => m.media_type === 'photo' || m.message_id.startsWith('pmsg_')).map(toFeature);

    const videoSource = map.getSource('video-messages');
    if (videoSource) videoSource.setData({ type: 'FeatureCollection', features: videoFeatures });

    const photoSource = map.getSource('photo-messages');
    if (photoSource) photoSource.setData({ type: 'FeatureCollection', features: photoFeatures });
  },

  // ==================== LOAD MESSAGES ====================

  async loadVideoMessages() {
    try {
      const response = await fetch(`${this.apiBase}`, {
        credentials: 'include'
      });
      if (!response.ok) return;

      const data = await response.json();
      this.videoMessages.clear();
      for (const m of (data.messages || [])) {
        this.videoMessages.set(m.message_id, m);
      }
      this.updateMapLayer();
    } catch (e) {
      Logger.warn('[VideoMessage] Failed to load messages');
    }
  },

  // ==================== DEEP LINK ====================

  async handleDeepLink() {
    const params = new URLSearchParams(window.location.search);
    const vmsgId = params.get('vmsg');
    if (!vmsgId) return;

    // Clean URL
    const url = new URL(window.location);
    url.searchParams.delete('vmsg');
    window.history.replaceState({}, '', url.pathname + url.search);

    // Check if already loaded
    let msg = this.videoMessages.get(vmsgId);

    // If not in local cache, fetch from API
    if (!msg) {
      try {
        const response = await fetch(`${this.apiBase}/${encodeURIComponent(vmsgId)}`, {
          credentials: 'include'
        });
        if (!response.ok) return;
        const data = await response.json();
        msg = data.message;
        if (msg) {
          this.videoMessages.set(msg.message_id, msg);
          this.updateMapLayer();
        }
      } catch (e) {
        Logger.warn('[VideoMessage] Deep link message fetch failed');
        return;
      }
    }

    if (!msg) return;

    AppState.mapReady.then(map => {
      map.flyTo({ center: [msg.lng, msg.lat], zoom: Math.max(map.getZoom(), 16) });
      setTimeout(() => {
        this.openMessagePopup(buildMessagePopupProps(msg), [msg.lng, msg.lat]);
      }, 1500);
    });
  },
};

export { MapLayerMixin };
