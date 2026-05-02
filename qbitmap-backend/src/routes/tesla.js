const crypto = require('crypto');
const config = require('../config');
const db = require('../services/database');
const { authHook, extractToken, verifyToken } = require('../utils/jwt');
const { encrypt, decrypt } = require('../utils/encryption');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const { formatModel } = require('../utils/tesla-trim');
const logger = require('../utils/logger').child({ module: 'tesla' });

const isProduction = process.env.NODE_ENV === 'production';

// Lazy backfill of static vehicle_config (trim_badging, etc.) for vehicles
// missed by the initial sync. Runs from the telemetry webhook when the
// vehicle is awake (telemetry is flowing). Per-VIN cooldown prevents
// hammering Tesla on every Location event when the vehicle is asleep but
// MQTT is still draining buffered messages.
const trimBackfillCooldown = new Map();
const TRIM_BACKFILL_COOLDOWN_MS = 30 * 60 * 1000;

async function backfillVehicleConfig(vehicle) {
  try {
    const tokens = await db.getTeslaTokensByAccountId(vehicle.tesla_account_id);
    if (!tokens || new Date(tokens.expires_at) < new Date()) return;
    const accessToken = decrypt(tokens.access_token);
    const url = `${config.tesla.apiBase}/api/1/vehicles/${vehicle.vehicle_id}/vehicle_data?endpoints=vehicle_config`;
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } }, 15000);
    if (!res.ok) return; // 408 = asleep — try again next cooldown window
    const vc = (await res.json()).response?.vehicle_config;
    if (!vc?.trim_badging) return;
    await db.upsertTeslaVehicle({
      teslaAccountId: vehicle.tesla_account_id,
      vehicleId: vehicle.vehicle_id,
      vin: vehicle.vin,
      displayName: vehicle.display_name,
      model: vehicle.model,
      carType: vc.car_type || null,
      color: vc.exterior_color || null,
      wheelType: vc.wheel_type || null,
      trimBadging: vc.trim_badging,
    });
    logger.info({ vin: vehicle.vin, trim: vc.trim_badging }, 'trim backfilled');
  } catch (err) {
    logger.warn({ err: err.message, vin: vehicle.vin }, 'trim backfill error');
  }
}

// PKCE state storage (short-lived, in-memory)
const pendingStates = new Map();
const STATE_TTL = 10 * 60 * 1000; // 10 minutes

