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

export async function loadHls() {
  if (typeof Hls !== 'undefined') return;
  await loadScript('/vendor/hls.min.js');
}

export async function loadDeckAndH3() {
  if (typeof deck !== 'undefined' && typeof h3 !== 'undefined') return;
  // h3-js must load first — deck.gl captures globalThis.h3 at init time
  if (typeof h3 === 'undefined') await loadScript('/vendor/h3-js.umd.js');
  if (typeof deck === 'undefined') await loadScript('/vendor/deck.gl.min.js');
}

export async function loadProtobuf() {
  if (typeof protobuf !== 'undefined') return;
  await loadScript('/vendor/protobuf.min.js');
}
