'use strict';

/**
 * Subscription routes — /subscription/*
 *
 * Public: pricing page
 * Auth required: checkout, manage, invoices, coupon validation
 *
 * Payment gateway webhook endpoints (/subscription/webhooks/*) are tagged
 * as CSRF-excluded because external services cannot provide a CSRF token.
 * A separate raw-body parser is applied so HMAC signatures can be verified
 * over the exact bytes received from the gateway.
 *
 * NOTE: The primary webhook routes now live at /webhooks/razorpay and
 * /webhooks/cashfree (see webhookRoutes.js).  The routes below are kept
 * here as an alternative mount point for backward compatibility and for
 * cases where subscription-specific webhook logic is processed inline.
 */

const express = require('express');
const router  = express.Router();

const subscriptionController      = require('../controllers/subscriptionController');
const { requireAuth }             = require('../middleware/auth');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mark route handlers as CSRF-excluded. The global csurf middleware (see
 * app.js) checks for req.csrfExcluded and skips token validation when set.
 *
 * @param {...Function} handlers
 * @returns {Function[]}
 */
function csrfExclude(...handlers) {
  const marker = (req, res, next) => {
    req.csrfExcluded = true;
    next();
  };
  return [marker, ...handlers];
}

/** Raw body parser for webhook signature verification */
const rawBodyParser = express.raw({ type: ['application/json', '*/*'], limit: '1mb' });

// ---------------------------------------------------------------------------
// Public — pricing page (accessible without login)
// ---------------------------------------------------------------------------

/** GET /subscription/pricing — public pricing page */
router.get('/pricing', subscriptionController.pricing);

// ---------------------------------------------------------------------------
// Checkout (auth required)
// ---------------------------------------------------------------------------

/** GET /subscription/checkout/:planId — show checkout page */
router.get('/checkout/:planId', requireAuth, subscriptionController.checkout);

/** POST /subscription/checkout/:planId — create payment order (returns JSON) */
router.post('/checkout/:planId', requireAuth, subscriptionController.processCheckout);

// ---------------------------------------------------------------------------
// Post-payment gateway redirects
// ---------------------------------------------------------------------------

/** GET /subscription/success — handle gateway success redirect */
router.get('/success', requireAuth, subscriptionController.success);

/** GET /subscription/cancel — handle gateway cancellation redirect */
router.get('/cancel', subscriptionController.cancel);

// ---------------------------------------------------------------------------
// Subscription management (auth required)
// ---------------------------------------------------------------------------

/** GET /subscription/manage — subscription management page */
router.get('/manage', requireAuth, subscriptionController.manage);

/** POST /subscription/cancel — request subscription cancellation */
router.post('/cancel', requireAuth, subscriptionController.cancelSubscription);

/** POST /subscription/change-plan — upgrade / downgrade plan */
router.post('/change-plan', requireAuth, subscriptionController.upgradeDowngrade);

// ---------------------------------------------------------------------------
// Invoices (auth required)
// ---------------------------------------------------------------------------

/** GET /subscription/invoices — paginated invoice history */
router.get('/invoices', requireAuth, subscriptionController.invoices);

/** GET /subscription/invoices/:paymentId/download — download invoice PDF */
router.get('/invoices/:paymentId/download', requireAuth, subscriptionController.downloadInvoice);

// ---------------------------------------------------------------------------
// Coupon validation (auth required, returns JSON)
// ---------------------------------------------------------------------------

/** POST /subscription/apply-coupon — validate and apply coupon code */
router.post('/apply-coupon', requireAuth, subscriptionController.applyCoupon);

// ---------------------------------------------------------------------------
// Payment gateway webhooks — CSRF excluded, no authentication
// Raw body parser is applied first to preserve bytes for signature checks.
// ---------------------------------------------------------------------------

/** POST /subscription/webhooks/razorpay — Razorpay payment webhook */
router.post(
  '/webhooks/razorpay',
  rawBodyParser,
  ...csrfExclude(subscriptionController.webhookRazorpay),
);

/** POST /subscription/webhooks/cashfree — Cashfree payment webhook */
router.post(
  '/webhooks/cashfree',
  rawBodyParser,
  ...csrfExclude(subscriptionController.webhookCashfree),
);

module.exports = router;
