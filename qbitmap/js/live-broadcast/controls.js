import { Logger } from '../utils.js';
import { AuthSystem } from '../auth.js';
import { applyAutofocus, saveCameraId } from '../video-message/media.js';

const ControlsMixin = {
  // ==================== Camera Switch ====================

  async switchCamera() {
    if (!this.isBroadcasting || !this.peerConnection || !this.mediaStream) return;
    if (this.broadcastRecording) {
      if (typeof AuthSystem !== 'undefined') AuthSystem.showNotification('Kayıt sırasında kamera değiştirilemez', 'error');
      return;
    }

    const switchBtn = this._cameraSwitchBtn;
    if (switchBtn) switchBtn.disabled = true;

    try {
      const newMode = this.currentFacingMode === 'environment' ? 'user' : 'environment';
      const videoBase = {
        width: { ideal: this.currentResolution.width },
        height: { ideal: this.currentResolution.height },
        frameRate: { ideal: 24 },
        focusMode: { ideal: 'continuous' }
      };

      // Stop old video track first — some devices can't open two cameras at once
      const oldVideoTrack = this.mediaStream.getVideoTracks()[0];
      if (oldVideoTrack) {
        oldVideoTrack.stop();
        this.mediaStream.removeTrack(oldVideoTrack);
      }

      let newStream;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { ...videoBase, facingMode: { exact: newMode } }, audio: false
        });
      } catch {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { ...videoBase, facingMode: { ideal: newMode } }, audio: false
        });
      }
      applyAutofocus(newStream);

      const newVideoTrack = newStream.getVideoTracks()[0];

      const sender = this.peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
      }

      this.mediaStream.addTrack(newVideoTrack);

      this.currentFacingMode = newMode;
      saveCameraId(newVideoTrack.getSettings()?.deviceId);
      Logger.log('[LiveBroadcast] Camera switched to', newMode);

    } catch (error) {
      Logger.error('[LiveBroadcast] Camera switch failed:', error);
      AuthSystem.showNotification('Kamera değiştirilemedi', 'error');
    } finally {
      if (switchBtn) switchBtn.disabled = false;
    }
  },

  showCameraSwitchButton() {
    if (this._cameraSwitchBtn) return;

    const btn = document.createElement('button');
    btn.className = 'mic-button-right';
    btn.id = 'camera-switch-button';
    btn.title = 'Kamerayı Değiştir';
    btn.setAttribute('aria-label', 'Kamerayı değiştir');
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="1 4 1 10 7 10"/>
        <polyline points="23 20 23 14 17 14"/>
        <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10"/>
        <path d="M3.51 15A9 9 0 0 0 18.36 18.36L23 14"/>
      </svg>
    `;
    btn.addEventListener('click', () => this.switchCamera());
    this._cameraSwitchBtn = btn;

    const floatContainer = document.getElementById('broadcast-float-controls');
    if (floatContainer) {
      floatContainer.appendChild(btn);
    } else {
      const broadcastBtn = document.getElementById('broadcast-button');
      if (broadcastBtn && broadcastBtn.parentNode) {
        broadcastBtn.parentNode.insertBefore(btn, broadcastBtn.nextSibling);
      }
    }
  },

  hideCameraSwitchButton() {
    if (this._cameraSwitchBtn) {
      this._cameraSwitchBtn.remove();
      this._cameraSwitchBtn = null;
    }
  },

  // ==================== Recording ====================

  async toggleBroadcastRecording(btn) {
    if (this.broadcastRecording) {
      await this.stopBroadcastRecordingAction(btn);
    } else {
      await this.startBroadcastRecordingAction(btn);
    }
  },

  async startBroadcastRecordingAction(btn) {
    try {
      const response = await fetch(`${this.apiBase}/recording/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Recording start failed');
      }

      this.broadcastRecording = true;
      if (btn) btn.classList.add('recording');
      Logger.log('[Recording] Broadcast recording started');
    } catch (error) {
      Logger.error('[Recording] Start error:', error);
      AuthSystem.showNotification(error.message || 'Kayıt başlatılamadı', 'error');
    }
  },

  async stopBroadcastRecordingAction(btn) {
    try {
      await fetch(`${this.apiBase}/recording/stop`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });

      this.broadcastRecording = false;
      if (btn) btn.classList.remove('recording');
      Logger.log('[Recording] Broadcast recording stopped');
    } catch (error) {
      Logger.error('[Recording] Stop error:', error);
    }
  },

  async checkBroadcastRecordingStatus(btn) {
    try {
      const response = await fetch(`${this.apiBase}/recording/status`, {
        credentials: 'include'
      });
      if (!response.ok) return;

      const data = await response.json();
      if (data.isRecording) {
        this.broadcastRecording = true;
        if (btn) btn.classList.add('recording');
      }
    } catch (e) {
      // ignore
    }
  },

  // ==================== Resolution Selector ====================

  showResolutionButton() {
    if (this._resolutionBtn) return;

    const btn = document.createElement('button');
    btn.className = 'mic-button-right';
    btn.id = 'resolution-button';
    btn.title = 'Çözünürlük';
    btn.setAttribute('aria-label', 'Çözünürlük değiştir');
    btn.textContent = this.currentResolution.label;
    btn.style.fontSize = '11px';
    btn.style.fontWeight = '700';
    btn.addEventListener('click', () => this.toggleResolutionDropdown());
    this._resolutionBtn = btn;

    const floatContainer = document.getElementById('broadcast-float-controls');
    if (floatContainer) {
      floatContainer.appendChild(btn);
    } else {
      const switchBtn = this._cameraSwitchBtn;
      if (switchBtn && switchBtn.parentNode) {
        switchBtn.parentNode.insertBefore(btn, switchBtn.nextSibling);
      }
    }
  },

  hideResolutionButton() {
    this.closeResolutionDropdown();
    if (this._resolutionBtn) {
      this._resolutionBtn.remove();
      this._resolutionBtn = null;
    }
  },

  toggleResolutionDropdown(anchorBtn) {
    const existing = document.getElementById('resolution-dropdown');
    if (existing) {
      this.closeResolutionDropdown();
      return;
    }

    const btn = anchorBtn || this._resolutionBtn;
    if (!btn) return;

    const dropdown = document.createElement('div');
    dropdown.id = 'resolution-dropdown';
    dropdown.style.cssText = 'position:fixed;background:rgba(20,20,30,0.95);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:4px;z-index:1000;min-width:80px;backdrop-filter:blur(10px);';

    for (const res of this.RESOLUTIONS) {
      const item = document.createElement('div');
      item.textContent = res.label;
      const isActive = res.label === this.currentResolution.label;
      item.style.cssText = `padding:10px 16px;cursor:pointer;border-radius:4px;font-size:14px;font-weight:600;color:${isActive ? '#4a9eff' : '#ccc'};text-align:center;min-height:44px;display:flex;align-items:center;justify-content:center;`;
      item.onmouseenter = () => { if (!isActive) item.style.background = 'rgba(255,255,255,0.1)'; };
      item.onmouseleave = () => { item.style.background = 'transparent'; };
      item.addEventListener('touchstart', () => { if (!isActive) item.style.background = 'rgba(255,255,255,0.1)'; }, { passive: true });
      item.addEventListener('touchend', () => { item.style.background = 'transparent'; }, { passive: true });
      item.onclick = () => {
        this.changeResolution(res);
        this.closeResolutionDropdown();
      };
      dropdown.appendChild(item);
    }

    document.body.appendChild(dropdown);

    const btnRect = btn.getBoundingClientRect();
    const dropdownHeight = dropdown.offsetHeight;
    const spaceBelow = window.innerHeight - btnRect.bottom;
    const centerX = btnRect.left + btnRect.width / 2 - dropdown.offsetWidth / 2;

    if (spaceBelow >= dropdownHeight + 6) {
      dropdown.style.top = (btnRect.bottom + 6) + 'px';
    } else {
      dropdown.style.top = (btnRect.top - dropdownHeight - 6) + 'px';
    }
    dropdown.style.left = Math.max(4, Math.min(centerX, window.innerWidth - dropdown.offsetWidth - 4)) + 'px';

    this._resolutionOutsideClick = (e) => {
      if (!btn.contains(e.target)) this.closeResolutionDropdown();
    };
    setTimeout(() => document.addEventListener('click', this._resolutionOutsideClick), 0);
  },

  closeResolutionDropdown() {
    const dropdown = document.getElementById('resolution-dropdown');
    if (dropdown) dropdown.remove();
    if (this._resolutionOutsideClick) {
      document.removeEventListener('click', this._resolutionOutsideClick);
      this._resolutionOutsideClick = null;
    }
  },

  async changeResolution(res) {
    if (res.label === this.currentResolution.label) return;
    if (!this.isBroadcasting || !this.peerConnection || !this.mediaStream) return;

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: res.width },
          height: { ideal: res.height },
          frameRate: { ideal: 24 },
          facingMode: { ideal: this.currentFacingMode },
          focusMode: { ideal: 'continuous' }
        },
        audio: false
      });
      applyAutofocus(newStream);

      const newVideoTrack = newStream.getVideoTracks()[0];

      const sender = this.peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
      }

      const oldVideoTrack = this.mediaStream.getVideoTracks()[0];
      if (oldVideoTrack) {
        oldVideoTrack.stop();
        this.mediaStream.removeTrack(oldVideoTrack);
      }
      this.mediaStream.addTrack(newVideoTrack);

      this.currentResolution = res;
      const popupResBtn = this.currentPopup?.getElement()?.querySelector('.broadcast-res-btn span');
      if (popupResBtn) popupResBtn.textContent = res.label;

      Logger.log('[LiveBroadcast] Resolution changed to', res.label);
    } catch (error) {
      Logger.error('[LiveBroadcast] Resolution change failed:', error);
      AuthSystem.showNotification('Çözünürlük değiştirilemedi', 'error');
    }
  },
};

export { ControlsMixin };
