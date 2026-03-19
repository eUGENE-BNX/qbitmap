/**
 * QBitmap Camera System - Face Blur Module
 * Client-side face detection and mosaic blur using face-api.js
 */

const FaceBlurMixin = {
  // State management
  faceBlurState: new Map(), // deviceId -> { enabled, canvas, ctx, animationId, lastFrameTime }
  faceDetectorReady: false,
  faceDetectorLoading: false,

  // face-api.js CDN
  FACE_API_CDN: 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js',
  FACE_API_MODELS: 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model',

  // Configuration
  BLUR_BLOCK_SIZE: 8, // Smaller blocks for finer mosaic
  BLUR_TARGET_FPS: 10, // ~100ms between frames
  BLUR_FRAME_INTERVAL: 100, // ms

  /**
   * Load face-api.js (lazy loading)
   */
  async loadFaceDetector() {
    if (this.faceDetectorReady) return true;
    if (this.faceDetectorLoading) {
      while (this.faceDetectorLoading) {
        await new Promise(r => setTimeout(r, 100));
      }
      return this.faceDetectorReady;
    }

    this.faceDetectorLoading = true;
    Logger.log('[FaceBlur] Loading face-api.js...');

    try {
      // Load face-api.js script
      if (!window.faceapi) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = this.FACE_API_CDN;
          script.onload = resolve;
          script.onerror = () => reject(new Error('Failed to load face-api.js'));
          document.head.appendChild(script);
        });
        Logger.log('[FaceBlur] face-api.js script loaded');
      }

      // Load SSD MobileNet model (better accuracy for distant faces)
      Logger.log('[FaceBlur] Loading SSD MobileNet model...');
      await faceapi.nets.ssdMobilenetv1.loadFromUri(this.FACE_API_MODELS);
      Logger.log('[FaceBlur] Model loaded successfully');

      this.faceDetectorReady = true;
      this.faceDetectorLoading = false;
      return true;

    } catch (error) {
      this.faceDetectorLoading = false;
      Logger.error('[FaceBlur] Failed to load face detector:', error);
      throw error;
    }
  },

  /**
   * Toggle face blur for a camera popup
   */
  async toggleFaceBlur(deviceId) {
    const state = this.faceBlurState.get(deviceId);

    if (state?.enabled) {
      this.stopFaceBlur(deviceId);
    } else {
      await this.startFaceBlur(deviceId);
    }
  },

  /**
   * Start face blur processing
   */
  async startFaceBlur(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    // Update button to show loading state
    const blurBtn = popupEl.querySelector('.blur-btn');
    if (blurBtn) {
      blurBtn.classList.add('loading');
      blurBtn.title = 'Yükleniyor...';
    }

    try {
      // Load face detector if not ready
      await this.loadFaceDetector();

      // Create canvas overlay with double buffering
      const { canvas, ctx, offscreen, offscreenCtx } = this.createBlurCanvas(deviceId);
      if (!canvas) {
        throw new Error('Failed to create blur canvas');
      }

      // Initialize state
      this.faceBlurState.set(deviceId, {
        enabled: true,
        canvas,
        ctx,
        offscreen,
        offscreenCtx,
        animationId: null,
        lastFrameTime: 0
      });

      // Update button state
      if (blurBtn) {
        blurBtn.classList.remove('loading');
        blurBtn.classList.add('active');
        blurBtn.title = 'Yüz Bulanıklaştır (Açık)';
      }

      // Start processing loop
      this.processBlurFrame(deviceId);

      Logger.log('[FaceBlur] Started for', deviceId);
      this.terminalWrite(deviceId, '[SYS] Yüz bulanıklaştırma başlatıldı', true);

    } catch (error) {
      Logger.error('[FaceBlur] Failed to start:', error);

      // Reset button
      if (blurBtn) {
        blurBtn.classList.remove('loading', 'active');
        blurBtn.title = 'Yüz Bulanıklaştır';
      }

      this.terminalWrite(deviceId, '[ERR] Yüz algılama yüklenemedi', true);
    }
  },

  /**
   * Stop face blur processing
   */
  stopFaceBlur(deviceId) {
    const state = this.faceBlurState.get(deviceId);
    if (!state) return;

    // Cancel animation frame
    if (state.animationId) {
      cancelAnimationFrame(state.animationId);
    }

    // Remove canvas
    if (state.canvas && state.canvas.parentNode) {
      state.canvas.parentNode.removeChild(state.canvas);
    }

    // Clear state
    this.faceBlurState.delete(deviceId);

    // Update button and restore video/img visibility
    const popupData = this.popups.get(deviceId);
    if (popupData) {
      const popupEl = popupData.popup.getElement();
      const blurBtn = popupEl?.querySelector('.blur-btn');
      if (blurBtn) {
        blurBtn.classList.remove('active', 'loading');
        blurBtn.title = 'Yüz Bulanıklaştır';
      }
      // Restore video/img visibility
      const video = popupEl?.querySelector('.camera-video');
      const img = popupEl?.querySelector('.camera-frame');
      if (video) video.style.opacity = '1';
      if (img) img.style.opacity = '1';
    }

    Logger.log('[FaceBlur] Stopped for', deviceId);
    this.terminalWrite(deviceId, '[SYS] Yüz bulanıklaştırma durduruldu', true);
  },

  /**
   * Create blur canvas overlay with double buffering
   */
  createBlurCanvas(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return { canvas: null, ctx: null, offscreen: null, offscreenCtx: null };

    const popupEl = popupData.popup.getElement();
    const frameContainer = popupEl?.querySelector('.camera-frame-container');
    if (!frameContainer) return { canvas: null, ctx: null, offscreen: null, offscreenCtx: null };

    // Create visible canvas
    const canvas = document.createElement('canvas');
    canvas.className = 'blur-canvas';
    canvas.width = 640;
    canvas.height = 360;

    // Create offscreen canvas for double buffering
    const offscreen = document.createElement('canvas');
    offscreen.width = 640;
    offscreen.height = 360;

    // Insert visible canvas into container
    frameContainer.appendChild(canvas);

    // Hide original video/img to prevent flicker
    const video = popupEl.querySelector('.camera-video');
    const img = popupEl.querySelector('.camera-frame');
    if (video) video.style.opacity = '0';
    if (img) img.style.opacity = '0';

    const ctx = canvas.getContext('2d');
    const offscreenCtx = offscreen.getContext('2d', { willReadFrequently: true });

    return { canvas, ctx, offscreen, offscreenCtx };
  },

  /**
   * Main processing loop with double buffering
   */
  async processBlurFrame(deviceId) {
    const state = this.faceBlurState.get(deviceId);
    if (!state?.enabled) return;

    // Skip if already processing
    if (state.isProcessing) {
      state.animationId = requestAnimationFrame(() => this.processBlurFrame(deviceId));
      return;
    }

    const popupData = this.popups.get(deviceId);
    if (!popupData) {
      this.stopFaceBlur(deviceId);
      return;
    }

    const popupEl = popupData.popup.getElement();
    if (!popupEl) {
      this.stopFaceBlur(deviceId);
      return;
    }

    const { canvas, ctx, offscreen, offscreenCtx } = state;

    // Get source element
    let source;
    if (popupData.isWhep) {
      source = popupEl.querySelector('.camera-video');
      if (!source || source.readyState < 2) {
        state.animationId = requestAnimationFrame(() => this.processBlurFrame(deviceId));
        return;
      }
    } else {
      source = popupEl.querySelector('.camera-frame');
      if (!source?.complete || !source.naturalWidth) {
        state.animationId = requestAnimationFrame(() => this.processBlurFrame(deviceId));
        return;
      }
    }

    // Frame rate limiting
    const now = performance.now();
    if (now - state.lastFrameTime < this.BLUR_FRAME_INTERVAL) {
      state.animationId = requestAnimationFrame(() => this.processBlurFrame(deviceId));
      return;
    }
    state.lastFrameTime = now;
    state.isProcessing = true;

    try {
      // Draw source to OFFSCREEN canvas first
      offscreenCtx.drawImage(source, 0, 0, offscreen.width, offscreen.height);

      // Detect faces using SSD MobileNet (lower confidence = more detections)
      const detections = await faceapi.detectAllFaces(offscreen, new faceapi.SsdMobilenetv1Options({
        minConfidence: 0.15
      }));

      // Apply mosaic to each detected face on OFFSCREEN canvas
      if (detections.length > 0) {
        for (const detection of detections) {
          const box = detection.box;

          // Add padding around face (25%)
          const padding = 0.25;
          const x = Math.max(0, box.x - box.width * padding);
          const y = Math.max(0, box.y - box.height * padding);
          const w = Math.min(offscreen.width - x, box.width * (1 + 2 * padding));
          const h = Math.min(offscreen.height - y, box.height * (1 + 2 * padding));

          this.applyMosaic(offscreenCtx, x, y, w, h, this.BLUR_BLOCK_SIZE);
        }
      }

      // Copy completed frame to visible canvas (atomic swap)
      ctx.drawImage(offscreen, 0, 0);

    } catch (e) {
      // On error, still show the current offscreen frame
      ctx.drawImage(offscreen, 0, 0);
    }

    state.isProcessing = false;

    // Continue loop
    state.animationId = requestAnimationFrame(() => this.processBlurFrame(deviceId));
  },

  /**
   * Apply mosaic effect to a region
   */
  applyMosaic(ctx, x, y, width, height, blockSize) {
    x = Math.floor(x);
    y = Math.floor(y);
    width = Math.floor(width);
    height = Math.floor(height);

    if (width <= 0 || height <= 0) return;

    const imageData = ctx.getImageData(x, y, width, height);
    const data = imageData.data;

    for (let by = 0; by < height; by += blockSize) {
      for (let bx = 0; bx < width; bx += blockSize) {
        const blockW = Math.min(blockSize, width - bx);
        const blockH = Math.min(blockSize, height - by);

        let r = 0, g = 0, b = 0, count = 0;

        for (let py = by; py < by + blockH; py++) {
          for (let px = bx; px < bx + blockW; px++) {
            const i = (py * width + px) * 4;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
          }
        }

        r = Math.floor(r / count);
        g = Math.floor(g / count);
        b = Math.floor(b / count);

        for (let py = by; py < by + blockH; py++) {
          for (let px = bx; px < bx + blockW; px++) {
            const i = (py * width + px) * 4;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
          }
        }
      }
    }

    ctx.putImageData(imageData, x, y);
  },

  /**
   * Cleanup blur resources when popup closes
   */
  cleanupFaceBlur(deviceId) {
    const state = this.faceBlurState.get(deviceId);
    if (state) {
      if (state.animationId) {
        cancelAnimationFrame(state.animationId);
      }
      if (state.canvas && state.canvas.parentNode) {
        state.canvas.parentNode.removeChild(state.canvas);
      }
      this.faceBlurState.delete(deviceId);
    }
  },

  /**
   * Update blur button visibility based on zoom level
   */
  updateBlurButtonVisibility(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    const blurBtn = popupEl?.querySelector('.blur-btn');
    if (!blurBtn) return;

    // Show only at zoom level 1 or higher (640x360+)
    const zoomLevel = popupData.zoomLevel || 0;
    blurBtn.style.display = zoomLevel >= 1 ? '' : 'none';

    // If blur is active but zoom dropped below 1, stop it
    const state = this.faceBlurState.get(deviceId);
    if (state?.enabled && zoomLevel < 1) {
      this.stopFaceBlur(deviceId);
    }
  }
};

// Merge into CameraSystem
if (typeof CameraSystem !== 'undefined') {
  Object.assign(CameraSystem, FaceBlurMixin);
}
