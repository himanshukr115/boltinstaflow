'use strict';

const { body, validationResult } = require('express-validator');

const Automation = require('../models/Automation');
const AuditLog = require('../models/AuditLog');
const automationTemplates = require('../data/automationTemplates');
const logger = require('../config/logger');

const TRIGGER_TYPES = [
  'new_follower',
  'post_comment',
  'story_reply',
  'dm_keyword',
  'post_like',
  'mention',
  'hashtag',
];

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// index  (GET /dashboard/automations)
// ---------------------------------------------------------------------------
const index = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * PAGE_SIZE;
    const statusFilter = req.query.status || '';
    const query = { userId: req.user._id, status: { $ne: 'archived' } };
    if (statusFilter && ['active', 'paused'].includes(statusFilter)) {
      query.status = statusFilter;
    }

    const [automations, total] = await Promise.all([
      Automation.find(query).sort({ updatedAt: -1 }).skip(skip).limit(PAGE_SIZE).lean(),
      Automation.countDocuments(query),
    ]);

    return res.render('automation/index', {
      title: 'Automations',
      automations,
      currentPage: page,
      totalPages: Math.ceil(total / PAGE_SIZE),
      total,
      statusFilter,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Automation index error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// create  (GET /dashboard/automations/create)
// ---------------------------------------------------------------------------
const create = (req, res) => {
  return res.render('automation/create', {
    title: 'Create Automation',
    triggerTypes: TRIGGER_TYPES,
    formData: {},
    errors: [],
    user: req.user,
    error: req.flash('error'),
    success: req.flash('success'),
  });
};

// ---------------------------------------------------------------------------
// Shared validators for store/update
// ---------------------------------------------------------------------------
const automationValidators = [
  body('name').trim().notEmpty().withMessage('Automation name is required.').isLength({ max: 120 }),
  body('triggerType').isIn(TRIGGER_TYPES).withMessage('Invalid trigger type.'),
  body('triggerConditions').optional().isObject().withMessage('Trigger conditions must be an object.'),
  body('actions').isArray({ min: 1 }).withMessage('At least one action is required.'),
];

// ---------------------------------------------------------------------------
// store  (POST /dashboard/automations)
// ---------------------------------------------------------------------------
const store = [
  ...automationValidators,
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('automation/create', {
        title: 'Create Automation',
        triggerTypes: TRIGGER_TYPES,
        formData: req.body,
        errors: errors.array(),
        user: req.user,
        error: [],
        success: [],
      });
    }

    try {
      const { name, triggerType, triggerConditions, actions, instagramAccountId, isActive } = req.body;

      const automation = await Automation.create({
        userId: req.user._id,
        instagramAccountId: instagramAccountId || null,
        name: name.trim(),
        triggerType,
        triggerConditions: triggerConditions || {},
        actions: Array.isArray(actions) ? actions : [],
        status: isActive === 'on' ? 'active' : 'paused',
      });

      await AuditLog.create({
        userId: req.user._id,
        action: 'automation.created',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { automationId: automation._id, name: automation.name },
      });

      req.flash('success', `Automation "${automation.name}" created successfully.`);
      return res.redirect(`/dashboard/automations/${automation._id}`);
    } catch (err) {
      logger.error('Automation store error', { error: err.message });
      return next(err);
    }
  },
];

