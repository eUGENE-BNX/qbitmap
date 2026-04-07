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

  // Weekly vehicle info sync — every Sunday at 03:00
  cron.schedule('0 3 * * 0', async () => {
    try {
      await syncVehicleInfo();
    } catch (err) {
      logger.error({ err }, 'Weekly vehicle info sync failed');
    }
  });

  // Daily TPMS sync — every day at 04:00
  cron.schedule('0 4 * * *', async () => {
    try {
      await syncTpms();
    } catch (err) {
      logger.error({ err }, 'Daily TPMS sync failed');
    }
  });

  logger.info('Tesla token refresh service started');
}

async function syncVehicleInfo() {
  const [accounts] = await db.pool.execute(
    `SELECT a.id, a.user_id, t.access_token FROM tesla_accounts a
     JOIN tesla_tokens t ON t.tesla_account_id = a.id WHERE t.expires_at > NOW()`
  );

  for (const acct of accounts) {
    try {
      const accessToken = decrypt(acct.access_token);

      // Discover region
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

      // Get vehicles
      const vRes = await fetchWithTimeout(`${apiBase}/api/1/vehicles`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, 15000);
      if (!vRes.ok) continue;
      const vData = await vRes.json();

      for (const v of (vData.response || [])) {
        // Get vehicle_data for config + state
        try {
          const vdRes = await fetchWithTimeout(
            `${apiBase}/api/1/vehicles/${v.id}/vehicle_data?endpoints=vehicle_config%3Bvehicle_state`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
            15000
          );
          if (!vdRes.ok) continue;
          const vd = await vdRes.json();
          const vc = vd.response?.vehicle_config;
          const vs = vd.response?.vehicle_state;

          await db.upsertTeslaVehicle({
            teslaAccountId: acct.id,
            vehicleId: String(v.id),
            vin: v.vin,
            displayName: vs?.vehicle_name || v.display_name || v.vin,
            model: inferModel(v.vin) || vc?.car_type,
            carType: vc?.car_type || null,
            color: vc?.exterior_color || null,
            wheelType: vc?.wheel_type || null,
            carVersion: vs?.car_version || null,
            odometer: vs?.odometer || null,
          });

          logger.info({ vin: v.vin, color: vc?.exterior_color, version: vs?.car_version }, 'Vehicle info synced');
        } catch (e) {
          logger.warn({ vin: v.vin, err: e.message }, 'Vehicle info sync failed');
        }
      }
    } catch (err) {
      logger.error({ err, accountId: acct.id }, 'Account vehicle sync failed');
    }
  }
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
            await db.pool.execute(
              `UPDATE tesla_vehicles SET last_tpms_fl = ?, last_tpms_fr = ?, last_tpms_rl = ?, last_tpms_rr = ?, odometer = ?, updated_at = NOW() WHERE vin = ?`,
              [vs.tpms_pressure_fl, vs.tpms_pressure_fr, vs.tpms_pressure_rl, vs.tpms_pressure_rr, vs.odometer, v.vin]
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

function inferModel(vin) {
  if (!vin || vin.length < 5) return null;
  const models = { 'S': 'Model S', '3': 'Model 3', 'X': 'Model X', 'Y': 'Model Y' };
  return models[vin.charAt(3)] || null;
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

module.exports = { start, stop, syncTpms, syncVehicleInfo };
