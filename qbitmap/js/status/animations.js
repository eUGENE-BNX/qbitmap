/**
 * StatusAnimations - Data flow animations for status graph
 * Creates animated particles flowing along connection lines
 * Cyberpunk tech-noir style with glowing data packets
 */

const StatusAnimations = {
  // Animation state
  activeAnimations: [],
  animationFrame: null,
  isRunning: false,

  // Configuration
  packetSpeed: 1200, // ms for packet to travel
  maxPackets: 60,

  // Single color - no variants
  packetColors: [''],

  // Connection traffic profiles - realistic traffic patterns
  connectionProfiles: {
    'qbitmap-web->backend-api': {
      intensity: 'high',
      interval: 350,
      randomDelay: 100,
      bidirectional: true,
      burstChance: 0.25,
      speed: 800
    },
    'backend-api->face-recognition': {
      intensity: 'sparse',
      interval: 8000,
      randomDelay: 6000,
      bidirectional: false,
      speed: 1500
    },
    'backend-api->ai-service': {
      intensity: 'sparse',
      interval: 12000,
      randomDelay: 8000,
      bidirectional: false,
      speed: 1500
    },
    'backend-api->voice-call': {
      intensity: 'rare',
      interval: 20000,
      randomDelay: 15000,
      bidirectional: false,
      speed: 1800
    },
    'backend-api->onvif-service': {
      intensity: 'sparse',
      interval: 10000,
      randomDelay: 7000,
      bidirectional: false,
      speed: 1500
    },
    'backend-api->capture-service': {
      intensity: 'medium',
      interval: 2500,
      randomDelay: 1500,
      bidirectional: true,
      speed: 1200
    },
    'backend-api->rtc-gateway-whep': {
      intensity: 'medium',
      interval: 2000,
      randomDelay: 1000,
      bidirectional: true,
      speed: 1000
    },
    'backend-api->mediamtx-api': {
      intensity: 'medium',
      interval: 2000,
      randomDelay: 1000,
      bidirectional: true,
      speed: 1000
    },
    'default': {
      intensity: 'medium',
      interval: 2000,
      randomDelay: 1000,
      bidirectional: true,
      speed: 1200
    }
  },

  /**
   * Get connection profile by connection index
   */
  getConnectionProfile(connectionIndex) {
    const svg = document.getElementById('connections-svg');
    const path = svg?.querySelector(`#connection-${connectionIndex}`);
    if (!path) return this.connectionProfiles.default;

    const from = path.dataset.from;
    const to = path.dataset.to;
    const key = `${from}->${to}`;

    return this.connectionProfiles[key] || this.connectionProfiles.default;
  },

  /**
   * Start packet animations for online connections
   */
  startPacketAnimations(services, connections) {
    this.stopAllAnimations();

    const serviceMap = new Map(services.map(s => [s.id, s]));
    const container = document.getElementById('packets-container');

    if (!container) return;

    // Clear existing packets
    container.innerHTML = '';

    // Find online connections and start animations
    connections.forEach((conn, index) => {
      const fromService = serviceMap.get(conn.from);
      const toService = serviceMap.get(conn.to);

      // Only animate if both endpoints are online
      if (fromService?.status === 'online' && toService?.status === 'online') {
        const profile = this.getConnectionProfile(index);

        // Forward direction
        this.schedulePacket(index, container, true);

        // Reverse direction only for bidirectional connections
        if (profile.bidirectional) {
          this.schedulePacket(index, container, false);
        }
      }
    });

    this.isRunning = true;
  },

  /**
   * Schedule a packet animation for a connection with profile-based timing
   */
  schedulePacket(connectionIndex, container, forward = true) {
    const profile = this.getConnectionProfile(connectionIndex);
    const baseInterval = profile.interval;
    const randomDelay = profile.randomDelay || 0;

    // Random initial delay (stagger start times)
    const initialDelay = Math.random() * baseInterval;

    const animate = () => {
      if (!this.isRunning) return;

      // For sparse/rare connections, randomly skip some cycles
      const shouldSend = profile.intensity === 'sparse' || profile.intensity === 'rare'
        ? Math.random() < 0.4  // 40% chance to send
        : true;

      if (shouldSend) {
        this.createPacket(connectionIndex, container, forward, profile);

        // High intensity burst - send extra packets
        if (profile.intensity === 'high' && profile.burstChance && Math.random() < profile.burstChance) {
          const burstCount = 2 + Math.floor(Math.random() * 3); // 2-4 extra packets
          for (let i = 0; i < burstCount; i++) {
            setTimeout(() => {
              if (this.isRunning) {
                this.createPacket(connectionIndex, container, forward, profile);
              }
            }, (i + 1) * 60);
          }
        }

        // High intensity bidirectional - send response packets
        if (profile.intensity === 'high' && profile.bidirectional && forward) {
          setTimeout(() => {
            if (this.isRunning) {
              this.createPacket(connectionIndex, container, !forward, profile);
            }
          }, 80 + Math.random() * 120);
        }
      }

      // Schedule next packet
      const nextInterval = baseInterval + Math.random() * randomDelay;
      const timerId = setTimeout(animate, nextInterval);
      this.activeAnimations.push({ type: 'timeout', id: timerId });
    };

    const timerId = setTimeout(animate, initialDelay);
    this.activeAnimations.push({ type: 'timeout', id: timerId });
  },

  /**
   * Create and animate a single packet
   */
  createPacket(connectionIndex, container, forward = true, profile = null) {
    // Get connection endpoints
    const endpoints = StatusGraph.getConnectionEndpoints(connectionIndex);
    if (!endpoints) return;

    // Check if we have too many packets
    if (container.children.length >= this.maxPackets) return;

    // Get profile if not provided
    if (!profile) {
      profile = this.getConnectionProfile(connectionIndex);
    }

    // Create packet element with random color variant and intensity class
    const packet = document.createElement('div');
    const colorClass = this.packetColors[Math.floor(Math.random() * this.packetColors.length)];
    const intensityClass = profile.intensity || 'medium';
    packet.className = `data-packet ${intensityClass}` + (colorClass ? ` ${colorClass}` : '');

    // Determine start and end points based on direction
    const start = forward ? endpoints.from : endpoints.to;
    const end = forward ? endpoints.to : endpoints.from;

    // Set initial position
    packet.style.left = `${start.x}px`;
    packet.style.top = `${start.y}px`;

    container.appendChild(packet);

    // Calculate angle for trail rotation
    const angle = Math.atan2(end.y - start.y, end.x - start.x) * (180 / Math.PI);
    packet.style.setProperty('--trail-angle', `${angle}deg`);

    // Calculate bezier control point for curved path
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const curveOffset = Math.min(Math.sqrt(dx * dx + dy * dy) * 0.15, 30);

    // Offset perpendicular to the line
    const controlX = midX + (forward ? curveOffset : -curveOffset) * (Math.abs(dy) > Math.abs(dx) ? 1 : 0);
    const controlY = midY + (forward ? curveOffset : -curveOffset) * (Math.abs(dx) > Math.abs(dy) ? 1 : 0);

    // Animate using Web Animations API with curved path
    const keyframes = [
      {
        left: `${start.x}px`,
        top: `${start.y}px`,
        opacity: 0,
        transform: 'translate(-50%, -50%) scale(0.3)',
        filter: 'blur(2px)'
      },
      {
        left: `${start.x}px`,
        top: `${start.y}px`,
        opacity: 1,
        transform: 'translate(-50%, -50%) scale(1)',
        filter: 'blur(0px)',
        offset: 0.1
      },
      {
        left: `${controlX}px`,
        top: `${controlY}px`,
        opacity: 1,
        transform: 'translate(-50%, -50%) scale(1.2)',
        filter: 'blur(0px)',
        offset: 0.5
      },
      {
        left: `${end.x}px`,
        top: `${end.y}px`,
        opacity: 1,
        transform: 'translate(-50%, -50%) scale(1)',
        filter: 'blur(0px)',
        offset: 0.9
      },
      {
        left: `${end.x}px`,
        top: `${end.y}px`,
        opacity: 0,
        transform: 'translate(-50%, -50%) scale(0.3)',
        filter: 'blur(2px)'
      }
    ];

    // Use profile speed with slight variation for natural look
    const baseSpeed = profile.speed || this.packetSpeed;
    const duration = baseSpeed + (Math.random() - 0.5) * (baseSpeed * 0.2);

    const animation = packet.animate(keyframes, {
      duration: duration,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      fill: 'forwards'
    });

    animation.onfinish = () => {
      packet.remove();
    };

    this.activeAnimations.push({ type: 'animation', ref: animation });
  },

  /**
   * Create burst of packets (for status change events)
   */
  createBurst(connectionIndex, count = 5) {
    const container = document.getElementById('packets-container');
    if (!container) return;

    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        this.createPacket(connectionIndex, container, true);
        this.createPacket(connectionIndex, container, false);
      }, i * 80);
    }
  },

  /**
   * Pulse effect on a node
   */
  pulseNode(serviceId) {
    const node = document.querySelector(`[data-service-id="${serviceId}"]`);
    if (!node) return;

    node.animate([
      { transform: 'translate(-50%, -50%) scale(1)', boxShadow: '0 0 20px rgba(0, 255, 136, 0.3)' },
      { transform: 'translate(-50%, -50%) scale(1.08)', boxShadow: '0 0 40px rgba(0, 255, 136, 0.6)' },
      { transform: 'translate(-50%, -50%) scale(1)', boxShadow: '0 0 20px rgba(0, 255, 136, 0.3)' }
    ], {
      duration: 400,
      easing: 'ease-out'
    });
  },

  /**
   * Ripple effect from a node
   */
  createRipple(serviceId) {
    const node = document.querySelector(`[data-service-id="${serviceId}"]`);
    if (!node) return;

    // Create multiple ripples for more dramatic effect
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        const ripple = document.createElement('div');
        ripple.style.cssText = `
          position: absolute;
          width: 100%;
          height: 100%;
          border-radius: 4px;
          border: 2px solid var(--accent-green);
          pointer-events: none;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          box-shadow: 0 0 10px var(--accent-green);
        `;

        node.appendChild(ripple);

        ripple.animate([
          { transform: 'translate(-50%, -50%) scale(1)', opacity: 0.8 },
          { transform: 'translate(-50%, -50%) scale(1.8)', opacity: 0 }
        ], {
          duration: 800,
          easing: 'ease-out'
        }).onfinish = () => ripple.remove();
      }, i * 150);
    }
  },

  /**
   * Connection highlight effect
   */
  highlightConnection(connectionIndex) {
    const svg = document.getElementById('connections-svg');
    const path = svg?.querySelector(`#connection-${connectionIndex}`);
    if (!path) return;

    path.animate([
      { strokeWidth: '2', filter: 'drop-shadow(0 0 4px var(--glow-green))' },
      { strokeWidth: '5', filter: 'drop-shadow(0 0 15px var(--glow-green))' },
      { strokeWidth: '2', filter: 'drop-shadow(0 0 4px var(--glow-green))' }
    ], {
      duration: 600,
      easing: 'ease-out'
    });
  },

  /**
   * Stop all animations
   */
  stopAllAnimations() {
    this.isRunning = false;

    this.activeAnimations.forEach(anim => {
      if (anim.type === 'timeout') {
        clearTimeout(anim.id);
      } else if (anim.type === 'animation' && anim.ref) {
        anim.ref.cancel();
      }
    });

    this.activeAnimations = [];

    // Clear packets container
    const container = document.getElementById('packets-container');
    if (container) {
      container.innerHTML = '';
    }
  },

  /**
   * Pause animations
   */
  pause() {
    this.isRunning = false;
  },

  /**
   * Resume animations
   */
  resume(services, connections) {
    if (!this.isRunning) {
      this.startPacketAnimations(services, connections);
    }
  },

  /**
   * Status change animation
   * Called when a service changes status
   */
  onStatusChange(serviceId, oldStatus, newStatus) {
    // Pulse the node
    this.pulseNode(serviceId);

    // Create ripple effect
    if (newStatus === 'online') {
      this.createRipple(serviceId);
    }

    // Flash connected paths and create burst
    const svg = document.getElementById('connections-svg');
    if (svg) {
      svg.querySelectorAll('.connection-line').forEach((path, index) => {
        if (path.dataset.from === serviceId || path.dataset.to === serviceId) {
          this.highlightConnection(index);
          if (newStatus === 'online') {
            this.createBurst(index, 3);
          }
        }
      });
    }
  }
};

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StatusAnimations;
}
