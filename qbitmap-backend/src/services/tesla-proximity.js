const db = require('./database');
const logger = require('../utils/logger').child({ module: 'tesla-proximity' });

const ALERT_RADIUS_M = 250;
const CLEAR_RADIUS_M = 400;      // hysteresis so we don't spam on hover at the boundary
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const TELEMETRY_STALE_MS = 10 * 60 * 1000;

// pair key "a:b" (sorted) -> { firedAt, insideZone }
const pairState = new Map();

function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Called after a Tesla vehicle reports fresh telemetry.
 *   movingUserId: the owner of the vehicle that just moved
 *   vehicle: { vin, displayName, lat, lng, avatarUrl?, ownerName? } for the moving car
 *
 * Sends a WS `tesla_proximity_alert` to BOTH sides of every matching share
 * pair when the vehicles come within ALERT_RADIUS_M. Debounced per pair.
 */
async function checkProximity(movingUserId, movingVehicle) {
  if (!movingVehicle || movingVehicle.lat == null || movingVehicle.lng == null) return;

  let peers;
  try {
    peers = await db.getTeslaProximityPeers(movingUserId);
  } catch (err) {
    logger.warn({ err }, 'proximity peer lookup failed');
    return;
  }
  if (!peers || peers.length === 0) return;

  const now = Date.now();
  const wsService = require('./websocket');

  for (const peer of peers) {
    if (peer.last_lat == null || peer.last_lng == null) continue;
    if (peer.last_telemetry_at && now - new Date(peer.last_telemetry_at).getTime() > TELEMETRY_STALE_MS) {
      continue;
    }

    const distance = haversineMeters(
      Number(movingVehicle.lat), Number(movingVehicle.lng),
      Number(peer.last_lat), Number(peer.last_lng)
    );
    const key = pairKey(movingUserId, peer.peer_user_id);
    const state = pairState.get(key);

    if (distance <= ALERT_RADIUS_M) {
      const cooled = !state || (now - state.firedAt > ALERT_COOLDOWN_MS);
      const reEnteredZone = state && !state.insideZone && cooled;
      const firstEntry = !state;
      if (firstEntry || reEnteredZone) {
        pairState.set(key, { firedAt: now, insideZone: true });
        const meters = Math.round(distance);

        wsService.sendToUser(movingUserId, {
          type: 'tesla_proximity_alert',
          payload: {
            contactName: peer.peer_name,
            contactAvatar: peer.peer_avatar,
            vehicleDisplayName: peer.display_name,
            vin: peer.vin,
            distanceMeters: meters,
          },
        });
        wsService.sendToUser(peer.peer_user_id, {
          type: 'tesla_proximity_alert',
          payload: {
            contactName: movingVehicle.ownerName || null,
            contactAvatar: movingVehicle.avatarUrl || null,
            vehicleDisplayName: movingVehicle.displayName || null,
            vin: movingVehicle.vin,
            distanceMeters: meters,
          },
        });

        logger.info({ pair: key, meters }, 'Tesla proximity alert dispatched');
      } else {
        // still inside zone, keep marker fresh
        pairState.set(key, { firedAt: state.firedAt, insideZone: true });
      }
    } else if (distance > CLEAR_RADIUS_M && state) {
      // Left the zone — arm the alert again for the next entry.
      pairState.set(key, { firedAt: state.firedAt, insideZone: false });
    }
  }
}

module.exports = { checkProximity, haversineMeters };
