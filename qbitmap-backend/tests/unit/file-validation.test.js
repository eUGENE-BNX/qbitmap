'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateMagicBytes } = require('../../src/utils/file-validation');

// Minimal fixtures — just enough bytes to satisfy the magic byte check.
const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
const png  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const mp4  = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]);
const webm = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x00, 0x00, 0x00]);

test('accepts a real JPEG header', () => {
  assert.equal(validateMagicBytes(jpeg, 'image/jpeg'), true);
});

test('accepts a real PNG header', () => {
  assert.equal(validateMagicBytes(png, 'image/png'), true);
});

test('accepts a real WEBP header', () => {
  assert.equal(validateMagicBytes(webp, 'image/webp'), true);
});

test('accepts a real MP4 header (ftyp at offset 4)', () => {
  assert.equal(validateMagicBytes(mp4, 'video/mp4'), true);
});

test('accepts a real WebM header (EBML signature)', () => {
  assert.equal(validateMagicBytes(webm, 'video/webm'), true);
});

test('rejects a JPEG spoofed as PNG (MIME mismatch)', () => {
  assert.equal(validateMagicBytes(jpeg, 'image/png'), false);
});

test('rejects unknown MIME type outright', () => {
  assert.equal(validateMagicBytes(jpeg, 'application/octet-stream'), false);
  assert.equal(validateMagicBytes(jpeg, 'text/html'), false);
});

test('rejects a short buffer that cannot contain the magic bytes', () => {
  assert.equal(validateMagicBytes(Buffer.from([0xFF]), 'image/jpeg'), false);
  assert.equal(validateMagicBytes(Buffer.alloc(3), 'video/mp4'), false);
});

test('rejects a buffer with correct length but wrong bytes', () => {
  const fake = Buffer.alloc(16, 0);
  assert.equal(validateMagicBytes(fake, 'image/jpeg'), false);
  assert.equal(validateMagicBytes(fake, 'image/png'), false);
  assert.equal(validateMagicBytes(fake, 'image/webp'), false);
  assert.equal(validateMagicBytes(fake, 'video/mp4'), false);
  assert.equal(validateMagicBytes(fake, 'video/webm'), false);
});
