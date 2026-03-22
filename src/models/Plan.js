'use strict';

const mongoose = require('mongoose');

/**
 * Converts a human-readable string to a URL-safe slug.
 * @param {string} str
 * @returns {string}
 */
function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')       // spaces and underscores → hyphens
    .replace(/[^a-z0-9-]/g, '')    // remove non-alphanumeric / non-hyphen chars
    .replace(/-{2,}/g, '-')        // collapse consecutive hyphens
    .replace(/^-+|-+$/g, '');      // strip leading/trailing hyphens
}

const PriceSchema = new mongoose.Schema(
  {
    monthly: {
      type: Number,
      required: [true, 'Monthly price is required'],
      min: [0, 'Monthly price cannot be negative'],
    },
    yearly: {
      type: Number,
      required: [true, 'Yearly price is required'],
      min: [0, 'Yearly price cannot be negative'],
    },
  },
  { _id: false }
);

const LimitsSchema = new mongoose.Schema(
  {
    dmPerDay: {
      type: Number,
      required: [true, 'DM per day limit is required'],
      min: [0, 'dmPerDay cannot be negative'],
      default: 0,
    },
    contacts: {
      type: Number,
      required: [true, 'Contacts limit is required'],
      min: [0, 'contacts cannot be negative'],
      default: 0,
    },
    automations: {
      type: Number,
      required: [true, 'Automations limit is required'],
      min: [0, 'automations cannot be negative'],
      default: 0,
    },
    campaigns: {
      type: Number,
      required: [true, 'Campaigns limit is required'],
      min: [0, 'campaigns cannot be negative'],
      default: 0,
    },
    instagramAccounts: {
      type: Number,
      required: [true, 'Instagram accounts limit is required'],
      min: [0, 'instagramAccounts cannot be negative'],
      default: 1,
    },
  },
  { _id: false }
);

const PlanSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Plan name is required'],
      trim: true,
      unique: true,
      maxlength: [80, 'Plan name must be at most 80 characters'],
    },
    slug: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Description must be at most 500 characters'],
      default: '',
    },
    price: {
      type: PriceSchema,
      required: [true, 'Plan pricing is required'],
    },
    currency: {
      type: String,
      uppercase: true,
      trim: true,
      default: 'INR',
      maxlength: [3, 'Currency code must be 3 characters'],
    },
    billingCycle: {
      type: String,
      enum: {
        values: ['monthly', 'yearly', 'both'],
        message: 'billingCycle must be monthly, yearly, or both',
      },
      default: 'both',
    },
    features: {
      type: [{ type: String, trim: true }],
      default: [],
    },
    limits: {
      type: LimitsSchema,
      required: [true, 'Plan limits are required'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isPopular: {
      type: Boolean,
      default: false,
    },
    isFeatured: {
      type: Boolean,
      default: false,
    },
    trialDays: {
      type: Number,
      default: 0,
      min: [0, 'trialDays cannot be negative'],
    },
    sortOrder: {
      type: Number,
      default: 0,
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

PlanSchema.index({ slug: 1 }, { unique: true });
PlanSchema.index({ name: 1 }, { unique: true });
PlanSchema.index({ isActive: 1, sortOrder: 1 });
PlanSchema.index({ isPopular: 1 });
PlanSchema.index({ isFeatured: 1 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

PlanSchema.virtual('yearlySavingsPercent').get(function () {
  if (!this.price || !this.price.monthly || this.price.monthly === 0) return 0;
  const monthlyAnnual = this.price.monthly * 12;
  const yearlyAnnual = this.price.yearly;
  if (monthlyAnnual === 0) return 0;
  return Math.round(((monthlyAnnual - yearlyAnnual) / monthlyAnnual) * 100);
});

PlanSchema.virtual('monthlyPriceFormatted').get(function () {
  if (!this.price) return null;
  return `${this.currency} ${(this.price.monthly / 100).toFixed(2)}`;
});

PlanSchema.virtual('yearlyPriceFormatted').get(function () {
  if (!this.price) return null;
  return `${this.currency} ${(this.price.yearly / 100).toFixed(2)}`;
});

// ─── Pre-save Hook ────────────────────────────────────────────────────────────

PlanSchema.pre('save', function (next) {
  if (this.isModified('name') || !this.slug) {
    this.slug = slugify(this.name);
  }
  return next();
});

// ─── Pre-update Hook ─────────────────────────────────────────────────────────

PlanSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate();
  if (update && update.name) {
    update.slug = slugify(update.name);
  }
  return next();
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Returns the effective price for the given billing cycle.
 * @param {'monthly'|'yearly'} cycle
 * @returns {number} Price in smallest currency unit (e.g. paise/cents).
 */
PlanSchema.methods.getPriceForCycle = function (cycle) {
  if (cycle === 'yearly') return this.price.yearly;
  return this.price.monthly;
};

/**
 * Check if this plan allows more Instagram accounts.
 * @param {number} currentCount
 * @returns {boolean}
 */
PlanSchema.methods.canAddInstagramAccount = function (currentCount) {
  return currentCount < this.limits.instagramAccounts;
};

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Fetch the active plans ordered by sortOrder ascending.
 * @returns {Promise<Document[]>}
 */
PlanSchema.statics.getActivePlans = function () {
  return this.find({ isActive: true }).sort({ sortOrder: 1 });
};

/**
 * Find a plan by its slug.
 * @param {string} slug
 * @returns {Promise<Document|null>}
 */
PlanSchema.statics.findBySlug = function (slug) {
  return this.findOne({ slug: slugify(slug) });
};

// ─── Export ───────────────────────────────────────────────────────────────────

const Plan = mongoose.model('Plan', PlanSchema);

module.exports = Plan;