// Cleanup expired states every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pendingStates.entries()) {
    if (now - entry.time > STATE_TTL) pendingStates.delete(key);
  }
}, 5 * 60 * 1000);

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function teslaRoutes(fastify) {

  // ==================== TESLA OAuth ====================

  // Initiate Tesla OAuth flow (requires qbitmap login)
  fastify.get('/tesla', { preHandler: authHook }, async (request, reply) => {
    const userId = request.user.userId;

    // Check if already connected
    const existing = await db.getTeslaAccountByUserId(userId);
    if (existing) {
      return reply.redirect(`${config.frontend.url}?tesla=already_connected`);
    }

    // PKCE: generate code_verifier and code_challenge
    const codeVerifier = base64url(crypto.randomBytes(32));
    const codeChallenge = base64url(
      crypto.createHash('sha256').update(codeVerifier).digest()
    );

    // State for CSRF protection
    const state = base64url(crypto.randomBytes(16));
    pendingStates.set(state, { userId, codeVerifier, time: Date.now() });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.tesla.clientId,
      redirect_uri: config.tesla.callbackUri,
      scope: config.tesla.scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return reply.redirect(`${config.tesla.authUrl}?${params.toString()}`);
  });

  // Tesla OAuth callback
  fastify.get('/tesla/callback', async (request, reply) => {
    try {
      const { code, state, error } = request.query;

      if (error) {
        logger.warn({ error }, 'Tesla OAuth denied');
        return reply.redirect(`${config.frontend.url}?tesla=denied`);
      }

      if (!code || !state) {
        return reply.redirect(`${config.frontend.url}?tesla=error`);
      }

      // Validate state
      const pending = pendingStates.get(state);
      if (!pending) {
        logger.warn('Invalid or expired Tesla OAuth state');
        return reply.redirect(`${config.frontend.url}?tesla=expired`);
      }
      pendingStates.delete(state);

      const { userId, codeVerifier } = pending;

      // Exchange code for tokens
      const tokenResponse = await fetchWithTimeout(config.tesla.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: config.tesla.clientId,
          client_secret: config.tesla.clientSecret,
          code,
          redirect_uri: config.tesla.callbackUri,
          code_verifier: codeVerifier,
        }).toString(),
      }, 15000);

      if (!tokenResponse.ok) {
        const errBody = await tokenResponse.text();
        logger.error({ status: tokenResponse.status, body: errBody }, 'Tesla token exchange failed');
        return reply.redirect(`${config.frontend.url}?tesla=token_error`);
      }

      const tokenData = await tokenResponse.json();
      const { access_token, refresh_token, expires_in, id_token, scope: grantedScopes } = tokenData;
      logger.info({ grantedScopes }, 'Tesla OAuth scopes granted');

      // Decode id_token to get Tesla user info (JWT, no verification needed here since we got it from token endpoint)
      let teslaUser = {};
      if (id_token) {
        try {
          const payload = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64').toString());
          teslaUser = {
            sub: payload.sub,
            email: payload.email,
            name: payload.name || payload.email,
            picture: payload.picture || null,
          };
        } catch (e) {
          logger.warn('Failed to decode Tesla id_token');
        }
      }

      // Fetch user profile from /users/me (fills email, name, picture if missing from id_token)
      try {
        const meResponse = await fetchWithTimeout(`${config.tesla.apiBase}/api/1/users/me`, {
          headers: { Authorization: `Bearer ${access_token}` },
        }, 10000);
        if (meResponse.ok) {
          const meData = await meResponse.json();
          const r = meData.response || meData;
          if (!teslaUser.sub) teslaUser.sub = String(r.vault_uuid || r.id);
          if (!teslaUser.email) teslaUser.email = r.email;
          if (!teslaUser.name) teslaUser.name = r.full_name || r.email;
          if (!teslaUser.picture) teslaUser.picture = r.profile_image_url || null;
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'Failed to fetch Tesla user profile');
      }

      if (!teslaUser.sub) {
        logger.error('Could not identify Tesla user');
        return reply.redirect(`${config.frontend.url}?tesla=user_error`);
      }

      // Save Tesla account
      const teslaAccount = await db.createOrUpdateTeslaAccount({
        userId,
        teslaUserId: teslaUser.sub,
        email: teslaUser.email,
        fullName: teslaUser.name,
        profileImageUrl: teslaUser.picture,
      });

      // Save encrypted tokens
      const expiresAt = new Date(Date.now() + expires_in * 1000);
      await db.saveTeslaTokens({
        teslaAccountId: teslaAccount.id,
        accessToken: encrypt(access_token),
        refreshToken: encrypt(refresh_token),
        expiresAt,
        scopes: grantedScopes || config.tesla.scopes,
      });

      // Discover user's regional Fleet API base URL
      let apiBase = config.tesla.apiBase;
      try {
        const regionRes = await fetchWithTimeout('https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/users/region', {
          headers: { Authorization: `Bearer ${access_token}` },
        }, 10000);
        const regionBody = await regionRes.text();
        logger.info({ status: regionRes.status, body: regionBody }, 'Tesla region response');
        if (regionRes.ok) {
          const regionData = JSON.parse(regionBody);
          if (regionData.response?.fleet_api_base_url) {
            apiBase = regionData.response.fleet_api_base_url;
            logger.info({ apiBase }, 'Discovered Tesla regional API base');
          }
        }
      } catch (e) {
        logger.warn({ err: e }, 'Failed to discover Tesla region, using default');
      }

      // Fetch and save vehicles
      try {
        await syncTeslaVehicles(teslaAccount.id, access_token, apiBase);
      } catch (err) {
        logger.error({ err }, 'Failed to sync Tesla vehicles on first connect');
      }

      logger.info({ userId, teslaEmail: teslaUser.email }, 'Tesla account connected');
      return reply.redirect(`${config.frontend.url}?tesla=connected`);

    } catch (err) {
      logger.error({ err }, 'Tesla callback error');
      return reply.redirect(`${config.frontend.url}?tesla=error`);
    }
  });
}

