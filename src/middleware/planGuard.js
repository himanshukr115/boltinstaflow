'use strict';

const { AppError } = require('./errorHandler');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Value used by plan limits to indicate "no limit" / unlimited.
 * Stored in the Plan document as -1.
 */
const UNLIMITED = -1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether the request prefers a JSON response.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function prefersJson(req) {
  const accept = req.headers.accept || '';
  return (
    accept.includes('application/json') ||
    !!(req.xhr || (req.headers['content-type'] || '').includes('application/json'))
  );
}

/**
 * Respond with a 402 or redirect when a plan quota is exceeded.
 * @param {import('express').Response} res
 * @param {import('express').Request} req
 * @param {string} message
 * @param {string} [redirectUrl='/pricing']
 */
function quotaExceeded(req, res, message, redirectUrl = '/pricing') {
  if (prefersJson(req)) {
    return res.status(402).json({
      success: false,
      statusCode: 402,
      message,
      redirectUrl,
    });
  }
  return res.redirect(redirectUrl);
}

/**
 * Load the active subscription + plan for a user ID.
 * Returns null when no active subscription exists.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @returns {Promise<import('mongoose').Document|null>}
 */
async function loadActiveSubscription(userId) {
  // Lazy-require to avoid circular dependency issues at module load time
  const Subscription = require('../models/Subscription');

  return Subscription.findOne({
    userId,
    status: { $in: ['active', 'trialing'] },
    $or: [
      { currentPeriodEnd: { $gt: new Date() } },
      { currentPeriodEnd: null },
    ],
  })
    .populate('plan')
    .lean(false);
}

/**
 * Extract plan limits from a subscription document.
 * Provides safe defaults when limits are missing.
 *
 * @param {import('mongoose').Document|null} subscription
 * @returns {Record<string, number>}
 */
function extractLimits(subscription) {
  const defaults = {
    instagramAccounts: 1,
    dailyDms: 50,
    contacts: 500,
    automations: 3,
    campaigns: 2,
  };

  if (!subscription || !subscription.plan || !subscription.plan.limits) {
    return defaults;
  }

  return { ...defaults, ...subscription.plan.limits.toObject() };
}

// ---------------------------------------------------------------------------
// checkDmQuota
// ---------------------------------------------------------------------------

/**
 * Middleware factory that verifies the daily DM limit for a specific
 * Instagram account has not been exceeded.
 *
 * @param {import('mongoose').Document} account - The InstagramAccount document
 *   (must have userId and dmsSentToday fields).
 * @returns {import('express').RequestHandler}
 */
