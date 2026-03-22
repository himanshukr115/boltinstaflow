'use strict';

const { Worker, UnrecoverableError } = require('bullmq');
const { getBullMQConnection, getRedisClient } = require('../config/redis');
const logger = require('../config/logger');
const { addDmJob } = require('../queues');

// Models
const Contact = require('../models/Contact');
const Account = require('../models/Account');

// Services
const instagramService = require('../services/instagramService');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const QUEUE_NAME   = 'dm';
const CONCURRENCY  = 5;

// Rate-limit policy (all values are adjustable via env or account settings)
const DEFAULT_DAILY_LIMIT     = parseInt(process.env.DM_DAILY_LIMIT     || '1000', 10);
const DEFAULT_HOURLY_NEW_LIMIT = parseInt(process.env.DM_HOURLY_NEW_LIMIT || '20',   10);

// Redis key templates
// daily:   ig:rl:{accountId}:daily:{YYYY-MM-DD}
// hourly:  ig:rl:{accountId}:hourly_new:{YYYY-MM-DDTHH}
const DAILY_KEY_TTL  = 25 * 60 * 60; // 25 hours (buffer past midnight)
const HOURLY_KEY_TTL =  2 * 60 * 60; // 2 hours (buffer past hour boundary)

// ---------------------------------------------------------------------------
// Rate-limit helpers
// ---------------------------------------------------------------------------

/**
 * Returns ISO date string in YYYY-MM-DD format (UTC).
 */
function dailyBucket() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns ISO date-hour string in YYYY-MM-DDTHH format (UTC).
 */
function hourlyBucket() {
  return new Date().toISOString().slice(0, 13);
}

/**
 * Milliseconds until the start of the next UTC hour.
 */
function msUntilNextHour() {
  const now   = new Date();
  const next  = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Milliseconds until the start of the next UTC day.
 */
function msUntilNextDay() {
  const now  = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  ));
  return next.getTime() - now.getTime();
}

/**
 * Atomically increment a Redis counter and set TTL on creation.
 * Returns the new counter value.
 */
async function incrementCounter(redis, key, ttlSeconds) {
  const pipeline = redis.pipeline();
  pipeline.incr(key);
  pipeline.expire(key, ttlSeconds);
  const results = await pipeline.exec();
  // results[0] = [err, newValue]
  return results[0][1];
}

/**
 * Get current counter value (returns 0 if key doesn't exist).
 */
async function getCounter(redis, key) {
  const val = await redis.get(key);
  return parseInt(val || '0', 10);
}

