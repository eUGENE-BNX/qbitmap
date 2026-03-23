import { Logger } from './utils.js';
import { AuthSystem } from './auth.js';

/**
 * Biometric Face Recognition Authentication
 * Using FacePlugin SDK for face detection and liveness
 * Scripts are preloaded after page load for instant FaceID experience
 */
const BiometricAuth = {
  video: null,
  canvas: null,
  overlay: null,
  stream: null,
  isDetecting: false,
  isModelLoaded: false,
  isCapturing: false,
  capturedImage: null,
  scriptsLoaded: false,
  scriptsLoading: false, // Prevent duplicate loading
  rafId: null, // Store RAF ID for cleanup

  /**
   * Preload FaceID scripts after page is idle
   * Called automatically after DOMContentLoaded
   */
  preloadScripts() {
    // Don't preload if already loaded or loading
    if (this.scriptsLoaded || this.scriptsLoading) return;

    // Use requestIdleCallback for non-blocking preload, fallback to setTimeout
    const schedulePreload = window.requestIdleCallback || ((cb) => setTimeout(cb, 2000));

    schedulePreload(() => {
      // Double-check in case user clicked FaceID before idle callback
      if (!this.scriptsLoaded && !this.scriptsLoading) {
        Logger.log('[Biometric] Preloading scripts in background...');
        this.loadScripts().catch(err => {
          Logger.warn('[Biometric] Preload failed, will retry on demand:', err.message);
        });
      }
    }, { timeout: 5000 }); // Max 5 seconds wait for idle
  },

  /**
   * Load FaceID scripts (opencv.js, faceplugin.bundle.js, liveness-detector.js)
   * Returns immediately if already loaded
   */
  async loadScripts() {
    if (this.scriptsLoaded) return true;
    if (this.scriptsLoading) {
      // Wait for ongoing loading to complete
      return new Promise((resolve) => {
        const checkLoaded = setInterval(() => {
          if (this.scriptsLoaded) {
            clearInterval(checkLoaded);
            resolve(true);
          }
        }, 100);
      });
    }

    this.scriptsLoading = true;

    const scripts = [
      '/js/faceplugin/opencv.js',
      '/js/faceplugin.bundle.js',
      '/js/liveness-detector.js'
    ];

    try {
      for (const src of scripts) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = src;
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }

      this.scriptsLoaded = true;
      Logger.log('[Biometric] Scripts loaded');
      return true;
    } finally {
      this.scriptsLoading = false;
    }
  },

  async init() {
    try {
      // First load scripts if not already loaded
      await this.loadScripts();

      if (typeof LivenessDetector !== 'undefined' && typeof LivenessDetector.loadModel === 'function') {
        await LivenessDetector.loadModel();
        this.isModelLoaded = LivenessDetector.isModelLoaded;
      }
    } catch (error) {
      Logger.error('[Biometric] Model loading error:', error);
    }
  },

  async open() {
    if (!this.isModelLoaded) {
      this.setStatus('Modeller yükleniyor...');
      await this.init();
    }

    const modal = document.getElementById('biometric-modal');
    modal.classList.add('active');

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      });

      this.video = document.getElementById('biometric-video');
      this.canvas = document.getElementById('biometric-canvas');
      this.overlay = document.getElementById('biometric-overlay');
      this.video.srcObject = this.stream;

      this.video.onloadedmetadata = () => {
        this.canvas.width = this.video.videoWidth;
        this.canvas.height = this.video.videoHeight;
        this.overlay.width = this.video.videoWidth;
        this.overlay.height = this.video.videoHeight;
        this.video.play();
        this.startDetection();
      };

    } catch (error) {
      Logger.error('[Biometric] Camera error:', error);
      this.setStatus('Kamera erişimi reddedildi', 'error');
    }
  },

  close() {
    const modal = document.getElementById('biometric-modal');
    modal.classList.remove('active');

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    this.isDetecting = false;
    this.isCapturing = false;

    // Cancel pending RAF to prevent memory leaks
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (typeof LivenessDetector !== 'undefined') {
      LivenessDetector.reset();
    }

    this.setStatus('Yüzünüzü kameraya gösterin');
  },

  startDetection() {
    const ctx = this.overlay.getContext('2d');
    this.isDetecting = true;

    const detectFrame = async () => {
      if (!this.isDetecting || !this.video || this.video.paused || !this.isModelLoaded) {
        this.rafId = null;
        return;
      }

      try {
        const canvasCtx = this.canvas.getContext('2d', { willReadFrequently: true });
        if (this.canvas.width !== this.video.videoWidth || this.canvas.height !== this.video.videoHeight) {
          this.canvas.width = this.video.videoWidth;
          this.canvas.height = this.video.videoHeight;
        }
        canvasCtx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

        ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);

        if (!this.isCapturing && typeof LivenessDetector !== 'undefined' && LivenessDetector.isModelLoaded) {
          if (!LivenessDetector.isActive() && !LivenessDetector.isComplete() && !LivenessDetector.isFailed()) {
            LivenessDetector.startChallenge();
          }

          const result = await LivenessDetector.processFrame('biometric-canvas');

          if (result) {
            const statusType = result.status === 'complete' ? 'success' :
              (result.status === 'timeout' || result.status === 'error' || result.status === 'fake') ? 'error' : '';
            this.setStatus(result.message, statusType);

            if (result.bbox) {
              const { x1, y1, x2, y2 } = result.bbox;
              const w = x2 - x1, h = y2 - y1;

              let boxColor = '#00bfff';
              if (result.status === 'complete') boxColor = '#34a853';
              else if (result.status === 'fake' || result.status === 'error') boxColor = '#ea4335';
              else if (result.score && result.score >= 0.7) boxColor = '#34a853';
              else if (result.score && result.score < 0.3) boxColor = '#ea4335';

              ctx.strokeStyle = boxColor;
              ctx.lineWidth = 3;
              ctx.lineCap = 'round';
              const cornerLen = Math.min(w, h) * 0.2;

              ctx.beginPath();
              ctx.moveTo(x1, y1 + cornerLen);
              ctx.lineTo(x1, y1);
              ctx.lineTo(x1 + cornerLen, y1);
              ctx.stroke();

              ctx.beginPath();
              ctx.moveTo(x2 - cornerLen, y1);
              ctx.lineTo(x2, y1);
              ctx.lineTo(x2, y1 + cornerLen);
              ctx.stroke();

              ctx.beginPath();
              ctx.moveTo(x1, y2 - cornerLen);
              ctx.lineTo(x1, y2);
              ctx.lineTo(x1 + cornerLen, y2);
              ctx.stroke();

              ctx.beginPath();
              ctx.moveTo(x2 - cornerLen, y2);
              ctx.lineTo(x2, y2);
              ctx.lineTo(x2, y2 - cornerLen);
              ctx.stroke();

              if (result.score !== undefined) {
                const scoreText = `${Math.round(result.score * 100)}%`;
                ctx.font = 'bold 18px Arial';
                ctx.fillStyle = 'white';
                ctx.strokeStyle = 'rgba(0,0,0,0.8)';
                ctx.lineWidth = 3;

                ctx.save();
                ctx.translate(x1 - 10, y1 + 22);
                ctx.scale(-1, 1);
                ctx.strokeText(scoreText, 0, 0);
                ctx.fillText(scoreText, 0, 0);
                ctx.restore();
              }
            }

            if (LivenessDetector.isComplete()) {
              this.autoCapture();
            } else if (LivenessDetector.isFailed()) {
              setTimeout(() => LivenessDetector.reset(), 2000);
            }
          }
        }

      } catch (error) {
        Logger.error('[Biometric] Detection error:', error);
      }

      // Store RAF ID for cleanup
      this.rafId = requestAnimationFrame(detectFrame);
    };

    // Store RAF ID for cleanup
    this.rafId = requestAnimationFrame(detectFrame);
  },

  async autoCapture() {
    if (this.isCapturing) return;
    this.isCapturing = true;
    this.setStatus('Tanınıyor...', 'success');

    const ctx = this.canvas.getContext('2d');
    ctx.drawImage(this.video, 0, 0);

    const imageData = this.canvas.toDataURL('image/jpeg', 0.9);
    const base64 = imageData.split(',')[1];
    this.capturedImage = base64;

    // Verify face with backend
    await this.verifyFace(base64);
  },

  /**
   * Verify face with backend Face Recognition API
   */
  async verifyFace(base64Image) {
    this.setStatus('Kimlik doğrulanıyor...', 'success');

    try {
      const response = await fetch(`${QBitmapConfig.api.base}/auth/biometric/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ image: base64Image })
      });

      const data = await response.json();

      if (data.success) {
        // Login successful - cookie already set by backend
        await AuthSystem.loadUserInfo();
        this.close();
        AuthSystem.showNotification('Giriş başarılı!', 'success');
      } else {
        // Login failed
        this.setStatus(data.error || 'Yüz tanınamadı', 'error');
        setTimeout(() => {
          this.isCapturing = false;
          if (typeof LivenessDetector !== 'undefined') {
            LivenessDetector.reset();
          }
        }, 2000);
      }
    } catch (error) {
      Logger.error('[Biometric] Verify error:', error);
      this.setStatus('Bağlantı hatası', 'error');
      setTimeout(() => {
        this.isCapturing = false;
        if (typeof LivenessDetector !== 'undefined') {
          LivenessDetector.reset();
        }
      }, 2000);
    }
  },

  setStatus(message, type = '') {
    const status = document.querySelector('.biometric-status');
    if (status) {
      status.textContent = message;
      status.className = 'biometric-status' + (type ? ` ${type}` : '');
    }
  }
};

// Smart lazy loading for FaceID scripts (23MB+ WASM)
// Only preload on fast connections when user is likely to use FaceID
document.addEventListener('DOMContentLoaded', () => {
  // Check if biometric auth feature is enabled
  if (!QBitmapConfig?.features?.biometricAuth) {
    Logger.log('[Biometric] Feature disabled, skipping preload');
    return;
  }

  // Use Network Information API to check connection speed
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

  // Only preload on fast connections (4G, WiFi, etc.)
  // effectiveType: 'slow-2g', '2g', '3g', '4g'
  const isFastConnection = !connection ||
    connection.effectiveType === '4g' ||
    (connection.downlink && connection.downlink > 5); // > 5 Mbps

  // Also check if user has data saver enabled
  const saveData = connection?.saveData;

  if (isFastConnection && !saveData) {
    // Delay preload until user interaction or long idle (60s)
    // This prevents loading 23MB immediately on page load
    let preloadTimeout = null;
    let hasPreloaded = false;

    const doPreload = () => {
      if (hasPreloaded) return;
      hasPreloaded = true;
      if (preloadTimeout) clearTimeout(preloadTimeout);
      Logger.log('[Biometric] Starting background preload...');
      BiometricAuth.preloadScripts();
    };

    // Preload after 60 seconds of idle, or on first user interaction
    preloadTimeout = setTimeout(doPreload, 60000);

    // Also preload on first meaningful interaction (hover on login area)
    const loginContainer = document.querySelector('.dropdown-content');
    if (loginContainer) {
      loginContainer.addEventListener('mouseenter', doPreload, { once: true });
    }
  } else {
    Logger.log('[Biometric] Slow connection detected, using on-demand loading');
    // On slow connections, scripts will load only when FaceID button is clicked
  }
});

export { BiometricAuth };
window.BiometricAuth = BiometricAuth;
