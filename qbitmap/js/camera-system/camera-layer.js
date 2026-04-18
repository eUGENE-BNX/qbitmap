import { Logger } from '../utils.js';
import { layers } from '../state.js';

/**
 * QBitmap Camera System - Camera Layer Module
 * Handles map layer, icons, and interactions
 */

// Pre-computed SVG icon cache (50-80ms faster initialization)
const SVG_ICON_CACHE = {};

// Pre-generate all SVG icons at module load time
(function initIconCache() {
  const generateCameraIconSVG = (bodyColor) => `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24">
      <rect x="2" y="6" width="14" height="12" rx="2.5" fill="${bodyColor}"/>
      <polygon points="18,8 23,5 23,19 18,16" fill="${bodyColor}"/>
    </svg>
  `;

  const generateRecBadgeSVG = (bodyColor, isDim = false) => `
    <svg xmlns="http://www.w3.org/2000/svg" width="56" height="32" viewBox="0 0 56 32">
      <rect x="2" y="8" width="16" height="14" rx="2.5" fill="${bodyColor}"/>
      <polygon points="20,10 26,6 26,24 20,20" fill="${bodyColor}"/>
      <rect x="28" y="4" width="24" height="14" rx="3" fill="${isDim ? '#660000' : '#cc0000'}"${isDim ? ' opacity="0.5"' : ''}/>
      <text x="40" y="14.5" font-size="10" font-weight="bold" fill="white" text-anchor="middle" font-family="Arial, sans-serif"${isDim ? ' opacity="0.5"' : ''}>REC</text>
    </svg>
  `;

  // Pre-compute all base64 encoded SVGs
  SVG_ICON_CACHE['camera-icon-normal'] = 'data:image/svg+xml;base64,' + btoa(generateCameraIconSVG('#1a1a1a'));
  SVG_ICON_CACHE['camera-icon-monitoring'] = 'data:image/svg+xml;base64,' + btoa(generateCameraIconSVG('#2563eb'));
  SVG_ICON_CACHE['camera-icon-alarm'] = 'data:image/svg+xml;base64,' + btoa(generateCameraIconSVG('#dc2626'));
  SVG_ICON_CACHE['camera-icon-shared'] = 'data:image/svg+xml;base64,' + btoa(generateCameraIconSVG('#f97316'));
  SVG_ICON_CACHE['camera-icon-city'] = 'data:image/svg+xml;base64,' + btoa(generateCameraIconSVG('#0ea5e9'));
  SVG_ICON_CACHE['camera-icon-recording'] = 'data:image/svg+xml;base64,' + btoa(generateRecBadgeSVG('#1a1a1a', false));
  SVG_ICON_CACHE['camera-icon-recording-dim'] = 'data:image/svg+xml;base64,' + btoa(generateRecBadgeSVG('#1a1a1a', true));
})();

