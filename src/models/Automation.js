'use strict';

const mongoose = require('mongoose');

const TRIGGER_TYPES = [
  'keyword_comment',
  'dm_keyword',
  'story_mention',
  'follow',
  'unfollow',
  'post_like',
];

const AUTOMATION_STATUSES = ['draft', 'active', 'paused', 'archived'];

const STEP_TYPES = [
  'send_dm',
  'send_comment_reply',
  'add_tag',
  'remove_tag',
  'wait',
  'condition',
  'update_contact',
  'notify_admin',
  'webhook',
];

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const StepSchema = new mongoose.Schema(
  {
    stepId: {
      type: String,
      required: [true, 'stepId is required'],
      trim: true,
    },
    type: {
      type: String,
      enum: {
        values: STEP_TYPES,
        message: `step.type must be one of: ${STEP_TYPES.join(', ')}`,
      },
      required: [true, 'step.type is required'],
    },
    config: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Delay before executing this step (in seconds)
    delay: {
      type: Number,
      default: 0,
      min: [0, 'delay cannot be negative'],
    },
    // Index within the workflow sequence (0-based)
    order: {
      type: Number,
      default: 0,
      min: 0,
    },
    // ID of the next step to execute (supports branching)
    nextStepId: {
      type: String,
      default: null,
    },
    // Conditional branching: { condition, trueStepId, falseStepId }
    branches: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { _id: false }
);

const AutomationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },
    instagramAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InstagramAccount',
      required: [true, 'instagramAccountId is required'],
    },
    name: {
      type: String,
      required: [true, 'name is required'],
      trim: true,
      maxlength: [100, 'name must be at most 100 characters'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'description must be at most 500 characters'],
      default: '',
    },
    triggerType: {
      type: String,
      enum: {
        values: TRIGGER_TYPES,
        message: `triggerType must be one of: ${TRIGGER_TYPES.join(', ')}`,
      },
      required: [true, 'triggerType is required'],
    },
    triggerConfig: {
      // Flexible object: e.g. { keywords: ['hi', 'hello'], postId: '...', caseSensitive: false }
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    isActive: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: {
        values: AUTOMATION_STATUSES,
        message: `status must be one of: ${AUTOMATION_STATUSES.join(', ')}`,
      },
      default: 'draft',
    },
    steps: {
      type: [StepSchema],
      default: [],
      validate: {
        validator: function (steps) {
          return steps.length <= 50;
        },
        message: 'An automation cannot have more than 50 steps',
      },
    },
    // Execution stats
    totalTriggered: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalCompleted: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalFailed: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastTriggeredAt: {
      type: Date,
      default: null,
    },
    tags: {
      type: [{ type: String, trim: true, lowercase: true }],
      default: [],
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

AutomationSchema.index({ userId: 1 });
AutomationSchema.index({ instagramAccountId: 1 });
AutomationSchema.index({ userId: 1, status: 1 });
AutomationSchema.index({ userId: 1, isActive: 1 });
AutomationSchema.index({ instagramAccountId: 1, triggerType: 1, isActive: 1 });
AutomationSchema.index({ tags: 1 });
AutomationSchema.index({ createdAt: -1 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

AutomationSchema.virtual('successRate').get(function () {
  if (this.totalTriggered === 0) return 0;
  return Math.round((this.totalCompleted / this.totalTriggered) * 100);
});

AutomationSchema.virtual('stepCount').get(function () {
  return this.steps.length;
});

// ─── Pre-save Hooks ───────────────────────────────────────────────────────────

AutomationSchema.pre('save', function (next) {
  // Sync isActive with status
  if (this.isModified('status')) {
    this.isActive = this.status === 'active';
  }
  if (this.isModified('isActive')) {
    if (this.isActive && this.status !== 'active') {
      this.status = 'active';
    } else if (!this.isActive && this.status === 'active') {
      this.status = 'paused';
    }
  }
  return next();
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Activate this automation.
 * @returns {Promise<Document>}
 */
AutomationSchema.methods.activate = async function () {
  this.status = 'active';
  this.isActive = true;
  return this.save();
};

/**
 * Pause this automation.
 * @returns {Promise<Document>}
 */
AutomationSchema.methods.pause = async function () {
  this.status = 'paused';
  this.isActive = false;
  return this.save();
};

/**
 * Archive this automation (soft delete).
 * @returns {Promise<Document>}
 */
AutomationSchema.methods.archive = async function () {
  this.status = 'archived';
  this.isActive = false;
  return this.save();
};

/**
 * Record a trigger event.
 * @returns {Promise<Document>}
 */
AutomationSchema.methods.recordTrigger = async function () {
  this.totalTriggered += 1;
  this.lastTriggeredAt = new Date();
  return this.save();
};

/**
 * Record a completed execution.
 * @returns {Promise<Document>}
 */
AutomationSchema.methods.recordCompletion = async function () {
  this.totalCompleted += 1;
  return this.save();
};

/**
 * Record a failed execution.
 * @returns {Promise<Document>}
 */
AutomationSchema.methods.recordFailure = async function () {
  this.totalFailed += 1;
  return this.save();
};

/**
 * Get an ordered list of steps.
 * @returns {object[]}
 */
AutomationSchema.methods.getOrderedSteps = function () {
  return [...this.steps].sort((a, b) => a.order - b.order);
};

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Find active automations for a given Instagram account and trigger type.
 * @param {ObjectId|string} instagramAccountId
 * @param {string} triggerType
 * @returns {Promise<Document[]>}
 */
AutomationSchema.statics.findActiveByTrigger = function (instagramAccountId, triggerType) {
  return this.find({
    instagramAccountId,
    triggerType,
    isActive: true,
    status: 'active',
  });
};

// ─── Export ───────────────────────────────────────────────────────────────────

const Automation = mongoose.model('Automation', AutomationSchema);

module.exports = Automation;
