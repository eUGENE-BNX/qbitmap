const crypto = require('crypto');
const logger = require('./logger').child({ module: 'encryption' });

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// [SEC-12] Require TESLA_ENCRYPTION_KEY to be a proper 32-byte key encoded
// as base64 (44 characters). Use the raw decoded bytes directly as the AES
// key instead of hashing through SHA-256. A 32-byte random key has 256 bits
// of entropy — no KDF needed and no brute-force path if the DB leaks.
//
// Migration: existing tokens encrypted with the old SHA-256(key) derivation
// are re-encrypted at startup via reEncryptAllTokens() in the migration
// runner. After that, the old derivation is only used as a one-way read
// fallback and never for new encrypts.
let _cachedKey = null;

function getKey() {
  if (_cachedKey) return _cachedKey;
  const raw = process.env.TESLA_ENCRYPTION_KEY;
  if (!raw) throw new Error('TESLA_ENCRYPTION_KEY not set');

  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `TESLA_ENCRYPTION_KEY must be exactly 32 bytes (base64-encoded, 44 chars). ` +
      `Got ${buf.length} bytes. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  _cachedKey = buf;
  return buf;
}

// Legacy key derivation — only used during migration to READ old tokens.
function getLegacyKey() {
  const raw = process.env.TESLA_ENCRYPTION_KEY;
  if (!raw) throw new Error('TESLA_ENCRYPTION_KEY not set');
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all base64)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decrypt(encoded) {
  const key = getKey();
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const encrypted = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted, null, 'utf8') + decipher.final('utf8');
}

// Decrypt with the legacy SHA-256-derived key (for migration only).
function decryptLegacy(encoded) {
  const key = getLegacyKey();
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const encrypted = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted, null, 'utf8') + decipher.final('utf8');
}

/**
 * Re-encrypt all Tesla tokens from the legacy SHA-256 key derivation to
 * the new raw-base64 key. Idempotent: tokens already encrypted with the
 * new key will fail legacy decryption and are skipped.
 *
 * @param {import('mysql2/promise').Pool} pool - DB pool
 * @returns {Promise<{migrated: number, skipped: number, errors: number}>}
 */
async function reEncryptAllTokens(pool) {
  const [rows] = await pool.execute(
    'SELECT id, access_token, refresh_token FROM tesla_tokens'
  );

  let migrated = 0, skipped = 0, errors = 0;

  for (const row of rows) {
    const fields = ['access_token', 'refresh_token'];
    const updates = {};
    let needsUpdate = false;

    for (const field of fields) {
      const val = row[field];
      if (!val) continue;

      // Try decrypting with the new key first — if it works, already migrated
      try {
        decrypt(val);
        continue; // Already using new key
      } catch {
        // Can't decrypt with new key — try legacy
      }

      try {
        const plaintext = decryptLegacy(val);
        updates[field] = encrypt(plaintext); // Re-encrypt with new key
        needsUpdate = true;
      } catch (e) {
        logger.error({ tokenId: row.id, field, err: e.message }, 'Token re-encryption failed');
        errors++;
      }
    }

    if (needsUpdate) {
      const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      const values = [...Object.values(updates), row.id];
      await pool.execute(`UPDATE tesla_tokens SET ${setClauses} WHERE id = ?`, values);
      migrated++;
    } else {
      skipped++;
    }
  }

  return { migrated, skipped, errors };
}

module.exports = { encrypt, decrypt, decryptLegacy, reEncryptAllTokens };
