'use strict';

const mongoose = require('mongoose');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Model resolution (lazy to avoid circular deps)
// ---------------------------------------------------------------------------
function getModels() {
  return {
    User: mongoose.model('User'),
    Subscription: mongoose.model('Subscription'),
    Payment: mongoose.model('Payment'),
    Contact: mongoose.model('Contact'),
    Campaign: mongoose.model('Campaign'),
    Automation: mongoose.model('Automation'),
    Message: mongoose.model('Message'),
    AnalyticsEvent: mongoose.model('AnalyticsEvent'),
    InstagramAccount: mongoose.model('InstagramAccount'),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ok(data) {
  return { success: true, data, error: null };
}

function fail(message, context, err) {
  logger.error(`[AnalyticsService] ${context}: ${message}`, { stack: err && err.stack });
  return { success: false, data: null, error: message };
}

/**
 * Return start/end Date objects based on a period string.
 * @param {string} period – 'today' | '7d' | '30d' | '90d' | 'this_month' | 'last_month' | 'all'
 */
function getPeriodDates(period = '30d') {
  const now = new Date();
  let start;
  let end = new Date(now);

  switch (period) {
    case 'today': {
      start = new Date(now);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case '7d': {
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    }
    case '30d': {
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    }
    case '90d': {
      start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    }
    case 'this_month': {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    }
    case 'last_month': {
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      break;
    }
    case 'all': {
      start = new Date(0);
      break;
    }
    default: {
      // parse numeric days suffix e.g. '14d'
      const match = String(period).match(/^(\d+)d$/);
      if (match) {
        const days = parseInt(match[1], 10);
        start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      } else {
        start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      }
    }
  }

  return { start, end };
}

// ---------------------------------------------------------------------------
// 1. getUserDashboardStats
// ---------------------------------------------------------------------------

/**
 * Aggregate user-facing dashboard metrics for a given period.
 *
 * @param {string} userId
 * @param {string} instagramAccountId
 * @param {string} period
 * @returns {{ success, data: {
 *   totalContacts, newContactsThisPeriod,
 *   automationsTriggered, campaignsSent,
 *   dmsSent, messagesSent,
 *   topAutomations, recentActivity
 * }, error }}
 */
async function getUserDashboardStats(userId, instagramAccountId, period = '30d') {
  const { Contact, Campaign, Automation, Message, AnalyticsEvent } = getModels();

  try {
    const { start, end } = getPeriodDates(period);

    const baseFilter = instagramAccountId
      ? { user: userId, instagramAccount: instagramAccountId }
      : { user: userId };

    // Run all queries concurrently
    const [
      totalContacts,
      newContacts,
      automationsTriggeredResult,
      campaignsSent,
      dmsSent,
      messagesSent,
      topAutomations,
      recentActivity,
    ] = await Promise.all([
      // Total contacts ever
      Contact.countDocuments(baseFilter),

      // New contacts this period
      Contact.countDocuments({
        ...baseFilter,
        createdAt: { $gte: start, $lte: end },
      }),

      // Automations triggered this period
      AnalyticsEvent.aggregate([
        {
          $match: {
            userId: mongoose.Types.ObjectId.isValid(userId)
              ? new mongoose.Types.ObjectId(userId)
              : userId,
            type: 'automation_triggered',
            createdAt: { $gte: start, $lte: end },
          },
        },
        { $count: 'total' },
      ]),

      // Campaigns sent this period
      Campaign.countDocuments({
        ...baseFilter,
        status: 'sent',
        sentAt: { $gte: start, $lte: end },
      }),

      // DMs sent this period (type: 'dm')
      Message.countDocuments({
        ...baseFilter,
        type: 'dm',
        direction: 'outbound',
        createdAt: { $gte: start, $lte: end },
      }),

      // All outbound messages this period
      Message.countDocuments({
        ...baseFilter,
        direction: 'outbound',
        createdAt: { $gte: start, $lte: end },
      }),

      // Top 5 automations by trigger count this period
      AnalyticsEvent.aggregate([
        {
          $match: {
            userId: mongoose.Types.ObjectId.isValid(userId)
              ? new mongoose.Types.ObjectId(userId)
              : userId,
            type: 'automation_triggered',
            createdAt: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: '$data.automationId',
            triggerCount: { $sum: 1 },
            completions: {
              $sum: { $cond: [{ $eq: ['$data.completed', true] }, 1, 0] },
            },
            automationName: { $first: '$data.automationName' },
          },
        },
        { $sort: { triggerCount: -1 } },
        { $limit: 5 },
        {
          $project: {
            automationId: '$_id',
            automationName: 1,
            triggerCount: 1,
            completionRate: {
              $cond: [
                { $gt: ['$triggerCount', 0] },
                { $round: [{ $multiply: [{ $divide: ['$completions', '$triggerCount'] }, 100] }, 1] },
                0,
              ],
            },
            _id: 0,
          },
        },
      ]),

      // Recent activity: last 10 analytics events
      AnalyticsEvent.find({
        userId: mongoose.Types.ObjectId.isValid(userId)
          ? new mongoose.Types.ObjectId(userId)
          : userId,
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

    const stats = {
      period,
      periodStart: start,
      periodEnd: end,
      totalContacts,
      newContactsThisPeriod: newContacts,
      automationsTriggered: automationsTriggeredResult[0]
        ? automationsTriggeredResult[0].total
        : 0,
      campaignsSent,
      dmsSent,
      messagesSent,
      topAutomations,
      recentActivity,
    };

    return ok(stats);
  } catch (err) {
    return fail(err.message, 'getUserDashboardStats', err);
  }
}

// ---------------------------------------------------------------------------
// 2. getInstagramInsights
// ---------------------------------------------------------------------------

/**
 * Aggregate Instagram account insights from stored data.
 * Supplements with data available in the AnalyticsEvent collection
 * (populated via the Instagram API poller / worker).
 */
async function getInstagramInsights(instagramAccountId, period = '30d') {
  const { AnalyticsEvent } = getModels();

  try {
    const { start, end } = getPeriodDates(period);

    const igId = mongoose.Types.ObjectId.isValid(instagramAccountId)
      ? new mongoose.Types.ObjectId(instagramAccountId)
      : instagramAccountId;

    const insightsAgg = await AnalyticsEvent.aggregate([
      {
        $match: {
          'data.instagramAccountId': instagramAccountId,
          type: 'instagram_insight',
          createdAt: { $gte: start, $lte: end },
        },
      },
      {
        $group: {
          _id: '$data.metric',
          total: { $sum: '$data.value' },
          avg: { $avg: '$data.value' },
          max: { $max: '$data.value' },
          min: { $min: '$data.value' },
          dataPoints: { $push: { date: '$createdAt', value: '$data.value' } },
        },
      },
    ]);

    // Reshape into a keyed object
    const metrics = {};
    for (const row of insightsAgg) {
      metrics[row._id] = {
        total: row.total,
        avg: Math.round(row.avg * 10) / 10,
        max: row.max,
        min: row.min,
        dataPoints: row.dataPoints.slice(-30), // last 30 data points for charts
      };
    }

    // DM activity from Message model
    const { Message } = getModels();
    const [dmsSent, dmsReceived] = await Promise.all([
      Message.countDocuments({
        instagramAccount: instagramAccountId,
        direction: 'outbound',
        createdAt: { $gte: start, $lte: end },
      }),
      Message.countDocuments({
        instagramAccount: instagramAccountId,
        direction: 'inbound',
        createdAt: { $gte: start, $lte: end },
      }),
    ]);

    return ok({
      instagramAccountId,
      period,
      periodStart: start,
      periodEnd: end,
      metrics,
      messaging: { dmsSent, dmsReceived, engagementRatio: dmsReceived > 0 ? Math.round((dmsSent / dmsReceived) * 100) / 100 : 0 },
    });
  } catch (err) {
    return fail(err.message, 'getInstagramInsights', err);
  }
}

// ---------------------------------------------------------------------------
// 3. getRevenueDashboard (admin)
// ---------------------------------------------------------------------------

/**
 * Admin revenue dashboard: MRR, ARR, churn, new subscribers, upgrades.
 */
async function getRevenueDashboard(period = 'this_month') {
  const { Subscription, Payment } = getModels();

  try {
    const { start, end } = getPeriodDates(period);

    const [
      // All active subscriptions for MRR calculation
      activeSubscriptions,
      // New subscriptions this period
      newSubscriptions,
      // Cancelled this period
      cancelledThisPeriod,
      // Revenue collected this period
      revenueResult,
      // Refunds this period
      refundsResult,
      // Revenue by gateway
      revenueByGateway,
      // Revenue trend (daily for short periods, monthly for longer)
      revenueTrend,
    ] = await Promise.all([
      Subscription.find({ status: 'active' }).populate('plan').lean(),

      Subscription.countDocuments({
        status: { $in: ['active', 'trialing'] },
        createdAt: { $gte: start, $lte: end },
      }),

      Subscription.countDocuments({
        status: 'cancelled',
        cancelledAt: { $gte: start, $lte: end },
      }),

      Payment.aggregate([
        {
          $match: {
            status: 'completed',
            paidAt: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            count: { $sum: 1 },
            avg: { $avg: '$amount' },
          },
        },
      ]),

      Payment.aggregate([
        {
          $match: {
            status: 'refunded',
            createdAt: { $gte: start, $lte: end },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),

      Payment.aggregate([
        {
          $match: { status: 'completed', paidAt: { $gte: start, $lte: end } },
        },
        {
          $group: {
            _id: '$gateway',
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]),

      Payment.aggregate([
        {
          $match: { status: 'completed', paidAt: { $gte: start, $lte: end } },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$paidAt' },
            },
            revenue: { $sum: '$amount' },
            payments: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    // Compute MRR
    let mrr = 0;
    for (const sub of activeSubscriptions) {
      const plan = sub.plan;
      if (!plan) continue;
      const monthly =
        sub.billingCycle === 'yearly'
          ? (plan.yearlyPrice || plan.monthlyPrice * 12) / 12
          : plan.monthlyPrice || 0;
      mrr += monthly;
    }

    // Compute churn rate: cancelled / (active at start of period)
    const activeAtStart = await Subscription.countDocuments({
      status: { $in: ['active', 'cancelled'] },
      createdAt: { $lt: start },
    });
    const churnRate =
      activeAtStart > 0
        ? Math.round((cancelledThisPeriod / activeAtStart) * 10000) / 100
        : 0;

    const grossRevenue = revenueResult[0] ? revenueResult[0].total : 0;
    const totalRefunds = refundsResult[0] ? refundsResult[0].total : 0;
    const netRevenue = grossRevenue - totalRefunds;

    return ok({
      period,
      periodStart: start,
      periodEnd: end,
      mrr: Math.round(mrr * 100) / 100,
      arr: Math.round(mrr * 12 * 100) / 100,
      grossRevenue,
      netRevenue,
      totalRefunds,
      paymentCount: revenueResult[0] ? revenueResult[0].count : 0,
      avgTransactionValue: revenueResult[0] ? Math.round(revenueResult[0].avg * 100) / 100 : 0,
      activeSubscribers: activeSubscriptions.length,
      newSubscribers: newSubscriptions,
      cancelledThisPeriod,
      churnRate,
      revenueByGateway,
      revenueTrend,
    });
  } catch (err) {
    return fail(err.message, 'getRevenueDashboard', err);
  }
}

// ---------------------------------------------------------------------------
// 4. getCampaignAnalytics
// ---------------------------------------------------------------------------

/**
 * Return analytics for a specific broadcast campaign.
 */
async function getCampaignAnalytics(campaignId) {
  const { Campaign, Message } = getModels();

  try {
    const campaign = await Campaign.findById(campaignId).lean();
    if (!campaign) {
      return fail('Campaign not found', 'getCampaignAnalytics');
    }

    const [messages, replies] = await Promise.all([
      Message.find({ campaign: campaignId }).lean(),
      Message.countDocuments({
        campaign: campaignId,
        direction: 'inbound',
        // inbound messages recorded against the campaign as replies
      }),
    ]);

    const totalSent = messages.filter((m) => m.direction === 'outbound').length;
    const delivered = messages.filter((m) => m.status === 'delivered').length;
    const read = messages.filter((m) => m.status === 'read').length;
    const failed = messages.filter((m) => m.status === 'failed').length;

    const deliveryRate = totalSent > 0 ? Math.round((delivered / totalSent) * 10000) / 100 : 0;
    const readRate = delivered > 0 ? Math.round((read / delivered) * 10000) / 100 : 0;
    const replyRate = totalSent > 0 ? Math.round((replies / totalSent) * 10000) / 100 : 0;
    const failureRate = totalSent > 0 ? Math.round((failed / totalSent) * 10000) / 100 : 0;

    return ok({
      campaignId,
      campaignName: campaign.name,
      status: campaign.status,
      scheduledAt: campaign.scheduledAt,
      sentAt: campaign.sentAt,
      targetCount: campaign.targetCount || totalSent,
      totalSent,
      delivered,
      read,
      failed,
      replies,
      deliveryRate,
      readRate,
      replyRate,
      failureRate,
    });
  } catch (err) {
    return fail(err.message, 'getCampaignAnalytics', err);
  }
}

// ---------------------------------------------------------------------------
// 5. getAutomationAnalytics
// ---------------------------------------------------------------------------

/**
 * Return analytics for a specific automation flow over a period.
 */
async function getAutomationAnalytics(automationId, period = '30d') {
  const { AnalyticsEvent, Message } = getModels();

  try {
    const { start, end } = getPeriodDates(period);

    const [triggerEvents, stepEvents, dailyTrend] = await Promise.all([
      AnalyticsEvent.aggregate([
        {
          $match: {
            type: 'automation_triggered',
            'data.automationId': automationId,
            createdAt: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$data.completed', true] }, 1, 0] } },
            dropped: { $sum: { $cond: [{ $eq: ['$data.dropped', true] }, 1, 0] } },
          },
        },
      ]),

      // Step-level drop-off analysis
      AnalyticsEvent.aggregate([
        {
          $match: {
            type: 'automation_step',
            'data.automationId': automationId,
            createdAt: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: '$data.stepIndex',
            reached: { $sum: 1 },
            stepName: { $first: '$data.stepName' },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Daily trigger count trend
      AnalyticsEvent.aggregate([
        {
          $match: {
            type: 'automation_triggered',
            'data.automationId': automationId,
            createdAt: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const triggerData = triggerEvents[0] || { total: 0, completed: 0, dropped: 0 };
    const completionRate =
      triggerData.total > 0
        ? Math.round((triggerData.completed / triggerData.total) * 10000) / 100
        : 0;
    const dropOffRate =
      triggerData.total > 0
        ? Math.round((triggerData.dropped / triggerData.total) * 10000) / 100
        : 0;

    // Calculate per-step drop-off
    const stepDropOff = stepEvents.map((step, idx) => {
      const prevReached = idx > 0 ? stepEvents[idx - 1].reached : step.reached;
      const dropOff = prevReached > 0
        ? Math.round(((prevReached - step.reached) / prevReached) * 10000) / 100
        : 0;
      return {
        stepIndex: step._id,
        stepName: step.stepName || `Step ${step._id + 1}`,
        reached: step.reached,
        dropOffRate: dropOff,
      };
    });

    // Messages sent by this automation
    const messagesSent = await Message.countDocuments({
      'metadata.automationId': automationId,
      direction: 'outbound',
      createdAt: { $gte: start, $lte: end },
    });

    return ok({
      automationId,
      period,
      periodStart: start,
      periodEnd: end,
      triggerCount: triggerData.total,
      completionRate,
      dropOffRate,
      completedCount: triggerData.completed,
      droppedCount: triggerData.dropped,
      messagesSent,
      stepDropOff,
      dailyTrend,
    });
  } catch (err) {
    return fail(err.message, 'getAutomationAnalytics', err);
  }
}

// ---------------------------------------------------------------------------
// 6. recordAnalyticsEvent
// ---------------------------------------------------------------------------

/**
 * Store an analytics event for later aggregation.
 *
 * @param {string} type   – event type e.g. 'automation_triggered', 'dm_sent', 'instagram_insight'
 * @param {string} userId
 * @param {object} data   – arbitrary event payload
 */
async function recordAnalyticsEvent(type, userId, data = {}) {
  const { AnalyticsEvent } = getModels();

  try {
    const event = new AnalyticsEvent({
      type,
      userId: mongoose.Types.ObjectId.isValid(userId)
        ? new mongoose.Types.ObjectId(userId)
        : userId,
      data,
      createdAt: new Date(),
    });
    await event.save();
    return ok({ eventId: event._id });
  } catch (err) {
    // Non-critical: log but don't throw
    logger.warn('[AnalyticsService] recordAnalyticsEvent failed', {
      type,
      userId,
      error: err.message,
    });
    return fail(err.message, 'recordAnalyticsEvent', err);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getUserDashboardStats,
  getInstagramInsights,
  getRevenueDashboard,
  getCampaignAnalytics,
  getAutomationAnalytics,
  recordAnalyticsEvent,
  getPeriodDates, // exported for use in controllers/workers
};
