import { QBitmapConfig } from './config.js';

/**
 * QBitmap Utility Functions
 */

/**
 * [FE-001] Debug logging - reads from config environment
 * Production: false, Development: true
 */
const DEBUG = QBitmapConfig.env === 'development';

const Logger = {
  log(...args) {
    if (DEBUG) console.log(...args);
  },
  warn(...args) {
    if (DEBUG) console.warn(...args);
  },
  error(...args) {
    // Always log errors
    console.error(...args);
  }
};

/**
 * Escape HTML to prevent XSS attacks
 * Safe for: text content, attribute values, inline JS strings
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize user input for display
 */
function sanitize(str) {
  return escapeHtml(str);
}

/**
 * Fetch with timeout and optional retry
 * @param {string} url - URL to fetch
 * @param {object} options - Fetch options
 * @param {number} timeout - Timeout in ms (default 30000)
 * @param {number} retries - Number of retries (default 0)
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeout = 30000, retries = 0) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    if (retries > 0 && error.name === 'AbortError') {
      Logger.warn(`[Fetch] Timeout, retrying... (${retries} left)`);
      return fetchWithTimeout(url, options, timeout, retries - 1);
    }
    throw error;
  }
}

/**
 * Timer Manager - Centralized timer management to prevent memory leaks
 * Usage:
 *   TimerManager.setInterval('ai-monitor-cam1', callback, 3000);
 *   TimerManager.setTimeout('popup-close-cam1', callback, 5000);
 *   TimerManager.clear('ai-monitor-cam1');
 *   TimerManager.clearAll('ai-monitor'); // clears all with prefix
 */
/**
 * Load user's cameras (owned + shared) in parallel
 * @returns {Promise<{owned: Array, shared: Array}>}
 */
async function loadUserCameras() {
  const [ownedRes, sharedRes] = await Promise.allSettled([
    fetch(`${QBitmapConfig.api.users}/me/cameras`, { credentials: 'include' }),
    fetch(`${QBitmapConfig.api.users}/me/shared-cameras`, { credentials: 'include' })
  ]);

  let owned = [];
  let shared = [];

  if (ownedRes.status === 'fulfilled' && ownedRes.value.ok) {
    const data = await ownedRes.value.json();
    owned = data.cameras || [];
  }

  if (sharedRes.status === 'fulfilled' && sharedRes.value.ok) {
    const data = await sharedRes.value.json();
    shared = data.cameras || [];
  }

  return { owned, shared };
}

/**
 * Show a notification toast
 * @param {string} message - Message to display
 * @param {string} type - 'success' | 'error' | 'info'
 * @param {number} duration - Duration in ms (default 3000)
 */
function showNotification(message, type = 'info', duration = 3000) {
  // Remove existing notification
  const existing = document.querySelector('.qb-notification');
  if (existing) existing.remove();

  const notification = document.createElement('div');
  notification.className = `qb-notification qb-notification-${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; padding: 12px 20px;
    background: ${type === 'error' ? '#dc3545' : type === 'success' ? '#28a745' : '#17a2b8'};
    color: white; border-radius: 8px; z-index: 10000; font-size: 14px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3); animation: slideIn 0.3s ease;
  `;
  document.body.appendChild(notification);

  TimerManager.setTimeout('notification-hide', () => {
    notification.style.animation = 'slideOut 0.3s ease';
    TimerManager.setTimeout('notification-remove', () => notification.remove(), 300);
  }, duration);
}

const TimerManager = {
  _timers: new Map(), // name -> { type: 'interval'|'timeout', id: number }

  setInterval(name, callback, ms) {
    this.clear(name); // Clear existing timer with same name
    const id = setInterval(callback, ms);
    this._timers.set(name, { type: 'interval', id });
    Logger.log(`[TimerManager] Started interval: ${name}`);
    return id;
  },

  setTimeout(name, callback, ms) {
    this.clear(name); // Clear existing timer with same name
    const id = setTimeout(() => {
      this._timers.delete(name); // Auto-remove on completion
      callback();
    }, ms);
    this._timers.set(name, { type: 'timeout', id });
    Logger.log(`[TimerManager] Started timeout: ${name}`);
    return id;
  },

  clear(name) {
    const timer = this._timers.get(name);
    if (timer) {
      if (timer.type === 'interval') {
        clearInterval(timer.id);
      } else {
        clearTimeout(timer.id);
      }
      this._timers.delete(name);
      Logger.log(`[TimerManager] Cleared: ${name}`);
    }
  },

  clearAll(prefix) {
    for (const [name] of this._timers) {
      if (name.startsWith(prefix)) {
        this.clear(name);
      }
    }
  },

  clearAllTimers() {
    for (const [name] of this._timers) {
      this.clear(name);
    }
    Logger.log('[TimerManager] All timers cleared');
  },

  getActiveTimers() {
    return Array.from(this._timers.keys());
  }
};

export { Logger, escapeHtml, sanitize, fetchWithTimeout, loadUserCameras, showNotification, TimerManager };
