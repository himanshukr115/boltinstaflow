'use strict';

/**
 * REST API routes — /api/v1/*
 *
 * All endpoints are authenticated via API key (X-API-Key header or
 * ?api_key= query parameter). Responses are always JSON.
 *
 * Available endpoints:
 *   GET  /api/v1/account                      – current user info
 *   GET  /api/v1/contacts                     – list contacts (paginated)
 *   GET  /api/v1/contacts/:id                 – get contact by ID
 *   GET  /api/v1/automations                  – list automations (paginated)
 *   POST /api/v1/automations/:id/trigger      – manually trigger an automation
 *   GET  /api/v1/campaigns                    – list campaigns (paginated)
 *   GET  /api/v1/analytics                    – dashboard stats
 *   GET  /api/v1/instagram/accounts           – list connected Instagram accounts
 *   POST /api/v1/instagram/:accountId/sync    – sync account profile
 *   POST /api/v1/instagram/:accountId/refresh – refresh access token
 *   POST /api/v1/automations/:id/toggle       – toggle automation status
 *   POST /api/v1/campaigns/:id/launch         – launch campaign
 *   POST /api/v1/campaigns/:id/pause          – pause campaign
 *   GET  /api/v1/campaigns/:id/analytics      – campaign analytics
 *   PUT  /api/v1/contacts/:id                 – update contact
 *   DELETE /api/v1/contacts/:id               – soft-delete contact
 *   POST /api/v1/contacts/bulk-tag            – bulk tag/untag contacts
 */

const express  = require('express');
const rateLimit = require('express-rate-limit');
const router   = express.Router();

const instagramController           = require('../controllers/instagramController');
const automationController          = require('../controllers/automationController');
const campaignController            = require('../controllers/campaignController');
const contactController             = require('../controllers/contactController');
const analyticsService              = require('../services/analyticsService');
const { loadUserFromApiKey }        = require('../middleware/authMiddleware');
const { apiLimiter }                = require('../middleware/rateLimiter');
const logger                        = require('../config/logger');

// ---------------------------------------------------------------------------
// Authentication — API key required for every request
// ---------------------------------------------------------------------------
router.use(loadUserFromApiKey);

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
router.use(apiLimiter);

// ---------------------------------------------------------------------------
// Account info
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/account
 * Returns public account information for the authenticated API key owner.
 */
router.get('/account', (req, res) => {
  const { _id, name, email, role, isEmailVerified, avatarUrl, createdAt, apiKey } = req.user;
  return res.json({
    success: true,
    account: {
      id:              String(_id),
      name,
      email,
      role,
      isEmailVerified: !!isEmailVerified,
      avatarUrl:       avatarUrl || null,
      createdAt,
      // Mask all but last 8 chars of the API key for security
      apiKey:          apiKey ? ('*'.repeat(Math.max(0, apiKey.length - 8)) + apiKey.slice(-8)) : null,
    },
  });
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/analytics
 * Returns aggregated dashboard statistics for the authenticated user.
 */
router.get('/analytics', async (req, res, next) => {
  try {
    const stats = await analyticsService.getUserDashboardStats(req.user._id);
    return res.json({ success: true, analytics: stats });
  } catch (err) {
    logger.error('[API] analytics error', { error: err.message, userId: req.user._id });
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Contacts
// Static routes (/bulk-tag) must come before dynamic /:id routes.
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/contacts
 * Returns a paginated list of contacts for the authenticated user.
 * Supports ?search=, ?tag=, ?page= query parameters.
 */
router.get('/contacts', contactController.index);

/**
 * POST /api/v1/contacts/bulk-tag
 * Add or remove tags from multiple contacts.
 * Body: { contactIds: string[], tags: string[], action: 'add'|'remove' }
 */
router.post('/contacts/bulk-tag', contactController.bulkTag);

/**
 * GET /api/v1/contacts/:id
 * Returns full contact detail including tags, custom fields, notes.
 */
router.get('/contacts/:id', contactController.show);

/**
 * PUT /api/v1/contacts/:id
 * Update contact tags, custom fields, or notes.
 */
router.put('/contacts/:id', contactController.update);

/**
 * DELETE /api/v1/contacts/:id
 * Soft-delete a contact.
 */
router.delete('/contacts/:id', contactController.destroy);

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/automations
 * Returns a paginated list of automations for the authenticated user.
 * Supports ?status=active|paused, ?page= query parameters.
 */
router.get('/automations', automationController.index);

/**
 * POST /api/v1/automations/:id/trigger
 * Manually enqueue a trigger run for the specified automation.
 * Returns JSON with job ID.
 */
router.post('/automations/:id/trigger', async (req, res, next) => {
  try {
    const Automation = require('../models/Automation');
    const { addAutomationJob } = require('../queues/index');

    const automation = await Automation.findOne({
      _id:    req.params.id,
      userId: req.user._id,
      status: 'active',
    }).lean();

    if (!automation) {
      return res.status(404).json({ success: false, error: 'Active automation not found.' });
    }

    const job = await addAutomationJob('manualTrigger', {
      automationId: String(automation._id),
      userId:       String(req.user._id),
      triggeredBy:  'api',
      triggeredAt:  new Date().toISOString(),
      payload:      req.body || {},
    });

    return res.json({ success: true, jobId: job.id, automationId: String(automation._id) });
  } catch (err) {
    logger.error('[API] automations/:id/trigger error', { error: err.message });
    return next(err);
  }
});

/**
 * POST /api/v1/automations/:id/toggle
 * Activate or pause an automation.
 */
router.post('/automations/:id/toggle', automationController.toggleStatus);

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/campaigns
 * Returns a paginated list of campaigns for the authenticated user.
 * Supports ?status=, ?page= query parameters.
 */
router.get('/campaigns', campaignController.index);

/**
 * GET /api/v1/campaigns/:id/analytics
 * Returns delivery stats for a specific campaign.
 */
router.get('/campaigns/:id/analytics', campaignController.analytics);

/**
 * POST /api/v1/campaigns/:id/launch
 * Launch a draft or paused campaign immediately.
 */
router.post('/campaigns/:id/launch', campaignController.launch);

/**
 * POST /api/v1/campaigns/:id/pause
 * Pause a running campaign.
 */
router.post('/campaigns/:id/pause', campaignController.pause);

// ---------------------------------------------------------------------------
// Instagram accounts
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/instagram/accounts
 * Returns a list of connected, active Instagram accounts.
 */
router.get('/instagram/accounts', instagramController.accounts);

/**
 * POST /api/v1/instagram/:accountId/sync
 * Sync Instagram profile data (followers, bio, etc.) from the API.
 */
router.post('/instagram/:accountId/sync', instagramController.syncAccount);

/**
 * POST /api/v1/instagram/:accountId/refresh
 * Refresh the Instagram long-lived access token.
 */
router.post('/instagram/:accountId/refresh', instagramController.refresh);

module.exports = router;
