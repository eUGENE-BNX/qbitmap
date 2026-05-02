/**
 * QBitmap Shared Application State
 * Replaces window.* globals with importable module state
 */

// Map instance (set by map.js after initialization)
export let map = null;

// Promise that resolves once the map's style has finished loading.
// Race-free: awaiters that arrive after the 'load' event has already fired
// still resolve immediately, unlike `map.on('load', ...)` which silently no-ops.
let _resolveMapReady;
export const mapReady = new Promise(r => { _resolveMapReady = r; });

export function setMap(m) {
  map = m;
  if (m.loaded()) {
    _resolveMapReady(m);
  } else {
    m.once('load', () => _resolveMapReady(m));
  }
}

// Layer visibility toggles
export const layers = {
  videoLayerVisible: false,
  buildings3DVisible: false,
  h3GridVisible: localStorage.getItem('qbitmap_h3grid') !== 'false',
  h3TrailsVisible: false,
  vehiclesVisible: false,
  videoMessagesVisible: true,
  photoMessagesVisible: true,
  cityCamerasVisible: true,
  userCamerasVisible: true,
  teslaVehiclesVisible: localStorage.getItem('qbitmap_tesla') === 'true',
  teslaCamLiveVisible: false,
  pastBroadcastsVisible: false,
  usdtVisible: false,
  gameZonesVisible: localStorage.getItem('qbitmap_zones') === 'true',
};

// Map mode state
export let satelliteMode = false;
export function setSatelliteMode(v) { satelliteMode = v; }
