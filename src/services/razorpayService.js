'use strict';

const Razorpay = require('razorpay');
const crypto = require('crypto');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Razorpay client – initialised once and reused across calls
// ---------------------------------------------------------------------------
let razorpayClient = null;

function getClient() {
  if (!razorpayClient) {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in environment variables');
    }
    razorpayClient = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayClient;
}

// ---------------------------------------------------------------------------
// Helper – uniform response envelope
// ---------------------------------------------------------------------------
function ok(data) {
  return { success: true, data, error: null };
}

function fail(error, context) {
  const message = error && error.message ? error.message : String(error);
  logger.error(`[RazorpayService] ${context}: ${message}`, {
    stack: error && error.stack,
    details: error && error.error,
  });
  return { success: false, data: null, error: message };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * Create a Razorpay payment order.
 * @param {number} amount  – amount in smallest currency unit (paise for INR)
 * @param {string} currency – e.g. 'INR'
 * @param {string} receipt  – unique receipt string (max 40 chars)
 * @param {object} notes    – key-value metadata (max 15 keys)
 * @returns {{ success: boolean, data: object|null, error: string|null }}
 */
async function createOrder(amount, currency = 'INR', receipt, notes = {}) {
  try {
    const client = getClient();
    const order = await client.orders.create({
      amount: Math.round(amount),
      currency,
      receipt: receipt || `rcpt_${Date.now()}`,
      notes,
      payment_capture: 1, // auto-capture
    });
    logger.info('[RazorpayService] Order created', { orderId: order.id, amount, currency });
    return ok(order);
  } catch (err) {
    return fail(err, 'createOrder');
  }
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Create a recurring subscription.
 * @param {string} planId        – Razorpay plan ID
 * @param {number} totalCount    – total billing cycles (e.g. 12 for annual)
 * @param {number} customerNotify – 1 to send SMS/email to customer, 0 otherwise
 * @param {Array}  addons        – optional addons array
 */
async function createSubscription(planId, totalCount = 12, customerNotify = 1, addons = []) {
  try {
    const client = getClient();
    const payload = {
      plan_id: planId,
      total_count: totalCount,
      quantity: 1,
      customer_notify: customerNotify,
    };
    if (addons && addons.length > 0) {
      payload.addons = addons;
    }
    const subscription = await client.subscriptions.create(payload);
    logger.info('[RazorpayService] Subscription created', {
      subscriptionId: subscription.id,
      planId,
    });
    return ok(subscription);
  } catch (err) {
    return fail(err, 'createSubscription');
  }
}

/**
 * Cancel a subscription.
 * @param {string}  subscriptionId
 * @param {boolean} cancelAtCycleEnd – if true, cancel at end of current cycle
 */
async function cancelSubscription(subscriptionId, cancelAtCycleEnd = false) {
  try {
    const client = getClient();
    const result = await client.subscriptions.cancel(subscriptionId, cancelAtCycleEnd);
    logger.info('[RazorpayService] Subscription cancelled', { subscriptionId, cancelAtCycleEnd });
    return ok(result);
  } catch (err) {
    return fail(err, 'cancelSubscription');
  }
}

/**
 * Pause an active subscription.
 * @param {string} subscriptionId
 */
async function pauseSubscription(subscriptionId) {
  try {
    const client = getClient();
    const result = await client.subscriptions.pause(subscriptionId, { pause_at: 'now' });
    logger.info('[RazorpayService] Subscription paused', { subscriptionId });
    return ok(result);
  } catch (err) {
    return fail(err, 'pauseSubscription');
  }
}

/**
 * Resume a paused subscription.
 * @param {string} subscriptionId
 */
async function resumeSubscription(subscriptionId) {
  try {
    const client = getClient();
    const result = await client.subscriptions.resume(subscriptionId, { resume_at: 'now' });
    logger.info('[RazorpayService] Subscription resumed', { subscriptionId });
    return ok(result);
  } catch (err) {
    return fail(err, 'resumeSubscription');
  }
}

/**
 * Fetch full details of a subscription.
 * @param {string} subscriptionId
 */
async function fetchSubscription(subscriptionId) {
  try {
    const client = getClient();
    const subscription = await client.subscriptions.fetch(subscriptionId);
    return ok(subscription);
  } catch (err) {
    return fail(err, 'fetchSubscription');
  }
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/**
 * Create a Razorpay customer record.
 * @param {string} name
 * @param {string} email
 * @param {string} contact – phone number with country code (e.g. '+919876543210')
 */
async function createCustomer(name, email, contact) {
  try {
    const client = getClient();
    const customer = await client.customers.create({
      name,
      email,
      contact,
      fail_existing: 0, // return existing customer if email already present
    });
    logger.info('[RazorpayService] Customer created/fetched', { customerId: customer.id, email });
    return ok(customer);
  } catch (err) {
    return fail(err, 'createCustomer');
  }
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * Create a recurring billing plan.
 * @param {number} interval – billing frequency (e.g. 1)
 * @param {string} period   – 'daily' | 'weekly' | 'monthly' | 'yearly'
 * @param {object} item     – { name, amount, unit_amount, currency, description }
 */
async function createPlan(interval, period, item) {
  try {
    const client = getClient();
    const plan = await client.plans.create({
      period,
      interval,
      item: {
        name: item.name,
        amount: Math.round(item.amount),
        currency: item.currency || 'INR',
        description: item.description || item.name,
      },
      notes: item.notes || {},
    });
    logger.info('[RazorpayService] Plan created', { planId: plan.id, period, interval });
    return ok(plan);
  } catch (err) {
    return fail(err, 'createPlan');
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Fetch a payment by its ID.
 * @param {string} paymentId
 */
async function fetchPayment(paymentId) {
  try {
    const client = getClient();
    const payment = await client.payments.fetch(paymentId);
    return ok(payment);
  } catch (err) {
    return fail(err, 'fetchPayment');
  }
}

/**
 * Capture an authorized (but not yet captured) payment.
 * @param {string} paymentId
 * @param {number} amount   – amount in smallest currency unit
 * @param {string} currency
 */
async function capturePayment(paymentId, amount, currency = 'INR') {
  try {
    const client = getClient();
    const payment = await client.payments.capture(paymentId, Math.round(amount), currency);
    logger.info('[RazorpayService] Payment captured', { paymentId, amount, currency });
    return ok(payment);
  } catch (err) {
    return fail(err, 'capturePayment');
  }
}

/**
 * Initiate a refund.
 * @param {string} paymentId
 * @param {number} amount    – amount to refund in smallest currency unit (full refund if omitted)
 * @param {object} notes
 * @param {string} speed     – 'normal' | 'optimum'
 */
async function refundPayment(paymentId, amount, notes = {}, speed = 'optimum') {
  try {
    const client = getClient();
    const payload = { speed, notes };
    if (amount) payload.amount = Math.round(amount);
    const refund = await client.payments.refund(paymentId, payload);
    logger.info('[RazorpayService] Refund initiated', { paymentId, refundId: refund.id, amount });
    return ok(refund);
  } catch (err) {
    return fail(err, 'refundPayment');
  }
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify Razorpay webhook signature using HMAC-SHA256.
 * @param {string|Buffer} body      – raw request body (string or Buffer)
 * @param {string}        signature – value of X-Razorpay-Signature header
 * @param {string}        secret    – webhook secret configured in Razorpay dashboard
 */
function verifyWebhookSignature(body, signature, secret) {
  try {
    const webhookSecret = secret || process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return fail(new Error('Webhook secret not provided'), 'verifyWebhookSignature');
    }
    const rawBody = typeof body === 'string' ? body : body.toString('utf8');
    const generatedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');
    const isValid = crypto.timingSafeEqual(
      Buffer.from(generatedSignature, 'hex'),
      Buffer.from(signature, 'hex')
    );
    if (!isValid) {
      return { success: false, data: null, error: 'Webhook signature mismatch' };
    }
    return ok({ valid: true });
  } catch (err) {
    return fail(err, 'verifyWebhookSignature');
  }
}

/**
 * Verify payment signature for order-based payment flow.
 * Razorpay signs: razorpay_order_id + '|' + razorpay_payment_id
 * @param {string} orderId
 * @param {string} paymentId
 * @param {string} signature – razorpay_signature from client
 */
function verifyPaymentSignature(orderId, paymentId, signature) {
  try {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return fail(new Error('RAZORPAY_KEY_SECRET not set'), 'verifyPaymentSignature');
    }
    const payload = `${orderId}|${paymentId}`;
    const generatedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(payload)
      .digest('hex');
    const isValid = crypto.timingSafeEqual(
      Buffer.from(generatedSignature, 'hex'),
      Buffer.from(signature, 'hex')
    );
    if (!isValid) {
      return { success: false, data: null, error: 'Payment signature mismatch' };
    }
    return ok({ valid: true });
  } catch (err) {
    return fail(err, 'verifyPaymentSignature');
  }
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * Create a Razorpay invoice (used for one-time billing links).
 * @param {string} userId       – internal user ID stored in description/notes
 * @param {number} amount       – amount in smallest currency unit
 * @param {string} description
 */
async function createInvoice(userId, amount, description) {
  try {
    const client = getClient();
    const invoice = await client.invoices.create({
      type: 'invoice',
      description,
      amount: Math.round(amount),
      currency: 'INR',
      date: Math.floor(Date.now() / 1000),
      notes: { userId },
    });
    logger.info('[RazorpayService] Invoice created', { invoiceId: invoice.id, userId, amount });
    return ok(invoice);
  } catch (err) {
    return fail(err, 'createInvoice');
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  createOrder,
  createSubscription,
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
  fetchSubscription,
  createCustomer,
  createPlan,
  fetchPayment,
  capturePayment,
  refundPayment,
  verifyWebhookSignature,
  verifyPaymentSignature,
  createInvoice,
};
