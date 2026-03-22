'use strict';

const { Worker } = require('bullmq');
const { getBullMQConnection } = require('../config/redis');
const logger = require('../config/logger');
const emailService = require('../services/emailService');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const QUEUE_NAME  = 'email';
const CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// Job handler dispatch map
// Maps job.name -> emailService function
// ---------------------------------------------------------------------------
const JOB_HANDLERS = {
  /**
   * Sent immediately after a new user registers.
   * data: { userId, email, name }
   */
  welcome: async (job) => {
    const { userId, email, name } = job.data;
    await emailService.sendWelcomeEmail({ userId, email, name });
  },

  /**
   * Password-reset link email.
   * data: { userId, email, name, resetToken, resetUrl }
   */
  password_reset: async (job) => {
    const { userId, email, name, resetToken, resetUrl } = job.data;
    await emailService.sendPasswordResetEmail({ userId, email, name, resetToken, resetUrl });
  },

  /**
   * Email-address verification link.
   * data: { userId, email, name, verifyToken, verifyUrl }
   */
  verify_email: async (job) => {
    const { userId, email, name, verifyToken, verifyUrl } = job.data;
    await emailService.sendVerifyEmail({ userId, email, name, verifyToken, verifyUrl });
  },

  /**
   * Sent when a subscription is first confirmed / created.
   * data: { userId, email, name, planName, amount, currency, nextBillingDate }
   */
  subscription_confirmation: async (job) => {
    const { userId, email, name, planName, amount, currency, nextBillingDate } = job.data;
    await emailService.sendSubscriptionConfirmationEmail({
      userId,
      email,
      name,
      planName,
      amount,
      currency,
      nextBillingDate,
    });
  },

  /**
   * Payment receipt.
   * data: { userId, email, name, amount, currency, invoiceId, paymentDate }
   */
  payment_success: async (job) => {
    const { userId, email, name, amount, currency, invoiceId, paymentDate } = job.data;
    await emailService.sendPaymentSuccessEmail({
      userId,
      email,
      name,
      amount,
      currency,
      invoiceId,
      paymentDate,
    });
  },

  /**
   * Payment failure notification.
   * data: { userId, email, name, amount, currency, failureReason, retryDate }
   */
  payment_failed: async (job) => {
    const { userId, email, name, amount, currency, failureReason, retryDate } = job.data;
    await emailService.sendPaymentFailedEmail({
      userId,
      email,
      name,
      amount,
      currency,
      failureReason,
      retryDate,
    });
  },

  /**
   * Subscription cancellation confirmation.
   * data: { userId, email, name, planName, cancelDate, accessUntil }
   */
  subscription_canceled: async (job) => {
    const { userId, email, name, planName, cancelDate, accessUntil } = job.data;
    await emailService.sendSubscriptionCanceledEmail({
      userId,
      email,
      name,
      planName,
      cancelDate,
      accessUntil,
    });
  },

  /**
   * Trial ending soon reminder (sent 24 h before trial expires).
   * data: { userId, email, name, trialEndDate, upgradeUrl }
   */
  trial_ending: async (job) => {
    const { userId, email, name, trialEndDate, upgradeUrl } = job.data;
    await emailService.sendTrialEndingEmail({ userId, email, name, trialEndDate, upgradeUrl });
  },

  /**
   * Invoice / receipt document email.
   * data: { userId, email, name, invoiceId, invoiceUrl, amount, currency, dueDate }
   */
  invoice: async (job) => {
    const { userId, email, name, invoiceId, invoiceUrl, amount, currency, dueDate } = job.data;
    await emailService.sendInvoiceEmail({
      userId,
      email,
      name,
      invoiceId,
      invoiceUrl,
      amount,
      currency,
      dueDate,
    });
  },

  /**
   * Daily analytics summary report.
   * data: { userId, email, name, reportDate, stats }
   */
  daily_report: async (job) => {
    const { userId, email, name, reportDate, stats } = job.data;
    await emailService.sendDailyReportEmail({ userId, email, name, reportDate, stats });
  },

  /**
   * Administrative alert to the ops team.
   * data: { subject, body, severity, metadata }
   */
  admin_alert: async (job) => {
    const { subject, body, severity, metadata } = job.data;
    await emailService.sendAdminAlertEmail({ subject, body, severity, metadata });
  },
};

// ---------------------------------------------------------------------------
// Processor function
// ---------------------------------------------------------------------------
async function processEmailJob(job) {
  const handler = JOB_HANDLERS[job.name];

  if (!handler) {
    const msg = `[EmailWorker] Unknown job type: "${job.name}" (id=${job.id})`;
    logger.warn(msg);
    // Throw so BullMQ marks it as failed and retries won't help – use UnrecoverableError
    const { UnrecoverableError } = require('bullmq');
    throw new UnrecoverableError(msg);
  }

  logger.info(`[EmailWorker] Processing job "${job.name}" id=${job.id}`, {
    jobId: job.id,
    jobName: job.name,
    attempt: job.attemptsMade + 1,
  });

  try {
    await handler(job);
    logger.info(`[EmailWorker] Completed job "${job.name}" id=${job.id}`);
  } catch (err) {
    logger.error(
      `[EmailWorker] Job "${job.name}" id=${job.id} failed on attempt ${job.attemptsMade + 1}: ${err.message}`,
      { stack: err.stack, jobData: job.data }
    );
    throw err; // re-throw so BullMQ can schedule the next retry
  }
}

// ---------------------------------------------------------------------------
// Worker instance
// ---------------------------------------------------------------------------
const emailWorker = new Worker(QUEUE_NAME, processEmailJob, {
  connection: getBullMQConnection(),
  concurrency: CONCURRENCY,
  // Lock duration: 60 s – enough for transactional email providers
  lockDuration: 60_000,
  // Automatically extend the lock if the job is still running
  lockRenewTime: 20_000,
});

// ---------------------------------------------------------------------------
// Worker-level event hooks
// ---------------------------------------------------------------------------
emailWorker.on('completed', (job) => {
  logger.debug(`[EmailWorker] Job "${job.name}" id=${job.id} completed successfully`);
});

emailWorker.on('failed', (job, err) => {
  logger.error(
    `[EmailWorker] Job "${job ? job.name : 'unknown'}" id=${job ? job.id : 'N/A'} permanently failed: ${err.message}`,
    { stack: err.stack }
  );
});

emailWorker.on('stalled', (jobId) => {
  logger.warn(`[EmailWorker] Job id=${jobId} stalled`);
});

emailWorker.on('error', (err) => {
  logger.error(`[EmailWorker] Worker error: ${err.message}`, { stack: err.stack });
});

emailWorker.on('active', (job) => {
  logger.debug(`[EmailWorker] Job "${job.name}" id=${job.id} is now active`);
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = emailWorker;
