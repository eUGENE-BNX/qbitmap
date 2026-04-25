import { registerSW } from 'virtual:pwa-register';

let updateSW = null;
let silentUpdateWired = false;

/**
 * Hook up the service worker and wire the "refresh to update" toast on
 * `onNeedRefresh`. Runs lazily — Vite's `virtual:pwa-register` module is
 * a no-op in dev.
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
        wireSilentUpdate();
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

// Apply a pending SW update silently when the tab is hidden AND no live
// camera stream is active AND no upload is mid-flight. Users often watch
// live cameras for hours and never click the toast — this lets a new
// version take effect on the next foreground without disrupting anything.
function wireSilentUpdate() {
  if (silentUpdateWired) return;
  silentUpdateWired = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (document.querySelector('.camera-frame-container.loaded')) return;
    if (window.__qbitmapUploadInFlight) return;
    updateSW?.(true);
  }, { passive: true });
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
    '<span class="pwa-update-text">Yeni sürüm hazır!</span>' +
    '<button type="button" class="pwa-update-refresh">Güncelle</button>' +
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
