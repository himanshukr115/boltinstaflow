'use strict';

const mongoose = require('mongoose');

const SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'canceled', 'expired', 'paused'];
const BILLING_CYCLES = ['monthly', 'yearly'];
const GATEWAYS = ['razorpay', 'cashfree', 'manual'];

const SubscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan',
      required: [true, 'planId is required'],
    },
    status: {
      type: String,
      enum: {
        values: SUBSCRIPTION_STATUSES,
        message: `status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}`,
      },
      default: 'trialing',
    },
    billingCycle: {
      type: String,
      enum: {
        values: BILLING_CYCLES,
        message: `billingCycle must be one of: ${BILLING_CYCLES.join(', ')}`,
      },
      required: [true, 'billingCycle is required'],
    },
    currentPeriodStart: {
      type: Date,
      required: [true, 'currentPeriodStart is required'],
    },
    currentPeriodEnd: {
      type: Date,
      required: [true, 'currentPeriodEnd is required'],
    },
    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },
    canceledAt: {
      type: Date,
      default: null,
    },
    trialStart: {
      type: Date,
      default: null,
    },
    trialEnd: {
      type: Date,
      default: null,
    },
    gateway: {
      type: String,
      enum: {
        values: GATEWAYS,
        message: `gateway must be one of: ${GATEWAYS.join(', ')}`,
      },
      required: [true, 'gateway is required'],
    },
    gatewaySubscriptionId: {
      type: String,
      trim: true,
      default: null,
    },
    gatewayCustomerId: {
      type: String,
      trim: true,
      default: null,
    },
    pausedAt: {
      type: Date,
      default: null,
    },
    resumesAt: {
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

SubscriptionSchema.index({ userId: 1 });
SubscriptionSchema.index({ status: 1 });
SubscriptionSchema.index({ userId: 1, status: 1 });
SubscriptionSchema.index({ planId: 1 });
SubscriptionSchema.index({ gatewaySubscriptionId: 1 }, { sparse: true });
SubscriptionSchema.index({ currentPeriodEnd: 1 });
SubscriptionSchema.index({ trialEnd: 1 }, { sparse: true });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

SubscriptionSchema.virtual('isTrialing').get(function () {
  return this.status === 'trialing';
});

SubscriptionSchema.virtual('isActive').get(function () {
  return this.status === 'active' || this.status === 'trialing';
});

SubscriptionSchema.virtual('daysUntilRenewal').get(function () {
  if (!this.currentPeriodEnd) return null;
  const diffMs = this.currentPeriodEnd.getTime() - Date.now();
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
});

SubscriptionSchema.virtual('trialDaysRemaining').get(function () {
  if (!this.trialEnd || this.status !== 'trialing') return 0;
  const diffMs = this.trialEnd.getTime() - Date.now();
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
});

// ─── Pre-save Validation ──────────────────────────────────────────────────────

SubscriptionSchema.pre('save', function (next) {
  if (this.currentPeriodEnd && this.currentPeriodStart) {
    if (this.currentPeriodEnd <= this.currentPeriodStart) {
      return next(new Error('currentPeriodEnd must be after currentPeriodStart'));
    }
  }
  if (this.trialEnd && this.trialStart) {
    if (this.trialEnd <= this.trialStart) {
      return next(new Error('trialEnd must be after trialStart'));
    }
  }
  return next();
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Cancel this subscription at the current period end.
 * @returns {Promise<Document>}
 */
SubscriptionSchema.methods.cancelAtEnd = async function () {
  this.cancelAtPeriodEnd = true;
  this.canceledAt = new Date();
  return this.save();
};

/**
 * Immediately cancel this subscription.
 * @returns {Promise<Document>}
 */
SubscriptionSchema.methods.cancelImmediately = async function () {
  this.status = 'canceled';
  this.cancelAtPeriodEnd = false;
  this.canceledAt = new Date();
  this.currentPeriodEnd = new Date();
  return this.save();
};

/**
 * Pause this subscription.
 * @param {Date} resumesAt - Date when the subscription should resume.
 * @returns {Promise<Document>}
 */
SubscriptionSchema.methods.pause = async function (resumesAt) {
  this.status = 'paused';
  this.pausedAt = new Date();
  this.resumesAt = resumesAt || null;
  return this.save();
};

/**
 * Resume a paused subscription.
 * @returns {Promise<Document>}
 */
SubscriptionSchema.methods.resume = async function () {
  this.status = 'active';
  this.pausedAt = null;
  this.resumesAt = null;
  return this.save();
};

/**
 * Renew the subscription period.
 * @param {Date} newPeriodStart
 * @param {Date} newPeriodEnd
 * @returns {Promise<Document>}
 */
SubscriptionSchema.methods.renew = async function (newPeriodStart, newPeriodEnd) {
  this.status = 'active';
  this.currentPeriodStart = newPeriodStart;
  this.currentPeriodEnd = newPeriodEnd;
  this.cancelAtPeriodEnd = false;
  this.canceledAt = null;
  return this.save();
};

/**
 * Check whether the subscription is currently in a usable state.
 * @returns {boolean}
 */
SubscriptionSchema.methods.isUsable = function () {
  const usableStatuses = ['active', 'trialing'];
  return usableStatuses.includes(this.status) && this.currentPeriodEnd > new Date();
};

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Get the active subscription for a user.
 * @param {ObjectId|string} userId
 * @returns {Promise<Document|null>}
 */
SubscriptionSchema.statics.getActiveForUser = function (userId) {
  return this.findOne({
    userId,
    status: { $in: ['active', 'trialing'] },
  }).populate('planId');
};

/**
 * Find subscriptions expiring within the next N days.
 * @param {number} days
 * @returns {Promise<Document[]>}
 */
SubscriptionSchema.statics.findExpiringSoon = function (days = 3) {
  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return this.find({
    status: { $in: ['active', 'trialing'] },
    currentPeriodEnd: { $gte: now, $lte: future },
  }).populate('userId planId');
};

// ─── Export ───────────────────────────────────────────────────────────────────

const Subscription = mongoose.model('Subscription', SubscriptionSchema);

module.exports = Subscription;
