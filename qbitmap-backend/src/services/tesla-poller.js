const config = require('../config');
const db = require('./database');
const { decrypt } = require('../utils/encryption');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'tesla-poller' });

// Polling intervals (ms)
const LOCATION_INTERVAL = 60 * 1000;       // 1 minute
const GEAR_INTERVAL = 5 * 60 * 1000;       // 5 minutes
const BATTERY_INTERVAL = 10 * 60 * 1000;   // 10 minutes
const PARKED_INTERVAL = 10 * 60 * 1000;    // 10 minutes when parked

// Track per-vehicle state
const vehicleState = new Map(); // vin -> { lastPoll, lastLocation, lastGear, lastBattery, isParked }

let pollTimer = null;
const TICK_INTERVAL = 30 * 1000; // Check every 30s

function start() {
  pollTimer = setInterval(tick, TICK_INTERVAL);
  setTimeout(tick, 5000);
  logger.info('Tesla poller started');
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function tick() {
  try {
    logger.info('Tick running');
    const [rows] = await db.pool.execute(
      `SELECT a.id AS account_id, a.user_id, t.access_token, t.expires_at
       FROM tesla_accounts a
       JOIN tesla_tokens t ON t.tesla_account_id = a.id
       WHERE t.expires_at > NOW()`
    );
    logger.info({ accounts: rows.length }, 'Found Tesla accounts to poll');

    for (const row of rows) {
      try {
        await pollAccount(row);
      } catch (err) {
        logger.error({ err, accountId: row.account_id }, 'Poll error');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Tesla poller tick error');
  }
}

async function pollAccount(row) {
  const accessToken = decrypt(row.access_token);
  const vehicles = await db.getTeslaVehiclesByUserId(row.user_id);

  for (const vehicle of vehicles) {
    await pollVehicle(vehicle, accessToken, row.user_id);
  }
}

async function pollVehicle(vehicle, accessToken, userId) {
  const vin = vehicle.vin;
  const now = Date.now();

  if (!vehicleState.has(vin)) {
    vehicleState.set(vin, {
      lastPoll: 0,
      lastLocation: 0,
      lastGear: 0,
      lastBattery: 0,
      isParked: vehicle.last_gear === 'P',
    });
  }
  const state = vehicleState.get(vin);

  // If parked — only poll every PARKED_INTERVAL
  if (state.isParked && (now - state.lastPoll) < PARKED_INTERVAL) {
    logger.info({ vin, nextIn: Math.round((PARKED_INTERVAL - (now - state.lastPoll)) / 1000) }, 'Parked, skipping');
    return;
  }

  // If not parked — check individual field intervals
  const needLocation = !state.isParked && (now - state.lastLocation) >= LOCATION_INTERVAL;
  const needGear = (now - state.lastGear) >= GEAR_INTERVAL;
  const needBattery = (now - state.lastBattery) >= BATTERY_INTERVAL;

  // When parked, we still need to check gear periodically (to detect drive start)
  if (!needLocation && !needGear && !needBattery && !state.isParked) {
    return;
  }

  // For parked vehicles, just check gear to detect drive start
  const endpoints = ['drive_state'];
  if (needBattery || state.isParked) endpoints.push('charge_state');

  try {
    const url = `${config.tesla.apiBase}/api/1/vehicles/${vehicle.vehicle_id}/vehicle_data?endpoints=${endpoints.join('%3B')}`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, 15000);

    state.lastPoll = now;

    if (res.status === 408 || res.status === 504) {
      state.isParked = true;
      logger.debug({ vin }, 'Vehicle asleep');
      return;
    }

    if (!res.ok) {
      logger.warn({ vin, status: res.status }, 'Vehicle data poll failed');
      return;
    }

    const data = await res.json();
    const ds = data.response?.drive_state;
    const cs = data.response?.charge_state;
    if (!ds) return;

    const update = { vin };
    const fields = [];

    // Location
    if (ds.latitude != null) {
      update.lat = ds.latitude;
      update.lng = ds.longitude;
      update.bearing = ds.heading || 0;
      update.speed = ds.speed || 0;
      state.lastLocation = now;
      fields.push('location');
    }

    // Gear
    update.gear = ds.shift_state || 'P';
    const wasParked = state.isParked;
    state.isParked = update.gear === 'P';
    state.lastGear = now;
    fields.push('gear');

    if (wasParked && !state.isParked) {
      logger.info({ vin }, 'Vehicle started driving — increasing poll rate');
    } else if (!wasParked && state.isParked) {
      logger.info({ vin }, 'Vehicle parked — reducing poll rate');
    }

    // Battery
    if (cs) {
      update.soc = cs.usable_battery_level ?? cs.battery_level;
      state.lastBattery = now;
      fields.push('battery');
    }

    await db.updateVehicleTelemetry(update);

    // WebSocket push
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
    });

    logger.info({ vin, fields, parked: state.isParked }, 'Vehicle polled');

  } catch (err) {
    logger.error({ err, vin }, 'Vehicle poll error');
  }
}

module.exports = { start, stop };
