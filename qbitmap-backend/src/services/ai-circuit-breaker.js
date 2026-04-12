/**
 * Circuit Breaker for vLLM AI service
 *
 * States:
 *  - CLOSED: normal operation, requests pass through
 *  - OPEN: service is down, all requests fail fast
 *  - HALF_OPEN: testing if service recovered (1 probe request)
 *
 * Transitions:
 *  CLOSED → OPEN: after failureThreshold consecutive failures
 *  OPEN → HALF_OPEN: after cooldown period
 *  HALF_OPEN → CLOSED: on success
 *  HALF_OPEN → OPEN: on failure (with increased cooldown)
 */

const logger = require('../utils/logger').child({ module: 'ai-circuit-breaker' });

const STATE = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

class AiCircuitBreaker {
  constructor(name = 'default') {
    this.name = name;
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.failureThreshold = 5;       // Open after 5 consecutive failures
    this.baseCooldownMs = 30000;     // 30s initial cooldown
    this.maxCooldownMs = 300000;     // 5 min max cooldown
    this.cooldownMs = this.baseCooldownMs;
    this.openedAt = null;
    this.lastError = null;
  }

  canRequest() {
    if (this.state === STATE.CLOSED) return true;

    if (this.state === STATE.OPEN) {
      // Check if cooldown has passed
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = STATE.HALF_OPEN;
        logger.info({ name: this.name, cooldownMs: this.cooldownMs }, 'Circuit breaker → HALF_OPEN (probing)');
        return true;
      }
      return false;
    }

    // HALF_OPEN — allow one probe
    return true;
  }

  onSuccess() {
    if (this.state !== STATE.CLOSED) {
      logger.info({ name: this.name }, 'Circuit breaker → CLOSED (service recovered)');
    }
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.cooldownMs = this.baseCooldownMs;
    this.lastError = null;
  }

  onFailure(error) {
    this.failureCount++;
    this.lastError = error;

    if (this.state === STATE.HALF_OPEN) {
      // Probe failed — back to OPEN with increased cooldown
      this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs);
      this.state = STATE.OPEN;
      this.openedAt = Date.now();
      logger.warn({ name: this.name, cooldownMs: this.cooldownMs, error }, 'Circuit breaker → OPEN (probe failed, backoff increased)');
      return;
    }

    if (this.failureCount >= this.failureThreshold) {
      this.state = STATE.OPEN;
      this.openedAt = Date.now();
      logger.warn({ name: this.name, failures: this.failureCount, cooldownMs: this.cooldownMs, error }, 'Circuit breaker → OPEN (threshold reached)');
    }
  }

  getStatus() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      cooldownMs: this.state === STATE.OPEN ? this.cooldownMs : 0,
      remainingCooldownMs: this.state === STATE.OPEN ? Math.max(0, this.cooldownMs - (Date.now() - this.openedAt)) : 0,
      lastError: this.lastError
    };
  }
}

// [PERF-13] Per-queue instances so video failures don't block photo analysis
// and vice versa. If vLLM is truly down, each queue independently reaches
// its own failure threshold and opens its own circuit.
module.exports = {
  photo: new AiCircuitBreaker('photo'),
  video: new AiCircuitBreaker('video'),
  translate: new AiCircuitBreaker('translate'),
  AiCircuitBreaker
};
