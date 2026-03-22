'use strict';

const { Worker, UnrecoverableError } = require('bullmq');
const { getBullMQConnection } = require('../config/redis');
const logger = require('../config/logger');
const { addAutomationJob, addEmailJob } = require('../queues');

// Models
const Contact      = require('../models/Contact');
const Automation   = require('../models/Automation');
const Subscription = require('../models/Subscription');
const User         = require('../models/User');
const WebhookLog   = require('../models/WebhookLog');

// Services
const billingService = require('../services/billingService');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const QUEUE_NAME   = 'webhook';
const CONCURRENCY  = 20;

// ---------------------------------------------------------------------------
// processInstagramWebhook
// Handles Meta Graph API webhook callbacks.
// data: { payload, accountId, userId, verifyToken }
// ---------------------------------------------------------------------------
async function processInstagramWebhook(job) {
  const { payload, accountId, userId } = job.data;

  if (!payload || !Array.isArray(payload.entry)) {
    logger.warn(`[WebhookWorker] Instagram webhook has no entry array`, { jobId: job.id });
    return { skipped: true };
  }

  for (const entry of payload.entry) {
    const igAccountId = entry.id;

    // -----------------------------------------------------------------------
    // Messaging events (DMs)
    // -----------------------------------------------------------------------
    if (Array.isArray(entry.messaging)) {
      for (const messagingEvent of entry.messaging) {
        try {
          await handleInstagramMessage(messagingEvent, igAccountId, accountId, userId);
        } catch (err) {
          logger.error(
            `[WebhookWorker] Error handling messaging event: ${err.message}`,
            { stack: err.stack, messagingEvent }
          );
        }
      }
    }

    // -----------------------------------------------------------------------
    // Comment events
    // -----------------------------------------------------------------------
    if (Array.isArray(entry.changes)) {
      for (const change of entry.changes) {
        try {
          if (change.field === 'comments') {
            await handleInstagramComment(change.value, igAccountId, accountId, userId);
          } else if (change.field === 'story_mentions') {
            await handleStoryMention(change.value, igAccountId, accountId, userId);
          } else if (change.field === 'mentions') {
            await handleMention(change.value, igAccountId, accountId, userId);
          }
        } catch (err) {
          logger.error(
            `[WebhookWorker] Error handling change field="${change.field}": ${err.message}`,
            { stack: err.stack, change }
          );
        }
      }
    }
  }

  return { processed: true };
}

// ---------------------------------------------------------------------------
// Instagram sub-handlers
// ---------------------------------------------------------------------------

async function handleInstagramMessage(event, igAccountId, accountId, userId) {
  // Ignore echo messages (sent by the page itself)
  if (event.message && event.message.is_echo) return;

  const senderId   = event.sender && event.sender.id;
  const recipientId = event.recipient && event.recipient.id;
  const messageText = (event.message && event.message.text) || '';
  const timestamp   = event.timestamp ? new Date(event.timestamp) : new Date();

  if (!senderId) return;

  logger.info(
    `[WebhookWorker] New DM from ${senderId} to account ${igAccountId}: "${messageText.slice(0, 80)}"`
  );

  // Find or create contact
  let contact = await Contact.findOne({ instagramId: senderId, accountId });
  if (!contact) {
    contact = await Contact.create({
      instagramId:            senderId,
      accountId,
      userId,
      source:                 'dm',
      firstMessageAt:         timestamp,
      lastMessageReceivedAt:  timestamp,
    });
    logger.info(`[WebhookWorker] Created new contact ${contact._id} for IG user ${senderId}`);
  } else {
    // Update last message timestamp (important for 24-hour window eligibility)
    await Contact.findByIdAndUpdate(contact._id, {
      lastMessageReceivedAt: timestamp,
      $inc: { messageCount: 1 },
    });
  }

  // Attempt to match and trigger automation
  await matchAutomationTrigger('dm', { message: messageText, senderId, recipientId, timestamp }, userId, accountId, contact._id.toString());
}

async function handleInstagramComment(value, igAccountId, accountId, userId) {
  const commentText = value.text || '';
  const commentId   = value.id;
  const mediaId     = value.media && value.media.id;
  const senderId    = value.from && value.from.id;

  if (!senderId) return;

  logger.info(
    `[WebhookWorker] New comment from ${senderId} on media ${mediaId}: "${commentText.slice(0, 80)}"`
  );

  // Find or create contact
  let contact = await Contact.findOne({ instagramId: senderId, accountId });
  if (!contact) {
    contact = await Contact.create({
      instagramId: senderId,
      accountId,
      userId,
      source:      'comment',
      firstCommentAt: new Date(),
    });
  }

  // Match keyword triggers for comments
  await matchAutomationTrigger(
    'comment',
    { message: commentText, commentId, mediaId, senderId },
    userId,
    accountId,
    contact._id.toString()
  );
}

