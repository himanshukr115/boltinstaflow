'use strict';

const razorpayService = require('./razorpayService');
const cashfreeService = require('./cashfreeService');
const logger = require('../config/logger');

async function createOrder(provider, options) {
  console.log(`[Payment] Creating order via ${provider}`);
  if (provider === 'cashfree') {
    return cashfreeService.createOrder(options);
  }
  return razorpayService.createOrder(options);
}

async function verifyPayment(provider, data) {
  console.log(`[Payment] Verifying payment via ${provider}`);
  if (provider === 'cashfree') {
    return cashfreeService.verifyPayment(data);
  }
  return razorpayService.verifyPayment(data);
}

async function createSubscription(provider, options) {
  console.log(`[Payment] Creating subscription via ${provider}`);
  if (provider === 'cashfree') {
    return cashfreeService.createSubscription(options);
  }
  return razorpayService.createSubscription(options);
}

async function cancelSubscription(provider, subscriptionId) {
  console.log(`[Payment] Cancelling subscription ${subscriptionId} via ${provider}`);
  if (provider === 'cashfree') {
    return cashfreeService.cancelSubscription(subscriptionId);
  }
  return razorpayService.cancelSubscription(subscriptionId);
}

module.exports = {
  createOrder,
  verifyPayment,
  createSubscription,
  cancelSubscription,
};
