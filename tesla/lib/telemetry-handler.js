const { dbWriter } = require('./db-writer');
const { notifyBackend } = require('./ws-notifier');

// Track previous location per VIN for bearing/speed calculation
const prevLocations = new Map();

// Tesla Fleet Telemetry field IDs (from vehicle_data.proto)
const FIELD = {
  VEHICLE_SPEED: 4,
  SOC: 8,
  GEAR: 10,
  LOCATION: 21,
  GPS_HEADING: 23,
  CHARGE_LIMIT_SOC: 38,
  EST_BATTERY_RANGE: 40,
  BATTERY_LEVEL: 42,
  LOCKED: 59,
  SENTRY_MODE: 65,
  INSIDE_TEMP: 85,
  OUTSIDE_TEMP: 86,
};

async function handleTelemetryMessage(rawData, logger) {
  const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);

  // Try JSON first
  try {
    const msg = JSON.parse(buf.toString());
    if (msg.vin) {
      await handleJsonMessage(msg, logger);
      return;
    }
  } catch { /* not JSON — FlatBuffers binary */ }

  // Parse FlatBuffers + protobuf binary
  try {
    const result = parseFlatBuffersDatum(buf);
    if (!result) return;

    const { vin, topic, fieldId, value, timestamp } = result;
    if (!vin) return;

    if (fieldId == null) {
      // Debug: log raw payload for unrecognized fields
      const tp = buf.indexOf(Buffer.from(topic || 'vehicle_device'));
      let after = tp + (topic || 'vehicle_device').length;
      while (after < buf.length && buf[after] === 0) after++;
      const pbLen = buf.readUInt32LE(after);
      const pbHex = buf.slice(after + 4, after + 4 + pbLen).toString('hex');
      logger.warn({ vin, topic, pbHex, pbLen }, 'Unrecognized field - raw payload');
    }
    logger.info({ vin, topic, fieldId, fieldName: fieldName(fieldId), value, timestamp }, 'Telemetry decoded');

    const update = { vin };
    let hasUpdate = false;

    switch (fieldId) {
      case FIELD.LOCATION:
        if (value?.lat != null && value?.lng != null) {
          update.lat = value.lat;
          update.lng = value.lng;
          hasUpdate = true;

          // Calculate bearing + speed from previous location
          const now = Date.now();
          const prev = prevLocations.get(vin);
          if (prev) {
            const dt = (now - prev.time) / 1000;
            if (dt > 0 && dt < 300) {
              const dist = haversineMeters(prev.lat, prev.lng, update.lat, update.lng);
              update.bearing = Math.round(calcBearing(prev.lat, prev.lng, update.lat, update.lng));
              update.speed = dist > 3 ? Math.round((dist / dt) * 3.6) : 0;
            }
          }
          prevLocations.set(vin, { lat: update.lat, lng: update.lng, time: now });
        }
        break;

      case FIELD.BATTERY_LEVEL:
      case FIELD.SOC:
        if (typeof value === 'number') {
          update.soc = Math.round(value);
          hasUpdate = true;
        }
        break;

      case FIELD.GEAR:
        if (value != null) {
          update.gear = normalizeGear(value);
          hasUpdate = true;
        }
        break;

      case FIELD.VEHICLE_SPEED:
        if (typeof value === 'number') {
          update.speed = Math.round(value);
          // If speed is 0 for a while, vehicle is likely in Park
          if (update.speed === 0) {
            update.gear = 'P';
          }
          hasUpdate = true;
        }
        break;

      case FIELD.GPS_HEADING:
        if (typeof value === 'number') {
          update.bearing = Math.round(value);
          hasUpdate = true;
        }
        break;

      case FIELD.INSIDE_TEMP:
        if (typeof value === 'number') {
          update.insideTemp = Math.round(value * 10) / 10;
          hasUpdate = true;
        }
        break;

      case FIELD.OUTSIDE_TEMP:
        if (typeof value === 'number') {
          update.outsideTemp = Math.round(value * 10) / 10;
          hasUpdate = true;
        }
        break;

      case FIELD.EST_BATTERY_RANGE:
        if (typeof value === 'number') {
          // Tesla sends miles, convert to km
          update.estRange = Math.round(value * 1.60934);
          hasUpdate = true;
        }
        break;

      case FIELD.CHARGE_LIMIT_SOC:
        if (typeof value === 'number') {
          update.chargeLimit = Math.round(value);
          hasUpdate = true;
        }
        break;

      case FIELD.LOCKED:
        if (value != null) {
          update.locked = value === 1 || value === true ? 1 : 0;
          hasUpdate = true;
        }
        break;

      case FIELD.SENTRY_MODE:
        if (value != null) {
          update.sentry = value === 1 || value === true || value === 'Active' ? 1 : 0;
          hasUpdate = true;
        }
        break;
    }

    if (!hasUpdate) return;

    await dbWriter(update);
    await notifyBackend(update);
    logger.info({ vin, fields: Object.keys(update).filter(k => k !== 'vin') }, 'Telemetry update written');

  } catch (err) {
    logger.error({ err, size: buf.length }, 'Failed to decode telemetry message');
  }
}

