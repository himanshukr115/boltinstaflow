'use strict';

/**
 * Campaign routes — /dashboard/campaigns/*
 *
 * All routes require authentication and an active subscription.
 * Plan quota guard is applied on creation so users cannot create more
 * campaigns than their tier allows.
 */

const express = require('express');
const router  = express.Router();

const campaignController                            = require('../controllers/campaignController');
const { requireAuth, requireActiveSubscription }    = require('../middleware/auth');
const { checkPlanLimit }                            = require('../middleware/authMiddleware');

// ---------------------------------------------------------------------------
// Global guards
// ---------------------------------------------------------------------------
router.use(requireAuth);
router.use(requireActiveSubscription);

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** GET /dashboard/campaigns — paginated campaign list */
router.get('/', campaignController.index);

/** GET /dashboard/campaigns/create — new campaign form */
router.get('/create', campaignController.create);

/** POST /dashboard/campaigns — create campaign (plan limit check applied) */
router.post('/', checkPlanLimit('campaigns'), ...campaignController.store);

/** GET /dashboard/campaigns/:id — campaign detail page */
router.get('/:id', campaignController.show);

/** GET /dashboard/campaigns/:id/edit — edit campaign form (draft only) */
router.get('/:id/edit', campaignController.edit);

/** PUT /dashboard/campaigns/:id — update campaign (draft only) */
router.put('/:id', ...campaignController.update);

/** DELETE /dashboard/campaigns/:id — delete campaign (draft/completed/failed only) */
router.delete('/:id', campaignController.destroy);

// ---------------------------------------------------------------------------
// Lifecycle actions (all return JSON)
// ---------------------------------------------------------------------------

/** POST /dashboard/campaigns/:id/launch — launch campaign immediately */
router.post('/:id/launch', campaignController.launch);

/** POST /dashboard/campaigns/:id/pause — pause running campaign */
router.post('/:id/pause', campaignController.pause);

/** POST /dashboard/campaigns/:id/resume — resume paused campaign */
router.post('/:id/resume', campaignController.resume);

/** POST /dashboard/campaigns/:id/schedule — schedule campaign for future send */
router.post('/:id/schedule', campaignController.schedule);

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** GET /dashboard/campaigns/:id/analytics — campaign stats (returns JSON) */
router.get('/:id/analytics', campaignController.analytics);

module.exports = router;
