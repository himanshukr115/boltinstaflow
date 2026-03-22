'use strict';

const cron = require('node-cron');
const logger = require('../config/logger');
const { addBillingJob, addEmailJob, analyticsQueue, webhookQueue } = require('../queues');

// Models
const Account      = require('../models/InstagramAccount');
const User         = require('../models/User');
const Subscription = require('../models/Subscription');
const WebhookLog   = require('../models/WebhookLog');

// Services
const instagramService = require('../services/instagramService');

// ---------------------------------------------------------------------------
// Scheduler registry – keeps references so tasks can be stopped cleanly
// ---------------------------------------------------------------------------
const registeredTasks = [];

// ---------------------------------------------------------------------------
// Helper: safely execute a scheduler callback and log errors without crashing
// ---------------------------------------------------------------------------
async function runTask(taskName, fn) {
  logger.info(`[Scheduler] Running task: ${taskName}`);
  const start = Date.now();
  try {
    await fn();
    logger.info(`[Scheduler] Task "${taskName}" completed in ${Date.now() - start}ms`);
  } catch (err) {
    logger.error(
      `[Scheduler] Task "${taskName}" failed: ${err.message}`,
      { stack: err.stack }
    );
  }
}

// ---------------------------------------------------------------------------
// Task implementations
// ---------------------------------------------------------------------------

// checkTrialExpiry  - runs every 5 minutes
// Enqueues a billing job to detect and act on expiring/expired trials.
async function scheduleTrialExpiryCheck() {
  await addBillingJob('check_trial_expiry', {});
}

/**
 * checkSubscriptionExpiry  (0 * * * *)
 * Enqueues a billing job to detect subscriptions whose period has ended.
 */
async function scheduleSubscriptionExpiryCheck() {
  await addBillingJob('check_subscription_expiry', {});
}

/**
 * refreshExpiringInstagramTokens  (0 * * * *)
 * Instagram long-lived tokens expire after 60 days.  This task finds tokens
 * expiring within the next 7 days and requests a refresh.
 */
async function refreshExpiringInstagramTokens() {
  const sevenDaysAhead = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const accounts = await Account.find({
    status:       'active',
    tokenExpiresAt: { $lte: sevenDaysAhead },
  }).select('_id accessToken userId').lean();

  logger.info(`[Scheduler] Found ${accounts.length} Instagram account(s) with expiring tokens`);

  for (const account of accounts) {
    try {
      await instagramService.refreshAccessToken(account._id.toString());
      logger.info(`[Scheduler] Refreshed token for account ${account._id}`);
    } catch (err) {
      logger.error(
        `[Scheduler] Failed to refresh token for account ${account._id}: ${err.message}`
      );
    }
  }
}

/**
 * resetDailyDmCounters  (0 0 * * *)
 * Resets the dmsSentToday counter on all Account documents at midnight UTC.
 * The Redis rate-limit counters expire on their own via TTL; this clears the
 * Mongo-side aggregate so dashboards stay accurate.
 */
async function resetDailyDmCounters() {
  const result = await Account.updateMany(
    { dmsSentToday: { $gt: 0 } },
    {
      dmsSentToday:    0,
      dmsDayResetAt:   new Date(),
    }
  );
  logger.info(`[Scheduler] Reset daily DM counters on ${result.modifiedCount} account(s)`);
}

/**
 * resetDailyApiCallCounters  (0 0 * * *)
 * Resets the Instagram Graph API call counter stored on Account documents.
 */
async function resetDailyApiCallCounters() {
  const result = await Account.updateMany(
    { apiCallsToday: { $gt: 0 } },
    { apiCallsToday: 0, apiCallsDayResetAt: new Date() }
  );
  logger.info(`[Scheduler] Reset daily API call counters on ${result.modifiedCount} account(s)`);
}

/**
 * sendDailyAnalyticsReports  (0 9 * * *)
 * Sends daily performance-summary emails to users who have opted in.
 * Queues individual email jobs rather than sending inline to keep the
 * scheduler fast.
 */
async function sendDailyAnalyticsReports() {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const reportDate = yesterday.toISOString().slice(0, 10);

  // Find users who opted in to daily reports
  const users = await User.find({
    'preferences.dailyReport': true,
    isActive: true,
  }).select('_id email name').lean();

  logger.info(`[Scheduler] Sending daily reports to ${users.length} user(s) for ${reportDate}`);

  for (const user of users) {
    try {
      // Analytics stats could be pre-aggregated; here we queue the job and
      // let the email worker call the analytics service for the actual numbers.
      await addEmailJob('daily_report', {
        userId:     user._id.toString(),
        email:      user.email,
        name:       user.name,
        reportDate,
        stats:      null, // emailService / analyticsService fetches live stats
      });
    } catch (err) {
      logger.error(
        `[Scheduler] Could not queue daily_report for user ${user._id}: ${err.message}`
      );
    }
  }
}

/**
 * retryFailedPayments  (*\/30 * * * *)
 * Finds subscriptions in 'past_due' / 'payment_failed' status and queues
 * individual retry jobs.  The billing worker enforces the max-retry policy.
 */
async function retryFailedPayments() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const failedSubs = await Subscription.find({
    status:            { $in: ['past_due', 'payment_failed'] },
    paymentRetryCount: { $lt: 3 },
    // Only retry subscriptions whose first failure is within the 7-day window
    $or: [
      { firstPaymentFailedAt: { $gte: sevenDaysAgo } },
      { firstPaymentFailedAt: { $exists: false } },
    ],
  }).select('_id').lean();

  logger.info(`[Scheduler] Queuing payment retries for ${failedSubs.length} subscription(s)`);

  for (const sub of failedSubs) {
    try {
      await addBillingJob('retry_failed_payment', { subscriptionId: sub._id.toString() });
    } catch (err) {
      logger.error(
        `[Scheduler] Could not queue retry for subscription ${sub._id}: ${err.message}`
      );
    }
  }
}