async function teslaApiRoutes(fastify) {

  // All API routes require qbitmap auth
  fastify.addHook('preHandler', authHook);

  // Check if user has Tesla connected
  fastify.get('/status', async (request) => {
    const account = await db.getTeslaAccountByUserId(request.user.userId);
    let scopes = null;
    if (account) {
      const tokens = await db.getTeslaTokensByAccountId(account.id);
      scopes = tokens?.scopes || null;
    }
    return {
      connected: !!account,
      email: account?.email || null,
      fullName: account?.full_name || null,
      profileImage: account?.profile_image_url || null,
      scopes,
    };
  });

  // Get user's Tesla vehicles with latest telemetry
  fastify.get('/vehicles', async (request) => {
    const vehicles = await db.getTeslaVehiclesByUserId(request.user.userId);
    return {
      vehicles: vehicles.map(v => ({
        id: v.id,
        vehicleId: v.vehicle_id,
        vin: v.vin,
        displayName: v.display_name,
        model: formatModel(v.model, v.trim_badging),
        trimBadging: v.trim_badging || null,
        color: v.color,
        lat: v.last_lat,
        lng: v.last_lng,
        soc: v.last_soc,
        gear: v.last_gear,
        bearing: v.last_bearing,
        speed: v.last_speed,
        carType: v.car_type,
        wheelType: v.wheel_type,
        carVersion: v.car_version,
        odometer: v.odometer ? Math.round(v.odometer) : null,
        isOnline: !!v.is_online,
        telemetryEnabled: !!v.telemetry_enabled,
        meshVisible: v.mesh_visible == null ? true : !!v.mesh_visible,
        insideTemp: v.last_inside_temp,
        outsideTemp: v.last_outside_temp,
        estRange: v.last_est_range,
        locked: v.last_locked != null ? !!v.last_locked : null,
        sentry: v.last_sentry != null ? !!v.last_sentry : null,
        licensePlate: v.license_plate || null,
        tpms: v.last_tpms_fl != null ? { fl: v.last_tpms_fl, fr: v.last_tpms_fr, rl: v.last_tpms_rl, rr: v.last_tpms_rr } : null,
        lastTelemetryAt: v.last_telemetry_at,
        ownerName: v.display_name,
        ownerAvatar: v.avatar_url,
        teslaAvatar: v.owner_profile_image || null,
      }))
    };
  });

  // Toggle mesh visibility (whether other users see this vehicle on the map)
  fastify.patch('/vehicles/:vehicleId/mesh-visible', async (request, reply) => {
    const { vehicleId } = request.params;
    const { visible } = request.body || {};
    const ok = await db.setTeslaVehicleMeshVisible(vehicleId, request.user.userId, !!visible);
    if (!ok) return reply.code(404).send({ error: 'Vehicle not found' });

    // Re-broadcast mesh to all subscribed clients so they add/remove the vehicle live
    try {
      const wsService = require('../services/websocket');
      wsService.broadcastTeslaMesh();
    } catch (err) {
      logger.warn({ err }, 'broadcastTeslaMesh failed');
    }
    return { status: 'ok', meshVisible: !!visible };
  });

  // ---- Per-user vehicle sharing ----

  fastify.get('/vehicles/:vehicleId/shares', async (request, reply) => {
    const { vehicleId } = request.params;
    const shares = await db.getTeslaVehicleShares(vehicleId, request.user.userId);
    if (shares === null) return reply.code(404).send({ error: 'Vehicle not found' });
    return { shares };
  });

  fastify.post('/vehicles/:vehicleId/shares', async (request, reply) => {
    const { vehicleId } = request.params;
    const email = (request.body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return reply.code(400).send({ error: 'Geçerli bir e-posta girin' });
    }
    const result = await db.shareTeslaVehicle(vehicleId, request.user.userId, email);
    if (!result.success) {
      const code = result.error === 'You do not own this vehicle' ? 403 : 400;
      return reply.code(code).send({ error: result.error });
    }
    try {
      const wsService = require('../services/websocket');
      wsService.broadcastTeslaMesh();
    } catch (err) {
      logger.warn({ err }, 'broadcastTeslaMesh failed after share add');
    }
    return { status: 'ok', share: result.share };
  });

  fastify.delete('/vehicles/:vehicleId/shares/:userId', async (request, reply) => {
    const { vehicleId, userId } = request.params;
    const result = await db.unshareTeslaVehicle(vehicleId, request.user.userId, Number(userId));
    if (!result.success) return reply.code(403).send({ error: result.error });
    try {
      const wsService = require('../services/websocket');
      wsService.broadcastTeslaMesh();
    } catch (err) {
      logger.warn({ err }, 'broadcastTeslaMesh failed after share remove');
    }
    return { status: 'ok' };
  });

  fastify.patch('/vehicles/:vehicleId/shares/:userId', async (request, reply) => {
    const { vehicleId, userId } = request.params;
    const { proximityAlertEnabled } = request.body || {};
    const result = await db.setTeslaShareProximityAlert(
      vehicleId, request.user.userId, Number(userId), !!proximityAlertEnabled
    );
    if (!result.success) return reply.code(404).send({ error: result.error || 'Share not found' });
    return { status: 'ok', proximityAlertEnabled: !!proximityAlertEnabled };
  });

  // Update vehicle license plate
  fastify.patch('/vehicles/:vehicleId/license-plate', async (request, reply) => {
    const { vehicleId } = request.params;
    const { licensePlate } = request.body || {};
    const plate = (licensePlate || '').trim().slice(0, 20) || null;
    await db.updateTeslaVehicleLicensePlate(vehicleId, request.user.userId, plate);
    return { status: 'ok', licensePlate: plate };
  });

  // Disconnect Tesla account
  fastify.post('/disconnect', async (request) => {
    await db.deleteTeslaAccount(request.user.userId);
    logger.info({ userId: request.user.userId }, 'Tesla account disconnected');
    return { status: 'ok' };
  });

  // Manually refresh vehicles list from Tesla API
  fastify.post('/sync-vehicles', async (request) => {
    const account = await db.getTeslaAccountByUserId(request.user.userId);
    if (!account) {
      return { error: 'Tesla not connected' };
    }

    const tokens = await db.getTeslaTokensByAccountId(account.id);
    if (!tokens) {
      return { error: 'No Tesla tokens found' };
    }

    const accessToken = decrypt(tokens.access_token);
    await syncTeslaVehicles(account.id, accessToken);
    const vehicles = await db.getTeslaVehiclesByUserId(request.user.userId);
    return { status: 'ok', count: vehicles.length };
  });

  // Debug: manual one-time poll for a vehicle (Fleet Telemetry is primary channel)
  fastify.post('/vehicles/:vehicleId/debug-poll', async (request, reply) => {
    const { vehicleId } = request.params;
    const vehicle = await db.getTeslaVehicleByVehicleId(vehicleId);
    if (!vehicle || vehicle.user_id !== request.user.userId) {
      return reply.code(404).send({ error: 'Vehicle not found' });
    }
    const teslaPoller = require('../services/tesla-poller');
    const results = await teslaPoller.pollOnce(vehicle.vin);
    return results[0] || { error: 'No result' };
  });

  // Virtual key pairing URL — user opens this in Tesla app to approve
  fastify.get('/virtual-key-url', async () => {
    return {
      url: 'https://tesla.com/_ak/telemetry.qbitmap.com',
      instructions: 'Bu linki Tesla uygulamanızda açarak virtual key onayını verin.',
    };
  });

  // Enable Fleet Telemetry for a specific vehicle
  fastify.post('/vehicles/:vehicleId/enable-telemetry', async (request, reply) => {
    const { vehicleId } = request.params;
    const vehicle = await db.getTeslaVehicleByVehicleId(vehicleId);
    if (!vehicle || vehicle.user_id !== request.user.userId) {
      return reply.code(404).send({ error: 'Vehicle not found' });
    }

    const account = await db.getTeslaAccountByUserId(request.user.userId);
    const tokens = await db.getTeslaTokensByAccountId(account.id);
    if (!tokens) {
      return reply.code(400).send({ error: 'No Tesla tokens' });
    }

    const accessToken = decrypt(tokens.access_token);

    // Read TLS certificate PEM for CA field (Tesla requires the server's TLS cert, not the EC public key)
    let caPem = '';
    try {
      const fs = require('fs');
      const certPath = process.env.TESLA_TLS_CERT_PATH || '/opt/fleet-telemetry/server.crt';
      caPem = fs.readFileSync(certPath, 'utf8').trim();
    } catch (err) {
      logger.error({ err }, 'Failed to read TLS certificate for Fleet Telemetry');
      return reply.code(500).send({ error: 'TLS certificate not found' });
    }

    // Discover regional API base
    let apiBase = config.tesla.apiBase;
    try {
      const regionRes = await fetchWithTimeout('https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/users/region', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, 10000);
      if (regionRes.ok) {
        const regionData = await regionRes.json();
        if (regionData.response?.fleet_api_base_url) {
          apiBase = regionData.response.fleet_api_base_url;
        }
      }
    } catch { /* use default */ }

    // Send fleet telemetry config to Tesla
    const telemetryConfig = {
      vins: [vehicle.vin],
      config: {
        hostname: 'telemetry.qbitmap.com',
        port: 4443,
        ca: caPem,
        fields: {
          Location: { interval_seconds: 15, minimum_delta: 25 },
          VehicleSpeed: { interval_seconds: 15 },
          GpsHeading: { interval_seconds: 15 },
          Gear: { interval_seconds: 15 },
          BatteryLevel: { interval_seconds: 600 },
          RatedRange: { interval_seconds: 600 },
          InsideTemp: { interval_seconds: 600 },
          OutsideTemp: { interval_seconds: 600 },
          Locked: { interval_seconds: 600 },
          SentryMode: { interval_seconds: 600 },
          TpmsPressureFl: { interval_seconds: 600 },
          TpmsPressureFr: { interval_seconds: 600 },
          TpmsPressureRl: { interval_seconds: 600 },
          TpmsPressureRr: { interval_seconds: 600 },
          Odometer: { interval_seconds: 3600 },
          Version: { interval_seconds: 21600 },
        },
        alert_types: [],
      },
    };

    // Send via Tesla Vehicle Command HTTP Proxy (required for fleet_telemetry_config)
    logger.info({ vehicleId, vin: vehicle.vin }, 'Sending fleet telemetry config via proxy');
    const proxyRes = await sendToProxy('/api/1/vehicles/fleet_telemetry_config', accessToken, telemetryConfig);
    const res = { ok: proxyRes.ok, status: proxyRes.status, text: () => Promise.resolve(proxyRes.body) };

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.error({ status: res.status, body: errBody, vehicleId }, 'Fleet telemetry config failed');
      return reply.code(res.status).send({ error: 'Fleet telemetry config failed', detail: errBody });
    }

    await db.setTeslaVehicleTelemetryEnabled(vehicleId, true);
    logger.info({ vehicleId, vin: vehicle.vin }, 'Fleet Telemetry enabled for vehicle');
    return { status: 'ok', telemetryEnabled: true };
  });

  // Disable Fleet Telemetry for a specific vehicle
  fastify.post('/vehicles/:vehicleId/disable-telemetry', async (request, reply) => {
    const { vehicleId } = request.params;
    const vehicle = await db.getTeslaVehicleByVehicleId(vehicleId);
    if (!vehicle || vehicle.user_id !== request.user.userId) {
      return reply.code(404).send({ error: 'Vehicle not found' });
    }

    await db.setTeslaVehicleTelemetryEnabled(vehicleId, false);
    logger.info({ vehicleId }, 'Fleet Telemetry disabled for vehicle');
    return { status: 'ok', telemetryEnabled: false };
  });
}

