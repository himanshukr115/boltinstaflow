'use strict';

const { Worker, UnrecoverableError } = require('bullmq');
const { getBullMQConnection } = require('../config/redis');
const logger = require('../config/logger');
const { addAutomationJob, addDmJob } = require('../queues');

// Models
const Automation    = require('../models/Automation');
const Contact       = require('../models/Contact');
const AutomationLog = require('../models/AutomationLog');
const Account       = require('../models/Account');

// Services
const instagramService = require('../services/instagramService');
const webhookService   = require('../services/webhookService');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const QUEUE_NAME  = 'automation';
const CONCURRENCY = 10;

// Step type constants
const STEP_TYPES = {
  SEND_DM:         'send_dm',
  SEND_REACTION:   'send_reaction',
  WAIT:            'wait',
  CONDITION_CHECK: 'condition_check',
  TAG_CONTACT:     'tag_contact',
  REMOVE_TAG:      'remove_tag',
  WEBHOOK_CALL:    'webhook_call',
};

// ---------------------------------------------------------------------------
// processTrigger
// Handles job.name === 'process_trigger'
// data: { automationId, contactId, triggerData }
// ---------------------------------------------------------------------------
async function processTrigger(job) {
  const { automationId, contactId, triggerData = {} } = job.data;

  logger.info(`[AutomationWorker] processTrigger automationId=${automationId} contactId=${contactId}`);

  // 1. Load automation and verify it is still active
  const automation = await Automation.findById(automationId).lean();
  if (!automation) {
    throw new UnrecoverableError(`Automation ${automationId} not found`);
  }
  if (automation.status !== 'active') {
    logger.info(
      `[AutomationWorker] Automation ${automationId} is not active (status=${automation.status}), skipping`
    );
    return { skipped: true, reason: 'not_active' };
  }

  // 2. Load contact
  const contact = await Contact.findById(contactId);
  if (!contact) {
    throw new UnrecoverableError(`Contact ${contactId} not found`);
  }

  // 3. Load the associated Instagram account
  const account = await Account.findById(automation.accountId);
  if (!account) {
    throw new UnrecoverableError(`Account ${automation.accountId} not found`);
  }

  // 4. Make sure we have steps
  const steps = automation.steps || [];
  if (steps.length === 0) {
    logger.warn(`[AutomationWorker] Automation ${automationId} has no steps`);
    return { skipped: true, reason: 'no_steps' };
  }

  // 5. Create an AutomationLog entry for this run
  const automationLog = await AutomationLog.create({
    automationId,
    contactId,
    accountId: automation.accountId,
    userId:    automation.userId,
    status:    'in_progress',
    startedAt: new Date(),
    triggerData,
    steps:     [],
  });

  // 6. Queue the first step
  await addAutomationJob('execute_step', {
    automationId,
    contactId,
    accountId:     automation.accountId,
    userId:        automation.userId,
    stepIndex:     0,
    automationLogId: automationLog._id.toString(),
    triggerData,
  });

  // 7. Increment trigger count on the automation document
  await Automation.findByIdAndUpdate(automationId, { $inc: { 'stats.triggered': 1 } });

  logger.info(
    `[AutomationWorker] Trigger processed for automation=${automationId} contact=${contactId} log=${automationLog._id}`
  );
  return { automationLogId: automationLog._id.toString() };
}

