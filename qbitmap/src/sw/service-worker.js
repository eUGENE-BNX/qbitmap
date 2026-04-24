/* global clients */
import { cleanupOutdatedCaches, precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute, setCatchHandler } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

import { parseRangeHeader } from './range-utils.js';
import { shareInboxPut } from '../pwa/idb-share-inbox.js';

// Runtime cache names. Bump the trailing `-vN` when the shape of what
// lives inside changes (different URL scheme, different response shape)
// — NOT for ordinary deploys. The activate handler below deletes any
// cache that matches our naming pattern but isn't in this set, so old
// versions are swept on the first SW activation after a bump.
const CACHES = Object.freeze({
  VENDOR:       'vendor-v1',
  MAP_STYLE:    'map-style-v1',
  MAP_FONTS:    'map-fonts-v1',
  MAP_SPRITES:  'map-sprites-v1',
  UPLOADS:      'uploads-v1',
  AVATAR_PROXY: 'avatar-proxy-v1',
  API_PUBLIC:   'api-public-v1',
  PMTILES:      'pmtiles-v1',
});
const CACHE_NAMES = new Set(Object.values(CACHES));
// Match our own cache names only; leaves Workbox precache (`workbox-*`)
// and anything we don't own alone.
const OWNED_CACHE_RE = /^(?:vendor|map-style|map-fonts|map-sprites|uploads|avatar-proxy|api-public|pmtiles)-v\d+$/;

// [PWA-02] Speed up cold starts — parallelize the first network request
// with service-worker boot.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      // Schema cleanup: wipe runtime caches from older CACHES versions.
      // Precache cleanup is handled by cleanupOutdatedCaches() further down.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => OWNED_CACHE_RE.test(n) && !CACHE_NAMES.has(n))
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

// Skip-waiting message from register-sw.js (used by the refresh toast).
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ── Web Share Target ─────────────────────────────────────────────────────
// The PWA manifest declares share_target.action = "/share-inbox" with
// method=POST. When the OS share sheet routes a payload to us we need to
// persist it somewhere the main thread can read, because POST responses
// can't hand FormData back to the window context. Strategy: stash the
// files + metadata in IndexedDB under a freshly minted id and 303 the
// browser to a friendly GET URL that the main thread reacts to.
//
// Register BEFORE workbox route dispatch so this path wins unambiguously.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'POST') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname !== '/share-inbox') return;

  event.respondWith((async () => {
    try {
      const formData = await req.formData();
      const id = crypto.randomUUID();
      const files = formData.getAll('files').filter((f) => f && typeof f === 'object' && 'type' in f);
      await shareInboxPut(id, {
        files,
        title: String(formData.get('title') || ''),
        text: String(formData.get('text') || ''),
        url: String(formData.get('url') || ''),
        at: Date.now(),
      });
      return Response.redirect('/?share=pending&id=' + encodeURIComponent(id), 303);
    } catch (err) {
      return new Response('share ingest failed', { status: 500 });
    }
  })());
});

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation → precached index.html.
// Deny backend/API paths so they always hit the network.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [
      /^\/api\//,
      /^\/auth\//,
      /^\/whep-proxy/,
      /^\/capture\//,
      /^\/frame\//,
      /^\/tiles\//,
      /^\/uploads\//,
      /^\/admin(\.html)?$/,
      /^\/status(\.html)?$/,
    ],
  }),
);

// ── Runtime caching ──────────────────────────────────────────────────────

// Vendor bundles (maplibre, basemaps, deck.gl, hls.js) — hash-less but
// filenames are stable. CacheFirst, long expiration.
registerRoute(
  ({ url }) => url.pathname.startsWith('/vendor/'),
  new CacheFirst({
    cacheName: CACHES.VENDOR,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 365 * 24 * 60 * 60 }),
    ],
  }),
);

// MapLibre style.json / tile index JSON — small, cache-bust via new
// filename on each map refresh (currently /tiles/20260331.json etc).
registerRoute(
  ({ url }) =>
    url.pathname.startsWith('/tiles/') && url.pathname.endsWith('.json'),
  new StaleWhileRevalidate({
    cacheName: CACHES.MAP_STYLE,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 7 * 24 * 60 * 60 }),
    ],
  }),
);

// Protomaps CDN assets (fonts + sprite atlas).
registerRoute(
  ({ url }) =>
    url.origin === 'https://protomaps.github.io' &&
    url.pathname.includes('/fonts/'),
  new CacheFirst({
    cacheName: CACHES.MAP_FONTS,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 120, maxAgeSeconds: 30 * 24 * 60 * 60 }),
    ],
  }),
);
registerRoute(
  ({ url }) =>
    url.origin === 'https://protomaps.github.io' &&
    url.pathname.includes('/sprites/'),
  new CacheFirst({
    cacheName: CACHES.MAP_SPRITES,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 30 * 24 * 60 * 60 }),
    ],
  }),
);

