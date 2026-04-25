import { QBitmapConfig } from './config.js';
// HTML escape helpers live in a dedicated window-free module so the
// node:test XSS regression suite can import them without a DOM shim.
// Re-exported here to keep the existing utils.js public API stable.
import { escapeHtml, sanitize, escapeHtmlAllowFormat } from './html-escape.js';

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
  notification.setAttribute('role', 'status');
  notification.setAttribute('aria-live', 'polite');

  const dot = document.createElement('span');
  dot.className = 'qb-notification-dot';
  const text = document.createElement('span');
  text.className = 'qb-notification-text';
  text.textContent = message;
  notification.appendChild(dot);
  notification.appendChild(text);

  document.body.appendChild(notification);

  TimerManager.setTimeout('notification-hide', () => {
    notification.classList.add('qb-notification-leaving');
    TimerManager.setTimeout('notification-remove', () => notification.remove(), 220);
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

/**
 * Run a DOM mutation inside a View Transition so the browser can animate
 * between before/after states. Falls back to calling `fn` directly when
 * the API is missing (Firefox today, older Safari, reduced-motion users).
 *
 * Usage: viewTransition(() => modal.style.display = 'block')
 *
 * For shared-element morphs (avatar → profile modal, marker DOM → popup),
 * set matching `view-transition-name: foo` on the source and destination
 * elements' CSS before calling this. The browser ties them together and
 * crossfades+transforms automatically.
 */
function viewTransition(fn) {
  if (typeof document === 'undefined' ||
      typeof document.startViewTransition !== 'function' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    // No API or user prefers reduced motion — just mutate synchronously.
    return { finished: Promise.resolve(fn?.()) };
  }
  return document.startViewTransition(fn);
}

export { Logger, escapeHtml, escapeHtmlAllowFormat, sanitize, fetchWithTimeout, loadUserCameras, showNotification, TimerManager, viewTransition };
