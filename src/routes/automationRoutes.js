'use strict';

/**
 * Automation routes — /dashboard/automations/*
 *
 * All routes require authentication and an active subscription.
 * Plan quota guards (checkPlanLimit) are applied to create/duplicate
 * operations so that users cannot exceed their tier's automation limit.
 */

const express = require('express');
const router  = express.Router();

const automationController                          = require('../controllers/automationController');
const { requireAuth, requireActiveSubscription }    = require('../middleware/auth');
const { checkPlanLimit }                            = require('../middleware/authMiddleware');

// ---------------------------------------------------------------------------
// Global guards
// ---------------------------------------------------------------------------
router.use(requireAuth);
router.use(requireActiveSubscription);

// ---------------------------------------------------------------------------
// Template gallery — must be defined before /:id to avoid routing conflicts
// ---------------------------------------------------------------------------

/** GET /dashboard/automations/templates — browse template gallery */
router.get('/templates', automationController.templates);

/** POST /dashboard/automations/templates/:templateId — create automation from template */
router.post('/templates/:templateId', checkPlanLimit('automations'), automationController.useTemplate);

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** GET /dashboard/automations — paginated automation list */
router.get('/', automationController.index);

/** GET /dashboard/automations/create — new automation form */
router.get('/create', automationController.create);

/** POST /dashboard/automations — create automation (plan limit check applied) */
router.post('/', checkPlanLimit('automations'), ...automationController.store);

/** GET /dashboard/automations/:id — automation detail / analytics */
router.get('/:id', automationController.show);

/** GET /dashboard/automations/:id/edit — edit automation form */
router.get('/:id/edit', automationController.edit);

/** PUT /dashboard/automations/:id — update automation */
router.put('/:id', ...automationController.update);

/** DELETE /dashboard/automations/:id — archive automation */
router.delete('/:id', automationController.destroy);

// ---------------------------------------------------------------------------
// Per-automation actions
// ---------------------------------------------------------------------------

/** POST /dashboard/automations/:id/toggle — activate / pause (returns JSON) */
router.post('/:id/toggle', automationController.toggleStatus);

/** POST /dashboard/automations/:id/duplicate — clone automation (plan limit check) */
router.post('/:id/duplicate', checkPlanLimit('automations'), automationController.duplicate);

module.exports = router;
