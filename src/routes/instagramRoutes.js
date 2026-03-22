'use strict';

/**
 * Instagram routes — /dashboard/instagram/*
 *
 * All routes require authentication AND an active subscription.
 * Uses the full-featured requireAuth from auth.js (supports both session
 * and JWT) and requireActiveSubscription which also bypasses checks for
 * admin-role users.
 */

const express = require('express');
const router  = express.Router();

const instagramController                          = require('../controllers/instagramController');
const { requireAuth, requireActiveSubscription }   = require('../middleware/auth');
const { checkPlanLimit }                           = require('../middleware/authMiddleware');

// ---------------------------------------------------------------------------
// Global guards — authentication + active subscription required
// ---------------------------------------------------------------------------
router.use(requireAuth);
router.use(requireActiveSubscription);

// ---------------------------------------------------------------------------
// Account list  →  GET /dashboard/instagram
// ---------------------------------------------------------------------------
router.get('/', instagramController.index);

// ---------------------------------------------------------------------------
// JSON list of accounts (used by front-end account pickers)
// Must be defined before /:accountId to avoid route shadowing
// ---------------------------------------------------------------------------
router.get('/accounts.json', instagramController.accounts);

// ---------------------------------------------------------------------------
// OAuth connect flow
// ---------------------------------------------------------------------------

/** GET /dashboard/instagram/connect — initiate Instagram OAuth */
router.get('/connect', checkPlanLimit('instagramAccounts'), instagramController.connect);

/** GET /dashboard/instagram/callback — OAuth callback from Instagram */
router.get('/callback', instagramController.callback);

// ---------------------------------------------------------------------------
// Per-account management
// ---------------------------------------------------------------------------

/** POST /dashboard/instagram/:accountId/disconnect — soft-delete account */
router.post('/:accountId/disconnect', instagramController.disconnect);

/** POST /dashboard/instagram/:accountId/refresh — refresh long-lived token (JSON) */
router.post('/:accountId/refresh', instagramController.refresh);

/** POST /dashboard/instagram/:accountId/sync — sync profile data (JSON) */
router.post('/:accountId/sync', instagramController.syncAccount);

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

/** GET /dashboard/instagram/:accountId/insights — insights dashboard */
router.get('/:accountId/insights', instagramController.getInsights);

module.exports = router;
