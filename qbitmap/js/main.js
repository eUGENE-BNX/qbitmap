/**
 * QBitmap Main Entry Point
 * Imports all modules in the correct order for the main map page
 */

// Core modules (config, utils loaded as dependencies)
import './config.js';
import './utils.js';
import './analytics.js';
import './voice-commands.js';
import './labels.js';

// Map and visualization
import './map.js';
import './h3-grid.js';
import './h3-tron-trails.js';

// Auth and user features
import './auth.js';
import './biometric-auth.js';
import './user-location.js';
import './voice-control.js';

// Camera system (index.js imports all mixins)
import { CameraSystem } from './camera-system/index.js';

// UI
import './modal.js';

// Start camera system after all modules are loaded
document.addEventListener('DOMContentLoaded', () => {
  if (window.startCameraSystem) window.startCameraSystem();
});
