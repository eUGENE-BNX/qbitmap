import { Logger } from './utils.js';
import { Analytics } from './analytics.js';
import { loadDeckAndH3 } from './vendor-loader.js';

/**
 * QBitmap Game Zones Layer
 *
 * Renders predefined polygon areas as H3 hexagons (res 10, ~100m edge) with:
 *   - 3-ring soft-fade halo around each zone (alpha 0.85 → 0.55 → 0.30 → 0.12)
 *   - "Living area" effect: each hex breathes independently with a per-cell
 *     deterministic random phase + period (2.0–4.0s). Alpha modulates between
 *     40%–100% of the cell's base alpha. Color stays at the zone hue — no
 *     white-lift — for an organic glow rather than a strobe.
 *
 * Zones are loaded once from /data/game-zones.json on first toggle-on.
 * Cell sets are computed once at init (zones are static), so per-frame
 * work is just a sin() per cell on the GPU side.
 */

const RESOLUTION = 10;
const FOG_RINGS = 3;
const RING_OPACITY = { 0: 0.85, 1: 0.55, 2: 0.30, 3: 0.12 };
const BREATH_MIN_MS = 3000;
const BREATH_MAX_MS = 5000;
const BREATH_ALPHA_MIN = 0.3;
const BREATH_ALPHA_MAX = 0.9;
const MIN_ZONE_ZOOM = 8;

