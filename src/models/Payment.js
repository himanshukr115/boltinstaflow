'use strict';

const mongoose = require('mongoose');

const PAYMENT_STATUSES = [
  'pending',
  'authorized',
  'captured',
  'failed',
  'refunded',
  'partially_refunded',
];

const PAYMENT_TYPES = ['subscription', 'one_time', 'upgrade', 'refund'];
const GATEWAYS = ['razorpay', 'cashfree', 'manual'];

const WebhookEventSchema = new mongoose.Schema(
  {
    eventType: { type: String, trim: true, required: true },
    payload: { type: mongoose.Schema.Types.Mixed },
    receivedAt: { type: Date, default: Date.now },
    isProcessed: { type: Boolean, default: false },
  },
  { _id: true }
);

const PaymentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      default: null,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan',
      default: null,
    },
    // amount in smallest currency unit (e.g. paise for INR, cents for USD)
    amount: {
      type: Number,
      required: [true, 'amount is required'],
      min: [0, 'amount cannot be negative'],
    },
    currency: {
      type: String,
      uppercase: true,
      trim: true,
      default: 'INR',
      maxlength: [3, 'Currency must be a 3-character ISO code'],
    },
    gateway: {
      type: String,
      enum: {
        values: GATEWAYS,
        message: `gateway must be one of: ${GATEWAYS.join(', ')}`,
      },
      required: [true, 'gateway is required'],
    },
    gatewayPaymentId: {
      type: String,
      trim: true,
      default: null,
    },
    gatewayOrderId: {
      type: String,
      trim: true,
      default: null,
    },
    status: {
      type: String,
      enum: {
        values: PAYMENT_STATUSES,
        message: `status must be one of: ${PAYMENT_STATUSES.join(', ')}`,
      },
      default: 'pending',
    },
    type: {
      type: String,
      enum: {
        values: PAYMENT_TYPES,
        message: `type must be one of: ${PAYMENT_TYPES.join(', ')}`,
      },
      required: [true, 'Payment type is required'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Description must be at most 500 characters'],
      default: '',
    },
    invoiceNumber: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      default: null,
    },
    invoiceUrl: {
      type: String,
      trim: true,
      default: null,
    },
    failureReason: {
      type: String,
      trim: true,
      default: null,
    },
    refundAmount: {
      type: Number,
      min: [0, 'refundAmount cannot be negative'],
      default: 0,
    },
    refundedAt: {
      type: Date,
      default: null,
    },
    metadata: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => new Map(),
    },
    webhookEvents: {
      type: [WebhookEventSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

PaymentSchema.index({ userId: 1 });
PaymentSchema.index({ status: 1 });
PaymentSchema.index({ gateway: 1 });
PaymentSchema.index({ gatewayPaymentId: 1 }, { sparse: true });
PaymentSchema.index({ gatewayOrderId: 1 }, { sparse: true });
PaymentSchema.index({ invoiceNumber: 1 }, { unique: true, sparse: true });
PaymentSchema.index({ subscriptionId: 1 }, { sparse: true });
PaymentSchema.index({ userId: 1, status: 1 });
PaymentSchema.index({ userId: 1, createdAt: -1 });
PaymentSchema.index({ createdAt: -1 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

PaymentSchema.virtual('amountFormatted').get(function () {
  return `${this.currency} ${(this.amount / 100).toFixed(2)}`;
});

PaymentSchema.virtual('refundAmountFormatted').get(function () {
  return `${this.currency} ${(this.refundAmount / 100).toFixed(2)}`;
});

PaymentSchema.virtual('netAmount').get(function () {
  return this.amount - (this.refundAmount || 0);
});

PaymentSchema.virtual('isRefunded').get(function () {
  return this.status === 'refunded' || this.status === 'partially_refunded';
});

// ─── Pre-save Hook ────────────────────────────────────────────────────────────

PaymentSchema.pre('save', async function (next) {
  // Auto-generate invoice number on first capture
  if (
    this.isModified('status') &&
    this.status === 'captured' &&
    !this.invoiceNumber
  ) {
    try {
      this.invoiceNumber = await generateInvoiceNumber();
    } catch (err) {
      return next(err);
    }
  }
  return next();
});

// ─── Invoice Number Generator ─────────────────────────────────────────────────

/**
 * Generates a unique invoice number in the format INV-YYYYMM-XXXXXX.
 * Uses the Payment collection to determine the next sequential number.
 * @returns {Promise<string>}
 */
async function generateInvoiceNumber() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `INV-${year}${month}-`;

  // Count existing invoices this month to determine sequence
  const Payment = mongoose.model('Payment');
  const count = await Payment.countDocuments({
    invoiceNumber: { $regex: `^${prefix}` },
  });

  const sequence = String(count + 1).padStart(6, '0');
  return `${prefix}${sequence}`;
}

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Mark the payment as captured (successful).
 * @param {string} gatewayPaymentId
 * @returns {Promise<Document>}
 */
PaymentSchema.methods.markCaptured = async function (gatewayPaymentId) {
  this.status = 'captured';
  if (gatewayPaymentId) this.gatewayPaymentId = gatewayPaymentId;
  return this.save();
};

/**
 * Mark the payment as failed.
 * @param {string} reason
 * @returns {Promise<Document>}
 */
PaymentSchema.methods.markFailed = async function (reason) {
  this.status = 'failed';
  this.failureReason = reason || 'Unknown failure';
  return this.save();
};

/**
 * Process a full or partial refund.
 * @param {number} refundAmount - Amount to refund in smallest currency unit.
 * @returns {Promise<Document>}
 */
PaymentSchema.methods.processRefund = async function (refundAmount) {
  if (refundAmount <= 0) throw new Error('Refund amount must be positive');
  if (refundAmount > this.amount) throw new Error('Refund amount exceeds payment amount');

  this.refundAmount = (this.refundAmount || 0) + refundAmount;
  this.refundedAt = new Date();
  this.status = this.refundAmount >= this.amount ? 'refunded' : 'partially_refunded';
  return this.save();
};

/**
 * Append a webhook event record to this payment.
 * @param {string} eventType
 * @param {object} payload
 * @returns {Promise<Document>}
 */
PaymentSchema.methods.addWebhookEvent = async function (eventType, payload) {
  this.webhookEvents.push({ eventType, payload, receivedAt: new Date() });
  return this.save();
};

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Get payment history for a user, newest first.
 * @param {ObjectId|string} userId
 * @param {number} [limit=20]
 * @param {number} [skip=0]
 * @returns {Promise<Document[]>}
 */
PaymentSchema.statics.getForUser = function (userId, limit = 20, skip = 0) {
  return this.find({ userId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('planId', 'name slug');
};

/**
 * Find a payment by gateway payment ID.
 * @param {string} gatewayPaymentId
 * @returns {Promise<Document|null>}
 */
PaymentSchema.statics.findByGatewayPaymentId = function (gatewayPaymentId) {
  return this.findOne({ gatewayPaymentId });
};

/**
 * Aggregate total revenue for a given date range.
 * @param {Date} startDate
 * @param {Date} endDate
 * @returns {Promise<{total: number, currency: string}[]>}
 */
PaymentSchema.statics.aggregateRevenue = function (startDate, endDate) {
  return this.aggregate([
    {
      $match: {
        status: 'captured',
        createdAt: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: '$currency',
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        currency: '$_id',
        total: 1,
        count: 1,
        _id: 0,
      },
    },
  ]);
};

// ─── Export ───────────────────────────────────────────────────────────────────

const Payment = mongoose.model('Payment', PaymentSchema);

module.exports = Payment;
