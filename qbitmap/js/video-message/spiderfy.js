import { Logger } from '../utils.js';

const SPIDERFY_RADIUS_PX = 50;
const INSTANT_THRESHOLD = 5;
const AUTO_ZOOM_THRESHOLD = 21;

const VIDEO_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <circle cx="12" cy="12" r="10.5" fill="#e8a87c" stroke="white" stroke-width="1.5"/>
  <polygon points="10,7 10,17 18,12" fill="white"/>
</svg>`;

const PHOTO_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <circle cx="12" cy="12" r="10.5" fill="#5a9ad4" stroke="white" stroke-width="1.5"/>
  <rect x="7" y="8.5" width="10" height="8" rx="1.2" fill="white"/>
  <circle cx="12" cy="12.5" r="2.2" fill="#5a9ad4"/>
  <circle cx="12" cy="12.5" r="1" fill="white"/>
  <rect x="9" y="7.5" width="3" height="1.5" rx="0.5" fill="white"/>
</svg>`;

const Spiderfy = {
  _map: null,
  _videoMessage: null,
  // key = `${sourceId}:${clusterId}` → { markers, lineFeatures, sourceId, clusterId }
  _active: new Map(),
  _lastAutoZoom: null,
  _refreshTimer: null,
  _boundRefresh: null,
  _refreshing: false,

  setup(map, videoMessage) {
    this._map = map;
    this._videoMessage = videoMessage;

    // Debounced refresh on map idle, plus initial run.
    this._boundRefresh = () => {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => this._refreshAuto(), 150);
    };
    map.on('moveend', this._boundRefresh);
    map.on('zoomend', this._boundRefresh);
    // Source data updates can change which clusters exist.
    map.on('sourcedata', (e) => {
      if (e.sourceId === 'video-messages' || e.sourceId === 'photo-messages') {
        this._boundRefresh();
      }
    });
    setTimeout(() => this._refreshAuto(), 300);
  },

  // Manual cluster-click entry point. At zoom >= AUTO_ZOOM_THRESHOLD the
  // refreshAuto loop has likely already spiderfied this cluster — early
  // return prevents a duplicate. Below threshold, behave as before:
  // small clusters spiderfy, large ones zoom-in.
  async tryHandleClusterClick(map, sourceId, clusterId, lngLat) {
    const key = `${sourceId}:${clusterId}`;
    if (this._active.has(key)) return;

    const source = map.getSource(sourceId);
    if (!source) return;

    const [expansionZoom, leaves] = await Promise.all([
      this._getExpansionZoom(source, clusterId),
      this._getLeaves(source, clusterId)
    ]);

    if (!leaves.length) return;

    const maxZoom = map.getMaxZoom();
    const currentZoom = map.getZoom();
    const wouldExceedMax = expansionZoom == null || expansionZoom > maxZoom;
    const atMaxZoom = currentZoom >= maxZoom - 0.1;
    const shouldSpiderfy = leaves.length <= INSTANT_THRESHOLD || wouldExceedMax || atMaxZoom;

    if (shouldSpiderfy) {
      this._spiderfyOne(sourceId, clusterId, lngLat, leaves);
    } else {
      map.easeTo({ center: lngLat, zoom: expansionZoom });
    }
  },

  // Auto-spiderfy: at zoom >= threshold, every visible cluster fans out
  // automatically. This avoids click-target conflicts with the underlying
  // H3 ownership tooltip layer at high zoom.
  async _refreshAuto() {
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      const map = this._map;
      const zoom = map.getZoom();

      if (zoom < AUTO_ZOOM_THRESHOLD) {
        this._unspiderfyAll();
        this._lastAutoZoom = null;
        return;
      }

      // Zoom changed enough that pixel offsets are stale → rebuild all.
      const zoomChanged = this._lastAutoZoom == null
        || Math.abs(zoom - this._lastAutoZoom) > 0.05;
      if (zoomChanged) {
        this._unspiderfyAll();
        this._lastAutoZoom = zoom;
      }

      // Use querySourceFeatures (not queryRenderedFeatures) so that the
      // visibility filter we apply to hide spiderfied cluster icons
      // doesn't make those same clusters invisible to our own viewport
      // detection — that caused a flip-flop loop.
      const bounds = map.getBounds();
      const inBounds = (lng, lat) =>
        lng >= bounds.getWest() && lng <= bounds.getEast() &&
        lat >= bounds.getSouth() && lat <= bounds.getNorth();

      const collect = (sourceId) => {
        const list = [];
        const seen = new Set();
        try {
          const features = map.querySourceFeatures(sourceId, { filter: ['has', 'point_count'] });
          for (const f of features) {
            const cid = f.properties.cluster_id;
            if (seen.has(cid)) continue;
            seen.add(cid);
            const [lng, lat] = f.geometry.coordinates;
            if (!inBounds(lng, lat)) continue;
            list.push({ f, sourceId });
          }
        } catch (e) {
          Logger.warn('[Spiderfy] querySourceFeatures failed:', e);
        }
        return list;
      };

      const visibleClusters = [...collect('video-messages'), ...collect('photo-messages')];

      const visibleKeys = new Set();
      const newClusters = [];

      for (const { f, sourceId } of visibleClusters) {
        const clusterId = f.properties.cluster_id;
        const key = `${sourceId}:${clusterId}`;
        if (visibleKeys.has(key)) continue;
        visibleKeys.add(key);
        if (!this._active.has(key)) {
          newClusters.push({ sourceId, clusterId, lngLat: f.geometry.coordinates });
        }
      }

      // Drop clusters that are no longer visible.
      for (const key of [...this._active.keys()]) {
        if (!visibleKeys.has(key)) this._unspiderfyKey(key);
      }

      // Spiderfy newly visible clusters.
      for (const { sourceId, clusterId, lngLat } of newClusters) {
        const source = map.getSource(sourceId);
        if (!source) continue;
        const leaves = await this._getLeaves(source, clusterId);
        if (!leaves.length) continue;
        // Re-check viewport after async; user may have panned.
        if (map.getZoom() < AUTO_ZOOM_THRESHOLD) return;
        this._spiderfyOne(sourceId, clusterId, lngLat, leaves);
      }
    } finally {
      this._refreshing = false;
    }
  },

  _spiderfyOne(sourceId, clusterId, centerLngLat, leaves) {
    const map = this._map;
    const key = `${sourceId}:${clusterId}`;
    if (this._active.has(key)) this._unspiderfyKey(key);

    const center = Array.isArray(centerLngLat)
      ? { lng: centerLngLat[0], lat: centerLngLat[1] }
      : centerLngLat;
    const centerPx = map.project([center.lng, center.lat]);
    const angleStep = (2 * Math.PI) / leaves.length;
    const markers = [];

    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      const angle = i * angleStep - Math.PI / 2;
      const offsetX = Math.cos(angle) * SPIDERFY_RADIUS_PX;
      const offsetY = Math.sin(angle) * SPIDERFY_RADIUS_PX;
      const targetLngLat = map.unproject([centerPx.x + offsetX, centerPx.y + offsetY]);

      const el = this._createMarkerEl(leaf);
      el.style.transitionDelay = `${i * 25}ms`;
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(targetLngLat)
        .addTo(map);

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const realCoords = leaf.geometry.coordinates;
        const props = leaf.properties;
        // Close just this cluster's spiderfy; keep others active.
        this._unspiderfyKey(key);
        this._videoMessage.openMessagePopup(props, realCoords);
      });

      markers.push(marker);
    }

    this._active.set(key, { markers, sourceId, clusterId });
    this._updateClusterFilters();

    requestAnimationFrame(() => {
      for (const m of markers) {
        m.getElement().classList.add('vmsg-spiderfy-marker--in');
      }
    });
  },

  _unspiderfyKey(key) {
    const state = this._active.get(key);
    if (!state) return;
    for (const marker of state.markers) marker.remove();
    this._active.delete(key);
    this._updateClusterFilters();
  },

  _unspiderfyAll() {
    if (!this._active.size) return;
    for (const state of this._active.values()) {
      for (const marker of state.markers) marker.remove();
    }
    this._active.clear();
    this._updateClusterFilters();
  },

  // Hide the underlying cluster icon (circle + count badge) for any cluster
  // we've spiderfied. When the spiderfy closes (zoom-out below threshold,
  // pan, or marker click), the cluster_id drops out of the exclusion list
  // and the original cluster pin becomes visible again.
  _updateClusterFilters() {
    const map = this._map;
    const videoIds = [];
    const photoIds = [];
    for (const state of this._active.values()) {
      if (state.sourceId === 'video-messages') videoIds.push(state.clusterId);
      else if (state.sourceId === 'photo-messages') photoIds.push(state.clusterId);
    }
    const build = (ids) => ids.length === 0
      ? ['has', 'point_count']
      : ['all', ['has', 'point_count'], ['!', ['in', ['get', 'cluster_id'], ['literal', ids]]]];

    const videoFilter = build(videoIds);
    const photoFilter = build(photoIds);

    if (map.getLayer('video-message-clusters')) map.setFilter('video-message-clusters', videoFilter);
    if (map.getLayer('video-message-cluster-count')) map.setFilter('video-message-cluster-count', videoFilter);
    if (map.getLayer('photo-message-clusters')) map.setFilter('photo-message-clusters', photoFilter);
    if (map.getLayer('photo-message-cluster-count')) map.setFilter('photo-message-cluster-count', photoFilter);
  },

  _createMarkerEl(leaf) {
    const props = leaf.properties || {};
    const isPhoto = props.mediaType === 'photo'
      || (props.messageId || '').startsWith('pmsg_');

    // Outer div: maplibregl.Marker writes its own translate3d transform
    // here for positioning, so animations must live on an inner element.
    const outer = document.createElement('div');
    outer.className = 'vmsg-spiderfy-marker';
    const inner = document.createElement('div');
    inner.className = 'vmsg-spiderfy-marker-inner';
    inner.innerHTML = isPhoto ? PHOTO_ICON_SVG : VIDEO_ICON_SVG;
    outer.appendChild(inner);
    return outer;
  },

  async _getExpansionZoom(source, clusterId) {
    try {
      return await source.getClusterExpansionZoom(clusterId);
    } catch (e) {
      Logger.warn('[Spiderfy] expansion zoom error:', e);
      return null;
    }
  },

  async _getLeaves(source, clusterId) {
    try {
      const leaves = await source.getClusterLeaves(clusterId, Infinity, 0);
      return leaves || [];
    } catch (e) {
      Logger.warn('[Spiderfy] leaves error:', e);
      return [];
    }
  }
};

export { Spiderfy };
