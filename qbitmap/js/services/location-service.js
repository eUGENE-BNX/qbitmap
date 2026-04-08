/**
 * LocationService — unified geolocation for all features.
 *
 * Single entry point: LocationService.get(opts) → Promise<LocationResult>
 *
 * Strategy:
 *   1. Cache hit (< 60s) unless purpose=map-init or noCache
 *   2. Progressive watchPosition sampling (10–20s window) keeping the lowest
 *      coords.accuracy sample
 *   3. Resolve early when accuracy <= acceptThresholdM (precise)
 *   4. On timeout, resolve with best sample if accuracy <= approximateMaxM
 *   5. Otherwise (or on error/denied), fall back to backend IP geolocation
 *      (/api/geo/ip-locate) marked as source:'ip', quality:'coarse'
 *   6. If everything fails, reject — caller decides UX (map picker, default)
 *
 * Returned shape:
 *   { lng, lat, accuracy_radius_m, source, quality, timestamp }
 *     source : 'gps' | 'ip' | 'cache'
 *     quality: 'precise' | 'approximate' | 'coarse'
 */

import { QBitmapConfig } from '../config.js';

const API_BASE = `${QBitmapConfig.api.base}/api`;
const CACHE_TTL_MS = 60_000;

let _cache = null; // last successful result

function _now() { return Date.now(); }

function _sample({ sampleWindowMs, acceptThresholdM, approximateMaxM }) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject(new Error('geolocation-unsupported'));
    }

    let best = null;
    let settled = false;

    const finish = (result, err) => {
      if (settled) return;
      settled = true;
      try { navigator.geolocation.clearWatch(watchId); } catch {}
      clearTimeout(timer);
      if (result) resolve(result);
      else reject(err || new Error('geolocation-failed'));
    };

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (!best || pos.coords.accuracy < best.coords.accuracy) {
          best = pos;
        }
        if (pos.coords.accuracy <= acceptThresholdM) {
          finish({
            lng: pos.coords.longitude,
            lat: pos.coords.latitude,
            accuracy_radius_m: Math.round(pos.coords.accuracy),
            source: 'gps',
            quality: 'precise',
            timestamp: _now()
          });
        }
      },
      (err) => {
        // Hard error (PERMISSION_DENIED etc.) → if we have something, use it.
        if (best) {
          const acc = best.coords.accuracy;
          finish({
            lng: best.coords.longitude,
            lat: best.coords.latitude,
            accuracy_radius_m: Math.round(acc),
            source: 'gps',
            quality: acc <= approximateMaxM ? 'approximate' : 'coarse',
            timestamp: _now()
          });
        } else {
          finish(null, err);
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: sampleWindowMs }
    );

    const timer = setTimeout(() => {
      if (best) {
        const acc = best.coords.accuracy;
        finish({
          lng: best.coords.longitude,
          lat: best.coords.latitude,
          accuracy_radius_m: Math.round(acc),
          source: 'gps',
          quality: acc <= approximateMaxM ? 'approximate' : 'coarse',
          timestamp: _now()
        });
      } else {
        finish(null, new Error('geolocation-timeout'));
      }
    }, sampleWindowMs + 500);
  });
}

async function _ipFallback() {
  const res = await fetch(`${API_BASE}/geo/ip-locate`, { credentials: 'include' });
  if (!res.ok) throw new Error(`ip-locate-${res.status}`);
  const data = await res.json();
  if (!Number.isFinite(data.lng) || !Number.isFinite(data.lat)) {
    throw new Error('ip-locate-invalid');
  }
  return {
    lng: data.lng,
    lat: data.lat,
    accuracy_radius_m: data.accuracy_radius_m || 25000,
    source: 'ip',
    quality: 'coarse',
    timestamp: _now()
  };
}

const LocationService = {
  /**
   * @param {object} [opts]
   * @param {string} [opts.purpose='generic'] - 'map-init'|'broadcast'|'video-upload'|'profile'|'photo'|'generic'
   * @param {number} [opts.sampleWindowMs=12000]
   * @param {number} [opts.acceptThresholdM=100]
   * @param {number} [opts.approximateMaxM=500]
   * @param {boolean} [opts.noCache=false]
   * @returns {Promise<{lng:number,lat:number,accuracy_radius_m:number,source:string,quality:string,timestamp:number}>}
   */
  async get(opts = {}) {
    const {
      purpose = 'generic',
      sampleWindowMs = 12000,
      acceptThresholdM = 100,
      approximateMaxM = 500,
      noCache = false
    } = opts;

    // 1. Cache (skipped for map-init so first paint always tries fresh GPS)
    if (!noCache && purpose !== 'map-init' && _cache && (_now() - _cache.timestamp) < CACHE_TTL_MS) {
      return { ..._cache, source: 'cache' };
    }

    // 2. GPS sampling
    try {
      const gps = await _sample({ sampleWindowMs, acceptThresholdM, approximateMaxM });
      _cache = gps;
      return gps;
    } catch (gpsErr) {
      // 3. IP fallback
      try {
        const ip = await _ipFallback();
        // Don't cache coarse IP results — next call should still try GPS
        return ip;
      } catch (ipErr) {
        const e = new Error('location-unavailable');
        e.gpsError = gpsErr;
        e.ipError = ipErr;
        throw e;
      }
    }
  },

  /** Read-only access to last successful result without triggering anything. */
  peek() {
    return _cache ? { ..._cache, source: 'cache' } : null;
  },

  /** Clear cached result (e.g. on logout). */
  clearCache() {
    _cache = null;
  }
};

export { LocationService };
export default LocationService;
