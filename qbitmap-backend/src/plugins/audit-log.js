/**
 * Audit log — async onResponse hook that records auth, admin, and
 * mutating-method requests into the `audit_log` MySQL table. Each row
 * captures who (user_id, ip, ua), what (method, path, action, target),
 * and the outcome (status_code, success, payload_hash). The hook is
 * non-blocking from the client's perspective: failures inside the hook
 * are logged but never bubble up to the response.
 *
 * Coverage filter is intentionally narrow — GETs and high-volume
 * read-only endpoints (status, health, public catalogs) would drown the
 * table without adding investigative value. Add new prefixes here as
 * features warrant audit trails.
 */
const crypto = require('node:crypto');
const fp = require('fastify-plugin');
const { extractToken, verifyToken } = require('../utils/jwt');
const db = require('../services/database');
const logger = require('../utils/logger').child({ module: 'audit-log' });

const AUDIT_PATH_PREFIXES = ['/api/admin/', '/api/auth/', '/auth/'];
const AUDIT_METHODS = new Set(['DELETE', 'PUT', 'PATCH', 'POST']);

function shouldAudit(method, path) {
  if (AUDIT_PATH_PREFIXES.some((p) => path.startsWith(p))) return true;
  // POST elsewhere is mostly content-creation; PUT/PATCH/DELETE are
  // mutating. Filter is broad enough to cover most security-relevant
  // surface without storing every WebSocket heartbeat.
  if (AUDIT_METHODS.has(method) && path.startsWith('/api/')) return true;
  return false;
}

function deriveActionLabel(method, path) {
  // Normalize numeric ids and uuids so distinct records collapse onto
  // the same "action": e.g. DELETE_/api/users/cameras/_id_ instead of
  // 8000 unique action strings. Helpful for SELECT count(*) GROUP BY action.
  const normalized = path
    .replace(/\/\d+/g, '/_id_')
    .replace(/\/[0-9a-fA-F-]{8,}/g, '/_uuid_');
  return `${method}_${normalized}`.slice(0, 64);
}

async function auditLogPlugin(fastify) {
  fastify.addHook('onResponse', async (request, reply) => {
    try {
      const url = request.url || '';
      const path = url.split('?')[0];
      const method = request.method || '';
      if (!shouldAudit(method, path)) return;

      // Prefer the value populated by authHook; fall back to a sync
      // verify on the cookie/Authorization token (cached, ~free) so
      // public routes that recognize a user opportunistically still
      // get a populated user_id.
      let userId = request.user?.userId ?? request.user?.id ?? null;
      if (userId == null) {
        try {
          const token = extractToken(request);
          if (token) {
            const decoded = verifyToken(token);
            if (decoded) userId = decoded.userId ?? null;
          }
        } catch {
          // ignore — audit log never blocks on auth lookup
        }
      }

      const ip = (request.ip || '').slice(0, 45);
      const ua = (request.headers?.['user-agent'] || '').slice(0, 255);
      const status = reply.statusCode;
      const success = status < 400 ? 1 : 0;
      const action = deriveActionLabel(method, path);
      const target = path.slice(0, 255);

      let payloadHash = null;
      const body = request.body;
      if (body && typeof body === 'object') {
        try {
          const serialized = JSON.stringify(body).slice(0, 100_000);
          payloadHash = crypto.createHash('sha256').update(serialized).digest('hex');
        } catch {
          // Circular / non-serializable body — leave hash null.
        }
      }

      await db.pool.execute(
        `INSERT INTO audit_log
          (user_id, ip, ua, method, path, action, target, success, status_code, payload_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, ip, ua, method, path.slice(0, 255), action, target, success, status, payloadHash]
      );
    } catch (err) {
      logger.error({ err }, 'audit_log insert failed');
    }
  });
}

module.exports = fp(auditLogPlugin, {
  name: 'audit-log',
  fastify: '5.x'
});
