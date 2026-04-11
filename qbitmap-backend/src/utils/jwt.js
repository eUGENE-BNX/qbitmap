const jwt = require('jsonwebtoken');
const { LRUCache } = require('lru-cache');
const config = require('../config');

// Token verification cache for performance (80-90% faster auth).
// LRU + TTL: bursts of unique tokens evict cold entries instead of warm ones.
const TOKEN_CACHE_TTL = 60_000;     // 1 minute
const TOKEN_CACHE_MAX_SIZE = 10_000;

const tokenCache = new LRUCache({
  max: TOKEN_CACHE_MAX_SIZE,
  ttl: TOKEN_CACHE_TTL,
  // Don't extend TTL on each get — JWT freshness is what matters, not recency.
  updateAgeOnGet: false,
  updateAgeOnHas: false
});

// [SEC-01] Per-user token_version cache. authHook compares the cached DB
// version against the JWT's tokenVersion claim on EVERY request (even cache
// hits), so a revocation (logout / admin deactivation) propagates across all
// workers within VERSION_CACHE_TTL instead of lingering for 7 days.
const VERSION_CACHE_TTL = 30_000;    // 30 seconds — max cross-process revocation delay
const VERSION_CACHE_MAX_SIZE = 10_000;

const userVersionCache = new LRUCache({
  max: VERSION_CACHE_MAX_SIZE,
  ttl: VERSION_CACHE_TTL,
  updateAgeOnGet: false,
  updateAgeOnHas: false
});

/**
 * Cleanup token cache (call on server shutdown)
 */
function cleanupTokenCache() {
  tokenCache.clear();
  userVersionCache.clear();
}

/**
 * Generate JWT token for user
 */
function generateToken(user) {
  const payload = {
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    // [SEC-01] Stamp token with user's current version. Bumping the DB value
    // (logout / deactivation) invalidates every JWT that still carries the old
    // number, even if the JWT's cryptographic expiry is days away.
    tokenVersion: user.token_version ?? 1
  };

  // [SEC-08] Pin the signing algorithm explicitly. jsonwebtoken@9.x's
  // default is already HS256, but a future upgrade or accidental header
  // override could silently introduce a weaker / attacker-controlled
  // algorithm. Keeping this value locked means verifyToken's algorithms
  // allow-list stays in sync with what we actually issue.
  return jwt.sign(payload, config.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: config.jwt.expiresIn
  });
}

/**
 * Verify and decode JWT token
 */
function verifyToken(token) {
  try {
    // [SEC-08] Pinning `algorithms` blocks the classic "alg: none" and
    // HS256-verified-as-RS256 downgrade attacks. Without this allow-list,
    // jsonwebtoken falls back to whatever the token header asks for.
    return jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256']
    });
  } catch (error) {
    return null;
  }
}

/**
 * [SEC-01] Fetch the current token_version for a user, cached for
 * VERSION_CACHE_TTL to keep the hot path off the DB. Lazy-require to avoid
 * a circular dep between utils/jwt and services/db.
 */
async function getCurrentTokenVersion(userId) {
  const cached = userVersionCache.get(userId);
  if (cached !== undefined) return cached;

  const db = require('../services/database');
  const [rows] = await db.pool.execute(
    'SELECT token_version FROM users WHERE id = ?',
    [userId]
  );
  // Missing user → return a sentinel (-1) that cannot match any JWT claim,
  // so authHook rejects the token instead of admitting the caller.
  const version = rows[0]?.token_version ?? -1;
  userVersionCache.set(userId, version);
  return version;
}

/**
 * [SEC-01] Drop a user's cached version so the next authHook call sees the
 * fresh DB value. Call this on the worker that just bumped token_version;
 * other workers will catch up within VERSION_CACHE_TTL.
 */
function invalidateUserVersionCache(userId) {
  userVersionCache.delete(userId);
}

/**
 * Extract token from cookie or Authorization header
 */
function extractToken(authHeaderOrRequest) {
  // If request object passed, check cookie first
  if (authHeaderOrRequest && typeof authHeaderOrRequest === 'object') {
    const request = authHeaderOrRequest;
    // Check cookie first
    if (request.cookies && request.cookies.qbitmap_token) {
      return request.cookies.qbitmap_token;
    }
    // Fallback to Authorization header
    const authHeader = request.headers && request.headers.authorization;
    return extractFromHeader(authHeader);
  }
  // Legacy: string authorization header
  return extractFromHeader(authHeaderOrRequest);
}

function extractFromHeader(authHeader) {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }
  return parts[1];
}

/**
 * [SEC-01] Verify a token's signature AND that its tokenVersion claim still
 * matches the DB. Returns the decoded payload, or null if the token is
 * invalid, expired, or revoked. Use this wherever you need a full auth check
 * outside the Fastify authHook (e.g., WebSocket upgrade).
 */
async function verifyTokenWithVersion(token) {
  const decoded = verifyToken(token);
  if (!decoded) return null;
  const currentVersion = await getCurrentTokenVersion(decoded.userId);
  if ((decoded.tokenVersion ?? 1) !== currentVersion) return null;
  return decoded;
}

/**
 * Fastify auth hook - adds user to request if valid token
 * Uses caching to avoid repeated JWT verification (CPU-intensive)
 */
async function authHook(request, reply) {
  const token = extractToken(request);

  if (!token) {
    return reply.code(401).send({ error: 'No token provided' });
  }

  // Check cache first (LRU handles TTL + size eviction internally)
  let decoded = tokenCache.get(token);
  if (!decoded) {
    decoded = verifyToken(token);
    if (!decoded) {
      return reply.code(401).send({ error: 'Invalid or expired token' });
    }
    tokenCache.set(token, decoded);
  }

  // [SEC-01] Always check token_version — even on cache hits — so revocations
  // propagate within VERSION_CACHE_TTL instead of waiting out the token cache.
  const currentVersion = await getCurrentTokenVersion(decoded.userId);
  if ((decoded.tokenVersion ?? 1) !== currentVersion) {
    tokenCache.delete(token);
    return reply.code(401).send({ error: 'Token revoked' });
  }

  request.user = decoded;
}

/**
 * Optional auth hook - adds user to request if token exists, but doesn't require it
 */
async function optionalAuthHook(request, reply) {
  const token = extractToken(request);

  if (token) {
    const decoded = await verifyTokenWithVersion(token);
    if (decoded) {
      request.user = decoded;
    }
  }
}

/**
 * Invalidate a specific token from the cache (used on logout)
 */
function invalidateTokenCache(token) {
  tokenCache.delete(token);
}

module.exports = {
  generateToken,
  verifyToken,
  verifyTokenWithVersion,
  extractToken,
  authHook,
  optionalAuthHook,
  cleanupTokenCache,
  invalidateTokenCache,
  invalidateUserVersionCache
};
