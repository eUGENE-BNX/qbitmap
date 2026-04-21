// Hold a screen Wake Lock whenever at least one camera popup is actively
// streaming. Implemented as a MutationObserver over `.camera-frame-container`
// elements so every WHEP/HLS entry point benefits without threading a
// counter through the popup/grid/recording mixins individually.
//
// Wake Lock drops silently on visibility change (OS-level behaviour) — we
// re-acquire it when the tab comes back and streams are still playing.

let wakeLock = null;
let armed = false;
let targetCount = 0;

function shouldHold() {
  return targetCount > 0;
}

async function acquire() {
  if (!('wakeLock' in navigator)) return;
  if (wakeLock) return;
  if (document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    // Permission or user-gesture blocked — silent.
    wakeLock = null;
  }
}

async function release() {
  const lock = wakeLock;
  wakeLock = null;
  try {
    await lock?.release();
  } catch { /* noop */ }
}

function recount() {
  const prev = targetCount;
  targetCount = document.querySelectorAll('.camera-frame-container.loaded').length;
  if (targetCount > 0 && prev === 0) acquire();
  else if (targetCount === 0 && prev > 0) release();
}

export function initWakeLock() {
  if (armed) return;
  if (!('wakeLock' in navigator)) return;
  armed = true;

  const observer = new MutationObserver(recount);
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
    childList: true,
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && shouldHold()) {
      acquire();
    }
  });

  // Initial sync in case popups were restored before this module loaded.
  recount();
}
