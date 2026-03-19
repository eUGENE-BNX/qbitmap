/**
 * Liveness Detection Module
 * Using FacePlugin SDK for iBeta Level 2 liveness detection
 * Protects against: printed photos, video replay, 3D masks, deepfakes
 */
const LivenessDetector = {
  livenessSession: null,
  detectSession: null,
  isModelLoaded: false,
  isOpenCVReady: false,

  state: {
    phase: 'idle',
    result: null,
    challengeStartTime: null,
    scoreHistory: [],
    lastScore: null,
  },

  config: {
    LIVENESS_THRESHOLD: 0.7,
    CHALLENGE_TIMEOUT: 15000,
    REQUIRED_CONSECUTIVE: 5,
    FAKE_THRESHOLD: 0.2,
    MAX_SCORE_VARIANCE: 0.15,
  },

  waitForOpenCV() {
    return new Promise((resolve) => {
      if (typeof cv !== 'undefined' && cv.Mat) {
        this.isOpenCVReady = true;
        resolve(true);
        return;
      }

      const checkCV = setInterval(() => {
        if (typeof cv !== 'undefined' && cv.Mat) {
          clearInterval(checkCV);
          this.isOpenCVReady = true;
          resolve(true);
        }
      }, 100);

      setTimeout(() => {
        clearInterval(checkCV);
        if (!this.isOpenCVReady) {
          resolve(false);
        }
      }, 10000);
    });
  },

  async loadModel() {
    if (this.isModelLoaded) return true;

    try {
      const cvReady = await this.waitForOpenCV();
      if (!cvReady) return false;

      if (typeof loadLivenessModel === 'function' && typeof loadDetectionModel === 'function') {
        const [livenessSession, detectSession] = await Promise.all([
          loadLivenessModel(),
          loadDetectionModel()
        ]);
        this.livenessSession = livenessSession;
        this.detectSession = detectSession;
        this.isModelLoaded = true;
        return true;
      }
      return false;
    } catch (error) {
      Logger.error('[Liveness] Model load error:', error);
      return false;
    }
  },

  async checkLiveness(canvasId) {
    if (!this.isModelLoaded || !this.livenessSession || !this.detectSession) {
      return { isLive: false, score: 0, error: 'Model not loaded' };
    }

    if (!this.isOpenCVReady) {
      return { isLive: false, score: 0, error: 'OpenCV not ready' };
    }

    try {
      let detectResult;
      try {
        detectResult = await detectFace(this.detectSession, canvasId);
      } catch (cvError) {
        return { isLive: false, score: 0, skipped: true };
      }

      if (!detectResult || !detectResult.bbox || detectResult.size === 0) {
        return { isLive: false, score: 0, noFace: true };
      }

      const bbox = detectResult.bbox;
      const x1 = bbox.get(0, 0), y1 = bbox.get(0, 1);
      const x2 = bbox.get(0, 2), y2 = bbox.get(0, 3);

      let results;
      try {
        results = await predictLiveness(this.livenessSession, canvasId, detectResult.bbox);
      } catch (cvError) {
        return { isLive: false, score: 0, skipped: true, bbox: { x1, y1, x2, y2 } };
      }

      if (results && Array.isArray(results) && results.length > 0) {
        const firstFace = results[0];
        if (Array.isArray(firstFace) && firstFace.length >= 5) {
          const livenessScore = firstFace[4];
          const isLive = livenessScore >= this.config.LIVENESS_THRESHOLD;
          return { isLive, score: livenessScore, bbox: { x1, y1, x2, y2 } };
        }
      }

      return { isLive: false, score: 0, error: 'No result', bbox: { x1, y1, x2, y2 } };
    } catch (error) {
      return { isLive: false, score: 0, error: error.message };
    }
  },

  startChallenge() {
    this.state = {
      phase: 'detecting',
      result: null,
      challengeStartTime: Date.now(),
      scoreHistory: [],
      lastScore: null,
    };
    return { status: 'started', message: 'Canlılık kontrolü...' };
  },

  async processFrame(canvasId) {
    if (this.state.phase !== 'detecting') {
      return null;
    }

    const elapsed = Date.now() - this.state.challengeStartTime;
    if (elapsed > this.config.CHALLENGE_TIMEOUT) {
      this.state.phase = 'failed';
      return { status: 'timeout', message: 'Süre doldu - Tekrar deneyin' };
    }

    const result = await this.checkLiveness(canvasId);

    if (result.skipped) {
      const remaining = Math.ceil((this.config.CHALLENGE_TIMEOUT - elapsed) / 1000);
      return { status: 'waiting', message: `Canlılık kontrolü... (${remaining}s)`, bbox: result.bbox };
    }

    if (result.noFace) {
      const remaining = Math.ceil((this.config.CHALLENGE_TIMEOUT - elapsed) / 1000);
      return { status: 'no_face', message: `Yüz algılanamadı (${remaining}s)` };
    }

    if (result.error) {
      return { status: 'error', message: result.error, bbox: result.bbox };
    }

    const remaining = Math.ceil((this.config.CHALLENGE_TIMEOUT - elapsed) / 1000);

    if (this.state.lastScore !== null) {
      const jump = Math.abs(result.score - this.state.lastScore);
      if (jump > 0.35) {
        this.state.scoreHistory = [];
        this.state.lastScore = result.score;
        return {
          status: 'waiting',
          message: 'Ani değişim - Sabit durun',
          score: result.score,
          bbox: result.bbox
        };
      }
    }
    this.state.lastScore = result.score;

    if (result.isLive) {
      this.state.scoreHistory.push(result.score);

      if (this.state.scoreHistory.length >= this.config.REQUIRED_CONSECUTIVE) {
        const recentScores = this.state.scoreHistory.slice(-this.config.REQUIRED_CONSECUTIVE);
        const allAboveThreshold = recentScores.every(s => s >= this.config.LIVENESS_THRESHOLD);

        if (allAboveThreshold) {
          const avgScore = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;
          const variance = recentScores.reduce((sum, s) => sum + Math.pow(s - avgScore, 2), 0) / recentScores.length;
          const stdDev = Math.sqrt(variance);

          if (stdDev > this.config.MAX_SCORE_VARIANCE) {
            this.state.scoreHistory = [];
            return { status: 'unstable', message: 'Tutarsız - Sabit durun', score: avgScore, bbox: result.bbox };
          }

          this.state.phase = 'complete';
          this.state.result = { isLive: true, score: avgScore };
          return { status: 'complete', message: 'Doğrulama başarılı! ✓', bbox: result.bbox };
        }
      }

      return {
        status: 'waiting',
        message: `Doğrulanıyor... (${this.state.scoreHistory.length}/${this.config.REQUIRED_CONSECUTIVE}) (${remaining}s)`,
        score: result.score,
        bbox: result.bbox
      };
    } else {
      this.state.scoreHistory = [];

      if (result.score < this.config.FAKE_THRESHOLD) {
        return { status: 'fake', message: 'Sahte yüz tespit edildi!', score: result.score, bbox: result.bbox };
      }

      return {
        status: 'waiting',
        message: `Canlılık doğrulanıyor... (${remaining}s)`,
        score: result.score,
        bbox: result.bbox
      };
    }
  },

  reset() {
    this.state = {
      phase: 'idle',
      result: null,
      challengeStartTime: null,
      scoreHistory: [],
      lastScore: null,
    };
  },

  isComplete() { return this.state.phase === 'complete'; },
  isFailed() { return this.state.phase === 'failed'; },
  isActive() { return this.state.phase === 'detecting'; },

  getRemainingTime() {
    if (!this.state.challengeStartTime) return 0;
    const elapsed = Date.now() - this.state.challengeStartTime;
    return Math.ceil(Math.max(0, this.config.CHALLENGE_TIMEOUT - elapsed) / 1000);
  }
};
