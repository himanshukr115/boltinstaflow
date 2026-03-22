'use strict';

const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const User = require('../models/User');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const analyticsService = require('../services/analyticsService');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Multer config for avatar uploads
// ---------------------------------------------------------------------------
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../../public/uploads/avatars'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `avatar-${req.user._id}-${Date.now()}${ext}`);
  },
});

const avatarFileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowed.includes(file.mimetype)) return cb(null, true);
  cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed.'));
};

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: avatarFileFilter,
});

// ---------------------------------------------------------------------------
// index  (GET /dashboard)
// ---------------------------------------------------------------------------
const index = async (req, res, next) => {
  try {
    const userId = req.user._id;

    const [stats, instagramAccounts, recentAutomations, recentCampaigns] =
      await Promise.all([
        analyticsService.getUserDashboardStats(userId),
        require('../models/InstagramAccount').find({ userId, isDeleted: false }).sort({ createdAt: -1 }).limit(5).lean(),
        require('../models/Automation').find({ userId, status: { $ne: 'archived' } }).sort({ updatedAt: -1 }).limit(5).lean(),
        require('../models/Campaign').find({ userId }).sort({ createdAt: -1 }).limit(5).lean(),
      ]);

    return res.render('dashboard/index', {
      title: 'Dashboard',
      user: req.user,
      stats,
      instagramAccounts,
      recentAutomations,
      recentCampaigns,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Dashboard index error', { error: err.message, userId: req.user._id });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// profile  (GET /dashboard/profile)
// ---------------------------------------------------------------------------
const profile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).lean();
    return res.render('dashboard/profile', {
      title: 'My Profile',
      user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// updateProfile  (POST /dashboard/profile)
// Wraps multer upload as a middleware array exported for route use.
// ---------------------------------------------------------------------------
const updateProfile = [
  uploadAvatar.single('avatar'),
  async (req, res, next) => {
    try {
      const { name, timezone, notifyEmail, notifyBrowser } = req.body;
      const user = await User.findById(req.user._id);

      if (name && name.trim().length > 0 && name.trim().length <= 100) {
        user.name = name.trim();
      }

      if (timezone) {
        // Basic allowlist check – full list is large; accept any non-empty string
        // that doesn't look malicious. Production should use moment-timezone list.
        user.timezone = timezone.replace(/[^A-Za-z0-9/_+-]/g, '').substring(0, 60);
      }

      user.notificationPrefs = {
        email: notifyEmail === 'on' || notifyEmail === 'true',
        browser: notifyBrowser === 'on' || notifyBrowser === 'true',
      };

      if (req.file) {
        user.avatarUrl = `/uploads/avatars/${req.file.filename}`;
      }

      await user.save();

      await AuditLog.create({
        userId: user._id,
        action: 'user.profileUpdated',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { fieldsChanged: ['name', 'timezone', 'notificationPrefs'] },
      });

      req.flash('success', 'Profile updated successfully.');
      return res.redirect('/dashboard/profile');
    } catch (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        req.flash('error', 'Avatar file must be 2 MB or smaller.');
        return res.redirect('/dashboard/profile');
      }
      logger.error('Update profile error', { error: err.message });
      return next(err);
    }
  },
];

// ---------------------------------------------------------------------------
// security  (GET /dashboard/security)
// ---------------------------------------------------------------------------
const security = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).lean();
    return res.render('dashboard/security', {
      title: 'Security Settings',
      user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// updatePassword  (POST /dashboard/security/password)
// ---------------------------------------------------------------------------
const updatePassword = async (req, res, next) => {
  const { currentPassword, newPassword, confirmNewPassword } = req.body;

  if (!currentPassword || !newPassword || !confirmNewPassword) {
    req.flash('error', 'All password fields are required.');
    return res.redirect('/dashboard/security');
  }
  if (newPassword.length < 8) {
    req.flash('error', 'New password must be at least 8 characters.');
    return res.redirect('/dashboard/security');
  }
  if (newPassword !== confirmNewPassword) {
    req.flash('error', 'New passwords do not match.');
    return res.redirect('/dashboard/security');
  }

  try {
    const user = await User.findById(req.user._id).select('+passwordHash');
    const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isMatch) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/dashboard/security');
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    await user.save();

    await AuditLog.create({
      userId: user._id,
      action: 'user.passwordChanged',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: {},
    });

    req.flash('success', 'Password updated successfully.');
    return res.redirect('/dashboard/security');
  } catch (err) {
    logger.error('Update password error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// apiKey  (GET /dashboard/api-key)
// ---------------------------------------------------------------------------
const apiKey = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).lean();
    return res.render('dashboard/api-key', {
      title: 'API Key',
      user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// regenerateApiKey  (POST /dashboard/api-key/regenerate)  → JSON
// ---------------------------------------------------------------------------
const regenerateApiKey = async (req, res, next) => {
  try {
    const newKey = uuidv4();
    await User.findByIdAndUpdate(req.user._id, { apiKey: newKey });

    await AuditLog.create({
      userId: req.user._id,
      action: 'user.apiKeyRegenerated',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: {},
    });

    return res.json({ success: true, apiKey: newKey });
  } catch (err) {
    logger.error('Regenerate API key error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// notifications  (GET /dashboard/notifications)
// ---------------------------------------------------------------------------
const notifications = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      Notification.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments({ userId: req.user._id }),
    ]);

    // Mark all as read
    await Notification.updateMany(
      { userId: req.user._id, isRead: false },
      { $set: { isRead: true, readAt: new Date() } },
    );

    return res.render('dashboard/notifications', {
      title: 'Notifications',
      notifications: items,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      total,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Notifications error', { error: err.message });
    return next(err);
  }
};

module.exports = {
  index,
  profile,
  updateProfile,
  security,
  updatePassword,
  apiKey,
  regenerateApiKey,
  notifications,
};
