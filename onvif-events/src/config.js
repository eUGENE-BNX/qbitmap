module.exports = {
  server: {
    host: '0.0.0.0',
    port: process.env.PORT || 3001
  },
  events: {
    maxPerCamera: 10  // Keep last N events per camera
  },
  webhook: {
    // QBitmap backend webhook URL
    url: process.env.WEBHOOK_URL || 'https://stream.qbitmap.com/api/onvif/webhook/event',
    enabled: process.env.WEBHOOK_ENABLED !== 'false'  // Enabled by default
  }
};
