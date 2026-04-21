// Media Session helper — lock-screen / notification-tray / CarPlay
// metadata + playback controls for any <video> element.
//
// IMPORTANT: Chrome Android has a bug where calling
// navigator.mediaSession.setActionHandler(...) BEFORE the video has
// entered the `playing` state locks the native <video controls> play
// button — first-play never fires, the video appears frozen on its
// poster frame. MediaMetadata assignment alone is safe.
//
// The working pattern (verified 2026-04-21 via USB remote debug):
//   1. Set metadata immediately (safe, cosmetic-only).
//   2. Wait for the `playing` event on the video element.
//   3. Only THEN register setActionHandler for pause/stop/seek.
//   4. NEVER register a 'play' handler. The native element's own play
//      button keeps working, and Chrome's default lock-screen play
//      dispatch resumes playback correctly because we keep
//      ms.playbackState in sync.

const NON_PLAY_ACTIONS = ['pause', 'stop', 'seekbackward', 'seekforward', 'seekto'];

/**
 * @param {HTMLVideoElement} videoEl
 * @param {object} opts
 * @param {string}  opts.title
 * @param {string=} opts.artist
 * @param {string=} opts.album
 * @param {string=} opts.posterUrl
 * @param {boolean=} opts.live       — skips seek handlers + position state
 * @param {() => void=} opts.onStop  — called when the OS Stop action fires
 * @returns {() => void}             — cleanup
 */
export function wireMediaSession(videoEl, opts) {
  if (!videoEl || typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return () => {};
  }

  const ms = navigator.mediaSession;
  const artwork = opts.posterUrl
    ? [
        { src: opts.posterUrl, sizes: '512x512', type: 'image/jpeg' },
        { src: opts.posterUrl, sizes: '384x384', type: 'image/jpeg' },
        { src: opts.posterUrl, sizes: '256x256', type: 'image/jpeg' },
        { src: opts.posterUrl, sizes: '192x192', type: 'image/jpeg' },
      ]
    : undefined;

  const applyMetadata = () => {
    try {
      ms.metadata = new MediaMetadata({
        title: opts.title || 'QBitmap',
        artist: opts.artist || (opts.live ? 'Canlı' : 'QBitmap'),
        album: opts.album || 'QBitmap',
        artwork,
      });
    } catch { /* construction failed — drop silently */ }
  };

  // Metadata is safe pre-play — set it immediately so if the video
  // auto-plays or the user swipes to the lock screen before tapping
  // play, the poster/title are already there.
  applyMetadata();

  const registered = new Set();
  const setHandler = (action, fn) => {
    try {
      ms.setActionHandler(action, fn);
      registered.add(action);
    } catch { /* action not supported on this platform */ }
  };

  let wired = false;
  const wireHandlers = () => {
    if (wired) return;
    wired = true;

    setHandler('pause', () => {
      try { videoEl.pause(); } catch {}
    });
    setHandler('stop', () => {
      try { videoEl.pause(); } catch {}
      ms.playbackState = 'paused';
      opts.onStop?.();
    });

    if (!opts.live) {
      setHandler('seekbackward', (d) => {
        videoEl.currentTime = Math.max(0, videoEl.currentTime - (d?.seekOffset || 10));
      });
      setHandler('seekforward', (d) => {
        const dur = videoEl.duration || Number.POSITIVE_INFINITY;
        videoEl.currentTime = Math.min(dur, videoEl.currentTime + (d?.seekOffset || 10));
      });
      setHandler('seekto', (d) => {
        if (!d || typeof d.seekTime !== 'number') return;
        if (d.fastSeek && typeof videoEl.fastSeek === 'function') {
          videoEl.fastSeek(d.seekTime);
        } else {
          videoEl.currentTime = d.seekTime;
        }
      });
    }
    // Do NOT register 'play' — see header comment.
  };

  const onPlaying = () => {
    ms.playbackState = 'playing';
    applyMetadata(); // refresh if opts mutated between pop-open and first-play
    wireHandlers();
  };
  const onPause = () => { ms.playbackState = 'paused'; };
  const onTimeUpdate = () => {
    if (opts.live) return;
    if (!videoEl.duration || !isFinite(videoEl.duration)) return;
    if (typeof ms.setPositionState !== 'function') return;
    try {
      ms.setPositionState({
        duration: videoEl.duration,
        playbackRate: videoEl.playbackRate || 1,
        position: Math.min(videoEl.currentTime, videoEl.duration),
      });
    } catch { /* bad state — ignore */ }
  };

  // Listen for `playing` (actual playback started), not `play` (play
  // requested). `play` fires before media starts and would risk the same
  // deadlock if we registered action handlers in response to it.
  videoEl.addEventListener('playing', onPlaying);
  videoEl.addEventListener('pause', onPause);
  videoEl.addEventListener('timeupdate', onTimeUpdate);

  // If the video is already in the middle of playback when wired (e.g.
  // protocol switch), arm handlers right away.
  if (!videoEl.paused && videoEl.readyState >= 2) {
    onPlaying();
  }

  return () => {
    videoEl.removeEventListener('playing', onPlaying);
    videoEl.removeEventListener('pause', onPause);
    videoEl.removeEventListener('timeupdate', onTimeUpdate);
    for (const action of registered) {
      try { ms.setActionHandler(action, null); } catch {}
    }
    registered.clear();
    try { ms.metadata = null; } catch {}
    ms.playbackState = 'none';
  };
}
