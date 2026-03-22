'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

const ACCOUNT_TYPES = ['PERSONAL', 'BUSINESS', 'CREATOR'];

// ─── Encryption helpers ───────────────────────────────────────────────────────
// Uses AES-256-GCM.  Set ENCRYPTION_KEY env var to a 32-byte hex string.

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getEncryptionKey() {
  const hexKey = process.env.ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY env var must be a 64-character hex string (32 bytes)'
    );
  }
  return Buffer.from(hexKey, 'hex');
}

/**
 * Encrypt a plaintext string.
 * @param {string} plaintext
 * @returns {string} iv:authTag:ciphertext (all hex)
 */
function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a previously encrypted string.
 * @param {string} encryptedText  iv:authTag:ciphertext (all hex)
 * @returns {string}
 */
function decrypt(encryptedText) {
  if (!encryptedText) return null;
  const [ivHex, authTagHex, ciphertextHex] = encryptedText.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Invalid encrypted text format');
  }
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const InstagramAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },
    instagramUserId: {
      type: String,
      required: [true, 'instagramUserId is required'],
      trim: true,
    },
    username: {
      type: String,
      required: [true, 'username is required'],
      trim: true,
      lowercase: true,
    },
    displayName: {
      type: String,
      trim: true,
      default: '',
    },
    profilePicUrl: {
      type: String,
      trim: true,
      default: null,
    },
    // Stored encrypted via pre-save hook
    accessToken: {
      type: String,
      select: false,
      default: null,
    },
    accessTokenExpiry: {
      type: Date,
      default: null,
    },
    longLivedToken: {
      type: String,
      select: false,
      default: null,
    },
    longLivedTokenExpiry: {
      type: Date,
      default: null,
    },
    permissions: {
      type: [{ type: String, trim: true }],
      default: [],
    },
    pageId: {
      type: String,
      trim: true,
      default: null,
    },
    pageAccessToken: {
      type: String,
      select: false,
      default: null,
    },
    isConnected: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    webhookSubscribed: {
      type: Boolean,
      default: false,
    },
    followersCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    followingCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    mediaCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    biography: {
      type: String,
      trim: true,
      maxlength: [500, 'Biography must be at most 500 characters'],
      default: '',
    },
    website: {
      type: String,
      trim: true,
      default: null,
    },
    accountType: {
      type: String,
      enum: {
        values: ACCOUNT_TYPES,
        message: `accountType must be one of: ${ACCOUNT_TYPES.join(', ')}`,
      },
      default: 'PERSONAL',
    },
    lastSyncAt: {
      type: Date,
      default: null,
    },
    // DM quota tracking
    dailyDmCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    dailyDmResetAt: {
      type: Date,
      default: null,
    },
    dmQuotaExceededAt: {
      type: Date,
      default: null,
    },
    // API call quota tracking
    apiCallsToday: {
      type: Number,
      default: 0,
      min: 0,
    },
    apiCallsResetAt: {
      type: Date,
      default: null,
    },
    metadata: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => new Map(),
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

InstagramAccountSchema.index({ userId: 1 });
InstagramAccountSchema.index({ instagramUserId: 1 }, { unique: true });
InstagramAccountSchema.index({ username: 1 });
InstagramAccountSchema.index({ userId: 1, isActive: 1 });
InstagramAccountSchema.index({ userId: 1, isConnected: 1 });
// Compound: unique account per user + IG user ID combo
InstagramAccountSchema.index({ userId: 1, instagramUserId: 1 }, { unique: true });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

InstagramAccountSchema.virtual('isTokenExpired').get(function () {
  if (!this.longLivedTokenExpiry) return true;
  return this.longLivedTokenExpiry < new Date();
});

InstagramAccountSchema.virtual('isTokenExpiringSoon').get(function () {
  if (!this.longLivedTokenExpiry) return true;
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return this.longLivedTokenExpiry <= sevenDaysFromNow;
});

// ─── Pre-save Hooks ───────────────────────────────────────────────────────────

