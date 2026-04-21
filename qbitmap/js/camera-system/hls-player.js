import { Logger } from '../utils.js';
import { Analytics } from '../analytics.js';
import { loadHls } from '../vendor-loader.js';

/**
 * QBitmap Camera System - HLS Player Mixin
 * Provides HLS playback via hls.js with Safari native fallback
 */

const HlsPlayerMixin = {
  /**
   * Start HLS stream on a video element
   * @param {HTMLVideoElement} videoElement
   * @param {string} hlsUrl - URL to .m3u8 manifest
   * @param {Object} options - { onReady, onError }
   * @returns {{ hls: Hls|null, destroy: Function }}
   */
  async startHlsStream(videoElement, hlsUrl, options = {}) {
    await loadHls();
    const { onReady, onError, isVod } = options;
    const _hlsStartTime = performance.now();

    // VOD clips: enable loop playback
    if (isVod) {
      videoElement.loop = true;
      videoElement._vodReloadHandler = () => {
        // hls.js may ignore loop attribute; force reload from start
        videoElement.currentTime = 0;
        videoElement.play().catch(() => {});
      };
      videoElement.addEventListener('ended', videoElement._vodReloadHandler);
      // Also handle pause at end (some browsers pause instead of firing ended)
      videoElement.addEventListener('pause', () => {
        if (isVod && videoElement.currentTime >= videoElement.duration - 0.5) {
          videoElement.currentTime = 0;
          videoElement.play().catch(() => {});
        }
      });
    }

    // Safari native HLS support
    if (videoElement.canPlayType('application/vnd.apple.mpegurl') &&
        (typeof Hls === 'undefined' || !Hls.isSupported())) {
      videoElement.src = hlsUrl;
      videoElement.addEventListener('loadedmetadata', () => onReady?.(), { once: true });
      videoElement.addEventListener('error', () => onError?.({ type: 'native' }), { once: true });
      return {
        hls: null,
        destroy() {
          videoElement.pause();
          videoElement.removeAttribute('src');
          videoElement.load();
        }
      };
    }

    // hls.js
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hlsConfig = isVod ? {
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 30,
      } : {
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
        maxBufferLength: 60,
        liveSyncDurationCount: 4,
        liveMaxLatencyDurationCount: 8,
        liveDurationInfinity: true,
      };

      const hls = new Hls(hlsConfig);

      hls.loadSource(hlsUrl);
      hls.attachMedia(videoElement);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoElement.play().catch(() => {});
        Analytics.timing('stream_load_time', _hlsStartTime);
        // [PWA] treat a successful HLS city-camera playback as engagement.
        try {
          if (!localStorage.getItem('qbitmap_first_cam_emitted')) {
            localStorage.setItem('qbitmap_first_cam_emitted', '1');
            window.dispatchEvent(new CustomEvent('qbitmap:first-camera-connected'));
          }
        } catch { /* noop */ }
        onReady?.();
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            onError?.(data);
          }
        }
      });

      return {
        hls,
        destroy() {
          hls.destroy();
          videoElement.removeAttribute('src');
          videoElement.load();
        }
      };
    }

    // Fallback: try native (some browsers support HLS natively)
    videoElement.src = hlsUrl;
    videoElement.addEventListener('loadedmetadata', () => onReady?.(), { once: true });
    videoElement.addEventListener('error', () => onError?.({ type: 'unsupported' }), { once: true });
    return {
      hls: null,
      destroy() {
        if (videoElement._vodEndedHandler) {
          videoElement.removeEventListener('ended', videoElement._vodEndedHandler);
        }
        videoElement.pause();
        videoElement.removeAttribute('src');
        videoElement.load();
      }
    };
  }
};

export { HlsPlayerMixin };
