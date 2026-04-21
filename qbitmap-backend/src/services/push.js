// Web Push dispatcher. Wraps the `web-push` library with VAPID config and
// auto-prunes subscriptions that the browser has revoked (404/410 from the
// push gateway). Callers are WebSocket broadcast sites — face-absence
// alarms, ONVIF AI alarms — which call sendToUser() alongside the existing
// WS broadcast. A user with an open tab receives the WS payload first; a
// user with the tab closed only ever sees the push.

const webpush = require('web-push');
const config = require('../config');
const db = require('./database');
const logger = require('../utils/logger').child({ module: 'push' });
const metrics = require('./metrics');

let configured = false;

// Only URLs on Qbitmap-controlled origins may appear as notification
// artwork. The OS / browser fetches these URLs when rendering the tray
// entry, so an attacker-controlled `image` would turn a push into a
// notification-gateway-driven SSRF-like probe. All current callers
// already build URLs on stream.qbitmap.com / qbitmap.com; this is a
// defense-in-depth filter for any future call-site that forgets.
const ALLOWED_IMAGE_HOSTS = new Set([
  'qbitmap.com',
  'stream.qbitmap.com',
  'hls.qbitmap.com',
  'static.qbitmap.com'
]);

function sanitizeImageUrl(u) {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return undefined;
    return ALLOWED_IMAGE_HOSTS.has(url.hostname) ? u : undefined;
  } catch { return undefined; }
}

// web-push has no built-in timeout. A slow / stuck gateway would let
// sendNotification hang for a long time, which for the alarm cron path
// means stacking Promise.allSettled awaits across successive ticks.
const SEND_TIMEOUT_MS = 10_000;

function sendWithTimeout(sub, body, options) {
  let timer;
  return Promise.race([
    webpush.sendNotification(sub, body, options),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('push send timeout');
        err.statusCode = 0;
        err.timeout = true;
        reject(err);
      }, SEND_TIMEOUT_MS);
    })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function ensureConfigured() {
  if (configured) return true;
  const { publicKey, privateKey, subject } = config.vapid;
  if (!publicKey || !privateKey) {
    logger.warn('VAPID keys not configured — push disabled. Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY.');
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

async function saveSubscription(userId, sub, userAgent) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    throw new Error('Invalid subscription payload');
  }
  await db.pool.execute(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth_secret, user_agent, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       p256dh = VALUES(p256dh),
       auth_secret = VALUES(auth_secret),
       user_agent = VALUES(user_agent),
       last_seen_at = NOW()`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent || null]
  );
}

async function removeSubscription(userId, endpoint) {
  await db.pool.execute(
    'DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?',
    [userId, endpoint]
  );
}

async function removeSubscriptionById(id) {
  await db.pool.execute('DELETE FROM push_subscriptions WHERE id = ?', [id]);
}

async function listForUser(userId) {
  const [rows] = await db.pool.execute(
    'SELECT id, endpoint, p256dh, auth_secret FROM push_subscriptions WHERE user_id = ?',
    [userId]
  );
  return rows;
}

// Fire-and-forget send to every subscription belonging to `userId`.
// Returns {sent, failed, expired}. Never throws — callers are on hot
// alarm paths and must not be blocked by push errors.
async function sendToUser(userId, payload) {
  if (!ensureConfigured()) {
    metrics.pushSentTotal?.inc({ status: 'skipped' });
    return { sent: 0, failed: 0, expired: 0, skipped: true };
  }
  let subs;
  try {
    subs = await listForUser(userId);
  } catch (err) {
    logger.error({ err: err.message, userId }, 'failed to load subscriptions');
    return { sent: 0, failed: 0, expired: 0, error: true };
  }
  if (!subs.length) return { sent: 0, failed: 0, expired: 0 };

  // Sanitize notification artwork URLs before serializing. The browser
  // fetches these on the user's device, so whitelist to our own origins.
  const safePayload = (payload && typeof payload === 'object')
    ? {
        ...payload,
        image: sanitizeImageUrl(payload.image),
        icon: sanitizeImageUrl(payload.icon),
        badge: sanitizeImageUrl(payload.badge),
      }
    : payload;

  const body = typeof safePayload === 'string' ? safePayload : JSON.stringify(safePayload);
  const options = {
    TTL: safePayload?.ttl ?? 60,
    urgency: safePayload?.urgency || 'normal',
  };
  if (safePayload?.topic) options.topic = safePayload.topic;

  let sent = 0;
  let failed = 0;
  let expired = 0;

  await Promise.allSettled(
    subs.map(async (s) => {
      const subscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth_secret },
      };
      const endTimer = metrics.pushSendDuration?.startTimer({ result: 'pending' });
      try {
        await sendWithTimeout(subscription, body, options);
        sent += 1;
        endTimer?.({ result: 'sent' });
        metrics.pushSentTotal?.inc({ status: 'sent' });
        await db.pool.execute(
          'UPDATE push_subscriptions SET last_seen_at = NOW() WHERE id = ?',
          [s.id]
        );
      } catch (err) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          expired += 1;
          endTimer?.({ result: 'expired' });
          metrics.pushSentTotal?.inc({ status: 'expired' });
          try { await removeSubscriptionById(s.id); } catch { /* noop */ }
        } else if (err?.timeout) {
          failed += 1;
          endTimer?.({ result: 'timeout' });
          metrics.pushSentTotal?.inc({ status: 'timeout' });
          logger.warn({ userId, subId: s.id }, 'push send timed out');
        } else {
          failed += 1;
          endTimer?.({ result: 'failed' });
          metrics.pushSentTotal?.inc({ status: 'failed' });
          logger.warn(
            { err: err.message, status, userId, subId: s.id },
            'push send failed'
          );
        }
      }
    })
  );

  return { sent, failed, expired };
}

module.exports = {
  ensureConfigured,
  saveSubscription,
  removeSubscription,
  listForUser,
  sendToUser,
  getPublicKey: () => config.vapid.publicKey,
};
