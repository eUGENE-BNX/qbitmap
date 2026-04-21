// PWA manifest shortcut dispatcher.
//
// Android long-press on the app icon surfaces the shortcuts defined in
// manifest.webmanifest. Each shortcut opens the app at `/?sc=<target>`;
// this module reads the query param and triggers the matching feature
// once the auth-dependent UI has mounted.
//
// Buttons referenced below render after `auth.js` hydrates the user
// menu, which can take a few hundred ms. We poll instead of listening
// on a specific event so the call-sites stay loosely coupled.

const SC_BUTTON_MAP = {
  cams: 'mycameras-menu-btn',
  vmsg: 'video-msg-button',
  video: 'video-msg-button',
  photo: 'photo-msg-button',
  broadcast: 'broadcast-dropdown-item',
};

export function initShortcuts() {
  if (typeof window === 'undefined') return;

  let sc;
  try {
    sc = new URLSearchParams(window.location.search).get('sc');
  } catch { sc = null; }
  if (!sc || !SC_BUTTON_MAP[sc]) return;

  // Strip `?sc=...` so a reload doesn't keep re-firing the shortcut.
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('sc');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch { /* noop */ }

  const btnId = SC_BUTTON_MAP[sc];
  const deadline = Date.now() + 10_000; // give auth up to 10s to mount

  const tick = () => {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.click();
      return;
    }
    if (Date.now() < deadline) {
      setTimeout(tick, 250);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick, { once: true });
  } else {
    tick();
  }
}
