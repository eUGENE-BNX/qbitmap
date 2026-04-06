import { QBitmapConfig } from '../config.js';
import { Logger, TimerManager, escapeHtml, showNotification } from '../utils.js';
import { Analytics } from '../analytics.js';

/**
 * QBitmap Camera System - Grid Module
 * Supports multiple independent grid overlays (Grid 1, Grid 2)
 */

const CameraGridMixin = {
  // Per-grid state: keyed by gridId (1 or 2)
  _grids: {
    1: { visible: false, cells: new Map(), savedAssignments: new Map(), controlButton: null },
    2: { visible: false, cells: new Map(), savedAssignments: new Map(), controlButton: null }
  },
  maxGridCells: 9,

  _getGrid(gridId) {
    return this._grids[gridId] || this._grids[1];
  },

  /**
   * Create grid container and append to DOM
   */
  createGridContainer(gridId = 1) {
    const overlayId = `camera-grid-overlay-${gridId}`;
    if (document.getElementById(overlayId)) return;

    const overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.className = `camera-grid-overlay camera-grid-instance-${gridId}`;

    // Header with drag + close
    const header = document.createElement('div');
    header.className = 'camera-grid-header';
    header.innerHTML = `
      <div class="camera-grid-drag-handle"></div>
      <span class="camera-grid-title">Kamera GRID ${gridId}</span>
      <button class="camera-grid-close" title="Kapat">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;
    overlay.appendChild(header);

    header.querySelector('.camera-grid-close').addEventListener('click', () => this.toggleGrid(gridId));

    const grid = document.createElement('div');
    grid.className = 'camera-grid';

    // Mobile: 8 cells (2x4), Desktop: 9 cells (3x3)
    const isMobile = window.innerWidth <= 500;
    const cellCount = isMobile ? 8 : this.maxGridCells;
    for (let i = 0; i < cellCount; i++) {
      const cell = this.createGridCell(i, gridId);
      grid.appendChild(cell);
    }

    overlay.appendChild(grid);
    document.body.appendChild(overlay);

    // Setup drag functionality
    this.setupDragHandlers(overlay, header);
  },

  /**
   * Setup drag handlers for moving the grid
   */
  setupDragHandlers(overlay, handle) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;
    let dragRafId = null;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      overlay.classList.add('dragging');
      startX = e.clientX;
      startY = e.clientY;
      const rect = overlay.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging || dragRafId) return;
      const cx = e.clientX, cy = e.clientY;
      dragRafId = requestAnimationFrame(() => {
        overlay.style.left = `${startLeft + (cx - startX)}px`;
        overlay.style.top = `${startTop + (cy - startY)}px`;
        overlay.style.right = 'auto';
        dragRafId = null;
      });
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        overlay.classList.remove('dragging');
        if (dragRafId) { cancelAnimationFrame(dragRafId); dragRafId = null; }
      }
    });

    // Touch support
    handle.addEventListener('touchstart', (e) => {
      isDragging = true;
      overlay.classList.add('dragging');
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      const rect = overlay.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!isDragging || dragRafId) return;
      const touch = e.touches[0];
      const cx = touch.clientX, cy = touch.clientY;
      dragRafId = requestAnimationFrame(() => {
        overlay.style.left = `${startLeft + (cx - startX)}px`;
        overlay.style.top = `${startTop + (cy - startY)}px`;
        overlay.style.right = 'auto';
        dragRafId = null;
      });
    }, { passive: true });

    document.addEventListener('touchend', () => {
      if (isDragging) {
        isDragging = false;
        overlay.classList.remove('dragging');
        if (dragRafId) { cancelAnimationFrame(dragRafId); dragRafId = null; }
      }
    });
  },

  /**
   * Create a single grid cell
   */
  createGridCell(index, gridId = 1) {
    const cell = document.createElement('div');
    cell.className = 'camera-grid-cell empty';
    cell.dataset.cellIndex = index;
    cell.dataset.gridId = gridId;

    cell.innerHTML = `
      <div class="cell-add-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </div>
      <span class="cell-hint">Kamera Ekle</span>
    `;

    cell.addEventListener('click', (e) => {
      if (cell.classList.contains('empty')) {
        this.openCameraSelector(index, gridId);
      }
    });

    return cell;
  },

  /**
   * Toggle grid visibility
   */
  toggleGrid(gridId = 1) {
    const g = this._getGrid(gridId);
    g.visible = !g.visible;

    if (g.visible) {
      this.showGrid(gridId);
    } else {
      this.hideGrid(gridId);
    }

    // Update button state
    if (g.controlButton) {
      if (g.visible) {
        g.controlButton.classList.add('active');
      } else {
        g.controlButton.classList.remove('active');
      }
    }

    return g.visible;
  },

  /**
   * Show grid overlay and reconnect saved cameras
   */
  showGrid(gridId = 1) {
    const g = this._getGrid(gridId);
    Analytics.event('camera_grid_open', { grid_id: gridId, camera_count: g.savedAssignments.size });
    this.createGridContainer(gridId);
    const overlay = document.getElementById(`camera-grid-overlay-${gridId}`);
    if (overlay) {
      overlay.classList.add('visible');
    }

    // Reconnect all saved camera assignments
    if (g.savedAssignments.size > 0) {
      Logger.log(`[CameraGrid${gridId}] Reconnecting ${g.savedAssignments.size} saved cameras...`);
      for (const [cellIndex] of g.savedAssignments) {
        this.reconnectGridCell(cellIndex, gridId);
      }
    }

    Logger.log(`[CameraGrid${gridId}] Grid shown`);
  },

  /**
   * Hide grid and cleanup streams (but preserve camera assignments)
   */
  hideGrid(gridId = 1) {
    const overlay = document.getElementById(`camera-grid-overlay-${gridId}`);
    if (overlay) {
      overlay.classList.remove('visible');
    }

    // Close zoom popup if open
    const zoomPopup = document.getElementById(`camera-zoom-popup-${gridId}`);
    if (zoomPopup) {
      zoomPopup.remove();
    }

    // Disconnect all active streams but keep savedAssignments
    for (let i = 0; i < this.maxGridCells; i++) {
      this.disconnectGridCell(i, gridId);
    }

    const g = this._getGrid(gridId);
    Logger.log(`[CameraGrid${gridId}] Grid hidden (${g.savedAssignments.size} cameras preserved)`);
  },

  /**
   * Get cameras available for grid (WHEP and City cameras with HLS or WHEP URL)
   */
  getGridCameras() {
    return this.cameras.filter(c =>
      (c.camera_type === 'whep' || c.camera_type === 'city') && (c.hls_url || c.whep_url)
    );
  },

  /**
   * Open camera selector modal for a cell
   */
  openCameraSelector(cellIndex, gridId = 1) {
    const g = this._getGrid(gridId);
    // Get WHEP and City cameras
    const availableCameras = this.getGridCameras();

    // Get already assigned device IDs (across this grid only)
    const assignedIds = new Set();
    for (const [, data] of g.cells) {
      if (data.deviceId) assignedIds.add(data.deviceId);
    }

    // Create modal
    const modal = document.createElement('div');
    modal.id = 'camera-selector-modal';
    modal.className = 'camera-selector-modal active';

    const camerasHtml = availableCameras.length === 0
      ? '<div class="camera-selector-empty">Kamera bulunamadı</div>'
      : availableCameras.map(cam => {
          const isAssigned = assignedIds.has(cam.device_id);
          const isCity = cam.camera_type === 'city';
          const iconClass = isCity ? 'city' : 'whep';
          const typeLabel = isAssigned ? 'Zaten atanmış' : (isCity ? 'Şehir Kamerası' : 'WHEP Stream');
          return `
            <div class="camera-selector-item ${isAssigned ? 'disabled' : ''}"
                 data-device-id="${escapeHtml(cam.device_id)}"
                 data-whep-url="${escapeHtml(cam.whep_url || '')}"
                 data-hls-url="${escapeHtml(cam.hls_url || '')}"
                 data-name="${escapeHtml(cam.name || cam.device_id)}">
              <div class="camera-icon ${iconClass}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M23 7l-7 5 7 5V7z"/>
                  <rect x="1" y="5" width="15" height="14" rx="2"/>
                </svg>
              </div>
              <div class="camera-details">
                <div class="camera-name">${escapeHtml(cam.name || cam.device_id)}</div>
                <div class="camera-type">${typeLabel}</div>
              </div>
            </div>
          `;
        }).join('');

    modal.innerHTML = `
      <div class="camera-selector-overlay"></div>
      <div class="camera-selector-content">
        <div class="camera-selector-header">
          <h3>Kamera Seç — Grid ${gridId}</h3>
          <button class="camera-selector-close">&times;</button>
        </div>
        <div class="camera-selector-list">
          ${camerasHtml}
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Event handlers
    const closeModal = () => {
      modal.classList.remove('active');
      setTimeout(() => modal.remove(), 200);
    };

    modal.querySelector('.camera-selector-overlay').onclick = closeModal;
    modal.querySelector('.camera-selector-close').onclick = closeModal;

    modal.querySelectorAll('.camera-selector-item:not(.disabled)').forEach(item => {
      item.onclick = () => {
        const deviceId = item.dataset.deviceId;
        const whepUrl = item.dataset.whepUrl;
        const hlsUrl = item.dataset.hlsUrl;
        const name = item.dataset.name;
        closeModal();
        this.assignCameraToCell(cellIndex, deviceId, whepUrl, name, hlsUrl, gridId);
      };
    });
  },

  /**
   * Assign camera to grid cell and start stream
   */
  async assignCameraToCell(cellIndex, deviceId, whepUrl, displayName, hlsUrl, gridId = 1) {
    const g = this._getGrid(gridId);
    const overlayId = `camera-grid-overlay-${gridId}`;
    const cell = document.querySelector(`#${overlayId} .camera-grid-cell[data-cell-index="${cellIndex}"]`);
    if (!cell) return;

    // Update cell to loading state
    cell.className = 'camera-grid-cell loading';
    cell.innerHTML = '<div class="cell-spinner"></div>';

    // Create video element
    const video = document.createElement('video');
    video.className = 'grid-camera-video';
    video.autoplay = true;
    video.playsinline = true;
    video.muted = true;

    // Create header overlay
    const header = document.createElement('div');
    header.className = 'cell-header';
    header.innerHTML = `
      <span class="cell-name">${escapeHtml(displayName)}</span>
      <span class="cell-live-badge">HLS</span>
    `;

    // Create remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'cell-remove-btn';
    removeBtn.innerHTML = '&times;';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      this.removeCameraFromCell(cellIndex, gridId);
    };

    // Start stream: HLS first, WHEP fallback
    try {
      let pc = null;
      let hlsInstance = null;

      if (hlsUrl && this.startHlsStream) {
        const isVod = hlsUrl.includes('/clips/');
        hlsInstance = await this.startHlsStream(video, hlsUrl, {
          isVod,
          onReady: () => {
            Logger.log(`[CameraGrid${gridId}] HLS stream ready for cell ${cellIndex}`);
          },
          onError: (data) => {
            Logger.error(`[CameraGrid${gridId}] HLS error for cell ${cellIndex}:`, data);
          }
        });
      } else if (whepUrl) {
        pc = await this.startGridWhepStream(video, whepUrl);
        // Update badge to show WHEP mode
        const badge = header.querySelector('.cell-live-badge');
        if (badge) badge.textContent = 'LIVE';
      } else {
        throw new Error('No stream URL available');
      }

      // Store cell data
      g.cells.set(cellIndex, {
        deviceId,
        peerConnection: pc,
        hlsInstance,
        videoElement: video,
        name: displayName
      });

      // Save assignment for persistence (survives grid hide/show)
      g.savedAssignments.set(cellIndex, {
        deviceId,
        whepUrl,
        hlsUrl,
        name: displayName
      });

      // Update cell UI
      cell.className = 'camera-grid-cell';
      cell.innerHTML = '';
      cell.appendChild(video);
      cell.appendChild(header);
      cell.appendChild(removeBtn);

      // Double-click to zoom
      video.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.openZoomView(cellIndex, gridId);
      });

      Logger.log(`[CameraGrid${gridId}] Camera ${deviceId} assigned to cell ${cellIndex}`);

    } catch (error) {
      Logger.error(`[CameraGrid${gridId}] Stream error:`, error);
      cell.className = 'camera-grid-cell error';
      cell.innerHTML = '';

      // Add retry button
      const retryBtn = document.createElement('button');
      retryBtn.className = 'cell-remove-btn';
      retryBtn.style.opacity = '1';
      retryBtn.innerHTML = '&times;';
      retryBtn.onclick = (e) => {
        e.stopPropagation();
        this.resetCellToEmpty(cell, cellIndex, gridId);
      };
      cell.appendChild(retryBtn);
    }
  },

  /**
   * Start WHEP stream for grid cell
   * Returns the RTCPeerConnection
   */
  async startGridWhepStream(videoElement, whepUrl) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    // Promise to track connection success
    const connectionPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 15000);

      pc.ontrack = (event) => {
        Logger.log('[CameraGrid] Got track:', event.track.kind);
        if (event.streams && event.streams[0]) {
          videoElement.srcObject = event.streams[0];
          clearTimeout(timeout);
          resolve();
        }
      };

      pc.oniceconnectionstatechange = () => {
        Logger.log('[CameraGrid] ICE state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed') {
          clearTimeout(timeout);
          reject(new Error('ICE connection failed'));
        }
      };
    });

    // Add transceivers for receiving audio and video
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Wait for ICE gathering to complete (or timeout)
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
      } else {
        const checkState = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', checkState);
            resolve();
          }
        };
        pc.addEventListener('icegatheringstatechange', checkState);
        setTimeout(resolve, 3000);
      }
    });

    // Use proxy for HTTP URLs to avoid mixed content issues
    let fetchUrl = whepUrl;
    if (whepUrl.startsWith('http://')) {
      fetchUrl = `${QBitmapConfig.api.public}/whep-proxy?url=${encodeURIComponent(whepUrl)}`;
    }

    const response = await fetch(fetchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp
    });

    if (!response.ok) {
      throw new Error(`WHEP request failed: ${response.status}`);
    }

    const answerSdp = await response.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    // Wait for connection to establish
    await connectionPromise;

    Logger.log('[CameraGrid] WebRTC connection established');
    return pc;
  },

  /**
   * Remove camera from cell
   */
  removeCameraFromCell(cellIndex, gridId = 1) {
    this.cleanupGridCell(cellIndex, gridId);

    // Remove from saved assignments (user explicitly removed)
    const g = this._getGrid(gridId);
    g.savedAssignments.delete(cellIndex);

    const overlayId = `camera-grid-overlay-${gridId}`;
    const cell = document.querySelector(`#${overlayId} .camera-grid-cell[data-cell-index="${cellIndex}"]`);
    if (cell) {
      this.resetCellToEmpty(cell, cellIndex, gridId);
    }

    Logger.log(`[CameraGrid${gridId}] Removed camera from cell ${cellIndex}`);
  },

  /**
   * Reset cell to empty state
   */
  resetCellToEmpty(cell, index, gridId = 1) {
    cell.className = 'camera-grid-cell empty';
    cell.innerHTML = `
      <div class="cell-add-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </div>
      <span class="cell-hint">Kamera Ekle</span>
    `;

    // Re-attach click listener
    cell.onclick = (e) => {
      if (cell.classList.contains('empty')) {
        this.openCameraSelector(index, gridId);
      }
    };
  },

  /**
   * Cleanup peer connection / HLS instance for a cell
   */
  cleanupGridCell(cellIndex, gridId = 1) {
    const g = this._getGrid(gridId);
    const cellData = g.cells.get(cellIndex);
    if (cellData) {
      // Destroy HLS instance
      if (cellData.hlsInstance) {
        cellData.hlsInstance.destroy();
        Logger.log(`[CameraGrid${gridId}] Destroyed HLS for cell ${cellIndex}`);
      }

      // Stop all media tracks explicitly
      if (cellData.videoElement && cellData.videoElement.srcObject) {
        const tracks = cellData.videoElement.srcObject.getTracks();
        tracks.forEach(track => {
          track.stop();
          Logger.log(`[CameraGrid${gridId}] Stopped track: ${track.kind}`);
        });
        cellData.videoElement.srcObject = null;
      }

      // Close peer connection
      if (cellData.peerConnection) {
        try {
          cellData.peerConnection.close();
          Logger.log(`[CameraGrid${gridId}] Closed peer connection for cell ${cellIndex}`);
        } catch (e) {
          // Ignore close errors
        }
      }

      g.cells.delete(cellIndex);
    }
  },

  /**
   * Disconnect stream but keep assignment saved (for hide/show persistence)
   */
  disconnectGridCell(cellIndex, gridId = 1) {
    const g = this._getGrid(gridId);
    const cellData = g.cells.get(cellIndex);
    if (cellData) {
      // Destroy HLS instance
      if (cellData.hlsInstance) {
        cellData.hlsInstance.destroy();
      }

      // Stop all media tracks
      if (cellData.videoElement?.srcObject) {
        cellData.videoElement.srcObject.getTracks().forEach(track => {
          track.stop();
          Logger.log(`[CameraGrid${gridId}] Stopped track: ${track.kind}`);
        });
        cellData.videoElement.srcObject = null;
      }

      // Close peer connection
      if (cellData.peerConnection) {
        try {
          cellData.peerConnection.close();
        } catch (e) {
          // Ignore close errors
        }
      }

      Logger.log(`[CameraGrid${gridId}] Disconnected cell ${cellIndex} (assignment preserved)`);

      // Remove from active cells but keep in savedAssignments
      g.cells.delete(cellIndex);
    }
  },

  /**
   * Reconnect a saved camera assignment
   */
  async reconnectGridCell(cellIndex, gridId = 1) {
    const g = this._getGrid(gridId);
    const saved = g.savedAssignments.get(cellIndex);
    if (saved) {
      Logger.log(`[CameraGrid${gridId}] Reconnecting cell ${cellIndex}: ${saved.name}`);
      await this.assignCameraToCell(cellIndex, saved.deviceId, saved.whepUrl, saved.name, saved.hlsUrl, gridId);
    }
  },

  /**
   * Open in-place zoom view for a camera cell
   */
  async openZoomView(cellIndex, gridId = 1) {
    const g = this._getGrid(gridId);
    const cellData = g.cells.get(cellIndex);
    if (!cellData) return;

    const zoomId = `camera-zoom-popup-${gridId}`;

    // Remove existing zoom if any
    const existing = document.getElementById(zoomId);
    if (existing) {
      existing.remove();
      return; // Toggle off if clicking same cell
    }

    // Get the grid overlay position and dimensions
    const gridOverlay = document.getElementById(`camera-grid-overlay-${gridId}`);
    const grid = gridOverlay?.querySelector('.camera-grid');
    if (!gridOverlay || !grid) return;

    const gridRect = grid.getBoundingClientRect();

    // Create zoom popup
    const popup = document.createElement('div');
    popup.id = zoomId;
    popup.className = 'camera-zoom-popup zooming-in';

    // Set popup size to match grid size
    popup.style.width = `${gridRect.width}px`;
    popup.style.height = `${gridRect.height}px`;

    // Position popup centered on grid (will scale from center)
    popup.style.left = `${gridRect.left}px`;
    popup.style.top = `${gridRect.top}px`;

    // Header overlay
    const header = document.createElement('div');
    header.className = 'zoom-header';
    header.innerHTML = `
      <div class="zoom-title">
        <span class="live-dot"></span>
        <span>${escapeHtml(cellData.name || 'Kamera')}</span>
      </div>
      <span class="zoom-hint">Tıkla kapat</span>
    `;

    // Video element - share the existing stream
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsinline = true;
    video.muted = true;

    let zoomHlsResult = null;
    if (cellData.videoElement && cellData.videoElement.srcObject) {
      // WHEP: clone the MediaStream
      video.srcObject = cellData.videoElement.srcObject;
    } else {
      // HLS: start a new independent stream for zoom view
      const saved = g.savedAssignments.get(cellIndex);
      if (saved?.hlsUrl && this.startHlsStream) {
        zoomHlsResult = await this.startHlsStream(video, saved.hlsUrl, {
          isVod: saved.hlsUrl.includes('/clips/'),
        });
      }
    }

    popup.appendChild(video);
    popup.appendChild(header);
    document.body.appendChild(popup);

    // Animate in from center
    requestAnimationFrame(() => {
      popup.classList.remove('zooming-in');
      popup.classList.add('zoomed');
    });

    // Close function
    const closeZoom = () => {
      popup.classList.remove('zoomed');
      popup.classList.add('zooming-out');
      if (zoomHlsResult?.destroy) zoomHlsResult.destroy();
      setTimeout(() => popup.remove(), 250);
      document.removeEventListener('keydown', handleEsc);
    };

    // Click to close
    popup.addEventListener('click', closeZoom);

    // ESC key to close
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        closeZoom();
      }
    };
    document.addEventListener('keydown', handleEsc);

    Logger.log(`[CameraGrid${gridId}] Zoom popup opened for cell ${cellIndex}`);
  }
};

export { CameraGridMixin };
