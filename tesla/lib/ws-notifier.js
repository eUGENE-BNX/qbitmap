const config = require('../config');

async function notifyBackend(update) {
  try {
    const response = await fetch(config.backend.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': config.backend.webhookSecret,
      },
      body: JSON.stringify(update),
    });

    if (!response.ok) {
      console.error(`Backend webhook failed: ${response.status}`);
    }
  } catch (err) {
    // Don't throw — telemetry processing shouldn't fail because of webhook
    console.error('Backend webhook error:', err.message);
  }
}

module.exports = { notifyBackend };
