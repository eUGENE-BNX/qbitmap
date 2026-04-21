import { QBitmapConfig } from '../config.js';
import { Logger } from '../utils.js';

// [PERF-01] Lazy feature loaders
// -------------------------------
// The WS mixin only touches LiveBroadcast / VideoMessage / CommentWidget
// inside specific event-type branches. Static imports here dragged all three
// chunks (~120KB combined) into the main graph on every page load even
// though most sessions never trigger those events.
//
// Each loader caches its resolved module so subsequent events are sync after
// the first miss. Handlers that can be fire-and-forget use .then(); paths
// that need the module synchronously (handleInitialState) await it.
let _liveBroadcastPromise = null;
function getLiveBroadcast() {
  if (!_liveBroadcastPromise) {
    _liveBroadcastPromise = import('../live-broadcast/index.js').then(m => m.LiveBroadcast);
  }
  return _liveBroadcastPromise;
}

let _videoMessagePromise = null;
function getVideoMessage() {
  if (!_videoMessagePromise) {
    _videoMessagePromise = import('../video-message/index.js').then(m => m.VideoMessage);
  }
  return _videoMessagePromise;
}

let _commentWidgetPromise = null;
function getCommentWidget() {
  if (!_commentWidgetPromise) {
    _commentWidgetPromise = import('../comments.js').then(m => m.CommentWidget);
  }
  return _commentWidgetPromise;
}

/**
 * QBitmap Camera System - WebSocket Module
 * Handles real-time communication with backend
 */

