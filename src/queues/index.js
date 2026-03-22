'use strict';

const { Queue, QueueEvents } = require('bullmq');
const { getBullMQConnection } = require('../config/redis');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Default job options applied to every queue
// ---------------------------------------------------------------------------
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000,
  },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

// ---------------------------------------------------------------------------
// Queue factory helper
// ---------------------------------------------------------------------------
function createQueue(name) {
  const connection = getBullMQConnection();
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  // Attach a QueueEvents listener so we can observe lifecycle events
  // without a Worker being required in this process.
  const queueEvents = new QueueEvents(name, { connection: getBullMQConnection() });

  queueEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error(`[Queue:${name}] Job ${jobId} failed: ${failedReason}`);
  });

  queueEvents.on('stalled', ({ jobId }) => {
    logger.warn(`[Queue:${name}] Job ${jobId} stalled`);
  });

  queueEvents.on('error', (err) => {
    logger.error(`[Queue:${name}] Queue error: ${err.message}`, { stack: err.stack });
  });

  // Surface Redis-level errors on the queue object itself
  queue.on('error', (err) => {
    logger.error(`[Queue:${name}] Connection error: ${err.message}`, { stack: err.stack });
  });

  return queue;
}

// ---------------------------------------------------------------------------
// Queue instances
// ---------------------------------------------------------------------------
const emailQueue        = createQueue('email');
const automationQueue   = createQueue('automation');
const campaignQueue     = createQueue('campaign');
const webhookQueue      = createQueue('webhook');
const billingQueue      = createQueue('billing');
const notificationQueue = createQueue('notification');
const analyticsQueue    = createQueue('analytics');
const dmQueue           = createQueue('dm');

// ---------------------------------------------------------------------------
// Helper: add a job with sensible defaults merged with caller-supplied options
// ---------------------------------------------------------------------------
async function addEmailJob(name, data, opts = {}) {
  const job = await emailQueue.add(name, data, { ...DEFAULT_JOB_OPTIONS, ...opts });
  logger.debug(`[Queue:email] Added job "${name}" id=${job.id}`);
  return job;
}

async function addAutomationJob(name, data, opts = {}) {
  const job = await automationQueue.add(name, data, { ...DEFAULT_JOB_OPTIONS, ...opts });
  logger.debug(`[Queue:automation] Added job "${name}" id=${job.id}`);
  return job;
}

async function addCampaignJob(name, data, opts = {}) {
  const job = await campaignQueue.add(name, data, { ...DEFAULT_JOB_OPTIONS, ...opts });
  logger.debug(`[Queue:campaign] Added job "${name}" id=${job.id}`);
  return job;
}

async function addWebhookJob(name, data, opts = {}) {
  // Webhooks are high-priority – use priority 1 (lowest number = highest priority in BullMQ)
  const job = await webhookQueue.add(name, data, {
    ...DEFAULT_JOB_OPTIONS,
    priority: 1,
    ...opts,
  });
  logger.debug(`[Queue:webhook] Added job "${name}" id=${job.id}`);
  return job;
}

async function addBillingJob(name, data, opts = {}) {
  const job = await billingQueue.add(name, data, { ...DEFAULT_JOB_OPTIONS, ...opts });
  logger.debug(`[Queue:billing] Added job "${name}" id=${job.id}`);
  return job;
}

async function addDmJob(name, data, opts = {}) {
  const job = await dmQueue.add(name, data, { ...DEFAULT_JOB_OPTIONS, ...opts });
  logger.debug(`[Queue:dm] Added job "${name}" id=${job.id}`);
  return job;
}

// ---------------------------------------------------------------------------
// getQueueStats – returns job counts for all queues
// ---------------------------------------------------------------------------
async function getQueueStats() {
  const queues = {
    email:        emailQueue,
    automation:   automationQueue,
    campaign:     campaignQueue,
    webhook:      webhookQueue,
    billing:      billingQueue,
    notification: notificationQueue,
    analytics:    analyticsQueue,
    dm:           dmQueue,
  };

  const stats = {};

  await Promise.all(
    Object.entries(queues).map(async ([name, queue]) => {
      try {
        const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getCompletedCount(),
          queue.getFailedCount(),
          queue.getDelayedCount(),
          queue.getPausedCount(),
        ]);

        stats[name] = { waiting, active, completed, failed, delayed, paused };
      } catch (err) {
        logger.error(`[Queue:${name}] Failed to fetch stats: ${err.message}`);
        stats[name] = { error: err.message };
      }
    })
  );

  return stats;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // Queue instances
  emailQueue,
  automationQueue,
  campaignQueue,
  webhookQueue,
  billingQueue,
  notificationQueue,
  analyticsQueue,
  dmQueue,

  // Helper adders
  addEmailJob,
  addAutomationJob,
  addCampaignJob,
  addWebhookJob,
  addBillingJob,
  addDmJob,

  // Stats
  getQueueStats,

  // Expose default options for re-use in worker files
  DEFAULT_JOB_OPTIONS,
};
