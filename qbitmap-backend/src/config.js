const isProduction = process.env.NODE_ENV === 'production';

// Helper: Required env var. Crashes at boot if missing — no string fallback,
// ever, for secrets/keys/tokens. Dev environments must populate .env.
function requireEnv(name) {
  const value = process.env[name];
  if (value) return value;
  console.error(`\n❌ FATAL: Missing required environment variable: ${name}`);
  console.error(`   Set it in your .env file or environment.\n`);
  process.exit(1);
}

module.exports = {
  server: {
    host: '0.0.0.0',
    port: process.env.PORT || 3000
  },
  cors: {
    origin: isProduction
      ? ['https://qbitmap.com', 'https://stream.qbitmap.com']
      : ['http://localhost:3000', 'http://localhost:8080', 'http://127.0.0.1:3000'],
    credentials: true,
    exposedHeaders: ['X-Config-Version'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-ID', 'X-Device-Token', 'X-Config-Version']
  },
  oauth: {
    google: {
      clientId: requireEnv('GOOGLE_CLIENT_ID'),
      clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
      callbackUri: isProduction
        ? 'https://stream.qbitmap.com/auth/google/callback'
        : 'http://localhost:3000/auth/google/callback'
    }
  },
  jwt: {
    secret: requireEnv('JWT_SECRET'),
    expiresIn: '7d'
  },
  auth: {
    sharedSecret: requireEnv('DEVICE_SHARED_SECRET')
  },
  frontend: {
    url: process.env.FRONTEND_URL || (isProduction ? 'https://qbitmap.com' : 'http://localhost:8080')
  },
  googlePlaces: {
    apiKey: requireEnv('GOOGLE_PLACES_API_KEY'),
    defaultRadius: 30,
    maxResultCount: 10,
    cacheTTLDays: 30
  },
  tesla: {
    clientId: requireEnv('TESLA_CLIENT_ID'),
    clientSecret: requireEnv('TESLA_CLIENT_SECRET'),
    callbackUri: isProduction
      ? 'https://stream.qbitmap.com/auth/tesla/callback'
      : 'http://localhost:3000/auth/tesla/callback',
    scopes: 'openid user_data vehicle_device_data vehicle_cmds vehicle_location vehicle_charging_cmds offline_access',
    authUrl: 'https://auth.tesla.com/oauth2/v3/authorize',
    tokenUrl: 'https://auth.tesla.com/oauth2/v3/token',
    apiBase: 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
    telemetryWebhookSecret: requireEnv('TESLA_TELEMETRY_WEBHOOK_SECRET'),
  },
  services: (() => {
    const mtxHost = process.env.MEDIAMTX_HOST || '91.98.90.57';
    return {
      mediamtxHost: mtxHost,
      mediamtxApi: process.env.MEDIAMTX_API || `http://${mtxHost}:9997`,
      mediamtxWhepBase: process.env.MEDIAMTX_WHEP_BASE || `http://${mtxHost}:8889`,
      mediamtxHlsBase: process.env.MEDIAMTX_HLS_BASE || 'https://hls.qbitmap.com',
      mediamtxPlayback: process.env.MEDIAMTX_PLAYBACK || `http://${mtxHost}:9996`,
      mediamtxRecordingApi: process.env.MEDIAMTX_RECORDING_API || `http://${mtxHost}:9999`,
      mediamtxServer: process.env.MEDIAMTX_SERVER || mtxHost,
      onvifServiceUrl: process.env.ONVIF_SERVICE_URL || `http://${mtxHost}:3003`,
      captureServiceUrl: process.env.CAPTURE_SERVICE_URL || `http://${mtxHost}:3002`,
      qbitmapHost: process.env.QBITMAP_HOST || '91.99.219.248',
      allowedWhepHosts: (process.env.ALLOWED_WHEP_HOSTS || mtxHost).split(',').map(s => s.trim()),
      webhookAllowedIps: (process.env.ONVIF_WEBHOOK_IPS || `${mtxHost},127.0.0.1,::1`).split(',').map(s => s.trim()),
    };
  })()
};