const H3GameZones = {
  _map: null,
  _overlay: null,
  _enabled: false,
  _ready: false,
  _zonesLoaded: false,
  _zones: [],
  _cellData: [],
  _animId: null,
  _tooltip: null,

  init(map) {
    this._map = map;
    Logger.log('[GameZones] Init (lazy deps)');
  },

  async _ensureReady() {
    if (this._ready) return;
    await loadDeckAndH3();

    const tip = document.createElement('div');
    tip.className = 'active-zone-tooltip';
    tip.style.cssText = [
      'position:fixed',
      'display:none',
      'pointer-events:none',
      'z-index:9999',
      'padding:10px 16px',
      'border-radius:12px',
      'background:rgba(20,24,36,0.78)',
      'color:#fff',
      'font:600 13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'letter-spacing:0.3px',
      'border:1px solid rgba(255,255,255,0.10)',
      'backdrop-filter:blur(16px)',
      '-webkit-backdrop-filter:blur(16px)',
      'box-shadow:0 8px 32px rgba(0,0,0,0.45)',
      'white-space:nowrap',
      'transition:opacity 0.15s ease',
    ].join(';');
    document.body.appendChild(tip);
    this._tooltip = tip;

    this._overlay = new deck.MapboxOverlay({
      interleaved: true,
      layers: [],
    });
    this._map.addControl(this._overlay);
    this._ready = true;
    Logger.log('[GameZones] deck.gl ready');
  },

  async _loadZones() {
    if (this._zonesLoaded) return;
    let zones = [];
    try {
      const res = await fetch('/data/game-zones.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      zones = json.zones || [];
    } catch (err) {
      Logger.warn('[GameZones] Failed to load zones', err);
      this._zonesLoaded = true;
      return;
    }
    for (const z of zones) {
      try {
        const computed = this._computeZoneCells(z);
        if (computed) this._zones.push(computed);
      } catch (err) {
        Logger.warn(`[GameZones] Skipping zone ${z.id}`, err);
      }
    }
    this._cellData = this._flattenForDeck();
    this._zonesLoaded = true;
    Logger.log(`[GameZones] Loaded ${this._zones.length} zones, ${this._cellData.length} cells`);
  },

  _computeZoneCells(zone) {
    if (!zone.polygon || zone.polygon.length < 3) return null;
    const polyGeoJson = zone.polygon.map(([lat, lng]) => [lng, lat]);
    const inner = h3.polygonToCells([polyGeoJson], RESOLUTION, true);
    if (!inner.length) return null;
    const innerSet = new Set(inner);

    const ringMap = new Map();
    for (const cell of inner) {
      let rings;
      try {
        rings = h3.gridDiskDistances(cell, FOG_RINGS);
      } catch (e) {
        continue;
      }
      for (let d = 1; d <= FOG_RINGS; d++) {
        if (!rings[d]) continue;
        for (const c of rings[d]) {
          if (innerSet.has(c)) continue;
          const prev = ringMap.get(c);
          if (prev === undefined || d < prev) ringMap.set(c, d);
        }
      }
    }

    return { ...zone, inner, ringMap };
  },

  _flattenForDeck() {
    const out = [];
    const periodSpan = BREATH_MAX_MS - BREATH_MIN_MS;
    for (const z of this._zones) {
      const color = z.color || [255, 185, 100];
      const zoneName = z.name || z.id;
      const push = (h, ringDist) => {
        const hash = this._cellHash(h);
        const phase = (hash & 0xffff) / 0xffff;
        const period = BREATH_MIN_MS + (((hash >>> 16) & 0xffff) / 0xffff) * periodSpan;
        out.push({ h3Index: h, ringDist, color, phase, period, zoneName });
      };
      for (const h of z.inner) push(h, 0);
      for (const [h, d] of z.ringMap) push(h, d);
    }
    return out;
  },

  async setEnabled(enabled) {
    this._enabled = enabled;
    Analytics.event('game_zones_toggle', { enabled });
    if (enabled) {
      await this._ensureReady();
      if (!this._enabled) return;
      await this._loadZones();
      if (!this._enabled) return;
      this._startAnimation();
    } else {
      this._stopAnimation();
      if (this._overlay) this._overlay.setProps({ layers: [] });
      if (this._tooltip) this._tooltip.style.display = 'none';
    }
  },

  _startAnimation() {
    if (this._animId) return;
    const tick = (now) => {
      if (!this._enabled) {
        this._animId = null;
        return;
      }
      if (document.visibilityState === 'visible' && this._map.getZoom() >= MIN_ZONE_ZOOM) {
        this._renderLayer(now);
      } else if (this._overlay) {
        this._overlay.setProps({ layers: [] });
      }
      this._animId = requestAnimationFrame(tick);
    };
    this._animId = requestAnimationFrame(tick);
  },

  _stopAnimation() {
    if (this._animId) cancelAnimationFrame(this._animId);
    this._animId = null;
  },

  _renderLayer(now) {
    if (!this._cellData.length) return;
    const TWO_PI = Math.PI * 2;
    const layer = new deck.H3HexagonLayer({
      id: 'h3-game-zones-layer',
      data: this._cellData,
      filled: true,
      stroked: true,
      extruded: false,
      pickable: true,
      onHover: (info) => this._onHover(info),
      getHexagon: d => d.h3Index,
      getFillColor: d => {
        const baseA = RING_OPACITY[d.ringDist] * 255;
        const breath = 0.5 + 0.5 * Math.sin(TWO_PI * (now / d.period + d.phase));
        const alphaMul = BREATH_ALPHA_MIN + (BREATH_ALPHA_MAX - BREATH_ALPHA_MIN) * breath;
        return [d.color[0], d.color[1], d.color[2], baseA * alphaMul];
      },
      getLineColor: d => {
        const [r, g, b] = d.color;
        return [r, g, b, RING_OPACITY[d.ringDist] * 180];
      },
      getLineWidth: 1,
      lineWidthMinPixels: 1,
      coverage: 1,
      highPrecision: true,
      updateTriggers: {
        getFillColor: now,
      },
    });
    this._overlay.setProps({ layers: [layer] });
  },

  _onHover(info) {
    if (!this._tooltip) return;
    if (info && info.object) {
      this._tooltip.textContent = info.object.zoneName;
      this._tooltip.style.left = (info.x + 14) + 'px';
      this._tooltip.style.top = (info.y + 14) + 'px';
      this._tooltip.style.display = 'block';
    } else {
      this._tooltip.style.display = 'none';
    }
  },

  _cellHash(s) {
    let h = 0;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  },
};

export { H3GameZones };
