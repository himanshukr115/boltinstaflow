'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

// ─── Constants ────────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;          // 96-bit IV recommended for GCM
const AUTH_TAG_BYTES = 16;    // 128-bit auth tag
const KEY_BYTES = 32;         // 256-bit key
const BCRYPT_ROUNDS = 12;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_SALT_BYTES = 16;

// Separator used when packing IV + authTag + ciphertext into one base64 string
const PACK_SEPARATOR = ':';

// ─── Key Derivation Helpers ───────────────────────────────────────────────────

/**
 * Derive a 32-byte Buffer key from a string secret.
 * If the secret is already 32 bytes of hex (64 hex chars), decode it directly.
 * Otherwise hash it with SHA-256 to guarantee key length.
 * @param {string} keyMaterial
 * @returns {Buffer}
 */
function resolveKeyBuffer(keyMaterial) {
  if (typeof keyMaterial !== 'string' || !keyMaterial) {
    throw new Error('Encryption key must be a non-empty string');
  }
  // If it looks like a 64-char hex string (32 bytes), use it directly
  if (/^[0-9a-fA-F]{64}$/.test(keyMaterial)) {
    return Buffer.from(keyMaterial, 'hex');
  }
  // Otherwise derive a consistent 32-byte key via SHA-256
  return crypto.createHash('sha256').update(keyMaterial).digest();
}

/**
 * Get the active encryption key, falling back to APP_SECRET env var.
 * @param {string|undefined} key
 * @returns {Buffer}
 */
function getKey(key) {
  const keyMaterial = key || process.env.APP_SECRET;
  if (!keyMaterial) {
    throw new Error(
      'No encryption key provided and APP_SECRET environment variable is not set'
    );
  }
  return resolveKeyBuffer(keyMaterial);
}

// ─── AES-256-GCM Encryption / Decryption ─────────────────────────────────────

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * The result is a single base64 string packing: iv:authTag:ciphertext
 * (each segment individually base64-encoded, separated by ':').
 *
 * @param {string}           text  Plaintext to encrypt
 * @param {string|undefined} key   Optional key; falls back to APP_SECRET
 * @returns {string} Packed base64 string: "<iv_b64>:<authTag_b64>:<ciphertext_b64>"
 */
function encrypt(text, key) {
  if (typeof text !== 'string') throw new TypeError('encrypt: text must be a string');
  const keyBuf = getKey(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const packed = [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(PACK_SEPARATOR);

  return packed;
}

/**
 * Decrypt a packed base64 string produced by `encrypt()`.
 *
 * @param {string}           encryptedStr  The packed string from `encrypt()`
 * @param {string|undefined} key           Optional key; falls back to APP_SECRET
 * @returns {string} Decrypted plaintext
 */
function decrypt(encryptedStr, key) {
  if (typeof encryptedStr !== 'string') {
    throw new TypeError('decrypt: encryptedStr must be a string');
  }
  const parts = encryptedStr.split(PACK_SEPARATOR);
  if (parts.length !== 3) {
    throw new Error('decrypt: Invalid encrypted string format (expected iv:authTag:ciphertext)');
  }

  const [ivB64, authTagB64, ciphertextB64] = parts;
  const keyBuf = getKey(key);
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuf, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

// ─── Password Hashing ─────────────────────────────────────────────────────────

/**
 * Hash a plaintext password using bcrypt with 12 rounds.
 * @param {string} password
 * @returns {Promise<string>} bcrypt hash
 */
async function hashPassword(password) {
  if (typeof password !== 'string' || !password) {
    throw new TypeError('hashPassword: password must be a non-empty string');
  }
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Compare a plaintext password against a bcrypt hash.
 * @param {string} password  Plaintext candidate
 * @param {string} hash      Stored bcrypt hash
 * @returns {Promise<boolean>}
 */
async function comparePassword(password, hash) {
  if (typeof password !== 'string' || typeof hash !== 'string') return false;
  return bcrypt.compare(password, hash);
}

// ─── HMAC ─────────────────────────────────────────────────────────────────────

/**
 * Generate an HMAC-SHA256 hex digest for the given data.
 * @param {string|Buffer} data
 * @param {string}        secret
 * @returns {string} Hex-encoded HMAC digest
 */
function generateHmac(data, secret) {
  if (!secret) throw new Error('generateHmac: secret is required');
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Verify an HMAC-SHA256 digest using a timing-safe comparison.
 * @param {string|Buffer} data    Original data
 * @param {string}        secret  Shared secret
 * @param {string}        hash    Expected hex HMAC digest
 * @returns {boolean}
 */
function verifyHmac(data, secret, hash) {
  if (!secret || !hash) return false;
  try {
    const expected = generateHmac(data, secret);
    const expectedBuf = Buffer.from(expected, 'hex');
    const receivedBuf = Buffer.from(hash, 'hex');
    if (expectedBuf.length !== receivedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

// ─── Secure Random ────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically secure random hex string.
 * @param {number} [length=32] Number of bytes (output will be 2× this in hex)
 * @returns {string} Hex string
 */
function generateSecureRandom(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

// ─── Key Derivation ───────────────────────────────────────────────────────────

/**
 * Derive a cryptographic key from a password using scrypt.
 * Returns both the derived key and the salt used (so the salt can be stored).
 *
 * @param {string}          password   The password or secret to derive from
 * @param {string|Buffer}   [salt]     Existing salt hex string or Buffer; if omitted a new random salt is generated
 * @returns {Promise<{ key: string, salt: string }>}  Both values as hex strings
 */
async function deriveKey(password, salt) {
  if (typeof password !== 'string' || !password) {
    throw new TypeError('deriveKey: password must be a non-empty string');
  }

  let saltBuf;
  if (salt) {
    saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'hex');
  } else {
    saltBuf = crypto.randomBytes(SCRYPT_SALT_BYTES);
  }

  // scrypt parameters: N=16384, r=8, p=1 (OWASP minimum for interactive logins)
  const derivedKey = await scrypt(password, saltBuf, SCRYPT_KEY_BYTES, {
    N: 16384,
    r: 8,
    p: 1,
  });

  return {
    key: derivedKey.toString('hex'),
    salt: saltBuf.toString('hex'),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  encrypt,
  decrypt,
  hashPassword,
  comparePassword,
  generateHmac,
  verifyHmac,
  generateSecureRandom,
  deriveKey,
};
