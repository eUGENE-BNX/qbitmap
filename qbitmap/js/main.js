/**
 * QBitmap Main Entry Point
 * Imports all modules in the correct order for the main map page
 */

// Core stylesheets (always needed)
import '../vendor/maplibre-gl.css';
import '../css/base.css';
import '../css/animations.css';
import '../css/style.css';
import '../css/modal.css';
import '../css/auth.css';
// Feature CSS moved to their respective modules for code splitting

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
import './user-location.js';
import './voice-control.js';

// Camera system (index.js imports all mixins)
import { CameraSystem, startCameraSystem } from './camera-system/index.js';

// UI
import './modal.js';

// Start camera system after all modules are loaded
document.addEventListener('DOMContentLoaded', () => {
  startCameraSystem();
});
