'use strict';

const { body, validationResult } = require('express-validator');

const Campaign = require('../models/Campaign');
const AuditLog = require('../models/AuditLog');
const { campaignQueue } = require('../queues/index');
const logger = require('../config/logger');

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// index  (GET /dashboard/campaigns)
// ---------------------------------------------------------------------------
const index = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * PAGE_SIZE;
    const statusFilter = req.query.status || '';
    const query = { userId: req.user._id };
    const allowedStatuses = ['draft', 'running', 'paused', 'completed', 'scheduled', 'failed'];
    if (statusFilter && allowedStatuses.includes(statusFilter)) {
      query.status = statusFilter;
    }

    const [campaigns, total] = await Promise.all([
      Campaign.find(query).sort({ createdAt: -1 }).skip(skip).limit(PAGE_SIZE).lean(),
      Campaign.countDocuments(query),
    ]);

    return res.render('campaign/index', {
      title: 'Campaigns',
      campaigns,
      currentPage: page,
      totalPages: Math.ceil(total / PAGE_SIZE),
      total,
      statusFilter,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Campaign index error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// create  (GET /dashboard/campaigns/create)
// ---------------------------------------------------------------------------
const create = (req, res) => {
  return res.render('campaign/create', {
    title: 'Create Campaign',
    formData: {},
    errors: [],
    user: req.user,
    error: req.flash('error'),
    success: req.flash('success'),
  });
};

// ---------------------------------------------------------------------------
// Shared validators
// ---------------------------------------------------------------------------
const campaignValidators = [
  body('name').trim().notEmpty().withMessage('Campaign name is required.').isLength({ max: 150 }),
  body('type')
    .isIn(['dm_blast', 'comment_reply', 'story_mention', 'follow_up'])
    .withMessage('Invalid campaign type.'),
  body('message').trim().notEmpty().withMessage('Message content is required.').isLength({ max: 2000 }),
];

// ---------------------------------------------------------------------------
// store  (POST /dashboard/campaigns)
// ---------------------------------------------------------------------------
const store = [
  ...campaignValidators,
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('campaign/create', {
        title: 'Create Campaign',
        formData: req.body,
        errors: errors.array(),
        user: req.user,
        error: [],
        success: [],
      });
    }

    try {
      const { name, type, message, instagramAccountId, scheduledAt, audience } = req.body;

      const campaign = await Campaign.create({
        userId: req.user._id,
        instagramAccountId: instagramAccountId || null,
        name: name.trim(),
        type,
        message: message.trim(),
        audience: audience || {},
        status: 'draft',
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      });

      // If a schedule time was provided, enqueue the campaign
      if (campaign.scheduledAt) {
        const delay = campaign.scheduledAt.getTime() - Date.now();
        if (delay > 0) {
          await campaignQueue.add(
            'scheduledCampaign',
            { campaignId: campaign._id.toString() },
            { delay, jobId: `campaign-scheduled-${campaign._id}` },
          );
        }
      }

      await AuditLog.create({
        userId: req.user._id,
        action: 'campaign.created',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { campaignId: campaign._id, name: campaign.name },
      });

      req.flash('success', `Campaign "${campaign.name}" created.`);
      return res.redirect(`/dashboard/campaigns/${campaign._id}`);
    } catch (err) {
      logger.error('Campaign store error', { error: err.message });
      return next(err);
    }
  },
];

