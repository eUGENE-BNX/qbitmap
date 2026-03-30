/**
 * QBitmap ONVIF Event Listener
 *
 * Listens to ONVIF events (motion, human, pet, vehicle detection)
 * from configured cameras and exposes them via REST API.
 *
 * Usage:
 *   node index.js
 *
 * Environment:
 *   PORT - Server port (default: 3001)
 */

const { startServer } = require('./src/server');

// Catch unhandled errors to prevent silent crashes
process.on('unhandledRejection', (reason) => {
  console.error('[ONVIF] FATAL: Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[ONVIF] FATAL: Uncaught exception:', err);
  process.exit(1);
});

console.log('========================================');
console.log('  QBitmap ONVIF Event Listener v1.0.0');
console.log('========================================');

startServer().then(() => {
  console.log('[ONVIF] Service started successfully');
  console.log('[ONVIF] Add cameras via POST /cameras');
}).catch((error) => {
  console.error('[ONVIF] Failed to start:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[ONVIF] Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[ONVIF] Shutting down...');
  process.exit(0);
});
