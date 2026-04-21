// Frontend Web Push helpers. Exports `enablePush`, `disablePush`, and
// `getPushState` — bound to a profile-menu toggle (see profile/index.js).
// The subscribe flow is strictly user-initiated: Safari rejects any
// PushManager.subscribe() that isn't tied to a gesture on the tab.

import { showNotification } from '../../js/utils.js';

const ua = navigator.userAgent || '';
const isIOS = /iPad|iPhone|iPod/.test(ua) && !('MSStream' in window);
const isStandalone =
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported() {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  );
}

export async function getPushState() {
  if (!pushSupported()) return { supported: false, subscribed: false, permission: 'unsupported' };
  const permission = Notification.permission;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return {
      supported: true,
      subscribed: Boolean(sub),
      permission,
      iosStandaloneRequired: isIOS && !isStandalone,
    };
  } catch {
    return { supported: true, subscribed: false, permission };
  }
}

async function fetchVapidPublicKey() {
  const r = await fetch('/api/push/vapid-public-key', {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) throw new Error('vapid key fetch failed: ' + r.status);
  const data = await r.json();
  if (!data?.publicKey) throw new Error('server has no VAPID key configured');
  return data.publicKey;
}

export async function enablePush() {
  if (!pushSupported()) {
    showNotification?.('Bu tarayıcı bildirimleri desteklemiyor', 'error', 4000);
    return { ok: false, reason: 'unsupported' };
  }
  if (isIOS && !isStandalone) {
    showNotification?.(
      'iOS\'ta bildirim için önce uygulamayı ana ekrana ekleyin',
      'info',
      5000
    );
    return { ok: false, reason: 'ios-needs-install' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, reason: 'permission-denied' };
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      const publicKey = await fetchVapidPublicKey();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    } catch (err) {
      console.error('[push] subscribe failed', err);
      showNotification?.('Bildirim kaydı başarısız', 'error', 4000);
      return { ok: false, reason: 'subscribe-failed' };
    }
  }

  const resp = await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!resp.ok) {
    console.warn('[push] server rejected subscription', resp.status);
    return { ok: false, reason: 'server-rejected' };
  }
  showNotification?.('Bildirimler aktif', 'success', 3000);
  return { ok: true };
}

export async function disablePush() {
  if (!pushSupported()) return { ok: false };
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return { ok: true, alreadyOff: true };

  // Best-effort server cleanup (don't fail user action if network is down).
  try {
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch { /* offline — server will age it out via 410 on next push */ }

  await sub.unsubscribe();
  showNotification?.('Bildirimler kapatıldı', 'info', 3000);
  return { ok: true };
}

export async function sendTestPush() {
  const r = await fetch('/api/push/test', { method: 'POST', credentials: 'include' });
  return r.ok;
}
