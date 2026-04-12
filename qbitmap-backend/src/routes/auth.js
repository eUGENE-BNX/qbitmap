const crypto = require('crypto');
const config = require('../config');
const db = require('../services/database');
const { generateToken, verifyToken, verifyTokenWithVersion, extractToken, invalidateTokenCache, invalidateUserVersionCache } = require('../utils/jwt');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const { validateBody } = require('../utils/validation');
const logger = require('../utils/logger').child({ module: 'auth' });

const isProduction = process.env.NODE_ENV === 'production';

// [SEC-11] SameSite: Strict blocks cookies on ALL cross-site navigations,
// including the OAuth callback redirect from Google/Tesla. To make login
// work, the callback no longer sets the cookie directly. Instead it stores
// a short-lived one-time auth code server-side and redirects to the
// frontend with ?auth_code=xxx. The frontend's auth.js init() detects the
// code and exchanges it via a same-site POST /auth/exchange — which IS
// allowed by Strict because both sides are *.qbitmap.com.
function getCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'test',
    sameSite: 'strict',
    path: '/',
    maxAge: 7 * 24 * 60 * 60, // 7 days
    ...(isProduction && { domain: '.qbitmap.com' })
  };
}

// [SEC-11] One-time auth code store. Codes expire after 60s and are
// single-use (deleted on exchange). The map is process-local which is fine
// for a single-process deployment; multi-process would need Redis.
const AUTH_CODE_TTL_MS = 60_000;
const pendingAuthCodes = new Map(); // code → { jwt, expiresAt }

// Cleanup expired codes every 30s
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of pendingAuthCodes) {
    if (now > entry.expiresAt) pendingAuthCodes.delete(code);
  }
}, 30_000);

function createAuthCode(jwt) {
  const code = crypto.randomBytes(32).toString('hex');
  pendingAuthCodes.set(code, { jwt, expiresAt: Date.now() + AUTH_CODE_TTL_MS });
  return code;
}

function consumeAuthCode(code) {
  const entry = pendingAuthCodes.get(code);
  if (!entry) return null;
  pendingAuthCodes.delete(code);
  if (Date.now() > entry.expiresAt) return null;
  return entry.jwt;
}