const WebSocketMixin = {
  /**
   * Initialize WebSocket connection for real-time AI monitoring and alarm sync
   */
  initWebSocket() {
    const wsUrl = QBitmapConfig.ws.cameras;

    Logger.log('[WS] Connecting to', wsUrl);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      Logger.log('[WS] Connected successfully');
      this.wsReconnectAttempts = 0;
      // [SECURITY] Auth is now automatic via HttpOnly cookie
      // No need to fetch/send token - server reads cookie on connection
      Logger.log('[WS] Auth handled via HttpOnly cookie');
    };

    // [MI-2] Batch WS messages with RAF to prevent DOM thrashing
    this.wsPendingMessages = [];
    this.wsRafPending = false;

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'onvif_event') {
          Logger.log('[WS] ONVIF event received');
        }

        // Urgent messages (alarms, auth) process immediately
        if (message.type === 'alarm_triggered' || message.type === 'auth_success' || message.type === 'auth_error' || message.type === 'initial_state' || message.type === 'face_absence_alarm') {
          this.handleWebSocketMessage(message);
          return;
        }

        // Batch non-urgent messages into next animation frame
        this.wsPendingMessages.push(message);
        if (!this.wsRafPending) {
          this.wsRafPending = true;
          requestAnimationFrame(() => {
            const batch = this.wsPendingMessages;
            this.wsPendingMessages = [];
            this.wsRafPending = false;
            for (const msg of batch) {
              this.handleWebSocketMessage(msg);
            }
          });
        }
      } catch (error) {
        Logger.error('[WS] Invalid message:', error);
      }
    };

    this.ws.onerror = (error) => {
      Logger.error('[WS] Error:', error);
    };

    this.ws.onclose = () => {
      Logger.warn('[WS] Disconnected');
      this.reconnectWebSocket();
    };
  },

  /**
   * Handle incoming WebSocket messages
   */
  handleWebSocketMessage(message) {
    const { type, payload } = message;

    switch (type) {
      case 'initial_state':
        this.handleInitialState(payload);
        break;

      case 'monitoring_changed':
        this.handleMonitoringChanged(payload);
        break;

      case 'alarm_triggered':
        this.handleAlarmTriggered(payload);
        break;

      case 'alarm_cleared':
        this.handleAlarmCleared(payload);
        break;

      case 'onvif_event':
        this.handleOnvifEvent(payload);
        break;

      case 'broadcast_started':
        getLiveBroadcast().then(LB => LB.handleBroadcastStarted(payload));
        break;

      case 'broadcast_ended':
        getLiveBroadcast().then(LB => LB.handleBroadcastEnded(payload));
        break;

      case 'recording_saved':
        getLiveBroadcast().then(LB => LB.handleRecordingSaved(payload));
        break;

      case 'video_message_new':
        getVideoMessage().then(VM => VM.handleNewMessage(payload));
        break;

      case 'video_message_deleted':
        getVideoMessage().then(VM => VM.handleDeletedMessage(payload));
        break;

      case 'video_message_unread_count':
        this._unreadVideoMessages = Number(payload.count) || 0;
        getVideoMessage().then(VM => VM.updateBadgeCount(payload.count));
        this._syncAppBadge();
        break;

      case 'video_message_tags_updated':
        getVideoMessage().then(VM => VM.handleTagsUpdated(payload));
        break;

      case 'ai_description_ready':
        getVideoMessage().then(VM => VM.handleAiDescriptionReady(payload));
        break;

      case 'comment_new':
        getCommentWidget().then(CW => CW.handleCommentNew(payload));
        break;

      case 'comment_deleted':
        getCommentWidget().then(CW => CW.handleCommentDeleted(payload));
        break;

      case 'pong':
        // Heartbeat response
        break;

      case 'auth_success':
        Logger.log('[WS] Authenticated successfully, userId:', payload.userId);
        break;

      case 'auth_error':
        Logger.warn('[WS] Authentication failed:', payload.error);
        break;

      case 'face_absence_alarm':
        if (typeof this.showFaceAbsenceAlert === 'function') {
          this.showFaceAbsenceAlert(payload);
        } else {
          Logger.warn('[WS] face_absence_alarm received but handler missing');
        }
        break;

      default:
        Logger.warn('[WS] Unknown message type:', type);
    }
  },

  /**
   * Handle initial state on WebSocket connect
   * [PERF-01] Async so we only load LiveBroadcast / VideoMessage chunks
   * when the server actually has broadcast / video-message state to
   * restore. A session with neither won't pay for those chunks at all.
   */
  async handleInitialState(payload) {
    Logger.log('[WS] Received initial state:', payload);

    // Restore AI monitoring states
    for (const monitor of payload.monitoring) {
      if (monitor.enabled) {
        this.aiMonitoring.set(monitor.deviceId, {
          enabled: true,
          startedAt: monitor.startedAt,
          intervalId: null, // Will be started if popup opens
          isAnalyzing: false,
          recentResults: []
        });
      }
    }

    // Restore active alarms
    for (const alarm of payload.alarms) {
      this.activeAlarms.set(alarm.deviceId, alarm);
    }

    // Restore active broadcasts (lazy-load LiveBroadcast only if any exist)
    if (payload.broadcasts && payload.broadcasts.length) {
      const LiveBroadcast = await getLiveBroadcast();
      LiveBroadcast.activeBroadcasts.clear();
      for (const b of payload.broadcasts) {
        LiveBroadcast.activeBroadcasts.set(b.broadcast_id, b);
      }
      LiveBroadcast.updateMapLayer();
    }

    // Restore unread video message count (lazy-load VideoMessage only if needed)
    if (payload.unreadVideoMessages !== undefined) {
      this._unreadVideoMessages = Number(payload.unreadVideoMessages) || 0;
      const VideoMessage = await getVideoMessage();
      VideoMessage.updateBadgeCount(payload.unreadVideoMessages);
    }

    // Update map icons
    this.updateAllCameraIcons();

    // [PWA] Sync OS-level app badge (Android launcher, Chrome/Edge
    // taskbar, iPadOS dock) with active alarm + unread message count.
    this._syncAppBadge();
  },

  // [PWA] Bridge alarm / unread-message counts to `navigator.setAppBadge`.
  // Silent no-op where the API is unsupported (Firefox, older Safari).
  // Cleared by register-sw.js on `visibilitychange` when the user comes
  // back to the tab.
  _syncAppBadge() {
    if (typeof navigator === 'undefined' || typeof navigator.setAppBadge !== 'function') return;
    const unread = this._unreadVideoMessages || 0;
    const alarms = this.activeAlarms?.size || 0;
    const total = unread + alarms;
    try {
      if (total > 0) navigator.setAppBadge(total).catch(() => {});
      else navigator.clearAppBadge?.().catch(() => {});
    } catch { /* noop */ }
  },

  /**
   * Handle monitoring state change from server
   */
  handleMonitoringChanged(payload) {
    const { deviceId, enabled } = payload;
    Logger.log('[WS] Monitoring changed:', deviceId, enabled);

    if (enabled) {
      // Check if already running (from direct toggleFallDetection call)
      const existingState = this.aiMonitoring.get(deviceId);
      if (existingState?.intervalId || existingState?.isStarting) {
        Logger.log(`[WS] Monitoring already started for ${deviceId}, skipping`);
        return;
      }

      // AI monitoring started - only create state if not exists
      if (!existingState) {
        this.aiMonitoring.set(deviceId, {
          enabled: true,
          intervalId: null,
          isAnalyzing: false,
          recentResults: []
        });
      }

      // Start local analysis if popup is open
      if (this.popups.has(deviceId)) {
        this.startLocalAIInterval(deviceId);
      }
    } else {
      // AI monitoring stopped
      this.stopAIMonitoring(deviceId);
    }

    // Update camera icon on map
    this.updateCameraIcon(deviceId);
  },

  /**
   * Handle alarm triggered from server
   */
  handleAlarmTriggered(payload) {
    const { id, deviceId, cameraName, data } = payload;
    Logger.log('[WS] Alarm triggered:', deviceId, data);

    // Skip if already shown locally (popup AI analyze triggers it directly)
    const existing = this.activeAlarms.get(deviceId);
    if (existing && existing.id === id) {
      Logger.log('[WS] Alarm already displayed locally, skipping');
      return;
    }

    // Store alarm
    this.activeAlarms.set(deviceId, { id, deviceId, cameraName, data });

    // Show alarm popup
    this.showAlarmPopup(deviceId, data, cameraName);

    // Play sound
    this.playAlarmSound();

    // Update camera icon on map
    this.updateCameraIcon(deviceId);

    // Maybe auto-open camera popup
    this.maybeAutoOpenCamera(deviceId);

    this._syncAppBadge();
  },

  /**
   * Handle alarm cleared from server
   */
  handleAlarmCleared(payload) {
    const { deviceId } = payload;
    Logger.log('[WS] Alarm cleared:', deviceId);

    // Remove from active alarms
    this.activeAlarms.delete(deviceId);

    // Dismiss alarm popup
    this.dismissAlarm();

    // Update camera icon on map
    this.updateCameraIcon(deviceId);

    this._syncAppBadge();
  },

  /**
   * Reconnect WebSocket with exponential backoff
   */
  reconnectWebSocket() {
    // Clear any existing reconnect timeout
    if (this.wsReconnectTimeout) {
      clearTimeout(this.wsReconnectTimeout);
      this.wsReconnectTimeout = null;
    }

    if (this.wsReconnectAttempts >= this.wsMaxReconnectAttempts) {
      Logger.error('[WS] Max reconnection attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.wsReconnectAttempts), 30000);
    this.wsReconnectAttempts++;

    Logger.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.wsReconnectAttempts})`);

    this.wsReconnectTimeout = setTimeout(() => {
      this.wsReconnectTimeout = null;
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this.initWebSocket();
      }
    }, delay);
  },

  /**
   * Cleanup WebSocket resources
   */
  cleanupWebSocket() {
    // Clear reconnect timeout
    if (this.wsReconnectTimeout) {
      clearTimeout(this.wsReconnectTimeout);
      this.wsReconnectTimeout = null;
    }

    // Close WebSocket connection
    if (this.ws) {
      this.ws.onclose = null; // Prevent reconnection on intentional close
      this.ws.close();
      this.ws = null;
    }

    Logger.log('[WS] Cleanup complete');
  }
};

export { WebSocketMixin };
