'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const moment = require('moment-timezone');

// ─── OTP & Token Generators ───────────────────────────────────────────────────

/**
 * Generate a cryptographically secure numeric OTP of the given length.
 * Uses rejection sampling to avoid modulo bias.
 * @param {number} [length=6]
 * @returns {string}
 */
function generateOTP(length = 6) {
  if (!Number.isInteger(length) || length < 1 || length > 20) {
    throw new RangeError('OTP length must be an integer between 1 and 20');
  }
  const max = Math.pow(10, length);
  // Use crypto.randomInt which is unbiased
  const num = crypto.randomInt(0, max);
  return String(num).padStart(length, '0');
}

/**
 * Generate a cryptographically random hex token.
 * @param {number} [bytes=32]
 * @returns {string} Hex string of length bytes * 2
 */
function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Hash a plain-text token with SHA-256 for safe database storage.
 * @param {string} token
 * @returns {string} Hex-encoded SHA-256 digest
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// ─── Slug Generation ──────────────────────────────────────────────────────────

/**
 * Convert text to a URL-safe slug, optionally appending a random hex suffix.
 * @param {string} text
 * @param {boolean|number} [suffix=false] If true uses 4-byte suffix; if number uses that many bytes.
 * @returns {string}
 */
function generateSlug(text, suffix = false) {
  const slug = String(text)
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  if (suffix) {
    const suffixBytes = typeof suffix === 'number' ? suffix : 4;
    const randomPart = crypto.randomBytes(suffixBytes).toString('hex');
    return slug ? `${slug}-${randomPart}` : randomPart;
  }
  return slug;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

/**
 * Execute a Mongoose query with pagination and return structured metadata.
 * @param {mongoose.Query} query  A Mongoose query (not yet awaited)
 * @param {number} [page=1]
 * @param {number} [limit=20]
 * @returns {Promise<{data: Array, pagination: {total: number, page: number, pages: number, limit: number, hasNext: boolean, hasPrev: boolean}}>}
 */
async function paginate(query, page = 1, limit = 20) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (safePage - 1) * safeLimit;

  // Clone the query to get a count without skip/limit
  const countQuery = query.model.find(query.getQuery());

  const [total, data] = await Promise.all([
    countQuery.countDocuments(),
    query.skip(skip).limit(safeLimit),
  ]);

  const pages = Math.ceil(total / safeLimit) || 1;

  return {
    data,
    pagination: {
      total,
      page: safePage,
      pages,
      limit: safeLimit,
      hasNext: safePage < pages,
      hasPrev: safePage > 1,
    },
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Format a numeric amount as a localized currency string.
 * @param {number} amount        The amount (in major units, e.g. 999.00)
 * @param {string} [currency='INR']
 * @param {string} [locale='en-IN']
 * @returns {string}
 */
function formatCurrency(amount, currency = 'INR', locale = 'en-IN') {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format a date using moment-timezone.
 * @param {Date|string|number} date
 * @param {string} [format='YYYY-MM-DD HH:mm:ss']
 * @param {string} [timezone='UTC']
 * @returns {string}
 */
function formatDate(date, format = 'YYYY-MM-DD HH:mm:ss', timezone = 'UTC') {
  return moment(date).tz(timezone).format(format);
}

/**
 * Format a date as a relative "time ago" string (e.g. "2 hours ago").
 * @param {Date|string|number} date
 * @returns {string}
 */
function formatRelativeTime(date) {
  return moment(date).fromNow();
}

// ─── String Utilities ─────────────────────────────────────────────────────────

/**
 * Truncate a string to the given length, appending "..." if truncated.
 * @param {string} str
 * @param {number} [length=100]
 * @returns {string}
 */
function truncate(str, length = 100) {
  if (typeof str !== 'string') return '';
  if (str.length <= length) return str;
  return str.slice(0, length - 3) + '...';
}

// ─── Object Utilities ─────────────────────────────────────────────────────────

/**
 * Deep clone a plain object/array via JSON serialization.
 * Loses undefined values, Functions, and Dates become strings.
 * Use only for serializable data.
 * @param {*} obj
 * @returns {*}
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Return a new object without the specified keys.
 * @param {object} obj
 * @param {string[]} keys
 * @returns {object}
 */
function omit(obj, keys) {
  if (!obj || typeof obj !== 'object') return {};
  const keysToOmit = new Set(Array.isArray(keys) ? keys : [keys]);
  return Object.fromEntries(
    Object.entries(obj).filter(([k]) => !keysToOmit.has(k))
  );
}

/**
 * Return a new object containing only the specified keys.
 * @param {object} obj
 * @param {string[]} keys
 * @returns {object}
 */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return {};
  const keysToPick = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(
    keysToPick.filter((k) => Object.prototype.hasOwnProperty.call(obj, k)).map((k) => [k, obj[k]])
  );
}

// ─── Async Utilities ──────────────────────────────────────────────────────────

/**
 * Promise-based sleep.
 * @param {number} ms Milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff.
 * @param {Function} fn              Async function that may throw
 * @param {number}   [attempts=3]   Maximum total attempts
 * @param {number}   [delay=500]    Initial delay in milliseconds; doubles each retry
 * @returns {Promise<*>}
 */
async function retry(fn, attempts = 3, delay = 500) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const backoff = delay * Math.pow(2, attempt - 1);
        await sleep(backoff);
      }
    }
  }
  throw lastError;
}

