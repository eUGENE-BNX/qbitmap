const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'voice-call' });
const db = require('./database');

/**
 * Voice Call Service - Matrix integration for ONVIF events
 * Uses Entangle Matrix API for initiating voice calls
 * Settings are read from database (configurable via admin panel)
 */
class VoiceCallService {
  constructor() {
    this.apiToken = process.env.ENTANGLE_API_TOKEN || '';

    // Cooldown tracking for ONVIF events: deviceId -> lastCallTime
    this.cooldowns = new Map();

    // Separate cooldown tracking for face detection: deviceId -> lastCallTime
    this.faceCooldowns = new Map();

    // Periodic cleanup of expired cooldowns to prevent memory leak
    this._cleanupInterval = setInterval(() => {
      this.cleanupExpiredCooldowns();
    }, 60000); // Clean every minute
  }

  // ==================== SETTINGS GETTERS (from database) ====================

  async getBaseUrl() {
    return (await db.getSystemSetting('voice_api_url')) || 'http://91.98.131.74:8000';
  }

  async getRoomId() {
    return (await db.getSystemSetting('voice_room_id')) || '!DMOAJwitQWHheVdNpI:entangle.reserve.network';
  }

  async getTargetUser() {
    return (await db.getSystemSetting('voice_target_user')) || '@callbot:entangle.reserve.network';
  }

  async getDefaultSampleType() {
    return (await db.getSystemSetting('voice_sample_type')) || 'human';
  }

  async getCooldownMs() {
    const seconds = parseInt((await db.getSystemSetting('voice_cooldown')) || '30', 10);
    return seconds * 1000;
  }

  async getAutoHangup() {
    return (await db.getSystemSetting('voice_auto_hangup')) || '30000';
  }

  async getCallTimeout() {
    return (await db.getSystemSetting('voice_call_timeout')) || '60000';
  }

  // ==================== COOLDOWN MANAGEMENT ====================

