import { registerSW } from 'virtual:pwa-register';
import { showNotification } from '../../js/utils.js';

let updateSW = null;

/**
 * Hook up the service worker and wire two prompts:
 *   - "refresh to update" toast on `onNeedRefresh`
 *   - transient "offline ready" toast on `onOfflineReady`
 * Runs lazily — Vite's `virtual:pwa-register` module is a no-op in dev.
 */
export function initServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  try {
    updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        showUpdateToast();
      },
      onOfflineReady() {
        showNotification?.('Çevrimdışı kullanıma hazır', 'info', 3000);
      },
      onRegisteredSW(_url, registration) {
        // Hourly update check — users leave tabs open for days.
        if (registration) {
          setInterval(() => {
            registration.update().catch(() => {});
          }, 60 * 60 * 1000);
        }
      },
    });
  } catch (err) {
    console.warn('[pwa] SW register failed', err);
  }

  // Notification click from the SW → jump the map to the target.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'push:navigate') return;
    const target = event.data.target;
    if (!target || typeof target !== 'string') return;
    try {
      const url = new URL(target, window.location.origin);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) {
        window.location.hash = url.hash || '';
      } else {
        window.location.href = url.pathname + url.search + url.hash;
      }
    } catch {
      /* ignore malformed push target */
    }
  });

  // Clear app badge when the user returns to the tab.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      navigator.clearAppBadge?.().catch(() => {});
    }
  });
}

function showUpdateToast() {
  // Persistent, two-button toast. Users often watch a live camera, so
  // the refresh must be opt-in — never auto-reload.
  let el = document.getElementById('pwa-update-toast');
  if (el) return;
  el = document.createElement('div');
  el.id = 'pwa-update-toast';
  el.className = 'pwa-update-toast';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML =
    '<span class="pwa-update-text">Yeni sürüm hazır.</span>' +
    '<button type="button" class="pwa-update-refresh">Yenile</button>' +
    '<button type="button" class="pwa-update-dismiss" aria-label="Kapat">Sonra</button>';
  document.body.appendChild(el);
  el.querySelector('.pwa-update-refresh').addEventListener('click', () => {
    el.remove();
    updateSW?.(true);
  });
  el.querySelector('.pwa-update-dismiss').addEventListener('click', () => {
    el.remove();
  });
}
