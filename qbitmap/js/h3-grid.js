import { QBitmapConfig } from './config.js';
import { Logger, escapeHtml } from './utils.js';
import { Analytics } from './analytics.js';
import { H3TronTrails } from './h3-tron-trails.js';
import { loadDeckAndH3 } from './vendor-loader.js';

/**
 * QBitmap H3 Hexagonal Grid Layer
 * Renders a semi-transparent hexagonal grid overlay using deck.gl H3HexagonLayer on MapLibre
 * Computes hexagons client-side using h3-js (no API call needed for grid display)
 * Uses interleaved mode to render below camera icons, messages, vehicles etc.
 * Includes Digital Land Ownership layer showing owned cells with per-user pastel colors
 */
const H3Grid = {
  _map: null,
  _overlay: null,
  _enabled: false,
  _currentResolution: null,
  _debounceTimer: null,
  _hexagonData: [],
  _ownershipData: [],
  _ownershipMap: null,
  _fogRingData: [],
  _tooltip: null,
  _ownershipFetchController: null,
  _userColorMap: new Map(),

  // [PERF-06] Viewport memoization.
  // _lastPaddedBounds is the padded {swLat, swLng, neLat, neLng} that drove
  // the previous polygonToCells + ownership fetch. _lastResolution is the
  // H3 resolution that was current at the time. If a viewport-change event
  // fires but the new (unpadded) view is fully inside that cached padded
  // region AND the resolution is unchanged, the cached cells still cover
  // the visible area and we can skip polygonToCells + the ownership fetch
  // entirely. Typical small pans (<15% of the viewport) fall into this
  // fast path and do zero work.
  _lastPaddedBounds: null,
  _lastResolution: null,

  // Predefined pastel color palette - each user gets a unique color
  _PASTEL_COLORS: [
    { fill: [255, 175, 110, 60], line: [230, 140, 70, 90],  highlight: [255, 155, 80, 130],  hex: '#ffaf6e' },  // orange
    { fill: [130, 200, 255, 60], line: [80, 160, 220, 90],   highlight: [100, 180, 255, 130], hex: '#82c8ff' },  // blue
    { fill: [170, 230, 150, 60], line: [120, 190, 100, 90],  highlight: [150, 220, 130, 130], hex: '#aae696' },  // green
    { fill: [230, 150, 230, 60], line: [190, 110, 190, 90],  highlight: [220, 130, 220, 130], hex: '#e696e6' },  // pink/magenta
    { fill: [255, 220, 120, 60], line: [220, 185, 80, 90],   highlight: [255, 210, 90, 130],  hex: '#ffdc78' },  // yellow
    { fill: [150, 220, 220, 60], line: [100, 180, 180, 90],  highlight: [130, 210, 210, 130], hex: '#96dcdc' },  // teal
    { fill: [255, 150, 150, 60], line: [220, 110, 110, 90],  highlight: [245, 130, 130, 130], hex: '#ff9696' },  // red
    { fill: [180, 170, 255, 60], line: [140, 130, 220, 90],  highlight: [165, 155, 245, 130], hex: '#b4aaff' },  // lavender
    { fill: [255, 195, 170, 60], line: [220, 155, 130, 90],  highlight: [245, 175, 150, 130], hex: '#ffc3aa' },  // salmon
    { fill: [170, 230, 200, 60], line: [120, 190, 160, 90],  highlight: [150, 220, 185, 130], hex: '#aae6c8' },  // mint
    { fill: [220, 200, 150, 60], line: [185, 165, 110, 90],  highlight: [210, 190, 130, 130], hex: '#dcc896' },  // khaki
    { fill: [200, 180, 220, 60], line: [160, 140, 185, 90],  highlight: [190, 165, 210, 130], hex: '#c8b4dc' },  // mauve
  ],

  _getUserColor(userId) {
    if (this._userColorMap.has(userId)) return this._userColorMap.get(userId);

    // Deterministic hash of userId → stable palette index
    let hash = 0;
    const str = String(userId);
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(hash) % this._PASTEL_COLORS.length;
    const color = this._PASTEL_COLORS[idx];
    this._userColorMap.set(userId, color);
    return color;
  },

  _FOG_RINGS: 3,
  _FOG_COLORS: {
    1: { fill: [140, 150, 160, 30], line: [120, 130, 140, 45] },
    2: { fill: [140, 150, 160, 18], line: [120, 130, 140, 30] },
    3: { fill: [140, 150, 160, 8],  line: [120, 130, 140, 15] },
  },

  _computeFogRings() {
    if (!this._ownershipMap || this._ownershipMap.size === 0) {
      this._fogRingData = [];
      return;
    }

    const fogMap = new Map(); // h3Index → minimum ring distance

    for (const [h3Index] of this._ownershipMap) {
      let rings;
      try {
        rings = h3.gridDiskDistances(h3Index, this._FOG_RINGS);
      } catch (e) {
        continue; // skip pentagons or errors
      }

      for (let dist = 1; dist <= this._FOG_RINGS; dist++) {
        if (!rings[dist]) continue;
        for (const cellId of rings[dist]) {
          if (this._ownershipMap.has(cellId)) continue;
          const existing = fogMap.get(cellId);
          if (existing === undefined || dist < existing) {
            fogMap.set(cellId, dist);
          }
        }
      }
    }

    this._fogRingData = [];
    for (const [h3Index, ringDistance] of fogMap) {
      this._fogRingData.push({ h3Index, ringDistance });
    }
  },

  ZOOM_RESOLUTION_MAP: [
    { minZoom: 19, resolution: 13 },
    { minZoom: 17, resolution: 12 },
    { minZoom: 16, resolution: 11 },
    { minZoom: 14, resolution: 10 },
    { minZoom: 13, resolution: 9 },
    { minZoom: 11, resolution: 8 },
    { minZoom: 10, resolution: 7 },
    { minZoom: 8,  resolution: 6 },
    { minZoom: 7,  resolution: 5 },
    { minZoom: 6,  resolution: 4 },
    { minZoom: 4,  resolution: 3 },
    { minZoom: 2,  resolution: 2 },
    { minZoom: 0,  resolution: 1 }
  ],

  // Lightweight init — just store the map reference and keep a stable
  // bound handler. The 1.5 MB deck.gl + 256 KB h3-js bundles and the
  // overlay / tooltip DOM don't materialize until setEnabled(true),
  // which matters for users who never toggle the grid on.
  init(map) {
    this._map = map;
    this._ready = false;
    this._boundOnViewportChange = () => this._onViewportChange();
    this._listenersActive = false;
    Logger.log('[H3Grid] Init (lazy deps)');
  },

  async _ensureReady() {
    if (this._ready) return;
    await loadDeckAndH3();
    // Rich tooltip for ownership + H3 index
    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;display:none;pointer-events:none;z-index:9999;background:rgba(18,20,28,0.80);color:#fff;padding:14px 16px;border-radius:12px;font:12px sans-serif;white-space:nowrap;width:180px;border:1px solid rgba(255,255,255,0.08);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:0 8px 32px rgba(0,0,0,0.45);transition:opacity 0.22s ease,transform 0.22s ease;';
    document.body.appendChild(tip);
    this._tooltip = tip;

    this._overlay = new deck.MapboxOverlay({
      interleaved: true,
      layers: [],
    });
    this._map.addControl(this._overlay);
    this._ready = true;
    Logger.log('[H3Grid] deck.gl ready');
  },

  _attachListeners() {
    if (this._listenersActive || !this._map) return;
    this._map.on('moveend', this._boundOnViewportChange);
    this._map.on('zoomend', this._boundOnViewportChange);
    this._listenersActive = true;
  },

  _detachListeners() {
    if (!this._listenersActive || !this._map) return;
    this._map.off('moveend', this._boundOnViewportChange);
    this._map.off('zoomend', this._boundOnViewportChange);
    this._listenersActive = false;
  },

  async setEnabled(enabled) {
    this._enabled = enabled;
    Analytics.event('h3_grid_toggle', { enabled });
    if (enabled) {
      // First toggle-on pulls deck.gl + h3-js off the wire. Subsequent
      // toggles are free (idempotent).
      await this._ensureReady();
      // Permission state may have flipped during the await.
      if (!this._enabled) return;
      this._attachListeners();
      this._onViewportChange();
      this._showLeaderboardBtn(true);
    } else {
      this._detachListeners();
      if (this._overlay) this._overlay.setProps({ layers: [] });
      this._hexagonData = [];
      this._ownershipData = [];
      this._ownershipMap = null;
      this._fogRingData = [];
      this._userColorMap.clear();
      // [PERF-06] Drop the memoization snapshot so re-enabling forces a
      // fresh compute instead of short-circuiting against a stale view.
      this._lastPaddedBounds = null;
      this._lastResolution = null;
      if (this._tooltip) this._tooltip.style.display = 'none';
      this._showLeaderboardBtn(false);
    }
  },

  _onViewportChange() {
    if (!this._enabled) return;
    clearTimeout(this._debounceTimer);
    // [PERF-06] 80ms was too tight: at 60fps a normal drag fires moveend
    // many times in quick succession and each 80ms debounce window still
    // allowed spurious recomputes. 250ms gives the map a chance to settle
    // after a multi-step pan / zoom gesture while still feeling
    // responsive, and the memoization below drops most of the surviving
    // calls to a no-op anyway.
    this._debounceTimer = setTimeout(() => this._computeAndRender(), 250);
  },

  _getResolution(zoom) {
    for (const entry of this.ZOOM_RESOLUTION_MAP) {
      if (zoom >= entry.minZoom) return entry.resolution;
    }
    return 1;
  },

  // Find the first non-basemap layer to insert H3 grid below it
  _getBeforeId() {
    const style = this._map.getStyle();
    if (!style || !style.layers) return undefined;
    const baseSources = new Set(['protomaps', 'atasehir-satellite', 'sincan-satellite', 'video-source']);
    for (const layer of style.layers) {
      if (!layer.source || baseSources.has(layer.source)) continue;
      return layer.id;
    }
    return undefined;
  },

  async _computeAndRender() {
    if (!this._enabled || !this._map) return;

    const bounds = this._map.getBounds();
    const zoom = Math.floor(this._map.getZoom());
    const resolution = this._getResolution(zoom);

    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();

    // [PERF-06] Fast path: if the new (unpadded) view is still inside the
    // padded region we computed last time AND the resolution is unchanged,
    // the hexagons already in _hexagonData cover the visible area and the
    // ownership fetch we did for that region is still valid. Skip the
    // whole polygonToCells + fetch + relayer work.
    const cached = this._lastPaddedBounds;
    if (
      cached &&
      resolution === this._lastResolution &&
      sw.lat >= cached.swLat &&
      sw.lng >= cached.swLng &&
      ne.lat <= cached.neLat &&
      ne.lng <= cached.neLng
    ) {
      return;
    }

    // Expand viewport by 15% on each side to fill edges
    const latPad = (ne.lat - sw.lat) * 0.15;
    const lngPad = (ne.lng - sw.lng) * 0.15;

    const polygon = [
      [sw.lat - latPad, sw.lng - lngPad],
      [ne.lat + latPad, sw.lng - lngPad],
      [ne.lat + latPad, ne.lng + lngPad],
      [sw.lat - latPad, ne.lng + lngPad],
      [sw.lat - latPad, sw.lng - lngPad]
    ];

    let cells;
    try {
      cells = h3.polygonToCells(polygon, resolution);
    } catch (e) {
      Logger.error('[H3Grid] polygonToCells error:', e);
      return;
    }

    if (cells.length > 50000) {
      Logger.warn('[H3Grid] Too many cells:', cells.length);
      return;
    }

    this._hexagonData = cells.map(idx => ({ h3Index: idx }));
    this._currentResolution = resolution;

    // [PERF-06] Record the padded bounds + resolution that produced
    // _hexagonData. The next _computeAndRender will short-circuit if the
    // view still fits inside this region at the same resolution.
    this._lastPaddedBounds = {
      swLat: sw.lat - latPad,
      swLng: sw.lng - lngPad,
      neLat: ne.lat + latPad,
      neLng: ne.lng + lngPad
    };
    this._lastResolution = resolution;

    // Notify TRON trails of new hex data
    if (H3TronTrails._enabled) {
      H3TronTrails.onHexDataChanged(this._hexagonData, resolution);
    }

    // Fetch ownership data (fog rings + owned cells rendered after fetch)
    // Skip at low zoom — too large an area, backend rejects and data is meaningless
    if (zoom >= 6) {
      this._fetchOwnership(sw.lat - latPad, sw.lng - lngPad, ne.lat + latPad, ne.lng + lngPad, zoom);
    } else {
      this._ownershipData = [];
      this._ownershipMap = null;
      this._fogRingData = [];
      this._renderLayer();
    }
  },

  async _fetchOwnership(swLat, swLng, neLat, neLng, zoom) {
    // Abort previous request if still pending
    if (this._ownershipFetchController) {
      this._ownershipFetchController.abort();
    }
    this._ownershipFetchController = new AbortController();

    try {
      const url = `${QBitmapConfig.api.h3}/hexagons/ownership?sw_lat=${swLat.toFixed(4)}&sw_lng=${swLng.toFixed(4)}&ne_lat=${neLat.toFixed(4)}&ne_lng=${neLng.toFixed(4)}&zoom=${zoom}`;
      const res = await fetch(url, { signal: this._ownershipFetchController.signal });

      if (!res.ok) return;

      const data = await res.json();
      this._ownershipData = data.cells || [];
      this._ownershipMap = new Map(this._ownershipData.map(c => [c.h3Index, c]));

      // Assign per-user colors directly into data objects
      for (const cell of this._ownershipData) {
        const c = this._getUserColor(cell.userId);
        cell._fill = c.fill;
        cell._line = c.line;
      }

      // Compute fog rings around owned cells
      this._computeFogRings();

      // Re-render with ownership data
      this._renderLayer();

      // Notify TRON trails of ownership changes
      if (H3TronTrails._enabled) {
        H3TronTrails.onOwnershipChanged(this._ownershipData);
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        Logger.warn('[H3Grid] Ownership fetch error:', e.message);
      }
    }
  },

  _renderLayer() {
    if (!this._overlay) return;

    const beforeId = this._getBeforeId();
    const layers = [];

    // Fog ring layer (fading hexagons around owned cells)
    if (this._fogRingData.length > 0) {
      const fogColors = this._FOG_COLORS;
      const fogLayer = new deck.H3HexagonLayer({
        id: 'h3-fog-ring-layer',
        data: this._fogRingData,
        pickable: true,
        filled: true,
        stroked: true,
        extruded: false,
        beforeId: beforeId,
        getHexagon: d => d.h3Index,
        getFillColor: d => fogColors[d.ringDistance]?.fill || [140, 150, 160, 5],
        getLineColor: d => fogColors[d.ringDistance]?.line || [120, 130, 140, 10],
        getLineWidth: 1,
        lineWidthMinPixels: 1,
        lineWidthMaxPixels: 1,
        coverage: 1,
        highPrecision: true,
        opacity: 0.5,
        autoHighlight: true,
        highlightColor: [140, 145, 150, 40],

        // Paneller tıklama ile açılıyor; autoHighlight hover'da hücreyi vurguluyor.
        onClick: (info) => {
          if (!info.object) return;
          if (this._currentResolution < 13) {
            const center = h3.cellToLatLng(info.object.h3Index);
            this._map.easeTo({
              center: [center[1], center[0]],
              zoom: this._map.getZoom() + 2
            });
          } else {
            this._showFogTooltip(info.x, info.y, info.object.h3Index);
          }
        }
      });
      layers.push(fogLayer);
    }

    // Ownership layer (owned cells, per-user colors)
    if (this._ownershipData.length > 0) {
      const ownershipLayer = new deck.H3HexagonLayer({
        id: 'h3-ownership-layer',
        data: this._ownershipData,
        pickable: true,
        filled: true,
        stroked: true,
        extruded: false,
        beforeId: beforeId,
        getHexagon: d => d.h3Index,
        getFillColor: d => d._fill,
        getLineColor: d => d._line,
        getLineWidth: 1,
        lineWidthMinPixels: 1,
        lineWidthMaxPixels: 1,
        coverage: 1,
        highPrecision: true,
        opacity: 0.7,
        autoHighlight: true,
        highlightColor: [200, 200, 200, 130],

        // Paneller tıklama ile açılıyor; autoHighlight hover'da hücreyi vurguluyor.
        onClick: (info) => {
          if (!info.object) return;
          if (this._currentResolution < 13) {
            const center = h3.cellToLatLng(info.object.h3Index);
            this._map.easeTo({
              center: [center[1], center[0]],
              zoom: this._map.getZoom() + 2
            });
          } else {
            this._showOwnerTooltipTimed(info.x, info.y, info.object.h3Index, info.object);
          }
        }
      });
      layers.push(ownershipLayer);
    }

    this._overlay.setProps({ layers });
  },

  _showOwnerTooltipTimed(x, y, h3Index, owner) {
    // Don't re-show if same cell tooltip is already visible
    if (this._tooltipH3Index === h3Index && this._tooltip.style.display === 'block') return;
    clearTimeout(this._tooltipTimer);
    this._tooltipH3Index = h3Index;
    this._showOwnerTooltip(x, y, h3Index, owner);
    this._tooltipTimer = setTimeout(() => {
      this._tooltip.style.opacity = '0';
      this._tooltip.style.transform = 'translateY(6px) scale(0.97)';
      setTimeout(() => {
        this._tooltip.style.display = 'none';
        this._tooltipH3Index = null;
      }, 220);
    }, 5000);
  },

  _animateTooltipIn(x, y) {
    this._tooltip.style.display = 'block';
    this._tooltip.style.left = (x + 14) + 'px';
    this._tooltip.style.top = (y - 40) + 'px';
    this._tooltip.style.opacity = '0';
    this._tooltip.style.transform = 'translateY(6px) scale(0.97)';
    requestAnimationFrame(() => {
      this._tooltip.style.opacity = '1';
      this._tooltip.style.transform = 'translateY(0) scale(1)';
    });
  },

  _statRow(label, value, valueStyle) {
    return `<div style="display:flex;justify-content:space-between;gap:16px;margin-bottom:3px;">
      <span style="color:#999;font-size:11px;">${label}</span>
      <span style="font-size:12px;font-weight:500;${valueStyle || ''}">${value}</span>
    </div>`;
  },

  _showOwnerTooltip(x, y, h3Index, owner) {
    const userColor = this._getUserColor(owner.userId);
    const avatarHtml = owner.avatarUrl
      ? `<img src="${escapeHtml(owner.avatarUrl)}" style="width:40px;height:40px;border-radius:10px;flex-shrink:0;border:2px solid ${userColor.hex};" />`
      : `<div style="width:40px;height:40px;border-radius:10px;flex-shrink:0;background:${userColor.hex};opacity:0.5;"></div>`;
    const cellArea = h3.cellArea(h3Index, 'm2');
    const areaStr = this._formatArea(cellArea);
    const cellViews = (owner.cellViews || 0).toLocaleString('tr-TR');
    const videos = owner.videoCount || 0;
    const photos = owner.photoCount || 0;

    this._tooltip.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:2px;">
        ${avatarHtml}
        <div>
          <div style="font-weight:600;font-size:14px;">${escapeHtml(owner.displayName)}</div>
          <div style="font-size:11px;opacity:0.5;margin-top:2px;">Qbitscore: ${owner.points.toLocaleString('tr-TR')}</div>
        </div>
      </div>
      <div style="height:1px;background:rgba(255,255,255,0.08);margin:10px 0;"></div>
      ${this._statRow('Lokasyon', h3Index, 'font:9px/1.4 monospace;')}
      ${this._statRow('Dijital Toprak', areaStr)}
      ${this._statRow('Pop\u00fclerlik', cellViews)}
      ${this._statRow('Video', videos)}
      ${this._statRow('Foto\u011fraf', photos)}`;
    // CSP: replace inline onerror on avatar img
    this._tooltip.querySelectorAll('img').forEach(img => {
      img.addEventListener('error', () => { img.style.display = 'none'; });
    });
    this._animateTooltipIn(x, y);
  },

  _showUnownedTooltip(x, y, h3Index) {
    this._tooltipH3Index = h3Index;
    clearTimeout(this._tooltipTimer);
    this._tooltip.innerHTML = `
      <div style="text-align:center;">
        <div style="font:10px monospace;opacity:0.7;margin-bottom:4px;">${h3Index}</div>
        <div style="font-weight:600;font-size:12px;color:#666;">Sahipsiz</div>
      </div>`;
    this._animateTooltipIn(x, y);
  },

  _showFogTooltip(x, y, h3Index) {
    this._tooltipH3Index = h3Index;
    clearTimeout(this._tooltipTimer);
    this._tooltip.innerHTML = `
      <div style="text-align:center;">
        <div style="font:10px monospace;opacity:0.5;margin-bottom:4px;">${h3Index}</div>
        <div style="font-weight:600;font-size:12px;color:#555;">Ke\u015Ffedilmemi\u015F</div>
      </div>`;
    this._animateTooltipIn(x, y);
    this._tooltipTimer = setTimeout(() => {
      this._tooltip.style.opacity = '0';
      this._tooltip.style.transform = 'translateY(6px) scale(0.97)';
      setTimeout(() => {
        this._tooltip.style.display = 'none';
        this._tooltipH3Index = null;
      }, 220);
    }, 3000);
  },

  _formatArea(m2) {
    if (m2 < 1000) return m2.toFixed(1) + 'm\u00B2';
    if (m2 < 1000000) return Math.round(m2).toLocaleString('en-US') + 'm\u00B2';
    const km2 = m2 / 1000000;
    if (km2 >= 10) return km2.toFixed(1) + 'km\u00B2';
    return km2.toFixed(2) + 'km\u00B2';
  },

  // ==================== LEADERBOARD ====================

  _leaderboardPanel: null,
  _leaderboardBtn: null,
  _leaderboardVisible: false,
  _leaderboardInterval: null,

  _initLeaderboard() {
    if (this._leaderboardBtn) return;

    // Toggle button
    const btn = document.createElement('button');
    btn.className = 'h3-leaderboard-btn';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M5 13h4v8H5zm6-5h4v13h-4zm6-4h4v17h-4z"/></svg>';
    btn.title = 'Toprak Sahipleri';
    btn.style.cssText = 'display:none;position:fixed;bottom:30px;right:14px;z-index:1000;width:40px;height:40px;border-radius:50%;border:none;background:rgba(0,0,0,0.75);color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.3);align-items:center;justify-content:center;';
    btn.addEventListener('click', () => this._toggleLeaderboard());
    document.body.appendChild(btn);
    this._leaderboardBtn = btn;

    // Panel
    const panel = document.createElement('div');
    panel.className = 'h3-leaderboard-panel';
    panel.style.cssText = 'display:none;position:fixed;bottom:80px;right:14px;z-index:1000;width:300px;max-height:400px;background:rgba(55,55,60,0.94);color:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.4);font-family:sans-serif;backdrop-filter:blur(10px);';
    panel.innerHTML = `
      <div style="padding:14px 16px 10px;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:space-between;">
        <span style="font-weight:600;font-size:14px;">Dijital Toprak Sahipleri</span>
        <span class="h3-lb-close" style="cursor:pointer;opacity:0.5;font-size:18px;line-height:1;">&times;</span>
      </div>
      <div class="h3-lb-list" style="padding:8px 0;overflow-y:auto;max-height:340px;"></div>`;
    panel.querySelector('.h3-lb-close').addEventListener('click', () => this._toggleLeaderboard());
    document.body.appendChild(panel);
    this._leaderboardPanel = panel;
  },

  _showLeaderboardBtn(show) {
    this._initLeaderboard();
    this._leaderboardBtn.style.display = show ? 'flex' : 'none';
    if (!show) {
      this._leaderboardPanel.style.display = 'none';
      this._leaderboardVisible = false;
      if (this._leaderboardInterval) {
        clearInterval(this._leaderboardInterval);
        this._leaderboardInterval = null;
      }
    }
  },

  _toggleLeaderboard() {
    this._leaderboardVisible = !this._leaderboardVisible;
    this._leaderboardPanel.style.display = this._leaderboardVisible ? 'block' : 'none';

    if (this._leaderboardVisible) {
      this._fetchLeaderboard();
      this._leaderboardInterval = setInterval(() => this._fetchLeaderboard(), 60000);
    } else {
      if (this._leaderboardInterval) {
        clearInterval(this._leaderboardInterval);
        this._leaderboardInterval = null;
      }
    }
  },

  async _fetchLeaderboard() {
    try {
      const res = await fetch(`${QBitmapConfig.api.h3}/hexagons/leaderboard?limit=5`);
      if (!res.ok) return;
      const data = await res.json();
      this._renderLeaderboard(data.users || []);
    } catch (e) {
      Logger.warn('[H3Grid] Leaderboard fetch error:', e.message);
    }
  },

  _renderLeaderboard(users) {
    const list = this._leaderboardPanel.querySelector('.h3-lb-list');
    if (!users.length) {
      list.innerHTML = '<div style="text-align:center;padding:20px;opacity:0.5;font-size:13px;">Henuz toprak sahibi yok</div>';
      return;
    }

    const res13Area = h3.getHexagonAreaAvg(13, 'm2');

    list.innerHTML = users.map((u, i) => {
      const medal = i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'transparent';
      const userColor = this._getUserColor(u.userId);
      const avatarHtml = u.avatarUrl
        ? `<img src="${escapeHtml(u.avatarUrl)}" style="width:32px;height:32px;border-radius:50%;flex-shrink:0;border:2px solid ${userColor.hex};" />`
        : `<div style="width:32px;height:32px;border-radius:50%;background:${userColor.hex};opacity:0.5;flex-shrink:0;"></div>`;
      const totalArea = this._formatArea(u.cellCount * res13Area);
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 16px;${i < users.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.05);' : ''}">
          <span style="width:22px;text-align:center;font-weight:700;font-size:13px;color:${medal !== 'transparent' ? medal : 'rgba(255,255,255,0.4)'};">${i + 1}</span>
          ${avatarHtml}
          <div style="flex:1;min-width:0;">
            <div style="font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(u.displayName)}</div>
            <div style="font-size:11px;opacity:0.5;">${u.cellCount} grid (${totalArea})</div>
          </div>
          <div style="font-weight:600;font-size:13px;color:${userColor.hex};">${u.totalPoints} qbits</div>
        </div>`;
    }).join('');
    // CSP: replace inline onerror on leaderboard avatars
    list.querySelectorAll('img').forEach(img => {
      img.addEventListener('error', () => { img.style.display = 'none'; });
    });
  }
};

export { H3Grid };
