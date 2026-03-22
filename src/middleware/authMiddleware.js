'use strict';

const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Automation = require('../models/Automation');
const Campaign = require('../models/Campaign');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// requireAuth – redirect to login if unauthenticated
// ---------------------------------------------------------------------------
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  req.session.returnTo = req.originalUrl;
  req.flash('error', 'Please sign in to continue.');
  return res.redirect('/auth/login');
};

// ---------------------------------------------------------------------------
// requireGuest – redirect to dashboard if already authenticated
// ---------------------------------------------------------------------------
const requireGuest = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/dashboard');
  return next();
};

// ---------------------------------------------------------------------------
// requireAdmin – reject non-admin users
// ---------------------------------------------------------------------------
const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') return next();
  logger.warn('Unauthorized admin access attempt', {
    userId: req.user && req.user._id,
    path: req.originalUrl,
    ip: req.ip,
  });
  return res.status(403).render('errors/403', {
    title: 'Access Denied',
    message: 'You do not have permission to access this area.',
  });
};

// ---------------------------------------------------------------------------
// requireActiveSubscription – ensures user has a paid/trial subscription
// ---------------------------------------------------------------------------
const requireActiveSubscription = async (req, res, next) => {
  try {
    const subscription = await Subscription.findOne({
      userId: req.user._id,
      status: { $in: ['active', 'trialing'] },
    }).lean();

    if (!subscription) {
      req.flash('error', 'An active subscription is required to use this feature.');
      return res.redirect('/pricing');
    }

    req.subscription = subscription;
    return next();
  } catch (err) {
    logger.error('requireActiveSubscription error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// checkPlanLimit – verify the user hasn't exceeded their plan quota
// resource: 'automations' | 'campaigns' | 'contacts' | 'instagramAccounts'
// ---------------------------------------------------------------------------
const checkPlanLimit = (resource) => async (req, res, next) => {
  try {
    const subscription = req.subscription
      || await Subscription.findOne({
          userId: req.user._id,
          status: { $in: ['active', 'trialing'] },
        }).populate('planId').lean();

    if (!subscription || !subscription.planId) {
      req.flash('error', 'Active subscription required.');
      return res.redirect('/pricing');
    }

    const limits = subscription.planId.limits || {};
    const limit = limits[resource];

    if (limit == null || limit === -1) {
      // Unlimited
      return next();
    }

    let currentCount = 0;
    if (resource === 'automations') {
      currentCount = await Automation.countDocuments({
        userId: req.user._id,
        status: { $ne: 'archived' },
      });
    } else if (resource === 'campaigns') {
      currentCount = await Campaign.countDocuments({ userId: req.user._id });
    } else if (resource === 'instagramAccounts') {
      const InstagramAccount = require('../models/InstagramAccount');
      currentCount = await InstagramAccount.countDocuments({ userId: req.user._id, isDeleted: false });
    }

    if (currentCount >= limit) {
      const isJsonRequest = req.headers.accept && req.headers.accept.includes('application/json');
      const msg = `You have reached the ${resource} limit (${limit}) for your plan. Please upgrade.`;
      if (isJsonRequest) {
        return res.status(403).json({ success: false, message: msg, upgradeUrl: '/pricing' });
      }
      req.flash('error', msg);
      return res.redirect('back');
    }

    return next();
  } catch (err) {
    logger.error('checkPlanLimit error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// loadUserFromApiKey – authenticate REST API requests via X-API-Key header
// or ?api_key= query parameter
// ---------------------------------------------------------------------------
const loadUserFromApiKey = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;

  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'API key required. Pass X-API-Key header or api_key query param.' });
  }

  try {
    const user = await User.findOne({ apiKey, isSuspended: false }).lean();
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid or revoked API key.' });
    }
    req.user = user;
    return next();
  } catch (err) {
    logger.error('loadUserFromApiKey error', { error: err.message });
    return next(err);
  }
};

module.exports = {
  requireAuth,
  requireGuest,
  requireAdmin,
  requireActiveSubscription,
  checkPlanLimit,
  loadUserFromApiKey,
};
