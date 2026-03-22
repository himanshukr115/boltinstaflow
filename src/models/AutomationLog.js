'use strict';

const mongoose = require('mongoose');

const LOG_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'];

const STEP_LOG_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'];

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const StepLogSchema = new mongoose.Schema(
  {
    stepId: {
      type: String,
      required: [true, 'stepId is required'],
      trim: true,
    },
    type: {
      type: String,
      trim: true,
      required: [true, 'step type is required'],
    },
    status: {
      type: String,
      enum: {
        values: STEP_LOG_STATUSES,
        message: `step.status must be one of: ${STEP_LOG_STATUSES.join(', ')}`,
      },
      default: 'pending',
    },
    input: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    output: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    error: {
      type: String,
      trim: true,
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    // Duration in milliseconds
    duration: {
      type: Number,
      default: null,
      min: 0,
    },
    retryCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false }
);

// ─── Main Schema ──────────────────────────────────────────────────────────────

const AutomationLogSchema = new mongoose.Schema(
  {
    automationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Automation',
      required: [true, 'automationId is required'],
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      default: null,
    },
    triggerType: {
      type: String,
      trim: true,
      required: [true, 'triggerType is required'],
    },
    triggerData: {
      // Raw trigger payload, e.g. { commentId, text, mediaId, ... }
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: {
        values: LOG_STATUSES,
        message: `status must be one of: ${LOG_STATUSES.join(', ')}`,
      },
      default: 'pending',
    },
    steps: {
      type: [StepLogSchema],
      default: [],
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    error: {
      type: String,
      trim: true,
      default: null,
    },
    // Total execution duration in milliseconds
    duration: {
      type: Number,
      default: null,
      min: 0,
    },
    metadata: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => new Map(),
    },
  },
  {
    // Only createdAt; no updatedAt to keep logs immutable-ish
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

AutomationLogSchema.index({ automationId: 1 });
AutomationLogSchema.index({ userId: 1 });
AutomationLogSchema.index({ contactId: 1 }, { sparse: true });
AutomationLogSchema.index({ automationId: 1, status: 1 });
AutomationLogSchema.index({ userId: 1, status: 1 });
AutomationLogSchema.index({ createdAt: -1 });
// TTL index: auto-delete logs older than 90 days
AutomationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

AutomationLogSchema.virtual('isComplete').get(function () {
  return this.status === 'completed' || this.status === 'failed' || this.status === 'skipped';
});

AutomationLogSchema.virtual('completedStepsCount').get(function () {
  return this.steps.filter((s) => s.status === 'completed').length;
});

AutomationLogSchema.virtual('failedStepsCount').get(function () {
  return this.steps.filter((s) => s.status === 'failed').length;
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Mark the execution as started.
 * @returns {Promise<Document>}
 */
AutomationLogSchema.methods.markStarted = async function () {
  this.status = 'running';
  this.startedAt = new Date();
  return this.save();
};

/**
 * Mark the execution as completed successfully.
 * @returns {Promise<Document>}
 */
AutomationLogSchema.methods.markCompleted = async function () {
  this.status = 'completed';
  this.completedAt = new Date();
  if (this.startedAt) {
    this.duration = this.completedAt.getTime() - this.startedAt.getTime();
  }
  return this.save();
};

/**
 * Mark the execution as failed.
 * @param {string} error - Error message or stack.
 * @returns {Promise<Document>}
 */
AutomationLogSchema.methods.markFailed = async function (error) {
  this.status = 'failed';
  this.completedAt = new Date();
  this.error = error;
  if (this.startedAt) {
    this.duration = this.completedAt.getTime() - this.startedAt.getTime();
  }
  return this.save();
};

/**
 * Update the log entry for a specific step.
 * @param {string} stepId
 * @param {object} update - Fields to update on the step log entry.
 * @returns {Promise<Document>}
 */
AutomationLogSchema.methods.updateStep = async function (stepId, update) {
  const step = this.steps.find((s) => s.stepId === stepId);
  if (!step) {
    throw new Error(`Step log not found for stepId: ${stepId}`);
  }
  Object.assign(step, update);

  if (update.status === 'completed' && step.startedAt) {
    step.completedAt = step.completedAt || new Date();
    step.duration = step.completedAt.getTime() - step.startedAt.getTime();
  }
  if (update.status === 'failed' && step.startedAt) {
    step.completedAt = step.completedAt || new Date();
    step.duration = step.completedAt.getTime() - step.startedAt.getTime();
  }

  return this.save();
};

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Get recent logs for an automation.
 * @param {ObjectId|string} automationId
 * @param {number} [limit=50]
 * @returns {Promise<Document[]>}
 */
AutomationLogSchema.statics.getRecentForAutomation = function (automationId, limit = 50) {
  return this.find({ automationId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('contactId', 'username displayName instagramUserId');
};

/**
 * Count logs by status for an automation.
 * @param {ObjectId|string} automationId
 * @returns {Promise<object[]>}
 */
AutomationLogSchema.statics.statusSummary = function (automationId) {
  return this.aggregate([
    { $match: { automationId: new mongoose.Types.ObjectId(automationId) } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        avgDuration: { $avg: '$duration' },
      },
    },
  ]);
};

// ─── Export ───────────────────────────────────────────────────────────────────

const AutomationLog = mongoose.model('AutomationLog', AutomationLogSchema);

module.exports = AutomationLog;
