import { QBitmapConfig } from './config.js';
import { Logger } from './utils.js';
import { Analytics } from './analytics.js';
import { H3Grid } from './h3-grid.js';
import { VideoMessage } from './video-message/index.js';

/**
 * QBitmap H3 TRON Light Trail Effect
 * Renders light beams that flow between owned hexagonal cells,
 * giving the impression of data transfer between digital territories.
 * Uses a Canvas 2D overlay on top of the MapLibre map.
 */
const H3TronTrails = {
  _map: null,
  _canvas: null,
  _ctx: null,
  _enabled: false,
  _animationId: null,
  _lastFrameTime: 0,

  // Ownership data
  _ownedCells: [],          // [h3Index, ...]
  _cellCenterCache: null,   // Map<h3Index, {lat,lng}> — all path cell centers

  // Runners
  _runners: [],
  _maxTrailLength: 30,
  _baseRunnerCount: 0,
  _maxRunnerCount: 0,
  _spawnTimer: 0,

  // Pastel white head, light gray tail
  _headColor: [255, 255, 255],
  _tailColor: [140, 145, 150],

  // Ad popup
  _adTimer: null,
  _adPopup: null,

  init(map) {
    this._map = map;

    const canvas = document.createElement('canvas');
    canvas.id = 'h3-tron-canvas';
    canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1;display:none;';
    map.getContainer().appendChild(canvas);
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');

    this._resizeCanvas();

    map.on('move', () => this._onMapMove());
    map.on('resize', () => this._resizeCanvas());

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._stopLoop();
      else if (this._enabled && this._runners.length > 0) this._startLoop();
    });

    Logger.log('[TronTrails] Initialized');
  },

  setEnabled(enabled) {
    this._enabled = enabled;
    if (enabled) {
      this._canvas.style.display = 'block';
      if (H3Grid._hexagonData.length > 0) {
        this.onHexDataChanged(H3Grid._hexagonData, H3Grid._currentResolution);
      }
      // Start ad timer (8-14s random delay)
      clearTimeout(this._adTimer);
      const delay = 10000 + Math.random() * 10000;
      this._adTimer = setTimeout(() => this._showAdPopup(), delay);
    } else {
      this._stopLoop();
      this._canvas.style.display = 'none';
      this._runners = [];
      this._ownedCells = [];
      this._cellCenterCache = null;
      clearTimeout(this._adTimer);
      this._dismissAdPopup();
    }
  },

  // Called when hex grid cells change (viewport move)
  onHexDataChanged(hexagonData, resolution) {
    if (!this._enabled) return;

    if (hexagonData.length > 3000) {
      this._stopLoop();
      this._clearCanvas();
      return;
    }

    // If we already have ownership data, restart runners
    if (this._ownedCells.length >= 2) {
      this._startRunners();
    }
  },

  // Called when ownership data arrives/changes
  onOwnershipChanged(ownershipData) {
    if (!this._enabled) return;

    this._ownedCells = (ownershipData || []).map(c => c.h3Index);
    this._cellCenterCache = new Map();

    if (this._ownedCells.length < 2) {
      this._stopLoop();
      this._clearCanvas();
      return;
    }

    this._startRunners();
  },

  // Get geo center for any H3 cell (cached)
  _getCellCenter(h3Index) {
    if (!this._cellCenterCache) this._cellCenterCache = new Map();
    let c = this._cellCenterCache.get(h3Index);
    if (!c) {
      const ll = h3.cellToLatLng(h3Index);
      c = { lat: ll[0], lng: ll[1] };
      this._cellCenterCache.set(h3Index, c);
    }
    return c;
  },

  _startRunners() {
    this._baseRunnerCount = Math.min(8, Math.max(2, Math.floor(this._ownedCells.length * 0.6)));
    this._maxRunnerCount = this._baseRunnerCount * 2;
    this._spawnRunners(this._baseRunnerCount);
    this._spawnTimer = 0;
    this._startLoop();
  },

  _onMapMove() {
    if (!this._enabled) return;
    // Reproject all runner path points
    for (const runner of this._runners) {
      if (!runner.alive || !runner.pathCells) continue;
      this._projectRunnerPath(runner);
    }
  },

  _projectRunnerPath(runner) {
    runner.pathPixels = runner.pathCells.map(cellId => {
      const c = this._getCellCenter(cellId);
      const p = this._map.project([c.lng, c.lat]);
      return { x: p.x, y: p.y };
    });
  },

  _resizeCanvas() {
    const container = this._map.getContainer();
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width = container.clientWidth * dpr;
    this._canvas.height = container.clientHeight * dpr;
    this._canvas.style.width = container.clientWidth + 'px';
    this._canvas.style.height = container.clientHeight + 'px';
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  // ==================== RUNNERS ====================

  _spawnRunners(count) {
    this._runners = [];
    if (this._ownedCells.length < 2) return;
    for (let i = 0; i < count; i++) {
      const runner = this._createRunner(i);
      if (runner) this._runners.push(runner);
    }
  },

  _createRunner(id) {
    // Pick random source owned cell
    const srcIdx = Math.floor(Math.random() * this._ownedCells.length);
    const sourceCell = this._ownedCells[srcIdx];

    // Pick a different random target owned cell
    let tgtIdx = Math.floor(Math.random() * (this._ownedCells.length - 1));
    if (tgtIdx >= srcIdx) tgtIdx++;
    const targetCell = this._ownedCells[tgtIdx];

    // Compute shortest path using H3
    let pathCells;
    try {
      pathCells = h3.gridPathCells(sourceCell, targetCell);
    } catch {
      return null; // gridPathCells can fail across pentagons or different resolutions
    }

    if (!pathCells || pathCells.length < 2) return null;

    // Cap very long paths
    if (pathCells.length > 60) return null;

    const speedFactor = Math.random() * Math.random();
    const speed = 30 + speedFactor * 130;

    const runner = {
      id,
      pathCells,
      pathPixels: null,
      pathIndex: 0,         // current segment: moving from pathPixels[i] to pathPixels[i+1]
      progress: 0,
      speed,
      trail: [],
      alive: true,
      fadeOut: false,
      opacity: 1
    };

    this._projectRunnerPath(runner);
    return runner;
  },

  _updateRunners(dt) {
    for (const runner of this._runners) {
      if (!runner.alive) continue;

      // Handle fade-out
      if (runner.fadeOut) {
        runner.opacity -= dt * 0.8;
        if (runner.opacity <= 0) { runner.alive = false; continue; }
      }

      if (!runner.pathPixels || runner.pathIndex >= runner.pathPixels.length - 1) {
        runner.alive = false;
        continue;
      }

      const p1 = runner.pathPixels[runner.pathIndex];
      const p2 = runner.pathPixels[runner.pathIndex + 1];
      if (!p1 || !p2) { runner.alive = false; continue; }

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (segLen < 0.5) {
        // Skip tiny segments
        runner.pathIndex++;
        continue;
      }

      runner.progress += (runner.speed * dt) / segLen;

      const t = Math.min(runner.progress, 1);
      runner.trail.unshift({ x: p1.x + dx * t, y: p1.y + dy * t });
      if (runner.trail.length > this._maxTrailLength) {
        runner.trail.length = this._maxTrailLength;
      }

      // Reached next cell center
      if (runner.progress >= 1) {
        runner.pathIndex++;
        runner.progress = 0;

        // Reached end of path — fade out
        if (runner.pathIndex >= runner.pathPixels.length - 1) {
          runner.fadeOut = true;
        }
      }
    }

    // Remove dead runners
    this._runners = this._runners.filter(r => r.alive);

    // Periodically adjust runner count
    this._spawnTimer += dt;
    if (this._spawnTimer > 1.5) {
      this._spawnTimer = 0;
      const target = this._baseRunnerCount + Math.floor(Math.random() * (this._baseRunnerCount + 1));
      const clamped = Math.min(target, this._maxRunnerCount);

      if (this._runners.length < clamped) {
        const toAdd = Math.min(2, clamped - this._runners.length);
        for (let i = 0; i < toAdd; i++) {
          const runner = this._createRunner(this._runners.length);
          if (runner) this._runners.push(runner);
        }
      } else if (this._runners.length > clamped) {
        const toFade = Math.min(2, this._runners.length - clamped);
        const active = this._runners.filter(r => !r.fadeOut);
        for (let i = 0; i < toFade && active.length > 0; i++) {
          const idx = Math.floor(Math.random() * active.length);
          active[idx].fadeOut = true;
          active.splice(idx, 1);
        }
      }
    }
  },

  // ==================== RENDERING ====================

  _clearCanvas() {
    const w = this._canvas.width / (window.devicePixelRatio || 1);
    const h = this._canvas.height / (window.devicePixelRatio || 1);
    this._ctx.clearRect(0, 0, w, h);
  },

  _drawTrails() {
    const ctx = this._ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';

    const [hr, hg, hb] = this._headColor;
    const [tr, tg, tb] = this._tailColor;

    for (const runner of this._runners) {
      if (!runner.alive || runner.trail.length < 2) continue;

      for (let i = runner.trail.length - 1; i >= 1; i--) {
        const p1 = runner.trail[i];
        const p2 = runner.trail[i - 1];
        const t = 1 - (i / this._maxTrailLength); // 1 = head, 0 = tail
        if (t <= 0.02) continue;

        // Interpolate from tail color (t=0) to head color (t=1)
        const cr = Math.round(tr + (hr - tr) * t);
        const cg = Math.round(tg + (hg - tg) * t);
        const cb = Math.round(tb + (hb - tb) * t);

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${t * 0.9 * runner.opacity})`;
        ctx.lineWidth = 0.5 + t * 1.5;
        ctx.stroke();
      }

      // Head dot: same as head color
      const head = runner.trail[0];
      ctx.beginPath();
      ctx.arc(head.x, head.y, 0.75, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${hr},${hg},${hb},${0.9 * runner.opacity})`;
      ctx.fill();
    }
  },

  // ==================== ANIMATION LOOP ====================

  _animate(now) {
    if (!this._enabled) return;

    const dt = this._lastFrameTime ? Math.min((now - this._lastFrameTime) / 1000, 0.1) : 0.016;
    this._lastFrameTime = now;

    this._updateRunners(dt);
    this._clearCanvas();
    this._drawTrails();

    this._animationId = requestAnimationFrame(t => this._animate(t));
  },

  _startLoop() {
    if (this._animationId) return;
    this._lastFrameTime = 0;
    this._animationId = requestAnimationFrame(t => this._animate(t));
  },

  _stopLoop() {
    if (this._animationId) {
      cancelAnimationFrame(this._animationId);
      this._animationId = null;
    }
    this._clearCanvas();
  },

  // ==================== AD POPUP ====================

  _playDiscoverySound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const now = ctx.currentTime;

      // Rising chime: 3 quick ascending tones
      const freqs = [523, 659, 784]; // C5, E5, G5 — major chord arpeggio
      freqs.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t = now + i * 0.12;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.25, t + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
        osc.start(t);
        osc.stop(t + 0.45);
      });

      // Sparkle: high shimmer after the chord
      const sparkle = ctx.createOscillator();
      const sGain = ctx.createGain();
      sparkle.connect(sGain);
      sGain.connect(ctx.destination);
      sparkle.type = 'sine';
      sparkle.frequency.value = 1047; // C6
      const st = now + 0.38;
      sGain.gain.setValueAtTime(0, st);
      sGain.gain.linearRampToValueAtTime(0.15, st + 0.03);
      sGain.gain.exponentialRampToValueAtTime(0.001, st + 0.6);
      sparkle.start(st);
      sparkle.stop(st + 0.65);
    } catch (e) { /* silent */ }
  },

  _showAdPopup() {
    if (this._adPopup) return;

    // Play discovery chime
    this._playDiscoverySound();

    const container = document.createElement('div');
    container.className = 'mesh-ad-container';
    container.innerHTML = `
      <button class="mesh-ad-close">&times;</button>
      <img src="/pellegrino.png" class="mesh-ad-img" alt="S.Pellegrino" />
      <div class="mesh-ad-text">
        <div class="mesh-ad-label">AI MESH DISCOVERY</div>
        <div class="mesh-ad-title">Firsat Bulundu!</div>
        <div class="mesh-ad-desc">Pellegrino sodalar Carrefour'da bugun indirimde gozukuyor.</div>
        <a href="#" class="mesh-ad-link">Carrefour Pellegrino Indirimi</a>
        <div class="mesh-ad-hint">Mesh agindaki veri akisi analiz edildi</div>
      </div>
      <div class="mesh-ad-scanline"></div>
    `;

    // Inject styles once
    if (!document.getElementById('mesh-ad-styles')) {
      const style = document.createElement('style');
      style.id = 'mesh-ad-styles';
      style.textContent = `
        .mesh-ad-container {
          position: fixed; z-index: 9999;
          top: 50%; left: 50%;
          transform: translate(-50%, -50%) scale(0.5);
          display: flex; align-items: center; gap: 0;
          pointer-events: auto;
          opacity: 0;
          transition: opacity 0.5s ease, transform 0.5s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .mesh-ad-container.visible {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
        }
        .mesh-ad-container.fadeout {
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.92);
          transition: opacity 0.25s ease, transform 0.25s ease;
        }
        .mesh-ad-img {
          height: 240px; width: auto; flex-shrink: 0;
          filter: drop-shadow(0 8px 24px rgba(0,0,0,0.3));
          animation: meshImgFloat 3s ease-in-out infinite;
        }
        @keyframes meshImgFloat {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }
        .mesh-ad-text {
          background: rgba(10, 14, 20, 0.82);
          backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(80, 200, 255, 0.12);
          border-radius: 12px;
          padding: 20px 24px;
          max-width: 280px;
          box-shadow: 0 0 30px rgba(80, 180, 255, 0.06);
        }
        .mesh-ad-label {
          font: 600 9px/1 sans-serif; letter-spacing: 2.5px;
          color: rgba(80, 210, 255, 0.7); margin-bottom: 8px;
        }
        .mesh-ad-title {
          font: 700 18px/1.2 sans-serif; color: #fff; margin-bottom: 6px;
        }
        .mesh-ad-desc {
          font: 400 13px/1.5 sans-serif; color: rgba(255,255,255,0.75); margin-bottom: 10px;
        }
        .mesh-ad-link {
          display: inline-block;
          font: 700 13px/1 sans-serif; color: #ff4444;
          text-decoration: none; cursor: pointer;
          padding: 8px 14px; border-radius: 6px;
          background: rgba(255, 60, 60, 0.1);
          border: 1px solid rgba(255, 60, 60, 0.3);
          transition: background 0.2s, color 0.2s;
          margin-bottom: 10px;
        }
        .mesh-ad-link:hover {
          background: rgba(255, 60, 60, 0.2);
          color: #ff6666;
        }
        .mesh-ad-hint {
          font: 400 10px/1 sans-serif; color: rgba(80, 210, 255, 0.35);
          border-top: 1px solid rgba(100,200,255,0.08); padding-top: 8px;
        }
        .mesh-ad-close {
          position: absolute; top: -8px; right: -8px;
          background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.15);
          border-radius: 50%; color: rgba(255,255,255,0.6);
          width: 28px; height: 28px; font-size: 16px; line-height: 26px;
          text-align: center; cursor: pointer; padding: 0;
          transition: background 0.2s, color 0.2s;
        }
        .mesh-ad-close:hover { background: rgba(0,0,0,0.7); color: #fff; }
        .mesh-ad-scanline {
          position: absolute; top: 0; left: 0; right: 0; height: 2px;
          background: linear-gradient(90deg, transparent, rgba(80,200,255,0.5), transparent);
          animation: meshScanDown 1s ease-out forwards;
          pointer-events: none;
        }
        @keyframes meshScanDown {
          0% { top: 0; opacity: 1; }
          100% { top: 100%; opacity: 0; }
        }
        @media (max-width: 520px) {
          .mesh-ad-container { flex-direction: column; gap: 0; }
          .mesh-ad-img { height: 160px; }
          .mesh-ad-text { max-width: 260px; padding: 16px; }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(container);
    this._adPopup = container;

    // Trigger enter animation
    requestAnimationFrame(() => {
      requestAnimationFrame(() => container.classList.add('visible'));
    });

    // Close handler
    container.querySelector('.mesh-ad-close').addEventListener('click', () => this._dismissAdPopup());

    // FlyTo + open video message handler
    container.querySelector('.mesh-ad-link').addEventListener('click', (e) => {
      e.preventDefault();
      this._dismissAdPopup();
      const coord = [29.124849, 40.993873];
      this._map.flyTo({ center: coord, zoom: 17, duration: 2000 });
      // After flyTo settles, open video message popup via deep link search
      this._map.once('moveend', () => {
        setTimeout(async () => {
          try {
            const msgId = 'vmsg_1_mlyzyvxx';
            const base = VideoMessage.apiBase || (QBitmapConfig.api.base + '/api/video-messages');
            const resp = await fetch(`${base}/${msgId}`, { credentials: 'include' });
            if (!resp.ok) return;
            const data = await resp.json();
            const msg = data.message;
            if (msg) {
              VideoMessage.openMessagePopup({
                messageId: msg.message_id,
                senderId: msg.sender_id,
                senderName: msg.sender_name,
                senderAvatar: msg.sender_avatar,
                recipientId: msg.recipient_id,
                durationMs: msg.duration_ms,
                mimeType: msg.mime_type,
                mediaType: msg.media_type || 'video',
                isRead: msg.is_read,
                createdAt: msg.created_at,
                viewCount: msg.view_count || 0,
                description: msg.description || '',
                aiDescription: msg.ai_description || '',
                tags: JSON.stringify(msg.tags || []),
                thumbnailPath: msg.thumbnail_path || ''
              }, coord);
            }
          } catch (err) {
            Logger.warn('[TronTrails] Ad link message fetch failed:', err);
          }
        }, 500);
      });
    });
  },

  _dismissAdPopup() {
    if (!this._adPopup) return;
    const popup = this._adPopup;
    this._adPopup = null;
    popup.classList.remove('visible');
    popup.classList.add('fadeout');
    setTimeout(() => {
      if (popup.parentNode) popup.parentNode.removeChild(popup);
    }, 300);
  }
};

export { H3TronTrails };
