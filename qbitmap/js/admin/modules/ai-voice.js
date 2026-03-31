import { QBitmapConfig } from '../../config.js';

export const AiVoiceMixin = {
  async loadAiSettings() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/settings`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load settings');
      const data = await response.json();
      const settings = data.settings || [];
      const getSetting = (key) => settings.find(s => s.key === key)?.value || '';

      document.getElementById('ai-service-url').value = getSetting('ai_service_url');
      document.getElementById('ai-vision-model').value = getSetting('ai_vision_model');
      document.getElementById('ai-monitoring-prompt').value = getSetting('ai_monitoring_prompt') || this.getDefaultMonitoringPrompt();
      document.getElementById('ai-search-prompt').value = getSetting('ai_search_prompt') || 'bu resimde ne görüyorsun maksimum birkaç cümle ile açıkla ve sadece emin olduklarını yaz';
      document.getElementById('ai-max-tokens').value = getSetting('ai_max_tokens') || '1024';
      document.getElementById('ai-temperature').value = getSetting('ai_temperature') || '0.7';
      document.getElementById('ai-broadcast-interval').value = getSetting('ai_broadcast_interval') || '3000';
      document.getElementById('ai-broadcast-prompt').value = getSetting('ai_broadcast_prompt') || '';
    } catch (error) {
      console.error('[Admin] Failed to load AI settings:', error);
      this.showToast('Failed to load AI settings', 'error');
    }
  },

  async loadVoiceSettings() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/settings`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load settings');
      const data = await response.json();
      const settings = data.settings || [];
      const getSetting = (key) => settings.find(s => s.key === key)?.value || '';

      const vd = QBitmapConfig.voiceDefaults;
      document.getElementById('voice-api-url').value = getSetting('voice_api_url') || '';
      document.getElementById('voice-room-id').value = getSetting('voice_room_id') || '';
      document.getElementById('voice-target-user').value = getSetting('voice_target_user') || '';
      document.getElementById('voice-sample-type').value = getSetting('voice_sample_type') || vd.sampleType;
      document.getElementById('voice-cooldown').value = getSetting('voice_cooldown') || vd.cooldown;
      document.getElementById('voice-auto-hangup').value = getSetting('voice_auto_hangup') || vd.autoHangup;
      document.getElementById('voice-call-timeout').value = getSetting('voice_call_timeout') || vd.callTimeout;
    } catch (error) {
      console.error('[Admin] Failed to load voice settings:', error);
      this.showToast('Failed to load voice settings', 'error');
    }
  },

  async saveAiSettings() {
    const aiServiceUrl = document.getElementById('ai-service-url').value.trim();
    const aiVisionModel = document.getElementById('ai-vision-model').value.trim();
    const aiMonitoringPrompt = document.getElementById('ai-monitoring-prompt').value.trim();
    const aiSearchPrompt = document.getElementById('ai-search-prompt').value.trim();
    const aiMaxTokens = document.getElementById('ai-max-tokens').value.trim();
    const aiTemperature = document.getElementById('ai-temperature').value.trim();
    const aiBroadcastInterval = document.getElementById('ai-broadcast-interval').value.trim();
    const aiBroadcastPrompt = document.getElementById('ai-broadcast-prompt').value.trim();
    const statusEl = document.getElementById('ai-save-status');

    if (!aiServiceUrl || !aiVisionModel) { this.showToast('Service URL and Model are required', 'error'); return; }

    statusEl.textContent = 'Saving...';
    statusEl.className = 'save-status saving';

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          ai_service_url: aiServiceUrl, ai_vision_model: aiVisionModel,
          ai_monitoring_prompt: aiMonitoringPrompt, ai_search_prompt: aiSearchPrompt,
          ai_max_tokens: aiMaxTokens, ai_temperature: aiTemperature,
          ai_broadcast_interval: aiBroadcastInterval, ai_broadcast_prompt: aiBroadcastPrompt
        })
      });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Failed to save settings'); }
      statusEl.textContent = 'Saved!'; statusEl.className = 'save-status success';
      this.showToast('AI settings saved', 'success');
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'save-status'; }, 3000);
    } catch (error) {
      console.error('[Admin] Failed to save AI settings:', error);
      statusEl.textContent = 'Error!'; statusEl.className = 'save-status error';
      this.showToast(error.message, 'error');
    }
  },

  async saveVoiceSettings() {
    const apiUrl = document.getElementById('voice-api-url').value.trim();
    const roomId = document.getElementById('voice-room-id').value.trim();
    const targetUser = document.getElementById('voice-target-user').value.trim();
    const sampleType = document.getElementById('voice-sample-type').value;
    const cooldown = document.getElementById('voice-cooldown').value;
    const autoHangup = document.getElementById('voice-auto-hangup').value;
    const callTimeout = document.getElementById('voice-call-timeout').value;
    const statusEl = document.getElementById('voice-save-status');

    if (!apiUrl || !roomId || !targetUser) { this.showToast('API URL, Room ID and Target User are required', 'error'); return; }

    statusEl.textContent = 'Saving...'; statusEl.className = 'save-status saving';

    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          voice_api_url: apiUrl, voice_room_id: roomId, voice_target_user: targetUser,
          voice_sample_type: sampleType, voice_cooldown: cooldown,
          voice_auto_hangup: autoHangup, voice_call_timeout: callTimeout
        })
      });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Failed to save settings'); }
      statusEl.textContent = 'Saved!'; statusEl.className = 'save-status success';
      this.showToast('Voice settings saved', 'success');
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'save-status'; }, 3000);
    } catch (error) {
      console.error('[Admin] Failed to save voice settings:', error);
      statusEl.textContent = 'Error!'; statusEl.className = 'save-status error';
      this.showToast(error.message, 'error');
    }
  },

  getDefaultMonitoringPrompt() {
    return `Sen bir acil durum algılama asistanısın. Sana verilen görüntüyü analiz et ve sadece JSON formatında yanıt ver.

Tespit etmen gereken durumlar:
- Düşmüş kişi (yerde yatan, bilinçsiz görünen)
- Yangın veya duman
- Kavga veya şiddet
- Panik hali veya kaçış
- Tıbbi acil durum belirtileri

JSON formatı:
{
  "alarm": true/false,
  "confidence": 0-100,
  "tasvir": "kısa açıklama"
}

Önemli:
- Normal aktiviteler için alarm: false
- Sadece gerçek acil durumlar için alarm: true
- Emin değilsen düşük confidence ver
- Yanıt SADECE JSON olmalı, başka metin yok`;
  },
};
