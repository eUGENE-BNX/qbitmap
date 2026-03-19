/**
 * QBitmap Backend Constants
 * Centralized configuration for timeouts, limits, and magic numbers
 */

// ==================== TIMEOUTS (in milliseconds) ====================

const TIMEOUTS = {
  // Default timeout for most HTTP requests
  DEFAULT: 10000,           // 10s

  // Quick health checks
  HEALTH_CHECK: 5000,       // 5s

  // AI/ML services (slower operations)
  AI_ANALYSIS: 60000,       // 60s
  AI_SERVICE: 10000,        // 10s for AI service health

  // Face API operations
  FACE_API: 15000,          // 15s
  FACE_UPLOAD: 30000,       // 30s for image uploads
  FACE_RECOGNITION: 30000,  // 30s for face matching

  // ONVIF operations
  ONVIF_DEFAULT: 10000,     // 10s
  ONVIF_CREATE: 15000,      // 15s for camera creation
  ONVIF_DELETE: 10000,      // 10s for camera deletion

  // MediaMTX operations
  MEDIAMTX_API: 5000,       // 5s
  MEDIAMTX_HEALTH: 5000,    // 5s

  // Voice call
  VOICE_HEALTH: 5000,       // 5s
  VOICE_CALL: 60000,        // 60s call timeout

  // Stream operations
  STREAM_TIMEOUT: 30000,    // 30s for stream connections

  // SSH operations
  SSH_CONNECT: 10000,       // 10s
};

// ==================== CACHE SETTINGS ====================

const CACHE = {
  // Frame cache
  FRAME_TTL: 5000,          // 5s for frame cache

  // Health check cache
  HEALTH_TTL: 15000,        // 15s for health status cache

  // Settings cache
  SETTINGS_TTL: 300000,     // 5 minutes
};

// ==================== LIMITS ====================

const LIMITS = {
  // File uploads
  MAX_FACE_IMAGE_SIZE: 10 * 1024 * 1024,  // 10MB
  MAX_FRAME_SIZE: 5 * 1024 * 1024,        // 5MB

  // API limits
  MAX_CAMERAS_PER_USER: 50,
  MAX_EVENTS_PER_QUERY: 100,
  MAX_FACE_ATTEMPTS: 3,

  // Pagination
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
};

// ==================== PORTS ====================

const PORTS = {
  ONVIF_DEFAULT: 2020,
  RTSP_DEFAULT: 554,
  WHEP_DEFAULT: 8889,
  MEDIAMTX_API: 9997,
  MEDIAMTX_PLAYBACK: 9996,
  MEDIAMTX_METRICS: 9998,
};

// ==================== RECORDING SETTINGS ====================

const RECORDING = {
  SEGMENT_DURATION: '1h',
  PART_DURATION: '1s',
  DELETE_AFTER: '15d',
  FORMAT: 'fmp4',
  PATH_TEMPLATE: '/recordings/%path/%Y-%m-%d_%H-%M-%S-%f',
};

// ==================== EVENT TYPES ====================

const EVENT_TYPES = {
  MOTION: 'motion',
  HUMAN: 'human',
  VEHICLE: 'vehicle',
  PET: 'pet',
  TAMPER: 'tamper',
  LINE_CROSSING: 'line_crossing',
  FACE: 'face',
  FIRE: 'fire',
};

// ==================== SAMPLE TYPES (Voice API) ====================

const SAMPLE_TYPES = {
  FIRE: 'fire',
  HUMAN: 'human',
  PERSON: 'person',
};

module.exports = {
  TIMEOUTS,
  CACHE,
  LIMITS,
  PORTS,
  RECORDING,
  EVENT_TYPES,
  SAMPLE_TYPES,
};