const CameraLayerMixin = {
  /**
   * Add camera layer to map
   */
  addCameraLayer() {
    const validCameras = this.cameras.filter(c => c.lng && c.lat);
    if (validCameras.length === 0) return;

    // Store GeoJSON in state for icon updates
    this.cameraGeojson = {
      type: 'FeatureCollection',
      features: validCameras.map(camera => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [camera.lng, camera.lat] },
        properties: {
          device_id: camera.device_id,
          name: camera.name || camera.device_id,
          state: camera.isShared ? 'shared' : 'normal', // shared/normal/monitoring/alarm
          isShared: !!camera.isShared,
          camera_type: camera.camera_type || 'whep'
        }
      }))
    };

    // Load three icon variants
    this.loadCameraIcons(() => {
      // [MI-5] Clustering for scalability with many cameras
      this.map.addSource('cameras', {
        type: 'geojson',
        data: this.cameraGeojson,
        cluster: true,
        clusterMaxZoom: 17,
        clusterRadius: 60
      });

      // Cluster circle layer
      this.map.addLayer({
        id: 'camera-clusters',
        type: 'circle',
        source: 'cameras',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'], '#51bbd6', 10, '#f1f075', 30, '#f28cb1'],
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            2, ['step', ['get', 'point_count'], 6, 10, 8, 30, 10],
            5, ['step', ['get', 'point_count'], 10, 10, 14, 30, 18],
            8, ['step', ['get', 'point_count'], 18, 10, 24, 30, 30]
          ],
          'circle-opacity': 0.75,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
          'circle-stroke-opacity': 0.85
        }
      });

      // Cluster count text layer
      this.map.addLayer({
        id: 'camera-cluster-count',
        type: 'symbol',
        source: 'cameras',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': '{point_count_abbreviated}',
          'text-font': ['Noto Sans Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 8, 5, 10, 8, 13]
        }
      });

      // Individual camera icons (unclustered)
      this.map.addLayer({
        id: 'cameras',
        type: 'symbol',
        source: 'cameras',
        filter: ['!', ['has', 'point_count']],
        layout: {
          'icon-image': [
            'case',
            ['==', ['get', 'camera_type'], 'city'],
            'camera-icon-city',
            ['all', ['==', ['get', 'state'], 'recording'], ['==', ['get', 'recBlink'], true]],
            'camera-icon-recording',
            ['all', ['==', ['get', 'state'], 'recording'], ['==', ['get', 'recBlink'], false]],
            'camera-icon-recording-dim',
            ['match', ['get', 'state'],
              'alarm', 'camera-icon-alarm',
              'monitoring', 'camera-icon-monitoring',
              'shared', 'camera-icon-shared',
              'camera-icon-normal'
            ]
          ],
          'icon-size': 0.6,
          'icon-allow-overlap': true
        }
      });

      this.setupInteractions();

      // Initial icon update
      this.updateAllCameraIcons();
    });
  },

  /**
   * Load camera icon variants (uses pre-computed cache for performance)
   */
  loadCameraIcons(callback) {
    const icons = {
      'camera-icon-normal': { width: 28, height: 28 },
      'camera-icon-monitoring': { width: 28, height: 28 },
      'camera-icon-alarm': { width: 28, height: 28 },
      'camera-icon-shared': { width: 28, height: 28 },
      'camera-icon-city': { width: 28, height: 28 },
      'camera-icon-recording': { width: 56, height: 32 },
      'camera-icon-recording-dim': { width: 56, height: 32 }
    };

    let loaded = 0;
    const total = Object.keys(icons).length;

    Object.entries(icons).forEach(([name, iconData]) => {
      const img = new Image(iconData.width, iconData.height);
      img.onload = () => {
        this.map.addImage(name, img);
        loaded++;
        if (loaded === total) callback();
      };
      // Use pre-computed cached base64 SVG
      img.src = SVG_ICON_CACHE[name];
    });
  },

  /**
   * Generate camera icon SVG with colors
   */
  getCameraIconSVG(bodyColor, lensColor) {
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24">
        <path d="M4 8 L4 18 C4 19 5 20 6 20 L18 20 C19 20 20 19 20 18 L20 8 C20 7 19 6 18 6 L15 6 L13 4 L11 4 L9 6 L6 6 C5 6 4 7 4 8 Z" fill="${bodyColor}"/>
        <circle cx="12" cy="13" r="3.5" fill="${lensColor}"/>
        <circle cx="12" cy="13" r="2" fill="${bodyColor}"/>
      </svg>
    `;
  },

  /**
   * Generate camera icon SVG with REC badge (bright - for blink on)
   */
  getCameraIconWithRecBadge(bodyColor, lensColor) {
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="56" height="32" viewBox="0 0 56 32">
        <path d="M4 10 L4 22 C4 23.5 5.5 25 7 25 L21 25 C22.5 25 24 23.5 24 22 L24 10 C24 8.5 22.5 7 21 7 L17 7 L15 4 L13 4 L11 7 L7 7 C5.5 7 4 8.5 4 10 Z" fill="${bodyColor}"/>
        <circle cx="14" cy="16" r="4.5" fill="${lensColor}"/>
        <circle cx="14" cy="16" r="2.5" fill="${bodyColor}"/>
        <rect x="28" y="4" width="24" height="14" rx="3" fill="#cc0000"/>
        <text x="40" y="14.5" font-size="10" font-weight="bold" fill="white" text-anchor="middle" font-family="Arial, sans-serif">REC</text>
      </svg>
    `;
  },

  /**
   * Generate camera icon SVG with REC badge (dim - for blink off)
   */
  getCameraIconWithRecBadgeDim(bodyColor, lensColor) {
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="56" height="32" viewBox="0 0 56 32">
        <path d="M4 10 L4 22 C4 23.5 5.5 25 7 25 L21 25 C22.5 25 24 23.5 24 22 L24 10 C24 8.5 22.5 7 21 7 L17 7 L15 4 L13 4 L11 7 L7 7 C5.5 7 4 8.5 4 10 Z" fill="${bodyColor}"/>
        <circle cx="14" cy="16" r="4.5" fill="${lensColor}"/>
        <circle cx="14" cy="16" r="2.5" fill="${bodyColor}"/>
        <rect x="28" y="4" width="24" height="14" rx="3" fill="#660000" opacity="0.5"/>
        <text x="40" y="14.5" font-size="10" font-weight="bold" fill="white" text-anchor="middle" font-family="Arial, sans-serif" opacity="0.5">REC</text>
      </svg>
    `;
  },

  /**
   * Update single camera icon based on state
   */
  updateCameraIcon(deviceId) {
    const source = this.map?.getSource('cameras');
    if (!source) {
      Logger.warn('[CameraLayer] No map source found');
      return;
    }

    if (!this.cameraGeojson || !this.cameraGeojson.features) {
      Logger.warn('[CameraLayer] No cameraGeojson data');
      return;
    }

    const feature = this.cameraGeojson.features.find(f => f.properties.device_id === deviceId);

    if (feature) {
      // Determine state: alarm > recording > monitoring > shared > normal
      let newState = 'normal';
      if (this.activeAlarms.has(deviceId)) {
        newState = 'alarm';
      } else if (this.recordingCameras.has(deviceId)) {
        newState = 'recording';
      } else if (this.aiMonitoring.has(deviceId) && this.aiMonitoring.get(deviceId).enabled) {
        newState = 'monitoring';
      } else if (feature.properties.isShared) {
        newState = 'shared';
      }

      const oldState = feature.properties.state;
      feature.properties.state = newState;

      // Recording state için blink property ekle
      if (newState === 'recording') {
        feature.properties.recBlink = true;
      }

      source.setData(this._getFilteredGeojson());

      Logger.log(`[CameraLayer] Icon updated: ${deviceId} ${oldState} → ${newState}`);
    } else {
      Logger.warn(`[CameraLayer] Feature not found for deviceId: ${deviceId}`);
    }
  },

  /**
   * Update all camera icons (called on initial load)
   */
  updateAllCameraIcons() {
    const source = this.map?.getSource('cameras');
    if (!source) return;

    if (!this.cameraGeojson || !this.cameraGeojson.features) return;

    this.cameraGeojson.features.forEach(feature => {
      const deviceId = feature.properties.device_id;

      // Determine state: alarm > recording > monitoring > shared > normal
      if (this.activeAlarms.has(deviceId)) {
        feature.properties.state = 'alarm';
      } else if (this.recordingCameras.has(deviceId)) {
        feature.properties.state = 'recording';
        feature.properties.recBlink = true;
      } else if (this.aiMonitoring.has(deviceId) && this.aiMonitoring.get(deviceId).enabled) {
        feature.properties.state = 'monitoring';
      } else if (feature.properties.isShared) {
        feature.properties.state = 'shared';
      } else {
        feature.properties.state = 'normal';
      }
    });

    source.setData(this.cameraGeojson);
  },

  /**
   * Get filtered GeoJSON based on camera type visibility
   */
  _getFilteredGeojson() {
    if (!this.cameraGeojson) return this.cameraGeojson;
    return {
      type: 'FeatureCollection',
      features: this.cameraGeojson.features.filter(f => {
        const type = f.properties.camera_type;
        if (type === 'city') return layers.cityCamerasVisible !== false;
        return layers.userCamerasVisible !== false;
      })
    };
  },

  /**
   * Filter camera layer by type visibility (city/user cameras toggle)
   */
  updateCameraFilter() {
    const source = this.map?.getSource('cameras');
    if (!source || !this.cameraGeojson) return;
    source.setData(this._getFilteredGeojson());
  },

  /**
   * Setup map interactions
   */
  setupInteractions() {
    // [MI-5] Cluster click - zoom into cluster
    this.map.on('click', 'camera-clusters', (e) => {
      const features = this.map.queryRenderedFeatures(e.point, { layers: ['camera-clusters'] });
      if (!features.length) return;
      const clusterId = features[0].properties.cluster_id;
      this.map.getSource('cameras').getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err) return;
        this.map.easeTo({ center: features[0].geometry.coordinates, zoom });
      });
    });

    this.map.on('mouseenter', 'camera-clusters', () => {
      this.map.getCanvas().style.cursor = 'pointer';
    });
    this.map.on('mouseleave', 'camera-clusters', () => {
      this.map.getCanvas().style.cursor = '';
    });

    this.map.on('mouseenter', 'cameras', () => {
      this.map.getCanvas().style.cursor = 'pointer';
    });

    this.map.on('mouseleave', 'cameras', () => {
      this.map.getCanvas().style.cursor = '';
    });

    this.map.on('click', 'cameras', (e) => {
      if (e.features && e.features.length > 0) {
        const feature = e.features[0];
        const deviceId = feature.properties.device_id;
        const coordinates = feature.geometry.coordinates.slice();
        const camera = this.cameras.find(c => c.device_id === deviceId);

        // Adjust for world wrap
        while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
          coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
        }

        if (camera) this.openCameraPopup(camera, coordinates);
      }
    });
  },

  /**
   * Start recording blink animation for map icons
   */
  startRecordingBlink() {
    // Zaten çalışıyorsa başlatma
    if (this.recordingBlinkInterval) return;

    let isOn = true;
    this.recordingBlinkInterval = setInterval(() => {
      isOn = !isOn;

      // Kayıtta olan kamera yoksa blink'i durdur
      if (this.recordingCameras.size === 0) {
        this.stopRecordingBlink();
        return;
      }

      // GeoJSON'daki kayıtta olan kameraların recBlink property'sini toggle et
      const source = this.map?.getSource('cameras');
      if (source && this.cameraGeojson && this.cameraGeojson.features) {
        let hasChanges = false;

        this.cameraGeojson.features.forEach(f => {
          if (f.properties.state === 'recording') {
            f.properties.recBlink = isOn;
            hasChanges = true;
          }
        });

        if (hasChanges) {
          source.setData(this._getFilteredGeojson());
        }
      }
    }, 500); // 500ms blink interval

    Logger.log('[CameraLayer] Recording blink started');
  },

  /**
   * Stop recording blink animation
   */
  stopRecordingBlink() {
    if (this.recordingBlinkInterval) {
      clearInterval(this.recordingBlinkInterval);
      this.recordingBlinkInterval = null;
      Logger.log('[CameraLayer] Recording blink stopped');
    }
  }
};

export { CameraLayerMixin };
