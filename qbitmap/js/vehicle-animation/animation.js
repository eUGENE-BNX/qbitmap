import { getPointAlongRoute, calculateBearing } from './route-math.js';

/**
 * Animation loop and speed control
 */
export const AnimationMixin = {
  updateVehicleSpeed: function(v, deltaMultiplier) {
    v.speedTimer += deltaMultiplier;
    if (v.speedTimer > 60 + Math.random() * 120) {
      v.speedTimer = 0;
      if (Math.random() < 0.03) {
        v.targetSpeed = v.baseSpeed * 0.1;
      } else {
        v.targetSpeed = v.baseSpeed * (0.4 + Math.random() * 1.0);
      }
    }
    v.currentSpeed += (v.targetSpeed - v.currentSpeed) * 0.02 * deltaMultiplier;
  },

  animate: function(currentTime) {
    if (!this.isRunning) return;

    if (!currentTime) currentTime = performance.now();
    var deltaTime = this.lastFrameTime ? (currentTime - this.lastFrameTime) : this.targetFrameTime;
    this.lastFrameTime = currentTime;

    deltaTime = Math.min(deltaTime, 100);

    var deltaMultiplier = deltaTime / this.targetFrameTime;

    var self = this;
    var features = this.vehicles.map(function(v) {
      self.updateVehicleSpeed(v, deltaMultiplier);
      v.progress += v.currentSpeed * v.direction * deltaMultiplier;

      if (v.progress >= 1) { v.progress = 1; v.direction = -1; }
      else if (v.progress <= 0) { v.progress = 0; v.direction = 1; }

      var coords = self.routes[v.route];
      var pos = getPointAlongRoute(coords, v.routeLength, v.progress);
      var prevPos = getPointAlongRoute(coords, v.routeLength, Math.max(0, v.progress - 0.01));
      var nextPos = getPointAlongRoute(coords, v.routeLength, Math.min(1, v.progress + 0.01));
      var bearing = calculateBearing(prevPos, nextPos);
      if (v.direction === -1) bearing = (bearing + 180) % 360;

      self.vehiclePositions[v.id] = pos;

      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pos },
        properties: {
          id: v.id,
          plate: v.plate,
          bearing: bearing,
          iconIndex: v.iconIndex || 0,
          vehicleType: v.type || 'car'
        }
      };
    });

    var source = this.map.getSource('vehicles');
    if (source) {
      source.setData({ type: 'FeatureCollection', features: features });
    }

    this.updateAllPopupPositions();

    this.animationId = requestAnimationFrame(function(time) { self.animate(time); });
  },

  start: function() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastFrameTime = 0;
    this.animate();
  },

  stop: function() {
    this.isRunning = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }
};
