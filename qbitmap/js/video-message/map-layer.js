import { QBitmapConfig } from "../config.js";
import { Logger, escapeHtml } from "../utils.js";
import { AuthSystem } from "../auth.js";
import * as AppState from '../state.js';

const MapLayerMixin = {
  initMapLayer() {
    if (AppState.map && AppState.map.isStyleLoaded()) {
      this.addVideoMessageLayer(AppState.map);
    } else if (AppState.map) {
      AppState.map.on('load', () => this.addVideoMessageLayer(AppState.map));
    } else {
      setTimeout(() => this.initMapLayer(), 500);
    }
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
        map.addSource('video-messages', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          cluster: true,
          clusterMaxZoom: 17,
          clusterRadius: 60
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
          clusterMaxZoom: 17,
          clusterRadius: 60
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
            'icon-allow-overlap': true
          }
        });

        // ---- Event handlers for video layers ----
        map.on('click', 'video-message-clusters', (e) => {
          const features = map.queryRenderedFeatures(e.point, { layers: ['video-message-clusters'] });
          if (!features.length) return;
          const clusterId = features[0].properties.cluster_id;
          map.getSource('video-messages').getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err) return;
            map.easeTo({ center: features[0].geometry.coordinates, zoom });
          });
        });

        map.on('click', 'video-messages', (e) => {
          if (this.isSelectingLocation) return;
          this._handleMessageClick(e, map);
        });

        // ---- Event handlers for photo layers ----
        map.on('click', 'photo-message-clusters', (e) => {
          const features = map.queryRenderedFeatures(e.point, { layers: ['photo-message-clusters'] });
          if (!features.length) return;
          const clusterId = features[0].properties.cluster_id;
          map.getSource('photo-messages').getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err) return;
            map.easeTo({ center: features[0].geometry.coordinates, zoom });
          });
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
        tags: JSON.stringify(m.tags || []),
        thumbnailPath: m.thumbnail_path || '',
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

    // Wait for map to be ready, then fly to location and open popup
    const openMsg = () => {
      AppState.map.flyTo({ center: [msg.lng, msg.lat], zoom: Math.max(AppState.map.getZoom(), 16) });
      setTimeout(() => {
        this.openMessagePopup({
          messageId: msg.message_id,
          senderId: msg.sender_id,
          senderName: msg.sender_name,
          senderAvatar: msg.sender_avatar,
          recipientId: msg.recipient_id,
          durationMs: msg.duration_ms,
          mimeType: msg.mime_type,
          mediaType: msg.media_type || 'video',
          isRead: msg.is_read,
          createdAt: msg.created_at,
          viewCount: msg.view_count || 0,
          likeCount: msg.like_count || 0,
          liked: msg.liked ? 'true' : 'false',
          description: msg.description || '',
          aiDescription: msg.ai_description || '',
          tags: JSON.stringify(msg.tags || []),
          thumbnailPath: msg.thumbnail_path || '',
          placeName: msg.place_name || ''
        }, [msg.lng, msg.lat]);
      }, 1500);
    };

    if (AppState.map && AppState.map.isStyleLoaded()) {
      openMsg();
    } else if (AppState.map) {
      AppState.map.on('load', openMsg);
    } else {
      // Map not yet created, wait for it
      const waitForMap = setInterval(() => {
        if (AppState.map && AppState.map.isStyleLoaded()) {
          clearInterval(waitForMap);
          openMsg();
        }
      }, 500);
      // Give up after 10 seconds
      setTimeout(() => clearInterval(waitForMap), 10000);
    }
  },
};

export { MapLayerMixin };
