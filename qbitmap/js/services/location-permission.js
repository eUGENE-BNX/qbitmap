/**
 * Geolocation permission UX helpers.
 *
 * The browser's native "Allow location?" prompt appears without context,
 * which tanks accept rates. We use the Permissions API to check state
 * first and show a tiny rationale modal before triggering the native
 * prompt, plus a help banner when the user has already denied.
 *
 * Exports:
 *   queryGeolocationState()      → 'granted' | 'prompt' | 'denied' | 'unsupported'
 *   showGeolocationRationale()   → Promise<boolean>  (true = user opted in)
 *   showGeolocationDeniedHelp()  → shows transient help banner
 *   ensureGeolocationPermission() → composes the three; returns true iff
 *                                    the caller should proceed with GPS.
 */
import { escapeHtml } from '../html-escape.js';

let _inFlightRationale = null;

export async function queryGeolocationState() {
  if (!navigator.permissions?.query) return 'unsupported';
  try {
    const r = await navigator.permissions.query({ name: 'geolocation' });
    return r.state;
  } catch {
    return 'unsupported';
  }
}

export function showGeolocationRationale({
  title = 'Konumunuza ihtiyacımız var',
  reason = 'Sizi haritada göstermek ve yakınlardaki kameraları bulmak için konumunuza ihtiyacımız var. Konumunuz halka açık paylaşılmaz.',
  acceptLabel = 'Paylaş',
  declineLabel = 'Şimdi değil',
} = {}) {
  if (_inFlightRationale) return _inFlightRationale;
  _inFlightRationale = new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'geo-rationale-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'geo-rationale-title');
    overlay.innerHTML =
      '<div class="geo-rationale">' +
        `<h2 id="geo-rationale-title" class="geo-rationale-title">${escapeHtml(title)}</h2>` +
        `<p class="geo-rationale-text">${escapeHtml(reason)}</p>` +
        '<div class="geo-rationale-actions">' +
          `<button type="button" class="geo-rationale-decline">${escapeHtml(declineLabel)}</button>` +
          `<button type="button" class="geo-rationale-accept">${escapeHtml(acceptLabel)}</button>` +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    const finish = (answer) => {
      overlay.remove();
      _inFlightRationale = null;
      resolve(answer);
    };
    overlay.querySelector('.geo-rationale-accept').addEventListener('click', () => finish(true));
    overlay.querySelector('.geo-rationale-decline').addEventListener('click', () => finish(false));
    // Escape key declines
    const onKey = (e) => {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); finish(false); }
    };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.geo-rationale-accept').focus();
  });
  return _inFlightRationale;
}

export function showGeolocationDeniedHelp() {
  if (document.getElementById('geo-denied-help')) return;
  const el = document.createElement('div');
  el.id = 'geo-denied-help';
  el.className = 'geo-denied-help';
  el.setAttribute('role', 'status');
  el.innerHTML =
    '<span class="geo-denied-help-text">Konum izni verilmemiş. Adres çubuğundaki simgeden site ayarlarını açıp konum iznini değiştirebilirsiniz.</span>' +
    '<button type="button" class="geo-denied-help-dismiss" aria-label="Kapat">&times;</button>';
  document.body.appendChild(el);
  const timer = setTimeout(() => el.remove(), 9000);
  el.querySelector('.geo-denied-help-dismiss').addEventListener('click', () => {
    clearTimeout(timer);
    el.remove();
  });
}

/**
 * True iff the caller should proceed to call navigator.geolocation.
 * false means: permission is denied OR the user declined the rationale.
 */
export async function ensureGeolocationPermission(opts = {}) {
  const state = await queryGeolocationState();
  if (state === 'granted') return true;
  if (state === 'denied') {
    showGeolocationDeniedHelp();
    return false;
  }
  // 'prompt' or 'unsupported' — both benefit from a rationale before the
  // native prompt (Safari, older Chromium don't expose Permissions for
  // geolocation and return 'unsupported').
  return showGeolocationRationale(opts);
}
