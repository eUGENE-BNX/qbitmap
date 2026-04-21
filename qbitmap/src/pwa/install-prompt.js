// Platform-aware "install this app" UX.
//   Android/Chromium: capture `beforeinstallprompt`, show a custom button,
//                     only after the user has connected their first camera
//                     (non-disruptive moment).
//   iOS Safari:       no programmatic prompt exists — show a one-time modal
//                     walking through Share → "Add to Home Screen".

const DISMISS_KEY = 'qbitmap_pwa_install_dismissed_at';
const FIRST_CAM_KEY = 'qbitmap_first_cam_emitted';
const COOLDOWN_DAYS = 7;

const ua = navigator.userAgent || '';
const isIOS = /iPad|iPhone|iPod/.test(ua) && !('MSStream' in window);
const isStandalone =
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

let deferredPrompt = null;

export function initInstallPrompt() {
  if (isStandalone) return;
  if (recentlyDismissed()) return;

  // Success telemetry — works regardless of platform.
  window.addEventListener('appinstalled', () => {
    hideInstallButton();
    closeIOSModal();
    window.gtag?.('event', 'pwa_install_success');
    try {
      localStorage.removeItem(DISMISS_KEY);
    } catch { /* noop */ }
  });

  if (isIOS) {
    waitForFirstCamera(showIOSInstructionsModal);
    return;
  }

  // Chromium: stash the event, render a custom button on first-cam.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    waitForFirstCamera(showInstallButton);
  });
}

function waitForFirstCamera(cb) {
  if (localStorage.getItem(FIRST_CAM_KEY) === '1') {
    // Already seen on a previous session — defer 5 s so we don't fire
    // during app cold start.
    setTimeout(cb, 5000);
    return;
  }
  window.addEventListener('qbitmap:first-camera-connected', cb, { once: true });
}

function recentlyDismissed() {
  try {
    const ts = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (!ts) return false;
    return Date.now() - ts < COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function rememberDismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch { /* noop */ }
}

// ── Android / Chromium custom button ──────────────────────────────────────
function showInstallButton() {
  if (!deferredPrompt) return;
  let btn = document.getElementById('pwa-install-btn');
  if (btn) return;
  btn = document.createElement('button');
  btn.id = 'pwa-install-btn';
  btn.type = 'button';
  btn.className = 'pwa-install-btn';
  btn.setAttribute('aria-label', 'Uygulamayı yükle');
  btn.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
    '<span>Uygulamayı yükle</span>' +
    '<span class="pwa-install-close" aria-label="Kapat">×</span>';

  document.body.appendChild(btn);
  btn.addEventListener('click', async (ev) => {
    if (ev.target?.classList?.contains('pwa-install-close')) {
      rememberDismiss();
      hideInstallButton();
      return;
    }
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      window.gtag?.('event', 'pwa_install_outcome', { outcome });
      if (outcome === 'dismissed') rememberDismiss();
    } catch (err) {
      console.warn('[pwa] install prompt failed', err);
    } finally {
      deferredPrompt = null;
      hideInstallButton();
    }
  });
}

function hideInstallButton() {
  document.getElementById('pwa-install-btn')?.remove();
}

// ── iOS modal ────────────────────────────────────────────────────────────
function showIOSInstructionsModal() {
  if (document.getElementById('pwa-ios-modal')) return;

  const wrap = document.createElement('div');
  wrap.id = 'pwa-ios-modal';
  wrap.className = 'pwa-ios-modal';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.innerHTML = `
    <div class="pwa-ios-modal-backdrop"></div>
    <div class="pwa-ios-modal-card">
      <button type="button" class="pwa-ios-modal-close" aria-label="Kapat">×</button>
      <img class="pwa-ios-modal-logo" src="/icons/icon-192.png" alt="QBitmap">
      <h3>QBitmap'i ana ekrana ekleyin</h3>
      <p class="pwa-ios-modal-sub">Tam ekran deneyim ve bildirimler için.</p>
      <ol class="pwa-ios-modal-steps">
        <li>Safari paylaş ikonuna dokunun
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;margin-left:4px"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
        </li>
        <li>"Ana Ekrana Ekle" seçeneğini seçin</li>
        <li>"Ekle" butonuna dokunun</li>
      </ol>
      <button type="button" class="pwa-ios-modal-ok">Tamam</button>
    </div>
  `;
  document.body.appendChild(wrap);

  const close = () => {
    rememberDismiss();
    closeIOSModal();
  };
  wrap.querySelector('.pwa-ios-modal-close').addEventListener('click', close);
  wrap.querySelector('.pwa-ios-modal-ok').addEventListener('click', close);
  wrap.querySelector('.pwa-ios-modal-backdrop').addEventListener('click', close);
}

function closeIOSModal() {
  document.getElementById('pwa-ios-modal')?.remove();
}
