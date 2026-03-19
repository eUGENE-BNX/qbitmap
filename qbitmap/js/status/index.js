/**
 * StatusSystem - Main status page controller
 * Handles API communication, state management, and DOM rendering
 */

const StatusSystem = {
  // Configuration
  apiBase: typeof QBitmapConfig !== 'undefined' ? QBitmapConfig.api.status : 'https://stream.qbitmap.com/api/status',
  refreshInterval: 30000, // 30 seconds

  // State
  services: [],
  connections: [],
  lastUpdate: null,
  isLoading: false,
  refreshTimer: null,
  countdownTimer: null,
  countdown: 30,

  // DOM Elements
  elements: {},

  /**
   * Initialize the status system
   */
  async init() {
    console.log('[StatusSystem] Initializing...');

    // Cache DOM elements
    this.cacheElements();

    // Setup event listeners
    this.setupEventListeners();

    // Initial fetch
    await this.fetchStatus();

    // Start auto-refresh
    this.startAutoRefresh();

    // Setup visibility change handler
    this.setupVisibilityHandler();

    console.log('[StatusSystem] Initialized successfully');
  },

  /**
   * Cache DOM element references
   */
  cacheElements() {
    this.elements = {
      overallStatus: document.getElementById('overall-status'),
      graphContainer: document.getElementById('graph-container'),
      nodesContainer: document.getElementById('nodes-container'),
      connectionsSvg: document.getElementById('connections-svg'),
      packetsContainer: document.getElementById('packets-container'),
      servicesList: document.getElementById('services-list'),
      onlineCount: document.getElementById('online-count'),
      offlineCount: document.getElementById('offline-count'),
      avgResponse: document.getElementById('avg-response'),
      lastUpdate: document.getElementById('last-update'),
      refreshCountdown: document.getElementById('refresh-countdown'),
      refreshBtn: document.getElementById('refresh-btn'),
      modal: document.getElementById('service-modal'),
      modalClose: document.getElementById('modal-close')
    };
  },

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Refresh button
    this.elements.refreshBtn?.addEventListener('click', () => {
      this.fetchStatus(true);
    });

    // Modal close
    this.elements.modalClose?.addEventListener('click', () => {
      this.closeModal();
    });

    // Close modal on overlay click
    this.elements.modal?.addEventListener('click', (e) => {
      if (e.target === this.elements.modal) {
        this.closeModal();
      }
    });

    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeModal();
      }
    });
  },

  /**
   * Setup visibility change handler (pause refresh when tab is hidden)
   */
  setupVisibilityHandler() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stopAutoRefresh();
      } else {
        this.fetchStatus();
        this.startAutoRefresh();
      }
    });
  },

  /**
   * Fetch status from API
   */
  async fetchStatus(forceRefresh = false) {
    if (this.isLoading) return;

    this.isLoading = true;
    this.elements.refreshBtn?.classList.add('loading');

    try {
      const url = forceRefresh
        ? `${this.apiBase}/health?refresh=true`
        : `${this.apiBase}/health`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // Update state
      this.services = data.services || [];
      this.connections = data.connections || [];
      this.lastUpdate = new Date(data.timestamp);

      // Render UI
      this.render(data);

      // Reset countdown
      this.countdown = 30;

    } catch (error) {
      console.error('[StatusSystem] Fetch error:', error);
      this.renderError(error);
    } finally {
      this.isLoading = false;
      this.elements.refreshBtn?.classList.remove('loading');
    }
  },

  /**
   * Render all UI components
   */
  render(data) {
    this.renderOverallStatus(data.overall);
    this.renderSummary(data.summary);
    this.renderGraph();
    this.renderServicesList();
    this.renderLastUpdate();

    // Trigger animations
    if (typeof StatusAnimations !== 'undefined') {
      StatusAnimations.startPacketAnimations(this.services, this.connections);
    }
  },

  /**
   * Render overall status badge
   */
  renderOverallStatus(overall) {
    const el = this.elements.overallStatus;
    if (!el) return;

    // Remove all status classes
    el.classList.remove('operational', 'degraded', 'partial_outage', 'major_outage');

    // Add current status class
    el.classList.add(overall);

    // Update text
    const statusText = el.querySelector('.status-text');
    if (statusText) {
      const labels = {
        operational: 'All Systems Operational',
        degraded: 'Degraded Performance',
        partial_outage: 'Partial Outage',
        major_outage: 'Major Outage'
      };
      statusText.textContent = labels[overall] || overall;
    }
  },

  /**
   * Render summary statistics
   */
  renderSummary(summary) {
    if (!summary) return;

    if (this.elements.onlineCount) {
      this.elements.onlineCount.textContent = summary.online || 0;
    }

    if (this.elements.offlineCount) {
      this.elements.offlineCount.textContent = summary.offline || 0;
    }

    if (this.elements.avgResponse) {
      this.elements.avgResponse.textContent = summary.avgResponseTime
        ? `${summary.avgResponseTime}ms`
        : '--';
    }
  },

  /**
   * Render network graph
   */
  renderGraph() {
    if (typeof StatusGraph !== 'undefined') {
      StatusGraph.render(this.services, this.connections, this.elements);
    }
  },

  /**
   * Render services list
   */
  renderServicesList() {
    const container = this.elements.servicesList;
    if (!container) return;

    container.innerHTML = this.services.map(service => `
      <div class="service-card ${service.status}" data-service-id="${service.id}">
        <div class="service-card-icon">
          ${this.getServiceIcon(service.icon)}
        </div>
        <div class="service-card-info">
          <div class="service-card-name">${service.name}</div>
          <div class="service-card-host">${service.host}</div>
        </div>
        <div class="service-card-status">
          <span class="service-card-badge">${service.status}</span>
          <div class="service-card-response">
            ${service.responseTime ? `${service.responseTime}ms` : '--'}
          </div>
        </div>
      </div>
    `).join('');

    // Add click handlers
    container.querySelectorAll('.service-card').forEach(card => {
      card.addEventListener('click', () => {
        const serviceId = card.dataset.serviceId;
        const service = this.services.find(s => s.id === serviceId);
        if (service) {
          this.openModal(service);
        }
      });
    });
  },

  /**
   * Render last update timestamp
   */
  renderLastUpdate() {
    if (!this.elements.lastUpdate || !this.lastUpdate) return;

    const formatTime = (date) => {
      return date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    };

    this.elements.lastUpdate.textContent = formatTime(this.lastUpdate);
  },

  /**
   * Render error state
   */
  renderError(error) {
    const el = this.elements.overallStatus;
    if (el) {
      el.classList.remove('operational', 'degraded', 'partial_outage');
      el.classList.add('major_outage');
      const statusText = el.querySelector('.status-text');
      if (statusText) {
        statusText.textContent = 'Connection Error';
      }
    }
  },

  /**
   * Get SVG icon for service
   */
  getServiceIcon(iconName) {
    const icons = {
      globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
      server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
      camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
      video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
      broadcast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>',
      api: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
      brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 0 0-4 4v2H6a4 4 0 0 0 0 8h2v2a4 4 0 0 0 8 0v-2h2a4 4 0 0 0 0-8h-2V6a4 4 0 0 0-4-4z"/><circle cx="12" cy="12" r="2"/></svg>',
      face: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
      phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>'
    };

    return icons[iconName] || icons.server;
  },

  /**
   * Open service detail modal
   */
  openModal(service) {
    const modal = this.elements.modal;
    if (!modal) return;

    // Update modal content
    document.getElementById('modal-name').textContent = service.name;
    document.getElementById('modal-description').textContent = service.description;
    document.getElementById('modal-icon').innerHTML = this.getServiceIcon(service.icon);

    const statusEl = document.getElementById('modal-status');
    statusEl.textContent = service.status.toUpperCase();
    statusEl.className = `detail-value ${service.status}`;

    document.getElementById('modal-host').textContent = service.host;
    document.getElementById('modal-response-time').textContent =
      service.responseTime ? `${service.responseTime}ms` : 'N/A';
    document.getElementById('modal-last-check').textContent =
      new Date(service.lastCheck).toLocaleString();

    // Show/hide error
    const errorRow = document.getElementById('modal-error-row');
    const errorEl = document.getElementById('modal-error');
    if (service.error) {
      errorRow.style.display = 'flex';
      errorEl.textContent = service.error;
    } else {
      errorRow.style.display = 'none';
    }

    // Show modal
    modal.classList.add('active');
  },

  /**
   * Close service detail modal
   */
  closeModal() {
    this.elements.modal?.classList.remove('active');
  },

  /**
   * Start auto-refresh timer
   */
  startAutoRefresh() {
    this.stopAutoRefresh();

    // Main refresh timer
    this.refreshTimer = setInterval(() => {
      this.fetchStatus();
    }, this.refreshInterval);

    // Countdown timer
    this.countdownTimer = setInterval(() => {
      this.countdown = Math.max(0, this.countdown - 1);
      if (this.elements.refreshCountdown) {
        this.elements.refreshCountdown.textContent = this.countdown;
      }
    }, 1000);
  },

  /**
   * Stop auto-refresh timer
   */
  stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  },

  /**
   * Cleanup
   */
  destroy() {
    this.stopAutoRefresh();
    if (typeof StatusAnimations !== 'undefined') {
      StatusAnimations.stopAllAnimations();
    }
  }
};

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StatusSystem;
}
