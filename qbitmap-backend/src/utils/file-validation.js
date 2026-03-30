/**
 * Magic byte validation for uploaded files.
 * Prevents MIME type spoofing by checking actual file content.
 */

const MAGIC_BYTES = {
  'image/jpeg': { offset: 0, bytes: [0xFF, 0xD8, 0xFF] },
  'image/png':  { offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47] },
  'image/webp': { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // "WEBP" at offset 8
  'video/mp4':  { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // "ftyp" at offset 4
  'video/webm': { offset: 0, bytes: [0x1A, 0x45, 0xDF, 0xA3] }, // EBML header
};

/**
 * Validate that a buffer's magic bytes match the declared MIME type.
 * @param {Buffer} buffer - File content
 * @param {string} declaredMime - MIME type from Content-Type header
 * @returns {boolean} true if magic bytes match
 */
function validateMagicBytes(buffer, declaredMime) {
  const spec = MAGIC_BYTES[declaredMime];
  if (!spec) return false; // Unknown MIME type — reject

  if (buffer.length < spec.offset + spec.bytes.length) return false;

  for (let i = 0; i < spec.bytes.length; i++) {
    if (buffer[spec.offset + i] !== spec.bytes[i]) return false;
  }

  return true;
}

module.exports = { validateMagicBytes };
