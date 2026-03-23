/**
 * QBitmap Frontend Configuration
 * Centralized configuration for all frontend components
 */

// Auto-detect environment based on hostname
const isLocalhost = typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' ||
   window.location.hostname === '127.0.0.1' ||
   window.location.hostname.startsWith('192.168.'));

const isDevelopment = isLocalhost;

// Base URLs based on environment
const API_BASE = isDevelopment ? 'http://localhost:3000' : 'https://stream.qbitmap.com';
const WS_PROTOCOL = isDevelopment ? 'ws' : 'wss';
const FRONTEND_BASE = isDevelopment ? `http://${window.location.host}` : 'https://qbitmap.com';

const QBitmapConfig = {
  // Environment
  env: isDevelopment ? 'development' : 'production',

  // API Endpoints (auto-detected)
  api: {
    base: API_BASE,
    public: `${API_BASE}/api/public`,
    users: `${API_BASE}/api/users`,
    admin: `${API_BASE}/api/admin`,
    monitoring: `${API_BASE}/api/monitoring`,
    onvif: `${API_BASE}/api/onvif`,
    ai: `${API_BASE}/api/ai`,
    status: `${API_BASE}/api/status`,
    faceMatcher: 'https://matcher.qbitwise.com',
    h3: isDevelopment ? 'http://localhost:3100/api/v1' : 'https://h3.qbitmap.com/api/v1'
  },

  // WebSocket (auto-detected)
  ws: {
    cameras: `${WS_PROTOCOL}://${isDevelopment ? 'localhost:3000' : 'stream.qbitmap.com'}/ws/cameras`
  },

  // Static Assets
  static: {
    base: 'https://static.qbitmap.com',
    maps: 'https://static.qbitmap.com/maps'
  },

  // Frontend URL (auto-detected)
  frontend: {
    base: FRONTEND_BASE
  },

  // Feature Flags
  features: {
    biometricAuth: true,
    voiceControl: true,
    aiMonitoring: true,
    onvifIntegration: true
  },

  // Cache Settings
  cache: {
    frameTTL: 5000,      // 5 seconds for frame cache
    settingsTTL: 300000  // 5 minutes for settings cache
  },

  // Map Settings
  map: {
    defaultCenter: [29.12304, 40.99112], // Ataşehir
    defaultZoom: 14.5,
    turkeyCenter: [35.157, 39.167],      // Türkiye merkezi (zoom out için)
    maxZoom: 22,
    minZoom: 5.75
  },

  // AI Settings
  ai: {
    analysisInterval: 5000,  // 5 seconds between analyses
    confidenceThreshold: 0.7
  },

  // Voice Call Defaults (non-sensitive fallbacks only)
  // Sensitive values (apiUrl, roomId, targetUser) must come from backend settings
  voiceDefaults: {
    sampleType: 'human',
    cooldown: 30,
    autoHangup: 30000,
    callTimeout: 60000
  }
};

// Freeze config to prevent modifications
Object.freeze(QBitmapConfig);
Object.freeze(QBitmapConfig.api);
Object.freeze(QBitmapConfig.ws);
Object.freeze(QBitmapConfig.static);
Object.freeze(QBitmapConfig.frontend);
Object.freeze(QBitmapConfig.features);
Object.freeze(QBitmapConfig.cache);
Object.freeze(QBitmapConfig.map);
Object.freeze(QBitmapConfig.ai);
Object.freeze(QBitmapConfig.voiceDefaults);

// ES module export + backward compat for non-module pages
export { QBitmapConfig };
window.QBitmapConfig = QBitmapConfig;
