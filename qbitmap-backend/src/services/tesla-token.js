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

  // car_version + odometer come via Fleet Telemetry — no weekly REST sync

  logger.info('Tesla token refresh service started');
}

async function syncTpms() {
  const [accounts] = await db.pool.execute(
    `SELECT a.id, a.user_id, t.access_token FROM tesla_accounts a
     JOIN tesla_tokens t ON t.tesla_account_id = a.id WHERE t.expires_at > NOW()`
  );

  for (const acct of accounts) {
    try {
      const accessToken = decrypt(acct.access_token);
      let apiBase = config.tesla.apiBase;
      try {
        const rr = await fetchWithTimeout('https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/users/region', {
          headers: { Authorization: `Bearer ${accessToken}` },
        }, 10000);
        if (rr.ok) {
          const rd = await rr.json();
          if (rd.response?.fleet_api_base_url) apiBase = rd.response.fleet_api_base_url;
        }
      } catch { /* use default */ }

      const vRes = await fetchWithTimeout(`${apiBase}/api/1/vehicles`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, 15000);
      if (!vRes.ok) continue;
      const vData = await vRes.json();

      for (const v of (vData.response || [])) {
        try {
          const vdRes = await fetchWithTimeout(
            `${apiBase}/api/1/vehicles/${v.id}/vehicle_data?endpoints=vehicle_state`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
            15000
          );
          if (!vdRes.ok) continue;
          const vd = await vdRes.json();
          const vs = vd.response?.vehicle_state;
          if (vs) {
            // Tesla returns odometer in miles — convert to km
            const odoKm = vs.odometer != null ? vs.odometer * 1.60934 : null;
            await db.pool.execute(
              `UPDATE tesla_vehicles SET last_tpms_fl = ?, last_tpms_fr = ?, last_tpms_rl = ?, last_tpms_rr = ?, odometer = ?, updated_at = NOW() WHERE vin = ?`,
              [vs.tpms_pressure_fl, vs.tpms_pressure_fr, vs.tpms_pressure_rl, vs.tpms_pressure_rr, odoKm, v.vin]
            );
            logger.info({ vin: v.vin, fl: vs.tpms_pressure_fl, fr: vs.tpms_pressure_fr }, 'TPMS synced');
          }
        } catch (e) {
          logger.warn({ vin: v.vin, err: e.message }, 'TPMS sync failed for vehicle');
        }
      }
    } catch (err) {
      logger.error({ err, accountId: acct.id }, 'TPMS sync failed for account');
    }
  }
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

module.exports = { start, stop, syncTpms };
