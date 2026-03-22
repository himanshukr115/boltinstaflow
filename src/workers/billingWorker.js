'use strict';

const { Worker, UnrecoverableError } = require('bullmq');
const { getBullMQConnection } = require('../config/redis');
const logger = require('../config/logger');
const { addEmailJob, addBillingJob } = require('../queues');

// Models
const Subscription = require('../models/Subscription');
const User         = require('../models/User');

// Services
const billingService = require('../services/billingService');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const QUEUE_NAME   = 'billing';
const CONCURRENCY  = 2;

// Payment retry policy: max 3 retries within 7 days
const MAX_PAYMENT_RETRIES  = 3;
const RETRY_WINDOW_DAYS    = 7;
const RETRY_WINDOW_MS      = RETRY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// How many hours before trial end to fire the reminder
const TRIAL_REMINDER_HOURS = 24;

// How many days before renewal to fire the renewal reminder
const RENEWAL_REMINDER_DAYS = 3;

// ---------------------------------------------------------------------------
// checkTrialExpiry
// Find subscriptions whose trial ends within the next TRIAL_REMINDER_HOURS hours
// that are still in 'trialing' status and haven't had a reminder sent yet.
// ---------------------------------------------------------------------------
async function checkTrialExpiry(job) {
  logger.info('[BillingWorker] checkTrialExpiry started');

  const now             = new Date();
  const reminderCutoff  = new Date(now.getTime() + TRIAL_REMINDER_HOURS * 60 * 60 * 1000);

  // Find trialing subscriptions expiring within the next 24 hours
  const expiringTrials = await Subscription.find({
    status:         'trialing',
    trialEnd:       { $lte: reminderCutoff, $gte: now },
    trialReminderSent: { $ne: true },
  }).populate('userId', 'email name').lean();

  logger.info(`[BillingWorker] Found ${expiringTrials.length} expiring trial(s)`);

  let reminded = 0;

  for (const sub of expiringTrials) {
    try {
      const user = sub.userId; // populated

      if (user && user.email) {
        await addEmailJob('trial_ending', {
          userId:       user._id.toString(),
          email:        user.email,
          name:         user.name,
          trialEndDate: sub.trialEnd,
          upgradeUrl:   `${process.env.APP_URL}/billing/upgrade`,
        });
      }

      // Mark reminder as sent to prevent duplicate emails
      await Subscription.findByIdAndUpdate(sub._id, {
        trialReminderSent:    true,
        trialReminderSentAt:  now,
      });

      reminded++;
    } catch (err) {
      logger.error(
        `[BillingWorker] Failed to send trial reminder for sub ${sub._id}: ${err.message}`,
        { stack: err.stack }
      );
    }
  }

  // Also find trials that have ALREADY ended and still show 'trialing'
  const expiredTrials = await Subscription.find({
    status:   'trialing',
    trialEnd: { $lt: now },
  }).populate('userId', 'email name').lean();

  let expired = 0;

  for (const sub of expiredTrials) {
    try {
      // Transition to 'expired' – billingService handles plan downgrade
      await billingService.expireTrialSubscription(sub._id.toString());
      expired++;
      logger.info(`[BillingWorker] Trial expired for subscription ${sub._id}`);
    } catch (err) {
      logger.error(
        `[BillingWorker] Failed to expire trial sub ${sub._id}: ${err.message}`,
        { stack: err.stack }
      );
    }
  }

  logger.info(`[BillingWorker] checkTrialExpiry done – reminded=${reminded} expired=${expired}`);
  return { reminded, expired };
}