async function authRoutes(fastify, options) {

  // Register Google OAuth2
  await fastify.register(require('@fastify/oauth2'), {
    name: 'googleOAuth2',
    scope: ['profile', 'email'],
    credentials: {
      client: {
        id: config.oauth.google.clientId,
        secret: config.oauth.google.clientSecret
      },
      auth: {
        authorizeHost: 'https://accounts.google.com',
        authorizePath: '/o/oauth2/v2/auth',
        tokenHost: 'https://oauth2.googleapis.com',
        tokenPath: '/token'
      }
    },
    startRedirectPath: '/auth/google',
    callbackUri: config.oauth.google.callbackUri
  });

  // Google OAuth callback — tight per-IP limit to slow brute-forced
  // callback replays / state-token guessing.
  fastify.get('/auth/google/callback', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' }
    }
  }, async (request, reply) => {
    try {
      // Get token from Google
      const { token } = await fastify.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);

      // Fetch user info from Google (with 10s timeout)
      const userInfoResponse = await fetchWithTimeout('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${token.access_token}`
        }
      }, 10000);

      if (!userInfoResponse.ok) {
        throw new Error('Failed to fetch user info from Google');
      }

      const googleUser = await userInfoResponse.json();

      // Create or update user in database
      const user = await db.createOrUpdateUser({
        googleId: googleUser.id,
        email: googleUser.email,
        displayName: googleUser.name,
        avatarUrl: googleUser.picture
      });

      // Check if account is active
      const limits = await db.getUserEffectiveLimits(user.id);
      if (limits && !limits.is_active) {
        logger.warn({ email: user.email }, 'Inactive account login attempt');
        return reply.redirect(`${config.frontend.url}?error=account_inactive`);
      }

      // Update last login
      await db.updateLastLogin(user.id);

      // Generate JWT token
      const jwtToken = generateToken(user);

      logger.info({ email: user.email, userId: user.id }, 'User logged in');

      // [SEC-11] Don't set the cookie here — this response arrives via a
      // cross-site redirect from Google and SameSite=Strict would prevent
      // the browser from sending it on the subsequent same-site navigation.
      // Instead, park the JWT behind a one-time code and let the frontend
      // exchange it via a same-site POST.
      const authCode = createAuthCode(jwtToken);
      reply.redirect(`${config.frontend.url}?auth_code=${authCode}`);

    } catch (error) {
      logger.error({ err: error }, 'Google callback error');
      reply.redirect(`${config.frontend.url}?error=auth_failed`);
    }
  });

  // ==================== STANDARD AUTH ROUTES ====================

  // Get current user info
  fastify.get('/auth/me', async (request, reply) => {
    const token = extractToken(request);

    if (!token) {
      return reply.code(401).send({ error: 'No token provided' });
    }

    // [SEC-01] Version-aware: a revoked token must not return user data.
    const decoded = await verifyTokenWithVersion(token);
    if (!decoded) {
      return reply.code(401).send({ error: 'Invalid or expired token' });
    }

    // Get fresh user data from database
    const user = await db.getUserById(decoded.userId);
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    // Get effective limits
    const limits = await db.getUserEffectiveLimits(user.id);

    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
      hasFaceRegistered: !!user.face_api_person_id,
      plan: {
        id: limits?.plan_id,
        name: limits?.plan_name,
        displayName: limits?.plan_display_name
      },
      role: limits?.role || 'user',
      isActive: limits?.is_active ?? true,
      features: {
        voiceControl: limits?.voice_control_enabled || false,
        publicSharing: limits?.public_sharing_enabled || false
      }
    };
  });

  // Verify token endpoint (for frontend to check if token is still valid)
  fastify.get('/auth/verify', async (request, reply) => {
    const token = extractToken(request);

    if (!token) {
      return { valid: false };
    }

    // [SEC-01] Include version check so the frontend learns about revocation
    // and prompts re-login instead of hanging on to a dead session.
    const decoded = await verifyTokenWithVersion(token);
    return { valid: !!decoded };
  });

  // [SEC-11] Exchange a one-time auth code for an HttpOnly session cookie.
  // Called by the frontend after an OAuth redirect lands with ?auth_code=xxx.
  // This is a same-site POST, so SameSite=Strict allows the Set-Cookie.
  fastify.post('/auth/exchange', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' }
    }
  }, async (request, reply) => {
    const { code } = request.body || {};
    if (!code || typeof code !== 'string') {
      return reply.code(400).send({ error: 'Missing auth code' });
    }

    const jwt = consumeAuthCode(code);
    if (!jwt) {
      return reply.code(401).send({ error: 'Invalid or expired auth code' });
    }

    reply.setCookie('qbitmap_token', jwt, getCookieOptions());
    return { success: true };
  });

  // [REMOVED] /auth/ws-token endpoint - Security risk (exposed token to JS)
  // WebSocket now authenticates directly from HttpOnly cookie on connection
  // See: src/services/websocket.js - extractTokenFromCookie()

  // Logout - clear cookie
  fastify.post('/auth/logout', async (request, reply) => {
    const token = extractToken(request);

    if (token) {
      invalidateTokenCache(token);
      const decoded = verifyToken(token);
      if (decoded) {
        // [SEC-01] Bump token_version so this JWT — and any other copies of
        // it (other tabs/devices) — stop authenticating on every worker
        // within ~30s. Without this, the cryptographic 7-day expiry would
        // keep the token valid even after logout.
        try {
          await db.bumpUserTokenVersion(decoded.userId);
          invalidateUserVersionCache(decoded.userId);
        } catch (err) {
          logger.error({ err, userId: decoded.userId }, 'Failed to bump token_version on logout');
        }
        logger.info({ email: decoded.email }, 'User logged out');
      }
    }

    // Clear the cookie
    reply.clearCookie('qbitmap_token', getCookieOptions());

    return { status: 'ok', message: 'Logged out successfully' };
  });
}

module.exports = authRoutes;
