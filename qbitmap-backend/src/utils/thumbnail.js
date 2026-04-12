// SECURITY INVARIANT: this module MUST use child_process.execFile (not exec
// or spawn-with-shell) and MUST pass arguments as an array. ffmpeg is
// invoked with caller-supplied filesystem paths; if those ever flowed into
// a shell-interpreted string, an attacker controlling a filename could
// inject arbitrary commands. Keep argv-array form. Do not refactor to
// `exec(\`ffmpeg ${args.join(' ')}\`)` or template literals.
const { execFile } = require('child_process');
const fs = require('fs');
const logger = require('./logger').child({ module: 'thumbnail' });

const FFMPEG_PATH = '/usr/bin/ffmpeg';
const THUMB_WIDTH = 320;
const PREVIEW_WIDTH = 800;
const WEBP_QUALITY = 40;
const PREVIEW_QUALITY = 70;

/**
 * Generate a WebP thumbnail from a video file.
 * Extracts a single frame at 25% of duration (or 1s/0s fallback).
 * @param {string} videoPath - Absolute path to the video file
 * @param {string} thumbPath - Absolute path for the output thumbnail
 * @param {object} [opts] - Options
 * @param {number} [opts.width] - Thumbnail width (default: 320)
 * @param {number} [opts.quality] - WebP quality (default: 40)
 * @param {number} [opts.durationMs] - Video duration in ms (for smart frame selection)
 * @returns {Promise<boolean>} true if successful
 */
function generateThumbnail(videoPath, thumbPath, opts = {}) {
  if (!fs.existsSync(FFMPEG_PATH)) {
    logger.warn('ffmpeg not found at %s, skipping thumbnail', FFMPEG_PATH);
    return Promise.resolve(false);
  }

  const width = opts.width || THUMB_WIDTH;
  const quality = opts.quality || WEBP_QUALITY;
  // Smart frame selection: 25% of duration, clamp to [1s, 10s], fallback 1s
  let seekTime = '00:00:01';
  if (opts.durationMs && opts.durationMs > 2000) {
    const seekSec = Math.min(Math.max(Math.round(opts.durationMs / 4) / 1000, 1), 10);
    const h = String(Math.floor(seekSec / 3600)).padStart(2, '0');
    const m = String(Math.floor((seekSec % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(seekSec % 60)).padStart(2, '0');
    seekTime = `${h}:${m}:${s}`;
  }

  // [ARCH-03] Auto-detect output format from file extension so callers
  // can request .webp (video-messages) or .jpg (broadcast recordings)
  // via the same function. `-2` rounds the scaled dimension to an even
  // number, which is safer across codecs than `-1`.
  const isWebp = thumbPath.endsWith('.webp');
  const codecArgs = isWebp
    ? ['-c:v', 'libwebp', '-quality', String(quality)]
    : ['-q:v', '5'];

  const args = [
    '-i', videoPath,
    '-ss', seekTime,
    '-vframes', '1',
    '-vf', `scale=${width}:-2`,
    ...codecArgs,
    '-y',
    thumbPath
  ];

  return new Promise((resolve) => {
    execFile(FFMPEG_PATH, args, { timeout: 10000 }, (err) => {
      if (err) {
        // Fallback: try frame at 0s (video may be shorter than seek time)
        const fallbackArgs = args.slice();
        fallbackArgs[fallbackArgs.indexOf(seekTime)] = '00:00:00';
        execFile(FFMPEG_PATH, fallbackArgs, { timeout: 10000 }, (err2) => {
          if (err2) {
            logger.warn({ err: err2 }, 'Thumbnail generation failed');
            resolve(false);
          } else {
            resolve(true);
          }
        });
      } else {
        resolve(true);
      }
    });
  });
}

/**
 * Generate a WebP thumbnail from a photo file.
 * Resizes the image while preserving aspect ratio.
 * @param {string} imagePath - Absolute path to the image file
 * @param {string} thumbPath - Absolute path for the output thumbnail
 * @param {object} [opts] - Options
 * @param {number} [opts.width] - Thumbnail width (default: 320)
 * @param {number} [opts.quality] - WebP quality (default: 40)
 * @returns {Promise<boolean>} true if successful
 */
function generatePhotoThumbnail(imagePath, thumbPath, opts = {}) {
  if (!fs.existsSync(FFMPEG_PATH)) {
    logger.warn('ffmpeg not found at %s, skipping photo thumbnail', FFMPEG_PATH);
    return Promise.resolve(false);
  }

  const width = opts.width || THUMB_WIDTH;
  const quality = opts.quality || WEBP_QUALITY;

  // [ARCH-03] Same format auto-detection and even-dimension rounding as
  // generateThumbnail above.
  const isWebp = thumbPath.endsWith('.webp');
  const codecArgs = isWebp
    ? ['-c:v', 'libwebp', '-quality', String(quality)]
    : ['-q:v', '5'];

  const args = [
    '-i', imagePath,
    '-vf', `scale=${width}:-2`,
    ...codecArgs,
    '-y',
    thumbPath
  ];

  return new Promise((resolve) => {
    execFile(FFMPEG_PATH, args, { timeout: 10000 }, (err) => {
      if (err) {
        logger.warn({ err }, 'Photo thumbnail generation failed');
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

module.exports = {
  generateThumbnail,
  generatePhotoThumbnail,
  THUMB_WIDTH,
  PREVIEW_WIDTH,
  WEBP_QUALITY,
  PREVIEW_QUALITY
};
