const { dbWriter } = require('./db-writer');
const { notifyBackend } = require('./ws-notifier');

// Tesla Fleet Telemetry sends JSON or protobuf messages
// Each message contains: vin, createdAt, and data fields
async function handleTelemetryMessage(rawData, logger) {
  let message;

  try {
    // Try JSON first (Tesla supports both JSON and protobuf)
    message = JSON.parse(rawData.toString());
  } catch {
    // If not JSON, try protobuf decode
    message = decodeProtobuf(rawData);
  }

  if (!message || !message.vin) {
    logger.warn('Received telemetry message without VIN, skipping');
    return;
  }

  const vin = message.vin;
  const data = message.data || message;

  // Extract relevant fields
  const update = { vin };
  let hasUpdate = false;

  // Location
  if (data.Location || data.drive_state) {
    const loc = data.Location || data.drive_state;
    if (loc.latitude != null) { update.lat = loc.latitude; hasUpdate = true; }
    if (loc.longitude != null) { update.lng = loc.longitude; hasUpdate = true; }
    if (loc.heading != null) { update.bearing = loc.heading; hasUpdate = true; }
    if (loc.speed != null) { update.speed = loc.speed; hasUpdate = true; }
  }

  // Battery SoC
  if (data.ChargeState || data.charge_state) {
    const cs = data.ChargeState || data.charge_state;
    if (cs.usable_battery_level != null) {
      update.soc = cs.usable_battery_level;
      hasUpdate = true;
    } else if (cs.BatteryLevel != null) {
      update.soc = cs.BatteryLevel;
      hasUpdate = true;
    }
  }

  // Gear / Shift State
  if (data.DriveState || data.drive_state) {
    const ds = data.DriveState || data.drive_state;
    if (ds.shift_state != null || ds.ShiftState != null) {
      const gear = ds.shift_state || ds.ShiftState;
      // Normalize gear value
      if (gear === 'P' || gear === 'Park') update.gear = 'P';
      else if (gear === 'D' || gear === 'Drive') update.gear = 'D';
      else if (gear === 'R' || gear === 'Reverse') update.gear = 'R';
      else if (gear === 'N' || gear === 'Neutral') update.gear = 'N';
      else update.gear = String(gear).charAt(0).toUpperCase();
      hasUpdate = true;
    }
  }

  if (!hasUpdate) {
    logger.debug({ vin }, 'No relevant telemetry fields in message');
    return;
  }

  logger.info({ vin, fields: Object.keys(update).filter(k => k !== 'vin') }, 'Processing telemetry update');

  // Write to database
  await dbWriter(update);

  // Notify backend for WebSocket broadcast
  await notifyBackend(update);
}

// Basic protobuf decode fallback
function decodeProtobuf(data) {
  try {
    // Tesla Fleet Telemetry uses a specific protobuf schema
    // For now, try to parse as a simple JSON-like structure
    // Full protobuf support will be added when we have the exact .proto schema
    const text = data.toString('utf8');
    if (text.startsWith('{')) {
      return JSON.parse(text);
    }
  } catch { /* ignore */ }
  return null;
}

module.exports = { handleTelemetryMessage };
