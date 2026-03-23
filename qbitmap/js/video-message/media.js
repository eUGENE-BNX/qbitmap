import { Logger } from "../utils.js";

const MediaMixin = {
  _applyVideoOrientation(container, stream, videoEl) {
    if (!container) return;

    const apply = () => {
      let w, h;
      if (videoEl && videoEl.videoWidth) {
        w = videoEl.videoWidth;
        h = videoEl.videoHeight;
      } else if (stream) {
        const track = stream.getVideoTracks()[0];
        if (track) {
          const s = track.getSettings();
          w = s.width;
          h = s.height;
        }
      }
      if (!w || !h) return;

      // On mobile landscape, camera may still report portrait dimensions
      // but the browser rotates the display. Swap to match device orientation.
      const isDeviceLandscape = window.innerWidth > window.innerHeight;
      if (isDeviceLandscape && h > w) {
        [w, h] = [h, w];
      }

      const isPortrait = h > w;
      const isMobileLandscape = isDeviceLandscape && window.innerHeight <= 500;

      container.style.aspectRatio = `${w} / ${h}`;
      container.classList.toggle('vmsg-portrait', isPortrait);

      if (isMobileLandscape) {
        // Mobile landscape: height is the constraint, width follows from aspect-ratio
        container.style.maxWidth = 'none';
        container.style.width = 'auto';
        container.style.height = 'calc(100vh - 16px)';
      } else {
        container.style.height = '';
        container.style.width = '';
        if (isPortrait) {
          container.style.maxWidth = `min(360px, calc((100vh - 120px) * ${w} / ${h}))`;
        } else {
          container.style.maxWidth = `min(640px, calc((100vh - 120px) * ${w} / ${h}))`;
        }
      }
    };

    // Try immediate detection from track settings
    if (stream) {
      const track = stream.getVideoTracks()[0];
      if (track) {
        const s = track.getSettings();
        if (s.width && s.height) apply();
      }
    }
    // Backup: detect from video element metadata
    if (videoEl) {
      videoEl.addEventListener('loadedmetadata', apply, { once: true });
    }

    // Listen for device orientation changes (resize)
    if (this._orientationHandler) {
      window.removeEventListener('resize', this._orientationHandler);
    }
    this._orientationHandler = apply;
    window.addEventListener('resize', apply);
  },

  // ==================== CAMERA SWITCH ====================

  async switchCamera() {
    if (!this.mediaStream || this.isRecording) return;

    try {
      const newMode = this.currentFacingMode === 'user' ? 'environment' : 'user';

      const rawStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: this.RESOLUTION.width },
          height: { ideal: this.RESOLUTION.height },
          aspectRatio: { ideal: 16 / 9 },
          frameRate: { ideal: 25, max: 25 },
          facingMode: { exact: newMode }
        },
        audio: true
      });

      // Stop old stream, raw audio track and audio context
      this.mediaStream.getTracks().forEach(t => t.stop());
      if (this._rawAudioTrack) { this._rawAudioTrack.stop(); this._rawAudioTrack = null; }
      if (this._audioCtx) { this._audioCtx.close().catch(() => {}); this._audioCtx = null; }
      this.mediaStream = this._processAudio(rawStream);
      this.currentFacingMode = newMode;

      // Update video preview
      const video = this._modalEl?.querySelector('#vmsg-preview-video');
      if (video) video.srcObject = this.mediaStream;

      // Re-detect orientation for new camera
      const container = this._modalEl?.querySelector('#vmsg-video-container');
      this._applyVideoOrientation(container, this.mediaStream, video);

      Logger.log('[VideoMessage] Camera switched to', newMode);
    } catch (error) {
      Logger.error('[VideoMessage] Camera switch failed:', error);
      AuthSystem.showNotification('Kamera değiştirilemedi', 'error');
    }
  },

  // ==================== CAMERA ENUMERATION ====================

  async _enumerateCameras() {
    try {
      // First enumerate with current permission
      let devices = await navigator.mediaDevices.enumerateDevices();
      let cameras = devices.filter(d => d.kind === 'videoinput');

      // If we only see ≤2 cameras, try unlocking more by briefly requesting
      // the opposite facingMode (some devices hide cameras until both are accessed)
      if (cameras.length <= 2) {
        const oppositeMode = this.currentFacingMode === 'user' ? 'environment' : 'user';
        try {
          const tempStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { exact: oppositeMode } }
          });
          tempStream.getTracks().forEach(t => t.stop());
          // Re-enumerate after unlocking
          devices = await navigator.mediaDevices.enumerateDevices();
          cameras = devices.filter(d => d.kind === 'videoinput');
        } catch (e) {
          // Ignore — opposite camera might not exist
        }
      }

      this._cameras = cameras;
      Logger.log('[VideoMessage] Found', this._cameras.length, 'cameras');
    } catch (e) {
      Logger.warn('[VideoMessage] enumerateDevices failed:', e);
      this._cameras = [];
    }
  },

  _getCameraLabel(device, index) {
    const label = (device.label || '').toLowerCase();
    if (label.includes('front') || label.includes('user') || label.includes('facing front')) return 'Ön Kamera';
    if (label.includes('wide') || label.includes('ultra')) return 'Geniş Açı';
    if (label.includes('tele')) return 'Telefoto';
    if (label.includes('back') || label.includes('environment') || label.includes('facing back') || label.includes('rear')) return 'Arka Kamera';
    if (device.label) return device.label.substring(0, 20);
    return `Kamera ${index + 1}`;
  },

  _showCameraDropdown() {
    // Remove existing dropdown
    const existing = this._modalEl?.querySelector('.vmsg-camera-dropdown');
    if (existing) { existing.remove(); return; }

    if (!this._cameras || this._cameras.length < 2) return;

    const btn = this._modalEl?.querySelector('#vmsg-switch-cam');
    if (!btn) return;

    const dropdown = document.createElement('div');
    dropdown.className = 'vmsg-camera-dropdown';

    this._cameras.forEach((cam, i) => {
      const opt = document.createElement('div');
      opt.className = 'vmsg-camera-option';
      if (cam.deviceId === this._selectedCameraId) opt.classList.add('active');
      opt.textContent = this._getCameraLabel(cam, i);
      opt.onclick = (e) => {
        e.stopPropagation();
        dropdown.remove();
        if (cam.deviceId !== this._selectedCameraId) {
          this._switchToCamera(cam.deviceId);
        }
      };
      dropdown.appendChild(opt);
    });

    // Position relative to the button's parent
    const parent = btn.parentElement;
    parent.style.position = 'relative';
    parent.appendChild(dropdown);

    // Close on outside click
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && e.target !== btn) {
        dropdown.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  },

  async _switchToCamera(deviceId) {
    if (!this.mediaStream) return;

    try {
      const rawStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: this.RESOLUTION.width },
          height: { ideal: this.RESOLUTION.height },
          aspectRatio: { ideal: 16 / 9 },
          frameRate: { ideal: 25, max: 25 }
        },
        audio: true
      });

      // Stop old stream and audio context
      this.mediaStream.getTracks().forEach(t => t.stop());
      if (this._rawAudioTrack) { this._rawAudioTrack.stop(); this._rawAudioTrack = null; }
      if (this._audioCtx) { this._audioCtx.close().catch(() => {}); this._audioCtx = null; }
      this.mediaStream = this._processAudio(rawStream);
      this._selectedCameraId = deviceId;

      // Update facing mode from new track
      const settings = this.mediaStream.getVideoTracks()[0]?.getSettings();
      if (settings?.facingMode) this.currentFacingMode = settings.facingMode;

      // Update video preview
      const video = this._modalEl?.querySelector('#vmsg-preview-video');
      if (video) video.srcObject = this.mediaStream;

      const container = this._modalEl?.querySelector('#vmsg-video-container');
      this._applyVideoOrientation(container, this.mediaStream, video);

      Logger.log('[VideoMessage] Switched to camera:', deviceId);
    } catch (error) {
      Logger.error('[VideoMessage] Camera switch failed:', error);
      AuthSystem.showNotification('Kamera değiştirilemedi', 'error');
    }
  },

  // ==================== AUDIO PROCESSING ====================

  _processAudio(rawStream) {
    // Web Audio API: force mono downmix + resample to 22050 Hz
    // - getUserMedia constraints for sampleRate/channelCount are NOT enforced by browsers
    // - Opus codec (WebM) always reports 48kHz regardless of input, so we prefer MP4/AAC
    // - MediaStreamAudioDestinationNode.channelCount is buggy; use explicit GainNode for mono
    try {
      const ctx = new AudioContext({ sampleRate: 22050 });
      Logger.log('[VideoMessage] AudioContext created, actual sampleRate:', ctx.sampleRate);

      const source = ctx.createMediaStreamSource(rawStream);

      // Force mono through a GainNode (more reliable than dest.channelCount)
      const mono = ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';
      mono.gain.value = 1;

      const dest = ctx.createMediaStreamDestination();

      source.connect(mono);
      mono.connect(dest);

      // Combine original video track with processed audio track
      const videoTrack = rawStream.getVideoTracks()[0];
      const processedAudio = dest.stream.getAudioTracks()[0];
      const combined = new MediaStream([videoTrack, processedAudio]);

      const audioSettings = processedAudio.getSettings ? processedAudio.getSettings() : {};
      Logger.log('[VideoMessage] Processed audio track settings:', JSON.stringify(audioSettings));

      // Store for cleanup
      this._audioCtx = ctx;
      this._rawAudioTrack = rawStream.getAudioTracks()[0];

      return combined;
    } catch (e) {
      Logger.warn('[VideoMessage] Audio processing failed, using raw stream:', e);
      return rawStream;
    }
  },

  // ==================== CODEC DETECTION ====================

  getPreferredMimeType() {
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  },
};

export { MediaMixin };
