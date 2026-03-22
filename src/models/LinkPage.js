'use strict';

const mongoose = require('mongoose');

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const ThemeSchema = new mongoose.Schema(
  {
    // Primary/background colour in hex
    primaryColor: {
      type: String,
      trim: true,
      match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'primaryColor must be a valid hex colour'],
      default: '#6366f1',
    },
    backgroundColor: {
      type: String,
      trim: true,
      match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'backgroundColor must be a valid hex colour'],
      default: '#ffffff',
    },
    textColor: {
      type: String,
      trim: true,
      match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'textColor must be a valid hex colour'],
      default: '#1f2937',
    },
    buttonColor: {
      type: String,
      trim: true,
      match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'buttonColor must be a valid hex colour'],
      default: '#6366f1',
    },
    buttonTextColor: {
      type: String,
      trim: true,
      default: '#ffffff',
    },
    fontFamily: {
      type: String,
      trim: true,
      default: 'Inter',
    },
    buttonStyle: {
      type: String,
      enum: ['rounded', 'square', 'pill'],
      default: 'rounded',
    },
    backgroundType: {
      type: String,
      enum: ['solid', 'gradient', 'image'],
      default: 'solid',
    },
    backgroundGradient: {
      type: String,
      trim: true,
      default: null,
    },
    backgroundImageUrl: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: false }
);

const LinkItemSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'link title is required'],
      trim: true,
      maxlength: [100, 'link title must be at most 100 characters'],
    },
    url: {
      type: String,
      required: [true, 'link url is required'],
      trim: true,
    },
    icon: {
      type: String,
      trim: true,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    clickCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    order: {
      type: Number,
      default: 0,
    },
    // Optional thumbnail image URL
    thumbnailUrl: {
      type: String,
      trim: true,
      default: null,
    },
    // Scheduling: only show link between these dates if set
    scheduledStart: {
      type: Date,
      default: null,
    },
    scheduledEnd: {
      type: Date,
      default: null,
    },
  },
  { _id: true }
);

// ─── Main Schema ──────────────────────────────────────────────────────────────

const LinkPageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },
    instagramAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InstagramAccount',
      default: null,
    },
    slug: {
      type: String,
      required: [true, 'slug is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9-_]+$/, 'slug can only contain lowercase letters, numbers, hyphens, and underscores'],
      minlength: [3, 'slug must be at least 3 characters'],
      maxlength: [50, 'slug must be at most 50 characters'],
    },
    title: {
      type: String,
      required: [true, 'title is required'],
      trim: true,
      maxlength: [100, 'title must be at most 100 characters'],
    },
    bio: {
      type: String,
      trim: true,
      maxlength: [300, 'bio must be at most 300 characters'],
      default: '',
    },
    avatar: {
      type: String,
      trim: true,
      default: null,
    },
    theme: {
      type: ThemeSchema,
      default: () => ({}),
    },
    links: {
      type: [LinkItemSchema],
      default: [],
      validate: {
        validator: (arr) => arr.length <= 50,
        message: 'A link page cannot have more than 50 links',
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    customDomain: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
      sparse: true,
    },
    seoTitle: {
      type: String,
      trim: true,
      maxlength: [70, 'seoTitle must be at most 70 characters'],
      default: '',
    },
    seoDescription: {
      type: String,
      trim: true,
      maxlength: [160, 'seoDescription must be at most 160 characters'],
      default: '',
    },
    totalViews: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalClicks: {
      type: Number,
      default: 0,
      min: 0,
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

LinkPageSchema.index({ slug: 1 }, { unique: true });
LinkPageSchema.index({ userId: 1 });
LinkPageSchema.index({ instagramAccountId: 1 }, { sparse: true });
LinkPageSchema.index({ customDomain: 1 }, { unique: true, sparse: true });
LinkPageSchema.index({ userId: 1, isActive: 1 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

LinkPageSchema.virtual('clickThroughRate').get(function () {
  if (!this.totalViews || this.totalViews === 0) return 0;
  return Math.round((this.totalClicks / this.totalViews) * 100);
});

LinkPageSchema.virtual('activeLinksCount').get(function () {
  return this.links.filter((l) => l.isActive).length;
});

LinkPageSchema.virtual('publicUrl').get(function () {
  const baseUrl = process.env.LINK_PAGE_BASE_URL || 'https://app.example.com/p';
  return `${baseUrl}/${this.slug}`;
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Increment the page view counter.
 * @returns {Promise<Document>}
 */
LinkPageSchema.methods.recordView = async function () {
  this.totalViews += 1;
  return this.save();
};

/**
 * Record a click on a specific link.
 * @param {ObjectId|string} linkId
 * @returns {Promise<Document>}
 */
LinkPageSchema.methods.recordClick = async function (linkId) {
  const link = this.links.id(linkId);
  if (!link) throw new Error(`Link not found: ${linkId}`);
  link.clickCount += 1;
  this.totalClicks += 1;
  return this.save();
};

/**
 * Add a new link to the page.
 * @param {object} linkData
 * @returns {Promise<Document>}
 */
LinkPageSchema.methods.addLink = async function (linkData) {
  if (this.links.length >= 50) {
    throw new Error('Cannot add more than 50 links to a page');
  }
  // Set order to end of list
  const maxOrder = this.links.reduce((max, l) => Math.max(max, l.order), -1);
  this.links.push({ ...linkData, order: maxOrder + 1 });
  return this.save();
};

/**
 * Remove a link by ID.
 * @param {ObjectId|string} linkId
 * @returns {Promise<Document>}
 */
LinkPageSchema.methods.removeLink = async function (linkId) {
  const link = this.links.id(linkId);
  if (!link) throw new Error(`Link not found: ${linkId}`);
  link.deleteOne();
  return this.save();
};

/**
 * Reorder links by providing an ordered array of link IDs.
 * @param {string[]} orderedIds - Array of link _id strings in desired order.
 * @returns {Promise<Document>}
 */
LinkPageSchema.methods.reorderLinks = async function (orderedIds) {
  orderedIds.forEach((id, index) => {
    const link = this.links.id(id);
    if (link) link.order = index;
  });
  return this.save();
};

/**
 * Get only the currently active, publicly visible links
 * respecting scheduling windows.
 * @returns {object[]}
 */
LinkPageSchema.methods.getVisibleLinks = function () {
  const now = new Date();
  return this.links
    .filter((l) => {
      if (!l.isActive) return false;
      if (l.scheduledStart && l.scheduledStart > now) return false;
      if (l.scheduledEnd && l.scheduledEnd < now) return false;
      return true;
    })
    .sort((a, b) => a.order - b.order);
};

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Find a link page by its slug (public lookup).
 * @param {string} slug
 * @returns {Promise<Document|null>}
 */
LinkPageSchema.statics.findBySlug = function (slug) {
  return this.findOne({ slug: slug.toLowerCase().trim(), isActive: true });
};

/**
 * Find a link page by custom domain.
 * @param {string} domain
 * @returns {Promise<Document|null>}
 */
LinkPageSchema.statics.findByCustomDomain = function (domain) {
  return this.findOne({ customDomain: domain.toLowerCase().trim(), isActive: true });
};

// ─── Export ───────────────────────────────────────────────────────────────────

const LinkPage = mongoose.model('LinkPage', LinkPageSchema);

module.exports = LinkPage;
