import '../../css/vehicles.css';
import * as AppState from '../state.js';
import { routes, carIcons, truckIcon, defaultVehicles } from './routes.js';
import { calculateRouteLength } from './route-math.js';
import { CameraStreamMixin } from './camera-stream.js';
import { PopupMixin } from './popup.js';
import { AnimationMixin } from './animation.js';
import { MapLayerMixin } from './map-layer.js';

const VehicleAnimation = {
  routes,
  map: null,
  vehicles: [],
  animationId: null,
  isRunning: false,
  activeVehicles: {},
  vehiclePositions: {},
  lastFrameTime: 0,
  targetFrameTime: 1000 / 60,
  carIcons,
  truckIcon,
  defaultVehicles,

  init: function(map) {
    this.map = map;
    this.loadVehicles();

    var self = this;
    var setup = function() {
      self.addVehicleLayers();
      self.setupClickHandler();
      self.start();
    };

    if (map.isStyleLoaded()) {
      setup();
    } else {
      map.on('load', setup);
    }
  },

  loadVehicles: function() {
    var saved = localStorage.getItem('qbitmap_vehicles');
    var customVehicles = [];
    if (saved) { try { customVehicles = JSON.parse(saved); } catch(e) { localStorage.removeItem('qbitmap_vehicles'); } }
    var self = this;

    this.vehicles = this.defaultVehicles.map(function(def) {
      var custom = customVehicles.find(function(c) { return c.id === def.id; }) || {};
      var randomIconIndex = Math.floor(Math.random() * self.carIcons.length);
      return {
        id: def.id,
        plate: custom.plate || def.plate,
        route: def.route,
        baseSpeed: def.baseSpeed,
        direction: def.direction || 1,
        iconIndex: randomIconIndex,
        type: def.type,
        cameraId: custom.cameraId || null,
        progress: Math.random(),
        currentSpeed: def.baseSpeed,
        targetSpeed: def.baseSpeed,
        speedTimer: 0,
        routeLength: 0
      };
    });

    this.vehicles.forEach(function(v) {
      v.routeLength = calculateRouteLength(self.routes[v.route]);
    });
  },

  saveVehicles: function() {
    var data = this.vehicles.map(function(v) {
      return { id: v.id, plate: v.plate, cameraId: v.cameraId, whepUrl: v.whepUrl };
    });
    localStorage.setItem('qbitmap_vehicles', JSON.stringify(data));
  },
};

// Apply mixins
Object.assign(VehicleAnimation, CameraStreamMixin, PopupMixin, AnimationMixin, MapLayerMixin);

export { VehicleAnimation };
window.VehicleAnimation = VehicleAnimation;

// Initialize
(function initVehicleAnimation() {
  if (AppState.map) {
    VehicleAnimation.init(AppState.map);
  } else {
    setTimeout(initVehicleAnimation, 200);
  }
})();
