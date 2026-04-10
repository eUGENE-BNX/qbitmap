const config = require('../config');
const db = require('./database');
const { decrypt } = require('../utils/encryption');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'tesla-poller' });

// All endpoints for a full debug poll
const ALL_ENDPOINTS = ['location_data', 'drive_state', 'charge_state', 'vehicle_state', 'climate_state'];

/**
 * Manual debug poll — fetch all data for a specific vehicle (or all vehicles).
 * Not used in production flow; Fleet Telemetry is the primary data channel.
 */
async function pollOnce(targetVin) {
  const [rows] = await db.pool.execute(
    `SELECT a.id AS account_id, a.user_id, t.access_token
     FROM tesla_accounts a
     JOIN tesla_tokens t ON t.tesla_account_id = a.id
     WHERE t.expires_at > NOW()`
  );

  const results = [];

  for (const row of rows) {
    const accessToken = decrypt(row.access_token);
    const vehicles = await db.getTeslaVehiclesByUserId(row.user_id);

    for (const vehicle of vehicles) {
      if (targetVin && vehicle.vin !== targetVin) continue;
      const result = await pollVehicle(vehicle, accessToken, row.user_id);
      results.push(result);
    }
  }

  return results;
}

async function pollVehicle(vehicle, accessToken, userId) {
  const vin = vehicle.vin;

  try {
    const url = `${config.tesla.apiBase}/api/1/vehicles/${vehicle.vehicle_id}/vehicle_data?endpoints=${ALL_ENDPOINTS.join('%3B')}`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, 15000);

    if (res.status === 408 || res.status === 504) {
      logger.info({ vin }, 'Vehicle asleep');
      return { vin, status: 'asleep' };
    }

    if (!res.ok) {
      logger.warn({ vin, status: res.status }, 'Poll failed');
      return { vin, status: 'error', httpStatus: res.status };
    }

    const data = await res.json();
    const ds = data.response?.drive_state;
    const ld = data.response?.location_data;
    const cs = data.response?.charge_state;
    const vs = data.response?.vehicle_state;
    const cl = data.response?.climate_state;

    const update = { vin };

    // Location
    if (ld?.latitude != null) { update.lat = ld.latitude; update.lng = ld.longitude; }
    update.bearing = ld?.heading ?? ds?.heading ?? 0;
    update.speed = ds?.speed || 0;
    update.gear = ds?.shift_state || 'P';

    // Battery
    if (cs) {
      update.soc = cs.usable_battery_level ?? cs.battery_level;
      if (cs.est_battery_range != null) update.estRange = Math.round(cs.est_battery_range * 1.60934);
    }

    // Climate
    if (cl) {
      if (cl.inside_temp != null) update.insideTemp = cl.inside_temp;
      if (cl.outside_temp != null) update.outsideTemp = cl.outside_temp;
    }

    // Vehicle state
    if (vs) {
      update.locked = vs.locked ? 1 : 0;
      update.sentry = vs.sentry_mode ? 1 : 0;
      if (vs.odometer != null) update.odometer = vs.odometer * 1.60934;
    }

    await db.updateVehicleTelemetry(update);

    // Broadcast full state
    const wsService = require('./websocket');
    wsService.broadcastTeslaUpdate(userId, {
      vin,
      vehicleId: vehicle.vehicle_id,
      lat: update.lat ?? vehicle.last_lat,
      lng: update.lng ?? vehicle.last_lng,
      soc: update.soc ?? vehicle.last_soc,
      gear: update.gear,
      bearing: update.bearing ?? vehicle.last_bearing,
      speed: update.speed ?? vehicle.last_speed,
      insideTemp: update.insideTemp ?? vehicle.last_inside_temp,
      outsideTemp: update.outsideTemp ?? vehicle.last_outside_temp,
      estRange: update.estRange ?? vehicle.last_est_range,
      locked: update.locked ?? vehicle.last_locked,
      sentry: update.sentry ?? vehicle.last_sentry,
    });

    logger.info({ vin, update }, 'Debug poll complete');
    return { vin, status: 'ok', update };

  } catch (err) {
    logger.error({ err, vin }, 'Poll error');
    return { vin, status: 'error', message: err.message };
  }
}

module.exports = { pollOnce };
