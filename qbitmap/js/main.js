/**
 * QBitmap Main Entry Point
 * Imports all modules in the correct order for the main map page
 */

// Page bootstrap (window.gtag, Plyr CSS swap). Must run before anything
// else touches those globals — keep it as the first import.
import './html-bootstrap.js';

// Core stylesheets (always needed)
import '../vendor/maplibre-gl.css';
import '../css/base.css';
import '../css/animations.css';
import '../css/style.css';
import '../css/modal.css';
import '../css/auth.css';
import '../css/pwa.css';
// Feature CSS moved to their respective modules for code splitting

// Core modules (config, utils loaded as dependencies)
import './config.js';
import './utils.js';
import './analytics.js';
import './labels.js';

// Map and visualization
import './map.js';
import './h3-grid.js';
import './h3-tron-trails.js';

// Auth and user features
import './auth.js';
import './user-location.js';
// Camera system (index.js imports all mixins)
import { CameraSystem, startCameraSystem } from './camera-system/index.js';

// UI
import './modal.js';

// PWA (service worker + install prompt). Dynamic import so the module
// stays out of the critical path and dev builds don't break when the
// virtual:pwa-register module is absent.
import('../src/pwa/register-sw.js')
  .then((m) => m.initServiceWorker?.())
  .catch((err) => console.warn('[pwa] register module failed', err));
import('../src/pwa/install-prompt.js')
  .then((m) => m.initInstallPrompt?.())
  .catch(() => {});
import('../src/pwa/offline-ui.js')
  .then((m) => m.initOfflineUI?.())
  .catch(() => {});
import('../src/pwa/wake-lock.js')
  .then((m) => m.initWakeLock?.())
  .catch(() => {});
import('../src/pwa/shortcuts.js')
  .then((m) => m.initShortcuts?.())
  .catch(() => {});
import('../src/pwa/share-inbox.js')
  .then((m) => m.initShareInbox?.())
  .catch(() => {});
import('./services/upload-outbox.js')
  .then((m) => m.initOutbox?.())
  .catch(() => {});
import('./services/upload-outbox-ui.js')
  .then((m) => m.initOutboxUI?.())
  .catch(() => {});

// Start camera system after all modules are loaded
document.addEventListener('DOMContentLoaded', () => {
  startCameraSystem();
});
