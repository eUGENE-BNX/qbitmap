const Fastify = require('fastify');
const cors = require('@fastify/cors');
const cookie = require('@fastify/cookie');
const helmet = require('@fastify/helmet');
const rateLimit = require('@fastify/rate-limit');
const compress = require('@fastify/compress');
const formbody = require('@fastify/formbody');
const multipart = require('@fastify/multipart');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./services/database');
const cleanupService = require('./services/cleanup');
const wsService = require('./services/websocket');
const mediamtx = require('./services/mediamtx');

const isProduction = process.env.NODE_ENV === 'production';

async function buildServer() {
  const fastify = Fastify({
    logger: isProduction
      ? { level: 'info' }
      : {
          level: 'info',
          transport: {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname'
            }
          }
        },
    bodyLimit: 20 * 1024 * 1024,
    trustProxy: '127.0.0.1',
    disableRequestLogging: isProduction
  });

  await fastify.register(cookie);

  // GZIP/Deflate compression for responses > 1KB
  await fastify.register(compress, {
    encodings: ['gzip', 'deflate'],
    threshold: 1024,
    removeContentLengthHeader: false
  });

  // Security headers with Helmet
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://accounts.google.com", "https://apis.google.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        connectSrc: ["'self'", "wss:", "ws:", "https:", "http:"],
        frameSrc: ["'self'", "https://accounts.google.com"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'", "blob:"],
        workerSrc: ["'self'", "blob:"],
        frameAncestors: ["'self'"], // X-Frame-Options equivalent - only allow same origin
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false, // Allow embedding external resources
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // Additional security headers
    hsts: { maxAge: 31536000, includeSubDomains: true }, // Force HTTPS for 1 year
    xFrameOptions: { action: 'sameorigin' }, // Prevent clickjacking
    xContentTypeOptions: true, // Prevent MIME sniffing
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  });

  // CORS - required for cross-origin cookie authentication
  await fastify.register(cors, {
    origin: config.cors.origin,
    credentials: config.cors.credentials,
    exposedHeaders: config.cors.exposedHeaders,
    methods: config.cors.methods,
    allowedHeaders: config.cors.allowedHeaders
  });

  // Rate limiting - Global (150 req/min)
  await fastify.register(rateLimit, {
    max: 150,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip
  });

  // Auth-specific rate limiting (brute force protection)
  // These will be applied as route-level limits
  fastify.decorate('authRateLimit', {
    max: 5,  // 5 attempts per minute for auth endpoints
    timeWindow: '1 minute'
  });
  await fastify.register(formbody);
  await fastify.register(multipart, {
    limits: {
      fileSize: 2 * 1024 * 1024 // 2MB max for face images
    }
  });

  fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, async (req, body) => {
    return body;
  });

  fastify.addContentTypeParser('image/jpeg', { parseAs: 'buffer' }, async (req, body) => {
    return body;
  });

  // SDP parser for WHEP proxy
  fastify.addContentTypeParser('application/sdp', { parseAs: 'string' }, async (req, body) => {
    return body;
  });

  // Wait for MySQL connection pool and seed data
  await db.ensureReady();

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register auth routes (Google OAuth)
  await fastify.register(require('./routes/auth'));

  // Register public API routes (no auth)
  await fastify.register(require('./routes/public'), { prefix: '/api/public' });

  // Register device routes (with device auth)
  await fastify.register(require('./routes/devices'), { prefix: '/api/devices' });

  // Register user routes (with JWT auth)
  // Register AI proxy routes
  await fastify.register(require('./routes/ai'), { prefix: '/api/ai' });
  await fastify.register(require('./routes/users'), { prefix: '/api/users' });

  // Register monitoring routes (AI monitoring & alarms)
  await fastify.register(require('./routes/monitoring'), { prefix: '/api/monitoring' });

  // Register ONVIF routes (ONVIF integration)
  await fastify.register(require('./routes/onvif'), { prefix: '/api/onvif' });

  // Register recordings routes (WHEP camera recording)
  await fastify.register(require('./routes/recordings'), { prefix: '/api/recordings' });

  // Register zones routes (clickable zones for relay control)
  await fastify.register(require('./routes/zones'), { prefix: '/api/zones' });

  // Face detection routes
  // Register status routes (system health monitoring)
  await fastify.register(require('./routes/status'), { prefix: '/api/status' });
  await fastify.register(require('./routes/face-detection'), { prefix: '/api/face-detection' });

  // Register video message routes
  await fastify.register(require('./routes/video-messages'), { prefix: '/api/video-messages' });

  // Register view count routes (generic, used by video messages, cameras, etc.)
  await fastify.register(require('./routes/view-counts'), { prefix: '/api/views' });

  // Register comment routes (generic, used by video messages, cameras, etc.)
  await fastify.register(require('./routes/comments'), { prefix: '/api/comments' });

  // Register like routes (generic, used by video messages, etc.)
  await fastify.register(require('./routes/likes'), { prefix: '/api/likes' });

  // Register live broadcast routes
  await fastify.register(require('./routes/broadcasts'), { prefix: '/api/broadcasts' });

  // Register admin routes (admin panel)
  await fastify.register(require('./routes/admin'), { prefix: '/api/admin' });

  // Start cleanup service
  cleanupService.start();

  // Initialize WebSocket server after server is ready
  fastify.ready((err) => {
    if (err) {
      logger.error({ err }, 'Server ready error');
      throw err;
    }
    wsService.initialize(fastify.server);

    // Sync RTSP cameras with MediaMTX on startup (non-blocking)
    syncRtspCamerasWithMediamtx().catch(err =>
      logger.error({ err }, 'Initial MediaMTX sync failed (will retry in 2 minutes)')
    );

    // Periodic sync every 2 minutes (in case MediaMTX restarts)
    setInterval(syncRtspCamerasWithMediamtx, 2 * 60 * 1000);
  });

  return fastify;
}

