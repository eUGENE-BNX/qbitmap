const WebSocket = require('ws');
const db = require('./database');
const { verifyToken } = require('../utils/jwt');
const logger = require('../utils/logger').child({ module: 'websocket' });
const cookie = require('cookie');

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
  }

  /**
   * Initialize WebSocket server
   */
  initialize(server) {
    this.wss = new WebSocket.Server({
      server,
      path: '/ws/cameras'
    });

    this.wss.on('connection', (ws, request) => {
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
      const token = extractTokenFromCookie(request);
      if (token) {
        const decoded = verifyToken(token);
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

    // Heartbeat to detect dead connections (store interval for cleanup)
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

    // Periodic cleanup of stale entries in clients Map (every 5 minutes)
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleClients();
    }, 300000);

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
            data: JSON.parse(a.alarm_data),
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
    for (const ws of userClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        sent++;
      }
    }
    return sent;
  }

  /**
   * Broadcast message to all connected clients (use sparingly - prefer filtered broadcast)
   */
  broadcast(message) {
    const payload = JSON.stringify(message);
    let sentCount = 0;

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sentCount++;
      }
    });

    logger.debug({ type: message.type, count: sentCount }, 'Broadcasted message');
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

      if (authorized) {
        client.send(payload);
        sentCount++;
      } else {
        skippedCount++;
      }
    });

    logger.debug({ type: message.type, deviceId, sent: sentCount, skipped: skippedCount }, 'Broadcasted to authorized clients');
  }

  /**
   * Broadcast to specific camera subscribers
   */
  broadcastToCamera(deviceId, message) {
    const payload = JSON.stringify(message);
    let sentCount = 0;

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        // Send to all clients if no subscription, or if client subscribed to this camera
        if (client.subscribedCameras.length === 0 || client.subscribedCameras.includes(deviceId)) {
          client.send(payload);
          sentCount++;
        }
      }
    });

    logger.debug({ type: message.type, deviceId, count: sentCount }, 'Broadcasted to camera');
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
   * Shutdown - clear intervals to prevent memory leaks on hot reload
   */
  shutdown() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.clients.clear();
    logger.info('WebSocket service shutdown complete');
  }
}

module.exports = new WebSocketService();