InstagramAccountSchema.pre('save', function (next) {
  // Encrypt accessToken if modified
  if (this.isModified('accessToken') && this.accessToken) {
    try {
      // Only encrypt if it doesn't look like it's already encrypted (iv:tag:cipher)
      if (!this.accessToken.match(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/)) {
        this.accessToken = encrypt(this.accessToken);
      }
    } catch (err) {
      return next(err);
    }
  }

  // Encrypt longLivedToken if modified
  if (this.isModified('longLivedToken') && this.longLivedToken) {
    try {
      if (!this.longLivedToken.match(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/)) {
        this.longLivedToken = encrypt(this.longLivedToken);
      }
    } catch (err) {
      return next(err);
    }
  }

  // Encrypt pageAccessToken if modified
  if (this.isModified('pageAccessToken') && this.pageAccessToken) {
    try {
      if (!this.pageAccessToken.match(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/)) {
        this.pageAccessToken = encrypt(this.pageAccessToken);
      }
    } catch (err) {
      return next(err);
    }
  }

  return next();
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Decrypt and return the raw access token.
 * The document must be fetched with .select('+accessToken').
 * @returns {string|null}
 */
InstagramAccountSchema.methods.getAccessToken = function () {
  if (!this.accessToken) return null;
  return decrypt(this.accessToken);
};

/**
 * Decrypt and return the raw long-lived token.
 * The document must be fetched with .select('+longLivedToken').
 * @returns {string|null}
 */
InstagramAccountSchema.methods.getLongLivedToken = function () {
  if (!this.longLivedToken) return null;
  return decrypt(this.longLivedToken);
};

/**
 * Decrypt and return the raw page access token.
 * The document must be fetched with .select('+pageAccessToken').
 * @returns {string|null}
 */
InstagramAccountSchema.methods.getPageAccessToken = function () {
  if (!this.pageAccessToken) return null;
  return decrypt(this.pageAccessToken);
};

/**
 * Check whether the account has DM quota remaining for a given plan limit.
 * Automatically resets the daily counter if it's a new UTC day.
 * @param {number} dailyLimit  - Maximum DMs allowed per day (from plan limits).
 * @returns {{ allowed: boolean, remaining: number, resetAt: Date }}
 */
InstagramAccountSchema.methods.checkDmQuota = function (dailyLimit) {
  const now = new Date();

  // Reset counter if it's a new UTC day
  if (!this.dailyDmResetAt || this.dailyDmResetAt < startOfUtcDay(now)) {
    this.dailyDmCount = 0;
    this.dailyDmResetAt = startOfUtcDay(now);
    this.dmQuotaExceededAt = null;
  }

  const remaining = Math.max(0, dailyLimit - this.dailyDmCount);
  const allowed = remaining > 0;

  if (!allowed && !this.dmQuotaExceededAt) {
    this.dmQuotaExceededAt = now;
  }

  return {
    allowed,
    remaining,
    used: this.dailyDmCount,
    limit: dailyLimit,
    resetAt: this.dailyDmResetAt,
  };
};

/**
 * Increment the daily DM counter.
 * @param {number} [count=1]
 * @returns {Promise<Document>}
 */
InstagramAccountSchema.methods.incrementDmCount = async function (count = 1) {
  const now = new Date();
  if (!this.dailyDmResetAt || this.dailyDmResetAt < startOfUtcDay(now)) {
    this.dailyDmCount = 0;
    this.dailyDmResetAt = startOfUtcDay(now);
    this.dmQuotaExceededAt = null;
  }
  this.dailyDmCount += count;
  return this.save();
};

/**
 * Increment the API calls counter for today.
 * @param {number} [count=1]
 * @returns {Promise<Document>}
 */
InstagramAccountSchema.methods.incrementApiCalls = async function (count = 1) {
  const now = new Date();
  if (!this.apiCallsResetAt || this.apiCallsResetAt < startOfUtcDay(now)) {
    this.apiCallsToday = 0;
    this.apiCallsResetAt = startOfUtcDay(now);
  }
  this.apiCallsToday += count;
  return this.save();
};

// ─── Utility ──────────────────────────────────────────────────────────────────

function startOfUtcDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Get all active and connected accounts for a user.
 * @param {ObjectId|string} userId
 * @returns {Promise<Document[]>}
 */
InstagramAccountSchema.statics.getActiveForUser = function (userId) {
  return this.find({ userId, isActive: true, isConnected: true });
};

/**
 * Find by Instagram user ID.
 * @param {string} instagramUserId
 * @returns {Promise<Document|null>}
 */
InstagramAccountSchema.statics.findByInstagramUserId = function (instagramUserId) {
  return this.findOne({ instagramUserId });
};

// ─── Export ───────────────────────────────────────────────────────────────────

const InstagramAccount = mongoose.model('InstagramAccount', InstagramAccountSchema);

module.exports = InstagramAccount;