async function handleStoryMention(value, igAccountId, accountId, userId) {
  const senderId = value.sender_id || (value.from && value.from.id);
  if (!senderId) return;

  logger.info(`[WebhookWorker] Story mention from ${senderId} on account ${igAccountId}`);

  let contact = await Contact.findOne({ instagramId: senderId, accountId });
  if (!contact) {
    contact = await Contact.create({
      instagramId:   senderId,
      accountId,
      userId,
      source:        'story_mention',
      firstMentionAt: new Date(),
    });
  }

  // Persist the story mention event on the contact
  await Contact.findByIdAndUpdate(contact._id, {
    $push: {
      events: {
        type:      'story_mention',
        data:      value,
        createdAt: new Date(),
      },
    },
    $inc: { storyMentionCount: 1 },
    lastStoryMentionAt: new Date(),
  });

  // Match story_mention triggers
  await matchAutomationTrigger('story_mention', { senderId, data: value }, userId, accountId, contact._id.toString());
}

async function handleMention(value, igAccountId, accountId, userId) {
  const senderId = value.sender_id || (value.from && value.from.id);
  if (!senderId) return;

  logger.info(`[WebhookWorker] Caption/post mention from ${senderId}`);

  let contact = await Contact.findOne({ instagramId: senderId, accountId });
  if (!contact) {
    contact = await Contact.create({
      instagramId: senderId,
      accountId,
      userId,
      source: 'mention',
    });
  }

  await matchAutomationTrigger('mention', { senderId, data: value }, userId, accountId, contact._id.toString());
}

// ---------------------------------------------------------------------------
// processRazorpayWebhook
// data: { event, payload, signature, rawBody }
// ---------------------------------------------------------------------------
async function processRazorpayWebhook(job) {
  const { event, payload } = job.data;

  logger.info(`[WebhookWorker] Razorpay event: ${event}`);

  // Log the webhook for audit
  await _logWebhook('razorpay', event, payload);

  switch (event) {
    case 'payment.captured':
      await handleRazorpayPaymentCaptured(payload);
      break;

    case 'subscription.activated':
      await handleRazorpaySubscriptionActivated(payload);
      break;

    case 'subscription.charged':
      await handleRazorpaySubscriptionCharged(payload);
      break;

    case 'subscription.halted':
      // Subscription payment has failed multiple times – mark as past_due
      await handleRazorpaySubscriptionHalted(payload);
      break;

    case 'subscription.cancelled':
      await handleRazorpaySubscriptionCancelled(payload);
      break;

    case 'payment.failed':
      await handleRazorpayPaymentFailed(payload);
      break;

    case 'subscription.pending':
      logger.info(`[WebhookWorker] Razorpay subscription pending`, { payload });
      break;

    default:
      logger.warn(`[WebhookWorker] Unhandled Razorpay event: ${event}`);
  }

  return { processed: true, event };
}

async function handleRazorpayPaymentCaptured(payload) {
  const payment  = payload.payment && payload.payment.entity;
  if (!payment) return;

  // Try to find subscription by Razorpay subscription_id if present
  if (payment.subscription_id) {
    const sub = await Subscription.findOne({
      'gateway.subscriptionId': payment.subscription_id,
    });
    if (sub && sub.status !== 'active') {
      await billingService.activateSubscription(sub._id.toString(), {
        paymentId: payment.id,
        amount:    payment.amount / 100, // paise -> rupees
        currency:  payment.currency,
      });
      logger.info(`[WebhookWorker] Activated subscription ${sub._id} via payment ${payment.id}`);
    }
  }
}

async function handleRazorpaySubscriptionActivated(payload) {
  const sub = payload.subscription && payload.subscription.entity;
  if (!sub) return;

  const localSub = await Subscription.findOne({ 'gateway.subscriptionId': sub.id });
  if (!localSub) {
    logger.warn(`[WebhookWorker] No local subscription found for Razorpay sub ${sub.id}`);
    return;
  }

  await billingService.activateSubscription(localSub._id.toString(), {
    currentPeriodStart: new Date(sub.current_start * 1000),
    currentPeriodEnd:   new Date(sub.current_end   * 1000),
  });

  const user = await User.findById(localSub.userId);
  if (user) {
    await addEmailJob('subscription_confirmation', {
      userId:         user._id.toString(),
      email:          user.email,
      name:           user.name,
      planName:       localSub.planName,
      amount:         localSub.amount,
      currency:       localSub.currency,
      nextBillingDate: new Date(sub.current_end * 1000),
    });
  }
}

