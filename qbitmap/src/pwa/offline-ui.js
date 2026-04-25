import { showNotification } from '../../js/utils.js';

// Sticky offline indicator + transient toast on online/offline transitions.
//
// Layered detection:
//   1. Trust `navigator.onLine === true` — false-positive offline reports
//      from the browser are the bug we're working around, but the API is
//      reliable in the *true* direction.
//   2. When the browser claims we're offline, double-check with a real
//      network probe before flipping UI. The probe must not fail-close,
//      so any HTTP response (including 4xx/5xx) is treated as proof of
//      connectivity. Only a thrown error / timeout means truly offline.
//   3. While offline, re-probe periodically so the badge clears on its
//      own once connectivity returns, even if the OS never fires a fresh
//      `online` event (common on Linux after suspend/resume).

// Same-origin static file Caddy always serves with no-cache headers in
// production. `/health` only exists on stream.qbitmap.com — qbitmap.com
// 404s on it.
const PROBE_URL = '/manifest.webmanifest';
const PROBE_TIMEOUT_MS = 6000;
const PROBE_RETRY_MS = 15000;

async function probe() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    // GET (not HEAD) — some intermediates handle HEAD inconsistently.
    // Cache-buster query keeps Workbox precache from matching (precache
    // ignores marketing params only, not arbitrary ones), and
    // cache:'no-store' tells the browser HTTP cache to skip too.
    const res = await fetch(`${PROBE_URL}?_p=${Date.now()}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: ctrl.signal,
    });
    clearTimeout(t);
    // Any HTTP response — even 4xx/5xx — proves connectivity. A thrown
    // TypeError (network error) or AbortError implies offline.
    return res.status >= 200 && res.status < 600;
  } catch {
    return false;
  }
}

export function initOfflineUI() {
  if (typeof window === 'undefined') return;

  const badge = document.createElement('div');
  badge.id = 'pwa-offline-badge';
  badge.className = 'pwa-offline-badge';
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'polite');
  badge.textContent = 'Çevrimdışı';
  badge.hidden = true;

  if (document.body) {
    document.body.appendChild(badge);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      document.body.appendChild(badge);
    }, { once: true });
  }

  // Optimistic default — assume online and only flip on confirmed offline.
  let online = true;
  let retryTimer = null;
  let inFlight = false;

  function showOffline(silent) {
    if (!online) return;
    online = false;
    badge.hidden = false;
    startRetry();
    if (!silent) {
      showNotification?.('Bağlantı koptu', 'error', 4000);
      window.dispatchEvent(new CustomEvent('qbitmap:offline'));
    }
  }

  function showOnline(silent) {
    if (online) return;
    online = true;
    badge.hidden = true;
    stopRetry();
    if (!silent) {
      showNotification?.('Bağlantı geri geldi', 'success', 3000);
      window.dispatchEvent(new CustomEvent('qbitmap:online'));
    }
  }

  function startRetry() {
    if (retryTimer) return;
    retryTimer = setInterval(verifyOnline, PROBE_RETRY_MS);
  }
  function stopRetry() {
    if (!retryTimer) return;
    clearInterval(retryTimer);
    retryTimer = null;
  }

  // Re-probe while in offline state to detect when connectivity returns.
  async function verifyOnline() {
    if (inFlight) return;
    inFlight = true;
    try {
      if (await probe()) showOnline(false);
    } finally {
      inFlight = false;
    }
  }

  // Browser says we lost the network — confirm with a probe before
  // flipping the UI. Don't trust `navigator.onLine === false` blindly.
  async function handleOfflineEvent() {
    if (inFlight) return;
    inFlight = true;
    try {
      const reachable = await probe();
      if (!reachable) showOffline(false);
      // If reachable, the browser was wrong — stay online silently.
    } finally {
      inFlight = false;
    }
  }

  // Browser says we're back online — trust it. Hide badge immediately.
  function handleOnlineEvent() {
    showOnline(false);
  }

  window.addEventListener('online', handleOnlineEvent);
  window.addEventListener('offline', handleOfflineEvent);

  // If the browser already claims offline at boot, verify before showing
  // the badge. We DO NOT probe when navigator.onLine === true — that's
  // the optimistic default and avoids false positives if the probe URL
  // is briefly unreachable (DNS warming, etc).
  if (navigator.onLine === false) {
    handleOfflineEvent();
  }
}
