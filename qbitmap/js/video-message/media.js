import { Logger } from "../utils.js";

const CAMERA_PREF_KEY = 'qbitmap_preferred_camera';

function getSavedCameraId() {
  try { return localStorage.getItem(CAMERA_PREF_KEY); } catch { return null; }
}

function saveCameraId(deviceId) {
  try { if (deviceId) localStorage.setItem(CAMERA_PREF_KEY, deviceId); } catch {}
}

function applyAutofocus(stream) {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const caps = track.getCapabilities?.();
  if (caps?.focusMode?.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
}

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
          container.style.maxWidth = `min(252px, calc((100vh - 120px) * ${w} / ${h}))`;
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

    const newMode = this.currentFacingMode === 'user' ? 'environment' : 'user';
    const videoBase = {
      width: { ideal: this.RESOLUTION.width },
      height: { ideal: this.RESOLUTION.height },
      aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: 25, max: 25 },
      focusMode: { ideal: 'continuous' }
    };

    // Stop old stream first — some devices can't open two cameras at once
    this.mediaStream.getTracks().forEach(t => t.stop());
    if (this._rawAudioTrack) { this._rawAudioTrack.stop(); this._rawAudioTrack = null; }
    if (this._audioCtx) { this._audioCtx.close().catch(() => {}); this._audioCtx = null; }

    try {
      let rawStream;
      try {
        rawStream = await navigator.mediaDevices.getUserMedia({
          video: { ...videoBase, facingMode: { exact: newMode } }, audio: true
        });
      } catch {
        // exact failed, try ideal
        rawStream = await navigator.mediaDevices.getUserMedia({
          video: { ...videoBase, facingMode: { ideal: newMode } }, audio: true
        });
      }

      this.mediaStream = this._processAudio(rawStream);
      applyAutofocus(rawStream);
      this.currentFacingMode = newMode;
      this._selectedCameraId = rawStream.getVideoTracks()[0]?.getSettings()?.deviceId || null;
      saveCameraId(this._selectedCameraId);

      // Update video preview
      const video = this._modalEl?.querySelector('#vmsg-preview-video');
      if (video) video.srcObject = this.mediaStream;

      // Re-detect orientation for new camera
      const container = this._modalEl?.querySelector('#vmsg-video-container');
      this._applyVideoOrientation(container, this.mediaStream, video);

      Logger.log('[VideoMessage] Camera switched to', newMode);
    } catch (error) {
      Logger.error('[VideoMessage] Camera switch failed:', error);
      // Try to recover old camera
      try {
        const fallback = await navigator.mediaDevices.getUserMedia({
          video: { ...videoBase, facingMode: { ideal: this.currentFacingMode } }, audio: true
        });
        this.mediaStream = this._processAudio(fallback);
        const video = this._modalEl?.querySelector('#vmsg-preview-video');
        if (video) video.srcObject = this.mediaStream;
      } catch {
        // Complete failure
      }
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
      cameras.forEach((c, i) => Logger.log(`[Camera ${i}] ${c.label || 'no-label'} id=${c.deviceId.slice(0, 12)}`));
    } catch (e) {
      Logger.warn('[VideoMessage] enumerateDevices failed:', e);
      this._cameras = [];
    }
  },

  _getCameraLabel(device, index) {
    const label = (device.label || '').toLowerCase();
    // Check specific lens types first (before generic back/front)
    if (label.includes('macro')) return 'Macro';
    if (label.includes('ultrawide') || label.includes('ultra wide') || label.includes('ultra-wide')) return 'Ultra Geniş';
    if (label.includes('wide') && !label.includes('ultra')) return 'Geniş Açı';
    if (label.includes('tele')) return 'Telefoto';
    if (label.includes('front') || label.includes('user') || label.includes('facing front')) return 'Ön Kamera';
    if (label.includes('back') || label.includes('environment') || label.includes('facing back') || label.includes('rear')) return 'Arka Kamera';
    if (device.label) return device.label.substring(0, 25);
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

    // Header showing camera count
    const header = document.createElement('div');
    header.className = 'vmsg-camera-option';
    header.style.cssText = 'font-size:11px;opacity:0.6;pointer-events:none;padding:4px 10px';
    header.textContent = `${this._cameras.length} kamera bulundu`;
    dropdown.appendChild(header);

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

    const videoBase = {
      width: { ideal: this.RESOLUTION.width },
      height: { ideal: this.RESOLUTION.height },
      aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: 25, max: 25 },
      focusMode: { ideal: 'continuous' }
    };

    // Stop old stream first — some devices can't open two cameras at once
    const oldFacingMode = this.currentFacingMode;
    this.mediaStream.getTracks().forEach(t => t.stop());
    if (this._rawAudioTrack) { this._rawAudioTrack.stop(); this._rawAudioTrack = null; }
    if (this._audioCtx) { this._audioCtx.close().catch(() => {}); this._audioCtx = null; }

    try {
      const rawStream = await navigator.mediaDevices.getUserMedia({
        video: { ...videoBase, deviceId: { exact: deviceId } }, audio: true
      });

      this.mediaStream = this._processAudio(rawStream);
      applyAutofocus(rawStream);
      this._selectedCameraId = deviceId;
      saveCameraId(deviceId);

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
      // Try to recover old camera
      try {
        const fallback = await navigator.mediaDevices.getUserMedia({
          video: { ...videoBase, facingMode: { ideal: oldFacingMode } }, audio: true
        });
        this.mediaStream = this._processAudio(fallback);
        const video = this._modalEl?.querySelector('#vmsg-preview-video');
        if (video) video.srcObject = this.mediaStream;
      } catch {
        // Complete failure
      }
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

export { MediaMixin, applyAutofocus, getSavedCameraId, saveCameraId };
