/**
 * Lazy vendor script loader
 * Loads UMD scripts on demand and caches the promise
 */
const _cache = {};

export function loadScript(url, { integrity } = {}) {
  if (_cache[url]) return _cache[url];
  _cache[url] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    if (integrity) {
      s.integrity = integrity;
      s.crossOrigin = 'anonymous';
    }
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${url}`));
    document.head.appendChild(s);
  });
  return _cache[url];
}

function loadStylesheet(url, { integrity } = {}) {
  if (_cache[url]) return _cache[url];
  _cache[url] = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    if (integrity) {
      link.integrity = integrity;
      link.crossOrigin = 'anonymous';
    }
    link.onload = resolve;
    link.onerror = () => reject(new Error(`Failed to load ${url}`));
    document.head.appendChild(link);
  });
  return _cache[url];
}

export async function loadHls() {
  if (typeof Hls !== 'undefined') return;
  await loadScript('/vendor/hls.min.js');
}

export async function loadDeckAndH3() {
  if (typeof deck !== 'undefined' && typeof h3 !== 'undefined') return;
  // h3-js must load first — deck.gl captures globalThis.h3 at init time
  if (typeof h3 === 'undefined') await loadScript('/vendor/h3-js.umd.js');
  if (typeof deck === 'undefined') await loadScript('/vendor/deck.gl.min.js?v=9.3.1');
}

export async function loadMapLibre() {
  if (typeof maplibregl !== 'undefined') return;
  // basemaps.js depends on the maplibregl global, so order matters.
  await loadScript('/vendor/maplibre-gl.js');
  await loadScript('/vendor/basemaps.js');
}

// Plyr 3.8.4 SRI hashes — recompute with
//   curl -sS https://cdn.plyr.io/3.8.4/plyr.polyfilled.js | openssl dgst -sha384 -binary | openssl base64 -A
// when bumping the version. SRI ensures a CDN compromise can't ship
// a substituted plyr.polyfilled.js to our visitors; the browser
// rejects the script outright if the bytes don't match.
const PLYR_JS_INTEGRITY  = 'sha384-ZDYtn77N2Oxc6W8oilE9z73hj1EZqidVlQeqTwsKW19gglwyUYHMn/LzX+ewyFJD';
const PLYR_CSS_INTEGRITY = 'sha384-VqqE0KSv00qfHvKpRa8aov+g3xtUu2Rw0NsEmtjTOPGn/JDKVghgd56iw/VObHa7';

export async function loadPlyr() {
  if (typeof Plyr !== 'undefined') return;
  // Load script + stylesheet in parallel; both are required before instantiating Plyr.
  await Promise.all([
    loadScript('https://cdn.plyr.io/3.8.4/plyr.polyfilled.js', { integrity: PLYR_JS_INTEGRITY }),
    loadStylesheet('https://cdn.plyr.io/3.8.4/plyr.css', { integrity: PLYR_CSS_INTEGRITY }),
  ]);
}