/**
 * cleanupOldWebhookLogs  (0 2 * * *)
 * Removes WebhookLog documents older than 30 days to keep the collection lean.
 */
async function cleanupOldWebhookLogs() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await WebhookLog.deleteMany({ receivedAt: { $lt: cutoff } });
  logger.info(`[Scheduler] Deleted ${result.deletedCount} old webhook log(s)`);
}

/**
 * cleanupCompletedJobs  (0 2 * * *)
 * BullMQ retains completed / failed jobs up to the removeOnComplete /
 * removeOnFail count configured on each queue.  This task drains anything
 * beyond a secondary threshold to free Redis memory on long-running instances.
 *
 * Note: the primary cleanup is handled by removeOnComplete:{count:1000} on
 * each queue.  This is an extra safety net.
 */
async function cleanupCompletedJobs() {
  const { getQueueStats, ...queues } = require('../queues');

  const queueInstances = [
    queues.emailQueue,
    queues.automationQueue,
    queues.campaignQueue,
    queues.webhookQueue,
    queues.billingQueue,
    queues.notificationQueue,
    queues.analyticsQueue,
    queues.dmQueue,
  ];

  let totalCleaned = 0;

  for (const queue of queueInstances) {
    try {
      // obliterate completed jobs older than 48 hours
      const grace = 48 * 60 * 60 * 1000;
      await queue.clean(grace, 500, 'completed');
      await queue.clean(grace, 500, 'failed');
      totalCleaned++;
    } catch (err) {
      logger.error(
        `[Scheduler] Error cleaning queue "${queue.name}": ${err.message}`
      );
    }
  }

  logger.info(`[Scheduler] cleanupCompletedJobs swept ${totalCleaned} queue(s)`);
}

// ---------------------------------------------------------------------------
// startScheduler
// Registers all cron tasks and starts them.
// ---------------------------------------------------------------------------
function startScheduler() {
  logger.info('[Scheduler] Starting cron scheduler');

  // ------------------------------------------------------------------
  // */5 * * * *  – Check trial expiry every 5 minutes
  // ------------------------------------------------------------------
  registeredTasks.push(
    cron.schedule('*/5 * * * *', () =>
      runTask('checkTrialExpiry', scheduleTrialExpiryCheck)
    )
  );

  // ------------------------------------------------------------------
  // 0 * * * *  – Top of every hour:
  //   1. Check subscription expiry
  //   2. Refresh expiring Instagram tokens
  // ------------------------------------------------------------------
  registeredTasks.push(
    cron.schedule('0 * * * *', () =>
      runTask('checkSubscriptionExpiry', scheduleSubscriptionExpiryCheck)
    )
  );

  registeredTasks.push(
    cron.schedule('0 * * * *', () =>
      runTask('refreshExpiringInstagramTokens', refreshExpiringInstagramTokens)
    )
  );

  // ------------------------------------------------------------------
  // 0 0 * * *  – Midnight UTC:
  //   1. Reset daily DM counters
  //   2. Reset daily API call counters
  // ------------------------------------------------------------------
  registeredTasks.push(
    cron.schedule('0 0 * * *', () =>
      runTask('resetDailyDmCounters', resetDailyDmCounters)
    )
  );

  registeredTasks.push(
    cron.schedule('0 0 * * *', () =>
      runTask('resetDailyApiCallCounters', resetDailyApiCallCounters)
    )
  );

  // ------------------------------------------------------------------
  // 0 9 * * *  – 09:00 UTC: Send daily analytics report emails
  // ------------------------------------------------------------------
  registeredTasks.push(
    cron.schedule('0 9 * * *', () =>
      runTask('sendDailyAnalyticsReports', sendDailyAnalyticsReports)
    )
  );

  // ------------------------------------------------------------------
  // */30 * * * *  – Every 30 minutes: Retry failed payments
  // ------------------------------------------------------------------
  registeredTasks.push(
    cron.schedule('*/30 * * * *', () =>
      runTask('retryFailedPayments', retryFailedPayments)
    )
  );

  // ------------------------------------------------------------------
  // 0 2 * * *  – 02:00 UTC daily:
  //   1. Cleanup old webhook logs (> 30 days)
  //   2. Cleanup completed/failed BullMQ jobs
  // ------------------------------------------------------------------
  registeredTasks.push(
    cron.schedule('0 2 * * *', () =>
      runTask('cleanupOldWebhookLogs', cleanupOldWebhookLogs)
    )
  );

  registeredTasks.push(
    cron.schedule('0 2 * * *', () =>
      runTask('cleanupCompletedJobs', cleanupCompletedJobs)
    )
  );

  logger.info(`[Scheduler] ${registeredTasks.length} cron task(s) registered and running`);

  return registeredTasks;
}

// ---------------------------------------------------------------------------
// stopScheduler
// Stops all registered cron tasks (called during graceful shutdown).
// ---------------------------------------------------------------------------
function stopScheduler() {
  logger.info(`[Scheduler] Stopping ${registeredTasks.length} cron task(s)`);
  for (const task of registeredTasks) {
    try {
      task.stop();
    } catch (err) {
      logger.warn(`[Scheduler] Error stopping cron task: ${err.message}`);
    }
  }
  registeredTasks.length = 0;
  logger.info('[Scheduler] All cron tasks stopped');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  startScheduler,
  stopScheduler,
};
