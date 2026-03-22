'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SALT_ROUNDS = 12;

const LoginHistorySchema = new mongoose.Schema(
  {
    ipAddress: { type: String, trim: true },
    userAgent: { type: String, trim: true },
    location: { type: String, trim: true },
    success: { type: Boolean, default: true },
    failureReason: { type: String, trim: true },
    loggedInAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const NotificationPrefsSchema = new mongoose.Schema(
  {
    emailOnLogin: { type: Boolean, default: true },
    emailOnPayment: { type: Boolean, default: true },
    emailOnAutomationFail: { type: Boolean, default: true },
    emailOnCampaignComplete: { type: Boolean, default: true },
    emailOnDmQuota: { type: Boolean, default: true },
    emailOnSubscriptionChange: { type: Boolean, default: true },
    inAppNewFeatures: { type: Boolean, default: true },
    inAppBilling: { type: Boolean, default: true },
    inAppAutomations: { type: Boolean, default: true },
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [100, 'Name must be at most 100 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    passwordHash: {
      type: String,
      required: [true, 'Password is required'],
      select: false,
    },
    role: {
      type: String,
      enum: { values: ['user', 'admin'], message: 'Role must be user or admin' },
      default: 'user',
    },
    avatar: {
      type: String,
      trim: true,
      default: null,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerifyToken: {
      type: String,
      select: false,
      default: null,
    },
    emailVerifyTokenExpires: {
      type: Date,
      select: false,
      default: null,
    },
    passwordResetToken: {
      type: String,
      select: false,
      default: null,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
      default: null,
    },
    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan',
      default: null,
    },
    subscription: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      default: null,
    },
    instagramAccounts: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'InstagramAccount',
      },
    ],
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
    twoFactorSecret: {
      type: String,
      select: false,
      default: null,
    },
    loginHistory: {
      type: [LoginHistorySchema],
      default: [],
      validate: {
        validator: function (arr) {
          return arr.length <= 20;
        },
        message: 'Login history cannot exceed 20 entries',
      },
    },
    apiKey: {
      type: String,
      unique: true,
      sparse: true,
      select: false,
      default: null,
    },
    apiKeyCreatedAt: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isSuspended: {
      type: Boolean,
      default: false,
    },
    suspendReason: {
      type: String,
      trim: true,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    lastLoginIp: {
      type: String,
      trim: true,
      default: null,
    },
    timezone: {
      type: String,
      trim: true,
      default: 'UTC',
    },
    notificationPrefs: {
      type: NotificationPrefsSchema,
      default: () => ({}),
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

// ─── Indexes ────────────────────────────────────────────────────────────────

UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ apiKey: 1 }, { unique: true, sparse: true });
UserSchema.index({ role: 1 });
UserSchema.index({ isActive: 1, isSuspended: 1 });
UserSchema.index({ plan: 1 });
UserSchema.index({ subscription: 1 });
UserSchema.index({ createdAt: -1 });

// ─── Virtuals ────────────────────────────────────────────────────────────────

UserSchema.virtual('fullProfile').get(function () {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    role: this.role,
    avatar: this.avatar,
    isEmailVerified: this.isEmailVerified,
    isActive: this.isActive,
    isSuspended: this.isSuspended,
    timezone: this.timezone,
    lastLoginAt: this.lastLoginAt,
  };
});

// ─── Pre-save Hook ────────────────────────────────────────────────────────────

UserSchema.pre('save', async function (next) {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('passwordHash')) return next();

  try {
    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
    return next();
  } catch (err) {
    return next(err);
  }
});

// Keep login history capped at 20 entries (oldest removed first)
UserSchema.pre('save', function (next) {
  if (this.isModified('loginHistory') && this.loginHistory.length > 20) {
    this.loginHistory = this.loginHistory.slice(-20);
  }
  return next();
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Compare a plain-text password against the stored hash.
 * @param {string} candidatePassword
 * @returns {Promise<boolean>}
 */
UserSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.passwordHash) {
    throw new Error('passwordHash field is not selected. Use .select("+passwordHash")');
  }
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

/**
 * Generate a cryptographically secure API key and persist it.
 * @returns {Promise<string>} The new plain-text API key (shown once).
 */
UserSchema.methods.generateApiKey = async function () {
  const rawKey = crypto.randomBytes(32).toString('hex');
  this.apiKey = rawKey;
  this.apiKeyCreatedAt = new Date();
  await this.save();
  return rawKey;
};

/**
 * Generate an email verification token (raw hex, store hashed).
 * @returns {string} Raw token to send to user.
 */
UserSchema.methods.generateEmailVerifyToken = function () {
  const rawToken = crypto.randomBytes(32).toString('hex');
  this.emailVerifyToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  this.emailVerifyTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  return rawToken;
};

/**
 * Generate a password reset token (raw hex, store hashed).
 * @returns {string} Raw token to send to user.
 */
UserSchema.methods.generatePasswordResetToken = function () {
  const rawToken = crypto.randomBytes(32).toString('hex');
  this.passwordResetToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  this.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  return rawToken;
};

/**
 * Record a login attempt in the history array (capped at 20).
 * @param {object} params
 * @param {string} params.ipAddress
 * @param {string} params.userAgent
 * @param {boolean} [params.success=true]
 * @param {string} [params.failureReason]
 */
UserSchema.methods.recordLogin = function ({
  ipAddress,
  userAgent,
  success = true,
  failureReason = null,
} = {}) {
  this.loginHistory.push({ ipAddress, userAgent, success, failureReason, loggedInAt: new Date() });
  if (this.loginHistory.length > 20) {
    this.loginHistory = this.loginHistory.slice(-20);
  }
  if (success) {
    this.lastLoginAt = new Date();
    this.lastLoginIp = ipAddress;
  }
};

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Find a user by email and include the passwordHash field.
 * @param {string} email
 * @returns {Promise<Document|null>}
 */
UserSchema.statics.findByEmailWithPassword = function (email) {
  return this.findOne({ email: email.toLowerCase().trim() }).select('+passwordHash');
};

/**
 * Find a user by raw API key (hash it first for lookup).
 * NOTE: Because we store raw keys (not hashed) for simplicity with sparse
 * unique index, adjust to hashed lookup if you store hashes.
 * @param {string} rawApiKey
 * @returns {Promise<Document|null>}
 */
UserSchema.statics.findByApiKey = function (rawApiKey) {
  return this.findOne({ apiKey: rawApiKey }).select('+apiKey');
};

// ─── Export ───────────────────────────────────────────────────────────────────

const User = mongoose.model('User', UserSchema);

module.exports = User;