// Telemetry webhook (called by Fleet Telemetry server, no user auth — uses shared secret)
async function teslaTelemetryRoutes(fastify) {

  fastify.post('/telemetry-event', async (request, reply) => {
    // [SEC-06] Constant-time comparison.
    // A plain `!==` leaks the matching prefix length through response
    // timing, letting an attacker iteratively recover the shared secret.
    // Buffer.from(... || '') handles a missing header without throwing, and
    // the length pre-check is required because timingSafeEqual rejects
    // unequal-length inputs with a thrown exception.
    const providedSecret = Buffer.from(request.headers['x-webhook-secret'] || '', 'utf8');
    const expectedSecret = Buffer.from(config.tesla.telemetryWebhookSecret, 'utf8');
    if (
      providedSecret.length !== expectedSecret.length ||
      !crypto.timingSafeEqual(providedSecret, expectedSecret)
    ) {
      return reply.code(401).send({ error: 'Invalid webhook secret' });
    }

    const { vin, lat, lng, soc, gear, bearing, speed, insideTemp, outsideTemp, estRange, locked, sentry, odometer, tpmsFl, tpmsFr, tpmsRl, tpmsRr, carVersion } = request.body;
    if (!vin) {
      return reply.code(400).send({ error: 'VIN required' });
    }

    await db.updateVehicleTelemetry({ vin, lat, lng, soc, gear, bearing, speed, insideTemp, outsideTemp, estRange, locked, sentry, odometer, tpmsFl, tpmsFr, tpmsRl, tpmsRr, carVersion });

    // Broadcast via WebSocket if available
    const vehicle = await db.getTeslaVehicleByVin(vin);
    if (vehicle) {
      if (vehicle.trim_badging == null) {
        const last = trimBackfillCooldown.get(vin) || 0;
        if (Date.now() - last > TRIM_BACKFILL_COOLDOWN_MS) {
          trimBackfillCooldown.set(vin, Date.now());
          backfillVehicleConfig(vehicle);
        }
      }
      const wsService = require('../services/websocket');
      const effectiveLat = lat ?? vehicle.last_lat;
      const effectiveLng = lng ?? vehicle.last_lng;
      wsService.broadcastTeslaUpdate(vehicle.user_id, {
        vin,
        vehicleId: vehicle.vehicle_id,
        lat: effectiveLat,
        lng: effectiveLng,
        soc: soc ?? vehicle.last_soc,
        gear: gear ?? vehicle.last_gear,
        bearing: bearing ?? vehicle.last_bearing,
        speed: speed ?? vehicle.last_speed,
        insideTemp: insideTemp ?? vehicle.last_inside_temp,
        outsideTemp: outsideTemp ?? vehicle.last_outside_temp,
        estRange: estRange ?? vehicle.last_est_range,
        locked: locked ?? vehicle.last_locked,
        sentry: sentry ?? vehicle.last_sentry,
      });

      if (lat != null && lng != null) {
        try {
          const proximity = require('../services/tesla-proximity');
          proximity.checkProximity(vehicle.user_id, {
            vin,
            lat: effectiveLat,
            lng: effectiveLng,
            displayName: vehicle.display_name,
          });
        } catch (err) {
          logger.warn({ err }, 'proximity check failed');
        }
      }
    }

    return { status: 'ok' };
  });
}

