'use strict';

const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Worker imports
// Each worker module creates and exports a BullMQ Worker instance.
// We import them lazily inside startWorkers() so that top-level imports do
// not inadvertently connect to Redis when this module is required but
// startWorkers() is never called (e.g. during unit tests or in the web
// process that only needs the queue producers).
// ---------------------------------------------------------------------------

let emailWorker;
let automationWorker;
let campaignWorker;
let webhookWorker;
let billingWorker;
let dmWorker;

// Collect all active workers for graceful shutdown
const activeWorkers = [];

// ---------------------------------------------------------------------------
// startWorkers
// Instantiates all workers and wires up process-signal handlers.
// Call once from your worker entry-point (e.g. `node src/workers/index.js`).
// ---------------------------------------------------------------------------
function startWorkers() {
  const env = process.env.NODE_ENV || 'development';

  logger.info(`[Workers] Starting all workers (NODE_ENV=${env})`);

  // Require worker modules (each module creates the Worker on require)
  emailWorker      = require('./emailWorker');
  automationWorker = require('./automationWorker');
  campaignWorker   = require('./campaignWorker');
  webhookWorker    = require('./webhookWorker');
  billingWorker    = require('./billingWorker');
  dmWorker         = require('./dmWorker');

  activeWorkers.push(
    { name: 'EmailWorker',      worker: emailWorker },
    { name: 'AutomationWorker', worker: automationWorker },
    { name: 'CampaignWorker',   worker: campaignWorker },
    { name: 'WebhookWorker',    worker: webhookWorker },
    { name: 'BillingWorker',    worker: billingWorker },
    { name: 'DmWorker',         worker: dmWorker },
  );

  for (const { name } of activeWorkers) {
    logger.info(`[Workers] ${name} started`);
  }

  // Register graceful-shutdown signal handlers
  _registerSignalHandlers();

  logger.info(`[Workers] All ${activeWorkers.length} workers running`);

  return activeWorkers.map((w) => w.worker);
}

// ---------------------------------------------------------------------------
// stopWorkers
// Gracefully closes every worker, waiting for in-flight jobs to complete.
// ---------------------------------------------------------------------------
async function stopWorkers() {
  if (activeWorkers.length === 0) {
    logger.info('[Workers] No active workers to stop');
    return;
  }

  logger.info(`[Workers] Gracefully stopping ${activeWorkers.length} worker(s)…`);

  const closePromises = activeWorkers.map(async ({ name, worker }) => {
    try {
      // Worker.close() waits for the current job to finish by default
      await worker.close();
      logger.info(`[Workers] ${name} closed`);
    } catch (err) {
      logger.error(`[Workers] Error closing ${name}: ${err.message}`, { stack: err.stack });
    }
  });

  await Promise.allSettled(closePromises);

  // Also close the queue instances (drains Redis connections)
  try {
    const queues = require('../queues');
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

    await Promise.allSettled(queueInstances.map((q) => q.close()));
    logger.info('[Workers] All queues closed');
  } catch (err) {
    logger.error(`[Workers] Error closing queues: ${err.message}`, { stack: err.stack });
  }

  logger.info('[Workers] Graceful shutdown complete');
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------
let _shutdownInitiated = false;

function _registerSignalHandlers() {
  async function shutdown(signal) {
    if (_shutdownInitiated) {
      logger.warn(`[Workers] Received ${signal} again – forcing exit`);
      process.exit(1);
    }
    _shutdownInitiated = true;
    logger.info(`[Workers] Received ${signal} – initiating graceful shutdown`);

    try {
      await stopWorkers();
      logger.info('[Workers] Clean exit');
      process.exit(0);
    } catch (err) {
      logger.error(`[Workers] Shutdown error: ${err.message}`, { stack: err.stack });
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('[Workers] Uncaught exception', { message: err.message, stack: err.stack });
    // Do NOT exit immediately – allow BullMQ to finish any in-flight job
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('[Workers] Unhandled promise rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack:  reason instanceof Error ? reason.stack : undefined,
    });
  });
}

// ---------------------------------------------------------------------------
// Auto-start when this file is executed directly
// e.g.:  NODE_ENV=production node src/workers/index.js
// ---------------------------------------------------------------------------
if (require.main === module) {
  startWorkers();

  // Optionally start the scheduler in the same process
  // (or run it as a separate process for better isolation)
  if (process.env.START_SCHEDULER !== 'false') {
    const { startScheduler } = require('./scheduler');
    startScheduler();
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  startWorkers,
  stopWorkers,
};