// ---------------------------------------------------------------------------
// executeStep
// Handles job.name === 'execute_step'
// data: { automationId, contactId, accountId, userId, stepIndex, automationLogId, triggerData }
// ---------------------------------------------------------------------------
async function executeStep(job) {
  const {
    automationId,
    contactId,
    accountId,
    stepIndex,
    automationLogId,
    triggerData = {},
  } = job.data;

  logger.info(
    `[AutomationWorker] executeStep automationId=${automationId} stepIndex=${stepIndex} contact=${contactId}`
  );

  // Load fresh automation (may have been edited since trigger)
  const automation = await Automation.findById(automationId).lean();
  if (!automation || automation.status !== 'active') {
    await _finalizeLog(automationLogId, 'cancelled', 'Automation no longer active');
    return { skipped: true };
  }

  const steps = automation.steps || [];
  if (stepIndex >= steps.length) {
    // No more steps – mark the run as completed
    await _finalizeLog(automationLogId, 'completed');
    await Automation.findByIdAndUpdate(automationId, { $inc: { 'stats.completed': 1 } });
    logger.info(`[AutomationWorker] Automation ${automationId} run completed for contact ${contactId}`);
    return { completed: true };
  }

  const step    = steps[stepIndex];
  const contact = await Contact.findById(contactId);
  if (!contact) {
    await _finalizeLog(automationLogId, 'failed', `Contact ${contactId} not found`);
    throw new UnrecoverableError(`Contact ${contactId} not found`);
  }

  const account = await Account.findById(accountId);
  if (!account) {
    await _finalizeLog(automationLogId, 'failed', `Account ${accountId} not found`);
    throw new UnrecoverableError(`Account ${accountId} not found`);
  }

  let nextStepIndex = stepIndex + 1;
  let stepResult    = {};

  try {
    switch (step.type) {
      case STEP_TYPES.SEND_DM:
        stepResult = await executeSendDm(step, contact, account, automationLogId);
        break;

      case STEP_TYPES.SEND_REACTION:
        stepResult = await executeSendReaction(step, contact, account);
        break;

      case STEP_TYPES.WAIT:
        // executeWait schedules the *next* step itself; do not queue below
        await executeWait(step, job, nextStepIndex);
        await _appendStepLog(automationLogId, stepIndex, step.type, 'waiting', stepResult);
        return { waiting: true, delay: step.delay };

      case STEP_TYPES.CONDITION_CHECK:
        nextStepIndex = await executeConditionCheck(step, contact, triggerData, steps, stepIndex);
        break;

      case STEP_TYPES.TAG_CONTACT:
        stepResult = await executeTagContact(step, contact);
        break;

      case STEP_TYPES.REMOVE_TAG:
        stepResult = await executeRemoveTag(step, contact);
        break;

      case STEP_TYPES.WEBHOOK_CALL:
        stepResult = await executeWebhookCall(step, contact, triggerData);
        break;

      default:
        logger.warn(`[AutomationWorker] Unknown step type "${step.type}" – skipping`);
    }

    await _appendStepLog(automationLogId, stepIndex, step.type, 'completed', stepResult);

    // Queue the next step
    await addAutomationJob('execute_step', {
      ...job.data,
      stepIndex: nextStepIndex,
    });

    return { stepType: step.type, stepResult, nextStepIndex };
  } catch (err) {
    logger.error(
      `[AutomationWorker] Step ${stepIndex} (${step.type}) failed for automation=${automationId}: ${err.message}`,
      { stack: err.stack }
    );
    await _appendStepLog(automationLogId, stepIndex, step.type, 'failed', { error: err.message });
    await _finalizeLog(automationLogId, 'failed', err.message);
    await Automation.findByIdAndUpdate(automationId, { $inc: { 'stats.failed': 1 } });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// scheduleFollowup
// Handles job.name === 'schedule_followup'
// data: { automationId, contactId, accountId, userId, stepIndex, automationLogId, delay }
// ---------------------------------------------------------------------------
async function scheduleFollowup(job) {
  const { automationId, contactId, delay } = job.data;
  logger.info(
    `[AutomationWorker] scheduleFollowup automationId=${automationId} contact=${contactId} delay=${delay}ms`
  );
  // Simply re-queue execute_step; the delay was already applied via job.opts.delay
  await addAutomationJob('execute_step', { ...job.data });
  return { scheduled: true };
}

// ---------------------------------------------------------------------------
// Step executors
// ---------------------------------------------------------------------------

/**
 * executeWait – schedule the continuation step after a delay.
 * @param {Object} step    - The wait step config { delay: <ms> }
 * @param {Object} job     - The current BullMQ job
 * @param {number} nextIdx - The step index to execute after the wait
 */
async function executeWait(step, job, nextIdx) {
  const delayMs = step.delay || 60_000; // default 1 minute
  logger.info(`[AutomationWorker] Scheduling wait of ${delayMs}ms before step ${nextIdx}`);

  await addAutomationJob(
    'schedule_followup',
    { ...job.data, stepIndex: nextIdx },
    { delay: delayMs }
  );
}

/**
 * executeSendDm – send a DM via Instagram Graph API.
 * Checks quota before sending; fails gracefully if quota is exceeded.
 */
async function executeSendDm(step, contact, account, automationLogId) {
  // Check per-account daily DM quota stored on Account model
  const dailyLimit = account.dmQuotaDaily || 1000;
  const dmsSentToday = account.dmsSentToday || 0;

  if (dmsSentToday >= dailyLimit) {
    const msg = `DM quota exceeded for account ${account._id} (${dmsSentToday}/${dailyLimit})`;
    logger.warn(`[AutomationWorker] ${msg}`);
    // Fail gracefully – do not throw an error that would retry; instead resolve
    await _appendStepLog(automationLogId, null, STEP_TYPES.SEND_DM, 'skipped', {
      reason: 'quota_exceeded',
    });
    return { skipped: true, reason: 'quota_exceeded' };
  }

  const message = step.message || '';
  logger.info(
    `[AutomationWorker] Sending DM to contact=${contact._id} via account=${account._id}`
  );

  const result = await instagramService.sendDM({
    accountId:   account._id.toString(),
    accessToken: account.accessToken, // decryption handled inside instagramService
    recipientId: contact.instagramId,
    message,
    mediaUrl:    step.mediaUrl || null,
  });

  // Record in AutomationLog
  if (automationLogId) {
    await AutomationLog.findByIdAndUpdate(automationLogId, {
      $push: {
        dmsSent: {
          contactId:   contact._id,
          sentAt:      new Date(),
          messageId:   result.messageId,
          message,
        },
      },
    });
  }

  // Increment account counters
  await Account.findByIdAndUpdate(account._id, {
    $inc: { dmsSentToday: 1, dmsSentTotal: 1 },
  });

  // Update contact last-contacted timestamp
  await Contact.findByIdAndUpdate(contact._id, {
    lastContactedAt: new Date(),
    $inc: { dmCount: 1 },
  });

  return { messageId: result.messageId };
}

/**
 * executeSendReaction – react to a post/story.
 */
async function executeSendReaction(step, contact, account) {
  const result = await instagramService.sendReaction({
    accountId:   account._id.toString(),
    accessToken: account.accessToken,
    mediaId:     step.mediaId || contact.lastMediaId,
    reaction:    step.reaction || 'like',
  });
  return { reactionId: result.reactionId };
}

/**
 * executeTagContact – add one or more tags to a contact.
 */
async function executeTagContact(step, contact) {
  const tagsToAdd = Array.isArray(step.tags) ? step.tags : [step.tag].filter(Boolean);
  if (tagsToAdd.length === 0) return { skipped: true };

  const updated = await Contact.findByIdAndUpdate(
    contact._id,
    { $addToSet: { tags: { $each: tagsToAdd } } },
    { new: true }
  );

  logger.info(
    `[AutomationWorker] Tagged contact ${contact._id} with [${tagsToAdd.join(', ')}]`
  );
  return { tags: updated.tags };
}

/**
 * executeRemoveTag – remove one or more tags from a contact.
 */
async function executeRemoveTag(step, contact) {
  const tagsToRemove = Array.isArray(step.tags) ? step.tags : [step.tag].filter(Boolean);
  if (tagsToRemove.length === 0) return { skipped: true };

  const updated = await Contact.findByIdAndUpdate(
    contact._id,
    { $pull: { tags: { $in: tagsToRemove } } },
    { new: true }
  );

  logger.info(
    `[AutomationWorker] Removed tags [${tagsToRemove.join(', ')}] from contact ${contact._id}`
  );
  return { tags: updated.tags };
}

/**
 * executeConditionCheck – evaluate a condition and branch the step index.
 * Returns the index of the next step to execute.
 */
async function executeConditionCheck(step, contact, triggerData, steps, currentIndex) {
  const { field, operator, value, trueStepIndex, falseStepIndex } = step;

  let fieldValue;
  if (field.startsWith('contact.')) {
    const key = field.replace('contact.', '');
    fieldValue = contact[key];
  } else if (field.startsWith('trigger.')) {
    const key = field.replace('trigger.', '');
    fieldValue = triggerData[key];
  } else {
    fieldValue = contact[field];
  }

  let conditionMet = false;
  switch (operator) {
    case 'equals':
      conditionMet = String(fieldValue) === String(value);
      break;
    case 'not_equals':
      conditionMet = String(fieldValue) !== String(value);
      break;
    case 'contains':
      conditionMet = String(fieldValue || '').toLowerCase().includes(String(value).toLowerCase());
      break;
    case 'not_contains':
      conditionMet = !String(fieldValue || '').toLowerCase().includes(String(value).toLowerCase());
      break;
    case 'exists':
      conditionMet = fieldValue !== undefined && fieldValue !== null && fieldValue !== '';
      break;
    case 'not_exists':
      conditionMet = fieldValue === undefined || fieldValue === null || fieldValue === '';
      break;
    case 'greater_than':
      conditionMet = Number(fieldValue) > Number(value);
      break;
    case 'less_than':
      conditionMet = Number(fieldValue) < Number(value);
      break;
    case 'has_tag':
      conditionMet = Array.isArray(contact.tags) && contact.tags.includes(value);
      break;
    default:
      logger.warn(`[AutomationWorker] Unknown condition operator "${operator}"`);
      conditionMet = false;
  }

  logger.info(
    `[AutomationWorker] Condition check field="${field}" operator="${operator}" value="${value}" met=${conditionMet}`
  );

  if (conditionMet) {
    return trueStepIndex !== undefined ? trueStepIndex : currentIndex + 1;
  }
  return falseStepIndex !== undefined ? falseStepIndex : steps.length; // jump to end if no false branch
}

/**
 * executeWebhookCall – POST step data to an external webhook URL.
 */
async function executeWebhookCall(step, contact, triggerData) {
  const result = await webhookService.sendOutboundWebhook({
    url:     step.webhookUrl,
    method:  step.method || 'POST',
    headers: step.headers || {},
    payload: {
      contact: {
        id:            contact._id,
        instagramId:   contact.instagramId,
        username:      contact.username,
        tags:          contact.tags,
      },
      triggerData,
      stepData: step.data || {},
    },
  });
  return { statusCode: result.statusCode, response: result.body };
}

// ---------------------------------------------------------------------------
// AutomationLog helpers
// ---------------------------------------------------------------------------
async function _finalizeLog(automationLogId, status, errorMessage = null) {
  if (!automationLogId) return;
  const update = { status, completedAt: new Date() };
  if (errorMessage) update.errorMessage = errorMessage;
  await AutomationLog.findByIdAndUpdate(automationLogId, update);
}

async function _appendStepLog(automationLogId, stepIndex, stepType, status, result) {
  if (!automationLogId) return;
  await AutomationLog.findByIdAndUpdate(automationLogId, {
    $push: {
      steps: {
        stepIndex,
        stepType,
        status,
        result,
        executedAt: new Date(),
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Main processor dispatcher
// ---------------------------------------------------------------------------
async function processAutomationJob(job) {
  logger.info(`[AutomationWorker] Processing job "${job.name}" id=${job.id}`, {
    jobId: job.id,
    attempt: job.attemptsMade + 1,
  });

  switch (job.name) {
    case 'process_trigger':
      return processTrigger(job);
    case 'execute_step':
      return executeStep(job);
    case 'schedule_followup':
      return scheduleFollowup(job);
    default: {
      const msg = `[AutomationWorker] Unknown job type: "${job.name}"`;
      logger.warn(msg);
      throw new UnrecoverableError(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker instance
// ---------------------------------------------------------------------------
const automationWorker = new Worker(QUEUE_NAME, processAutomationJob, {
  connection:    getBullMQConnection(),
  concurrency:   CONCURRENCY,
  lockDuration:  120_000,
  lockRenewTime:  30_000,
});

automationWorker.on('completed', (job, result) => {
  logger.debug(`[AutomationWorker] Job "${job.name}" id=${job.id} completed`, { result });
});

automationWorker.on('failed', (job, err) => {
  logger.error(
    `[AutomationWorker] Job "${job ? job.name : 'unknown'}" id=${job ? job.id : 'N/A'} failed: ${err.message}`,
    { stack: err.stack }
  );
});

automationWorker.on('stalled', (jobId) => {
  logger.warn(`[AutomationWorker] Job id=${jobId} stalled`);
});

automationWorker.on('error', (err) => {
  logger.error(`[AutomationWorker] Worker error: ${err.message}`, { stack: err.stack });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = automationWorker;
