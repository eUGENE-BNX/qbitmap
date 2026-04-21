// Common Media Session helper used by video-message popup, live camera
// popups (WHEP + HLS), and broadcast recordings. Shows sender / camera
// name + poster on the lock screen and tray, wires play/pause/seek back
// to the underlying <video> element, and releases the session when the
// caller's cleanup function runs.
//
// Returns a cleanup function — call it when the consumer closes its
// popup so a stale "Now Playing" chip doesn't outlive the player.

const ACTIONS = ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto'];

/**
 * @param {HTMLVideoElement} videoEl
 * @param {object} opts
 * @param {string}  opts.title         e.g. camera name or message description
 * @param {string=} opts.artist        e.g. sender name
 * @param {string=} opts.album         default: "QBitmap"
 * @param {string=} opts.posterUrl     single URL — OS scales for every slot
 * @param {boolean=} opts.live         true for live streams (skip seek + position)
 * @param {() => void=} opts.onStop    called when the user taps Stop in the tray
 * @returns {() => void}
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
    } catch (err) {
      console.warn('[media-session] metadata failed', err);
    }
  };

  const setHandler = (action, fn) => {
    try { ms.setActionHandler(action, fn); } catch { /* not supported */ }
  };

  setHandler('play', () => videoEl.play().catch(() => {}));
  setHandler('pause', () => videoEl.pause());
  setHandler('stop', () => {
    videoEl.pause();
    ms.playbackState = 'paused';
    opts.onStop?.();
  });

  // Non-live only: seeking + position state.
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

  const onPlay = () => {
    applyMetadata();
    ms.playbackState = 'playing';
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
    } catch { /* ignore */ }
  };

  videoEl.addEventListener('play', onPlay);
  videoEl.addEventListener('pause', onPause);
  videoEl.addEventListener('timeupdate', onTimeUpdate);

  // If the video is already playing when wired (HLS MANIFEST_PARSED auto-
  // plays), push metadata immediately.
  if (!videoEl.paused) onPlay();

  return () => {
    videoEl.removeEventListener('play', onPlay);
    videoEl.removeEventListener('pause', onPause);
    videoEl.removeEventListener('timeupdate', onTimeUpdate);
    ACTIONS.forEach((a) => { try { ms.setActionHandler(a, null); } catch {} });
    try { ms.metadata = null; } catch {}
    ms.playbackState = 'none';
  };
}
