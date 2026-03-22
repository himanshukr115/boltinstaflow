'use strict';

const { Queue } = require('bullmq');
const { getBullMQConnection } = require('../config/redis');
const logger = require('../config/logger');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

// Lazy-initialised to avoid connecting at require time during tests / migrations
let _auditQueue = null;

/**
 * Get (or lazily create) the BullMQ audit queue instance.
 * Jobs are fire-and-forget: they should not block the HTTP request thread.
 * @returns {Queue}
 */
function getAuditQueue() {
  if (!_auditQueue) {
    _auditQueue = new Queue('audit', {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 2000 },
      },
    });

    _auditQueue.on('error', (err) => {
      // Never crash the app if the audit queue has trouble
      logger.error(`[AuditQueue] Queue error: ${err.message}`, { stack: err.stack });
    });
  }
  return _auditQueue;
}

// ─── IP / User-Agent Extraction ───────────────────────────────────────────────

/**
 * Extract the best-available IP address from an Express request object.
 * Respects x-forwarded-for (from trusted proxies) when present.
 * @param {import('express').Request|undefined} req
 * @returns {string|null}
 */
function extractIp(req) {
  if (!req) return null;
  const forwarded = req.headers && req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for may be a comma-separated list; the first entry is the client IP
    return String(forwarded).split(',')[0].trim();
  }
  return (req.ip || (req.connection && req.connection.remoteAddress) || null);
}

/**
 * Extract the User-Agent string from an Express request object.
 * @param {import('express').Request|undefined} req
 * @returns {string|null}
 */
function extractUserAgent(req) {
  if (!req || !req.headers) return null;
  return req.headers['user-agent'] || null;
}

// ─── Core Log Function ────────────────────────────────────────────────────────

/**
 * Enqueue an audit log entry via BullMQ so the HTTP thread is not blocked.
 * Falls back to a direct DB write if the queue is unavailable (defensive).
 *
 * The corresponding worker (workers/auditWorker.js) is responsible for calling
 * AuditLog.create() with the job data.
 *
 * @param {string}                     action       Dot-notated action (e.g. 'user.login')
 * @param {string|null}                userId       MongoDB ObjectId string of the acting user
 * @param {string|null}                resource     Resource type (e.g. 'User', 'Subscription')
 * @param {string|null}                resourceId   Resource identifier
 * @param {string}                     [description='']
 * @param {import('express').Request}  [req]        Express request (for IP / UA extraction)
 * @param {'info'|'warning'|'critical'} [severity='info']
 * @param {object}                     [metadata={}]
 * @returns {Promise<void>}
 */
async function log(
  action,
  userId = null,
  resource = null,
  resourceId = null,
  description = '',
  req = null,
  severity = 'info',
  metadata = {}
) {
  if (!action || typeof action !== 'string') {
    logger.warn('[AuditLogger] log() called without a valid action – skipping');
    return;
  }

  const jobData = {
    action,
    userId: userId ? String(userId) : null,
    resource: resource || null,
    resourceId: resourceId ? String(resourceId) : null,
    description: description || '',
    ipAddress: extractIp(req),
    userAgent: extractUserAgent(req),
    severity: ['info', 'warning', 'critical'].includes(severity) ? severity : 'info',
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
  };

  try {
    await getAuditQueue().add('create', jobData, {
      // Audit logs are relatively low priority; let billing/DM jobs go first
      priority: 10,
    });
  } catch (queueErr) {
    // Last-resort: write directly to DB so no audit event is silently lost
    logger.error(`[AuditLogger] Failed to enqueue audit log, attempting direct write: ${queueErr.message}`);
    try {
      // Require lazily to avoid circular dependency issues at module load time
      const AuditLog = require('../models/AuditLog');
      await AuditLog.create(jobData);
    } catch (dbErr) {
      logger.error(`[AuditLogger] Direct write also failed: ${dbErr.message}`, { jobData });
    }
  }
}

// ─── Shorthand Helpers ────────────────────────────────────────────────────────

/**
 * Log an authentication event (login, logout, password reset, etc.).
 * @param {string}                    action  e.g. 'user.login', 'user.login_failed'
 * @param {string|null}               userId
 * @param {import('express').Request} [req]
 * @returns {Promise<void>}
 */
