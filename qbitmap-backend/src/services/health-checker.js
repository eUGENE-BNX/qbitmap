/**
 * Health Checker Service
 * Monitors the health status of all QBitmap services
 */

const { fetchWithTimeout } = require('../utils/fetch-timeout');
const { getVllmUrl } = require('../utils/ai-config');
const logger = require('../utils/logger').child({ module: 'health-checker' });
const { services } = require('../config');

const QBITMAP_HOST = services.qbitmapHost;
const MEDIAMTX_HOST = services.mediamtxHost;
// [ARCH-09] Voice host + URL now from config.js (was hardcoded IP).
const VOICE_HOST = services.voiceHost;
const VOICE_API_URL = services.voiceApiUrl;

const ONVIF_SERVICE_URL = services.onvifServiceUrl;
const CAPTURE_SERVICE_URL = services.captureServiceUrl;
const MEDIAMTX_WHEP_BASE = services.mediamtxWhepBase;
const MEDIAMTX_API = services.mediamtxApi;

// Service configurations
const SERVICES = [
  {
    id: 'qbitmap-web',
    name: 'QBitmap Web',
    description: 'Caddy Web Server',
    host: QBITMAP_HOST,
    url: 'https://qbitmap.com/',
    method: 'HEAD',
    timeout: 5000,
    icon: 'globe'
  },
  {
    id: 'backend-api',
    name: 'Backend API',
    description: 'Main API Server',
    host: QBITMAP_HOST,
    url: 'https://stream.qbitmap.com/health',
    method: 'GET',
    timeout: 5000,
    icon: 'server'
  },
  {
    id: 'onvif-service',
    name: 'ONVIF Service',
    description: 'Camera Event Handler',
    host: MEDIAMTX_HOST,
    url: `${ONVIF_SERVICE_URL}/health`,
    method: 'GET',
    timeout: 5000,
    icon: 'camera'
  },
  {
    id: 'capture-service',
    name: 'RTSP Capture',
    description: 'Stream Capture Service',
    host: MEDIAMTX_HOST,
    url: `${CAPTURE_SERVICE_URL}/health`,
    method: 'GET',
    timeout: 5000,
    icon: 'video'
  },
  {
    id: 'rtc-gateway-whep',
    name: 'RTC Gateway',
    description: 'WebRTC WHEP Server',
    host: MEDIAMTX_HOST,
    url: `${MEDIAMTX_WHEP_BASE}/`,
    method: 'GET',
    timeout: 5000,
    icon: 'broadcast',
    acceptCodes: [200, 301, 404] // WHEP endpoint returns 404 on root but service is up
  },
  {
    id: 'mediamtx-api',
    name: 'Media API',
    description: 'Media Server API',
    host: MEDIAMTX_HOST,
    url: `${MEDIAMTX_API}/v3/paths/list`,
    method: 'GET',
    timeout: 5000,
    icon: 'api',
    acceptCodes: [200, 401] // 401 means auth required but service is up
  },
  {
    id: 'ai-service',
    name: 'AI Service',
    description: 'vLLM Vision Server',
    host: '', // resolved dynamically from ai-config
    url: '',  // resolved dynamically from ai-config
    method: 'GET',
    timeout: 10000,
    icon: 'brain',
    dynamic: true
  },
  {
    id: 'face-recognition',
    name: 'Face Recognition',
    description: 'Face Matcher Service',
    host: 'matcher.qbitwise.com',
    url: 'https://matcher.qbitwise.com/',
    method: 'GET',
    timeout: 5000,
    icon: 'face',
    acceptCodes: [200, 301, 302] // Redirect means service is up
  },
  {
    id: 'voice-call',
    name: 'Voice Call',
    description: 'Matrix Voice Call API',
    host: VOICE_HOST,
    url: `${VOICE_API_URL}/api/health`,
    method: 'GET',
    timeout: 5000,
    icon: 'phone'
  }
];

// Connection topology for graph visualization
const CONNECTIONS = [
  { from: 'qbitmap-web', to: 'backend-api' },
  { from: 'backend-api', to: 'face-recognition' },
  { from: 'backend-api', to: 'ai-service' },
  { from: 'backend-api', to: 'onvif-service' },
  { from: 'backend-api', to: 'capture-service' },
  { from: 'backend-api', to: 'rtc-gateway-whep' },
  { from: 'backend-api', to: 'mediamtx-api' },
  { from: 'backend-api', to: 'voice-call' }
];

// Cache for health results
let healthCache = null;
let lastCheck = 0;
const CACHE_TTL = 15000; // 15 seconds

