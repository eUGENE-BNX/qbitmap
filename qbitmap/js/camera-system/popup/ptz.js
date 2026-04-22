import { QBitmapConfig } from "../../config.js";
import { Logger } from "../../utils.js";

// Relative step magnitudes in ONVIF TranslationGenericSpace where
// 1.0 = half of the full axis range. Calibrated for Tapo C236 pan/tilt:
//   pan full range ≈ 360°  →  0.055 ≈ 10°
//   tilt full range ≈ 151° →  0.13  ≈ 10°
// Each click issues one RelativeMove — the camera terminates on its own
// when the target is reached, so there is no move/stop race to worry about.
const PTZ_STEP_X = 0.055;
const PTZ_STEP_Y = 0.13;

const DIR_STEPS = {
  up:    { x: 0,             y: PTZ_STEP_Y  },
  down:  { x: 0,             y: -PTZ_STEP_Y },
  left:  { x: -PTZ_STEP_X,   y: 0           },
  right: { x: PTZ_STEP_X,    y: 0           }
};

const KEY_DIR_MAP = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
};

const PtzMixin = {
  /**
   * Probe PTZ support for this camera and render the overlay if available.
   * Called once per popup open, after the camera object is known.
   */
  async initPtzOverlay(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;
    const camera = popupData.camera;
    // City cameras have no ONVIF link; numeric id is required for the
    // owner-scoped backend endpoint.
    if (!camera || !camera.id || camera.camera_type === 'city') return;

    try {
      const response = await fetch(
        `${QBitmapConfig.api.onvif}/ptz/${camera.id}/capabilities`,
        { credentials: 'include' }
      );
      if (!response.ok) return; // 401/403/404 — hide overlay silently
      const caps = await response.json();
      if (!caps || !caps.ptz) return;

      this._renderPtzOverlay(deviceId);
    } catch (e) {
      Logger.log('[PTZ] capability fetch failed:', e);
    }
  },

  _renderPtzOverlay(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;
    const popupEl = popupData.popup.getElement();
    if (!popupEl) return;
    const frameContainer = popupEl.querySelector('.camera-frame-container');
    if (!frameContainer) return;
    if (popupEl.querySelector('.camera-ptz-overlay')) return; // idempotent

    // C236 and similar pan/tilt-only cameras have no optical zoom; we don't
    // render zoom buttons at all — digital zoom is a Tapo app feature, not
    // an ONVIF one, so there's nothing ONVIF-side to trigger.
    const overlay = document.createElement('div');
    overlay.className = 'camera-ptz-overlay';
    overlay.innerHTML = `
      <div class="ptz-pad" role="group" aria-label="Pan/Tilt">
        <button type="button" class="ptz-btn ptz-up" data-ptz-dir="up" aria-label="Yukarı">▲</button>
        <button type="button" class="ptz-btn ptz-left" data-ptz-dir="left" aria-label="Sol">◀</button>
        <button type="button" class="ptz-btn ptz-right" data-ptz-dir="right" aria-label="Sağ">▶</button>
        <button type="button" class="ptz-btn ptz-down" data-ptz-dir="down" aria-label="Aşağı">▼</button>
        <button type="button" class="ptz-btn ptz-home" data-ptz-action="home" aria-label="Merkeze al" title="Merkeze al">⌂</button>
      </div>
    `;
    frameContainer.appendChild(overlay);

    this._wirePtzHandlers(deviceId, overlay);
  },

  _wirePtzHandlers(deviceId, overlay) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;
    const cameraId = popupData.camera.id;

    // Serialize step requests so a rapid-fire user can't pile them up on the
    // camera faster than it can execute — Tapo will queue a few but rejects
    // beyond that. `inFlight` blocks new dispatches until the previous
    // relativeMove has returned (camera has finished or acknowledged).
    let inFlight = false;

    const fireStep = async (dir) => {
      const delta = DIR_STEPS[dir];
      if (!delta) return;
      if (inFlight) return; // drop extra clicks during motion
      inFlight = true;
      try {
        const response = await fetch(`${QBitmapConfig.api.onvif}/ptz/${cameraId}/step`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(delta)
        });
        if (!response.ok) {
          Logger.log('[PTZ] step rejected:', response.status);
        }
      } catch (e) {
        Logger.log('[PTZ] step failed:', e);
      } finally {
        inFlight = false;
      }
    };

    const fireHome = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        // Empty JSON body + Content-Type — Fastify's body parser trips on
        // bodyless POSTs served via its default validation path.
        const response = await fetch(`${QBitmapConfig.api.onvif}/ptz/${cameraId}/home`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        if (!response.ok) {
          Logger.log('[PTZ] home rejected:', response.status);
        }
      } catch (e) {
        Logger.log('[PTZ] home failed:', e);
      } finally {
        inFlight = false;
      }
    };

    const flashActive = (btn) => {
      if (!btn) return;
      btn.classList.add('active');
      setTimeout(() => btn.classList.remove('active'), 150);
    };

    // Pointer-based click: treat pointerdown as the action so there's no
    // ~300ms synthetic-click delay on touch devices.
    const onPointerDown = (e) => {
      const btn = e.target.closest('.ptz-btn');
      if (!btn) return;
      e.preventDefault();
      flashActive(btn);
      if (btn.dataset.ptzAction === 'home') {
        fireHome();
        return;
      }
      const dir = btn.dataset.ptzDir;
      if (dir) fireStep(dir);
    };
    overlay.addEventListener('pointerdown', onPointerDown);

    const onTouchStart = (e) => {
      if (e.target.closest('.ptz-btn')) e.preventDefault();
    };
    overlay.addEventListener('touchstart', onTouchStart, { passive: false });

    // Keyboard: one step per keydown, no auto-repeat (we don't want holding
    // the arrow key to spam relativeMove).
    const popupEl = popupData.popup.getElement();
    const isPopupFocused = () => {
      const active = document.activeElement;
      return active && popupEl && popupEl.contains(active);
    };

    const onKeyDown = (e) => {
      if (!isPopupFocused()) return;
      const dir = KEY_DIR_MAP[e.key];
      if (!dir || e.repeat) return;
      e.preventDefault();
      const btn = overlay.querySelector(`.ptz-btn[data-ptz-dir="${dir}"]`);
      flashActive(btn);
      fireStep(dir);
    };
    document.addEventListener('keydown', onKeyDown);

    popupData.ptzCleanup = () => {
      overlay.removeEventListener('pointerdown', onPointerDown);
      overlay.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('keydown', onKeyDown);
    };
  },

  destroyPtzOverlay(deviceId) {
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;
    if (popupData.ptzCleanup) {
      try { popupData.ptzCleanup(); } catch (_) { /* ignore */ }
      popupData.ptzCleanup = null;
    }
  }
};

export { PtzMixin };