// ---------------------------------------------------------------------------
// show  (GET /dashboard/automations/:id)
// ---------------------------------------------------------------------------
const show = async (req, res, next) => {
  try {
    const automation = await Automation.findOne({
      _id: req.params.id,
      userId: req.user._id,
      status: { $ne: 'archived' },
    }).lean();

    if (!automation) {
      req.flash('error', 'Automation not found.');
      return res.redirect('/dashboard/automations');
    }

    return res.render('automation/show', {
      title: automation.name,
      automation,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// edit  (GET /dashboard/automations/:id/edit)
// ---------------------------------------------------------------------------
const edit = async (req, res, next) => {
  try {
    const automation = await Automation.findOne({
      _id: req.params.id,
      userId: req.user._id,
      status: { $ne: 'archived' },
    }).lean();

    if (!automation) {
      req.flash('error', 'Automation not found.');
      return res.redirect('/dashboard/automations');
    }

    return res.render('automation/edit', {
      title: `Edit – ${automation.name}`,
      automation,
      triggerTypes: TRIGGER_TYPES,
      formData: automation,
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
// update  (PUT /dashboard/automations/:id)
// ---------------------------------------------------------------------------
const update = [
  ...automationValidators,
  async (req, res, next) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      const automation = await Automation.findById(req.params.id).lean().catch(() => null);
      return res.render('automation/edit', {
        title: automation ? `Edit – ${automation.name}` : 'Edit Automation',
        automation,
        triggerTypes: TRIGGER_TYPES,
        formData: req.body,
        errors: errors.array(),
        user: req.user,
        error: [],
        success: [],
      });
    }

    try {
      const { name, triggerType, triggerConditions, actions, instagramAccountId, isActive } = req.body;

      const automation = await Automation.findOneAndUpdate(
        { _id: req.params.id, userId: req.user._id, status: { $ne: 'archived' } },
        {
          name: name.trim(),
          triggerType,
          triggerConditions: triggerConditions || {},
          actions: Array.isArray(actions) ? actions : [],
          instagramAccountId: instagramAccountId || null,
          status: isActive === 'on' ? 'active' : 'paused',
          updatedAt: new Date(),
        },
        { new: true },
      );

      if (!automation) {
        req.flash('error', 'Automation not found.');
        return res.redirect('/dashboard/automations');
      }

      await AuditLog.create({
        userId: req.user._id,
        action: 'automation.updated',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { automationId: automation._id },
      });

      req.flash('success', 'Automation updated successfully.');
      return res.redirect(`/dashboard/automations/${automation._id}`);
    } catch (err) {
      logger.error('Automation update error', { error: err.message });
      return next(err);
    }
  },
];

// ---------------------------------------------------------------------------
// destroy  (DELETE /dashboard/automations/:id)
// ---------------------------------------------------------------------------
const destroy = async (req, res, next) => {
  try {
    const automation = await Automation.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { status: 'archived', archivedAt: new Date() },
      { new: true },
    );

    if (!automation) {
      req.flash('error', 'Automation not found.');
      return res.redirect('/dashboard/automations');
    }

    await AuditLog.create({
      userId: req.user._id,
      action: 'automation.archived',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { automationId: automation._id, name: automation.name },
    });

    req.flash('success', `Automation "${automation.name}" has been deleted.`);
    return res.redirect('/dashboard/automations');
  } catch (err) {
    logger.error('Automation destroy error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// toggleStatus  (POST /dashboard/automations/:id/toggle)  → JSON
// ---------------------------------------------------------------------------
const toggleStatus = async (req, res, next) => {
  try {
    const automation = await Automation.findOne({
      _id: req.params.id,
      userId: req.user._id,
      status: { $ne: 'archived' },
    });

    if (!automation) {
      return res.status(404).json({ success: false, message: 'Automation not found.' });
    }

    automation.status = automation.status === 'active' ? 'paused' : 'active';
    await automation.save();

    await AuditLog.create({
      userId: req.user._id,
      action: `automation.${automation.status === 'active' ? 'activated' : 'paused'}`,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { automationId: automation._id },
    });

    return res.json({ success: true, status: automation.status });
  } catch (err) {
    logger.error('Automation toggle error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// duplicate  (POST /dashboard/automations/:id/duplicate)
// ---------------------------------------------------------------------------
const duplicate = async (req, res, next) => {
  try {
    const source = await Automation.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).lean();

    if (!source) {
      req.flash('error', 'Automation not found.');
      return res.redirect('/dashboard/automations');
    }

    const cloned = await Automation.create({
      userId: req.user._id,
      instagramAccountId: source.instagramAccountId,
      name: `Copy of ${source.name}`,
      triggerType: source.triggerType,
      triggerConditions: source.triggerConditions,
      actions: source.actions,
      status: 'paused',
    });

    await AuditLog.create({
      userId: req.user._id,
      action: 'automation.duplicated',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { sourceId: source._id, clonedId: cloned._id },
    });

    req.flash('success', `Automation duplicated as "${cloned.name}".`);
    return res.redirect(`/dashboard/automations/${cloned._id}/edit`);
  } catch (err) {
    logger.error('Automation duplicate error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// templates  (GET /dashboard/automations/templates)
// ---------------------------------------------------------------------------
const templates = (req, res) => {
  return res.render('automation/templates', {
    title: 'Automation Templates',
    templates: automationTemplates,
    user: req.user,
    error: req.flash('error'),
    success: req.flash('success'),
  });
};

// ---------------------------------------------------------------------------
// useTemplate  (POST /dashboard/automations/templates/:templateId)
// ---------------------------------------------------------------------------
const useTemplate = async (req, res, next) => {
  try {
    const template = automationTemplates.find((t) => t.id === req.params.templateId);
    if (!template) {
      req.flash('error', 'Template not found.');
      return res.redirect('/dashboard/automations/templates');
    }

    const automation = await Automation.create({
      userId: req.user._id,
      instagramAccountId: req.body.instagramAccountId || null,
      name: template.name,
      triggerType: template.triggerType,
      triggerConditions: template.triggerConditions || {},
      actions: template.actions || [],
      status: 'paused',
    });

    await AuditLog.create({
      userId: req.user._id,
      action: 'automation.createdFromTemplate',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { templateId: template.id, automationId: automation._id },
    });

    req.flash('success', `Automation created from template "${template.name}". Review and activate it below.`);
    return res.redirect(`/dashboard/automations/${automation._id}/edit`);
  } catch (err) {
    logger.error('Use template error', { error: err.message });
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
  toggleStatus,
  duplicate,
  templates,
  useTemplate,
};