async function logAuth(action, userId, req) {
  const descriptions = {
    'user.login': 'User logged in successfully',
    'user.logout': 'User logged out',
    'user.login_failed': 'Login attempt failed',
    'user.password_reset': 'Password was reset',
    'user.email_verified': 'Email address verified',
    'user.two_factor_enabled': 'Two-factor authentication enabled',
    'user.two_factor_disabled': 'Two-factor authentication disabled',
    'user.created': 'New user account created',
  };
  const description = descriptions[action] || `Auth event: ${action}`;
  const severity = action === 'user.login_failed' ? 'warning' : 'info';

  return log(action, userId, 'User', userId, description, req, severity);
}

/**
 * Log a billing or subscription event.
 * @param {string}                    action  e.g. 'payment.captured', 'subscription.created'
 * @param {string|null}               userId
 * @param {object}                    [data]  { subscriptionId, paymentId, planId, amount, ... }
 * @param {import('express').Request} [req]
 * @returns {Promise<void>}
 */
async function logBilling(action, userId, data = {}, req = null) {
  const resourceId =
    data.paymentId || data.subscriptionId || data.invoiceId || null;
  const resource =
    action.startsWith('payment') ? 'Payment' :
    action.startsWith('subscription') ? 'Subscription' :
    action.startsWith('invoice') ? 'Invoice' : 'Billing';

  const severity = ['payment.failed', 'payment.refunded'].includes(action) ? 'warning' : 'info';

  const description = buildBillingDescription(action, data);

  return log(action, userId, resource, resourceId, description, req, severity, data);
}

/**
 * Log an admin action performed on behalf of another user.
 * @param {string}                    action        e.g. 'admin.impersonate', 'user.suspended'
 * @param {string|null}               adminId       ObjectId of the admin performing the action
 * @param {string|null}               targetUserId  ObjectId of the affected user
 * @param {object}                    [changes]     { before, after } snapshot
 * @param {import('express').Request} [req]
 * @returns {Promise<void>}
 */
async function logAdmin(action, adminId, targetUserId, changes = {}, req = null) {
  const description = `Admin action "${action}" performed on user ${targetUserId || 'N/A'}`;
  return log(
    action,
    adminId,
    'User',
    targetUserId,
    description,
    req,
    'warning',
    { targetUserId, changes }
  );
}

/**
 * Log an Instagram account event (connect, disconnect, token refresh, etc.).
 * @param {string}                    action     e.g. 'instagram_account.connected'
 * @param {string|null}               userId
 * @param {string|null}               accountId  Instagram account ObjectId
 * @param {import('express').Request} [req]
 * @returns {Promise<void>}
 */
async function logInstagram(action, userId, accountId, req = null) {
  const descriptions = {
    'instagram_account.connected': 'Instagram account connected',
    'instagram_account.disconnected': 'Instagram account disconnected',
    'instagram_account.token_refreshed': 'Instagram access token refreshed',
  };
  const description = descriptions[action] || `Instagram event: ${action}`;
  return log(action, userId, 'InstagramAccount', accountId, description, req, 'info');
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Build a human-readable description for billing events.
 * @param {string} action
 * @param {object} data
 * @returns {string}
 */
function buildBillingDescription(action, data) {
  const amount = data.amount != null
    ? ` of ${data.currency || 'INR'} ${(data.amount / 100).toFixed(2)}`
    : '';
  switch (action) {
    case 'payment.captured':    return `Payment captured${amount}`;
    case 'payment.failed':      return `Payment failed${amount}`;
    case 'payment.refunded':    return `Payment refunded${amount}`;
    case 'subscription.created':  return `Subscription created for plan ${data.planId || 'unknown'}`;
    case 'subscription.upgraded': return `Subscription upgraded to plan ${data.planId || 'unknown'}`;
    case 'subscription.downgraded': return `Subscription downgraded to plan ${data.planId || 'unknown'}`;
    case 'subscription.canceled':  return 'Subscription cancelled';
    case 'subscription.renewed':   return `Subscription renewed${amount}`;
    default: return `Billing event: ${action}`;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  log,
  logAuth,
  logBilling,
  logAdmin,
  logInstagram,
};