function checkDmQuota(account) {
  return async (req, res, next) => {
    try {
      if (!req.user) return next(new AppError('Not authenticated.', 401));

      const subscription = await loadActiveSubscription(req.user._id);
      const limits = extractLimits(subscription);

      if (limits.dailyDms === UNLIMITED) return next();

      const dmsSentToday = account.dmsSentToday || 0;

      if (dmsSentToday >= limits.dailyDms) {
        return quotaExceeded(
          req,
          res,
          `Daily DM limit of ${limits.dailyDms} reached for this account. Upgrade your plan for a higher limit.`,
          '/pricing'
        );
      }

      // Attach remaining quota for use in controllers
      req.dmQuota = {
        limit: limits.dailyDms,
        used: dmsSentToday,
        remaining: limits.dailyDms - dmsSentToday,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// checkContactLimit
// ---------------------------------------------------------------------------

/**
 * Middleware that checks whether the user has reached their plan's contact
 * (audience list member) limit before allowing a new contact to be created.
 *
 * @param {string|import('mongoose').Types.ObjectId} [userIdOverride] - Optional
 *   user ID override; defaults to req.user._id.
 * @returns {import('express').RequestHandler}
 */
function checkContactLimit(userIdOverride) {
  return async (req, res, next) => {
    try {
      const userId = userIdOverride || (req.user && req.user._id);
      if (!userId) return next(new AppError('Not authenticated.', 401));

      const Contact = require('../models/Contact');
      const subscription = await loadActiveSubscription(userId);
      const limits = extractLimits(subscription);

      if (limits.contacts === UNLIMITED) return next();

      const count = await Contact.countDocuments({ userId });

      if (count >= limits.contacts) {
        return quotaExceeded(
          req,
          res,
          `Contact limit of ${limits.contacts} reached. Upgrade your plan to add more contacts.`,
          '/pricing'
        );
      }

      req.contactQuota = { limit: limits.contacts, used: count, remaining: limits.contacts - count };
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// checkAutomationLimit
// ---------------------------------------------------------------------------

/**
 * Middleware that checks whether the user has reached their plan's automation
 * limit before allowing a new automation to be created.
 *
 * @param {string|import('mongoose').Types.ObjectId} [userIdOverride]
 * @returns {import('express').RequestHandler}
 */
function checkAutomationLimit(userIdOverride) {
  return async (req, res, next) => {
    try {
      const userId = userIdOverride || (req.user && req.user._id);
      if (!userId) return next(new AppError('Not authenticated.', 401));

      const Automation = require('../models/Automation');
      const subscription = await loadActiveSubscription(userId);
      const limits = extractLimits(subscription);

      if (limits.automations === UNLIMITED) return next();

      const count = await Automation.countDocuments({ userId });

      if (count >= limits.automations) {
        return quotaExceeded(
          req,
          res,
          `Automation limit of ${limits.automations} reached. Upgrade your plan to create more automations.`,
          '/pricing'
        );
      }

      req.automationQuota = {
        limit: limits.automations,
        used: count,
        remaining: limits.automations - count,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// checkCampaignLimit
// ---------------------------------------------------------------------------

/**
 * Middleware that checks whether the user has reached their plan's campaign
 * limit before allowing a new campaign to be created.
 *
 * @param {string|import('mongoose').Types.ObjectId} [userIdOverride]
 * @returns {import('express').RequestHandler}
 */
function checkCampaignLimit(userIdOverride) {
  return async (req, res, next) => {
    try {
      const userId = userIdOverride || (req.user && req.user._id);
      if (!userId) return next(new AppError('Not authenticated.', 401));

      const Campaign = require('../models/Campaign');
      const subscription = await loadActiveSubscription(userId);
      const limits = extractLimits(subscription);

      if (limits.campaigns === UNLIMITED) return next();

      const count = await Campaign.countDocuments({ userId });

      if (count >= limits.campaigns) {
        return quotaExceeded(
          req,
          res,
          `Campaign limit of ${limits.campaigns} reached. Upgrade your plan to create more campaigns.`,
          '/pricing'
        );
      }

      req.campaignQuota = {
        limit: limits.campaigns,
        used: count,
        remaining: limits.campaigns - count,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// requirePlanFeature
// ---------------------------------------------------------------------------

/**
 * Middleware factory that checks whether the authenticated user's active plan
 * includes a specific feature key.
 *
 * The plan's features array is expected to contain objects of the shape:
 *   { key: string, included: boolean }
 *
 * @param {string} featureName - The feature key to check (e.g. 'analytics', 'api_access').
 * @returns {import('express').RequestHandler}
 */
function requirePlanFeature(featureName) {
  if (!featureName || typeof featureName !== 'string') {
    throw new TypeError('requirePlanFeature requires a non-empty feature name string.');
  }

  return async (req, res, next) => {
    try {
      if (!req.user) return next(new AppError('Not authenticated.', 401));

      // Admins bypass all feature checks
      if (req.user.role === 'admin') return next();

      const subscription = await loadActiveSubscription(req.user._id);

      if (!subscription || !subscription.plan) {
        return quotaExceeded(
          req,
          res,
          `Feature "${featureName}" requires an active subscription.`,
          '/pricing'
        );
      }

      const features = subscription.plan.features || [];
      const feature = features.find(
        (f) => f.key === featureName || f.key === featureName.toLowerCase()
      );

      if (!feature || feature.included === false) {
        return quotaExceeded(
          req,
          res,
          `The "${featureName}" feature is not included in your current plan. Please upgrade to access it.`,
          '/pricing'
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  checkDmQuota,
  checkContactLimit,
  checkAutomationLimit,
  checkCampaignLimit,
  requirePlanFeature,
  // Exposed for testing
  loadActiveSubscription,
  extractLimits,
  UNLIMITED,
};
