'use strict';

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const API_VERSION = '2023-08-01';

function getBaseUrl() {
  const env = process.env.CASHFREE_ENV || 'sandbox';
  return env === 'prod' || env === 'production'
    ? 'https://api.cashfree.com'
    : 'https://sandbox.cashfree.com';
}

function getHeaders(extraHeaders = {}) {
  return {
    'x-api-version': API_VERSION,
    'x-client-id': process.env.CASHFREE_CLIENT_ID,
    'x-client-secret': process.env.CASHFREE_CLIENT_SECRET,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
}

// ---------------------------------------------------------------------------
// HTTP client wrapper
// ---------------------------------------------------------------------------
async function cashfreeRequest(method, path, data = null, params = null) {
  const url = `${getBaseUrl()}${path}`;
  const config = {
    method,
    url,
    headers: getHeaders(),
    timeout: 30000,
  };
  if (data) config.data = data;
  if (params) config.params = params;

  const response = await axios(config);
  return response.data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ok(data) {
  return { success: true, data, error: null };
}

function fail(err, context) {
  const httpData = err.response && err.response.data;
  const message =
    (httpData && (httpData.message || JSON.stringify(httpData))) ||
    (err.message || String(err));
  logger.error(`[CashfreeService] ${context}: ${message}`, {
    status: err.response && err.response.status,
    details: httpData,
    stack: err.stack,
  });
  return { success: false, data: null, error: message };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * Create a Cashfree payment order.
 * @param {string} orderId      – unique order ID in your system
 * @param {number} amount       – order amount in INR (decimal, e.g. 499.00)
 * @param {string} currency     – e.g. 'INR'
 * @param {object} customer     – { customerId, customerName, customerEmail, customerPhone }
 * @param {string} returnUrl    – redirect after payment
 * @param {string} notifyUrl    – webhook notification URL
 */
async function createOrder(orderId, amount, currency = 'INR', customer, returnUrl, notifyUrl) {
  try {
    if (!process.env.CASHFREE_CLIENT_ID || !process.env.CASHFREE_CLIENT_SECRET) {
      throw new Error('CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET must be set');
    }
    const payload = {
      order_id: orderId,
      order_amount: parseFloat(amount.toFixed(2)),
      order_currency: currency,
      customer_details: {
        customer_id: customer.customerId,
        customer_name: customer.customerName,
        customer_email: customer.customerEmail,
        customer_phone: customer.customerPhone,
      },
      order_meta: {
        return_url: returnUrl,
        notify_url: notifyUrl,
      },
    };
    const data = await cashfreeRequest('POST', '/pg/orders', payload);
    logger.info('[CashfreeService] Order created', { orderId, amount, currency });
    return ok(data);
  } catch (err) {
    return fail(err, 'createOrder');
  }
}

/**
 * Fetch order details by order ID.
 * @param {string} orderId
 */
async function fetchOrder(orderId) {
  try {
    const data = await cashfreeRequest('GET', `/pg/orders/${orderId}`);
    return ok(data);
  } catch (err) {
    return fail(err, 'fetchOrder');
  }
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Create a subscription (recurring payments).
 * @param {string} planId       – Cashfree plan ID
 * @param {string} customerId   – Cashfree customer ID
 * @param {string} returnUrl
 * @param {string} notifyUrl
 */
async function createSubscription(planId, customerId, returnUrl, notifyUrl) {
  try {
    const subscriptionId = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    const payload = {
      subscription_id: subscriptionId,
      plan_id: planId,
      customer_id: customerId,
      authorization_details: {
        return_url: returnUrl,
        notify_url: notifyUrl,
      },
    };
    const data = await cashfreeRequest('POST', '/easy-subscriptions/subscriptions', payload);
    logger.info('[CashfreeService] Subscription created', { subscriptionId, planId, customerId });
    return ok(data);
  } catch (err) {
    return fail(err, 'createSubscription');
  }
}

/**
 * Cancel a subscription.
 * @param {string} subscriptionId
 */
async function cancelSubscription(subscriptionId) {
  try {
    const data = await cashfreeRequest(
      'PATCH',
      `/easy-subscriptions/subscriptions/${subscriptionId}`,
      { status: 'CANCELLED' }
    );
    logger.info('[CashfreeService] Subscription cancelled', { subscriptionId });
    return ok(data);
  } catch (err) {
    return fail(err, 'cancelSubscription');
  }
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * Create a subscription plan.
 * @param {string} planId    – unique plan ID in your system
 * @param {string} planName
 * @param {string} type      – 'PERIODIC' | 'ON_DEMAND'
 * @param {number} amount    – recurring charge amount
 * @param {number} interval  – billing interval (number of periods between charges)
 * @param {string} intervalType – 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
 */
async function createPlan(planId, planName, type = 'PERIODIC', amount, interval = 1, intervalType = 'MONTHLY') {
  try {
    const payload = {
      plan_id: planId,
      plan_name: planName,
      plan_type: type,
      plan_currency: 'INR',
      plan_max_amount: parseFloat(amount.toFixed(2)),
      plan_max_cycles: 0, // 0 = unlimited
      plan_intervals: interval,
      plan_interval_type: intervalType,
    };
    const data = await cashfreeRequest('POST', '/easy-subscriptions/plans', payload);
    logger.info('[CashfreeService] Plan created', { planId, planName, type, amount });
    return ok(data);
  } catch (err) {
    return fail(err, 'createPlan');
  }
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/**
 * Create or upsert a Cashfree customer.
 * @param {string} customerId
 * @param {string} customerName
 * @param {string} customerEmail
 * @param {string} customerPhone
 */
async function createCustomer(customerId, customerName, customerEmail, customerPhone) {
  try {
    const payload = {
      customer_id: customerId,
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone,
    };
    const data = await cashfreeRequest('POST', '/easy-subscriptions/customers', payload);
    logger.info('[CashfreeService] Customer created/updated', { customerId, customerEmail });
    return ok(data);
  } catch (err) {
    // If customer already exists (409), try to fetch instead
    if (err.response && err.response.status === 409) {
      try {
        const existing = await cashfreeRequest('GET', `/easy-subscriptions/customers/${customerId}`);
        return ok(existing);
      } catch (fetchErr) {
        return fail(fetchErr, 'createCustomer:fetch-existing');
      }
    }
    return fail(err, 'createCustomer');
  }
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * Process a refund for an order.
 * @param {string} orderId
 * @param {string} refundId    – unique refund ID in your system
 * @param {number} refundAmount
 * @param {string} refundNote  – reason for refund
 */
async function refund(orderId, refundId, refundAmount, refundNote = '') {
  try {
    const payload = {
      refund_id: refundId,
      refund_amount: parseFloat(refundAmount.toFixed(2)),
      refund_note: refundNote,
    };
    const data = await cashfreeRequest('POST', `/pg/orders/${orderId}/refunds`, payload);
    logger.info('[CashfreeService] Refund initiated', { orderId, refundId, refundAmount });
    return ok(data);
  } catch (err) {
    return fail(err, 'refund');
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Get all payments for a given order.
 * @param {string} orderId
 */
async function getPayments(orderId) {
  try {
    const data = await cashfreeRequest('GET', `/pg/orders/${orderId}/payments`);
    return ok(data);
  } catch (err) {
    return fail(err, 'getPayments');
  }
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Verify Cashfree webhook signature.
 *
 * Cashfree signs webhooks as:
 *   HMAC-SHA256( timestamp + rawBody, CLIENT_SECRET )
 *   and base64-encodes the result.
 *
 * @param {string|Buffer} rawBody  – raw request body (must not be parsed)
 * @param {string}        signature – value of x-webhook-signature header
 * @param {string}        timestamp – value of x-webhook-timestamp header
 */
function verifyWebhookSignature(rawBody, signature, timestamp) {
  try {
    const secret = process.env.CASHFREE_CLIENT_SECRET;
    if (!secret) {
      return fail(new Error('CASHFREE_CLIENT_SECRET not set'), 'verifyWebhookSignature');
    }
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const message = timestamp + body;
    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('base64');

    // Use timing-safe comparison on base64 strings
    const sigBuf = Buffer.from(signature, 'base64');
    const genBuf = Buffer.from(generatedSignature, 'base64');

    if (sigBuf.length !== genBuf.length) {
      return { success: false, data: null, error: 'Webhook signature mismatch' };
    }

    const isValid = crypto.timingSafeEqual(sigBuf, genBuf);
    if (!isValid) {
      return { success: false, data: null, error: 'Webhook signature mismatch' };
    }
    return ok({ valid: true });
  } catch (err) {
    return fail(err, 'verifyWebhookSignature');
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  createOrder,
  fetchOrder,
  createSubscription,
  cancelSubscription,
  createPlan,
  createCustomer,
  refund,
  getPayments,
  verifyWebhookSignature,
};
