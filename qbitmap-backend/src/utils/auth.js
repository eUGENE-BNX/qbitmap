const crypto = require('crypto');

const SHARED_SECRET = process.env.DEVICE_SHARED_SECRET;
const isProduction = process.env.NODE_ENV === 'production';

if (!SHARED_SECRET) {
  if (isProduction) {
    console.error('[Auth] FATAL: DEVICE_SHARED_SECRET not set in production');
    process.exit(1);
  }
  console.warn('[Auth] WARNING: DEVICE_SHARED_SECRET not set, using fallback');
}

function computeHmacSha256(deviceId, secret = SHARED_SECRET) {
  if (!secret) {
    throw new Error('DEVICE_SHARED_SECRET is not configured');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(deviceId)
    .digest('hex');
}

function validateDeviceToken(deviceId, providedToken) {
  if (!providedToken || typeof providedToken !== 'string') {
    return false;
  }

  const expectedToken = computeHmacSha256(deviceId);

  // Use timing-safe comparison to prevent timing attacks
  try {
    const expectedBuffer = Buffer.from(expectedToken, 'hex');
    const providedBuffer = Buffer.from(providedToken, 'hex');

    // Buffers must be same length for timingSafeEqual
    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  } catch {
    return false;
  }
}

module.exports = {
  computeHmacSha256,
  validateDeviceToken,
  SHARED_SECRET
};