/**
 * Sync all cameras (RTSP, RTMP, and City/HLS) from database to MediaMTX
 * This ensures cameras survive MediaMTX restarts
 */
async function syncRtspCamerasWithMediamtx() {
  try {
    let totalSynced = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    // Build list of all cameras to sync
    const syncTasks = [];

    const rtspCameras = await db.getRtspCamerasForSync();
    for (const camera of rtspCameras) {
      const { mediamtx_path, rtsp_source_url } = camera;
      if (!mediamtx_path || !rtsp_source_url) { totalSkipped++; continue; }
      syncTasks.push({ path: mediamtx_path, type: 'RTSP', sync: () => mediamtx.addPath(mediamtx_path, rtsp_source_url) });
    }

    const rtmpCameras = await db.getRtmpCamerasForSync();
    for (const camera of rtmpCameras) {
      const { mediamtx_path } = camera;
      if (!mediamtx_path) { totalSkipped++; continue; }
      syncTasks.push({ path: mediamtx_path, type: 'RTMP', sync: () => mediamtx.addRtmpPath(mediamtx_path) });
    }

    // City cameras no longer use MediaMTX — served as pre-recorded clips via clip-scheduler

    // [SF-8] Sync in parallel batches of 10 for faster startup
    const BATCH_SIZE = 10;
    for (let i = 0; i < syncTasks.length; i += BATCH_SIZE) {
      const batch = syncTasks.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(async (task) => {
        const exists = await mediamtx.pathExists(task.path);
        if (exists.exists) {
          // Remove stale path and re-add with correct source config
          await mediamtx.removePath(task.path);
        }
        const result = await task.sync();
        return { status: result.success ? 'synced' : 'failed', task, error: result.error };
      }));

      for (const settled of results) {
        if (settled.status === 'rejected') {
          totalFailed++;
          logger.error({ error: settled.reason?.message }, 'Camera sync batch error');
        } else if (settled.value.status === 'skipped') {
          totalSkipped++;
        } else if (settled.value.status === 'synced') {
          totalSynced++;
          logger.info({ path: settled.value.task.path, type: settled.value.task.type }, 'Camera synced to MediaMTX');
        } else {
          totalFailed++;
          logger.error({ path: settled.value.task.path, error: settled.value.error }, `Failed to sync ${settled.value.task.type} camera`);
        }
      }
    }

    const total = rtspCameras.length + rtmpCameras.length;
    if (total > 0) {
      logger.info({ synced: totalSynced, skipped: totalSkipped, failed: totalFailed, total }, 'MediaMTX sync completed');
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to sync cameras with MediaMTX');
  }
}

module.exports = buildServer;