// Backend uploads (face thumbnails, video-message posters) — revalidate
// often so freshly uploaded content shows up.
registerRoute(
  ({ url }) => url.pathname.startsWith('/uploads/'),
  new StaleWhileRevalidate({
    cacheName: CACHES.UPLOADS,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 7 * 24 * 60 * 60 }),
    ],
  }),
);

// Image proxy (Google avatars etc.) — long-lived per-URL, must not evict
// small public-JSON entries. One entry per proxied image URL; 500 slots
// is roughly "most of your network's avatars".
registerRoute(
  ({ url, request }) =>
    request.method === 'GET' && url.pathname === '/api/public/image-proxy',
  new CacheFirst({
    cacheName: CACHES.AVATAR_PROXY,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 7 * 24 * 60 * 60 }),
    ],
  }),
);

// Public config/data GETs — dashboards feel instant, revalidate quietly.
// image-proxy handled separately above so avatar churn doesn't evict
// actual JSON responses.
registerRoute(
  ({ url, request }) =>
    request.method === 'GET' &&
    url.pathname.startsWith('/api/public/') &&
    url.pathname !== '/api/public/image-proxy',
  new StaleWhileRevalidate({
    cacheName: CACHES.API_PUBLIC,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 80, maxAgeSeconds: 5 * 60 }),
    ],
  }),
);

// Auth / mutation / stream / admin APIs — never cache.
registerRoute(
  ({ url }) =>
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/whep-proxy') ||
    url.pathname.startsWith('/capture/') ||
    url.pathname.startsWith('/frame/'),
  new NetworkOnly(),
);

// HLS playlists + segments — handled by MediaMTX, keep them on the wire.
registerRoute(
  ({ url }) => url.hostname === 'hls.qbitmap.com',
  new NetworkOnly(),
);

// ── PMTiles range handler ───────────────────────────────────────────────
// Chrome & Firefox don't persistent-cache HTTP Range responses.
// Store the whole .pmtiles once, slice ranges out of the cached buffer.
// See plan Faz 7 for details.
registerRoute(
  ({ url }) =>
    url.pathname.startsWith('/tiles/') && url.pathname.endsWith('.pmtiles'),
  pmtilesHandler,
);

// Max .pmtiles files kept simultaneously. TR + Ataşehir + Sincan typically
// uses 3; one slot of headroom. FIFO eviction by cache insertion order —
// not true LRU, but enough for this small working set.
const PMTILES_MAX_ENTRIES = 4;

async function pmtilesHandler({ request }) {
  const cache = await caches.open(CACHES.PMTILES);
  const cacheKey = new Request(request.url, { method: 'GET' });
  let full = await cache.match(cacheKey);

  if (!full) {
    // Fetch the entire file once. Server must not return 206 when no
    // Range header is sent — if it does, fall back to passthrough.
    const fetchReq = new Request(request.url, { method: 'GET' });
    const resp = await fetch(fetchReq);
    if (!resp.ok || resp.status === 206) return resp;

    try {
      const contentLen = Number(resp.headers.get('content-length') || 0);
      const est = await navigator.storage?.estimate?.();
      if (est && est.quota && est.usage + contentLen > est.quota * 0.85) {
        // Skip caching to avoid quota eviction thrash.
        return resp;
      }
      // FIFO cap: drop oldest entries before growing beyond the limit.
      const existing = await cache.keys();
      const evictCount = existing.length - (PMTILES_MAX_ENTRIES - 1);
      if (evictCount > 0) {
        await Promise.all(existing.slice(0, evictCount).map((k) => cache.delete(k)));
      }
      await cache.put(cacheKey, resp.clone());
      full = resp;
    } catch {
      return resp;
    }
  }

  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) return full.clone();

  const buf = await full.clone().arrayBuffer();
  const range = parseRangeHeader(rangeHeader, buf.byteLength);
  if (!range) return full.clone();

  return new Response(buf.slice(range.start, range.end + 1), {
    status: 206,
    headers: {
      'Content-Range': `bytes ${range.start}-${range.end}/${buf.byteLength}`,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Type': 'application/vnd.pmtiles',
      'Accept-Ranges': 'bytes',
    },
  });
}

// ── Upload outbox — Background Sync handler ──────────────────────────────
// Chromium-only (Android + desktop Chrome/Edge). iOS Safari has no sync
// event; the client-side 'online' listener picks up the slack there.
// Keep the IDB schema here in lockstep with js/services/upload-outbox.js.
self.addEventListener('sync', (event) => {
  if (event.tag !== 'outbox-flush') return;
  event.waitUntil(flushOutboxFromSW());
});

const OUTBOX_DB = 'qbitmap-outbox';
const OUTBOX_STORE = 'messages';
const OUTBOX_RETRYABLE = new Set([0, 408, 429, 500, 502, 503, 504]);
const OUTBOX_MAX_ATTEMPTS = 6;

function outboxOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OUTBOX_DB, 1);
    // If the client hasn't opened this DB yet, the schema won't exist.
    // Don't try to create it here; just bail — there can't be records to drain.
    req.onupgradeneeded = () => { req.transaction?.abort?.(); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function flushOutboxFromSW() {
  let db;
  try { db = await outboxOpen(); } catch { return; }
  if (!db.objectStoreNames.contains(OUTBOX_STORE)) { db.close(); return; }

  const records = await new Promise((resolve) => {
    const r = db.transaction(OUTBOX_STORE).objectStore(OUTBOX_STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => resolve([]);
  });

  for (const record of records) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(record.fields || {})) fd.append(k, v);
    for (const f of (record.files || [])) fd.append(f.fieldName, f.blob, f.filename);

    let res;
    try { res = await fetch(record.endpoint, { method: 'POST', credentials: 'include', body: fd }); }
    catch {
      // Network is down mid-drain — let Background Sync back off by rejecting.
      db.close();
      throw new Error('sw-outbox-network');
    }

    if (res.ok) {
      await idbDelete(db, record.id);
    } else if (OUTBOX_RETRYABLE.has(res.status)) {
      await idbUpdateAttempt(db, record, `HTTP ${res.status}`);
      if ((record.attempts + 1) >= OUTBOX_MAX_ATTEMPTS) {
        await idbDelete(db, record.id);
      }
    } else {
      // Permanent failure (403/404/413 etc). Drop it.
      await idbDelete(db, record.id);
    }
  }
  db.close();
}

function idbDelete(db, id) {
  return new Promise((resolve) => {
    const r = db.transaction(OUTBOX_STORE, 'readwrite').objectStore(OUTBOX_STORE).delete(id);
    r.onsuccess = () => resolve();
    r.onerror = () => resolve();
  });
}

function idbUpdateAttempt(db, record, lastError) {
  return new Promise((resolve) => {
    const store = db.transaction(OUTBOX_STORE, 'readwrite').objectStore(OUTBOX_STORE);
    const updated = {
      ...record,
      attempts: (record.attempts || 0) + 1,
      lastTriedAt: Date.now(),
      lastError,
    };
    const r = store.put(updated);
    r.onsuccess = () => resolve();
    r.onerror = () => resolve();
  });
}

// ── Offline fallback ─────────────────────────────────────────────────────
setCatchHandler(async ({ request }) => {
  if (request.destination === 'document') {
    return (await caches.match('/offline.html')) ?? Response.error();
  }
  return Response.error();
});

// ── Push notifications ───────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { title: 'QBitmap', body: event.data?.text() ?? '' };
  }
  const {
    title = 'QBitmap',
    body = '',
    icon = '/icons/icon-192.png',
    badge = '/icons/badge-72.png',
    tag,
    navigate,
    urgency,
    image,
    suppressIfVisible = false,
  } = data;

  // Action buttons appear on Android; iOS ignores them (safe).
  // 'view' is the default click path, 'dismiss' closes without navigating.
  const actions = urgency === 'high'
    ? [{ action: 'view', title: 'Aç' }, { action: 'dismiss', title: 'Kapat' }]
    : undefined;

  event.waitUntil(
    (async () => {
      // Suppress OS notification if the user already has the app focused —
      // the in-page popup handles the same alert, so the OS notification
      // would be redundant noise. Test pushes and other always-show events
      // omit this flag so they still surface.
      if (suppressIfVisible) {
        const clients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        const anyVisible = clients.some((c) => c.visibilityState === 'visible');
        if (anyVisible) {
          return;
        }
      }

      await self.registration.showNotification(title, {
        body,
        icon,
        badge,
        tag,
        image,
        actions,
        renotify: urgency === 'high',
        requireInteraction: urgency === 'high',
        data: { navigate, receivedAt: Date.now() },
      });
      try {
        const existing = await self.registration.getNotifications();
        await navigator.setAppBadge?.(existing.length);
      } catch {
        /* badge API unsupported — silent */
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // 'dismiss' action: swipe-away equivalent. Just close + badge refresh;
  // no window focus / navigation.
  if (event.action === 'dismiss') {
    event.waitUntil((async () => {
      try {
        const existing = await self.registration.getNotifications();
        await navigator.setAppBadge?.(existing.length);
      } catch { /* noop */ }
    })());
    return;
  }

  const target = event.notification.data?.navigate || '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const c of all) {
        const url = new URL(c.url);
        if (url.origin === self.location.origin) {
          await c.focus();
          c.postMessage({ type: 'push:navigate', target });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

self.addEventListener('notificationclose', () => {
  // Let the app refresh the badge count after the user dismisses a
  // notification from the OS tray.
  (async () => {
    try {
      const existing = await self.registration.getNotifications();
      await navigator.setAppBadge?.(existing.length);
    } catch {
      /* noop */
    }
  })();
});
