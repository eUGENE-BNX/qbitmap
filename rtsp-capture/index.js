/**
 * QBitmap RTSP Frame Capture Service
 *
 * Captures JPEG frames from RTSP streams via ffmpeg
 * and serves them through a REST API.
 *
 * Usage:
 *   node index.js
 *
 * Environment:
 *   PORT - Server port (default: 3002)
 *
 * Requirements:
 *   ffmpeg must be installed and in PATH
 */

const { startServer } = require('./src/server');

console.log('==========================================');
console.log('  QBitmap RTSP Frame Capture v1.0.0');
console.log('==========================================');

startServer().then(() => {
  console.log('[CAPTURE] Service started successfully');
  console.log('[CAPTURE] Start capture via POST /capture/start');
}).catch((error) => {
  console.error('[CAPTURE] Failed to start:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[CAPTURE] Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[CAPTURE] Shutting down...');
  process.exit(0);
});
