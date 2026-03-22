'use strict';

const mongoose = require('mongoose');

const SEVERITY_LEVELS = ['info', 'warning', 'critical'];

// Common action categories (non-exhaustive; extensible by the application layer)
const COMMON_ACTIONS = [
  // Auth
  'user.login',
  'user.logout',
  'user.login_failed',
  'user.password_reset',
  'user.email_verified',
  'user.two_factor_enabled',
  'user.two_factor_disabled',
  // User management
  'user.created',
  'user.updated',
  'user.deleted',
  'user.suspended',
  'user.unsuspended',
  'user.role_changed',
  // Subscription / billing
  'subscription.created',
  'subscription.upgraded',
  'subscription.downgraded',
  'subscription.canceled',
  'subscription.renewed',
  'payment.captured',
  'payment.failed',
  'payment.refunded',
  // Instagram accounts
  'instagram_account.connected',
  'instagram_account.disconnected',
  'instagram_account.token_refreshed',
  // Automations
  'automation.created',
  'automation.updated',
  'automation.activated',
  'automation.paused',
  'automation.archived',
  'automation.deleted',
  // Campaigns
  'campaign.created',
  'campaign.started',
  'campaign.paused',
  'campaign.completed',
  'campaign.deleted',
  // API keys
  'api_key.generated',
  'api_key.revoked',
  // Admin actions
  'admin.impersonate',
  'admin.bulk_action',
];

const AuditLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    action: {
      type: String,
      required: [true, 'action is required'],
      trim: true,
    },
    resource: {
      type: String,
      trim: true,
      default: null,
    },
    resourceId: {
      type: String,
      trim: true,
      default: null,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, 'description must be at most 1000 characters'],
      default: '',
    },
    ipAddress: {
      type: String,
      trim: true,
      default: null,
    },
    userAgent: {
      type: String,
      trim: true,
      maxlength: [500, 'userAgent must be at most 500 characters'],
      default: null,
    },
    metadata: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => new Map(),
    },
    severity: {
      type: String,
      enum: {
        values: SEVERITY_LEVELS,
        message: `severity must be one of: ${SEVERITY_LEVELS.join(', ')}`,
      },
      default: 'info',
    },
  },
  {
    // Audit logs are append-only; no updatedAt needed
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

AuditLogSchema.index({ userId: 1 });
AuditLogSchema.index({ action: 1 });
AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ userId: 1, createdAt: -1 });
AuditLogSchema.index({ userId: 1, action: 1 });
AuditLogSchema.index({ resource: 1, resourceId: 1 });
AuditLogSchema.index({ severity: 1, createdAt: -1 });
// TTL index: retain audit logs for 1 year (365 days)
AuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

AuditLogSchema.virtual('isCritical').get(function () {
  return this.severity === 'critical';
});

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Create a structured audit log entry.
 * @param {object} params
 * @param {ObjectId|string|null} params.userId
 * @param {string} params.action
 * @param {string} [params.resource]
 * @param {string} [params.resourceId]
 * @param {string} [params.description]
 * @param {string} [params.ipAddress]
 * @param {string} [params.userAgent]
 * @param {'info'|'warning'|'critical'} [params.severity]
 * @param {object} [params.metadata]
 * @returns {Promise<Document>}
 */
AuditLogSchema.statics.log = function ({
  userId = null,
  action,
  resource = null,
  resourceId = null,
  description = '',
  ipAddress = null,
  userAgent = null,
  severity = 'info',
  metadata = {},
} = {}) {
  return this.create({
    userId,
    action,
    resource,
    resourceId,
    description,
    ipAddress,
    userAgent,
    severity,
    metadata,
  });
};

/**
 * Get the audit trail for a specific resource.
 * @param {string} resource - e.g. 'User', 'Subscription'
 * @param {string} resourceId
 * @param {number} [limit=50]
 * @returns {Promise<Document[]>}
 */
AuditLogSchema.statics.getForResource = function (resource, resourceId, limit = 50) {
  return this.find({ resource, resourceId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('userId', 'name email role');
};

/**
 * Get audit logs for a user.
 * @param {ObjectId|string} userId
 * @param {number} [limit=100]
 * @param {number} [skip=0]
 * @returns {Promise<Document[]>}
 */
AuditLogSchema.statics.getForUser = function (userId, limit = 100, skip = 0) {
  return this.find({ userId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);
};

/**
 * Get recent critical events (for admin dashboard alerts).
 * @param {number} [limit=20]
 * @param {number} [sinceHours=24]
 * @returns {Promise<Document[]>}
 */
AuditLogSchema.statics.getCriticalEvents = function (limit = 20, sinceHours = 24) {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  return this.find({ severity: 'critical', createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('userId', 'name email');
};

// ─── Export ───────────────────────────────────────────────────────────────────

const AuditLog = mongoose.model('AuditLog', AuditLogSchema);

module.exports = AuditLog;
