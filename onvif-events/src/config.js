// Validate WEBHOOK_URL at boot. A misconfigured value (e.g. http://localhost,
// http://169.254.169.254) would turn camera events into an SSRF channel
// against whatever lives on the same host. Refuse to start instead.
const DEFAULT_WEBHOOK_URL = 'https://stream.qbitmap.com/api/onvif/webhook/event';
const ALLOWED_WEBHOOK_HOSTS = (process.env.WEBHOOK_ALLOWED_HOSTS || 'stream.qbitmap.com')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function validateWebhookUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    throw new Error(`WEBHOOK_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`WEBHOOK_URL must be http(s): ${raw}`);
  }
  if (!ALLOWED_WEBHOOK_HOSTS.includes(url.hostname)) {
    throw new Error(
      `WEBHOOK_URL host "${url.hostname}" not in allowlist [${ALLOWED_WEBHOOK_HOSTS.join(', ')}]. ` +
      `Set WEBHOOK_ALLOWED_HOSTS to override.`
    );
  }
  return url.toString();
}

const webhookUrl = validateWebhookUrl(process.env.WEBHOOK_URL || DEFAULT_WEBHOOK_URL);

module.exports = {
  server: {
    host: '0.0.0.0',
    port: process.env.PORT || 3001
  },
  events: {
    maxPerCamera: 10  // Keep last N events per camera
  },
  webhook: {
    url: webhookUrl,
    enabled: process.env.WEBHOOK_ENABLED !== 'false'  // Enabled by default
  }
};