// ─── Validation Helpers ───────────────────────────────────────────────────────

/**
 * Validate a MongoDB ObjectId string.
 * @param {*} id
 * @returns {boolean}
 */
function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Parse a value that may represent a boolean (e.g. from env vars or query strings).
 * "true", "1", "yes" => true; "false", "0", "no" => false; anything else => defaultValue.
 * @param {*}       val
 * @param {boolean} [defaultValue=false]
 * @returns {boolean}
 */
function parseBoolean(val, defaultValue = false) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  const str = String(val).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(str)) return true;
  if (['false', '0', 'no', 'off'].includes(str)) return false;
  return defaultValue;
}

// ─── Array Utilities ──────────────────────────────────────────────────────────

/**
 * Split an array into chunks of the given size.
 * @param {Array} arr
 * @param {number} size
 * @returns {Array[]}
 */
function chunkArray(arr, size) {
  if (!Array.isArray(arr)) throw new TypeError('First argument must be an array');
  if (!Number.isInteger(size) || size < 1) throw new RangeError('Chunk size must be a positive integer');
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ─── File / Name Utilities ────────────────────────────────────────────────────

/**
 * Sanitize a string for safe use as a filename (removes path traversal, etc.).
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  return String(name)
    .replace(/[/\\?%*:|"<>]/g, '')   // remove forbidden chars
    .replace(/\.\./g, '')            // prevent directory traversal
    .replace(/\s+/g, '_')           // spaces to underscores
    .trim()
    .slice(0, 255);                  // OS filename length limit
}

/**
 * Generate a zero-padded invoice number.
 * @param {string} [prefix='INV']
 * @param {number} count            Sequential counter
 * @returns {string} e.g. "INV-000042"
 */
function generateInvoiceNumber(prefix = 'INV', count) {
  const paddedCount = String(count).padStart(6, '0');
  return `${prefix}-${paddedCount}`;
}

// ─── Masking / Obfuscation ────────────────────────────────────────────────────

/**
 * Mask an email address for display (e.g. j***@gmail.com).
 * Shows first character, masks the rest of the local part.
 * @param {string} email
 * @returns {string}
 */
function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, 1);
  const masked = '*'.repeat(Math.max(3, local.length - 1));
  return `${visible}${masked}@${domain}`;
}

/**
 * Format a masked card number for display.
 * @param {string} last4  Last 4 digits of the card
 * @returns {string} e.g. "**** **** **** 4242"
 */
function maskCard(last4) {
  const digits = String(last4).replace(/\D/g, '').slice(-4).padStart(4, '0');
  return `**** **** **** ${digits}`;
}

// ─── Billing Utilities ────────────────────────────────────────────────────────

/**
 * Calculate a prorated charge amount for a plan change mid-cycle.
 * @param {number} planAmount      Full plan price for the cycle
 * @param {number} daysRemaining   Days left in the current billing cycle
 * @param {number} totalDays       Total days in the billing cycle
 * @returns {number} Prorated amount (same currency unit as planAmount), rounded to 2 decimal places
 */
function calculateProratedAmount(planAmount, daysRemaining, totalDays) {
  if (totalDays <= 0) throw new RangeError('totalDays must be a positive number');
  if (daysRemaining < 0) throw new RangeError('daysRemaining cannot be negative');
  const safeRemaining = Math.min(daysRemaining, totalDays);
  const prorated = (planAmount * safeRemaining) / totalDays;
  return Math.round(prorated * 100) / 100;
}

// ─── Size Formatting ──────────────────────────────────────────────────────────

/**
 * Convert a byte count to a human-readable file size string.
 * @param {number} bytes
 * @returns {string} e.g. "1.23 MB"
 */
function bytesToHuman(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) return '0 B';
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  if (bytes === 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log2(bytes) / 10), UNITS.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 2)} ${UNITS[exponent]}`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generateOTP,
  generateToken,
  hashToken,
  generateSlug,
  paginate,
  formatCurrency,
  formatDate,
  formatRelativeTime,
  truncate,
  deepClone,
  omit,
  pick,
  sleep,
  retry,
  isValidObjectId,
  parseBoolean,
  chunkArray,
  sanitizeFilename,
  generateInvoiceNumber,
  maskEmail,
  maskCard,
  calculateProratedAmount,
  bytesToHuman,
};
