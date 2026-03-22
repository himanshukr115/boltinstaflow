'use strict';

const mongoose = require('mongoose');

const CONTACT_SOURCES = [
  'dm_reply',
  'comment_reply',
  'story_mention',
  'follow',
  'manual',
  'import',
  'campaign',
  'automation',
  'api',
];

const ContactSchema = new mongoose.Schema(
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
    instagramUserId: {
      type: String,
      required: [true, 'instagramUserId is required'],
      trim: true,
    },
    username: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
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
    isFollower: {
      type: Boolean,
      default: false,
    },
    tags: {
      type: [{ type: String, trim: true, lowercase: true }],
      default: [],
    },
    customFields: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => new Map(),
    },
    leadScore: {
      type: Number,
      default: 0,
      min: [0, 'leadScore cannot be negative'],
      max: [100, 'leadScore cannot exceed 100'],
    },
    firstSeenAt: {
      type: Date,
      default: Date.now,
    },
    lastInteractedAt: {
      type: Date,
      default: null,
    },
    // DM opt-in/out tracking
    dmOptIn: {
      type: Boolean,
      default: false,
    },
    dmOptInAt: {
      type: Date,
      default: null,
    },
    dmOptOut: {
      type: Boolean,
      default: false,
    },
    dmOptOutAt: {
      type: Date,
      default: null,
    },
    totalDmsSent: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalDmsReceived: {
      type: Number,
      default: 0,
      min: 0,
    },
    isBlocked: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    source: {
      type: String,
      enum: {
        values: CONTACT_SOURCES,
        message: `source must be one of: ${CONTACT_SOURCES.join(', ')}`,
      },
      default: 'manual',
    },
    sourceDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [2000, 'Notes must be at most 2000 characters'],
      default: '',
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

ContactSchema.index({ userId: 1 });
ContactSchema.index({ instagramAccountId: 1 });
ContactSchema.index({ instagramUserId: 1 });
// Unique contact per Instagram account per IG user
ContactSchema.index(
  { instagramAccountId: 1, instagramUserId: 1 },
  { unique: true }
);
ContactSchema.index({ userId: 1, instagramAccountId: 1 });
ContactSchema.index({ userId: 1, isActive: 1 });
ContactSchema.index({ userId: 1, dmOptIn: 1, isActive: 1 });
ContactSchema.index({ tags: 1 });
ContactSchema.index({ leadScore: -1 });
ContactSchema.index({ lastInteractedAt: -1 });
ContactSchema.index({ createdAt: -1 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

ContactSchema.virtual('canReceiveDm').get(function () {
  return this.isActive && !this.isBlocked && !this.dmOptOut && this.dmOptIn;
});

ContactSchema.virtual('engagementRate').get(function () {
  const total = this.totalDmsSent + this.totalDmsReceived;
  if (total === 0) return 0;
  return Math.round((this.totalDmsReceived / total) * 100);
});

// ─── Pre-save Hooks ───────────────────────────────────────────────────────────

ContactSchema.pre('save', function (next) {
  // Ensure dmOptOut timestamp is set
  if (this.isModified('dmOptOut') && this.dmOptOut && !this.dmOptOutAt) {
    this.dmOptOutAt = new Date();
  }
  // Ensure dmOptIn timestamp is set
  if (this.isModified('dmOptIn') && this.dmOptIn && !this.dmOptInAt) {
    this.dmOptInAt = new Date();
  }
  // If user opts out, clear opt-in
  if (this.isModified('dmOptOut') && this.dmOptOut) {
    this.dmOptIn = false;
  }
  return next();
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Opt this contact in to DM communications.
 * @returns {Promise<Document>}
 */
ContactSchema.methods.optInToDm = async function () {
  this.dmOptIn = true;
  this.dmOptInAt = new Date();
  this.dmOptOut = false;
  this.dmOptOutAt = null;
  return this.save();
};

/**
 * Opt this contact out of DM communications.
 * @returns {Promise<Document>}
 */
ContactSchema.methods.optOutOfDm = async function () {
  this.dmOptOut = true;
  this.dmOptOutAt = new Date();
  this.dmOptIn = false;
  return this.save();
};

/**
 * Add a tag to this contact (no duplicates).
 * @param {string} tag
 * @returns {Promise<Document>}
 */
ContactSchema.methods.addTag = async function (tag) {
  const normalised = tag.trim().toLowerCase();
  if (!this.tags.includes(normalised)) {
    this.tags.push(normalised);
    await this.save();
  }
  return this;
};

/**
 * Remove a tag from this contact.
 * @param {string} tag
 * @returns {Promise<Document>}
 */
ContactSchema.methods.removeTag = async function (tag) {
  const normalised = tag.trim().toLowerCase();
  this.tags = this.tags.filter((t) => t !== normalised);
  return this.save();
};

/**
 * Update the lead score clamped to [0, 100].
 * @param {number} score
 * @returns {Promise<Document>}
 */
ContactSchema.methods.setLeadScore = async function (score) {
  this.leadScore = Math.min(100, Math.max(0, Math.round(score)));
  return this.save();
};

/**
 * Record a DM interaction.
 * @param {'sent'|'received'} direction
 * @returns {Promise<Document>}
 */
ContactSchema.methods.recordDm = async function (direction) {
  if (direction === 'sent') {
    this.totalDmsSent += 1;
  } else if (direction === 'received') {
    this.totalDmsReceived += 1;
  }
  this.lastInteractedAt = new Date();
  return this.save();
};

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Find or create a contact by Instagram user ID within an account.
 * @param {object} params
 * @returns {Promise<{ doc: Document, created: boolean }>}
 */
ContactSchema.statics.findOrCreate = async function ({
  userId,
  instagramAccountId,
  instagramUserId,
  username,
  displayName,
  profilePicUrl,
  source,
  sourceDetails,
}) {
  let doc = await this.findOne({ instagramAccountId, instagramUserId });
  let created = false;

  if (!doc) {
    doc = await this.create({
      userId,
      instagramAccountId,
      instagramUserId,
      username,
      displayName,
      profilePicUrl,
      source: source || 'manual',
      sourceDetails,
      firstSeenAt: new Date(),
    });
    created = true;
  } else {
    // Update mutable fields if provided
    let dirty = false;
    if (username && doc.username !== username.toLowerCase()) {
      doc.username = username.toLowerCase();
      dirty = true;
    }
    if (displayName && doc.displayName !== displayName) {
      doc.displayName = displayName;
      dirty = true;
    }
    if (profilePicUrl && doc.profilePicUrl !== profilePicUrl) {
      doc.profilePicUrl = profilePicUrl;
      dirty = true;
    }
    if (dirty) await doc.save();
  }

  return { doc, created };
};

/**
 * Get contacts eligible for DM broadcast.
 * @param {ObjectId|string} instagramAccountId
 * @returns {Promise<Document[]>}
 */
ContactSchema.statics.getDmEligible = function (instagramAccountId) {
  return this.find({
    instagramAccountId,
    isActive: true,
    isBlocked: false,
    dmOptOut: false,
    dmOptIn: true,
  });
};

// ─── Export ───────────────────────────────────────────────────────────────────

const Contact = mongoose.model('Contact', ContactSchema);

module.exports = Contact;
