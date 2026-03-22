'use strict';

const mongoose = require('mongoose');

const CAMPAIGN_TYPES = ['broadcast', 'sequence', 'story_reply'];
const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'running', 'completed', 'failed', 'paused'];

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const CtaButtonSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['url', 'phone', 'postback'],
      required: true,
    },
    title: { type: String, trim: true, maxlength: 20, required: true },
    payload: { type: String, trim: true, required: true },
  },
  { _id: false }
);

const QuickReplySchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, maxlength: 20, required: true },
    payload: { type: String, trim: true, required: true },
    imageUrl: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const MediaAttachmentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['image', 'video', 'audio', 'file'],
      required: true,
    },
    url: { type: String, trim: true, required: true },
    caption: { type: String, trim: true, maxlength: 500, default: '' },
    mimeType: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const MessageSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      trim: true,
      maxlength: [2000, 'Message text must be at most 2000 characters'],
      default: '',
    },
    media: {
      type: MediaAttachmentSchema,
      default: null,
    },
    ctaButton: {
      type: CtaButtonSchema,
      default: null,
    },
    quickReplies: {
      type: [QuickReplySchema],
      default: [],
      validate: {
        validator: (arr) => arr.length <= 13,
        message: 'Cannot have more than 13 quick replies',
      },
    },
  },
  { _id: false }
);

const BroadcastLogEntrySchema = new mongoose.Schema(
  {
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      required: true,
    },
    instagramUserId: { type: String, trim: true },
    status: {
      type: String,
      enum: ['pending', 'sent', 'delivered', 'failed', 'replied'],
      default: 'pending',
    },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    repliedAt: { type: Date, default: null },
    failureReason: { type: String, trim: true, default: null },
    messageId: { type: String, trim: true, default: null },
  },
  { _id: true }
);

const AudienceFilterSchema = new mongoose.Schema(
  {
    tags: { type: [String], default: [] },
    excludeTags: { type: [String], default: [] },
    isFollower: { type: Boolean, default: null },
    dmOptIn: { type: Boolean, default: true },
    minLeadScore: { type: Number, default: 0 },
    maxLeadScore: { type: Number, default: 100 },
    source: { type: [String], default: [] },
    contactIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Contact' }],
      default: [],
    },
  },
  { _id: false }
);

// ─── Main Schema ──────────────────────────────────────────────────────────────