/**
 * Check health of a single service
 * @param {Object} service - Service configuration
 * @returns {Promise<Object>} Health check result
 */
async function checkService(service) {
  const startTime = Date.now();

  try {
    if (!service.url) {
      throw new Error('Service URL not configured');
    }

    const response = await fetchWithTimeout(
      service.url,
      { method: service.method },
      service.timeout
    );

    const responseTime = Date.now() - startTime;

    // Determine if response is acceptable
    const acceptCodes = service.acceptCodes || [200];
    const isAcceptable = response.ok || acceptCodes.includes(response.status);

    // Try to parse JSON response for additional metadata
    let metadata = {};
    if (service.method === 'GET' && response.ok) {
      try {
        const text = await response.text();
        if (text.startsWith('{') || text.startsWith('[')) {
          metadata = JSON.parse(text);
        }
      } catch (e) {
        // Not JSON response, that's OK
      }
    }

    return {
      id: service.id,
      name: service.name,
      description: service.description,
      host: service.host,
      icon: service.icon,
      status: isAcceptable ? 'online' : 'degraded',
      statusCode: response.status,
      responseTime,
      lastCheck: new Date().toISOString(),
      metadata
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;

    logger.warn({
      service: service.id,
      error: error.message,
      responseTime
    }, 'Service health check failed');

    return {
      id: service.id,
      name: service.name,
      description: service.description,
      host: service.host,
      icon: service.icon,
      status: 'offline',
      statusCode: null,
      responseTime,
      lastCheck: new Date().toISOString(),
      error: error.message
    };
  }
}

/**
 * Check health of all services
 * @param {boolean} forceRefresh - Force refresh ignoring cache
 * @returns {Promise<Object>} Aggregated health status
 */
async function resolveAiServiceUrl() {
  try {
    const chatUrl = await getVllmUrl();
    const baseUrl = chatUrl.replace(/\/v1\/chat\/completions$/, '');
    const aiService = SERVICES.find(s => s.id === 'ai-service');
    if (aiService) {
      aiService.url = `${baseUrl}/health`;
      try {
        const urlObj = new URL(baseUrl);
        aiService.host = urlObj.host;
      } catch {}
    }
  } catch (e) {
    logger.warn({ err: e }, 'Failed to resolve AI service URL');
  }
}

async function checkAllServices(forceRefresh = false) {
  const now = Date.now();

  // Return cached result if fresh and not forcing refresh
  if (!forceRefresh && healthCache && (now - lastCheck) < CACHE_TTL) {
    return healthCache;
  }

  logger.info('Running health checks for all services');

  // Resolve dynamic service URLs (AI service URL from DB/config)
  await resolveAiServiceUrl();

  // Check all services in parallel
  const results = await Promise.all(
    SERVICES.map(service => checkService(service))
  );

  // Calculate overall status
  const offlineCount = results.filter(r => r.status === 'offline').length;
  const degradedCount = results.filter(r => r.status === 'degraded').length;
  const onlineCount = results.filter(r => r.status === 'online').length;

  let overall = 'operational';
  if (offlineCount > 0) {
    overall = offlineCount >= results.length / 2 ? 'major_outage' : 'partial_outage';
  } else if (degradedCount > 0) {
    overall = 'degraded';
  }

  // Calculate average response time (only for online services)
  const onlineServices = results.filter(r => r.status === 'online' && r.responseTime);
  const avgResponseTime = onlineServices.length > 0
    ? Math.round(onlineServices.reduce((sum, s) => sum + s.responseTime, 0) / onlineServices.length)
    : null;

  healthCache = {
    timestamp: new Date().toISOString(),
    services: results,
    connections: CONNECTIONS,
    summary: {
      total: results.length,
      online: onlineCount,
      offline: offlineCount,
      degraded: degradedCount,
      avgResponseTime
    },
    overall
  };

  lastCheck = now;

  logger.info({
    overall,
    online: onlineCount,
    offline: offlineCount
  }, 'Health check completed');

  return healthCache;
}

/**
 * Get service configurations (for frontend graph layout)
 * @returns {Object} Service and connection configurations
 */
function getServiceConfig() {
  return {
    services: SERVICES.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      icon: s.icon
    })),
    connections: CONNECTIONS
  };
}

/**
 * Clear the health cache
 */
function clearCache() {
  healthCache = null;
  lastCheck = 0;
}

module.exports = {
  checkAllServices,
  checkService,
  getServiceConfig,
  clearCache,
  SERVICES,
  CONNECTIONS
};
