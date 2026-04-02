const cron = require('node-cron');
const config = require('../config');
const db = require('./database');
const { encrypt, decrypt } = require('../utils/encryption');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'tesla-token' });

let cronJob = null;

function start() {
  // Run every 10 minutes — refresh tokens expiring within 30 minutes
  cronJob = cron.schedule('*/10 * * * *', async () => {
    try {
      const expiringTokens = await db.getExpiringTeslaTokens(30);
      if (expiringTokens.length === 0) return;

      logger.info({ count: expiringTokens.length }, 'Refreshing expiring Tesla tokens');

      for (const token of expiringTokens) {
        try {
          await refreshToken(token);
        } catch (err) {
          logger.error({ err, teslaAccountId: token.tesla_account_id }, 'Token refresh failed');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Tesla token refresh cron error');
    }
  });

  logger.info('Tesla token refresh service started');
}

async function refreshToken(tokenRow) {
  const refreshTokenPlain = decrypt(tokenRow.refresh_token);

  const response = await fetchWithTimeout(config.tesla.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.tesla.clientId,
      client_secret: config.tesla.clientSecret,
      refresh_token: refreshTokenPlain,
    }).toString(),
  }, 15000);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tesla token refresh failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await db.saveTeslaTokens({
    teslaAccountId: tokenRow.tesla_account_id,
    accessToken: encrypt(data.access_token),
    refreshToken: encrypt(data.refresh_token || refreshTokenPlain),
    expiresAt,
    scopes: tokenRow.scopes,
  });

  logger.info({ teslaAccountId: tokenRow.tesla_account_id }, 'Tesla token refreshed');
}

function stop() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
}

module.exports = { start, stop };
