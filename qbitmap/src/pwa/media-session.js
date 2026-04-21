// Media Session helper — lock-screen, notification-tray, CarPlay
// metadata + playback controls for any <video> element.
//
// Lock-screen video frames aren't drawn (the screen is off) — the
// metadata + controls are what's exposed. When the phone unlocks the
// video resumes where it left off. This is an OS-level behaviour, not
// something to work around.

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

  try {
    ms.metadata = new MediaMetadata({
      title: opts.title || 'QBitmap',
      artist: opts.artist || (opts.live ? 'Canlı' : 'QBitmap'),
      album: opts.album || 'QBitmap',
      artwork,
    });
  } catch { /* ignore */ }

  const registered = new Set();
  const setHandler = (action, fn) => {
    try {
      ms.setActionHandler(action, fn);
      registered.add(action);
    } catch { /* action not supported */ }
  };

  setHandler('play', () => videoEl.play().catch(() => {}));
  if (!opts.skipPause) {
    setHandler('pause', () => videoEl.pause());
  }
  setHandler('stop', () => {
    videoEl.pause();
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

  const onPlay = () => { ms.playbackState = 'playing'; };
  const onPause = () => { ms.playbackState = 'paused'; };
  const onTimeUpdate = () => {
    if (opts.live || !videoEl.duration || !isFinite(videoEl.duration)) return;
    if (typeof ms.setPositionState !== 'function') return;
    try {
      ms.setPositionState({
        duration: videoEl.duration,
        playbackRate: videoEl.playbackRate || 1,
        position: Math.min(videoEl.currentTime, videoEl.duration),
      });
    } catch { /* bad state — ignore */ }
  };

  videoEl.addEventListener('play', onPlay);
  videoEl.addEventListener('pause', onPause);
  videoEl.addEventListener('timeupdate', onTimeUpdate);

  return () => {
    videoEl.removeEventListener('play', onPlay);
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
