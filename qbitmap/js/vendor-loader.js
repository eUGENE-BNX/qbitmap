/**
 * Lazy vendor script loader
 * Loads UMD scripts on demand and caches the promise
 */
const _cache = {};

export function loadScript(url) {
  if (_cache[url]) return _cache[url];
  _cache[url] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${url}`));
    document.head.appendChild(s);
  });
  return _cache[url];
}

function loadStylesheet(url) {
  if (_cache[url]) return _cache[url];
  _cache[url] = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
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

export async function loadPlyr() {
  if (typeof Plyr !== 'undefined') return;
  // Load script + stylesheet in parallel; both are required before instantiating Plyr.
  await Promise.all([
    loadScript('https://cdn.plyr.io/3.8.4/plyr.polyfilled.js'),
    loadStylesheet('https://cdn.plyr.io/3.8.4/plyr.css'),
  ]);
}

