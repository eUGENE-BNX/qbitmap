import { QBitmapConfig } from '../config.js';
import { Logger, TimerManager, escapeHtml, showNotification } from '../utils.js';
import { Analytics } from '../analytics.js';

/**
 * QBitmap Camera System - Grid Module
 * Provides a 3x2 camera grid overlay for simultaneous viewing
 */

const CameraGridMixin = {
  // Grid state
  gridVisible: false,
  gridCells: new Map(), // cellIndex -> { deviceId, peerConnection, hlsInstance, videoElement, name }
  savedGridAssignments: new Map(), // cellIndex -> { deviceId, whepUrl, hlsUrl, name } - persists when grid is hidden
  maxGridCells: 9,
  gridControlButton: null,

  /**
   * Create grid container and append to DOM
   */
  createGridContainer() {
    if (document.getElementById('camera-grid-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'camera-grid-overlay';
    overlay.className = 'camera-grid-overlay';

    // Drag handle
    const handle = document.createElement('div');
    handle.className = 'camera-grid-drag-handle';
    overlay.appendChild(handle);

    const grid = document.createElement('div');
    grid.className = 'camera-grid';

    // Create 9 empty cells (3x3)
    for (let i = 0; i < this.maxGridCells; i++) {
      const cell = this.createGridCell(i);
      grid.appendChild(cell);
    }

    overlay.appendChild(grid);
    document.body.appendChild(overlay);

    // Setup drag functionality
    this.setupDragHandlers(overlay, handle);
  },

  /**
   * Setup drag handlers for moving the grid
   */
  setupDragHandlers(overlay, handle) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;
    let dragRafId = null; // [MI-3] RAF throttle for smooth 120Hz dragging

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
  createGridCell(index) {
    const cell = document.createElement('div');
    cell.className = 'camera-grid-cell empty';
    cell.dataset.cellIndex = index;

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
        this.openCameraSelector(index);
      }
    });

    return cell;
  },

  /**
   * Toggle grid visibility
   */
  toggleGrid() {
    this.gridVisible = !this.gridVisible;

    if (this.gridVisible) {
      this.showGrid();
    } else {
      this.hideGrid();
    }

    // Update button state
    if (this.gridControlButton) {
      if (this.gridVisible) {
        this.gridControlButton.classList.add('active');
      } else {
        this.gridControlButton.classList.remove('active');
      }
    }

    return this.gridVisible;
  },

  /**
   * Show grid overlay and reconnect saved cameras
   */
  showGrid() {
    Analytics.event('camera_grid_open', { camera_count: this.savedGridAssignments.size });
    this.createGridContainer();
    const overlay = document.getElementById('camera-grid-overlay');
    if (overlay) {
      overlay.classList.add('visible');
    }

    // Reconnect all saved camera assignments
    if (this.savedGridAssignments.size > 0) {
      Logger.log(`[CameraGrid] Reconnecting ${this.savedGridAssignments.size} saved cameras...`);
      for (const [cellIndex] of this.savedGridAssignments) {
        this.reconnectGridCell(cellIndex);
      }
    }

    Logger.log('[CameraGrid] Grid shown');
  },

  /**
   * Hide grid and cleanup streams (but preserve camera assignments)
   */
  hideGrid() {
    const overlay = document.getElementById('camera-grid-overlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }

    // Close zoom popup if open
    const zoomPopup = document.getElementById('camera-zoom-popup');
    if (zoomPopup) {
      zoomPopup.remove();
    }

    // Disconnect all active streams but keep savedGridAssignments
    for (let i = 0; i < this.maxGridCells; i++) {
      this.disconnectGridCell(i);
    }

    // Note: We don't reset cells to empty - they stay as-is since overlay is hidden
    // When showGrid() is called, it will reconnect saved cameras

    Logger.log(`[CameraGrid] Grid hidden (${this.savedGridAssignments.size} cameras preserved)`);
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
  openCameraSelector(cellIndex) {
    // Get WHEP and City cameras
    const availableCameras = this.getGridCameras();

    // Get already assigned device IDs
    const assignedIds = new Set();
    for (const [, data] of this.gridCells) {
      if (data.deviceId) assignedIds.add(data.deviceId);
    }

    // Create modal
    const modal = document.createElement('div');
    modal.id = 'camera-selector-modal';
    modal.className = 'camera-selector-modal active';

    const camerasHtml = availableCameras.length === 0
      ? '<div class="camera-selector-empty">Kamera bulunamadi</div>'
      : availableCameras.map(cam => {
          const isAssigned = assignedIds.has(cam.device_id);
          const isCity = cam.camera_type === 'city';
          const iconClass = isCity ? 'city' : 'whep';
          const typeLabel = isAssigned ? 'Zaten atanmis' : (isCity ? 'Sehir Kamerasi' : 'WHEP Stream');
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
          <h3>Kamera Sec</h3>
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
        this.assignCameraToCell(cellIndex, deviceId, whepUrl, name, hlsUrl);
      };
    });
  },

  /**
   * Assign camera to grid cell and start stream
   */
  async assignCameraToCell(cellIndex, deviceId, whepUrl, displayName, hlsUrl) {
    const cell = document.querySelector(`.camera-grid-cell[data-cell-index="${cellIndex}"]`);
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
      this.removeCameraFromCell(cellIndex);
    };

    // Start stream: HLS first, WHEP fallback
    try {
      let pc = null;
      let hlsInstance = null;

      if (hlsUrl && this.startHlsStream) {
        const isVod = hlsUrl.includes('/clips/');
        hlsInstance = this.startHlsStream(video, hlsUrl, {
          isVod,
          onReady: () => {
            Logger.log(`[CameraGrid] HLS stream ready for cell ${cellIndex}`);
          },
          onError: (data) => {
            Logger.error(`[CameraGrid] HLS error for cell ${cellIndex}:`, data);
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
      this.gridCells.set(cellIndex, {
        deviceId,
        peerConnection: pc,
        hlsInstance,
        videoElement: video,
        name: displayName
      });

      // Save assignment for persistence (survives grid hide/show)
      this.savedGridAssignments.set(cellIndex, {
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
        this.openZoomView(cellIndex);
      });

      Logger.log(`[CameraGrid] Camera ${deviceId} assigned to cell ${cellIndex}`);

    } catch (error) {
      Logger.error('[CameraGrid] Stream error:', error);
      cell.className = 'camera-grid-cell error';
      cell.innerHTML = '';

      // Add retry button
      const retryBtn = document.createElement('button');
      retryBtn.className = 'cell-remove-btn';
      retryBtn.style.opacity = '1';
      retryBtn.innerHTML = '&times;';
      retryBtn.onclick = (e) => {
        e.stopPropagation();
        this.resetCellToEmpty(cell, cellIndex);
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
  removeCameraFromCell(cellIndex) {
    this.cleanupGridCell(cellIndex);

    // Remove from saved assignments (user explicitly removed)
    this.savedGridAssignments.delete(cellIndex);

    const cell = document.querySelector(`.camera-grid-cell[data-cell-index="${cellIndex}"]`);
    if (cell) {
      this.resetCellToEmpty(cell, cellIndex);
    }

    Logger.log(`[CameraGrid] Removed camera from cell ${cellIndex}`);
  },

  /**
   * Reset cell to empty state
   */
  resetCellToEmpty(cell, index) {
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
        this.openCameraSelector(index);
      }
    };
  },

  /**
   * Cleanup peer connection / HLS instance for a cell
   */
  cleanupGridCell(cellIndex) {
    const cellData = this.gridCells.get(cellIndex);
    if (cellData) {
      // Destroy HLS instance
      if (cellData.hlsInstance) {
        cellData.hlsInstance.destroy();
        Logger.log(`[CameraGrid] Destroyed HLS for cell ${cellIndex}`);
      }

      // Stop all media tracks explicitly
      if (cellData.videoElement && cellData.videoElement.srcObject) {
        const tracks = cellData.videoElement.srcObject.getTracks();
        tracks.forEach(track => {
          track.stop();
          Logger.log(`[CameraGrid] Stopped track: ${track.kind}`);
        });
        cellData.videoElement.srcObject = null;
      }

      // Close peer connection
      if (cellData.peerConnection) {
        try {
          cellData.peerConnection.close();
          Logger.log(`[CameraGrid] Closed peer connection for cell ${cellIndex}`);
        } catch (e) {
          // Ignore close errors
        }
      }

      this.gridCells.delete(cellIndex);
    }
  },

  /**
   * Disconnect stream but keep assignment saved (for hide/show persistence)
   */
  disconnectGridCell(cellIndex) {
    const cellData = this.gridCells.get(cellIndex);
    if (cellData) {
      // Destroy HLS instance
      if (cellData.hlsInstance) {
        cellData.hlsInstance.destroy();
      }

      // Stop all media tracks
      if (cellData.videoElement?.srcObject) {
        cellData.videoElement.srcObject.getTracks().forEach(track => {
          track.stop();
          Logger.log(`[CameraGrid] Stopped track: ${track.kind}`);
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

      Logger.log(`[CameraGrid] Disconnected cell ${cellIndex} (assignment preserved)`);

      // Remove from active cells but keep in savedGridAssignments
      this.gridCells.delete(cellIndex);
    }
  },

  /**
   * Reconnect a saved camera assignment
   */
  async reconnectGridCell(cellIndex) {
    const saved = this.savedGridAssignments.get(cellIndex);
    if (saved) {
      Logger.log(`[CameraGrid] Reconnecting cell ${cellIndex}: ${saved.name}`);
      await this.assignCameraToCell(cellIndex, saved.deviceId, saved.whepUrl, saved.name, saved.hlsUrl);
    }
  },

  /**
   * Open in-place zoom view for a camera cell
   * Zoom animates from grid center and expands to full grid size
   */
  openZoomView(cellIndex) {
    const cellData = this.gridCells.get(cellIndex);
    if (!cellData) return;

    // Remove existing zoom if any
    const existing = document.getElementById('camera-zoom-popup');
    if (existing) {
      existing.remove();
      return; // Toggle off if clicking same cell
    }

    // Get the grid overlay position and dimensions
    const gridOverlay = document.getElementById('camera-grid-overlay');
    const grid = gridOverlay?.querySelector('.camera-grid');
    if (!gridOverlay || !grid) return;

    const gridRect = grid.getBoundingClientRect();

    // Calculate grid center point
    const gridCenterX = gridRect.left + gridRect.width / 2;
    const gridCenterY = gridRect.top + gridRect.height / 2;

    // Create zoom popup
    const popup = document.createElement('div');
    popup.id = 'camera-zoom-popup';
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
      <span class="zoom-hint">Tikla kapat</span>
    `;

    // Video element - share the existing stream
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsinline = true;
    video.muted = true;

    if (cellData.videoElement && cellData.videoElement.srcObject) {
      video.srcObject = cellData.videoElement.srcObject;
    } else if (cellData.videoElement && cellData.videoElement.src) {
      // HLS: share the same source (hls.js manages the buffer)
      video.src = cellData.videoElement.src;
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

    Logger.log(`[CameraGrid] Zoom popup opened for cell ${cellIndex}`);
  }
};

export { CameraGridMixin };