async function handleRazorpaySubscriptionCharged(payload) {
  const sub     = payload.subscription && payload.subscription.entity;
  const payment = payload.payment      && payload.payment.entity;
  if (!sub || !payment) return;

  const localSub = await Subscription.findOne({ 'gateway.subscriptionId': sub.id });
  if (!localSub) return;

  // Extend the billing period
  await billingService.recordSuccessfulCharge(localSub._id.toString(), {
    paymentId:          payment.id,
    amount:             payment.amount / 100,
    currency:           payment.currency,
    currentPeriodStart: new Date(sub.current_start * 1000),
    currentPeriodEnd:   new Date(sub.current_end   * 1000),
  });

  const user = await User.findById(localSub.userId);
  if (user) {
    await addEmailJob('payment_success', {
      userId:      user._id.toString(),
      email:       user.email,
      name:        user.name,
      amount:      payment.amount / 100,
      currency:    payment.currency,
      invoiceId:   payment.id,
      paymentDate: new Date(),
    });
  }
}

async function handleRazorpaySubscriptionHalted(payload) {
  const sub = payload.subscription && payload.subscription.entity;
  if (!sub) return;

  const localSub = await Subscription.findOneAndUpdate(
    { 'gateway.subscriptionId': sub.id },
    { status: 'past_due', updatedAt: new Date() },
    { new: true }
  );

  if (!localSub) return;

  // Downgrade user to free/restricted plan
  await billingService.deactivateUserPlan(localSub.userId.toString());

  const user = await User.findById(localSub.userId);
  if (user) {
    await addEmailJob('payment_failed', {
      userId:        user._id.toString(),
      email:         user.email,
      name:          user.name,
      amount:        localSub.amount,
      currency:      localSub.currency,
      failureReason: 'Subscription halted after multiple payment failures',
    });
  }
  logger.warn(`[WebhookWorker] Subscription ${localSub._id} halted / past_due`);
}

async function handleRazorpaySubscriptionCancelled(payload) {
  const sub = payload.subscription && payload.subscription.entity;
  if (!sub) return;

  const localSub = await Subscription.findOne({ 'gateway.subscriptionId': sub.id });
  if (!localSub) return;

  await billingService.cancelSubscription(localSub._id.toString(), {
    cancelledAt: new Date(sub.cancelled_at * 1000),
  });

  const user = await User.findById(localSub.userId);
  if (user) {
    await addEmailJob('subscription_canceled', {
      userId:      user._id.toString(),
      email:       user.email,
      name:        user.name,
      planName:    localSub.planName,
      cancelDate:  new Date(),
      accessUntil: localSub.currentPeriodEnd,
    });
  }
  logger.info(`[WebhookWorker] Subscription ${localSub._id} cancelled`);
}