// ---------------------------------------------------------------------------
// checkAndConsumeRateLimit
// Returns { allowed: true } if the DM can be sent, or
// { allowed: false, delayMs: <number>, reason: <string> } if rate-limited.
// Does NOT consume the token if not allowed.
// ---------------------------------------------------------------------------
async function checkAndConsumeRateLimit(redis, accountId, isNewContact, limits) {
  const dailyKey  = `ig:rl:${accountId}:daily:${dailyBucket()}`;
  const hourlyKey = `ig:rl:${accountId}:hourly_new:${hourlyBucket()}`;

  const dailyCount  = await getCounter(redis, dailyKey);
  const hourlyCount = isNewContact ? await getCounter(redis, hourlyKey) : 0;

  const dailyLimit  = limits.dailyLimit  || DEFAULT_DAILY_LIMIT;
  const hourlyLimit = limits.hourlyNewLimit || DEFAULT_HOURLY_NEW_LIMIT;

  // Check daily limit
  if (dailyCount >= dailyLimit) {
    return {
      allowed:  false,
      delayMs:  msUntilNextDay(),
      reason:   `daily_limit_exceeded (${dailyCount}/${dailyLimit})`,
    };
  }

  // Check hourly new-contact limit
  if (isNewContact && hourlyCount >= hourlyLimit) {
    return {
      allowed:  false,
      delayMs:  msUntilNextHour(),
      reason:   `hourly_new_limit_exceeded (${hourlyCount}/${hourlyLimit})`,
    };
  }

  // Consume tokens
  await incrementCounter(redis, dailyKey, DAILY_KEY_TTL);
  if (isNewContact) {
    await incrementCounter(redis, hourlyKey, HOURLY_KEY_TTL);
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// sendDm
// Handles job.name === 'send_dm'
// data: { accountId, contactId, recipientInstagramId, message, mediaUrl, isNewContact, automationLogId }
// ---------------------------------------------------------------------------
async function sendDm(job) {
  const {
    accountId,
    contactId,
    recipientInstagramId,
    message,
    mediaUrl        = null,
    isNewContact    = false,
    automationLogId = null,
  } = job.data;

  // Load account to get token and configured limits
  const account = await Account.findById(accountId);
  if (!account) {
    throw new UnrecoverableError(`Account ${accountId} not found`);
  }
  if (!account.accessToken) {
    throw new UnrecoverableError(`Account ${accountId} has no access token`);
  }
  if (account.status !== 'active') {
    throw new UnrecoverableError(`Account ${accountId} is not active (status=${account.status})`);
  }

  const limits = {
    dailyLimit:    account.dmQuotaDaily    || DEFAULT_DAILY_LIMIT,
    hourlyNewLimit: account.dmQuotaHourlyNew || DEFAULT_HOURLY_NEW_LIMIT,
  };

  // -------------------------------------------------------------------------
  // Rate limit check
  // -------------------------------------------------------------------------
  const redis    = getRedisClient();
  const rlResult = await checkAndConsumeRateLimit(redis, accountId, isNewContact, limits);

  if (!rlResult.allowed) {
    logger.warn(
      `[DmWorker] Rate limit hit for account ${accountId}: ${rlResult.reason}. Delaying job by ${rlResult.delayMs}ms`
    );

    // Re-queue this job with a delay so it retries after the window resets
    await addDmJob('send_dm', job.data, { delay: rlResult.delayMs });

    // Return without error so BullMQ marks this job as completed
    // (the actual delivery is handled by the newly queued delayed job)
    return {
      rateLimited:  true,
      reason:       rlResult.reason,
      requeueDelay: rlResult.delayMs,
    };
  }

  // -------------------------------------------------------------------------
  // Send DM via Instagram Graph API
  // -------------------------------------------------------------------------
  logger.info(
    `[DmWorker] Sending DM from account=${accountId} to=${recipientInstagramId}`
  );

  let messageId;
  try {
    const result = await instagramService.sendDM({
      accountId,
      // instagramService handles token decryption internally
      accessToken:  account.accessToken,
      recipientId:  recipientInstagramId,
      message,
      mediaUrl,
    });
    messageId = result.messageId;
  } catch (err) {
    // On Graph API error, roll back the consumed rate-limit token
    try {
      const dailyKey = `ig:rl:${accountId}:daily:${dailyBucket()}`;
      await redis.decr(dailyKey);
      if (isNewContact) {
        const hourlyKey = `ig:rl:${accountId}:hourly_new:${hourlyBucket()}`;
        await redis.decr(hourlyKey);
      }
    } catch (rollbackErr) {
      logger.warn(`[DmWorker] Could not roll back rate-limit counter: ${rollbackErr.message}`);
    }

    // Detect non-retryable Graph API errors
    const nonRetryableCodes = [100, 190, 200, 10, 368];
    if (err.graphApiCode && nonRetryableCodes.includes(err.graphApiCode)) {
      throw new UnrecoverableError(
        `Instagram Graph API non-retryable error ${err.graphApiCode}: ${err.message}`
      );
    }

    throw err; // retryable – BullMQ will schedule retry
  }

  // -------------------------------------------------------------------------
  // Post-send updates
  // -------------------------------------------------------------------------

  // Update contact record
  if (contactId) {
    await Contact.findByIdAndUpdate(contactId, {
      lastContactedAt: new Date(),
      $inc:            { dmCount: 1 },
      $push: {
        dmHistory: {
          messageId,
          sentAt:   new Date(),
          preview:  message ? message.slice(0, 100) : '',
          accountId,
        },
      },
    });
  }

  // Update account counters
  await Account.findByIdAndUpdate(accountId, {
    $inc: { dmsSentToday: 1, dmsSentTotal: 1 },
    lastDmSentAt: new Date(),
  });

  logger.info(
    `[DmWorker] DM sent successfully: account=${accountId} to=${recipientInstagramId} messageId=${messageId}`
  );

  return { success: true, messageId };
}

// ---------------------------------------------------------------------------
// Main processor dispatcher
// ---------------------------------------------------------------------------
async function processDmJob(job) {
  logger.info(`[DmWorker] Processing job "${job.name}" id=${job.id}`, {
    jobId:   job.id,
    attempt: job.attemptsMade + 1,
  });

  switch (job.name) {
    case 'send_dm':
      return sendDm(job);
    default: {
      const msg = `[DmWorker] Unknown job type: "${job.name}"`;
      logger.warn(msg);
      throw new UnrecoverableError(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker instance
// ---------------------------------------------------------------------------
const dmWorker = new Worker(QUEUE_NAME, processDmJob, {
  connection:    getBullMQConnection(),
  concurrency:   CONCURRENCY,
  lockDuration:  30_000,
  lockRenewTime:  10_000,
});

dmWorker.on('completed', (job, result) => {
  logger.debug(`[DmWorker] Job "${job.name}" id=${job.id} completed`, { result });
});

dmWorker.on('failed', (job, err) => {
  logger.error(
    `[DmWorker] Job "${job ? job.name : 'unknown'}" id=${job ? job.id : 'N/A'} failed: ${err.message}`,
    { stack: err.stack }
  );
});

dmWorker.on('stalled', (jobId) => {
  logger.warn(`[DmWorker] Job id=${jobId} stalled`);
});

dmWorker.on('error', (err) => {
  logger.error(`[DmWorker] Worker error: ${err.message}`, { stack: err.stack });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = dmWorker;
