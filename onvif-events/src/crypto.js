/**
 * AES-256-GCM credential encryption for cameras.json.
 *
 * Format:  enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *
 * Key source: ONVIF_CREDS_KEY env var (32 bytes, hex or base64).
 * Without the key the service refuses to start, so plaintext credentials
 * never silently fall back to disk.
 */

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;

  const raw = process.env.ONVIF_CREDS_KEY;
  if (!raw) {
    throw new Error(
      'ONVIF_CREDS_KEY env var is required (32 bytes, hex or base64). ' +
      'Generate with: openssl rand -hex 32'
    );
  }

  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw new Error(`ONVIF_CREDS_KEY must decode to exactly 32 bytes (got ${key.length})`);
  }

  cachedKey = key;
  return key;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // already encrypted
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(value) {
  if (value == null || value === '') return value;
  if (!isEncrypted(value)) return value; // legacy plaintext — caller will re-encrypt on save
  const key = getKey();
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted value');
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const ct = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encrypt, decrypt, isEncrypted, getKey };
