const { execFile } = require('child_process');
const fs = require('fs');
const logger = require('./logger').child({ module: 'thumbnail' });

const FFMPEG_PATH = '/usr/bin/ffmpeg';
const THUMB_WIDTH = 320;
const WEBP_QUALITY = 40;

/**
 * Generate a JPEG thumbnail from a video file.
 * Extracts a single frame at 1 second (or 0s fallback).
 * @param {string} videoPath - Absolute path to the video file
 * @param {string} thumbPath - Absolute path for the output thumbnail
 * @returns {Promise<boolean>} true if successful
 */
function generateThumbnail(videoPath, thumbPath) {
  if (!fs.existsSync(FFMPEG_PATH)) {
    logger.warn('ffmpeg not found at %s, skipping thumbnail', FFMPEG_PATH);
    return Promise.resolve(false);
  }

  const args = [
    '-i', videoPath,
    '-ss', '00:00:01',
    '-vframes', '1',
    '-vf', `scale=${THUMB_WIDTH}:-1`,
    '-c:v', 'libwebp',
    '-quality', String(WEBP_QUALITY),
    '-y',
    thumbPath
  ];

  return new Promise((resolve) => {
    execFile(FFMPEG_PATH, args, { timeout: 10000 }, (err) => {
      if (err) {
        // Fallback: try frame at 0s (video may be shorter than 1s)
        const fallbackArgs = args.slice();
        fallbackArgs[fallbackArgs.indexOf('00:00:01')] = '00:00:00';
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
 * Generate a JPEG thumbnail from a photo file.
 * Resizes the image to THUMB_WIDTH while preserving aspect ratio.
 * @param {string} imagePath - Absolute path to the image file
 * @param {string} thumbPath - Absolute path for the output thumbnail
 * @returns {Promise<boolean>} true if successful
 */
function generatePhotoThumbnail(imagePath, thumbPath) {
  if (!fs.existsSync(FFMPEG_PATH)) {
    logger.warn('ffmpeg not found at %s, skipping photo thumbnail', FFMPEG_PATH);
    return Promise.resolve(false);
  }

  const args = [
    '-i', imagePath,
    '-vf', `scale=${THUMB_WIDTH}:-1`,
    '-c:v', 'libwebp',
    '-quality', String(WEBP_QUALITY),
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

module.exports = { generateThumbnail, generatePhotoThumbnail };
