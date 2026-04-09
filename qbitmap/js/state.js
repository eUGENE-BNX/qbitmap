/**
 * QBitmap Shared Application State
 * Replaces window.* globals with importable module state
 */

// Map instance (set by map.js after initialization)
export let map = null;
export function setMap(m) { map = m; }

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
};

// Map mode state
export let satelliteMode = false;
export function setSatelliteMode(v) { satelliteMode = v; }
