const config = require('../config');
const db = require('../services/database');
const { generateToken, verifyToken, extractToken, invalidateTokenCache } = require('../utils/jwt');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const { validateBody, biometricVerifySchema } = require('../utils/validation');
const faceApi = require('../services/face-api');
const logger = require('../utils/logger').child({ module: 'auth' });

const isProduction = process.env.NODE_ENV === 'production';

// [SF-2] Cookie options that work in both dev (localhost) and production
function getCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60, // 7 days
    ...(isProduction && { domain: '.qbitmap.com' })
  };
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

  // Google OAuth callback
  fastify.get('/auth/google/callback', async (request, reply) => {
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

      // Set HttpOnly cookie and redirect to frontend
      reply.setCookie('qbitmap_token', jwtToken, getCookieOptions()).redirect(config.frontend.url);

    } catch (error) {
      logger.error({ err: error }, 'Google callback error');
      reply.redirect(`${config.frontend.url}?error=auth_failed`);
    }
  });

  // ==================== BIOMETRIC LOGIN ====================

  // Verify face for biometric login (rate limited: 5 req/min)
  fastify.post('/auth/biometric/verify', {
    preHandler: validateBody(biometricVerifySchema),
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    const { image } = request.body;

    try {
      // Convert base64 to buffer for Face API
      // Remove data URI prefix if present (e.g., "data:image/jpeg;base64,")
      let base64Data = image;
      if (image.includes(',')) {
        base64Data = image.split(',')[1];
      }
      const imageBuffer = Buffer.from(base64Data, 'base64');

      // Call Face API recognition (1:N search to identify who this is)
      const apiResult = await faceApi.recognizeFace(imageBuffer);

      if (!apiResult.ok) {
        logger.error({ apiResult }, 'Face API error');
        return { success: false, error: 'Yüz doğrulama servisi hatası' };
      }

      const result = apiResult.data;
      logger.debug({ result }, 'Face API response');

      // Check if API returned success and has results
      // API returns: { success: true, result: [{ name, score, thresold, isMatchFound, ... }] }
      if (!result.success || !result.result || result.result.length === 0) {
        return { success: false, error: 'Yüz tanınamadı' };
      }

      // Get the best match (highest score)
      const bestMatch = result.result.reduce((best, current) =>
        (current.score > best.score) ? current : best
      );

      // Check if match was found and score is above threshold
      if (!bestMatch.isMatchFound) {
        logger.info('No face match found');
        return { success: false, error: 'Yüz eşleşmesi bulunamadı' };
      }

      if (bestMatch.score < bestMatch.thresold) {
        logger.info({ score: bestMatch.score, threshold: bestMatch.thresold }, 'Low face match score');
        return { success: false, error: 'Yüz eşleşmesi güvenilir değil' };
      }

      logger.info({ name: bestMatch.name, score: bestMatch.score }, 'Face match found');

      // Find user - the name field contains what we stored as firstname (user's email)
      let user = null;

      // Try by email (we stored email as firstname when creating person)
      if (bestMatch.name && bestMatch.name.includes('@')) {
        user = await db.getUserByEmail(bestMatch.name);
      }

      // Try by display name
      if (!user && bestMatch.name) {
        user = await db.getUserByDisplayName(bestMatch.name);
      }

      if (!user) {
        logger.warn({ name: bestMatch.name }, 'No user found for face match');
        return { success: false, error: 'Kayıtlı kullanıcı bulunamadı' };
      }

      // Check if account is active
      const limits = await db.getUserEffectiveLimits(user.id);
      if (limits && !limits.is_active) {
        logger.warn({ email: user.email }, 'Inactive account FaceID login attempt');
        return { success: false, error: 'Hesap devre dışı' };
      }

      // Update last login
      await db.updateLastLogin(user.id);

      // Generate JWT token
      const jwtToken = generateToken(user);

      logger.info({ email: user.email, confidence: bestMatch.confidence }, 'Biometric authentication successful');

      // Set HttpOnly cookie
      reply.setCookie('qbitmap_token', jwtToken, getCookieOptions());

      // [SB-2] Token removed from response body - cookie is already set above
      // Frontend uses cookie-based auth via AuthSystem.loadUserInfo()
      return {
        success: true,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          avatarUrl: user.avatar_url
        }
      };

    } catch (error) {
      logger.error({ err: error }, 'Biometric verification error');
      return reply.code(500).send({ success: false, error: 'Yüz doğrulama hatası' });
    }
  });

  // ==================== STANDARD AUTH ROUTES ====================

  // Get current user info
  fastify.get('/auth/me', async (request, reply) => {
    const token = extractToken(request);

    if (!token) {
      return reply.code(401).send({ error: 'No token provided' });
    }

    const decoded = verifyToken(token);
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
        faceLogin: limits?.face_login_enabled || false,
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

    const decoded = verifyToken(token);
    return { valid: !!decoded };
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
        logger.info({ email: decoded.email }, 'User logged out');
      }
    }

    // Clear the cookie
    reply.clearCookie('qbitmap_token', getCookieOptions());

    return { status: 'ok', message: 'Logged out successfully' };
  });
}

module.exports = authRoutes;
