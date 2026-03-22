'use strict';

const { Worker, UnrecoverableError } = require('bullmq');
const { getBullMQConnection } = require('../config/redis');
const logger = require('../config/logger');
const { addCampaignJob } = require('../queues');

// Models
const Campaign = require('../models/Campaign');
const Contact  = require('../models/Contact');

// Services
const instagramService = require('../services/instagramService');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const QUEUE_NAME   = 'campaign';
const CONCURRENCY  = 3;
const BATCH_SIZE   = 50;

// Rate-limit safety: minimum milliseconds between batches (1 batch per 60 s)
const BATCH_DELAY_MS = 60_000;

// Per Meta policy: DMs via the Messaging API may only be sent to users who
// have messaged the page/account within the last 24 hours.
const ELIGIBLE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// launchCampaign
// job.name === 'launch_campaign'
// data: { campaignId }
// ---------------------------------------------------------------------------
async function launchCampaign(job) {
  const { campaignId } = job.data;

  logger.info(`[CampaignWorker] Launching campaign ${campaignId}`);

  const campaign = await Campaign.findById(campaignId);
  if (!campaign) {
    throw new UnrecoverableError(`Campaign ${campaignId} not found`);
  }
  if (!['scheduled', 'draft'].includes(campaign.status)) {
    logger.warn(
      `[CampaignWorker] Campaign ${campaignId} is in status "${campaign.status}", skipping launch`
    );
    return { skipped: true, status: campaign.status };
  }

  // Mark campaign as running
  campaign.status    = 'running';
  campaign.startedAt = new Date();
  await campaign.save();

  // ---------------------------------------------------------------------------
  // Build audience query from campaign filters
  // ---------------------------------------------------------------------------
  const contactFilter = buildAudienceFilter(campaign);

  // ---------------------------------------------------------------------------
  // POLICY CHECK: Only send to contacts eligible under Meta's 24-hour window.
  // A contact is eligible if they sent a message to the account in the last 24 h.
  // We add this as a mandatory filter condition on top of the audience filter.
  // ---------------------------------------------------------------------------
  const eligibilityThreshold = new Date(Date.now() - ELIGIBLE_WINDOW_MS);
  contactFilter.lastMessageReceivedAt = { $gte: eligibilityThreshold };
  contactFilter.accountId             = campaign.accountId;

  const totalContacts = await Contact.countDocuments(contactFilter);
  logger.info(`[CampaignWorker] Campaign ${campaignId} audience size: ${totalContacts}`);

  if (totalContacts === 0) {
    campaign.status = 'completed';
    campaign.stats  = { ...campaign.stats, totalContacts: 0 };
    await campaign.save();
    return { completed: true, reason: 'no_eligible_contacts' };
  }

  // Update total on the campaign document
  await Campaign.findByIdAndUpdate(campaignId, {
    'stats.totalContacts': totalContacts,
  });

  // ---------------------------------------------------------------------------
  // Split audience into batches of BATCH_SIZE and queue each batch with a
  // cumulative delay to respect Instagram rate limits.
  // ---------------------------------------------------------------------------
  const batchCount = Math.ceil(totalContacts / BATCH_SIZE);
  const contactIds = await Contact.find(contactFilter).select('_id').lean();

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    const batchContactIds = contactIds
      .slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE)
      .map((c) => c._id.toString());

    const delayMs = batchIndex * BATCH_DELAY_MS;

    await addCampaignJob(
      'send_batch',
      {
        campaignId,
        batchIndex,
        batchContactIds,
        totalBatches: batchCount,
      },
      { delay: delayMs }
    );

    logger.debug(
      `[CampaignWorker] Queued batch ${batchIndex + 1}/${batchCount} for campaign ${campaignId} delay=${delayMs}ms`
    );
  }

  logger.info(
    `[CampaignWorker] Campaign ${campaignId} launched: ${batchCount} batches queued for ${totalContacts} contacts`
  );

  return { batchCount, totalContacts };
}

