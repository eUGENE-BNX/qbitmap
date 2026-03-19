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
  startHlsStream(videoElement, hlsUrl, options = {}) {
    const { onReady, onError } = options;
    const _hlsStartTime = performance.now();

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
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 30,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        liveDurationInfinity: true,
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(videoElement);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoElement.play().catch(() => {});
        Analytics.timing('stream_load_time', _hlsStartTime);
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
        videoElement.pause();
        videoElement.removeAttribute('src');
        videoElement.load();
      }
    };
  }
};

// Merge into CameraSystem when available
if (typeof CameraSystem !== 'undefined') {
  Object.assign(CameraSystem, HlsPlayerMixin);
  Logger.log('[HlsPlayer] Module loaded');
} else {
  const waitForCS = setInterval(() => {
    if (typeof CameraSystem !== 'undefined') {
      clearInterval(waitForCS);
      Object.assign(CameraSystem, HlsPlayerMixin);
      Logger.log('[HlsPlayer] Module loaded (deferred)');
    }
  }, 100);
}
