/* global clients */
import { cleanupOutdatedCaches, precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute, setCatchHandler } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

import { parseRangeHeader } from './range-utils.js';

// [PWA-02] Speed up cold starts — parallelize the first network request
// with service-worker boot.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

// Skip-waiting message from register-sw.js (used by the refresh toast).
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
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
    cacheName: 'vendor-v1',
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
    cacheName: 'map-style-v1',
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
    cacheName: 'map-fonts-v1',
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
    cacheName: 'map-sprites-v1',
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
    cacheName: 'uploads-v1',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 7 * 24 * 60 * 60 }),
    ],
  }),
);

// Public config/data GETs — dashboards feel instant, revalidate quietly.
registerRoute(
  ({ url, request }) =>
    request.method === 'GET' && url.pathname.startsWith('/api/public/'),
  new StaleWhileRevalidate({
    cacheName: 'api-public-v1',
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

async function pmtilesHandler({ request }) {
  const cache = await caches.open('pmtiles-v1');
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
  } = data;

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body,
        icon,
        badge,
        tag,
        image,
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
