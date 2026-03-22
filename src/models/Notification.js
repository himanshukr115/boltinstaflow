'use strict';

const mongoose = require('mongoose');

// Notification types map to frontend rendering/icon logic
const NOTIFICATION_TYPES = [
  'subscription_activated',
  'subscription_expiring',
  'subscription_expired',
  'subscription_canceled',
  'subscription_renewed',
  'payment_success',
  'payment_failed',
  'payment_refunded',
  'automation_triggered',
  'automation_failed',
  'campaign_started',
  'campaign_completed',
  'campaign_failed',
  'instagram_connected',
  'instagram_disconnected',
  'instagram_token_expiring',
  'dm_quota_reached',
  'new_contact',
  'new_follower',
  'mention',
  'system_maintenance',
  'new_feature',
  'security_alert',
  'info',
  'warning',
  'error',
];

const NotificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },
    type: {
      type: String,
      enum: {
        values: NOTIFICATION_TYPES,
        message: `type must be one of: ${NOTIFICATION_TYPES.join(', ')}`,
      },
      required: [true, 'notification type is required'],
    },
    title: {
      type: String,
      required: [true, 'title is required'],
      trim: true,
      maxlength: [150, 'title must be at most 150 characters'],
    },
    message: {
      type: String,
      required: [true, 'message is required'],
      trim: true,
      maxlength: [1000, 'message must be at most 1000 characters'],
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
      default: null,
    },
    // Optional deep-link inside the app
    link: {
      type: String,
      trim: true,
      default: null,
    },
    // Optional icon override (e.g. emoji or icon name)
    icon: {
      type: String,
      trim: true,
      default: null,
    },
    metadata: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => new Map(),
    },
  },
  {
    // Only createdAt; notifications are immutable once created
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

NotificationSchema.index({ userId: 1 });
NotificationSchema.index({ isRead: 1 });
NotificationSchema.index({ userId: 1, isRead: 1 });
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, type: 1 });
// TTL index: auto-delete notifications older than 60 days
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

NotificationSchema.virtual('ageInMinutes').get(function () {
  return Math.floor((Date.now() - this.createdAt.getTime()) / 60000);
});

NotificationSchema.virtual('isNew').get(function () {
  // Considered "new" if unread and created within the last 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return !this.isRead && this.createdAt >= oneDayAgo;
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Mark this notification as read.
 * @returns {Promise<Document>}
 */
NotificationSchema.methods.markAsRead = async function () {
  if (this.isRead) return this;
  this.isRead = true;
  this.readAt = new Date();
  return this.save();
};

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * Get unread notifications for a user.
 * @param {ObjectId|string} userId
 * @param {number} [limit=20]
 * @returns {Promise<Document[]>}
 */
NotificationSchema.statics.getUnread = function (userId, limit = 20) {
  return this.find({ userId, isRead: false })
    .sort({ createdAt: -1 })
    .limit(limit);
};

/**
 * Get all notifications for a user (paginated).
 * @param {ObjectId|string} userId
 * @param {number} [limit=30]
 * @param {number} [skip=0]
 * @returns {Promise<Document[]>}
 */
NotificationSchema.statics.getForUser = function (userId, limit = 30, skip = 0) {
  return this.find({ userId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);
};

/**
 * Count unread notifications for a user.
 * @param {ObjectId|string} userId
 * @returns {Promise<number>}
 */
NotificationSchema.statics.countUnread = function (userId) {
  return this.countDocuments({ userId, isRead: false });
};

/**
 * Mark all unread notifications for a user as read.
 * @param {ObjectId|string} userId
 * @returns {Promise<object>} MongoDB updateMany result.
 */
NotificationSchema.statics.markAllAsRead = function (userId) {
  return this.updateMany(
    { userId, isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );
};

/**
 * Create and deliver a notification to a user.
 * @param {object} params
 * @param {ObjectId|string} params.userId
 * @param {string} params.type
 * @param {string} params.title
 * @param {string} params.message
 * @param {string} [params.link]
 * @param {string} [params.icon]
 * @param {object} [params.metadata]
 * @returns {Promise<Document>}
 */
NotificationSchema.statics.send = function ({
  userId,
  type,
  title,
  message,
  link = null,
  icon = null,
  metadata = {},
}) {
  return this.create({ userId, type, title, message, link, icon, metadata });
};

/**
 * Broadcast a notification to multiple users at once.
 * @param {(ObjectId|string)[]} userIds
 * @param {object} notification - Notification fields (type, title, message, etc.)
 * @returns {Promise<object>} MongoDB insertMany result.
 */
NotificationSchema.statics.broadcast = function (userIds, { type, title, message, link = null, icon = null, metadata = {} }) {
  const docs = userIds.map((userId) => ({
    userId,
    type,
    title,
    message,
    link,
    icon,
    metadata,
    isRead: false,
  }));
  return this.insertMany(docs, { ordered: false });
};

/**
 * Delete all notifications for a user (e.g. on account deletion).
 * @param {ObjectId|string} userId
 * @returns {Promise<object>}
 */
NotificationSchema.statics.deleteForUser = function (userId) {
  return this.deleteMany({ userId });
};

// ─── Export ───────────────────────────────────────────────────────────────────

const Notification = mongoose.model('Notification', NotificationSchema);

module.exports = Notification;