// Parse Tesla FlatBuffers Datum envelope + protobuf payload
function parseFlatBuffersDatum(buf) {
  // Extract VIN (17 uppercase alphanumeric chars)
  const vinMatch = buf.toString('ascii', 0, buf.length).match(/[A-HJ-NPR-Z0-9]{17}/);
  if (!vinMatch) return null;
  const vin = vinMatch[0];

  // Extract topic
  let topic = null;
  const topicNames = ['vehicle_device', 'alerts', 'errors'];
  for (const t of topicNames) {
    if (buf.includes(Buffer.from(t))) { topic = t; break; }
  }

  // Find protobuf payload: after "vehicle_device\0\0" + 4-byte LE length
  const topicBuf = Buffer.from(topic || 'vehicle_device');
  const topicPos = buf.indexOf(topicBuf);
  if (topicPos < 0) return null;

  let after = topicPos + topicBuf.length;
  while (after < buf.length && buf[after] === 0) after++;
  if (after + 4 > buf.length) return null;

  const pbLen = buf.readUInt32LE(after);
  const pbData = buf.slice(after + 4, after + 4 + pbLen);

  if (pbData.length < pbLen) return null; // truncated

  // Parse protobuf Datum: field 1 = PayloadField, field 2 = Timestamp
  let fieldId = null;
  let value = null;
  let timestamp = null;
  let pos = 0;

  while (pos < pbData.length) {
    const tag = pbData[pos++];
    const fnum = tag >> 3;
    const wt = tag & 7;

    if (wt !== 2) break; // expect length-delimited

    const { val: len, pos: newPos } = readVarint(pbData, pos);
    pos = newPos;
    const sub = pbData.slice(pos, pos + len);
    pos += len;

    if (fnum === 1) {
      // PayloadField: field 1 = field_id, field 2 = Value
      const pf = parsePayloadField(sub);
      fieldId = pf.fieldId;
      value = pf.value;
    } else if (fnum === 2) {
      // Timestamp: field 1 = seconds
      const ts = parseTimestamp(sub);
      timestamp = ts;
    }
  }

  return { vin, topic, fieldId, value, timestamp };
}

function parsePayloadField(data) {
  let fieldId = null;
  let value = null;
  let pos = 0;

  while (pos < data.length) {
    const tag = data[pos++];
    const fnum = tag >> 3;
    const wt = tag & 7;

    if (fnum === 1 && wt === 0) {
      const r = readVarint(data, pos);
      fieldId = r.val;
      pos = r.pos;
    } else if (fnum === 2 && wt === 2) {
      const r = readVarint(data, pos);
      pos = r.pos;
      const valueData = data.slice(pos, pos + r.val);
      pos += r.val;
      value = parseValue(valueData);
    } else {
      break;
    }
  }

  return { fieldId, value };
}

function parseValue(data) {
  let pos = 0;
  while (pos < data.length) {
    const tag = data[pos++];
    const fnum = tag >> 3;
    const wt = tag & 7;

    if (wt === 0) {
      // varint — intValue (field 3) or stringValue enum
      const r = readVarint(data, pos);
      pos = r.pos;
      return r.val;
    } else if (wt === 1) {
      // 64-bit double — doubleValue (field 5) or locationValue lat/lng
      if (pos + 8 > data.length) return null;
      const dval = data.readDoubleLE(pos);
      pos += 8;
      return dval;
    } else if (wt === 2) {
      // length-delimited — could be locationValue (field 7) or stringValue (field 1)
      const r = readVarint(data, pos);
      pos = r.pos;
      const sub = data.slice(pos, pos + r.val);
      pos += r.val;

      if (fnum === 7) {
        // LocationValue: field 1 = lat (double), field 2 = lng (double)
        return parseLocationValue(sub);
      } else if (fnum === 1) {
        // stringValue
        return sub.toString('utf8');
      }
      return sub.toString('hex');
    } else if (wt === 5) {
      // 32-bit float
      if (pos + 4 > data.length) return null;
      const fval = data.readFloatLE(pos);
      pos += 4;
      return fval;
    } else {
      break;
    }
  }
  return null;
}

function parseLocationValue(data) {
  let lat = null;
  let lng = null;
  let pos = 0;

  while (pos < data.length) {
    const tag = data[pos++];
    const fnum = tag >> 3;
    const wt = tag & 7;

    if (wt === 1 && pos + 8 <= data.length) {
      const dval = data.readDoubleLE(pos);
      pos += 8;
      if (fnum === 1) lat = dval;
      else if (fnum === 2) lng = dval;
    } else {
      break;
    }
  }

  return { lat, lng };
}

function parseTimestamp(data) {
  let pos = 0;
  if (pos >= data.length) return null;
  const tag = data[pos++];
  if ((tag & 7) !== 0) return null;
  const r = readVarint(data, pos);
  return r.val;
}

function readVarint(data, pos) {
  let val = 0;
  let shift = 0;
  while (pos < data.length) {
    const b = data[pos++];
    val |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { val, pos };
}

function fieldName(id) {
  const names = { 4: 'VehicleSpeed', 8: 'Soc', 10: 'Gear', 21: 'Location', 23: 'GpsHeading', 38: 'ChargeLimitSoc', 40: 'EstBatteryRange', 42: 'BatteryLevel', 59: 'Locked', 65: 'SentryMode', 85: 'InsideTemp', 86: 'OutsideTemp' };
  return names[id] || `Field_${id}`;
}

function normalizeGear(gear) {
  if (gear == null) return 'P';
  const g = String(gear).toUpperCase();
  if (g === 'P' || g === 'PARK' || g === '0') return 'P';
  if (g === 'D' || g === 'DRIVE' || g === '1') return 'D';
  if (g === 'R' || g === 'REVERSE' || g === '2') return 'R';
  if (g === 'N' || g === 'NEUTRAL' || g === '3') return 'N';
  return g.charAt(0) || 'P';
}

function calcBearing(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Legacy JSON handler (kept for compatibility)
async function handleJsonMessage(msg, logger) {
  // ... existing JSON handling if needed
  logger.info({ vin: msg.vin }, 'JSON telemetry message (legacy)');
}

module.exports = { handleTelemetryMessage };
