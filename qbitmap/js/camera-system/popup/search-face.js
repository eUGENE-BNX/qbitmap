import { QBitmapConfig } from "../../config.js";
import { Logger, escapeHtml } from "../../utils.js";
import { AuthSystem } from "../../auth.js";

const SearchFaceMixin = {
  async updateMjpegButtonState(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const mjpegBtn = popupEl?.querySelector('.mjpeg-btn');
    if (!mjpegBtn) return;

    try {
      const response = await fetch(`${this.apiSettings}/${deviceId}`);
      if (response.ok) {
        const data = await response.json();
        const mjpegEnabled = data.settings?.mjpeg_enabled || false;

        if (mjpegEnabled) {
          mjpegBtn.classList.add('active');
          mjpegBtn.title = 'MJPEG Stream (Açık)';
        } else {
          mjpegBtn.classList.remove('active');
          mjpegBtn.title = 'MJPEG Stream (Kapalı)';
        }
      }
    } catch (e) {
      Logger.warn('[Cameras] Could not get MJPEG state');
    }
  },

  /**
   * Toggle zoom: 320x180 <-> 640x360 (via double-click on video)
   */
  cycleZoom(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    if (!frameContainer) return;

    // Cycle: 0 -> 1 -> 0 (video dblclick)
    // zoom-2 is handled by title bar dblclick
    if (popupData.zoomLevel === 0) {
      popupData.zoomLevel = 1;
    } else {
      popupData.zoomLevel = 0;
      // Deactivate search mode when zooming out
      if (popupData.searchMode) {
        this.toggleSearchMode(deviceId);
      }
    }

    const level = popupData.zoomLevel;

    // Remove all zoom classes and add current
    frameContainer.classList.remove('zoom-0', 'zoom-1', 'zoom-2');
    frameContainer.classList.add(`zoom-${level}`);

    // Update cursor (respect search mode)
    if (!popupData.searchMode) {
      frameContainer.style.cursor = level === 0 ? 'zoom-in' : 'zoom-out';
    }

    // Update search button visibility
    this.updateSearchButtonVisibility(deviceId);

    // Update zone buttons visibility based on zoom
    if (this.updateZoneButtonsVisibility) {
      this.updateZoneButtonsVisibility(deviceId);
    }

    Logger.log(`[Cameras] Zoom: ${level === 0 ? '320x180' : '640x360'}`);
  },

  /**
   * Cycle to zoom-2 (x4) when title bar is double-clicked
   * Only works when at zoom-1 (x2) or higher
   */
  cycleToZoom2(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    if (!frameContainer) return;

    // From zoom-1 go to zoom-2, from zoom-2 go back to zoom-0
    if (popupData.zoomLevel === 1) {
      popupData.zoomLevel = 2;
    } else if (popupData.zoomLevel === 2) {
      popupData.zoomLevel = 0;
      // Deactivate search mode when zooming out
      if (popupData.searchMode) {
        this.toggleSearchMode(deviceId);
      }
    } else {
      // zoom-0: do nothing (need to go to zoom-1 first via video dblclick)
      return;
    }

    const level = popupData.zoomLevel;

    frameContainer.classList.remove('zoom-0', 'zoom-1', 'zoom-2');
    frameContainer.classList.add(`zoom-${level}`);

    // Update cursor (respect search mode)
    if (!popupData.searchMode) {
      frameContainer.style.cursor = level === 0 ? 'zoom-in' : 'zoom-out';
    }

    // Update search button visibility
    this.updateSearchButtonVisibility(deviceId);

    // Update zone buttons visibility
    if (this.updateZoneButtonsVisibility) {
      this.updateZoneButtonsVisibility(deviceId);
    }

    Logger.log(`[Cameras] Zoom: ${level === 0 ? '320x180' : level === 1 ? '640x360' : '1280x720'}`);
  },

  /**
   * Update search button visibility based on zoom level
   * Only visible at zoom-1 (x2) or zoom-2 (x4)
   */
  updateSearchButtonVisibility(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const searchBtn = popupEl?.querySelector('.search-btn');
    if (!searchBtn) return;

    // Show only at zoom-1 (x2) or zoom-2 (x4) for WHEP cameras
    if (popupData.isWhep && popupData.zoomLevel >= 1) {
      searchBtn.style.display = 'flex';
    } else {
      searchBtn.style.display = 'none';
      // Deactivate search mode when hiding button
      if (popupData.searchMode) {
        this.toggleSearchMode(deviceId);
      }
    }

    // Also update AI search button visibility
    this.updateAiSearchButtonVisibility(deviceId);
  },

  /**
   * Update AI search button visibility based on zoom level
   * Only visible at zoom-1 (x2) or zoom-2 (x4)
   */
  updateAiSearchButtonVisibility(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const aiSearchBtn = popupEl?.querySelector('.ai-search-btn');
    const aiAnalyzeBtn = popupEl?.querySelector('.ai-analyze-btn');

    // Show only at zoom-1 (x2) or zoom-2 (x4) for WHEP cameras
    if (popupData.isWhep && popupData.zoomLevel >= 1) {
      if (aiSearchBtn) aiSearchBtn.style.display = 'flex';
      if (aiAnalyzeBtn) aiAnalyzeBtn.style.display = 'flex';
    } else {
      if (aiSearchBtn) aiSearchBtn.style.display = 'none';
      if (aiAnalyzeBtn) aiAnalyzeBtn.style.display = 'none';
      // Exit AI search mode when hiding button
      if (popupData.aiSearchMode) {
        this.exitAiSearchMode(deviceId);
      }
      // Stop AI analyze when hiding button
      if (popupData.aiAnalyzeActive) {
        this.stopAiAnalyze(deviceId);
      }
    }
  },

  /**
   * Toggle face search mode on/off
   */
  toggleSearchMode(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const searchBtn = popupEl?.querySelector('.search-btn');
    const frameContainer = popupEl?.querySelector('.camera-frame-container');
    const videoEl = popupEl?.querySelector('.camera-video');

    if (!searchBtn || !frameContainer || !videoEl) return;

    popupData.searchMode = !popupData.searchMode;

    if (popupData.searchMode) {
      // Activate search mode
      searchBtn.classList.add('active');
      frameContainer.classList.add('search-mode');
      frameContainer.style.cursor = 'crosshair';

      // Add click handler for face capture
      popupData.searchClickHandler = (e) => this.handleSearchClick(deviceId, e);
      videoEl.addEventListener('click', popupData.searchClickHandler);

      Logger.log('[FaceSearch] Search mode activated');
    } else {
      // Deactivate search mode
      searchBtn.classList.remove('active');
      frameContainer.classList.remove('search-mode');
      frameContainer.style.cursor = popupData.zoomLevel === 0 ? 'zoom-in' : 'zoom-out';

      // Remove click handler
      if (popupData.searchClickHandler) {
        videoEl.removeEventListener('click', popupData.searchClickHandler);
        popupData.searchClickHandler = null;
      }

      // Dismiss any open tooltip
      this.dismissFaceSearchTooltip();

      Logger.log('[FaceSearch] Search mode deactivated');
    }
  },

  /**
   * Handle click on video in search mode - capture face region
   */
  async handleSearchClick(deviceId, event) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.searchMode) return;

    // Prevent if already processing
    if (popupData.searchProcessing) return;
    popupData.searchProcessing = true;

    const popupEl = popupData.popup.getElement();
    const videoEl = popupEl?.querySelector('.camera-video');
    if (!videoEl) {
      popupData.searchProcessing = false;
      return;
    }

    // Get click coordinates relative to video element
    const rect = videoEl.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;

    // Calculate scale factor between displayed size and actual video resolution
    const scaleX = videoEl.videoWidth / rect.width;
    const scaleY = videoEl.videoHeight / rect.height;

    // Convert to video coordinates
    const videoX = clickX * scaleX;
    const videoY = clickY * scaleY;

    // Define capture region size (250x250 at native resolution)
    const captureSize = 250;
    const halfSize = captureSize / 2;

    // Clamp coordinates to stay within video bounds
    const x = Math.max(0, Math.min(videoEl.videoWidth - captureSize, videoX - halfSize));
    const y = Math.max(0, Math.min(videoEl.videoHeight - captureSize, videoY - halfSize));

    // Create canvas and capture the region
    const canvas = document.createElement('canvas');
    canvas.width = captureSize;
    canvas.height = captureSize;
    const ctx = canvas.getContext('2d');

    // Draw the cropped region from video
    ctx.drawImage(
      videoEl,
      x, y, captureSize, captureSize,  // Source rect
      0, 0, captureSize, captureSize    // Dest rect
    );

    // Convert to JPEG blob
    try {
      const blob = await new Promise(resolve => {
        canvas.toBlob(resolve, 'image/jpeg', 0.9);
      });

      // Store capture data for tooltip
      const thumbnailUrl = URL.createObjectURL(blob);
      popupData.lastCapture = {
        blob,
        thumbnailUrl,
        mouseX: event.clientX,
        mouseY: event.clientY
      };

      // Show loading tooltip
      this.showFaceSearchTooltip(deviceId, {
        loading: true,
        thumbnailUrl,
        mouseX: event.clientX,
        mouseY: event.clientY
      });

      // Send to recognition API
      await this.sendFaceToRecognition(deviceId, blob);

    } catch (error) {
      Logger.error('[FaceSearch] Capture error:', error);
      popupData.searchProcessing = false;
    }
  },

  /**
   * Send captured face region to recognition API
   */
  async sendFaceToRecognition(deviceId, blob) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    try {
      // Create FormData with image
      const formData = new FormData();
      formData.append('image', blob, 'face.jpg');

      // Send to backend proxy (handles matcher.qbitwise.com auth)
      const response = await fetch(
        `${QBitmapConfig.api.public.replace('/public', '')}/face-detection/${deviceId}/recognize`,
        {
          method: 'POST',
          credentials: 'include',
          body: formData
        }
      );

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = await response.json();

      // Process results
      if (result.success && Array.isArray(result.result) && result.result.length > 0) {
        // Find best match
        const bestMatch = result.result.reduce((best, current) =>
          (!best || current.score > best.score) ? current : best
        , null);

        if (bestMatch && bestMatch.isMatchFound) {
          // Show success tooltip with match
          this.showFaceSearchTooltip(deviceId, {
            loading: false,
            matched: true,
            name: bestMatch.name,
            confidence: Math.round(bestMatch.score),
            thumbnailUrl: popupData.lastCapture?.thumbnailUrl,
            mouseX: popupData.lastCapture?.mouseX,
            mouseY: popupData.lastCapture?.mouseY
          });
        } else {
          // No match found
          this.showFaceSearchTooltip(deviceId, {
            loading: false,
            matched: false,
            message: 'Eslesen yuz bulunamadi',
            thumbnailUrl: popupData.lastCapture?.thumbnailUrl,
            mouseX: popupData.lastCapture?.mouseX,
            mouseY: popupData.lastCapture?.mouseY
          });
        }
      } else {
        // No faces detected
        this.showFaceSearchTooltip(deviceId, {
          loading: false,
          matched: false,
          message: 'Yuz tespit edilemedi',
          thumbnailUrl: popupData.lastCapture?.thumbnailUrl,
          mouseX: popupData.lastCapture?.mouseX,
          mouseY: popupData.lastCapture?.mouseY
        });
      }

    } catch (error) {
      Logger.error('[FaceSearch] Recognition error:', error);
      this.showFaceSearchTooltip(deviceId, {
        loading: false,
        error: true,
        message: 'API hatasi',
        thumbnailUrl: popupData.lastCapture?.thumbnailUrl,
        mouseX: popupData.lastCapture?.mouseX,
        mouseY: popupData.lastCapture?.mouseY
      });
    } finally {
      popupData.searchProcessing = false;
    }
  },

  /**
   * Show face search result tooltip near mouse cursor
   */
  showFaceSearchTooltip(deviceId, options) {
    const { loading, matched, error, name, confidence, message, thumbnailUrl, mouseX, mouseY } = options;

    // Remove existing tooltip (but don't revoke the blob URL if we're updating with same thumbnail)
    const existingTooltip = document.getElementById('face-search-tooltip');
    if (existingTooltip) {
      existingTooltip.remove();
    }

    // Clear previous handlers
    if (this.tooltipDismissTimer) {
      clearTimeout(this.tooltipDismissTimer);
      this.tooltipDismissTimer = null;
    }
    if (this.tooltipEscHandler) {
      document.removeEventListener('keydown', this.tooltipEscHandler);
      this.tooltipEscHandler = null;
    }
    if (this.tooltipClickHandler) {
      document.removeEventListener('click', this.tooltipClickHandler);
      this.tooltipClickHandler = null;
    }

    // Create tooltip element
    const tooltip = document.createElement('div');
    tooltip.id = 'face-search-tooltip';
    tooltip.className = 'face-search-tooltip';

    // Create thumbnail HTML - use placeholder if no URL
    const thumbHtml = thumbnailUrl
      ? `<img src="${thumbnailUrl}" class="fst-thumb" alt="Captured">`
      : `<div class="fst-thumb fst-thumb-placeholder"></div>`;

    if (loading) {
      tooltip.innerHTML = `
        <div class="fst-content loading">
          ${thumbHtml}
          <div class="fst-info">
            <div class="fst-spinner"></div>
            <span>Araniyor...</span>
          </div>
        </div>
      `;
    } else if (error) {
      tooltip.innerHTML = `
        <div class="fst-content error">
          ${thumbHtml}
          <div class="fst-info">
            <div class="fst-status">Hata</div>
            <div class="fst-message">${escapeHtml(message || 'Bilinmeyen hata')}</div>
          </div>
        </div>
      `;
    } else if (matched) {
      tooltip.innerHTML = `
        <div class="fst-content matched">
          ${thumbHtml}
          <div class="fst-info">
            <div class="fst-name">${escapeHtml(name || 'Bilinmiyor')}</div>
            <div class="fst-confidence">Eslesme: ${confidence || 0}%</div>
          </div>
        </div>
      `;
    } else {
      tooltip.innerHTML = `
        <div class="fst-content no-match">
          ${thumbHtml}
          <div class="fst-info">
            <div class="fst-status">Sonuc Yok</div>
            <div class="fst-message">${escapeHtml(message || 'Eslesen yuz bulunamadi')}</div>
          </div>
        </div>
      `;
    }

    // Position tooltip near mouse BEFORE appending
    const offset = 5;
    tooltip.style.left = `${mouseX + offset}px`;
    tooltip.style.top = `${mouseY + offset}px`;

    document.body.appendChild(tooltip);

    // Ensure tooltip stays within viewport, then show
    requestAnimationFrame(() => {
      const rect = tooltip.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        tooltip.style.left = `${mouseX - rect.width - offset}px`;
      }
      if (rect.bottom > window.innerHeight) {
        tooltip.style.top = `${mouseY - rect.height - offset}px`;
      }
      // Show tooltip after positioning
      tooltip.classList.add('visible');
    });

    // Store popup data reference for mouse tracking
    const popupData = this.popups.get(deviceId);
    if (popupData) {
      popupData.tooltipElement = tooltip;
      popupData.tooltipDeviceId = deviceId;

      // Set up mouse move handler for following
      popupData.tooltipMouseMoveHandler = (e) => {
        this.updateTooltipPosition(deviceId, e.clientX, e.clientY);
      };
      document.addEventListener('mousemove', popupData.tooltipMouseMoveHandler);
    }

    // Auto-dismiss after 5 seconds (if not loading)
    if (!loading) {
      this.tooltipDismissTimer = setTimeout(() => this.dismissFaceSearchTooltip(), 5000);
    }

    // ESC to dismiss
    this.tooltipEscHandler = (e) => {
      if (e.key === 'Escape') {
        this.dismissFaceSearchTooltip();
      }
    };
    document.addEventListener('keydown', this.tooltipEscHandler);

    // Click outside to dismiss (with delay to prevent immediate dismiss)
    setTimeout(() => {
      this.tooltipClickHandler = (e) => {
        if (!tooltip.contains(e.target)) {
          this.dismissFaceSearchTooltip();
        }
      };
      document.addEventListener('click', this.tooltipClickHandler);
    }, 100);
  },

  /**
   * Update tooltip position to follow mouse
   */
  updateTooltipPosition(deviceId, mouseX, mouseY) {
    const popupData = this.popups.get(deviceId);
    if (!popupData?.tooltipElement) return;

    const tooltip = popupData.tooltipElement;
    const offset = 5;

    tooltip.style.left = `${mouseX + offset}px`;
    tooltip.style.top = `${mouseY + offset}px`;

    // Adjust if going off-screen
    const rect = tooltip.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      tooltip.style.left = `${mouseX - rect.width - offset}px`;
    }
    if (rect.bottom > window.innerHeight) {
      tooltip.style.top = `${mouseY - rect.height - offset}px`;
    }
  },

  /**
   * Dismiss and cleanup face search tooltip
   */
  dismissFaceSearchTooltip() {
    const tooltip = document.getElementById('face-search-tooltip');
    if (tooltip) {
      tooltip.remove();
    }

    // Clear dismiss timer
    if (this.tooltipDismissTimer) {
      clearTimeout(this.tooltipDismissTimer);
      this.tooltipDismissTimer = null;
    }

    // Remove ESC handler
    if (this.tooltipEscHandler) {
      document.removeEventListener('keydown', this.tooltipEscHandler);
      this.tooltipEscHandler = null;
    }

    // Remove click handler
    if (this.tooltipClickHandler) {
      document.removeEventListener('click', this.tooltipClickHandler);
      this.tooltipClickHandler = null;
    }

    // Cleanup mouse move handlers and blob URLs from all popups
    for (const [deviceId, popupData] of this.popups) {
      if (popupData.tooltipMouseMoveHandler) {
        document.removeEventListener('mousemove', popupData.tooltipMouseMoveHandler);
        popupData.tooltipMouseMoveHandler = null;
      }
      if (popupData.lastCapture?.thumbnailUrl) {
        URL.revokeObjectURL(popupData.lastCapture.thumbnailUrl);
        popupData.lastCapture = null;
      }
      popupData.tooltipElement = null;
    }
  },
};

export { SearchFaceMixin };