// ---------------------------------------------------------------------------
// show  (GET /dashboard/campaigns/:id)
// ---------------------------------------------------------------------------
const show = async (req, res, next) => {
  try {
    const campaign = await Campaign.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).lean();

    if (!campaign) {
      req.flash('error', 'Campaign not found.');
      return res.redirect('/dashboard/campaigns');
    }

    return res.render('campaign/show', {
      title: campaign.name,
      campaign,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// edit  (GET /dashboard/campaigns/:id/edit)
// ---------------------------------------------------------------------------
const edit = async (req, res, next) => {
  try {
    const campaign = await Campaign.findOne({
      _id: req.params.id,
      userId: req.user._id,
      status: 'draft',
    }).lean();

    if (!campaign) {
      req.flash('error', 'Campaign not found or cannot be edited.');
      return res.redirect('/dashboard/campaigns');
    }

    return res.render('campaign/edit', {
      title: `Edit – ${campaign.name}`,
      campaign,
      formData: campaign,
      errors: [],
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// update  (PUT /dashboard/campaigns/:id) – only if draft
// ---------------------------------------------------------------------------
const update = [
  ...campaignValidators,
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const campaign = await Campaign.findById(req.params.id).lean().catch(() => null);
      return res.render('campaign/edit', {
        title: campaign ? `Edit – ${campaign.name}` : 'Edit Campaign',
        campaign,
        formData: req.body,
        errors: errors.array(),
        user: req.user,
        error: [],
        success: [],
      });
    }

    try {
      const { name, type, message, instagramAccountId, scheduledAt, audience } = req.body;

      const campaign = await Campaign.findOneAndUpdate(
        { _id: req.params.id, userId: req.user._id, status: 'draft' },
        {
          name: name.trim(),
          type,
          message: message.trim(),
          audience: audience || {},
          instagramAccountId: instagramAccountId || null,
          scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
          updatedAt: new Date(),
        },
        { new: true },
      );

      if (!campaign) {
        req.flash('error', 'Campaign not found or cannot be edited.');
        return res.redirect('/dashboard/campaigns');
      }

      req.flash('success', 'Campaign updated.');
      return res.redirect(`/dashboard/campaigns/${campaign._id}`);
    } catch (err) {
      logger.error('Campaign update error', { error: err.message });
      return next(err);
    }
  },
];

// ---------------------------------------------------------------------------
// destroy  (DELETE /dashboard/campaigns/:id) – only draft or completed
// ---------------------------------------------------------------------------
const destroy = async (req, res, next) => {
  try {
    const campaign = await Campaign.findOne({
      _id: req.params.id,
      userId: req.user._id,
      status: { $in: ['draft', 'completed', 'failed'] },
    });

    if (!campaign) {
      req.flash('error', 'Campaign cannot be deleted in its current state.');
      return res.redirect('/dashboard/campaigns');
    }

    await campaign.deleteOne();

    await AuditLog.create({
      userId: req.user._id,
      action: 'campaign.deleted',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { campaignId: req.params.id },
    });

    req.flash('success', 'Campaign deleted.');
    return res.redirect('/dashboard/campaigns');
  } catch (err) {
    logger.error('Campaign destroy error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// launch  (POST /dashboard/campaigns/:id/launch)  → JSON
// ---------------------------------------------------------------------------
const launch = async (req, res, next) => {
  try {
    const campaign = await Campaign.findOne({
      _id: req.params.id,
      userId: req.user._id,
      status: { $in: ['draft', 'paused', 'scheduled'] },
    });

    if (!campaign) {
      return res.status(400).json({ success: false, message: 'Campaign cannot be launched.' });
    }

    campaign.status = 'running';
    campaign.startedAt = new Date();
    await campaign.save();

    // Queue broadcast job immediately
    await campaignQueue.add(
      'broadcastCampaign',
      { campaignId: campaign._id.toString() },
      { jobId: `campaign-broadcast-${campaign._id}` },
    );

    await AuditLog.create({
      userId: req.user._id,
      action: 'campaign.launched',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { campaignId: campaign._id },
    });

    return res.json({ success: true, status: campaign.status });
  } catch (err) {
    logger.error('Campaign launch error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// pause  (POST /dashboard/campaigns/:id/pause)  → JSON
// ---------------------------------------------------------------------------
const pause = async (req, res, next) => {
  try {
    const campaign = await Campaign.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, status: 'running' },
      { status: 'paused' },
      { new: true },
    );

    if (!campaign) {
      return res.status(400).json({ success: false, message: 'Campaign is not running.' });
    }

    return res.json({ success: true, status: campaign.status });
  } catch (err) {
    logger.error('Campaign pause error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// resume  (POST /dashboard/campaigns/:id/resume)  → JSON
// ---------------------------------------------------------------------------
const resume = async (req, res, next) => {
  try {
    const campaign = await Campaign.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, status: 'paused' },
      { status: 'running' },
      { new: true },
    );

    if (!campaign) {
      return res.status(400).json({ success: false, message: 'Campaign is not paused.' });
    }

    await campaignQueue.add(
      'broadcastCampaign',
      { campaignId: campaign._id.toString() },
      { jobId: `campaign-broadcast-resume-${campaign._id}-${Date.now()}` },
    );

    return res.json({ success: true, status: campaign.status });
  } catch (err) {
    logger.error('Campaign resume error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// schedule  (POST /dashboard/campaigns/:id/schedule)  → JSON
// ---------------------------------------------------------------------------
const schedule = async (req, res, next) => {
  const { scheduledAt } = req.body;
  if (!scheduledAt || isNaN(new Date(scheduledAt).getTime())) {
    return res.status(400).json({ success: false, message: 'Invalid schedule time.' });
  }

  const scheduledDate = new Date(scheduledAt);
  if (scheduledDate <= new Date()) {
    return res.status(400).json({ success: false, message: 'Scheduled time must be in the future.' });
  }

  try {
    const campaign = await Campaign.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, status: { $in: ['draft', 'paused'] } },
      { status: 'scheduled', scheduledAt: scheduledDate },
      { new: true },
    );

    if (!campaign) {
      return res.status(400).json({ success: false, message: 'Campaign cannot be scheduled.' });
    }

    const delay = scheduledDate.getTime() - Date.now();
    await campaignQueue.add(
      'scheduledCampaign',
      { campaignId: campaign._id.toString() },
      { delay, jobId: `campaign-scheduled-${campaign._id}` },
    );

    return res.json({ success: true, scheduledAt: campaign.scheduledAt });
  } catch (err) {
    logger.error('Campaign schedule error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// analytics  (GET /dashboard/campaigns/:id/analytics)  → JSON
// ---------------------------------------------------------------------------
const analytics = async (req, res, next) => {
  try {
    const campaign = await Campaign.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).lean();

    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found.' });
    }

    return res.json({
      success: true,
      analytics: {
        sent: campaign.sentCount || 0,
        delivered: campaign.deliveredCount || 0,
        failed: campaign.failedCount || 0,
        opened: campaign.openedCount || 0,
        clicked: campaign.clickedCount || 0,
        optedOut: campaign.optedOutCount || 0,
        deliveryRate: campaign.sentCount
          ? ((campaign.deliveredCount / campaign.sentCount) * 100).toFixed(2)
          : 0,
      },
    });
  } catch (err) {
    logger.error('Campaign analytics error', { error: err.message });
    return next(err);
  }
};

module.exports = {
  index,
  create,
  store,
  show,
  edit,
  update,
  destroy,
  launch,
  pause,
  resume,
  schedule,
  analytics,
};
