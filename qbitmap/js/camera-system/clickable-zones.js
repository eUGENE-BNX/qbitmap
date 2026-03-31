import '../../css/clickable-zones.css';
import { QBitmapConfig } from '../config.js';
import { Logger, escapeHtml, showNotification } from '../utils.js';
import { AuthSystem } from '../auth.js';

/**
 * QBitmap Camera System - Clickable Zones Module
 * Draw polygon zones on camera video to control relay devices
 */

const ClickableZonesMixin = {
  // Zone state
  zones: new Map(), // deviceId -> Zone[]
  zonesVisible: new Map(), // deviceId -> boolean (visibility state)
  drawingState: null, // { deviceId, points: [], isDrawing: false }

  /**
   * Initialize zones for a camera (called when popup opens)
   */
  async loadZonesForCamera(deviceId) {
    try {
      const response = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/zones/camera/${deviceId}`, {
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();
        this.zones.set(deviceId, data.zones || []);
        Logger.log(`[Zones] Loaded ${data.zones?.length || 0} zones for ${deviceId}`);
      }
    } catch (error) {
      Logger.error('[Zones] Load error:', error);
    }
  },

  /**
   * Enter drawing mode for a camera
   */
  enterDrawMode(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    // Initialize drawing state
    this.drawingState = {
      deviceId,
      points: [],
      isDrawing: true
    };

    // Add drawing overlay
    this.createDrawingOverlay(deviceId);

    // Update UI
    const drawBtn = popupEl.querySelector('.draw-zone-btn');
    if (drawBtn) {
      drawBtn.classList.add('active');
      drawBtn.title = 'Çizim modundan çık';
    }

    // Show drawing toolbar
    this.showDrawingToolbar(deviceId);

    Logger.log('[Zones] Entered draw mode for', deviceId);
  },

  /**
   * Exit drawing mode
   */
  exitDrawMode(cancelled = false) {
    if (!this.drawingState) return;

    const { deviceId } = this.drawingState;
    const popupData = this.popups.get(deviceId);

    // Remove drawing overlay
    const popupEl = popupData?.popup.getElement();
    if (popupEl) {
      const overlay = popupEl.querySelector('.zone-drawing-overlay');
      if (overlay) overlay.remove();

      const toolbar = popupEl.querySelector('.zone-drawing-toolbar');
      if (toolbar) toolbar.remove();

      const drawBtn = popupEl.querySelector('.draw-zone-btn');
      if (drawBtn) {
        drawBtn.classList.remove('active');
        drawBtn.title = 'Alan çiz';
      }
    }

    if (!cancelled && this.drawingState.points.length >= 3) {
      // Show save modal
      this.showZoneSaveModal(deviceId, [...this.drawingState.points]);
    }

    this.drawingState = null;
    Logger.log('[Zones] Exited draw mode');
  },

  /**
   * Create SVG overlay for drawing
   */
  createDrawingOverlay(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const container = popupEl.querySelector('.camera-frame-container');
    if (!container) return;

    // Create SVG overlay
    const overlay = document.createElement('div');
    overlay.className = 'zone-drawing-overlay';
    overlay.innerHTML = `
      <svg class="zone-drawing-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline class="zone-drawing-line" points="" fill="none" stroke="#00ff00" stroke-width="0.2" />
        <g class="zone-drawing-points"></g>
      </svg>
    `;

    container.appendChild(overlay);

    // Add event listeners
    overlay.addEventListener('click', (e) => this.handleDrawClick(e, deviceId));
    overlay.addEventListener('mousemove', (e) => this.handleDrawMove(e, deviceId));
  },

  /**
   * Show drawing toolbar
   */
  showDrawingToolbar(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const container = popupEl.querySelector('.camera-frame-container');
    if (!container) return;

    const toolbar = document.createElement('div');
    toolbar.className = 'zone-drawing-toolbar';
    toolbar.innerHTML = `
      <button class="zone-toolbar-btn zone-undo-btn" title="Son noktayı sil">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 10h10a5 5 0 0 1 5 5v2a5 5 0 0 1-5 5H7"/>
          <path d="M8 5L3 10l5 5"/>
        </svg>
      </button>
      <button class="zone-toolbar-btn zone-save-btn" title="Kaydet" disabled>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </button>
      <button class="zone-toolbar-btn zone-cancel-btn" title="İptal">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <span class="zone-point-count">0 nokta</span>
    `;

    container.appendChild(toolbar);

    // Event listeners
    toolbar.querySelector('.zone-undo-btn').addEventListener('click', () => this.undoLastPoint());
    toolbar.querySelector('.zone-save-btn').addEventListener('click', () => this.exitDrawMode(false));
    toolbar.querySelector('.zone-cancel-btn').addEventListener('click', () => this.exitDrawMode(true));
  },

  /**
   * Handle click during drawing
   */
  handleDrawClick(e, deviceId) {
    if (!this.drawingState || this.drawingState.deviceId !== deviceId) return;

    const overlay = e.currentTarget;
    const rect = overlay.getBoundingClientRect();

    // Calculate normalized coordinates (0-1)
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    // Add point
    this.drawingState.points.push([x, y]);

    // Update SVG
    this.updateDrawingSVG(deviceId);

    // Update toolbar
    this.updateDrawingToolbar();
  },

  /**
   * Handle mouse move during drawing (preview line)
   */
  handleDrawMove(e, deviceId) {
    if (!this.drawingState || this.drawingState.deviceId !== deviceId) return;
    if (this.drawingState.points.length === 0) return;

    const overlay = e.currentTarget;
    const rect = overlay.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    // Update preview line
    const svg = overlay.querySelector('.zone-drawing-svg');
    let preview = svg.querySelector('.zone-preview-line');

    if (!preview) {
      preview = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      preview.setAttribute('class', 'zone-preview-line');
      preview.setAttribute('stroke', '#00ff00');
      preview.setAttribute('stroke-width', '0.15');
      preview.setAttribute('stroke-dasharray', '0.5,0.5');
      svg.appendChild(preview);
    }

    const lastPoint = this.drawingState.points[this.drawingState.points.length - 1];
    preview.setAttribute('x1', lastPoint[0] * 100);
    preview.setAttribute('y1', lastPoint[1] * 100);
    preview.setAttribute('x2', x);
    preview.setAttribute('y2', y);
  },

  /**
   * Update drawing SVG with current points
   */
  updateDrawingSVG(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const svg = popupEl.querySelector('.zone-drawing-svg');
    if (!svg) return;

    const points = this.drawingState.points;

    // Update polyline
    const pointsStr = points.map(p => `${p[0] * 100},${p[1] * 100}`).join(' ');
    svg.querySelector('.zone-drawing-line').setAttribute('points', pointsStr);

    // Update point markers
    const pointsGroup = svg.querySelector('.zone-drawing-points');
    pointsGroup.innerHTML = '';

    points.forEach((p, i) => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', p[0] * 100);
      circle.setAttribute('cy', p[1] * 100);
      circle.setAttribute('r', '0.5');
      circle.setAttribute('fill', i === 0 ? '#ff0000' : '#00ff00');
      pointsGroup.appendChild(circle);
    });
  },

  /**
   * Update toolbar state
   */
  updateDrawingToolbar() {
    if (!this.drawingState) return;

    const popupData = this.popups.get(this.drawingState.deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const toolbar = popupEl.querySelector('.zone-drawing-toolbar');
    if (!toolbar) return;

    const pointCount = this.drawingState.points.length;
    toolbar.querySelector('.zone-point-count').textContent = `${pointCount} nokta`;
    toolbar.querySelector('.zone-save-btn').disabled = pointCount < 3;
    toolbar.querySelector('.zone-undo-btn').disabled = pointCount === 0;
  },

  /**
   * Undo last point
   */
  undoLastPoint() {
    if (!this.drawingState || this.drawingState.points.length === 0) return;

    this.drawingState.points.pop();
    this.updateDrawingSVG(this.drawingState.deviceId);
    this.updateDrawingToolbar();
  },

  /**
   * Show zone save modal
   */
  showZoneSaveModal(deviceId, points) {
    // Remove existing modal
    const existing = document.getElementById('zone-save-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'zone-save-modal';
    modal.className = 'zone-modal-overlay';
    modal.innerHTML = `
      <div class="zone-modal">
        <div class="zone-modal-header">
          <h3>Alan Kaydet</h3>
          <button class="zone-modal-close">&times;</button>
        </div>
        <div class="zone-modal-body">
          <div class="zone-form-group">
            <label>Alan Adı *</label>
            <input type="text" id="zone-name" placeholder="örn: TV, Lamba, Kapı" required>
          </div>
          <div class="zone-form-group">
            <label>Relay ON URL</label>
            <input type="url" id="zone-relay-on" placeholder="http://192.168.1.100/on">
          </div>
          <div class="zone-form-group">
            <label>Relay OFF URL</label>
            <input type="url" id="zone-relay-off" placeholder="http://192.168.1.100/off">
          </div>
          <div class="zone-form-group">
            <label>Relay Status URL (opsiyonel)</label>
            <input type="url" id="zone-relay-status" placeholder="http://192.168.1.100/status">
          </div>
        </div>
        <div class="zone-modal-footer">
          <button class="zone-modal-btn zone-modal-cancel">İptal</button>
          <button class="zone-modal-btn zone-modal-save">Kaydet</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Focus name input
    setTimeout(() => modal.querySelector('#zone-name').focus(), 100);

    // Event listeners
    modal.querySelector('.zone-modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('.zone-modal-cancel').addEventListener('click', () => modal.remove());
    modal.querySelector('.zone-modal-save').addEventListener('click', async () => {
      const name = modal.querySelector('#zone-name').value.trim();
      if (!name) {
        modal.querySelector('#zone-name').classList.add('error');
        return;
      }

      const zoneData = {
        cameraId: deviceId,
        name,
        points,
        relayOnUrl: modal.querySelector('#zone-relay-on').value.trim() || null,
        relayOffUrl: modal.querySelector('#zone-relay-off').value.trim() || null,
        relayStatusUrl: modal.querySelector('#zone-relay-status').value.trim() || null
      };

      const success = await this.saveZone(zoneData);
      if (success) {
        modal.remove();
        this.renderZones(deviceId);
      }
    });

    // Close on overlay click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    // Close on Escape
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        modal.remove();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  },

  /**
   * Save zone to backend
   */
  async saveZone(zoneData) {
    try {
      const response = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/zones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(zoneData)
      });

      if (response.ok) {
        const data = await response.json();
        // Add to local cache
        const zones = this.zones.get(zoneData.cameraId) || [];
        zones.push({
          ...data.zone,
          points: zoneData.points
        });
        this.zones.set(zoneData.cameraId, zones);

        Logger.log('[Zones] Zone saved:', data.zone.id);
        return true;
      } else {
        const error = await response.json();
        Logger.error('[Zones] Save failed:', error);
        alert('Alan kaydedilemedi: ' + (error.error || 'Bilinmeyen hata'));
        return false;
      }
    } catch (error) {
      Logger.error('[Zones] Save error:', error);
      alert('Alan kaydedilemedi: Bağlantı hatası');
      return false;
    }
  },

  /**
   * Delete zone
   */
  async deleteZone(deviceId, zoneId) {
    if (!confirm('Bu alanı silmek istediğinize emin misiniz?')) return;

    try {
      const response = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/zones/${zoneId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (response.ok) {
        // Remove from local cache
        const zones = this.zones.get(deviceId) || [];
        const index = zones.findIndex(z => z.id === zoneId);
        if (index !== -1) zones.splice(index, 1);
        this.zones.set(deviceId, zones);

        // Re-render
        this.renderZones(deviceId);
        Logger.log('[Zones] Zone deleted:', zoneId);
      }
    } catch (error) {
      Logger.error('[Zones] Delete error:', error);
    }
  },

  /**
   * Render zones overlay on camera popup
   */
  renderZones(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const container = popupEl.querySelector('.camera-frame-container');
    if (!container) return;

    // Remove existing zones overlay
    const existing = container.querySelector('.zones-overlay');
    if (existing) existing.remove();

    const zones = this.zones.get(deviceId) || [];
    if (zones.length === 0) return;

    // Create zones overlay (hidden by default)
    const overlay = document.createElement('div');
    overlay.className = 'zones-overlay zones-hidden';
    overlay.innerHTML = `
      <svg class="zones-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        ${zones.map(zone => {
          const pointsStr = zone.points.map(p => `${p[0] * 100},${p[1] * 100}`).join(' ');
          return `
            <polygon
              class="zone-polygon"
              data-zone-id="${zone.id}"
              data-zone-name="${escapeHtml(zone.name)}"
              points="${pointsStr}"
              fill="rgba(0, 255, 0, 0.1)"
              stroke="rgba(0, 255, 0, 0.3)"
              stroke-width="0.3"
            />
          `;
        }).join('')}
      </svg>
    `;

    container.appendChild(overlay);

    // Add click handlers
    const isTouchDevice = ('ontouchstart' in window || navigator.maxTouchPoints > 0) && window.matchMedia('(max-width: 768px)').matches;

    overlay.querySelectorAll('.zone-polygon').forEach(polygon => {
      if (isTouchDevice) {
        // Mobile: tap shows info card, same tap dismisses
        polygon.addEventListener('click', (e) => {
          e.stopPropagation();
          const topElement = document.elementFromPoint(e.clientX, e.clientY);
          if (topElement !== polygon && !polygon.contains(topElement)) return;

          const zoneId = polygon.dataset.zoneId;

          if (this._activeInfoZoneId === zoneId) {
            this.dismissRelayInfoCard();
            return;
          }

          this.dismissRelayInfoCard();
          this._activeInfoZoneId = zoneId;
          this.showRelayInfoCard(deviceId, zoneId, polygon);
        });

        // Long press for context menu on mobile
        let longPressTimer = null;
        polygon.addEventListener('touchstart', (e) => {
          longPressTimer = setTimeout(() => {
            e.preventDefault();
            const zoneId = polygon.dataset.zoneId;
            const touch = e.touches[0];
            this.showZoneContextMenu({ clientX: touch.clientX, clientY: touch.clientY, preventDefault: () => {} }, deviceId, zoneId);
          }, 600);
        }, { passive: false });
        polygon.addEventListener('touchend', () => { clearTimeout(longPressTimer); });
        polygon.addEventListener('touchmove', () => { clearTimeout(longPressTimer); });
      } else {
        // Desktop: click toggles relay, hover shows info
        polygon.addEventListener('click', (e) => {
          e.stopPropagation();
          const topElement = document.elementFromPoint(e.clientX, e.clientY);
          if (topElement !== polygon && !polygon.contains(topElement)) return;
          const zoneId = polygon.dataset.zoneId;
          this.handleZoneClick(deviceId, zoneId);
        });

        // Context menu for delete
        polygon.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const topElement = document.elementFromPoint(e.clientX, e.clientY);
          if (topElement !== polygon && !polygon.contains(topElement)) return;
          const zoneId = polygon.dataset.zoneId;
          this.showZoneContextMenu(e, deviceId, zoneId);
        });

        // Hover for relay info card
        let hoverTimeout = null;
        polygon.addEventListener('mouseenter', (e) => {
          const topElement = document.elementFromPoint(e.clientX, e.clientY);
          if (topElement !== polygon && !polygon.contains(topElement)) return;
          const zoneId = polygon.dataset.zoneId;
          hoverTimeout = setTimeout(() => {
            this.showRelayInfoCard(deviceId, zoneId, polygon);
          }, 200);
        });

        polygon.addEventListener('mouseleave', () => {
          if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
          this.dismissRelayInfoCard();
        });
      }
    });
  },

  /**
   * Handle zone click - toggle relay
   */
  async handleZoneClick(deviceId, zoneId) {
    const zones = this.zones.get(deviceId) || [];
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;

    // Show feedback
    this.showZoneFeedback(deviceId, zoneId, 'pending');

    try {
      const response = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/zones/${zoneId}/toggle`, {
        method: 'POST',
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();
        zone.lastState = data.newState;
        this.showZoneFeedback(deviceId, zoneId, 'success');
        Logger.log(`[Zones] Relay toggled: ${zone.name} -> ${data.newState}`);
      } else {
        this.showZoneFeedback(deviceId, zoneId, 'error');
      }
    } catch (error) {
      Logger.error('[Zones] Toggle error:', error);
      this.showZoneFeedback(deviceId, zoneId, 'error');
    }
  },

  /**
   * Show visual feedback on zone click
   */
  showZoneFeedback(deviceId, zoneId, status) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const polygon = popupEl.querySelector(`.zone-polygon[data-zone-id="${zoneId}"]`);
    if (!polygon) return;

    // Remove existing feedback classes
    polygon.classList.remove('zone-pending', 'zone-success', 'zone-error');

    if (status === 'pending') {
      polygon.classList.add('zone-pending');
    } else if (status === 'success') {
      polygon.classList.add('zone-success');
      setTimeout(() => polygon.classList.remove('zone-success'), 500);
    } else if (status === 'error') {
      polygon.classList.add('zone-error');
      setTimeout(() => polygon.classList.remove('zone-error'), 500);
    }
  },

  /**
   * Show context menu for zone (only for logged-in users)
   */
  showZoneContextMenu(e, deviceId, zoneId) {
    // Only show context menu for logged-in users (for delete option)
    const isLoggedIn = AuthSystem.isLoggedIn();
    if (!isLoggedIn) return;

    // Remove existing menu
    const existing = document.querySelector('.zone-context-menu');
    if (existing) existing.remove();

    const zones = this.zones.get(deviceId) || [];
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;

    const menu = document.createElement('div');
    menu.className = 'zone-context-menu';
    menu.innerHTML = `
      <div class="zone-context-header">${escapeHtml(zone.name)}</div>
      <div class="zone-context-item zone-context-delete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
        Alanı Sil
      </div>
    `;

    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    document.body.appendChild(menu);

    // Delete handler
    menu.querySelector('.zone-context-delete').addEventListener('click', () => {
      menu.remove();
      this.deleteZone(deviceId, zoneId);
    });

    // Close on outside click
    const closeHandler = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 100);
  },

  /**
   * Toggle draw mode (called from popup button)
   */
  toggleDrawMode(deviceId) {
    if (this.drawingState && this.drawingState.deviceId === deviceId) {
      this.exitDrawMode(true);
    } else {
      if (this.drawingState) {
        this.exitDrawMode(true);
      }
      this.enterDrawMode(deviceId);
    }
  },

  /**
   * Toggle zones visibility
   */
  toggleZonesVisibility(deviceId) {
    const currentVisible = this.zonesVisible.get(deviceId) === true; // default false (hidden)
    this.zonesVisible.set(deviceId, !currentVisible);
    this.updateZonesVisibility(deviceId);
    this.updateToggleZonesButton(deviceId);
  },

  /**
   * Update zones overlay visibility (but keep click handlers active)
   */
  updateZonesVisibility(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const overlay = popupEl?.querySelector('.zones-overlay');
    if (!overlay) return;

    const visible = this.zonesVisible.get(deviceId) === true; // default false (hidden)
    overlay.classList.toggle('zones-hidden', !visible);
  },

  /**
   * Update toggle zones button state
   */
  updateToggleZonesButton(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const btn = popupEl?.querySelector('.toggle-zones-btn');
    if (!btn) return;

    const visible = this.zonesVisible.get(deviceId) === true; // default false (hidden)
    btn.classList.toggle('zones-hidden-state', !visible);
    btn.title = visible ? 'Alanları gizle' : 'Alanları göster';

    // Toggle eye icons
    const eyeOff = btn.querySelector('.eye-off');
    const eyeOn = btn.querySelector('.eye-on');
    if (eyeOff && eyeOn) {
      eyeOff.style.display = visible ? 'none' : 'block';
      eyeOn.style.display = visible ? 'block' : 'none';
    }
  },

  /**
   * Update zone buttons visibility based on zoom level and login state
   * - toggle-zones-btn: visible for everyone at zoom-1/zoom-2
   * - draw-zone-btn: visible only for logged-in users at zoom-1/zoom-2
   */
  updateZoneButtonsVisibility(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    // Show zone buttons at zoom-1 (x2) or zoom-2 (x4)
    const isZoomed = frameContainer?.classList.contains('zoom-1') || frameContainer?.classList.contains('zoom-2');
    const isLoggedIn = AuthSystem.isLoggedIn();

    const drawBtn = popupEl.querySelector('.draw-zone-btn');
    const toggleBtn = popupEl.querySelector('.toggle-zones-btn');

    // Toggle zones button: visible for everyone when zoomed
    if (toggleBtn) toggleBtn.style.display = isZoomed ? '' : 'none';

    // Draw zone button: visible only for logged-in users when zoomed
    if (drawBtn) drawBtn.style.display = (isZoomed && isLoggedIn) ? '' : 'none';
  },

  /**
   * Show relay info card on zone hover
   */
  async showRelayInfoCard(deviceId, zoneId, polygonElement) {
    // Remove existing card
    this.dismissRelayInfoCard();

    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const container = popupEl?.querySelector('.camera-frame-container');
    if (!container) return;

    // Only show at zoom-1 (x2) or zoom-2 (x4)
    const isZoomed = container.classList.contains('zoom-1') || container.classList.contains('zoom-2');
    if (!isZoomed) return;

    const zones = this.zones.get(deviceId) || [];
    const zone = zones.find(z => z.id == zoneId);
    if (!zone) return;

    // Calculate position from polygon's bounding box (top-right corner)
    const svgElement = container.querySelector('.zones-svg');
    const containerRect = container.getBoundingClientRect();

    // Get zone's top-right point from polygon points
    const points = zone.points || [];
    if (points.length === 0) return;

    // Find rightmost-topmost point
    let maxX = 0, minY = 1;
    points.forEach(p => {
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
    });

    // Convert normalized coords to pixels
    const cardX = maxX * containerRect.width + 10; // 10px offset from zone
    const cardY = minY * containerRect.height;

    // Create card element
    const card = document.createElement('div');
    card.id = 'relay-info-card';
    card.className = 'relay-info-card';
    card.innerHTML = `
      <div class="ric-header">${escapeHtml(zone.name)}</div>
      <div class="ric-metrics ric-loading">
        <div class="ric-spinner"></div>
        <span>Yükleniyor...</span>
      </div>
    `;

    // Position card
    card.style.left = cardX + 'px';
    card.style.top = cardY + 'px';

    container.appendChild(card);

    // Fetch metrics
    try {
      const response = await fetch(`${QBitmapConfig.api.public.replace('/public', '')}/zones/${zoneId}/metrics`, {
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();
        const m = data.metrics;

        // Update card with metrics
        const metricsEl = card.querySelector('.ric-metrics');
        metricsEl.classList.remove('ric-loading');
        metricsEl.innerHTML = `
          <div class="ric-row">
            <span class="ric-label">Gerilim/Akım</span>
            <span class="ric-value">${m.voltage.toFixed(0)}V / ${m.current.toFixed(3)}A</span>
          </div>
          ${m.temperature !== null ? `
          <div class="ric-row">
            <span class="ric-label">Sıcaklık</span>
            <span class="ric-value">${m.temperature.toFixed(1)} °C</span>
          </div>
          ` : ''}
          <div class="ric-row">
            <span class="ric-label">Anlık Tüketim</span>
            <span class="ric-value">${m.apower.toFixed(1)} W</span>
          </div>
          <div class="ric-row">
            <span class="ric-label">Toplam Tüketim</span>
            <span class="ric-value">${(m.totalEnergy / 1000).toFixed(3)} kWh</span>
          </div>
          <div class="ric-row ric-total">
            <span class="ric-label">Fatura</span>
            <span class="ric-value">${m.bill.toFixed(2)} TL</span>
          </div>
        `;
      } else {
        const metricsEl = card.querySelector('.ric-metrics');
        metricsEl.classList.remove('ric-loading');
        metricsEl.innerHTML = '<span class="ric-error">Veri alınamadı</span>';
      }
    } catch (error) {
      Logger.error('[Zones] Metrics fetch error:', error);
      const metricsEl = card.querySelector('.ric-metrics');
      if (metricsEl) {
        metricsEl.classList.remove('ric-loading');
        metricsEl.innerHTML = '<span class="ric-error">Bağlantı hatası</span>';
      }
    }
  },

  /**
   * Dismiss relay info card
   */
  dismissRelayInfoCard() {
    const card = document.getElementById('relay-info-card');
    if (card) {
      card.remove();
    }
    this._activeInfoZoneId = null;
  }
};

export { ClickableZonesMixin };
