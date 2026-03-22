'use strict';

const mongoose = require('mongoose');

const COUPON_TYPES = ['percentage', 'fixed'];

const UsedByEntrySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    usedAt: {
      type: Date,
      default: Date.now,
    },
    discountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan',
      default: null,
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
      default: null,
    },
  },
  { _id: true }
);

const CouponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'Coupon code is required'],
      unique: true,
      uppercase: true,
      trim: true,
      minlength: [3, 'Coupon code must be at least 3 characters'],
      maxlength: [30, 'Coupon code must be at most 30 characters'],
      match: [/^[A-Z0-9_-]+$/, 'Coupon code can only contain uppercase letters, numbers, hyphens, and underscores'],
    },
    type: {
      type: String,
      enum: {
        values: COUPON_TYPES,
        message: `type must be one of: ${COUPON_TYPES.join(', ')}`,
      },
      required: [true, 'Coupon type is required'],
    },
    // For 'percentage': value is 0–100. For 'fixed': value is in smallest currency unit.
    value: {
      type: Number,
      required: [true, 'Coupon value is required'],
      min: [0, 'value cannot be negative'],
    },
    currency: {
      type: String,
      uppercase: true,
      trim: true,
      default: 'INR',
      maxlength: [3, 'Currency must be a 3-character ISO code'],
    },
    // Minimum order/plan amount required to use this coupon (in smallest unit)
    minAmount: {
      type: Number,
      default: 0,
      min: [0, 'minAmount cannot be negative'],
    },
    // Maximum number of total uses allowed (null = unlimited)
    maxUses: {
      type: Number,
      default: null,
      min: [1, 'maxUses must be at least 1'],
    },
    usedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    usedBy: {
      type: [UsedByEntrySchema],
      default: [],
    },
    // If empty, coupon applies to all plans
    applicablePlans: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Plan',
      },
    ],
    expiresAt: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Maximum number of times a single user can use this coupon (null = unlimited)
    maxUsesPerUser: {
      type: Number,
      default: 1,
      min: [1, 'maxUsesPerUser must be at least 1'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [300, 'description must be at most 300 characters'],
      default: '',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'createdBy is required'],
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

CouponSchema.index({ code: 1 }, { unique: true });
CouponSchema.index({ isActive: 1 });
CouponSchema.index({ expiresAt: 1 }, { sparse: true });
CouponSchema.index({ createdBy: 1 });
CouponSchema.index({ 'usedBy.userId': 1 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

CouponSchema.virtual('isExpired').get(function () {
  if (!this.expiresAt) return false;
  return this.expiresAt < new Date();
});

CouponSchema.virtual('isExhausted').get(function () {
  if (this.maxUses === null) return false;
  return this.usedCount >= this.maxUses;
});

CouponSchema.virtual('remainingUses').get(function () {
  if (this.maxUses === null) return Infinity;
  return Math.max(0, this.maxUses - this.usedCount);
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Validate the coupon for a given user and amount.
 * Throws descriptive errors when invalid.
 *
 * @param {object} params
 * @param {ObjectId|string} params.userId
 * @param {number} params.amount       - Order amount in smallest currency unit.
 * @param {ObjectId|string} [params.planId] - Plan being purchased (optional).
 * @returns {{ valid: true, discountAmount: number }}
 */
CouponSchema.methods.validate = function ({ userId, amount, planId = null }) {
  if (!this.isActive) {
    throw new Error('Coupon is not active');
  }

  if (this.isExpired) {
    throw new Error('Coupon has expired');
  }

  if (this.isExhausted) {
    throw new Error('Coupon has reached its maximum use limit');
  }

  if (amount < this.minAmount) {
    throw new Error(
      `Minimum order amount of ${this.currency} ${(this.minAmount / 100).toFixed(2)} required`
    );
  }

  // Check per-user usage limit
  const userUsageCount = this.usedBy.filter(
    (u) => u.userId.toString() === userId.toString()
  ).length;

  if (this.maxUsesPerUser !== null && userUsageCount >= this.maxUsesPerUser) {
    throw new Error('You have already used this coupon the maximum number of times');
  }

  // Check plan applicability
  if (planId && this.applicablePlans.length > 0) {
    const planIdStr = planId.toString();
    const applicable = this.applicablePlans.some((p) => p.toString() === planIdStr);
    if (!applicable) {
      throw new Error('Coupon is not applicable to the selected plan');
    }
  }

  const discountAmount = this.calculateDiscount(amount);

  return { valid: true, discountAmount };
};

/**
 * Calculate the discount amount for a given order amount.
 * @param {number} amount - In smallest currency unit.
 * @returns {number} Discount in smallest currency unit.
 */
CouponSchema.methods.calculateDiscount = function (amount) {
  if (this.type === 'percentage') {
    const pct = Math.min(100, Math.max(0, this.value));
    return Math.round((amount * pct) / 100);
  }
  // Fixed discount; cannot exceed the order amount
  return Math.min(this.value, amount);
};

/**
 * Apply the coupon to a transaction: record usage and increment counter.
 * Should be called within a transaction for atomicity in production.
 *
 * @param {object} params
 * @param {ObjectId|string} params.userId
 * @param {number} params.discountAmount
 * @param {ObjectId|string} [params.planId]
 * @param {ObjectId|string} [params.paymentId]
 * @returns {Promise<Document>}
 */
CouponSchema.methods.applyForUser = async function ({
  userId,
  discountAmount,
  planId = null,
  paymentId = null,
}) {
  this.usedBy.push({ userId, usedAt: new Date(), discountAmount, planId, paymentId });
  this.usedCount += 1;
  return this.save();
};

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Find an active, non-expired coupon by code.
 * @param {string} code
 * @returns {Promise<Document|null>}
 */
CouponSchema.statics.findByCode = function (code) {
  return this.findOne({
    code: code.toUpperCase().trim(),
    isActive: true,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  }).populate('applicablePlans', 'name slug');
};

/**
 * Validate and apply a coupon in a single call.
 * Returns the discount amount on success.
 *
 * @param {object} params
 * @param {string} params.code
 * @param {ObjectId|string} params.userId
 * @param {number} params.amount
 * @param {ObjectId|string} [params.planId]
 * @param {ObjectId|string} [params.paymentId]
 * @returns {Promise<{ coupon: Document, discountAmount: number }>}
 */
CouponSchema.statics.validateAndApply = async function ({
  code,
  userId,
  amount,
  planId = null,
  paymentId = null,
}) {
  const coupon = await this.findByCode(code);
  if (!coupon) {
    throw new Error('Invalid or expired coupon code');
  }

  const { discountAmount } = coupon.validate({ userId, amount, planId });
  await coupon.applyForUser({ userId, discountAmount, planId, paymentId });

  return { coupon, discountAmount };
};

// ─── Export ───────────────────────────────────────────────────────────────────

const Coupon = mongoose.model('Coupon', CouponSchema);

module.exports = Coupon;