// ---------------------------------------------------------------------------
// sendBatch
// job.name === 'send_batch'
// data: { campaignId, batchIndex, batchContactIds, totalBatches }
// ---------------------------------------------------------------------------
async function sendBatch(job) {
  const { campaignId, batchIndex, batchContactIds, totalBatches } = job.data;

  logger.info(
    `[CampaignWorker] Sending batch ${batchIndex + 1}/${totalBatches} for campaign ${campaignId} (${batchContactIds.length} contacts)`
  );

  const campaign = await Campaign.findById(campaignId);
  if (!campaign) {
    throw new UnrecoverableError(`Campaign ${campaignId} not found`);
  }

  // Allow pausing mid-campaign
  if (campaign.status === 'paused') {
    logger.info(`[CampaignWorker] Campaign ${campaignId} is paused, skipping batch ${batchIndex}`);
    return { skipped: true, reason: 'paused' };
  }

  if (campaign.status === 'cancelled') {
    return { skipped: true, reason: 'cancelled' };
  }

  const eligibilityThreshold = new Date(Date.now() - ELIGIBLE_WINDOW_MS);

  let sentCount   = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const contactId of batchContactIds) {
    try {
      const contact = await Contact.findById(contactId);

      if (!contact) {
        logger.warn(`[CampaignWorker] Contact ${contactId} not found, skipping`);
        skippedCount++;
        continue;
      }

      // ---------------------------------------------------------------------------
      // POLICY ENFORCEMENT: Only send if contact messaged within 24 h window.
      // ---------------------------------------------------------------------------
      if (
        !contact.lastMessageReceivedAt ||
        contact.lastMessageReceivedAt < eligibilityThreshold
      ) {
        logger.debug(
          `[CampaignWorker] Contact ${contactId} not eligible (24h window), skipping`
        );
        skippedCount++;
        continue;
      }

      // Build message content – support template variable substitution
      const message = renderTemplate(campaign.messageTemplate, contact);

      await instagramService.sendDM({
        accountId:   campaign.accountId.toString(),
        accessToken: campaign.account ? campaign.account.accessToken : undefined,
        recipientId: contact.instagramId,
        message,
        mediaUrl:    campaign.mediaUrl || null,
      });

      // Record delivery on contact
      await Contact.findByIdAndUpdate(contactId, {
        lastContactedAt:  new Date(),
        $inc: { dmCount: 1 },
        $push: {
          campaignHistory: {
            campaignId,
            sentAt: new Date(),
            status: 'delivered',
          },
        },
      });

      sentCount++;
    } catch (err) {
      logger.error(
        `[CampaignWorker] Failed to send DM to contact ${contactId} in campaign ${campaignId}: ${err.message}`,
        { stack: err.stack }
      );
      failedCount++;

      // Record failure on contact
      try {
        await Contact.findByIdAndUpdate(contactId, {
          $push: {
            campaignHistory: {
              campaignId,
              sentAt:  new Date(),
              status:  'failed',
              error:   err.message,
            },
          },
        });
      } catch (_) {
        // best-effort
      }
    }
  }

  // Update campaign aggregate stats
  const statsUpdate = {
    $inc: {
      'stats.sent':    sentCount,
      'stats.failed':  failedCount,
      'stats.skipped': skippedCount,
    },
  };

  // If this is the last batch, mark the campaign as completed
  const isLastBatch = batchIndex + 1 >= totalBatches;
  if (isLastBatch) {
    await Campaign.findByIdAndUpdate(campaignId, {
      ...statsUpdate,
      status:      'completed',
      completedAt: new Date(),
    });
    logger.info(`[CampaignWorker] Campaign ${campaignId} fully completed`);

    // Queue a final stats update job
    await addCampaignJob('update_campaign_stats', { campaignId });
  } else {
    await Campaign.findByIdAndUpdate(campaignId, statsUpdate);
  }

  logger.info(
    `[CampaignWorker] Batch ${batchIndex + 1}/${totalBatches} done – sent=${sentCount} failed=${failedCount} skipped=${skippedCount}`
  );

  return { sentCount, failedCount, skippedCount };
}

