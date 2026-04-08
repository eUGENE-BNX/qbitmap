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

/**
 * Cleanup token cache (call on server shutdown)
 */
function cleanupTokenCache() {
  tokenCache.clear();
}

/**
 * Generate JWT token for user
 */
function generateToken(user) {
  const payload = {
    userId: user.id,
    email: user.email,
    displayName: user.display_name
  };

  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn
  });
}

/**
 * Verify and decode JWT token
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch (error) {
    return null;
  }
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
 * Fastify auth hook - adds user to request if valid token
 * Uses caching to avoid repeated JWT verification (CPU-intensive)
 */
async function authHook(request, reply) {
  const token = extractToken(request);

  if (!token) {
    return reply.code(401).send({ error: 'No token provided' });
  }

  // Check cache first (LRU handles TTL + size eviction internally)
  const cached = tokenCache.get(token);
  if (cached) {
    request.user = cached;
    return;
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return reply.code(401).send({ error: 'Invalid or expired token' });
  }

  tokenCache.set(token, decoded);
  request.user = decoded;
}

/**
 * Optional auth hook - adds user to request if token exists, but doesn't require it
 */
async function optionalAuthHook(request, reply) {
  const token = extractToken(request);

  if (token) {
    const decoded = verifyToken(token);
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
  extractToken,
  authHook,
  optionalAuthHook,
  cleanupTokenCache,
  invalidateTokenCache
};