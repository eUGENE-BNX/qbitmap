const WebSocket = require('ws');
const db = require('./database');
const { verifyTokenWithVersion } = require('../utils/jwt');
const config = require('../config');
const logger = require('../utils/logger').child({ module: 'websocket' });
const cookie = require('cookie');
const { formatModel } = require('../utils/tesla-trim');

// Allow-list of origins permitted to open /ws/cameras. Browser WS handshakes
// always send Origin; non-browser callers (there are none — WS is frontend-
// only) would be rejected. Reused from CORS config so HTTP + WS stay in sync.
const ALLOWED_WS_ORIGINS = new Set(config.cors.origin);

/**
 * Extract token from request cookies (secure - no JS exposure)
 */
function extractTokenFromCookie(request) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;

  try {
    const cookies = cookie.parse(cookieHeader);
    return cookies.qbitmap_token || null;
  } catch {
    return null;
  }
}

// Per-connection rate limiter (message rate)
// Note: Node.js is single-threaded, so no mutex needed for Map operations
const connectionRateLimits = new Map(); // ws -> { count, resetTime }
const RATE_LIMIT_MAX = 100; // max messages per window
const RATE_LIMIT_WINDOW = 10000; // 10 second window

// Per-IP connection limiter (prevent connection flood DoS)
const ipConnectionCounts = new Map(); // ip -> count
const MAX_CONNECTIONS_PER_IP = 10;

// Backpressure threshold for broadcast fanout. If a socket's write buffer
// exceeds this, its client is slow or stuck and queueing more bytes only
// makes it worse — skip that iteration and keep the broadcast snappy for
// every healthy subscriber. 1 MiB matches the audit guidance and is several
// hundred typical broadcast messages worth of backlog, so a healthy client
// on a normal link never trips it.
const BACKPRESSURE_LIMIT_BYTES = 1 * 1024 * 1024;

function checkRateLimit(ws) {
  const now = Date.now();
  let record = connectionRateLimits.get(ws);

  if (!record || now > record.resetTime) {
    record = { count: 1, resetTime: now + RATE_LIMIT_WINDOW };
    connectionRateLimits.set(ws, record);
    return true;
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return false;
  }

  record.count++;
  return true;
}

function clearRateLimit(ws) {
  connectionRateLimits.delete(ws);
}

/**
 * Check if IP can open new connection (DoS protection)
 * Returns true if allowed, false if limit exceeded
 */
function checkIpConnectionLimit(ip) {
  const count = ipConnectionCounts.get(ip) || 0;
  if (count >= MAX_CONNECTIONS_PER_IP) {
    return false;
  }
  ipConnectionCounts.set(ip, count + 1);
  return true;
}

function decrementIpConnection(ip) {
  const count = ipConnectionCounts.get(ip) || 0;
  if (count <= 1) {
    ipConnectionCounts.delete(ip);
  } else {
    ipConnectionCounts.set(ip, count - 1);
  }
}

class WebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // userId -> Set of WebSocket connections
    this.heartbeatInterval = null; // Store for cleanup
    this.cleanupInterval = null;   // Store for cleanup
    this.shuttingDown = false;     // Flips true in shutdown(); blocks new upgrades
  }

  /**
   * Send payload to one socket with state + backpressure guards. Returns a
   * small status so callers can aggregate stats without duplicating checks:
   *   'sent'     — payload handed off to ws
   *   'closed'   — socket not OPEN (benign, routine races with close)
   *   'backpressure' — bufferedAmount > threshold, skipped (caller logs warn)
   *   'threw'    — ws.send threw (e.g. closed mid-call); treat as closed
   * Never throws to the caller.
   */
  _trySend(client, payload) {
    if (!client || client.readyState !== WebSocket.OPEN) return 'closed';
    if (client.bufferedAmount > BACKPRESSURE_LIMIT_BYTES) return 'backpressure';
    try {
      client.send(payload);
      return 'sent';
    } catch {
      return 'threw';
    }
  }

  /**
   * Initialize WebSocket server
   */
  initialize(server) {
    this.wss = new WebSocket.Server({
      server,
      path: '/ws/cameras',
      // Cookie-auth on WS is *not* same-origin-policied by browsers, so a
      // malicious page could trigger a credentialed WS upgrade on behalf of
      // the victim. SameSite on the session cookie is our primary defense;
      // this Origin allow-list is defense-in-depth for the case where SameSite
      // is relaxed (e.g., Lax + top-level nav) or the user's browser lags
      // behind. Missing Origin header → reject: every supported browser
      // sends it on WS upgrade.
      verifyClient: (info, cb) => {
        // During graceful shutdown reject new upgrades fast so systemd /
        // load-balancer stops sending traffic here; existing sockets are
        // drained separately in shutdown().
        if (this.shuttingDown) {
          return cb(false, 503, 'Server shutting down');
        }
        const origin = info.req.headers.origin;
        if (!origin || !ALLOWED_WS_ORIGINS.has(origin)) {
          logger.warn({ origin, ip: info.req.socket.remoteAddress }, 'WS upgrade rejected: origin not allowed');
          return cb(false, 403, 'Origin not allowed');
        }
        cb(true);
      }
    });

    this.wss.on('connection', async (ws, request) => {
      const clientIp = request.socket.remoteAddress;
      logger.info({ ip: clientIp }, 'New WebSocket connection');

      // [SECURITY] Per-IP connection limit (DoS protection)
      if (!checkIpConnectionLimit(clientIp)) {
        logger.warn({ ip: clientIp }, 'Connection rejected - IP limit exceeded');
        ws.close(1008, 'Too many connections from this IP');
        return;
      }

      // Store IP for cleanup on disconnect
      ws.clientIp = clientIp;

      // Initialize connection state
      ws.userId = null;
      ws.isAlive = true;
      ws.subscribedCameras = [];

      // [SECURITY] Auto-authenticate from HttpOnly cookie (no JS exposure)
      // [SEC-01] Full version-aware verification — a token whose user has
      // logged out or been deactivated must be rejected here, not admitted
      // because the raw JWT signature still validates.
      const token = extractTokenFromCookie(request);
      if (token) {
        const decoded = await verifyTokenWithVersion(token);
        if (decoded) {
          ws.userId = decoded.userId;
          ws.userEmail = decoded.email;
          this.addClient(ws);
          logger.info({ userId: ws.userId }, 'Client auto-authenticated from cookie');
          ws.send(JSON.stringify({ type: 'auth_success', payload: { userId: ws.userId } }));
          // Send initial state immediately
          this.sendInitialState(ws);
        }
      }

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (data) => {
        try {
          // [CC-007] Per-connection rate limit (100 msg/10s) - prevent flood
          if (!checkRateLimit(ws)) {
            logger.warn({ userId: ws.userId }, 'WebSocket rate limit exceeded');
            ws.send(JSON.stringify({ type: 'error', payload: { error: 'Rate limit exceeded (max 100 msg/10s)' } }));
            return;
          }

          // [CC-006] Message size limit (100KB) - prevent DoS
          if (data.length > 102400) {
            logger.warn({ size: data.length }, 'WebSocket message too large, ignoring');
            ws.send(JSON.stringify({ type: 'error', payload: { error: 'Message too large (max 100KB)' } }));
            return;
          }

          const message = JSON.parse(data);
          this.handleMessage(ws, message);
        } catch (error) {
          logger.error({ err: error }, 'Invalid WebSocket message');
          // Send error response to client
          try {
            ws.send(JSON.stringify({ type: 'error', payload: { error: 'Invalid JSON message' } }));
          } catch {
            // Client may have disconnected
          }
        }
      });

      ws.on('close', () => {
        if (ws._authTimeout) clearTimeout(ws._authTimeout);
        clearRateLimit(ws);
        decrementIpConnection(ws.clientIp);
        this.removeClient(ws);
        logger.info('Client disconnected');
      });

      ws.on('error', (error) => {
        logger.error({ err: error }, 'Connection error');
        // Clean up on error to prevent memory leaks
        clearRateLimit(ws);
        decrementIpConnection(ws.clientIp);
        this.removeClient(ws);
      });

      // Note: Initial state is sent after authentication, not on connection
      // This prevents leaking monitoring/alarm data to unauthenticated users

      // [SECURITY] Close unauthenticated connections after 10 seconds
      if (!ws.userId) {
        ws._authTimeout = setTimeout(() => {
          if (!ws.userId) {
            logger.warn({ ip: clientIp }, 'Closing unauthenticated WebSocket after timeout');
            ws.close(1008, 'Authentication timeout');
          }
        }, 10000);
      }
    });

    // Heartbeat to detect dead connections (store interval for cleanup).
    // .unref() so SIGTERM doesn't wait on the 30s heartbeat tick — shutdown()
    // still explicitly clearInterval's it, this is belt-and-suspenders.
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
          logger.debug('Terminating dead connection');
          // Clean up client from map before terminating
          // (terminate() may not always fire 'close' event)
          clearRateLimit(ws);
          decrementIpConnection(ws.clientIp);
          this.removeClient(ws);
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
    this.heartbeatInterval.unref();

    // Periodic cleanup of stale entries in clients Map (every 5 minutes)
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleClients();
    }, 300000);
    this.cleanupInterval.unref();

    logger.info('WebSocket server initialized on /ws/cameras');
  }

  /**
   * Handle incoming messages from clients
   */
  handleMessage(ws, message) {
    const { type, payload } = message;

    switch (type) {
      case 'subscribe':
        // [CC-003] Auth check - require authentication for subscriptions
        if (!ws.userId) {
          logger.warn('Subscribe attempt without authentication');
          ws.send(JSON.stringify({ type: 'error', payload: { error: 'Authentication required for subscriptions' } }));
          break;
        }
        // Client wants to subscribe to specific cameras
        ws.subscribedCameras = payload.cameras || [];
        logger.info({ cameras: ws.subscribedCameras }, 'Client subscribed to cameras');
        break;

      case 'auth':
        // [SECURITY] Token-based WS auth removed - use cookie auth on connection instead
        logger.warn('Deprecated token-based WS auth attempted');
        ws.send(JSON.stringify({
          type: 'auth_error',
          payload: { error: 'Token-based auth is deprecated. Refresh the page to use cookie auth.' }
        }));
        break;

      case 'subscribe_tesla':
        if (!ws.userId) {
          ws.send(JSON.stringify({ type: 'error', payload: { error: 'Authentication required' } }));
          break;
        }
        ws.subscribedTesla = true;
        this.sendTeslaVehicles(ws);
        break;

      case 'unsubscribe_tesla':
        ws.subscribedTesla = false;
        break;

      case 'ping':
        // Manual ping from client
        ws.send(JSON.stringify({ type: 'pong', payload: { timestamp: Date.now() } }));
        break;

      default:
        logger.warn({ type }, 'Unknown message type');
    }
  }

  /**
   * Add client to users map
   */
  addClient(ws) {
    if (ws.userId) {
      if (!this.clients.has(ws.userId)) {
        this.clients.set(ws.userId, new Set());
      }
      this.clients.get(ws.userId).add(ws);
    }
  }

  /**
   * Remove client from users map
   */
  removeClient(ws) {
    if (ws.userId && this.clients.has(ws.userId)) {
      const userClients = this.clients.get(ws.userId);
      userClients.delete(ws);
      if (userClients.size === 0) {
        this.clients.delete(ws.userId);
      }
    }
    // Clear references to help GC
    ws.userId = null;
    ws.subscribedCameras = null;
  }

  /**
   * Cleanup stale entries in clients Map
   * Removes entries where all WebSocket connections are closed
   */
  cleanupStaleClients() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [userId, wsSet] of this.clients.entries()) {
      // Remove closed connections from the Set
      for (const ws of wsSet) {
        if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          wsSet.delete(ws);
          cleanedCount++;
        }
      }
      // Remove empty Sets from the Map
      if (wsSet.size === 0) {
        this.clients.delete(userId);
      }
    }

    // [QW-2] Clean up rate limit and IP connection Maps for disconnected clients
    const activeIPs = new Set();
    for (const [, wsSet] of this.clients.entries()) {
      for (const ws of wsSet) {
        if (ws.readyState === WebSocket.OPEN && ws.clientIp) {
          activeIPs.add(ws.clientIp);
        }
      }
    }
    for (const ip of ipConnectionCounts.keys()) {
      if (!activeIPs.has(ip)) {
        ipConnectionCounts.delete(ip);
      }
    }
    // Clean rate limits for closed connections
    for (const ws of connectionRateLimits.keys()) {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        connectionRateLimits.delete(ws);
      }
    }

    // [PERF-14] Sweep expired _authCache entries so the Map doesn't grow
    // unbounded. Each entry has a 30s TTL; we piggyback on the 30s
    // cleanupStaleClients interval that already runs.
    if (this._authCache) {
      for (const [deviceId, entry] of this._authCache) {
        if (now - entry.time > 30000) this._authCache.delete(deviceId);
      }
    }

    if (cleanedCount > 0) {
      logger.info({ cleanedCount, remainingUsers: this.clients.size }, 'Cleaned up stale WebSocket clients');
    }
  }

  /**
   * Send initial state to authenticated client
   * [PERF] Uses database-level filtering to avoid N+1 queries
   */
  async sendInitialState(ws) {
    try {
      // Security: Only send state if user is authenticated
      if (!ws.userId) {
        logger.warn('Attempted to send initial state to unauthenticated client');
        return;
      }

      // [PERF] Filter at database level - single query instead of N+1
      const [monitoring, alarms, activeBroadcasts, unreadVideoMessages] = await Promise.all([
        db.getActiveMonitoringForUser(ws.userId),
        db.getActiveAlarmsForUser(ws.userId),
        db.getActiveBroadcasts(),
        db.getUnreadVideoMessageCount(ws.userId)
      ]);

      ws.send(JSON.stringify({
        type: 'initial_state',
        payload: {
          monitoring: monitoring.map(m => ({
            deviceId: m.device_id,
            enabled: !!m.enabled,
            startedAt: m.started_at
          })),
          alarms: alarms.map(a => ({
            id: a.id,
            deviceId: a.device_id,
            cameraName: a.name,
            data: a.alarm_data,
            triggeredAt: a.triggered_at
          })),
          broadcasts: activeBroadcasts,
          unreadVideoMessages
        }
      }));

      logger.info({ userId: ws.userId, monitoringCount: monitoring.length, alarmCount: alarms.length }, 'Sent initial state to authenticated client');
    } catch (error) {
      logger.error({ err: error }, 'Error sending initial state');
    }
  }

  /**
   * Send message to a specific user (all their WebSocket connections)
   */
  sendToUser(userId, message) {
    const userClients = this.clients.get(userId);
    if (!userClients) return 0;
    const payload = JSON.stringify(message);
    let sent = 0;
    let backpressure = 0;
    for (const ws of userClients) {
      const r = this._trySend(ws, payload);
      if (r === 'sent') sent++;
      else if (r === 'backpressure') backpressure++;
    }
    if (backpressure > 0) {
      logger.warn({ userId, type: message.type, backpressure }, 'sendToUser dropped frames due to bufferedAmount');
    }
    return sent;
  }

  /**
   * Broadcast message to all connected clients (use sparingly - prefer filtered broadcast)
   */
  broadcast(message) {
    const payload = JSON.stringify(message);
    let sentCount = 0;
    let backpressure = 0;

    this.wss.clients.forEach((client) => {
      const r = this._trySend(client, payload);
      if (r === 'sent') sentCount++;
      else if (r === 'backpressure') backpressure++;
    });

    if (backpressure > 0) {
      logger.warn({ type: message.type, sent: sentCount, backpressure }, 'broadcast dropped frames due to bufferedAmount');
    } else {
      logger.debug({ type: message.type, count: sentCount }, 'Broadcasted message');
    }
  }

  /**
   * Broadcast to authorized clients only (owner, shared access, or public camera)
   * [CC-011] Security: Users only receive events for cameras they can access
   * [PERF] Uses batch query + 30s cache to minimize DB load for frequent events
   */
  async broadcastToAuthorizedClients(deviceId, message) {
    const payload = JSON.stringify(message);
    let sentCount = 0;
    let skippedCount = 0;

    // [PERF] Cache authorized user sets per camera (30s TTL)
    const now = Date.now();
    let cached = this._authCache?.get(deviceId);
    let camera, authorizedSet, isPublicCamera;

    if (cached && now - cached.time < 30000) {
      camera = cached.camera;
      authorizedSet = cached.users;
      isPublicCamera = cached.isPublic;
    } else {
      camera = await db.getCameraByDeviceId(deviceId);
      isPublicCamera = camera?.is_public;
      const authorizedUserIds = await db.getUsersWithCameraAccess(deviceId);
      authorizedSet = new Set(authorizedUserIds);
      if (!this._authCache) this._authCache = new Map();
      this._authCache.set(deviceId, { camera, users: authorizedSet, isPublic: isPublicCamera, time: now });
    }

    let backpressureCount = 0;
    this.wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;

      // Check authorization using pre-fetched set
      let authorized = false;

      if (client.userId) {
        // Authenticated user - check using batch-fetched set
        authorized = authorizedSet.has(client.userId);
      } else if (isPublicCamera) {
        // Unauthenticated user can see public camera events
        authorized = true;
      }

      if (!authorized) {
        skippedCount++;
        return;
      }

      const r = this._trySend(client, payload);
      if (r === 'sent') sentCount++;
      else if (r === 'backpressure') backpressureCount++;
    });

    if (backpressureCount > 0) {
      logger.warn({ type: message.type, deviceId, sent: sentCount, skipped: skippedCount, backpressure: backpressureCount }, 'Authorized broadcast dropped frames due to bufferedAmount');
    } else {
      logger.debug({ type: message.type, deviceId, sent: sentCount, skipped: skippedCount }, 'Broadcasted to authorized clients');
    }
  }

  /**
   * Broadcast to specific camera subscribers
   */
  broadcastToCamera(deviceId, message) {
    const payload = JSON.stringify(message);
    let sentCount = 0;
    let backpressureCount = 0;

    this.wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      // Send to all clients if no subscription, or if client subscribed to this camera
      if (client.subscribedCameras.length === 0 || client.subscribedCameras.includes(deviceId)) {
        const r = this._trySend(client, payload);
        if (r === 'sent') sentCount++;
        else if (r === 'backpressure') backpressureCount++;
      }
    });

    if (backpressureCount > 0) {
      logger.warn({ type: message.type, deviceId, sent: sentCount, backpressure: backpressureCount }, 'broadcastToCamera dropped frames due to bufferedAmount');
    } else {
      logger.debug({ type: message.type, deviceId, count: sentCount }, 'Broadcasted to camera');
    }
  }

  /**
   * Broadcast AI monitoring state change (filtered by access)
   */
  async broadcastMonitoringChange(deviceId, enabled, startedBy) {
    await this.broadcastToAuthorizedClients(deviceId, {
      type: 'monitoring_changed',
      payload: {
        deviceId,
        enabled,
        startedBy,
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Broadcast new alarm (filtered by access)
   */
  async broadcastAlarm(alarmId, deviceId, cameraName, alarmData) {
    await this.broadcastToAuthorizedClients(deviceId, {
      type: 'alarm_triggered',
      payload: {
        id: alarmId,
        deviceId,
        cameraName,
        data: alarmData,
        timestamp: new Date().toISOString()
      }
    });

    // [PWA-01] Web Push fanout to every user with access to this camera.
    // WS reaches open tabs; push catches closed tabs / locked phones.
    // Fire-and-forget: never block the WS broadcast on gateway latency.
    (async () => {
      try {
        const pushService = require('./push');
        const authorizedUserIds = await db.getUsersWithCameraAccess(deviceId);
        const label = alarmData?.sample_type || alarmData?.type || 'Alarm';
        await Promise.allSettled(
          authorizedUserIds.map((userId) =>
            pushService.sendToUser(userId, {
              title: `${cameraName} — ${label}`,
              body: alarmData?.message || 'Kamera alarmı tetiklendi',
              tag: `alarm-${deviceId}`,
              topic: `alarm-${deviceId}`,
              urgency: 'high',
              navigate: '/',
            })
          )
        );
      } catch (err) {
        logger.warn({ err: err.message, deviceId }, 'alarm push dispatch failed');
      }
    })();
  }

  /**
   * Broadcast alarm cleared (filtered by access)
   */
  async broadcastAlarmCleared(alarmId, deviceId, clearedBy) {
    await this.broadcastToAuthorizedClients(deviceId, {
      type: 'alarm_cleared',
      payload: {
        id: alarmId,
        deviceId,
        clearedBy,
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Broadcast ONVIF event (filtered by access)
   */
  async broadcastOnvifEvent(eventData) {
    const clientCount = this.getClientCount();
    logger.info({ eventData, clientCount }, 'Broadcasting ONVIF event');

    // Filter by access if deviceId is available
    if (eventData.deviceId) {
      await this.broadcastToAuthorizedClients(eventData.deviceId, {
        type: 'onvif_event',
        payload: eventData
      });
    } else {
      // Fallback to broadcast (shouldn't happen normally)
      logger.warn('ONVIF event without deviceId, broadcasting to all');
      this.broadcast({
        type: 'onvif_event',
        payload: eventData
      });
    }
  }

  /**
   * Build the mesh payload FOR A SPECIFIC USER. Includes:
   *  - every mesh_visible vehicle (public),
   *  - the user's own vehicles (always visible to owner, even when hidden),
   *  - vehicles individually shared with this user via tesla_vehicle_shares.
   */
  async _buildTeslaMeshPayloadForUser(userId) {
    const vehicles = await db.getTeslaVehiclesVisibleToUser(userId);
    return vehicles.map(v => ({
      vin: v.vin,
      vehicleId: v.vehicle_id,
      displayName: v.display_name,
      model: formatModel(v.model, v.trim_badging),
      trimBadging: v.trim_badging || null,
      lat: v.last_lat,
      lng: v.last_lng,
      soc: v.last_soc,
      gear: v.last_gear,
      bearing: v.last_bearing,
      speed: v.last_speed,
      isOnline: !!v.is_online,
      insideTemp: v.last_inside_temp,
      outsideTemp: v.last_outside_temp,
      estRange: v.last_est_range,
      locked: v.last_locked != null ? !!v.last_locked : null,
      sentry: v.last_sentry != null ? !!v.last_sentry : null,
      color: v.color,
      carVersion: v.car_version,
      odometer: v.odometer ? Math.round(v.odometer) : null,
      tpms: v.last_tpms_fl != null ? { fl: v.last_tpms_fl, fr: v.last_tpms_fr, rl: v.last_tpms_rl, rr: v.last_tpms_rr } : null,
      ownerUserId: v.user_id,
      ownerName: v.display_name,
      ownerAvatar: v.avatar_url,
      teslaAvatar: v.owner_profile_image || null,
    }));
  }

  /**
   * Send current Tesla mesh to a client (user-specific: public + owned + shared).
   */
  async sendTeslaVehicles(ws) {
    try {
      if (!ws.userId) return;
      const payload = await this._buildTeslaMeshPayloadForUser(ws.userId);
      ws.send(JSON.stringify({ type: 'tesla_vehicles', payload }));
    } catch (err) {
      logger.error({ err }, 'Error sending Tesla vehicles');
    }
  }

  /**
   * Broadcast the full mesh snapshot. Each connected user gets a personalised
   * snapshot so hidden vehicles stay visible to their owner and share list.
   */
  async broadcastTeslaMesh() {
    try {
      let backpressure = 0;
      for (const [userId, userClients] of this.clients.entries()) {
        const needsSnapshot = [...userClients].some(
          ws => ws.readyState === WebSocket.OPEN && ws.subscribedTesla
        );
        if (!needsSnapshot) continue;

        const payload = await this._buildTeslaMeshPayloadForUser(userId);
        const msg = JSON.stringify({ type: 'tesla_vehicles', payload });
        for (const ws of userClients) {
          if (!ws.subscribedTesla) continue;
          const r = this._trySend(ws, msg);
          if (r === 'backpressure') backpressure++;
        }
      }
      if (backpressure > 0) {
        logger.warn({ backpressure }, 'broadcastTeslaMesh dropped frames due to bufferedAmount');
      }
    } catch (err) {
      logger.error({ err }, 'broadcastTeslaMesh failed');
    }
  }

  /**
   * Broadcast Tesla vehicle telemetry update.
   * If mesh_visible, fan out to all subscribed clients; otherwise only to
   * the owner and users the vehicle has been explicitly shared with.
   */
  async broadcastTeslaUpdate(userId, vehicleData) {
    const payload = JSON.stringify({ type: 'tesla_vehicle_update', payload: vehicleData });

    let vehicle = null;
    try {
      if (vehicleData.vin) {
        vehicle = await db.getTeslaVehicleByVin(vehicleData.vin);
      }
    } catch (err) {
      logger.warn({ err }, 'mesh_visible lookup failed');
    }

    let backpressure = 0;
    if (vehicle && vehicle.mesh_visible) {
      for (const userClients of this.clients.values()) {
        for (const ws of userClients) {
          if (!ws.subscribedTesla) continue;
          const r = this._trySend(ws, payload);
          if (r === 'backpressure') backpressure++;
        }
      }
      if (backpressure > 0) {
        logger.warn({ vin: vehicleData.vin, backpressure }, 'broadcastTeslaUpdate (mesh) dropped frames');
      }
      return;
    }

    // Hidden vehicle — send to owner + explicit share recipients.
    let recipientIds = [userId];
    if (vehicle) {
      try {
        recipientIds = await db.getTeslaVehiclePrivateAudience(vehicle.id);
      } catch (err) {
        logger.warn({ err }, 'private audience lookup failed, falling back to owner only');
      }
    }
    for (const uid of recipientIds) {
      const userClients = this.clients.get(uid);
      if (!userClients) continue;
      for (const ws of userClients) {
        if (!ws.subscribedTesla) continue;
        const r = this._trySend(ws, payload);
        if (r === 'backpressure') backpressure++;
      }
    }
    if (backpressure > 0) {
      logger.warn({ vin: vehicleData.vin, backpressure }, 'broadcastTeslaUpdate (private) dropped frames');
    }
  }

  /**
   * Send an arbitrary JSON message to every live connection of a user.
   * Used for targeted push (e.g. Tesla proximity alerts).
   */
  sendToUser(userId, message) {
    const userClients = this.clients.get(userId);
    if (!userClients) return false;
    const data = JSON.stringify(message);
    let delivered = false;
    let backpressure = 0;
    for (const ws of userClients) {
      const r = this._trySend(ws, data);
      if (r === 'sent') delivered = true;
      else if (r === 'backpressure') backpressure++;
    }
    if (backpressure > 0) {
      logger.warn({ userId, type: message.type, backpressure }, 'sendToUser (push) dropped frames due to bufferedAmount');
    }
    return delivered;
  }

  /**
   * Get connected clients count
   */
  getClientCount() {
    return this.wss ? this.wss.clients.size : 0;
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      totalClients: this.getClientCount(),
      authenticatedUsers: this.clients.size
    };
  }

  /**
   * Graceful shutdown.
   *
   * Order matters: flip shuttingDown → stop heartbeats → notify clients with
   * {type:'closing'} (so the FE can show a "reconnecting…" UI and pause
   * writes) → wait up to drainTimeoutMs for sockets to leave on their own →
   * force-close stragglers with 1001 (Going Away) → wss.close().
   *
   * Without this the old shutdown() tore down the HTTP server mid-frame,
   * so clients saw reset-connection noise and any in-flight broadcast was
   * silently dropped. Now they get a clean "closing" signal before we pull
   * the plug, and shutdown() awaits actual drain before the caller moves
   * on to fastify.close() + dbPool.end().
   */
  async shutdown({ drainTimeoutMs = 10000 } = {}) {
    this.shuttingDown = true;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.wss) {
      const closingMsg = JSON.stringify({ type: 'closing' });
      for (const ws of this.wss.clients) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(closingMsg);
        } catch (_) { /* client already gone */ }
      }

      const deadline = Date.now() + drainTimeoutMs;
      while (this.wss.clients.size > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }

      // Force-close anything still hanging around. 1001 = Going Away —
      // the spec-blessed code for a server restart/shutdown, so FE reconnect
      // logic knows this wasn't an error.
      for (const ws of this.wss.clients) {
        try { ws.close(1001, 'server shutdown'); } catch (_) {}
      }

      // Short grace so close frames get flushed to sockets before .close().
      await new Promise(r => setTimeout(r, 200));

      await new Promise(resolve => this.wss.close(() => resolve()));
      this.wss = null;
    }

    this.clients.clear();
    // [PERF-14] Drop auth cache on shutdown so a hot-reload doesn't
    // carry stale authorization data into the new instance.
    if (this._authCache) { this._authCache.clear(); this._authCache = null; }
    logger.info({ drainTimeoutMs }, 'WebSocket service shutdown complete');
  }
}

module.exports = new WebSocketService();