  /**
   * Remove expired cooldowns from the Map to prevent memory leak
   */
  async cleanupExpiredCooldowns() {
    if (this.cooldowns.size === 0 && this.faceCooldowns.size === 0) return;
    const now = Date.now();
    const cooldownMs = await this.getCooldownMs();
    let cleanedCount = 0;

    // Clean ONVIF cooldowns
    for (const [deviceId, timestamp] of this.cooldowns.entries()) {
      if (now - timestamp > cooldownMs) {
        this.cooldowns.delete(deviceId);
        cleanedCount++;
      }
    }

    // Clean face detection cooldowns
    for (const [deviceId, timestamp] of this.faceCooldowns.entries()) {
      if (now - timestamp > cooldownMs) {
        this.faceCooldowns.delete(deviceId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug({ cleanedCount }, 'Cleaned up expired voice call cooldowns');
    }
  }

  /**
   * Check if a camera is in cooldown period
   */
  async isInCooldown(deviceId) {
    const lastCall = this.cooldowns.get(deviceId);
    if (!lastCall) return false;

    const elapsed = Date.now() - lastCall;
    return elapsed < (await this.getCooldownMs());
  }

  /**
   * Get remaining cooldown time in seconds
   */
  async getCooldownRemaining(deviceId) {
    const lastCall = this.cooldowns.get(deviceId);
    if (!lastCall) return 0;

    const elapsed = Date.now() - lastCall;
    const remaining = (await this.getCooldownMs()) - elapsed;
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  // ==================== FACE DETECTION COOLDOWN ====================

  /**
   * Check if a camera is in face detection cooldown period
   */
  async isInFaceCooldown(deviceId) {
    const lastCall = this.faceCooldowns.get(deviceId);
    if (!lastCall) return false;

    const elapsed = Date.now() - lastCall;
    return elapsed < (await this.getCooldownMs());
  }

  /**
   * Get remaining face cooldown time in seconds
   */
  async getFaceCooldownRemaining(deviceId) {
    const lastCall = this.faceCooldowns.get(deviceId);
    if (!lastCall) return 0;

    const elapsed = Date.now() - lastCall;
    const remaining = (await this.getCooldownMs()) - elapsed;
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  /**
   * Clear face cooldown for a device (for testing)
   */
  clearFaceCooldown(deviceId) {
    this.faceCooldowns.delete(deviceId);
  }

  // ==================== CALL INITIATION ====================

  /**
   * Core call method - shared logic for all voice call types
   * @param {object} opts
   * @param {string} opts.deviceId - Camera device ID
   * @param {string} opts.cameraName - Camera name for logging
   * @param {string} opts.sampleType - Voice sample type (fire, human, person)
   * @param {Map} opts.cooldownMap - Which cooldown map to use
   * @param {function} opts.isCooldownFn - Cooldown check function
   * @param {function} opts.getRemainingFn - Remaining cooldown function
   * @param {string} opts.logPrefix - Log prefix for context
   * @param {object} [opts.extraLogFields] - Extra fields for log messages
   * @param {object} [opts.extraResult] - Extra fields to add to success result
   * @returns {Promise<object>} Call result
   */
  async _makeCall({ deviceId, cameraName, sampleType, cooldownMap, isCooldownFn, getRemainingFn, logPrefix, extraLogFields = {}, extraResult = {} }) {
    // Check cooldown
    if (await isCooldownFn.call(this, deviceId)) {
      const remaining = await getRemainingFn.call(this, deviceId);
      logger.info({ deviceId, remaining, ...extraLogFields }, `${logPrefix} skipped - in cooldown`);
      return { success: false, reason: 'cooldown', remainingSeconds: remaining };
    }

    try {
      const [baseUrl, roomId, targetUser, autoHangup, callTimeout] = await Promise.all([
        this.getBaseUrl(), this.getRoomId(), this.getTargetUser(), this.getAutoHangup(), this.getCallTimeout()
      ]);

      logger.info({ deviceId, cameraName, baseUrl, ...extraLogFields }, `Initiating ${logPrefix}`);

      const formData = new URLSearchParams();
      formData.append('room_id', roomId);
      formData.append('target_user', targetUser);
      formData.append('sample_type', sampleType);
      formData.append('auto_hangup_after', autoHangup);
      formData.append('call_timeout', callTimeout);

      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (this.apiToken) {
        headers['Authorization'] = `Bearer ${this.apiToken}`;
      }

      const response = await fetchWithTimeout(`${baseUrl}/api/v1/matrix/voice-call/initiate`, {
        method: 'POST',
        headers,
        body: formData.toString()
      }, 15000);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        logger.error({ deviceId, status: response.status, error: errorText, ...extraLogFields }, `${logPrefix} API error`);
        return { success: false, reason: 'api_error', status: response.status, error: errorText };
      }

      const result = await response.json();
      cooldownMap.set(deviceId, Date.now());

      logger.info({ deviceId, cameraName, callId: result.data?.call_id, ...extraLogFields }, `${logPrefix} initiated successfully`);

      return {
        success: true,
        callId: result.data?.call_id,
        roomId: result.data?.room_id,
        state: result.data?.state,
        ...extraResult
      };

    } catch (error) {
      logger.error({ err: error, deviceId, cameraName, ...extraLogFields }, `${logPrefix} failed`);
      return { success: false, reason: 'exception', error: error.message };
    }
  }

  /**
   * Initiate a voice call via Matrix (ONVIF events)
   * @param {string} deviceId - Camera device ID
   * @param {string} cameraName - Camera name for logging
   * @param {string} eventType - Event type (motion, human, etc.)
   * @returns {Promise<object>} Call result
   */
  async initiateCall(deviceId, cameraName, eventType) {
    // Determine sample type based on event
    // API accepts: fire, human, person (lowercase)
    let sampleType = await this.getDefaultSampleType();
    if (eventType === 'human') sampleType = 'human';
    else if (eventType === 'fire') sampleType = 'fire';

    return this._makeCall({
      deviceId, cameraName, sampleType,
      cooldownMap: this.cooldowns,
      isCooldownFn: this.isInCooldown,
      getRemainingFn: this.getCooldownRemaining,
      logPrefix: 'voice call',
      extraLogFields: { eventType }
    });
  }

  /**
   * Clear cooldown for a device (for testing)
   */
  clearCooldown(deviceId) {
    this.cooldowns.delete(deviceId);
  }

  /**
   * Initiate a voice call for face detection
   * Uses separate cooldown from ONVIF events
   * @param {string} deviceId - Camera device ID
   * @param {string} cameraName - Camera name for logging
   * @param {string} faceName - Name of the detected face
   * @returns {Promise<object>} Call result
   */
  async initiateCallForFace(deviceId, cameraName, faceName) {
    return this._makeCall({
      deviceId, cameraName,
      sampleType: 'person',
      cooldownMap: this.faceCooldowns,
      isCooldownFn: this.isInFaceCooldown,
      getRemainingFn: this.getFaceCooldownRemaining,
      logPrefix: 'face voice call',
      extraLogFields: { faceName },
      extraResult: { triggerType: 'face_detection', faceName }
    });
  }

  /**
   * Shutdown - clear cleanup interval for graceful exit
   */
  shutdown() {
    if (this._cleanupInterval) clearInterval(this._cleanupInterval);
  }

  /**
   * Health check for Matrix API
   */
  async healthCheck() {
    try {
      const baseUrl = await this.getBaseUrl();
      const response = await fetchWithTimeout(`${baseUrl}/api/health`, {}, 5000);
      return response.ok;
    } catch (error) {
      logger.error({ err: error }, 'Matrix API health check failed');
      return false;
    }
  }
}

module.exports = new VoiceCallService();
