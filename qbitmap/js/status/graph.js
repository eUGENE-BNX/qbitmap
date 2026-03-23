/**
 * StatusGraph - SVG-based network graph rendering
 * Renders service nodes and connection lines
 */

const StatusGraph = {
  // Node positions (relative to container, in percentages)
  nodePositions: {
    'qbitmap-web': { x: 50, y: 14 },
    'backend-api': { x: 50, y: 42 },
    'face-recognition': { x: 10, y: 42 },
    'ai-service': { x: 90, y: 42 },
    'onvif-service': { x: 10, y: 78 },
    'capture-service': { x: 30, y: 78 },
    'rtc-gateway-whep': { x: 50, y: 78 },
    'mediamtx-api': { x: 70, y: 78 },
    'voice-call': { x: 90, y: 78 }
  },

  // Cached elements
  svg: null,
  nodesContainer: null,
  packetsContainer: null,

  /**
   * Render the network graph
   */
  render(services, connections, elements) {
    this.svg = elements.connectionsSvg;
    this.nodesContainer = elements.nodesContainer;
    this.packetsContainer = elements.packetsContainer;

    if (!this.svg || !this.nodesContainer) {
      console.warn('[StatusGraph] Required elements not found');
      return;
    }

    // Clear existing content
    this.svg.innerHTML = '';
    this.nodesContainer.innerHTML = '';

    // Get container dimensions
    const container = elements.graphContainer;
    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    // Setup SVG viewBox
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    // Create service lookup map
    const serviceMap = new Map(services.map(s => [s.id, s]));

    // Draw connections first (behind nodes)
    this.renderConnections(connections, serviceMap, width, height);

    // Draw nodes
    this.renderNodes(services, width, height);
  },

  /**
   * Render connection lines between services
   */
  renderConnections(connections, serviceMap, width, height) {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

    // Create glow filter
    defs.innerHTML = `
      <filter id="glow-green" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
        <feMerge>
          <feMergeNode in="coloredBlur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
      <filter id="glow-red" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
        <feMerge>
          <feMergeNode in="coloredBlur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    `;
    this.svg.appendChild(defs);

    connections.forEach((conn, index) => {
      const fromPos = this.nodePositions[conn.from];
      const toPos = this.nodePositions[conn.to];

      if (!fromPos || !toPos) return;

      const fromService = serviceMap.get(conn.from);
      const toService = serviceMap.get(conn.to);

      // Calculate absolute positions
      const x1 = (fromPos.x / 100) * width;
      const y1 = (fromPos.y / 100) * height;
      const x2 = (toPos.x / 100) * width;
      const y2 = (toPos.y / 100) * height;

      // Determine connection status
      let status = 'offline';
      if (fromService?.status === 'online' && toService?.status === 'online') {
        status = 'online';
      } else if (fromService?.status === 'online' || toService?.status === 'online') {
        status = 'partial';
      }

      // Create curved path
      const path = this.createCurvedPath(x1, y1, x2, y2);

      // Create path element
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', path);
      pathEl.setAttribute('class', `connection-line ${status}`);
      pathEl.setAttribute('data-from', conn.from);
      pathEl.setAttribute('data-to', conn.to);
      pathEl.id = `connection-${index}`;

      if (status === 'online') {
        pathEl.setAttribute('filter', 'url(#glow-green)');
      }

      this.svg.appendChild(pathEl);
    });
  },

  /**
   * Create curved path between two points
   */
  createCurvedPath(x1, y1, x2, y2) {
    // Calculate control point for quadratic curve
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;

    // Offset control point perpendicular to line
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);

    // Small curve for mostly vertical/horizontal lines
    const curveAmount = Math.min(len * 0.1, 30);

    // For vertical connections, curve slightly
    if (Math.abs(dx) < Math.abs(dy) * 0.3) {
      return `M ${x1} ${y1} Q ${midX + curveAmount} ${midY} ${x2} ${y2}`;
    }

    // For horizontal connections
    if (Math.abs(dy) < Math.abs(dx) * 0.3) {
      return `M ${x1} ${y1} Q ${midX} ${midY - curveAmount} ${x2} ${y2}`;
    }

    // For diagonal connections
    return `M ${x1} ${y1} Q ${midX} ${midY} ${x2} ${y2}`;
  },

  /**
   * Render service nodes
   */
  renderNodes(services, width, height) {
    services.forEach(service => {
      const pos = this.nodePositions[service.id];
      if (!pos) return;

      // Calculate absolute position
      const x = (pos.x / 100) * width;
      const y = (pos.y / 100) * height;

      // Create node element
      const node = document.createElement('div');
      node.className = `service-node ${service.status}`;
      node.dataset.serviceId = service.id;
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;

      // Add status indicator dot for online nodes
      const statusDot = service.status === 'online'
        ? '<div class="status-dot"></div>'
        : '';

      node.innerHTML = `
        ${statusDot}
        <div class="node-icon">
          ${this.getNodeIcon(service.icon)}
        </div>
        <div class="node-name">${service.name}</div>
        <div class="node-response">
          ${service.responseTime ? `${service.responseTime}ms` : '--'}
        </div>
      `;

      // Add click handler
      node.addEventListener('click', () => {
        if (typeof StatusSystem !== 'undefined') {
          StatusSystem.openModal(service);
        }
      });

      this.nodesContainer.appendChild(node);
    });
  },

  /**
   * Get SVG icon for node
   */
  getNodeIcon(iconName) {
    const icons = {
      globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
      server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/></svg>',
      camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
      video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
      broadcast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>',
      api: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
      brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>',
      face: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
      phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>'
    };

    return icons[iconName] || icons.server;
  },

  /**
   * Update connection status without full re-render
   */
  updateConnectionStatus(connectionId, status) {
    const path = this.svg?.querySelector(`#connection-${connectionId}`);
    if (path) {
      path.classList.remove('online', 'offline', 'partial');
      path.classList.add(status);

      if (status === 'online') {
        path.setAttribute('filter', 'url(#glow-green)');
      } else {
        path.removeAttribute('filter');
      }
    }
  },

  /**
   * Update node status without full re-render
   */
  updateNodeStatus(serviceId, status) {
    const node = this.nodesContainer?.querySelector(`[data-service-id="${serviceId}"]`);
    if (node) {
      node.classList.remove('online', 'offline', 'degraded');
      node.classList.add(status);
    }
  },

  /**
   * Get path data for a connection (used by animations)
   */
  getConnectionPath(connectionIndex) {
    const path = this.svg?.querySelector(`#connection-${connectionIndex}`);
    return path?.getAttribute('d') || null;
  },

  /**
   * Get connection endpoints (used by animations)
   */
  getConnectionEndpoints(connectionIndex) {
    const path = this.svg?.querySelector(`#connection-${connectionIndex}`);
    if (!path) return null;

    const from = path.dataset.from;
    const to = path.dataset.to;
    const fromPos = this.nodePositions[from];
    const toPos = this.nodePositions[to];

    if (!fromPos || !toPos) return null;

    const container = this.svg.parentElement;
    const rect = container.getBoundingClientRect();

    return {
      from: {
        x: (fromPos.x / 100) * rect.width,
        y: (fromPos.y / 100) * rect.height
      },
      to: {
        x: (toPos.x / 100) * rect.width,
        y: (toPos.y / 100) * rect.height
      }
    };
  }
};

export { StatusGraph };
