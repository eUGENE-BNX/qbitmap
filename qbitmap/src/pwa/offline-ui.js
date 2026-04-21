import { showNotification } from '../../js/utils.js';

// Small persistent badge in the top-right that reflects navigator.onLine.
// Complements the transient toast — a live camera that loses signal needs
// a sticky indicator, not a 3-second dismiss.
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

  let wasOffline = !navigator.onLine;
  function update() {
    if (navigator.onLine) {
      badge.hidden = true;
      if (wasOffline) {
        showNotification?.('Bağlantı geri geldi', 'success', 3000);
        window.dispatchEvent(new CustomEvent('qbitmap:online'));
      }
      wasOffline = false;
    } else {
      badge.hidden = false;
      if (!wasOffline) {
        showNotification?.('Bağlantı koptu', 'error', 4000);
        window.dispatchEvent(new CustomEvent('qbitmap:offline'));
      }
      wasOffline = true;
    }
  }

  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}
