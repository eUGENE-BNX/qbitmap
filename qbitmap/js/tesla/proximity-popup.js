// Tesla proximity alert popup. Self-registers a WebSocket message listener
// via CameraSystem's shared connection so alerts arrive even when the Tesla
// map layer is hidden. The actual modal UI is inlined here — no extra CSS
// file needed; styles are scoped to the injected root element.

import { CameraSystem } from '../camera-system/index.js';

let _listenerAttached = false;
let _muteUntil = 0;
let _injected = null;

function ensureElement() {
  if (_injected) return _injected;

  const root = document.createElement('div');
  root.id = 'tesla-proximity-modal';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-live', 'polite');
  root.style.cssText = [
    'position:fixed', 'right:20px', 'bottom:24px', 'z-index:9999',
    'max-width:320px', 'padding:14px 16px', 'border-radius:14px',
    'background:linear-gradient(135deg,#0f172a,#1e293b)',
    'color:#e2e8f0', 'box-shadow:0 18px 48px rgba(15,23,42,0.45)',
    'border:1px solid rgba(148,163,184,0.25)',
    'font-family:inherit', 'font-size:14px', 'display:none',
    'transform:translateY(12px)', 'opacity:0',
    'transition:opacity .28s ease, transform .28s ease',
  ].join(';');

  root.innerHTML = `
    <div style="display:flex;gap:12px;align-items:flex-start;">
      <div class="tpm-avatar" style="flex-shrink:0;width:44px;height:44px;border-radius:50%;background:#334155;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#cbd5f5;font-weight:600;font-size:18px;">?</div>
      <div style="flex:1;min-width:0;">
        <div style="color:#f8fafc;font-weight:600;margin-bottom:2px;" class="tpm-title">Tesla yakınınızda</div>
        <div class="tpm-line" style="color:#cbd5e1;font-size:13px;line-height:1.35;"></div>
      </div>
      <button type="button" class="tpm-close" aria-label="Kapat" style="background:none;border:none;color:#94a3b8;font-size:18px;line-height:1;cursor:pointer;padding:2px 4px;">×</button>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      <button type="button" class="tpm-mute" style="background:transparent;border:1px solid rgba(148,163,184,0.4);color:#cbd5e1;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px;">Sustur 1sa</button>
      <button type="button" class="tpm-ok" style="background:#38bdf8;border:none;color:#0f172a;border-radius:8px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:600;">Tamam</button>
    </div>
  `;

  document.body.appendChild(root);

  const hide = () => {
    root.style.opacity = '0';
    root.style.transform = 'translateY(12px)';
    setTimeout(() => { root.style.display = 'none'; }, 260);
  };

  root.querySelector('.tpm-close').addEventListener('click', hide);
  root.querySelector('.tpm-ok').addEventListener('click', hide);
  root.querySelector('.tpm-mute').addEventListener('click', () => {
    _muteUntil = Date.now() + 60 * 60 * 1000;
    hide();
  });

  _injected = root;
  return root;
}

export const TeslaProximityPopup = {
  show(payload) {
    if (Date.now() < _muteUntil) return;
    if (!payload) return;

    const root = ensureElement();
    const avatar = root.querySelector('.tpm-avatar');
    const line = root.querySelector('.tpm-line');

    avatar.textContent = '';
    if (payload.contactAvatar) {
      const img = document.createElement('img');
      img.src = payload.contactAvatar;
      img.alt = '';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      avatar.appendChild(img);
    } else {
      avatar.textContent = (payload.contactName || '?').charAt(0).toUpperCase();
    }

    const name = payload.contactName || 'Paylaştığınız kişi';
    const car = payload.vehicleDisplayName ? ` (${payload.vehicleDisplayName})` : '';
    const meters = Number.isFinite(payload.distanceMeters) ? payload.distanceMeters : '?';
    line.textContent = `${name}${car} yakınınızda — yaklaşık ${meters}m`;

    root.style.display = 'block';
    requestAnimationFrame(() => {
      root.style.opacity = '1';
      root.style.transform = 'translateY(0)';
    });
  },

  // Attach a WS message listener that works even when the Tesla layer is
  // hidden. Safe to call repeatedly — only the first call attaches.
  init() {
    if (_listenerAttached) return;

    const tryAttach = () => {
      const ws = CameraSystem?.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg?.type === 'tesla_proximity_alert') {
            this.show(msg.payload);
          }
        } catch { /* non-json */ }
      });
      _listenerAttached = true;
      return true;
    };

    if (tryAttach()) return;
    // The shared camera WS hasn't connected yet. Poll briefly; stop once
    // attached or after a minute of idle retries (user likely not signed in).
    let tries = 0;
    const interval = setInterval(() => {
      tries++;
      if (tryAttach() || tries > 60) clearInterval(interval);
    }, 1000);
  },
};
