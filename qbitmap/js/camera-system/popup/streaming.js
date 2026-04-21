import { QBitmapConfig } from "../../config.js";
import { Logger } from "../../utils.js";
import { Analytics } from "../../analytics.js";

const StreamingMixin = {
  // [PWA] Media Session for camera popups. Snapshots the current video
  // frame once decoded so the lock-screen artwork shows the live camera
  // view instead of the default PWA logo. WebRTC / HLS streams are
  // same-origin so the canvas isn't tainted.
  _attachCameraMediaSession(popupData, videoEl, deviceId) {
    if (!popupData || !videoEl) return;
    if (popupData.mediaSessionCleanup) {
      popupData.mediaSessionCleanup();
      popupData.mediaSessionCleanup = null;
    }
    import('../../../src/pwa/media-session.js').then(({ wireMediaSession }) => {
      const camera = popupData.camera || {};
      const title = camera.name || camera.camera_name || 'Canlı Kamera';
      const location = camera.location_name || camera.address || '';
      const opts = {
        title,
        artist: location || 'Canlı',
        album: 'QBitmap Canlı Yayın',
        live: true,
        skipPause: true, // pause on a live feed is misleading — use Stop
        posterUrl: null,
        onStop: () => { try { this.closePopup?.(deviceId); } catch {} },
      };

      const rewire = () => {
        if (popupData.mediaSessionCleanup) popupData.mediaSessionCleanup();
        popupData.mediaSessionCleanup = wireMediaSession(videoEl, opts);
      };
      rewire();

      // Build a JPEG data URL from the current camera frame. The tricky
      // part is WHEP: Chrome Android hardware-decodes WebRTC video into
      // an overlay that neither canvas2D drawImage nor ImageCapture can
      // read reliably — both produce a uniform (brown) frame. The
      // modern fix is MediaStreamTrackProcessor, which exposes raw
      // VideoFrame objects from the track and bypasses the overlay.
      // HLS streams go through the video-element path as usual.
      const W = 512;
      const bitmapToDataUrl = (bmp) => {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = Math.round(W * bmp.height / bmp.width) || W;
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.75);
      };

      const grabFromTrack = async () => {
        const stream = videoEl.srcObject;
        const track = stream?.getVideoTracks?.()[0];
        if (!track || track.readyState !== 'live') return null;

        // Modern path — MediaStreamTrackProcessor + VideoFrame.
        if ('MediaStreamTrackProcessor' in window) {
          let reader;
          try {
            const processor = new MediaStreamTrackProcessor({ track });
            reader = processor.readable.getReader();
            const { value: frame, done } = await reader.read();
            if (done || !frame) return null;
            const bitmap = await createImageBitmap(frame);
            frame.close();
            try { await reader.cancel(); } catch {}
            const url = bitmapToDataUrl(bitmap);
            bitmap.close?.();
            return url;
          } catch {
            try { await reader?.cancel(); } catch {}
            // fall through
          }
        }

        // Legacy path — ImageCapture. Often rejected on remote tracks,
        // but worth a shot.
        if ('ImageCapture' in window) {
          try {
            const bmp = await new ImageCapture(track).grabFrame();
            const url = bitmapToDataUrl(bmp);
            bmp.close?.();
            return url;
          } catch { /* ignore */ }
        }
        return null;
      };

      const grabFromVideoEl = async () => {
        if (!videoEl.videoWidth || !videoEl.videoHeight) return null;
        try {
          // createImageBitmap on the video element can succeed where
          // canvas.drawImage(video) fails on HW-accelerated playback.
          const bmp = await createImageBitmap(videoEl);
          const url = bitmapToDataUrl(bmp);
          bmp.close?.();
          return url;
        } catch { /* fall through */ }
        try {
          const canvas = document.createElement('canvas');
          canvas.width = W;
          canvas.height = Math.round(W * videoEl.videoHeight / videoEl.videoWidth) || W;
          canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/jpeg', 0.75);
        } catch { return null; }
      };

      const snapshot = async () => {
        try {
          const dataUrl = (await grabFromTrack()) || (await grabFromVideoEl());
          if (!dataUrl || dataUrl.length < 3000) return false;
          opts.posterUrl = dataUrl;
          rewire();
          return true;
        } catch {
          return false;
        }
      };

      // `requestVideoFrameCallback` fires once a frame has been decoded
      // and is ready to paint — exactly what we need so the capture
      // isn't an empty buffer. Fall back to load events on older UAs.
      if (typeof videoEl.requestVideoFrameCallback === 'function') {
        videoEl.requestVideoFrameCallback(() => snapshot());
      } else {
        videoEl.addEventListener('loadeddata', async () => {
          if (!(await snapshot())) {
            videoEl.addEventListener('playing', () => snapshot(), { once: true });
          }
        }, { once: true });
      }
    }).catch(() => {});
  },


  async startWhepStream(deviceId, whepUrl) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    const videoEl = popupEl.querySelector('.camera-video');

    if (!frameContainer || !videoEl || !whepUrl) {
      Logger.error('[WHEP] Missing video element or URL');
      frameContainer?.classList.remove('loading');
      frameContainer?.classList.add('error');
      return;
    }

    try {
      // Create RTCPeerConnection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      // Store peer connection for cleanup
      popupData.peerConnection = pc;

      // Handle incoming tracks
      pc.ontrack = (event) => {
        Logger.log('[WHEP] Got track:', event.track.kind);
        if (event.streams && event.streams[0]) {
          videoEl.srcObject = event.streams[0];
          frameContainer.classList.remove('loading', 'error');
          frameContainer.classList.add('loaded');

          // [PWA-03] One-shot signal for install-prompt. Fires the
          // first time any camera connects; persists via localStorage.
          try {
            if (!localStorage.getItem('qbitmap_first_cam_emitted')) {
              localStorage.setItem('qbitmap_first_cam_emitted', '1');
              window.dispatchEvent(new CustomEvent('qbitmap:first-camera-connected'));
            }
          } catch { /* localStorage blocked — skip */ }

          // [PWA] Media Session — defer-until-playing helper is safe
          // to call here; it wires listeners but registers handlers
          // only after the `playing` event fires.
          this._attachCameraMediaSession(popupData, videoEl, deviceId);


          // Start stats polling for viewer count and bandwidth
          const bandwidthSpan = popupEl.querySelector('.camera-bandwidth');
          const viewerCountSpan = popupEl.querySelector('.viewer-count');

          if (bandwidthSpan && viewerCountSpan) {
            if (popupData.clockInterval) clearInterval(popupData.clockInterval);

            // Extract path from WHEP URL (e.g., http://167.235.27.12:8889/cam1/whep -> cam1)
            const extractPath = (url) => {
              try {
                const parts = url.split('/');
                const whepIndex = parts.findIndex(p => p === 'whep');
                return whepIndex > 0 ? parts[whepIndex - 1] : null;
              } catch (e) {
                return null;
              }
            };

            const streamPath = extractPath(whepUrl);
            let lastBytesSent = 0;
            let lastTimestamp = Date.now();

            const updateStats = async () => {
              if (!streamPath) return;

              try {
                const response = await fetch(`${QBitmapConfig.api.public}/mediamtx/metrics/${streamPath}`);
                if (response.ok) {
                  const data = await response.json();

                  // Update viewer count
                  viewerCountSpan.textContent = data.viewers;

                  // Calculate bandwidth rate (bytes per second)
                  const now = Date.now();
                  const timeDiff = (now - lastTimestamp) / 1000; // seconds
                  const bytesDiff = data.bytesSent - lastBytesSent;

                  if (lastBytesSent > 0 && timeDiff > 0) {
                    const bytesPerSecond = bytesDiff / timeDiff;
                    bandwidthSpan.textContent = this.formatBandwidth(bytesPerSecond);
                  } else {
                    bandwidthSpan.textContent = data.bytesSentFormatted;
                  }

                  lastBytesSent = data.bytesSent;
                  lastTimestamp = now;
                }
              } catch (e) {
                // Silent fail
              }
            };

            this.startAdaptivePolling(popupData, updateStats);
          }

          // Frame-freeze watchdog: detect stalled video without waiting for ICE failure
          if (popupData.whepWatchdog) clearInterval(popupData.whepWatchdog);
          let lastFramesDecoded = 0;
          let stallTicks = 0;
          popupData.whepWatchdog = setInterval(async () => {
            if (!popupData.peerConnection || popupData.peerConnection !== pc) {
              clearInterval(popupData.whepWatchdog);
              popupData.whepWatchdog = null;
              return;
            }
            try {
              const stats = await pc.getStats();
              let framesDecoded = 0;
              stats.forEach(r => {
                if (r.type === 'inbound-rtp' && r.kind === 'video') {
                  framesDecoded = r.framesDecoded || 0;
                }
              });
              if (framesDecoded > lastFramesDecoded) {
                lastFramesDecoded = framesDecoded;
                stallTicks = 0;
              } else if (lastFramesDecoded > 0) {
                stallTicks++;
                // 3 ticks * 3s = 9s without a new decoded frame → reconnect
                if (stallTicks >= 3) {
                  Logger.log('[WHEP] Frame freeze detected, reconnecting', deviceId);
                  clearInterval(popupData.whepWatchdog);
                  popupData.whepWatchdog = null;
                  if (this.popups.has(deviceId)) {
                    this.reconnectWhepStream(deviceId);
                  }
                }
              }
            } catch (e) {
              // Silent fail
            }
          }, 3000);
        }
      };

      pc.oniceconnectionstatechange = () => {
        Logger.log('[WHEP] ICE state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          // Reset backoff on successful connection
          popupData.whepReconnectAttempts = 0;
        } else if (pc.iceConnectionState === 'failed') {
          frameContainer.classList.remove('loading', 'loaded');
          frameContainer.classList.add('error');
          // Exponential backoff: 3s, 6s, 12s, 24s, max 30s
          const attempts = popupData.whepReconnectAttempts || 0;
          const delay = Math.min(3000 * Math.pow(2, attempts), 30000);
          popupData.whepReconnectAttempts = attempts + 1;
          Logger.log(`[WHEP] Reconnecting in ${delay}ms (attempt ${attempts + 1})...`);
          setTimeout(() => {
            if (this.popups.has(deviceId)) {
              this.reconnectWhepStream(deviceId);
            }
          }, delay);
        } else if (pc.iceConnectionState === 'disconnected') {
          // Disconnected state - might recover, wait before showing error
          setTimeout(() => {
            if (pc.iceConnectionState === 'disconnected') {
              frameContainer.classList.remove('loading', 'loaded');
              frameContainer.classList.add('error');
            }
          }, 5000);
        }
      };

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
          // Timeout after 3 seconds
          setTimeout(resolve, 3000);
        }
      });

      // Send offer to WHEP endpoint via proxy (to avoid mixed content issues)
      // Use proxy for HTTP URLs, direct for HTTPS
      let fetchUrl = whepUrl;
      if (whepUrl.startsWith('http://')) {
        fetchUrl = `${QBitmapConfig.api.public}/whep-proxy?url=${encodeURIComponent(whepUrl)}`;
      }

      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp'
        },
        body: pc.localDescription.sdp
      });

      if (!response.ok) {
        throw new Error(`WHEP request failed: ${response.status}`);
      }

      // Get answer from WHEP server
      const answerSdp = await response.text();
      await pc.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp
      });

      Logger.log('[WHEP] WebRTC connection established');

    } catch (error) {
      Logger.error('[WHEP] Connection error:', error);

      // Cleanup peer connection on error to prevent memory leak
      if (popupData.peerConnection) {
        try {
          popupData.peerConnection.close();
        } catch (e) {
          // Ignore close errors
        }
        popupData.peerConnection = null;
      }
      if (popupData.whepWatchdog) {
        clearInterval(popupData.whepWatchdog);
        popupData.whepWatchdog = null;
      }

      frameContainer.classList.remove('loading', 'loaded');
      frameContainer.classList.add('error');
    }
  },

  /**
   * Start HLS playback for a popup
   */
  async startHlsPlayback(deviceId, hlsUrl) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    const videoEl = popupEl.querySelector('.camera-video');

    if (!frameContainer || !videoEl || !hlsUrl) {
      Logger.error('[HLS] Missing video element or URL');
      frameContainer?.classList.remove('loading');
      frameContainer?.classList.add('error');
      return;
    }

    popupData.streamMode = 'hls';

    // Update protocol toggle label
    const protocolLabel = popupEl.querySelector('.protocol-label');
    if (protocolLabel) protocolLabel.textContent = 'HLS';
    const protocolBtn = popupEl.querySelector('.protocol-toggle-btn');
    if (protocolBtn) {
      protocolBtn.classList.remove('active');
      protocolBtn.title = 'Gerçek Zamanlı Mod';
    }

    const isCityCamera = popupData.camera?.camera_type === 'city' || popupData.camera?.is_city_camera;

    const result = await this.startHlsStream(videoEl, hlsUrl, {
      isVod: isCityCamera,
      onReady: () => {
        frameContainer.classList.remove('loading', 'error');
        frameContainer.classList.add('loaded');

        // [PWA] Media Session — same defer-until-playing helper.
        this._attachCameraMediaSession(popupData, videoEl, deviceId);


        // Start metrics polling
        const bandwidthSpan = popupEl.querySelector('.camera-bandwidth');
        const viewerCountSpan = popupEl.querySelector('.viewer-count');
        const whepUrl = popupData.camera.whep_url;

        if (bandwidthSpan && viewerCountSpan && whepUrl) {
          if (popupData.clockInterval) clearInterval(popupData.clockInterval);

          const extractPath = (url) => {
            try {
              const parts = url.split('/');
              const whepIndex = parts.findIndex(p => p === 'whep');
              return whepIndex > 0 ? parts[whepIndex - 1] : null;
            } catch (e) { return null; }
          };

          const streamPath = extractPath(whepUrl);
          let lastBytesSent = 0;
          let lastTimestamp = Date.now();
          const updateStats = async () => {
            if (!streamPath) return;
            try {
              const response = await fetch(`${QBitmapConfig.api.public}/mediamtx/metrics/${streamPath}`);
              if (response.ok) {
                const data = await response.json();
                // WHEP viewers + at least 1 if HLS active (current user)
                const hlsViewers = data.hlsActive ? 1 : 0;
                viewerCountSpan.textContent = data.viewers + hlsViewers;
                const now = Date.now();
                const timeDiff = (now - lastTimestamp) / 1000;
                const bytesDiff = data.bytesSent - lastBytesSent;
                if (lastBytesSent > 0 && timeDiff > 0) {
                  bandwidthSpan.textContent = this.formatBandwidth(bytesDiff / timeDiff);
                } else {
                  bandwidthSpan.textContent = data.bytesSentFormatted || '--';
                }
                lastBytesSent = data.bytesSent;
                lastTimestamp = now;
              }
            } catch (e) { /* silent */ }
          };

          this.startAdaptivePolling(popupData, updateStats);
        }
      },
      onError: (data) => {
        Logger.error('[HLS] Fatal error:', data);
        frameContainer.classList.remove('loading', 'loaded');
        frameContainer.classList.add('error');
      }
    });

    popupData.hlsInstance = result;
  },

  /**
   * Toggle between HLS and WHEP stream protocols
   */
  async toggleStreamProtocol(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const camera = popupData.camera;
    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    const videoEl = popupEl.querySelector('.camera-video');

    if (!frameContainer || !videoEl) return;

    // Show loading state
    frameContainer.classList.remove('loaded', 'error');
    frameContainer.classList.add('loading');

    // Cleanup current stream
    if (popupData.mediaSessionCleanup) {
      popupData.mediaSessionCleanup();
      popupData.mediaSessionCleanup = null;
    }
    if (popupData.hlsInstance) {
      popupData.hlsInstance.destroy();
      popupData.hlsInstance = null;
    }
    if (popupData.peerConnection) {
      try { popupData.peerConnection.close(); } catch (e) {}
      popupData.peerConnection = null;
      if (videoEl.srcObject) {
        videoEl.srcObject.getTracks().forEach(t => t.stop());
        videoEl.srcObject = null;
      }
    }
    if (popupData.whepWatchdog) {
      clearInterval(popupData.whepWatchdog);
      popupData.whepWatchdog = null;
    }
    if (popupData.clockInterval) {
      clearInterval(popupData.clockInterval);
      popupData.clockInterval = null;
    }

    const currentMode = popupData.streamMode || 'hls';

    if (currentMode === 'hls' && camera.whep_url) {
      // Switch to WHEP
      popupData.streamMode = 'whep';
      const protocolLabel = popupEl.querySelector('.protocol-label');
      if (protocolLabel) protocolLabel.textContent = 'LIVE';
      const protocolBtn = popupEl.querySelector('.protocol-toggle-btn');
      if (protocolBtn) {
        protocolBtn.classList.add('active');
        protocolBtn.title = 'HLS Moduna Dön';
      }
      await this.startWhepStream(deviceId, camera.whep_url);
    } else if (camera.hls_url) {
      // Switch to HLS
      await this.startHlsPlayback(deviceId, camera.hls_url);
    }
  },

  async applyResolutionClass(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;

    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;

    const frameContainer = popupEl.querySelector('.camera-frame-container');
    if (!frameContainer) return;

    // Remove any existing resolution classes
    frameContainer.classList.remove('res-720', 'res-1080', 'res-1440', 'res-2160');

    // City cameras use city-cam class (640x360 → 1280x720), skip resolution class
    if (popupData.isCity) {
      popupData.resolution = 720;
      Logger.log(`[Popup] City camera ${deviceId} — using city-cam class`);
      return;
    }

    try {
      // Fetch camera settings to get resolution
      const response = await fetch(`${this.apiSettings}/${deviceId}`);
      if (!response.ok) return;

      const data = await response.json();
      const resolution = data.settings?.stream_resolution || 720;

      // Add the resolution class
      frameContainer.classList.add(`res-${resolution}`);

      // Store resolution in popup data for reference
      popupData.resolution = resolution;

      Logger.log(`[Popup] Applied resolution class: res-${resolution} for ${deviceId}`);
    } catch (error) {
      Logger.warn('[Popup] Could not fetch resolution setting:', error.message);
      // Default to 720p if fetch fails
      frameContainer.classList.add('res-720');
    }
  }
};

export { StreamingMixin };