const CampaignSchema = new mongoose.Schema(
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
    type: {
      type: String,
      enum: {
        values: CAMPAIGN_TYPES,
        message: `type must be one of: ${CAMPAIGN_TYPES.join(', ')}`,
      },
      required: [true, 'campaign type is required'],
    },
    status: {
      type: String,
      enum: {
        values: CAMPAIGN_STATUSES,
        message: `status must be one of: ${CAMPAIGN_STATUSES.join(', ')}`,
      },
      default: 'draft',
    },
    audienceFilter: {
      type: AudienceFilterSchema,
      default: () => ({}),
    },
    message: {
      type: MessageSchema,
      required: [true, 'message is required'],
    },
    scheduledAt: {
      type: Date,
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
    // Delivery stats
    totalTargeted: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalSent: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalDelivered: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalFailed: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalReplied: {
      type: Number,
      default: 0,
      min: 0,
    },
    broadcastLog: {
      type: [BroadcastLogEntrySchema],
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

CampaignSchema.index({ userId: 1 });
CampaignSchema.index({ instagramAccountId: 1 });
CampaignSchema.index({ userId: 1, status: 1 });
CampaignSchema.index({ userId: 1, type: 1 });
CampaignSchema.index({ scheduledAt: 1, status: 1 });
CampaignSchema.index({ createdAt: -1 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

CampaignSchema.virtual('deliveryRate').get(function () {
  if (!this.totalSent || this.totalSent === 0) return 0;
  return Math.round((this.totalDelivered / this.totalSent) * 100);
});

CampaignSchema.virtual('replyRate').get(function () {
  if (!this.totalDelivered || this.totalDelivered === 0) return 0;
  return Math.round((this.totalReplied / this.totalDelivered) * 100);
});

CampaignSchema.virtual('failureRate').get(function () {
  if (!this.totalTargeted || this.totalTargeted === 0) return 0;
  return Math.round((this.totalFailed / this.totalTargeted) * 100);
});

CampaignSchema.virtual('isScheduled').get(function () {
  return this.status === 'scheduled' && this.scheduledAt !== null;
});

// ─── Pre-save Hooks ───────────────────────────────────────────────────────────

CampaignSchema.pre('save', function (next) {
  // Set startedAt when campaign transitions to running
  if (this.isModified('status') && this.status === 'running' && !this.startedAt) {
    this.startedAt = new Date();
  }
  // Set completedAt when campaign transitions to completed or failed
  if (
    this.isModified('status') &&
    (this.status === 'completed' || this.status === 'failed') &&
    !this.completedAt
  ) {
    this.completedAt = new Date();
  }
  return next();
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Start the campaign.
 * @returns {Promise<Document>}
 */
CampaignSchema.methods.start = async function () {
  this.status = 'running';
  this.startedAt = this.startedAt || new Date();
  return this.save();
};

/**
 * Pause the campaign.
 * @returns {Promise<Document>}
 */
CampaignSchema.methods.pause = async function () {
  if (this.status !== 'running') {
    throw new Error('Can only pause a running campaign');
  }
  this.status = 'paused';
  return this.save();
};

/**
 * Resume a paused campaign.
 * @returns {Promise<Document>}
 */
CampaignSchema.methods.resume = async function () {
  if (this.status !== 'paused') {
    throw new Error('Can only resume a paused campaign');
  }
  this.status = 'running';
  return this.save();
};

/**
 * Mark the campaign as complete.
 * @returns {Promise<Document>}
 */
CampaignSchema.methods.complete = async function () {
  this.status = 'completed';
  this.completedAt = new Date();
  return this.save();
};

/**
 * Mark the campaign as failed.
 * @param {string} [reason]
 * @returns {Promise<Document>}
 */
CampaignSchema.methods.fail = async function (reason) {
  this.status = 'failed';
  this.completedAt = new Date();
  if (reason) {
    this.metadata.set('failureReason', reason);
  }
  return this.save();
};

/**
 * Update a broadcast log entry status.
 * @param {ObjectId|string} contactId
 * @param {'sent'|'delivered'|'failed'|'replied'} newStatus
 * @param {object} [extra] - Additional fields to set (e.g. messageId, failureReason).
 * @returns {Promise<Document>}
 */
CampaignSchema.methods.updateBroadcastLog = async function (contactId, newStatus, extra = {}) {
  const entry = this.broadcastLog.find(
    (e) => e.contactId.toString() === contactId.toString()
  );
  if (!entry) {
    throw new Error(`Broadcast log entry not found for contact ${contactId}`);
  }

  entry.status = newStatus;
  const now = new Date();

  if (newStatus === 'sent') {
    entry.sentAt = now;
    this.totalSent += 1;
  } else if (newStatus === 'delivered') {
    entry.deliveredAt = now;
    this.totalDelivered += 1;
  } else if (newStatus === 'replied') {
    entry.repliedAt = now;
    this.totalReplied += 1;
  } else if (newStatus === 'failed') {
    entry.failureReason = extra.failureReason || 'Unknown error';
    this.totalFailed += 1;
  }

  Object.assign(entry, extra);
  return this.save();
};

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Find campaigns that are scheduled to run now or in the past.
 * @returns {Promise<Document[]>}
 */
CampaignSchema.statics.findDueScheduled = function () {
  return this.find({
    status: 'scheduled',
    scheduledAt: { $lte: new Date() },
  });
};

/**
 * Get campaign performance summary for a user.
 * @param {ObjectId|string} userId
 * @returns {Promise<object[]>}
 */
CampaignSchema.statics.getPerformanceSummary = function (userId) {
  return this.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId), status: 'completed' } },
    {
      $group: {
        _id: '$type',
        totalCampaigns: { $sum: 1 },
        totalTargeted: { $sum: '$totalTargeted' },
        totalSent: { $sum: '$totalSent' },
        totalDelivered: { $sum: '$totalDelivered' },
        totalReplied: { $sum: '$totalReplied' },
        totalFailed: { $sum: '$totalFailed' },
      },
    },
  ]);
};

// ─── Export ───────────────────────────────────────────────────────────────────

const Campaign = mongoose.model('Campaign', CampaignSchema);

module.exports = Campaign;