// ---------------------------------------------------------------------------
// checkSubscriptionExpiry
// Find active subscriptions whose current billing period has ended.
// ---------------------------------------------------------------------------
async function checkSubscriptionExpiry(job) {
  logger.info('[BillingWorker] checkSubscriptionExpiry started');

  const now = new Date();

  // 1. Send renewal reminders for subscriptions expiring in the next N days
  const renewalCutoff = new Date(now.getTime() + RENEWAL_REMINDER_DAYS * 24 * 60 * 60 * 1000);

  const upcomingRenewals = await Subscription.find({
    status:                'active',
    currentPeriodEnd:      { $lte: renewalCutoff, $gte: now },
    renewalReminderSent:   { $ne: true },
    cancelAtPeriodEnd:     { $ne: true },
  }).populate('userId', 'email name').lean();

  for (const sub of upcomingRenewals) {
    const user = sub.userId;
    if (user && user.email) {
      await addEmailJob('subscription_confirmation', {
        userId:         user._id.toString(),
        email:          user.email,
        name:           user.name,
        planName:       sub.planName,
        amount:         sub.amount,
        currency:       sub.currency,
        nextBillingDate: sub.currentPeriodEnd,
      });
    }
    await Subscription.findByIdAndUpdate(sub._id, {
      renewalReminderSent:    true,
      renewalReminderSentAt:  now,
    });
  }

  // 2. Expire subscriptions whose period has ended
  const expiredSubs = await Subscription.find({
    status:          'active',
    currentPeriodEnd: { $lt: now },
  }).populate('userId', 'email name').lean();

  let expired = 0;

  for (const sub of expiredSubs) {
    try {
      // Mark as expired and deactivate user plan
      await Subscription.findByIdAndUpdate(sub._id, {
        status:    'expired',
        updatedAt: now,
      });

      await billingService.deactivateUserPlan(sub.userId._id.toString());
      expired++;
      logger.info(`[BillingWorker] Subscription ${sub._id} marked expired`);
    } catch (err) {
      logger.error(
        `[BillingWorker] Failed to expire subscription ${sub._id}: ${err.message}`,
        { stack: err.stack }
      );
    }
  }

  logger.info(
    `[BillingWorker] checkSubscriptionExpiry done – upcomingRenewals=${upcomingRenewals.length} expired=${expired}`
  );
  return { upcomingRenewals: upcomingRenewals.length, expired };
}

