'use strict';

const crypto = require('crypto');
const path = require('path');

const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const Payment = require('../models/Payment');
const Coupon = require('../models/Coupon');
const AppSettings = require('../models/AppSettings');
const AuditLog = require('../models/AuditLog');
const emailService = require('../services/emailService');
const invoiceService = require('../services/invoiceService');
const paymentService = require('../services/paymentService');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// pricing  (GET /pricing)
// ---------------------------------------------------------------------------
const pricing = async (req, res, next) => {
  try {
    const plans = await Plan.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
    const currentSubscription = req.user
      ? await Subscription.findOne({ userId: req.user._id, status: { $in: ['active', 'trialing'] } })
          .populate('planId')
          .lean()
      : null;

    return res.render('subscription/pricing', {
      title: 'Pricing',
      plans,
      currentSubscription,
      user: req.user || null,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Pricing page error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// checkout  (GET /subscription/checkout/:planId)
// ---------------------------------------------------------------------------
const checkout = async (req, res, next) => {
  try {
    const plan = await Plan.findOne({ _id: req.params.planId, isActive: true }).lean();
    if (!plan) {
      req.flash('error', 'Plan not found.');
      return res.redirect('/pricing');
    }

    const appSettings = await AppSettings.findOne({ key: 'gateway' }).lean();
    const gateways = {
      razorpay: !!(appSettings && appSettings.value && appSettings.value.razorpay && appSettings.value.razorpay.keyId),
      cashfree: !!(appSettings && appSettings.value && appSettings.value.cashfree && appSettings.value.cashfree.appId),
    };

    return res.render('subscription/checkout', {
      title: `Checkout – ${plan.name}`,
      plan,
      gateways,
      user: req.user,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Checkout page error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// processCheckout  (POST /subscription/checkout/:planId)  → JSON
// ---------------------------------------------------------------------------
const processCheckout = async (req, res, next) => {
  const { gateway, couponCode } = req.body;

  if (!['razorpay', 'cashfree'].includes(gateway)) {
    return res.status(400).json({ success: false, message: 'Invalid payment gateway.' });
  }

  try {
    const plan = await Plan.findOne({ _id: req.params.planId, isActive: true }).lean();
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found.' });

    let discount = 0;
    let coupon = null;
    if (couponCode) {
      coupon = await Coupon.findOne({ code: couponCode.toUpperCase(), isActive: true });
      if (coupon && coupon.isValid()) {
        discount = coupon.calculateDiscount(plan.price);
      }
    }

    const amountInPaise = Math.round((plan.price - discount) * 100);

    const orderData = await paymentService.createOrder(gateway, {
      amount: amountInPaise,
      currency: plan.currency || 'INR',
      planId: plan._id.toString(),
      userId: req.user._id.toString(),
      couponCode: coupon ? coupon.code : null,
    });

    return res.json({ success: true, gateway, orderData, discount, finalAmount: (plan.price - discount) });
  } catch (err) {
    logger.error('Process checkout error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// success  (GET /subscription/success)  – redirect from gateway
// ---------------------------------------------------------------------------
const success = async (req, res, next) => {
  try {
    const { orderId, paymentId, signature, gateway } = req.query;

    if (!orderId || !paymentId) {
      req.flash('error', 'Invalid payment response. Please contact support.');
      return res.redirect('/subscription/manage');
    }

    const verified = await paymentService.verifyPayment(gateway || 'razorpay', {
      orderId,
      paymentId,
      signature,
    });

    if (!verified) {
      req.flash('error', 'Payment verification failed. Please contact support.');
      return res.redirect('/subscription/manage');
    }

    // Activate subscription
    const subscription = await paymentService.activateSubscription(req.user._id, orderId);

    emailService
      .sendSubscriptionConfirmationEmail(req.user, subscription)
      .catch((err) => logger.error('Subscription confirmation email failed', { error: err.message }));

    await AuditLog.create({
      userId: req.user._id,
      action: 'subscription.activated',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { orderId, paymentId, planId: subscription.planId },
    });

    req.flash('success', 'Subscription activated successfully! Welcome aboard.');
    return res.redirect('/dashboard');
  } catch (err) {
    logger.error('Subscription success error', { error: err.message });
    req.flash('error', 'Something went wrong activating your subscription. Please contact support.');
    return res.redirect('/subscription/manage');
  }
};

// ---------------------------------------------------------------------------
// cancel  (GET /subscription/cancel)  – user cancelled at gateway
// ---------------------------------------------------------------------------
const cancel = (req, res) => {
  req.flash('error', 'Payment was cancelled. Your subscription has not been activated.');
  return res.redirect('/pricing');
};

// ---------------------------------------------------------------------------
// manage  (GET /subscription/manage)
// ---------------------------------------------------------------------------
const manage = async (req, res, next) => {
  try {
    const subscription = await Subscription.findOne({
      userId: req.user._id,
    })
      .populate('planId')
      .sort({ createdAt: -1 })
      .lean();

    const recentPayments = await Payment.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    return res.render('subscription/manage', {
      title: 'Manage Subscription',
      subscription,
      recentPayments,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// cancelSubscription  (POST /subscription/cancel)
// ---------------------------------------------------------------------------
const cancelSubscription = async (req, res, next) => {
  try {
    const subscription = await Subscription.findOne({
      userId: req.user._id,
      status: { $in: ['active', 'trialing'] },
    });

    if (!subscription) {
      req.flash('error', 'No active subscription found.');
      return res.redirect('/subscription/manage');
    }

    await paymentService.cancelSubscription(subscription);

    subscription.cancelAtPeriodEnd = true;
    subscription.cancellationRequestedAt = new Date();
    await subscription.save();

    await AuditLog.create({
      userId: req.user._id,
      action: 'subscription.cancellationRequested',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { subscriptionId: subscription._id },
    });

    emailService
      .sendCancellationEmail(req.user, subscription)
      .catch((err) => logger.error('Cancellation email failed', { error: err.message }));

    req.flash('success', 'Your subscription will be cancelled at the end of the billing period.');
    return res.redirect('/subscription/manage');
  } catch (err) {
    logger.error('Cancel subscription error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// upgradeDowngrade  (POST /subscription/change-plan)
// ---------------------------------------------------------------------------
const upgradeDowngrade = async (req, res, next) => {
  const { newPlanId } = req.body;
  if (!newPlanId) {
    req.flash('error', 'Please select a plan.');
    return res.redirect('/subscription/manage');
  }

  try {
    const [newPlan, subscription] = await Promise.all([
      Plan.findOne({ _id: newPlanId, isActive: true }),
      Subscription.findOne({ userId: req.user._id, status: { $in: ['active', 'trialing'] } }),
    ]);

    if (!newPlan) {
      req.flash('error', 'Plan not found.');
      return res.redirect('/subscription/manage');
    }
    if (!subscription) {
      req.flash('error', 'No active subscription found.');
      return res.redirect('/subscription/manage');
    }

    await paymentService.changePlan(subscription, newPlan);

    subscription.planId = newPlan._id;
    subscription.updatedAt = new Date();
    await subscription.save();

    await AuditLog.create({
      userId: req.user._id,
      action: 'subscription.planChanged',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { newPlanId, subscriptionId: subscription._id },
    });

    req.flash('success', `Plan changed to ${newPlan.name}.`);
    return res.redirect('/subscription/manage');
  } catch (err) {
    logger.error('Plan change error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// invoices  (GET /subscription/invoices)
// ---------------------------------------------------------------------------
const invoices = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20;
    const skip = (page - 1) * limit;

    const [payments, total] = await Promise.all([
      Payment.find({ userId: req.user._id, status: 'captured' })
        .populate('planId', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Payment.countDocuments({ userId: req.user._id, status: 'captured' }),
    ]);

    return res.render('subscription/invoices', {
      title: 'Invoice History',
      payments,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      total,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// downloadInvoice  (GET /subscription/invoices/:paymentId/download)
// ---------------------------------------------------------------------------
const downloadInvoice = async (req, res, next) => {
  try {
    const payment = await Payment.findOne({
      _id: req.params.paymentId,
      userId: req.user._id,
      status: 'captured',
    }).populate('planId').lean();

    if (!payment) {
      req.flash('error', 'Invoice not found.');
      return res.redirect('/subscription/invoices');
    }

    const pdfBuffer = await invoiceService.generateInvoicePdf(payment, req.user);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="invoice-${payment.invoiceNumber || payment._id}.pdf"`,
    );
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.end(pdfBuffer);
  } catch (err) {
    logger.error('Download invoice error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// applyCoupon  (POST /subscription/apply-coupon)  → JSON
// ---------------------------------------------------------------------------
const applyCoupon = async (req, res, next) => {
  const { code, planId } = req.body;

  if (!code || !planId) {
    return res.status(400).json({ success: false, message: 'Coupon code and plan ID are required.' });
  }

  try {
    const [coupon, plan] = await Promise.all([
      Coupon.findOne({ code: code.toUpperCase().trim(), isActive: true }),
      Plan.findById(planId).lean(),
    ]);

    if (!coupon) {
      return res.json({ success: false, message: 'Invalid or expired coupon code.' });
    }
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found.' });
    }
    if (!coupon.isValid()) {
      return res.json({ success: false, message: 'This coupon has expired or reached its usage limit.' });
    }

    const discount = coupon.calculateDiscount(plan.price);
    const finalPrice = Math.max(0, plan.price - discount);

    return res.json({
      success: true,
      discount,
      finalPrice,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      message: `Coupon applied! You save ${plan.currency || 'INR'} ${discount.toFixed(2)}.`,
    });
  } catch (err) {
    logger.error('Apply coupon error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// webhookRazorpay  (POST /webhooks/razorpay)
// CSRF excluded via route-level csrfExclude wrapper
// ---------------------------------------------------------------------------
const webhookRazorpay = async (req, res, next) => {
  const signature = req.headers['x-razorpay-signature'];
  if (!signature) {
    logger.warn('Razorpay webhook missing signature');
    return res.status(400).json({ error: 'Missing signature' });
  }

  try {
    const appSettings = await AppSettings.findOne({ key: 'gateway' }).lean();
    const webhookSecret =
      appSettings && appSettings.value && appSettings.value.razorpay
        ? appSettings.value.razorpay.webhookSecret
        : process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      logger.error('Razorpay webhook secret not configured');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    // Verify HMAC-SHA256 signature over raw body
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const expectedSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      logger.warn('Razorpay webhook signature mismatch');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const { event, payload } = req.body;
    logger.info('Razorpay webhook received', { event });

    switch (event) {
      case 'payment.captured': {
        const payment = payload.payment && payload.payment.entity;
        if (payment) await paymentService.handleRazorpayPaymentCaptured(payment);
        break;
      }
      case 'subscription.activated': {
        const sub = payload.subscription && payload.subscription.entity;
        if (sub) await paymentService.handleRazorpaySubscriptionActivated(sub);
        break;
      }
      case 'subscription.cancelled': {
        const sub = payload.subscription && payload.subscription.entity;
        if (sub) await paymentService.handleRazorpaySubscriptionCancelled(sub);
        break;
      }
      case 'payment.failed': {
        const payment = payload.payment && payload.payment.entity;
        if (payment) await paymentService.handleRazorpayPaymentFailed(payment);
        break;
      }
      default:
        logger.debug('Unhandled Razorpay webhook event', { event });
    }

    return res.json({ received: true });
  } catch (err) {
    logger.error('Razorpay webhook error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// webhookCashfree  (POST /webhooks/cashfree)
// CSRF excluded via route-level csrfExclude wrapper
// ---------------------------------------------------------------------------
const webhookCashfree = async (req, res, next) => {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];

  if (!signature || !timestamp) {
    logger.warn('Cashfree webhook missing signature or timestamp');
    return res.status(400).json({ error: 'Missing signature headers' });
  }

  try {
    const appSettings = await AppSettings.findOne({ key: 'gateway' }).lean();
    const secretKey =
      appSettings && appSettings.value && appSettings.value.cashfree
        ? appSettings.value.cashfree.secretKey
        : process.env.CASHFREE_SECRET_KEY;

    if (!secretKey) {
      logger.error('Cashfree webhook secret not configured');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    // Cashfree: HMAC-SHA256 over (timestamp + rawBody)
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const signedData = `${timestamp}${rawBody}`;
    const expectedSig = crypto
      .createHmac('sha256', secretKey)
      .update(signedData)
      .digest('base64');

    if (signature !== expectedSig) {
      logger.warn('Cashfree webhook signature mismatch');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const { type, data } = req.body;
    logger.info('Cashfree webhook received', { type });

    switch (type) {
      case 'PAYMENT_SUCCESS_WEBHOOK':
        await paymentService.handleCashfreePaymentSuccess(data);
        break;
      case 'PAYMENT_FAILED_WEBHOOK':
        await paymentService.handleCashfreePaymentFailed(data);
        break;
      case 'PAYMENT_USER_DROPPED_WEBHOOK':
        await paymentService.handleCashfreePaymentDropped(data);
        break;
      case 'SUBSCRIPTION_STATUS_CHANGE':
        await paymentService.handleCashfreeSubscriptionChange(data);
        break;
      default:
        logger.debug('Unhandled Cashfree webhook event', { type });
    }

    return res.json({ received: true });
  } catch (err) {
    logger.error('Cashfree webhook error', { error: err.message });
    return next(err);
  }
};

module.exports = {
  pricing,
  checkout,
  processCheckout,
  success,
  cancel,
  manage,
  cancelSubscription,
  upgradeDowngrade,
  invoices,
  downloadInvoice,
  applyCoupon,
  webhookRazorpay,
  webhookCashfree,
};
