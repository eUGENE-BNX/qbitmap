const { dbWriter } = require('./db-writer');
const { notifyBackend } = require('./ws-notifier');

// Track previous location per VIN for bearing/speed calculation
const prevLocations = new Map(); // vin -> { lat, lng, time }

// Tesla Fleet Telemetry message formats:
// 1. Fleet Telemetry streaming format (array of key-value data)
// 2. Legacy JSON format (drive_state, charge_state objects)
async function handleTelemetryMessage(rawData, logger) {
  let message;

  try {
    message = JSON.parse(rawData.toString());
  } catch {
    // Binary protobuf — not yet supported
    logger.warn('Non-JSON telemetry message received, skipping');
    return;
  }

  if (!message) return;

  // Fleet Telemetry streaming format: { vin, createdAt, data: [...] }
  if (message.vin && Array.isArray(message.data)) {
    await handleFleetTelemetryFormat(message, logger);
    return;
  }

  // Legacy format: { vin, drive_state, charge_state, ... }
  if (message.vin && (message.drive_state || message.charge_state || message.Location)) {
    await handleLegacyFormat(message, logger);
    return;
  }

  // Envelope format: { data: { vin, ... } }
  if (message.data?.vin) {
    message.data.data = message.data.data || message.data;
    await handleTelemetryMessage(Buffer.from(JSON.stringify(message.data)), logger);
    return;
  }

  logger.warn({ keys: Object.keys(message) }, 'Unknown telemetry message format');
}

// Tesla Fleet Telemetry streaming: { vin, createdAt, data: [{ key, value }] }
async function handleFleetTelemetryFormat(message, logger) {
  const vin = message.vin;
  const update = { vin };
  let hasUpdate = false;

  for (const item of message.data) {
    const key = item.key;
    const val = item.value;

    switch (key) {
      case 'Location':
        if (val?.locationValue) {
          update.lat = val.locationValue.latitude;
          update.lng = val.locationValue.longitude;
          hasUpdate = true;
        }
        break;

      case 'Latitude':
        update.lat = val?.doubleValue ?? val?.floatValue ?? val;
        hasUpdate = true;
        break;

      case 'Longitude':
        update.lng = val?.doubleValue ?? val?.floatValue ?? val;
        hasUpdate = true;
        break;

      case 'Heading':
        update.bearing = val?.doubleValue ?? val?.floatValue ?? val ?? 0;
        hasUpdate = true;
        break;

      case 'VehicleSpeed':
      case 'Speed':
        update.speed = val?.doubleValue ?? val?.floatValue ?? val ?? 0;
        hasUpdate = true;
        break;

      case 'Soc':
      case 'BatteryLevel':
      case 'UsableBatteryLevel':
        update.soc = val?.intValue ?? val?.doubleValue ?? val;
        hasUpdate = true;
        break;

      case 'GearSelection':
      case 'ShiftState':
      case 'Gear': {
        const gear = val?.stringValue ?? val?.intValue ?? val;
        update.gear = normalizeGear(gear);
        hasUpdate = true;
        break;
      }

      case 'ChargeState':
        if (val?.stringValue === 'Charging' || val?.stringValue === 'Complete') {
          // Charging info — we mainly care about SoC
        }
        break;

      case 'DriveState':
        if (val?.locationValue) {
          update.lat = val.locationValue.latitude;
          update.lng = val.locationValue.longitude;
          hasUpdate = true;
        }
        break;
    }
  }

  if (!hasUpdate) {
    logger.debug({ vin }, 'No relevant fields in Fleet Telemetry message');
    return;
  }

  // Calculate bearing and speed from consecutive coordinates
  if (update.lat != null && update.lng != null) {
    const now = Date.now();
    const prev = prevLocations.get(vin);

    if (prev) {
      const dt = (now - prev.time) / 1000; // seconds
      if (dt > 0 && dt < 300) { // ignore stale data (>5min gap)
        const bearing = calcBearing(prev.lat, prev.lng, update.lat, update.lng);
        const dist = haversineMeters(prev.lat, prev.lng, update.lat, update.lng);
        const speedKmh = (dist / dt) * 3.6;

        update.bearing = Math.round(bearing);
        // Only set speed if moved more than 3m (GPS noise filter)
        update.speed = dist > 3 ? Math.round(speedKmh) : 0;
      }
    }

    prevLocations.set(vin, { lat: update.lat, lng: update.lng, time: now });
  }

  logger.info({ vin, fields: Object.keys(update).filter(k => k !== 'vin') }, 'Fleet Telemetry update');
  await dbWriter(update);
  await notifyBackend(update);
}

// Legacy format: { vin, drive_state: {...}, charge_state: {...} }
async function handleLegacyFormat(message, logger) {
  const vin = message.vin;
  const data = message;
  const update = { vin };
  let hasUpdate = false;

  // Location
  const loc = data.Location || data.drive_state;
  if (loc) {
    if (loc.latitude != null) { update.lat = loc.latitude; hasUpdate = true; }
    if (loc.longitude != null) { update.lng = loc.longitude; hasUpdate = true; }
    if (loc.heading != null) { update.bearing = loc.heading; hasUpdate = true; }
    if (loc.speed != null) { update.speed = loc.speed; hasUpdate = true; }
  }

  // Battery SoC
  const cs = data.ChargeState || data.charge_state;
  if (cs) {
    const soc = cs.usable_battery_level ?? cs.BatteryLevel ?? cs.battery_level;
    if (soc != null) { update.soc = soc; hasUpdate = true; }
  }

  // Gear
  const ds = data.DriveState || data.drive_state;
  if (ds) {
    const gear = ds.shift_state ?? ds.ShiftState;
    if (gear != null) {
      update.gear = normalizeGear(gear);
      hasUpdate = true;
    }
  }

  if (!hasUpdate) return;

  logger.info({ vin, fields: Object.keys(update).filter(k => k !== 'vin') }, 'Legacy telemetry update');
  await dbWriter(update);
  await notifyBackend(update);
}

function normalizeGear(gear) {
  if (gear == null) return 'P';
  const g = String(gear).toUpperCase();
  if (g === 'P' || g === 'PARK') return 'P';
  if (g === 'D' || g === 'DRIVE') return 'D';
  if (g === 'R' || g === 'REVERSE') return 'R';
  if (g === 'N' || g === 'NEUTRAL') return 'N';
  return g.charAt(0) || 'P';
}

// Bearing between two GPS points (degrees, 0=North, clockwise)
function calcBearing(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Haversine distance in meters
function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = { handleTelemetryMessage };
