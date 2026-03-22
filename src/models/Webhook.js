'use strict';

const mongoose = require('mongoose');

const WEBHOOK_SOURCES = ['instagram', 'razorpay', 'cashfree'];
const WEBHOOK_STATUSES = ['received', 'processing', 'processed', 'failed'];

const WebhookSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: {
        values: WEBHOOK_SOURCES,
        message: `source must be one of: ${WEBHOOK_SOURCES.join(', ')}`,
      },
      required: [true, 'source is required'],
    },
    eventType: {
      type: String,
      required: [true, 'eventType is required'],
      trim: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: [true, 'payload is required'],
    },
    // Raw signature header from the provider
    signature: {
      type: String,
      trim: true,
      default: null,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: {
        values: WEBHOOK_STATUSES,
        message: `status must be one of: ${WEBHOOK_STATUSES.join(', ')}`,
      },
      default: 'received',
    },
    processingError: {
      type: String,
      trim: true,
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    retryCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    nextRetryAt: {
      type: Date,
      default: null,
    },
    // IP address from which the webhook was received (for allow-listing validation)
    sourceIp: {
      type: String,
      trim: true,
      default: null,
    },
    // Raw request headers (useful for debugging)
    headers: {
      type: Map,
      of: String,
      default: () => new Map(),
      select: false,
    },
  },
  {
    // Webhooks are append-only; no updatedAt column needed (we track status changes)
    timestamps: { createdAt: true, updatedAt: true },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

WebhookSchema.index({ source: 1 });
WebhookSchema.index({ status: 1 });
WebhookSchema.index({ createdAt: -1 });
WebhookSchema.index({ source: 1, status: 1 });
WebhookSchema.index({ source: 1, eventType: 1 });
WebhookSchema.index({ status: 1, nextRetryAt: 1 });
// TTL index: auto-delete processed webhooks after 30 days
WebhookSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

WebhookSchema.virtual('isProcessed').get(function () {
  return this.status === 'processed';
});

WebhookSchema.virtual('hasFailed').get(function () {
  return this.status === 'failed';
});

WebhookSchema.virtual('canRetry').get(function () {
  return this.status === 'failed' && this.retryCount < 5;
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Mark this webhook as currently being processed.
 * @returns {Promise<Document>}
 */
WebhookSchema.methods.markProcessing = async function () {
  this.status = 'processing';
  return this.save();
};

/**
 * Mark this webhook as successfully processed.
 * @returns {Promise<Document>}
 */
WebhookSchema.methods.markProcessed = async function () {
  this.status = 'processed';
  this.processedAt = new Date();
  this.processingError = null;
  return this.save();
};

/**
 * Mark this webhook as failed and schedule a retry with exponential back-off.
 * @param {string} error - Error message or description.
 * @returns {Promise<Document>}
 */
WebhookSchema.methods.markFailed = async function (error) {
  this.status = 'failed';
  this.processingError = error;
  this.retryCount += 1;

  if (this.retryCount < 5) {
    // Exponential back-off: 1min, 5min, 15min, 60min, 240min
    const backoffMinutes = [1, 5, 15, 60, 240];
    const delayMs = backoffMinutes[this.retryCount - 1] * 60 * 1000;
    this.nextRetryAt = new Date(Date.now() + delayMs);
  } else {
    this.nextRetryAt = null; // No more retries
  }

  return this.save();
};

/**
 * Reset for retry.
 * @returns {Promise<Document>}
 */
WebhookSchema.methods.resetForRetry = async function () {
  if (!this.canRetry) {
    throw new Error('This webhook has exceeded maximum retry attempts');
  }
  this.status = 'received';
  this.processingError = null;
  this.nextRetryAt = null;
  return this.save();
};

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Find all webhook events that are due for retry.
 * @returns {Promise<Document[]>}
 */
WebhookSchema.statics.findDueForRetry = function () {
  return this.find({
    status: 'failed',
    retryCount: { $lt: 5 },
    nextRetryAt: { $lte: new Date() },
  }).sort({ nextRetryAt: 1 });
};

/**
 * Find pending/unprocessed webhooks for a source.
 * @param {string} source
 * @param {number} [limit=100]
 * @returns {Promise<Document[]>}
 */
WebhookSchema.statics.findPendingForSource = function (source, limit = 100) {
  return this.find({ source, status: 'received' })
    .sort({ createdAt: 1 })
    .limit(limit);
};

/**
 * Record a new incoming webhook event.
 * @param {object} params
 * @returns {Promise<Document>}
 */
WebhookSchema.statics.record = function ({
  source,
  eventType,
  payload,
  signature = null,
  sourceIp = null,
  headers = {},
}) {
  return this.create({
    source,
    eventType,
    payload,
    signature,
    sourceIp,
    headers,
    isVerified: false,
    status: 'received',
  });
};

// ─── Export ───────────────────────────────────────────────────────────────────

const Webhook = mongoose.model('Webhook', WebhookSchema);

module.exports = Webhook;
