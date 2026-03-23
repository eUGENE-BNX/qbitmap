/**
 * QBitmap Analytics Module
 * Centralized Google Analytics 4 event tracking
 * Only active in production (disabled on localhost)
 */

import { QBitmapConfig } from './config.js';

const Analytics = {
  enabled: QBitmapConfig.env === 'production',
  GA_ID: 'G-5Y929W13D6',

  event(name, params = {}) {
    if (!this.enabled || typeof gtag === 'undefined') return;
    gtag('event', name, params);
  },

  setUser(user) {
    if (!this.enabled || typeof gtag === 'undefined' || !user) return;
    gtag('config', this.GA_ID, { user_id: user.id });
    gtag('set', 'user_properties', {
      user_role: user.role || 'user',
      has_cameras: !!user.cameraCount
    });
  },

  clearUser() {
    if (!this.enabled || typeof gtag === 'undefined') return;
    gtag('config', this.GA_ID, { user_id: undefined });
  },

  timing(name, startTime, params = {}) {
    if (!startTime) return;
    const ms = Math.round(performance.now() - startTime);
    this.event(name, { ...params, value: ms });
  },

  // Track page load performance
  _trackPageLoad() {
    if (!this.enabled) return;
    window.addEventListener('load', () => {
      const timing = performance.getEntriesByType('navigation')[0];
      if (timing) {
        this.event('page_load', { value: Math.round(timing.loadEventEnd) });
      }
    }, { once: true });
  }
};

// Auto-track page load
Analytics._trackPageLoad();

// Send initial page_view
if (Analytics.enabled && typeof gtag !== 'undefined') {
  gtag('event', 'page_view');
}

export { Analytics };
window.Analytics = Analytics;