// ---------------------------------------------------------------------------
// updateCampaignStats
// job.name === 'update_campaign_stats'
// data: { campaignId }
// ---------------------------------------------------------------------------
async function updateCampaignStats(job) {
  const { campaignId } = job.data;
  logger.info(`[CampaignWorker] Refreshing stats for campaign ${campaignId}`);

  // Recalculate delivery rate, open rate etc. from Contact campaign history
  const stats = await Contact.aggregate([
    { $unwind: '$campaignHistory' },
    { $match: { 'campaignHistory.campaignId': campaignId } },
    {
      $group: {
        _id:     '$campaignHistory.status',
        count:   { $sum: 1 },
      },
    },
  ]);

  const statsMap = {};
  for (const s of stats) {
    statsMap[s._id] = s.count;
  }

  await Campaign.findByIdAndUpdate(campaignId, {
    'stats.delivered': statsMap.delivered || 0,
    'stats.failed':    statsMap.failed    || 0,
    'stats.skipped':   statsMap.skipped   || 0,
    'stats.updatedAt': new Date(),
  });

  logger.info(`[CampaignWorker] Stats updated for campaign ${campaignId}`, { statsMap });
  return statsMap;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Mongoose filter object from campaign audience settings.
 * Supports tag-based, segment-based and custom filters.
 */
function buildAudienceFilter(campaign) {
  const filter = {};

  if (campaign.audience && campaign.audience.type) {
    switch (campaign.audience.type) {
      case 'all':
        // No extra filter – all contacts for the account
        break;

      case 'tag':
        if (campaign.audience.tags && campaign.audience.tags.length > 0) {
          filter.tags = { $in: campaign.audience.tags };
        }
        break;

      case 'segment':
        if (campaign.audience.segmentId) {
          filter.segmentId = campaign.audience.segmentId;
        }
        break;

      case 'custom':
        // campaign.audience.filter is a raw Mongoose-compatible filter object
        Object.assign(filter, campaign.audience.filter || {});
        break;

      default:
        logger.warn(
          `[CampaignWorker] Unknown audience type "${campaign.audience.type}" for campaign ${campaign._id}`
        );
    }
  }

  return filter;
}

/**
 * Simple template renderer – replaces {{firstName}}, {{username}} etc.
 */
function renderTemplate(template, contact) {
  if (!template) return '';
  return template
    .replace(/\{\{firstName\}\}/g,  contact.firstName  || '')
    .replace(/\{\{lastName\}\}/g,   contact.lastName   || '')
    .replace(/\{\{username\}\}/g,   contact.username   || '')
    .replace(/\{\{fullName\}\}/g,   contact.fullName   || `${contact.firstName || ''} ${contact.lastName || ''}`.trim())
    .replace(/\{\{(.+?)\}\}/g, (_, key) => (contact[key.trim()] !== undefined ? contact[key.trim()] : ''));
}

// ---------------------------------------------------------------------------
// Main processor dispatcher
// ---------------------------------------------------------------------------
async function processCampaignJob(job) {
  logger.info(`[CampaignWorker] Processing job "${job.name}" id=${job.id}`, {
    jobId:   job.id,
    attempt: job.attemptsMade + 1,
  });

  switch (job.name) {
    case 'launch_campaign':
      return launchCampaign(job);
    case 'send_batch':
      return sendBatch(job);
    case 'update_campaign_stats':
      return updateCampaignStats(job);
    default: {
      const msg = `[CampaignWorker] Unknown job type: "${job.name}"`;
      logger.warn(msg);
      throw new UnrecoverableError(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker instance
// ---------------------------------------------------------------------------
const campaignWorker = new Worker(QUEUE_NAME, processCampaignJob, {
  connection:    getBullMQConnection(),
  concurrency:   CONCURRENCY,
  lockDuration:  180_000, // 3 min per batch
  lockRenewTime:  45_000,
});

campaignWorker.on('completed', (job, result) => {
  logger.debug(`[CampaignWorker] Job "${job.name}" id=${job.id} completed`, { result });
});

campaignWorker.on('failed', (job, err) => {
  logger.error(
    `[CampaignWorker] Job "${job ? job.name : 'unknown'}" id=${job ? job.id : 'N/A'} failed: ${err.message}`,
    { stack: err.stack }
  );
});

campaignWorker.on('stalled', (jobId) => {
  logger.warn(`[CampaignWorker] Job id=${jobId} stalled`);
});

campaignWorker.on('error', (err) => {
  logger.error(`[CampaignWorker] Worker error: ${err.message}`, { stack: err.stack });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = campaignWorker;