async function handleRazorpayPaymentFailed(payload) {
  const payment = payload.payment && payload.payment.entity;
  if (!payment) return;

  if (payment.subscription_id) {
    const localSub = await Subscription.findOne({
      'gateway.subscriptionId': payment.subscription_id,
    });

    if (localSub) {
      const retryCount = (localSub.paymentRetryCount || 0) + 1;
      await Subscription.findByIdAndUpdate(localSub._id, {
        $inc: { paymentRetryCount: 1 },
        lastPaymentFailedAt: new Date(),
        lastPaymentError:    payment.error_description || 'Unknown error',
      });

      const user = await User.findById(localSub.userId);
      if (user) {
        await addEmailJob('payment_failed', {
          userId:        user._id.toString(),
          email:         user.email,
          name:          user.name,
          amount:        payment.amount / 100,
          currency:      payment.currency,
          failureReason: payment.error_description,
        });
      }

      if (retryCount >= 3) {
        logger.warn(`[WebhookWorker] Subscription ${localSub._id} payment failed ${retryCount} times`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// processCashfreeWebhook
// data: { event, data, signature }
// ---------------------------------------------------------------------------
async function processCashfreeWebhook(job) {
  const { event, data } = job.data;

  logger.info(`[WebhookWorker] Cashfree event: ${event}`);
  await _logWebhook('cashfree', event, data);

  switch (event) {
    case 'PAYMENT_SUCCESS':
      await handleCashfreePaymentSuccess(data);
      break;

    case 'PAYMENT_FAILED':
      await handleCashfreePaymentFailed(data);
      break;

    case 'PAYMENT_USER_DROPPED':
      logger.info(`[WebhookWorker] Cashfree user dropped payment`, { data });
      break;

    case 'SUBSCRIPTION_PAYMENT_SUCCESS':
      await handleCashfreeSubscriptionPaymentSuccess(data);
      break;

    case 'SUBSCRIPTION_PAYMENT_FAILED':
      await handleCashfreeSubscriptionPaymentFailed(data);
      break;

    case 'SUBSCRIPTION_ACTIVATED':
      await handleCashfreeSubscriptionActivated(data);
      break;

    case 'SUBSCRIPTION_CANCELLED':
      await handleCashfreeSubscriptionCancelled(data);
      break;

    case 'SUBSCRIPTION_STATUS_CHANGE':
      await handleCashfreeSubscriptionStatusChange(data);
      break;

    default:
      logger.warn(`[WebhookWorker] Unhandled Cashfree event: ${event}`);
  }

  return { processed: true, event };
}

async function handleCashfreePaymentSuccess(data) {
  const orderId = data.order && data.order.order_id;
  if (!orderId) return;

  const localSub = await Subscription.findOne({ 'gateway.orderId': orderId });
  if (!localSub) {
    logger.warn(`[WebhookWorker] Cashfree: No subscription found for orderId ${orderId}`);
    return;
  }

  await billingService.activateSubscription(localSub._id.toString(), {
    paymentId: data.payment && data.payment.cf_payment_id,
    amount:    data.order   && data.order.order_amount,
    currency:  data.order   && data.order.order_currency,
  });

  const user = await User.findById(localSub.userId);
  if (user) {
    await addEmailJob('payment_success', {
      userId:      user._id.toString(),
      email:       user.email,
      name:        user.name,
      amount:      data.order && data.order.order_amount,
      currency:    data.order && data.order.order_currency,
      invoiceId:   data.payment && data.payment.cf_payment_id,
      paymentDate: new Date(),
    });
  }
}

async function handleCashfreePaymentFailed(data) {
  const orderId = data.order && data.order.order_id;
  if (!orderId) return;

  const localSub = await Subscription.findOne({ 'gateway.orderId': orderId });
  if (!localSub) return;

  await Subscription.findByIdAndUpdate(localSub._id, {
    $inc:                { paymentRetryCount: 1 },
    lastPaymentFailedAt: new Date(),
    lastPaymentError:    (data.payment && data.payment.payment_message) || 'Unknown',
  });

  const user = await User.findById(localSub.userId);
  if (user) {
    await addEmailJob('payment_failed', {
      userId:        user._id.toString(),
      email:         user.email,
      name:          user.name,
      amount:        data.order && data.order.order_amount,
      currency:      data.order && data.order.order_currency,
      failureReason: data.payment && data.payment.payment_message,
    });
  }
}

async function handleCashfreeSubscriptionPaymentSuccess(data) {
  const subId = data.subscription && data.subscription.subscription_id;
  if (!subId) return;

  const localSub = await Subscription.findOne({ 'gateway.subscriptionId': subId });
  if (!localSub) return;

  await billingService.recordSuccessfulCharge(localSub._id.toString(), {
    paymentId: data.payment && data.payment.cf_payment_id,
    amount:    data.payment && data.payment.payment_amount,
    currency:  'INR',
  });
}

async function handleCashfreeSubscriptionPaymentFailed(data) {
  const subId = data.subscription && data.subscription.subscription_id;
  if (!subId) return;

  const localSub = await Subscription.findOneAndUpdate(
    { 'gateway.subscriptionId': subId },
    {
      $inc:                { paymentRetryCount: 1 },
      lastPaymentFailedAt: new Date(),
    },
    { new: true }
  );

  if (localSub && localSub.paymentRetryCount >= 3) {
    await billingService.deactivateUserPlan(localSub.userId.toString());
  }
}

async function handleCashfreeSubscriptionActivated(data) {
  const subId = data.subscription && data.subscription.subscription_id;
  if (!subId) return;

  const localSub = await Subscription.findOneAndUpdate(
    { 'gateway.subscriptionId': subId },
    { status: 'active', activatedAt: new Date() },
    { new: true }
  );

  if (localSub) {
    await billingService.activateUserPlan(localSub.userId.toString(), localSub.planId.toString());
  }
}

async function handleCashfreeSubscriptionCancelled(data) {
  const subId = data.subscription && data.subscription.subscription_id;
  if (!subId) return;

  const localSub = await Subscription.findOne({ 'gateway.subscriptionId': subId });
  if (!localSub) return;

  await billingService.cancelSubscription(localSub._id.toString(), { cancelledAt: new Date() });

  const user = await User.findById(localSub.userId);
  if (user) {
    await addEmailJob('subscription_canceled', {
      userId:      user._id.toString(),
      email:       user.email,
      name:        user.name,
      planName:    localSub.planName,
      cancelDate:  new Date(),
      accessUntil: localSub.currentPeriodEnd,
    });
  }
}

async function handleCashfreeSubscriptionStatusChange(data) {
  const subId  = data.subscription && data.subscription.subscription_id;
  const status = data.subscription && data.subscription.status;
  if (!subId || !status) return;

  logger.info(`[WebhookWorker] Cashfree subscription ${subId} status -> ${status}`);

  await Subscription.findOneAndUpdate(
    { 'gateway.subscriptionId': subId },
    { status: _mapCashfreeStatus(status), updatedAt: new Date() }
  );
}

function _mapCashfreeStatus(cfStatus) {
  const map = {
    ACTIVE:    'active',
    INACTIVE:  'inactive',
    CANCELLED: 'cancelled',
    EXPIRED:   'expired',
    ON_HOLD:   'past_due',
  };
  return map[cfStatus] || 'unknown';
}

// ---------------------------------------------------------------------------
// matchAutomationTrigger
// Find all active Automations for the given userId+accountId that match the
// trigger type and keyword, then queue automation jobs.
// ---------------------------------------------------------------------------
async function matchAutomationTrigger(triggerType, data, userId, accountId, contactId) {
  const message = (data.message || '').toLowerCase().trim();

  // Query for automations matching this trigger type
  const automations = await Automation.find({
    userId,
    accountId,
    status: 'active',
    'trigger.type': triggerType,
  }).lean();

  if (!automations.length) return;

  for (const automation of automations) {
    const trigger = automation.trigger || {};

    // Keyword matching
    if (trigger.keyword) {
      const keyword = trigger.keyword.toLowerCase().trim();
      const matchMode = trigger.matchMode || 'contains'; // 'exact' | 'contains' | 'starts_with'

      let matched = false;
      switch (matchMode) {
        case 'exact':
          matched = message === keyword;
          break;
        case 'starts_with':
          matched = message.startsWith(keyword);
          break;
        case 'contains':
        default:
          matched = message.includes(keyword);
      }

      if (!matched) continue;
    }

    logger.info(
      `[WebhookWorker] Matched automation ${automation._id} (trigger=${triggerType}) for contact ${contactId}`
    );

    await addAutomationJob('process_trigger', {
      automationId: automation._id.toString(),
      contactId,
      triggerData: data,
    });
  }
}

// ---------------------------------------------------------------------------
// Audit log helper
// ---------------------------------------------------------------------------
async function _logWebhook(provider, event, payload) {
  try {
    await WebhookLog.create({
      provider,
      event,
      payload,
      receivedAt: new Date(),
    });
  } catch (err) {
    logger.warn(`[WebhookWorker] Could not write WebhookLog: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main processor dispatcher
// ---------------------------------------------------------------------------
async function processWebhookJob(job) {
  logger.info(`[WebhookWorker] Processing job "${job.name}" id=${job.id}`, {
    jobId:   job.id,
    attempt: job.attemptsMade + 1,
  });

  switch (job.name) {
    case 'instagram_webhook':
      return processInstagramWebhook(job);
    case 'razorpay_webhook':
      return processRazorpayWebhook(job);
    case 'cashfree_webhook':
      return processCashfreeWebhook(job);
    default: {
      const msg = `[WebhookWorker] Unknown job type: "${job.name}"`;
      logger.warn(msg);
      throw new UnrecoverableError(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker instance
// ---------------------------------------------------------------------------
const webhookWorker = new Worker(QUEUE_NAME, processWebhookJob, {
  connection:    getBullMQConnection(),
  concurrency:   CONCURRENCY,
  lockDuration:  30_000,
  lockRenewTime:  10_000,
});

webhookWorker.on('completed', (job) => {
  logger.debug(`[WebhookWorker] Job "${job.name}" id=${job.id} completed`);
});

webhookWorker.on('failed', (job, err) => {
  logger.error(
    `[WebhookWorker] Job "${job ? job.name : 'unknown'}" id=${job ? job.id : 'N/A'} failed: ${err.message}`,
    { stack: err.stack }
  );
});

webhookWorker.on('stalled', (jobId) => {
  logger.warn(`[WebhookWorker] Job id=${jobId} stalled`);
});

webhookWorker.on('error', (err) => {
  logger.error(`[WebhookWorker] Worker error: ${err.message}`, { stack: err.stack });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = webhookWorker;