// Helper: Fetch and sync vehicles from Tesla Fleet API
async function syncTeslaVehicles(teslaAccountId, accessToken, apiBase) {
  const base = apiBase || config.tesla.apiBase;
  const response = await fetchWithTimeout(`${base}/api/1/vehicles`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, 15000);

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    logger.error({ status: response.status, body: errBody, url: `${base}/api/1/vehicles` }, 'Tesla vehicles API error');
    throw new Error(`Tesla vehicles API returned ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const vehicles = data.response || [];

  for (const v of vehicles) {
    await db.upsertTeslaVehicle({
      teslaAccountId,
      vehicleId: String(v.id),
      vin: v.vin,
      displayName: v.display_name || v.vin,
      model: v.vehicle_config?.car_type || inferModel(v.vin),
      color: v.vehicle_config?.exterior_color || null,
    });

    // Fetch initial vehicle data (location, charge, drive, config, state)
    try {
      const vdRes = await fetchWithTimeout(
        `${base}/api/1/vehicles/${v.id}/vehicle_data?endpoints=location_data%3Bcharge_state%3Bdrive_state%3Bvehicle_config%3Bvehicle_state%3Bclimate_state`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        15000
      );
      if (vdRes.ok) {
        const vd = await vdRes.json();
        const ds = vd.response?.drive_state;
        const cs = vd.response?.charge_state;
        const vc = vd.response?.vehicle_config;
        const vs = vd.response?.vehicle_state;
        const cl = vd.response?.climate_state;

        // Update vehicle info (config + state)
        if (vc || vs) {
          await db.upsertTeslaVehicle({
            teslaAccountId,
            vehicleId: String(v.id),
            vin: v.vin,
            displayName: vs?.vehicle_name || v.display_name || v.vin,
            model: inferModel(v.vin) || vc?.car_type,
            carType: vc?.car_type || null,
            color: vc?.exterior_color || null,
            wheelType: vc?.wheel_type || null,
            trimBadging: vc?.trim_badging || null,
            carVersion: vs?.car_version || null,
            // Tesla returns odometer in miles — store as km
            odometer: vs?.odometer != null ? vs.odometer * 1.60934 : null,
          });
        }

        // Update telemetry
        if (ds?.latitude) {
          await db.updateVehicleTelemetry({
            vin: v.vin,
            lat: ds.latitude,
            lng: ds.longitude,
            soc: cs?.usable_battery_level ?? cs?.battery_level,
            gear: ds.shift_state || 'P',
            bearing: ds.heading || 0,
            speed: ds.speed || 0,
            insideTemp: cl?.inside_temp,
            outsideTemp: cl?.outside_temp,
            estRange: cs?.est_battery_range ? Math.round(cs.est_battery_range * 1.60934) : null,
            locked: vs?.locked ? 1 : 0,
            sentry: vs?.sentry_mode ? 1 : 0,
          });
          logger.info({ vin: v.vin, lat: ds.latitude, lng: ds.longitude, soc: cs?.usable_battery_level }, 'Initial vehicle data fetched');
        }
      }
    } catch (e) {
      logger.warn({ vin: v.vin, err: e.message }, 'Failed to fetch initial vehicle data');
    }
  }

  return vehicles.length;
}

// Infer Tesla model from VIN (position 4)
function inferModel(vin) {
  if (!vin || vin.length < 5) return null;
  const modelChar = vin.charAt(3);
  const models = { 'S': 'Model S', '3': 'Model 3', 'X': 'Model X', 'Y': 'Model Y' };
  return models[modelChar] || null;
}

// Send request through Tesla Vehicle Command HTTP Proxy (localhost:8443)
function sendToProxy(path, accessToken, body) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'localhost',
      port: 8443,
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      rejectUnauthorized: false, // localhost proxy, cert hostname mismatch ok
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Proxy request timeout')); });
    req.write(data);
    req.end();
  });
}

module.exports = { teslaRoutes, teslaApiRoutes, teslaTelemetryRoutes };
