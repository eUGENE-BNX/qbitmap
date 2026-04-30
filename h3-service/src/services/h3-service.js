const h3 = require('h3-js');
const pool = require('./db-pool');
const cache = require('./cache');

const ZOOM_TO_RESOLUTION = [
  [21, 14],
  [20, 13],
  [18, 12],
  [16, 11],
  [14, 10],
  [13, 9],
  [11, 8],
  [10, 7],
  [8, 6],
  [7, 5],
  [6, 4],
  [4, 3],
  [2, 2],
  [0, 1]
];

function zoomToResolution(zoom) {
  for (const [minZoom, res] of ZOOM_TO_RESOLUTION) {
    if (zoom >= minZoom) return res;
  }
  return 1;
}

async function getViewportHexagons(swLat, swLng, neLat, neLng, zoom) {
  const resolution = zoomToResolution(zoom);

  const cacheKey = `vp:${resolution}:${swLat.toFixed(3)}:${swLng.toFixed(3)}:${neLat.toFixed(3)}:${neLng.toFixed(3)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Get H3 cells covering the viewport
  const polygon = [
    [swLat, swLng],
    [neLat, swLng],
    [neLat, neLng],
    [swLat, neLng],
    [swLat, swLng]
  ];

  let viewportCells;
  try {
    viewportCells = h3.polygonToCells(polygon, resolution);
  } catch (e) {
    return { resolution, hexagons: [], meta: { zoom, cellCount: 0, error: 'polygon computation failed' } };
  }

  // Cap at 50,000 cells
  if (viewportCells.length > 50000) {
    return { resolution, hexagons: [], meta: { zoom, cellCount: 0, error: 'viewport too large' } };
  }

  // Return grid cells with centers (no camera data for now)
  const hexagons = viewportCells.map(cellId => {
    const center = h3.cellToLatLng(cellId);
    return {
      h3Index: cellId,
      center: [center[0], center[1]]
    };
  });

  const result = {
    resolution,
    hexagons,
    meta: { zoom, cellCount: hexagons.length }
  };

  cache.set(cacheKey, result, 30000);
  return result;
}

async function getHexagonDetails(h3Index) {
  const res = h3.getResolution(h3Index);

  let rows;
  if (res === 14) {
    const result = await pool.query(
      'SELECT device_id, name, lat, lng, camera_type, is_public FROM cameras WHERE h3_res14 = $1::h3index',
      [h3Index]
    );
    rows = result.rows;
  } else {
    const result = await pool.query(
      'SELECT device_id, name, lat, lng, camera_type, is_public FROM cameras WHERE h3_cell_to_parent(h3_res14, $1) = $2::h3index',
      [res, h3Index]
    );
    rows = result.rows;
  }

  return {
    h3Index,
    resolution: res,
    center: h3.cellToLatLng(h3Index),
    cameras: rows
  };
}

async function getHexagonNeighbors(h3Index, k = 1) {
  const neighbors = h3.gridDisk(h3Index, k);

  return neighbors.map(idx => ({
    h3Index: idx,
    center: h3.cellToLatLng(idx)
  }));
}

module.exports = {
  zoomToResolution,
  getViewportHexagons,
  getHexagonDetails,
  getHexagonNeighbors
};
