import { QBitmapConfig } from "../../config.js";
import { Logger } from "../../utils.js";
import { AuthSystem } from "../../auth.js";

const VoiceCallMixin = {
  async loadVoiceCallState(deviceId, voiceBtn) {
    try {
      // Check if user is logged in via AuthSystem
      if (!AuthSystem.isLoggedIn()) {
        // Show button but mark as unauthorized
        voiceBtn.dataset.authorized = 'false';
        voiceBtn.title = 'Sesli Arama (Giriş yapın)';
        voiceBtn.style.opacity = '0.5';
        return;
      }

      const response = await fetch(`${QBitmapConfig.api.public}/cameras/${deviceId}/voice-call`, {
        credentials: 'include'
      });

      if (!response.ok) {
        if (response.status === 403) {
          // User doesn't own this camera
          voiceBtn.dataset.authorized = 'false';
          voiceBtn.title = 'Sesli Arama (Yetkiniz yok)';
          voiceBtn.style.opacity = '0.5';
        }
        return;
      }

      voiceBtn.dataset.authorized = 'true';
      const data = await response.json();
      this.updateVoiceButtonState(voiceBtn, data.voiceCallEnabled);

    } catch (error) {
      Logger.error('[VoiceCall] Load state error:', error);
    }
  },

  /**
   * Toggle voice call enabled state
   */
  async toggleVoiceCall(deviceId, voiceBtn) {
    try {
      // Check if user is logged in via AuthSystem
      if (!AuthSystem.isLoggedIn()) {
        alert('Bu özellik için giriş yapmanız gerekiyor.');
        return;
      }

      // Check authorization
      if (voiceBtn.dataset.authorized === 'false') {
        alert('Bu kamera için sesli arama yetkiniz yok.');
        return;
      }

      // Get current state from button class
      const currentEnabled = voiceBtn.classList.contains('active');
      const newEnabled = !currentEnabled;

      // Optimistic UI update
      this.updateVoiceButtonState(voiceBtn, newEnabled);

      const response = await fetch(`${QBitmapConfig.api.public}/cameras/${deviceId}/voice-call`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ enabled: newEnabled })
      });

      if (!response.ok) {
        // Revert on error
        this.updateVoiceButtonState(voiceBtn, currentEnabled);
        const error = await response.json().catch(() => ({}));
        alert(error.error || 'Sesli arama ayarı güncellenemedi.');
        return;
      }

      const data = await response.json();
      Logger.log('[VoiceCall] State updated:', data.voiceCallEnabled);

    } catch (error) {
      Logger.error('[VoiceCall] Toggle error:', error);
      alert('Sesli arama ayarı güncellenemedi.');
    }
  },

  /**
   * Update voice button visual state
   */
  updateVoiceButtonState(voiceBtn, enabled) {
    if (enabled) {
      voiceBtn.classList.add('active');
      voiceBtn.title = 'Sesli Arama (Açık)';
    } else {
      voiceBtn.classList.remove('active');
      voiceBtn.title = 'Sesli Arama (Kapalı)';
    }
  },

  /**
   * Apply resolution class to camera popup frame container
   * Reads stream_resolution from camera settings and applies res-{resolution} class
   * City cameras always use res-1080 (480x270 → 960x540 → 1920x1080)
   */
};

export { VoiceCallMixin };
