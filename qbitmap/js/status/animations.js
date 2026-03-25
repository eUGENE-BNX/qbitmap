import { StatusGraph } from './graph.js';

/**
 * StatusAnimations - Connection flow animations for status graph
 * Animated dashed-line flow along SVG connections (replaces particle dots)
 */

const StatusAnimations = {
  isRunning: false,

  // Connection speed profiles (stroke-dashoffset animation speed)
  connectionSpeeds: {
    'qbitmap-web->backend-api': 20,
    'backend-api->face-recognition': 40,
    'backend-api->ai-service': 40,
    'backend-api->voice-call': 50,
    'backend-api->onvif-service': 35,
    'backend-api->capture-service': 25,
    'backend-api->rtc-gateway-whep': 22,
    'backend-api->mediamtx-api': 22,
    'default': 30
  },

  /**
   * Start flow animations on online connections
   */
  startPacketAnimations(services, connections) {
    this.stopAllAnimations();

    const serviceMap = new Map(services.map(s => [s.id, s]));
    const svg = document.getElementById('connections-svg');
    if (!svg) return;

    connections.forEach((conn, index) => {
      const fromService = serviceMap.get(conn.from);
      const toService = serviceMap.get(conn.to);
      const path = svg.querySelector(`#connection-${index}`);
      if (!path) return;

      if (fromService?.status === 'online' && toService?.status === 'online') {
        const key = `${conn.from}->${conn.to}`;
        const speed = this.connectionSpeeds[key] || this.connectionSpeeds.default;

        path.classList.add('flow-active');
        path.style.setProperty('--flow-speed', `${speed}s`);
      } else {
        path.classList.remove('flow-active');
      }
    });

    this.isRunning = true;
  },

  /**
   * Pulse effect on a node
   */
  pulseNode(serviceId) {
    const node = document.querySelector(`[data-service-id="${serviceId}"]`);
    if (!node) return;

    node.animate([
      { transform: 'translate(-50%, -50%) scale(1)', boxShadow: '0 0 20px rgba(34, 197, 94, 0.3)' },
      { transform: 'translate(-50%, -50%) scale(1.08)', boxShadow: '0 0 40px rgba(34, 197, 94, 0.6)' },
      { transform: 'translate(-50%, -50%) scale(1)', boxShadow: '0 0 20px rgba(34, 197, 94, 0.3)' }
    ], {
      duration: 400,
      easing: 'ease-out'
    });
  },

  /**
   * Status change animation
   */
  onStatusChange(serviceId, oldStatus, newStatus) {
    this.pulseNode(serviceId);
  },

  /**
   * Stop all animations
   */
  stopAllAnimations() {
    this.isRunning = false;

    const svg = document.getElementById('connections-svg');
    if (svg) {
      svg.querySelectorAll('.flow-active').forEach(path => {
        path.classList.remove('flow-active');
      });
    }
  },

  pause() {
    this.stopAllAnimations();
  },

  resume(services, connections) {
    if (!this.isRunning) {
      this.startPacketAnimations(services, connections);
    }
  }
};

export { StatusAnimations };
