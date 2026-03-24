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
  object3DLayerVisible: false,
  buildings3DVisible: false,
  h3GridVisible: localStorage.getItem('qbitmap_h3grid') === 'true',
  h3TrailsVisible: false,
  vehiclesVisible: false,
  videoMessagesVisible: true,
  photoMessagesVisible: true,
  cityCamerasVisible: true,
  userCamerasVisible: true,
};

// Map mode state
export let satelliteMode = false;
export function setSatelliteMode(v) { satelliteMode = v; }
