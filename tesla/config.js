require('dotenv').config();

// Crash at boot if a required secret is missing — no string fallbacks.
function requireEnv(name) {
  const v = process.env[name];
  if (v) return v;
  console.error(`\n❌ FATAL: Missing required environment variable: ${name}\n`);
  process.exit(1);
}

module.exports = {
  server: {
    port: process.env.TELEMETRY_PORT || 4443,
    host: process.env.TELEMETRY_HOST || '0.0.0.0',
  },
  tls: {
    certPath: process.env.TLS_CERT_PATH || '/etc/letsencrypt/live/telemetry.qbitmap.com/fullchain.pem',
    keyPath: process.env.TLS_KEY_PATH || '/etc/letsencrypt/live/telemetry.qbitmap.com/privkey.pem',
  },
  db: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'qbitmap',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'qbitmap',
    connectionLimit: 10,
    timezone: 'Z',
    charset: 'utf8mb4',
  },
  backend: {
    webhookUrl: process.env.BACKEND_WEBHOOK_URL || 'http://localhost:3000/api/tesla/telemetry-event',
    webhookSecret: requireEnv('TESLA_TELEMETRY_WEBHOOK_SECRET'),
  },
};