// ---------------------------------------------------------------------------
// retryFailedPayment
// job.data: { subscriptionId }
// ---------------------------------------------------------------------------
async function retryFailedPayment(job) {
  const { subscriptionId } = job.data;

  logger.info(`[BillingWorker] retryFailedPayment for subscription ${subscriptionId}`);

  const sub = await Subscription.findById(subscriptionId).populate('userId', 'email name');
  if (!sub) {
    throw new UnrecoverableError(`Subscription ${subscriptionId} not found`);
  }

  // Only retry if the subscription is in a retryable state
  if (!['past_due', 'payment_failed'].includes(sub.status)) {
    logger.info(
      `[BillingWorker] Subscription ${subscriptionId} is in status "${sub.status}", skipping retry`
    );
    return { skipped: true, status: sub.status };
  }

  // Check if we are still within the retry window
  const firstFailedAt = sub.firstPaymentFailedAt || sub.lastPaymentFailedAt;
  if (firstFailedAt && Date.now() - firstFailedAt.getTime() > RETRY_WINDOW_MS) {
    logger.warn(
      `[BillingWorker] Subscription ${subscriptionId} is past the ${RETRY_WINDOW_DAYS}-day retry window, cancelling`
    );
    await billingService.cancelSubscription(subscriptionId, {
      cancelledAt: new Date(),
      reason:      'max_retry_window_exceeded',
    });
    return { cancelled: true, reason: 'max_retry_window_exceeded' };
  }

  const retryCount = sub.paymentRetryCount || 0;

  if (retryCount >= MAX_PAYMENT_RETRIES) {
    logger.warn(
      `[BillingWorker] Subscription ${subscriptionId} has exhausted ${MAX_PAYMENT_RETRIES} retries, cancelling`
    );
    await billingService.cancelSubscription(subscriptionId, {
      cancelledAt: new Date(),
      reason:      'max_retries_exceeded',
    });

    const user = sub.userId;
    if (user) {
      await addEmailJob('subscription_canceled', {
        userId:      user._id.toString(),
        email:       user.email,
        name:        user.name,
        planName:    sub.planName,
        cancelDate:  new Date(),
        accessUntil: sub.currentPeriodEnd,
      });
    }
    return { cancelled: true, reason: 'max_retries_exceeded', retryCount };
  }

  // Attempt payment retry via gateway
  try {
    const result = await billingService.retryPayment(subscriptionId);

    if (result.success) {
      // Activate subscription and reset retry counters
      await billingService.activateSubscription(subscriptionId, {
        paymentId: result.paymentId,
        amount:    result.amount,
        currency:  result.currency,
      });

      await Subscription.findByIdAndUpdate(subscriptionId, {
        paymentRetryCount:  0,
        lastPaymentFailedAt: null,
        lastPaymentError:   null,
      });

      const user = sub.userId;
      if (user) {
        await addEmailJob('payment_success', {
          userId:      user._id.toString(),
          email:       user.email,
          name:        user.name,
          amount:      result.amount,
          currency:    result.currency,
          invoiceId:   result.paymentId,
          paymentDate: new Date(),
        });
      }

      logger.info(`[BillingWorker] Payment retry succeeded for subscription ${subscriptionId}`);
      return { success: true, paymentId: result.paymentId };
    } else {
      // Retry failed – increment counter
      const newRetryCount = retryCount + 1;
      await Subscription.findByIdAndUpdate(subscriptionId, {
        paymentRetryCount:  newRetryCount,
        lastPaymentFailedAt: new Date(),
        lastPaymentError:    result.error || 'Unknown error',
        // Track first failure timestamp for the retry window
        ...(!sub.firstPaymentFailedAt ? { firstPaymentFailedAt: new Date() } : {}),
      });

      const user = sub.userId;
      if (user) {
        await addEmailJob('payment_failed', {
          userId:        user._id.toString(),
          email:         user.email,
          name:          user.name,
          amount:        sub.amount,
          currency:      sub.currency,
          failureReason: result.error,
        });
      }

      logger.warn(
        `[BillingWorker] Payment retry ${newRetryCount}/${MAX_PAYMENT_RETRIES} failed for subscription ${subscriptionId}: ${result.error}`
      );
      return { success: false, retryCount: newRetryCount, error: result.error };
    }
  } catch (err) {
    logger.error(
      `[BillingWorker] retryFailedPayment threw for sub ${subscriptionId}: ${err.message}`,
      { stack: err.stack }
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// sendTrialReminder
// Explicit job variant used by the scheduler for batch trial reminders.
// data: { subscriptionId } – or omit to process all
// ---------------------------------------------------------------------------
async function sendTrialReminder(job) {
  const { subscriptionId } = job.data || {};

  if (subscriptionId) {
    const sub = await Subscription.findById(subscriptionId).populate('userId', 'email name').lean();
    if (!sub) throw new UnrecoverableError(`Subscription ${subscriptionId} not found`);

    const user = sub.userId;
    if (user) {
      await addEmailJob('trial_ending', {
        userId:       user._id.toString(),
        email:        user.email,
        name:         user.name,
        trialEndDate: sub.trialEnd,
        upgradeUrl:   `${process.env.APP_URL}/billing/upgrade`,
      });
    }
    return { sent: 1 };
  }

  // Fallback: delegate to the full check
  return checkTrialExpiry(job);
}

// ---------------------------------------------------------------------------
// sendRenewalReminder
// Explicit job variant used by the scheduler.
// data: { subscriptionId }
// ---------------------------------------------------------------------------
async function sendRenewalReminder(job) {
  const { subscriptionId } = job.data || {};

  if (subscriptionId) {
    const sub = await Subscription.findById(subscriptionId).populate('userId', 'email name').lean();
    if (!sub) throw new UnrecoverableError(`Subscription ${subscriptionId} not found`);

    const user = sub.userId;
    if (user) {
      await addEmailJob('subscription_confirmation', {
        userId:         user._id.toString(),
        email:          user.email,
        name:           user.name,
        planName:       sub.planName,
        amount:         sub.amount,
        currency:       sub.currency,
        nextBillingDate: sub.currentPeriodEnd,
      });
    }
    return { sent: 1 };
  }

  return checkSubscriptionExpiry(job);
}

// ---------------------------------------------------------------------------
// Main processor dispatcher
// ---------------------------------------------------------------------------
async function processBillingJob(job) {
  logger.info(`[BillingWorker] Processing job "${job.name}" id=${job.id}`, {
    jobId:   job.id,
    attempt: job.attemptsMade + 1,
  });

  switch (job.name) {
    case 'check_trial_expiry':
      return checkTrialExpiry(job);
    case 'check_subscription_expiry':
      return checkSubscriptionExpiry(job);
    case 'retry_failed_payment':
      return retryFailedPayment(job);
    case 'send_trial_reminder':
      return sendTrialReminder(job);
    case 'send_renewal_reminder':
      return sendRenewalReminder(job);
    default: {
      const msg = `[BillingWorker] Unknown job type: "${job.name}"`;
      logger.warn(msg);
      throw new UnrecoverableError(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker instance
// ---------------------------------------------------------------------------
const billingWorker = new Worker(QUEUE_NAME, processBillingJob, {
  connection:    getBullMQConnection(),
  concurrency:   CONCURRENCY,
  lockDuration:  120_000,
  lockRenewTime:  30_000,
});

billingWorker.on('completed', (job, result) => {
  logger.debug(`[BillingWorker] Job "${job.name}" id=${job.id} completed`, { result });
});

billingWorker.on('failed', (job, err) => {
  logger.error(
    `[BillingWorker] Job "${job ? job.name : 'unknown'}" id=${job ? job.id : 'N/A'} failed: ${err.message}`,
    { stack: err.stack }
  );
});

billingWorker.on('stalled', (jobId) => {
  logger.warn(`[BillingWorker] Job id=${jobId} stalled`);
});

billingWorker.on('error', (err) => {
  logger.error(`[BillingWorker] Worker error: ${err.message}`, { stack: err.stack });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = billingWorker;
