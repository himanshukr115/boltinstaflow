'use strict';

/**
 * Admin routes — /admin/*
 *
 * All routes require authentication AND the admin role.
 * requireAuth from auth.js handles both Passport sessions and JWT.
 * requireAdmin from auth.js redirects non-admin authenticated users to /dashboard.
 */

const express = require('express');
const router  = express.Router();

const adminController                   = require('../controllers/adminController');
const { requireAuth, requireAdmin }     = require('../middleware/auth');

// ---------------------------------------------------------------------------
// Global guards — authentication + admin role required for every route
// ---------------------------------------------------------------------------
router.use(requireAuth);
router.use(requireAdmin);

// ---------------------------------------------------------------------------
// Admin dashboard overview  →  GET /admin
// ---------------------------------------------------------------------------
router.get('/', adminController.dashboard);

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

/** GET /admin/users — paginated user list with search/filters */
router.get('/users', adminController.users);

/** GET /admin/users/:id — user detail with subscription and payment history */
router.get('/users/:id', adminController.showUser);

/** POST /admin/users/:id — update user fields (name, email, role, verified) */
router.post('/users/:id', adminController.updateUser);

/** POST /admin/users/:id/suspend — suspend a user account */
router.post('/users/:id/suspend', adminController.suspendUser);

/** POST /admin/users/:id/unsuspend — restore a suspended account */
router.post('/users/:id/unsuspend', adminController.unsuspendUser);

/** POST /admin/users/:id/assign-plan — manually assign a plan (bypasses payment) */
router.post('/users/:id/assign-plan', adminController.assignPlan);

// ---------------------------------------------------------------------------
// Subscription plan management
// Note: /plans/create and /plans/reorder must be declared before /plans/:id
// ---------------------------------------------------------------------------

/** GET /admin/plans — list all subscription plans */
router.get('/plans', adminController.plans);

/** GET /admin/plans/create — create plan form */
router.get('/plans/create', adminController.createPlan);

/** POST /admin/plans — store new plan */
router.post('/plans', adminController.storePlan);

/** POST /admin/plans/reorder — reorder plans (returns JSON) */
router.post('/plans/reorder', adminController.reorderPlans);

/** GET /admin/plans/:id/edit — edit plan form */
router.get('/plans/:id/edit', adminController.editPlan);

/** PUT /admin/plans/:id — update plan details */
router.put('/plans/:id', adminController.updatePlan);

/** POST /admin/plans/:id/toggle — toggle plan active/inactive (returns JSON) */
router.post('/plans/:id/toggle', adminController.togglePlanStatus);

/** DELETE /admin/plans/:id — delete plan (only if no active subscriptions) */
router.delete('/plans/:id', adminController.deletePlan);

// ---------------------------------------------------------------------------
// Payment history
// ---------------------------------------------------------------------------

/** GET /admin/payments — paginated payment list with filters */
router.get('/payments', adminController.payments);

/** GET /admin/payments/:id — payment detail */
router.get('/payments/:id', adminController.showPayment);

/** POST /admin/payments/:id/refund — initiate refund (returns JSON) */
router.post('/payments/:id/refund', adminController.refundPayment);

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------

/** GET /admin/subscriptions — paginated subscription list */
router.get('/subscriptions', adminController.subscriptions);

/** GET /admin/subscriptions/:id — subscription detail with related payments */
router.get('/subscriptions/:id', adminController.showSubscription);

// ---------------------------------------------------------------------------
// Gateway settings
// ---------------------------------------------------------------------------

/** GET /admin/settings — gateway configuration page */
router.get('/settings', adminController.settings);

/** POST /admin/settings — save gateway credentials */
router.post('/settings', adminController.updateSettings);

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------

/** GET /admin/audit-logs — filterable audit log viewer */
router.get('/audit-logs', adminController.auditLogs);

// ---------------------------------------------------------------------------
// Platform analytics
// ---------------------------------------------------------------------------

/** GET /admin/analytics — revenue and growth charts */
router.get('/analytics', adminController.analytics);

// ---------------------------------------------------------------------------
// Webhook event logs
// ---------------------------------------------------------------------------

/** GET /admin/webhook-logs — incoming webhook log viewer */
router.get('/webhook-logs', adminController.webhookLogs);

module.exports = router;
