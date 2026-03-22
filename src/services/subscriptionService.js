'use strict';

const mongoose = require('mongoose');
const logger = require('../config/logger');
const razorpayService = require('./razorpayService');
const cashfreeService = require('./cashfreeService');
const emailService = require('./emailService');

// ---------------------------------------------------------------------------
// Lazy model resolution – avoids circular-require at module load time
// ---------------------------------------------------------------------------
function getModels() {
  const User = mongoose.model('User');
  const Subscription = mongoose.model('Subscription');
  const Payment = mongoose.model('Payment');
  const Plan = mongoose.model('Plan');
  const Coupon = mongoose.model('Coupon');
  return { User, Subscription, Payment, Plan, Coupon };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
function ok(data) {
  return { success: true, data, error: null };
}

function fail(message, context, err) {
  logger.error(`[SubscriptionService] ${context}: ${message}`, {
    stack: err && err.stack,
  });
  return { success: false, data: null, error: message };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computePeriodEnd(billingCycle) {
  const now = new Date();
  if (billingCycle === 'yearly') {
    return new Date(now.setFullYear(now.getFullYear() + 1));
  }
  // Default monthly
  return new Date(now.setMonth(now.getMonth() + 1));
}

function computeDiscountedAmount(originalAmount, coupon) {
  if (!coupon) return { discountedAmount: originalAmount, discountAmount: 0 };
  let discountAmount = 0;
  if (coupon.discountType === 'percent') {
    discountAmount = Math.round((originalAmount * coupon.discountValue) / 100);
  } else if (coupon.discountType === 'flat') {
    discountAmount = Math.min(coupon.discountValue, originalAmount);
  }
  return { discountedAmount: originalAmount - discountAmount, discountAmount };
}

async function recordPayment(
  { User, Payment },
  userId,
  subscriptionId,
  amount,
  currency,
  status,
  gateway,
  gatewayPaymentId,
  gatewayOrderId,
  description,
  metadata = {}
) {
  const payment = new Payment({
    user: userId,
    subscription: subscriptionId,
    amount,
    currency: currency || 'INR',
    status,
    gateway,
    gatewayPaymentId: gatewayPaymentId || null,
    gatewayOrderId: gatewayOrderId || null,
    description,
    metadata,
    createdAt: new Date(),
  });
  await payment.save();
  return payment;
}

// ---------------------------------------------------------------------------
// 1. createSubscription
// ---------------------------------------------------------------------------

/**
 * Full subscription creation flow.
 * - Validates plan
 * - Applies coupon (if provided)
 * - Creates gateway subscription or one-time order
 * - Creates Subscription document
 * - Updates User.subscription reference
 *
 * @returns {{ success, data: { subscription, payment, checkoutUrl }, error }}
 */
async function createSubscription(userId, planId, gateway = 'razorpay', billingCycle = 'monthly', couponCode = null) {
  const { User, Subscription, Payment, Plan, Coupon } = getModels();
  try {
    // --- validate plan ---
    const plan = await Plan.findById(planId);
    if (!plan) {
      return fail('Plan not found', 'createSubscription');
    }
    if (!plan.isActive) {
      return fail('Plan is not active', 'createSubscription');
    }

    // --- validate user ---
    const user = await User.findById(userId);
    if (!user) {
      return fail('User not found', 'createSubscription');
    }

    // --- determine price ---
    const unitAmount =
      billingCycle === 'yearly'
        ? plan.yearlyPrice || plan.monthlyPrice * 12
        : plan.monthlyPrice;

    // --- apply coupon ---
    let coupon = null;
    let discountAmount = 0;
    let finalAmount = unitAmount;

    if (couponCode) {
      coupon = await Coupon.findOne({
        code: couponCode.toUpperCase(),
        isActive: true,
        $or: [{ expiresAt: { $gte: new Date() } }, { expiresAt: null }],
      });
      if (!coupon) {
        return fail('Invalid or expired coupon code', 'createSubscription');
      }
      if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
        return fail('Coupon usage limit reached', 'createSubscription');
      }
      const computed = computeDiscountedAmount(unitAmount, coupon);
      finalAmount = computed.discountedAmount;
      discountAmount = computed.discountAmount;
    }

    // Razorpay amounts are in smallest unit (paise)
    const amountInPaise = Math.round(finalAmount * 100);

    // --- gateway integration ---
    let gatewaySubscriptionId = null;
    let gatewayOrderId = null;
    let checkoutUrl = null;

    if (gateway === 'razorpay') {
      if (plan.razorpayPlanId && billingCycle === 'monthly') {
        // recurring subscription
        const subResult = await razorpayService.createSubscription(
          plan.razorpayPlanId,
          billingCycle === 'yearly' ? 12 : 1,
          1,
          []
        );
        if (!subResult.success) {
          return fail(`Razorpay subscription creation failed: ${subResult.error}`, 'createSubscription');
        }
        gatewaySubscriptionId = subResult.data.id;
        checkoutUrl = subResult.data.short_url || null;
      } else {
        // one-time order
        const receipt = `sub_${userId.toString().slice(-6)}_${Date.now()}`;
        const orderResult = await razorpayService.createOrder(
          amountInPaise,
          'INR',
          receipt,
          { userId: userId.toString(), planId: planId.toString(), billingCycle }
        );
        if (!orderResult.success) {
          return fail(`Razorpay order creation failed: ${orderResult.error}`, 'createSubscription');
        }
        gatewayOrderId = orderResult.data.id;
      }
    } else if (gateway === 'cashfree') {
      const cfOrderId = `ord_${userId.toString().slice(-6)}_${Date.now()}`;
      const customer = {
        customerId: userId.toString(),
        customerName: user.name || user.email,
        customerEmail: user.email,
        customerPhone: user.phone || '9999999999',
      };
      const orderResult = await cashfreeService.createOrder(
        cfOrderId,
        finalAmount,
        'INR',
        customer,
        process.env.APP_URL ? `${process.env.APP_URL}/payment/return` : 'http://localhost:3000/payment/return',
        process.env.APP_URL ? `${process.env.APP_URL}/webhooks/cashfree` : 'http://localhost:3000/webhooks/cashfree'
      );
      if (!orderResult.success) {
        return fail(`Cashfree order creation failed: ${orderResult.error}`, 'createSubscription');
      }
      gatewayOrderId = orderResult.data.order_id;
      checkoutUrl = orderResult.data.payment_link || null;
    } else {
      return fail(`Unsupported gateway: ${gateway}`, 'createSubscription');
    }

    // --- create Subscription document ---
    const now = new Date();
    const periodEnd = computePeriodEnd(billingCycle);

    const subscription = new Subscription({
      user: userId,
      plan: planId,
      gateway,
      status: 'pending',
      billingCycle,
      amount: finalAmount,
      currency: 'INR',
      discountAmount,
      coupon: coupon ? coupon._id : null,
      gatewaySubscriptionId,
      gatewayOrderId,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      trialEnd: null,
      cancelAtPeriodEnd: false,
      createdAt: now,
    });
    await subscription.save();

    // --- record pending payment ---
    const payment = await recordPayment(
      { User, Payment },
      userId,
      subscription._id,
      finalAmount,
      'INR',
      'pending',
      gateway,
      null,
      gatewayOrderId || gatewaySubscriptionId,
      `Subscription to ${plan.name} (${billingCycle})`,
      { planId: planId.toString(), discountAmount, couponCode }
    );

    // --- update user reference ---
    await User.findByIdAndUpdate(userId, {
      pendingSubscription: subscription._id,
    });

    // --- increment coupon usage ---
    if (coupon) {
      await Coupon.findByIdAndUpdate(coupon._id, { $inc: { usedCount: 1 } });
    }

    logger.info('[SubscriptionService] Subscription created', {
      userId,
      subscriptionId: subscription._id,
      gateway,
      billingCycle,
      amount: finalAmount,
    });

    return ok({ subscription, payment, checkoutUrl });
  } catch (err) {
    return fail(err.message, 'createSubscription', err);
  }
}

// ---------------------------------------------------------------------------
// 2. activateSubscription
// ---------------------------------------------------------------------------

/**
 * Mark subscription as active after successful payment confirmation.
 * Called from webhook handlers.
 */
async function activateSubscription(userId, gatewaySubscriptionId, paymentId, gateway) {
  const { User, Subscription, Payment } = getModels();
  try {
    const query = gatewaySubscriptionId
      ? { $or: [{ gatewaySubscriptionId }, { gatewayOrderId: gatewaySubscriptionId }] }
      : { user: userId, status: 'pending' };

    const subscription = await Subscription.findOne(query).populate('plan');
    if (!subscription) {
      return fail('Subscription not found for activation', 'activateSubscription');
    }

    const now = new Date();
    subscription.status = 'active';
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = computePeriodEnd(subscription.billingCycle);
    subscription.activatedAt = now;
    await subscription.save();

    // update related pending payment
    await Payment.findOneAndUpdate(
      { subscription: subscription._id, status: 'pending' },
      {
        status: 'completed',
        gatewayPaymentId: paymentId,
        paidAt: now,
      }
    );

    // set active subscription on user
    await User.findByIdAndUpdate(userId || subscription.user, {
      subscription: subscription._id,
      subscriptionStatus: 'active',
      $unset: { pendingSubscription: '' },
    });

    // send confirmation email (fire-and-forget)
    const user = await User.findById(userId || subscription.user);
    if (user && subscription.plan) {
      emailService
        .sendSubscriptionConfirmation(user, subscription, subscription.plan)
        .catch((e) => logger.error('[SubscriptionService] Email error', { error: e.message }));
    }

    logger.info('[SubscriptionService] Subscription activated', {
      subscriptionId: subscription._id,
      userId: subscription.user,
    });

    return ok(subscription);
  } catch (err) {
    return fail(err.message, 'activateSubscription', err);
  }
}

// ---------------------------------------------------------------------------
// 3. cancelSubscription
// ---------------------------------------------------------------------------

/**
 * Cancel a user's subscription.
 * @param {boolean} immediate – if true, cancel now; if false, cancel at period end
 */
async function cancelSubscription(userId, reason = '', immediate = false) {
  const { User, Subscription, Payment } = getModels();
  try {
    const subscription = await Subscription.findOne({
      user: userId,
      status: { $in: ['active', 'paused', 'trialing'] },
    });
    if (!subscription) {
      return fail('No active subscription found', 'cancelSubscription');
    }

    // --- cancel on gateway ---
    if (subscription.gatewaySubscriptionId) {
      if (subscription.gateway === 'razorpay') {
        const result = await razorpayService.cancelSubscription(
          subscription.gatewaySubscriptionId,
          !immediate
        );
        if (!result.success) {
          logger.warn('[SubscriptionService] Razorpay cancel warning', { error: result.error });
        }
      } else if (subscription.gateway === 'cashfree') {
        const result = await cashfreeService.cancelSubscription(subscription.gatewaySubscriptionId);
        if (!result.success) {
          logger.warn('[SubscriptionService] Cashfree cancel warning', { error: result.error });
        }
      }
    }

    // --- update DB ---
    if (immediate) {
      subscription.status = 'cancelled';
      subscription.cancelledAt = new Date();
      await User.findByIdAndUpdate(userId, {
        subscriptionStatus: 'cancelled',
        $unset: { subscription: '' },
      });
    } else {
      subscription.cancelAtPeriodEnd = true;
      subscription.cancellationReason = reason;
    }
    await subscription.save();

    // record cancellation event in Payment log
    await recordPayment(
      { User, Payment },
      userId,
      subscription._id,
      0,
      'INR',
      'cancelled',
      subscription.gateway,
      null,
      null,
      `Subscription cancellation: ${reason || 'user requested'}`,
      { immediate }
    );

    // send email
    const user = await User.findById(userId);
    if (user) {
      emailService
        .sendSubscriptionCanceledEmail(user, subscription)
        .catch((e) => logger.error('[SubscriptionService] Email error', { error: e.message }));
    }

    logger.info('[SubscriptionService] Subscription cancelled', {
      subscriptionId: subscription._id,
      userId,
      immediate,
    });

    return ok(subscription);
  } catch (err) {
    return fail(err.message, 'cancelSubscription', err);
  }
}

// ---------------------------------------------------------------------------
// 4. upgradeSubscription
// ---------------------------------------------------------------------------

/**
 * Upgrade to a higher plan immediately with proration.
 */
async function upgradeSubscription(userId, newPlanId, billingCycle) {
  const { User, Subscription, Payment, Plan } = getModels();
  try {
    const [currentSub, newPlan] = await Promise.all([
      Subscription.findOne({ user: userId, status: 'active' }).populate('plan'),
      Plan.findById(newPlanId),
    ]);

    if (!currentSub) return fail('No active subscription found', 'upgradeSubscription');
    if (!newPlan) return fail('New plan not found', 'upgradeSubscription');
    if (!newPlan.isActive) return fail('New plan is not active', 'upgradeSubscription');

    const now = new Date();
    const periodEnd = currentSub.currentPeriodEnd;
    const daysRemaining = Math.max(
      0,
      Math.ceil((periodEnd - now) / (1000 * 60 * 60 * 24))
    );
    const totalDays =
      currentSub.billingCycle === 'yearly' ? 365 : 30;
    const fraction = daysRemaining / totalDays;

    const oldAmount =
      currentSub.billingCycle === 'yearly'
        ? currentSub.plan.yearlyPrice || currentSub.plan.monthlyPrice * 12
        : currentSub.plan.monthlyPrice;
    const newAmount =
      (billingCycle || currentSub.billingCycle) === 'yearly'
        ? newPlan.yearlyPrice || newPlan.monthlyPrice * 12
        : newPlan.monthlyPrice;

    const creditAmount = Math.round(oldAmount * fraction);
    const chargeAmount = Math.max(0, newAmount - creditAmount);

    // cancel existing gateway subscription (end of current billing)
    if (currentSub.gatewaySubscriptionId && currentSub.gateway === 'razorpay') {
      await razorpayService.cancelSubscription(currentSub.gatewaySubscriptionId, false);
    }

    // create new subscription on gateway
    let gatewaySubscriptionId = null;
    let gatewayOrderId = null;

    if (currentSub.gateway === 'razorpay' && newPlan.razorpayPlanId) {
      const subResult = await razorpayService.createSubscription(newPlan.razorpayPlanId, 1, 1, []);
      if (subResult.success) {
        gatewaySubscriptionId = subResult.data.id;
      }
    }

    if (!gatewaySubscriptionId) {
      const receipt = `upg_${userId.toString().slice(-6)}_${Date.now()}`;
      const orderResult = await razorpayService.createOrder(
        Math.round(chargeAmount * 100),
        'INR',
        receipt,
        { userId: userId.toString(), upgrade: true }
      );
      if (orderResult.success) gatewayOrderId = orderResult.data.id;
    }

    // update subscription document
    const newBillingCycle = billingCycle || currentSub.billingCycle;
    currentSub.plan = newPlanId;
    currentSub.billingCycle = newBillingCycle;
    currentSub.amount = newAmount;
    currentSub.gatewaySubscriptionId = gatewaySubscriptionId || currentSub.gatewaySubscriptionId;
    currentSub.gatewayOrderId = gatewayOrderId || null;
    currentSub.currentPeriodEnd = computePeriodEnd(newBillingCycle);
    currentSub.cancelAtPeriodEnd = false;
    await currentSub.save();

    // record payment
    await recordPayment(
      { User, Payment },
      userId,
      currentSub._id,
      chargeAmount,
      'INR',
      'pending',
      currentSub.gateway,
      null,
      gatewayOrderId || gatewaySubscriptionId,
      `Upgrade to ${newPlan.name} (proration: -${creditAmount})`,
      { creditAmount, newPlanId: newPlanId.toString() }
    );

    logger.info('[SubscriptionService] Subscription upgraded', {
      userId,
      subscriptionId: currentSub._id,
      oldPlan: currentSub.plan,
      newPlan: newPlanId,
      chargeAmount,
    });

    return ok({ subscription: currentSub, chargeAmount, creditAmount });
  } catch (err) {
    return fail(err.message, 'upgradeSubscription', err);
  }
}

// ---------------------------------------------------------------------------
// 5. downgradeSubscription
// ---------------------------------------------------------------------------

/**
 * Downgrade to a lower plan at the end of the current billing period.
 */
async function downgradeSubscription(userId, newPlanId) {
  const { Subscription, Plan } = getModels();
  try {
    const [currentSub, newPlan] = await Promise.all([
      Subscription.findOne({ user: userId, status: 'active' }),
      Plan.findById(newPlanId),
    ]);

    if (!currentSub) return fail('No active subscription found', 'downgradeSubscription');
    if (!newPlan) return fail('New plan not found', 'downgradeSubscription');

    // Schedule downgrade for period end
    currentSub.scheduledDowngradePlanId = newPlanId;
    currentSub.cancelAtPeriodEnd = false; // not cancelling, just changing
    await currentSub.save();

    logger.info('[SubscriptionService] Subscription downgrade scheduled', {
      userId,
      subscriptionId: currentSub._id,
      newPlanId,
      effectiveDate: currentSub.currentPeriodEnd,
    });

    return ok({
      subscription: currentSub,
      effectiveDate: currentSub.currentPeriodEnd,
      newPlan,
    });
  } catch (err) {
    return fail(err.message, 'downgradeSubscription', err);
  }
}

// ---------------------------------------------------------------------------
// 6. pauseSubscription
// ---------------------------------------------------------------------------

async function pauseSubscription(userId) {
  const { User, Subscription } = getModels();
  try {
    const subscription = await Subscription.findOne({ user: userId, status: 'active' });
    if (!subscription) return fail('No active subscription found', 'pauseSubscription');

    // pause on gateway
    if (subscription.gatewaySubscriptionId && subscription.gateway === 'razorpay') {
      const result = await razorpayService.pauseSubscription(subscription.gatewaySubscriptionId);
      if (!result.success) {
        return fail(`Razorpay pause failed: ${result.error}`, 'pauseSubscription');
      }
    }

    subscription.status = 'paused';
    subscription.pausedAt = new Date();
    await subscription.save();

    await User.findByIdAndUpdate(userId, { subscriptionStatus: 'paused' });

    logger.info('[SubscriptionService] Subscription paused', {
      userId,
      subscriptionId: subscription._id,
    });

    return ok(subscription);
  } catch (err) {
    return fail(err.message, 'pauseSubscription', err);
  }
}

// ---------------------------------------------------------------------------
// 7. resumeSubscription
// ---------------------------------------------------------------------------

async function resumeSubscription(userId) {
  const { User, Subscription } = getModels();
  try {
    const subscription = await Subscription.findOne({ user: userId, status: 'paused' });
    if (!subscription) return fail('No paused subscription found', 'resumeSubscription');

    // resume on gateway
    if (subscription.gatewaySubscriptionId && subscription.gateway === 'razorpay') {
      const result = await razorpayService.resumeSubscription(subscription.gatewaySubscriptionId);
      if (!result.success) {
        return fail(`Razorpay resume failed: ${result.error}`, 'resumeSubscription');
      }
    }

    subscription.status = 'active';
    subscription.pausedAt = null;
    await subscription.save();

    await User.findByIdAndUpdate(userId, { subscriptionStatus: 'active' });

    logger.info('[SubscriptionService] Subscription resumed', {
      userId,
      subscriptionId: subscription._id,
    });

    return ok(subscription);
  } catch (err) {
    return fail(err.message, 'resumeSubscription', err);
  }
}

// ---------------------------------------------------------------------------
// 8. handleExpiredSubscriptions (cron)
// ---------------------------------------------------------------------------

/**
 * Intended to be called by a scheduled cron job (e.g. daily at midnight).
 * - Expires subscriptions past their period end
 * - Applies scheduled downgrades
 * - Sends trial-ending warnings
 */
async function handleExpiredSubscriptions() {
  const { User, Subscription, Plan } = getModels();
  const now = new Date();
  const results = { expired: 0, downgraded: 0, trialWarnings: 0, errors: [] };

  try {
    // --- expire active subscriptions past period end ---
    const expiredSubs = await Subscription.find({
      status: { $in: ['active', 'paused'] },
      currentPeriodEnd: { $lt: now },
      cancelAtPeriodEnd: { $ne: true }, // those are handled separately
    });

    for (const sub of expiredSubs) {
      try {
        sub.status = 'expired';
        await sub.save();
        await User.findByIdAndUpdate(sub.user, { subscriptionStatus: 'expired' });
        results.expired++;
      } catch (e) {
        results.errors.push({ subscriptionId: sub._id, error: e.message });
      }
    }

    // --- process cancel-at-period-end ---
    const pendingCancels = await Subscription.find({
      status: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: { $lt: now },
    });

    for (const sub of pendingCancels) {
      try {
        sub.status = 'cancelled';
        sub.cancelledAt = now;
        await sub.save();
        await User.findByIdAndUpdate(sub.user, {
          subscriptionStatus: 'cancelled',
          $unset: { subscription: '' },
        });
        results.expired++;
      } catch (e) {
        results.errors.push({ subscriptionId: sub._id, error: e.message });
      }
    }

    // --- process scheduled downgrades at period end ---
    const pendingDowngrades = await Subscription.find({
      status: 'active',
      scheduledDowngradePlanId: { $exists: true, $ne: null },
      currentPeriodEnd: { $lt: now },
    }).populate('user');

    for (const sub of pendingDowngrades) {
      try {
        const newPlan = await Plan.findById(sub.scheduledDowngradePlanId);
        if (!newPlan) continue;
        sub.plan = sub.scheduledDowngradePlanId;
        sub.amount = sub.billingCycle === 'yearly'
          ? newPlan.yearlyPrice || newPlan.monthlyPrice * 12
          : newPlan.monthlyPrice;
        sub.scheduledDowngradePlanId = null;
        sub.currentPeriodStart = now;
        sub.currentPeriodEnd = computePeriodEnd(sub.billingCycle);
        await sub.save();
        results.downgraded++;
      } catch (e) {
        results.errors.push({ subscriptionId: sub._id, error: e.message });
      }
    }

    // --- send trial-ending warnings (3 days before) ---
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const expiringTrials = await Subscription.find({
      status: 'trialing',
      trialEnd: { $gte: now, $lte: threeDaysFromNow },
      trialWarningSent: { $ne: true },
    }).populate('user');

    for (const sub of expiringTrials) {
      try {
        if (!sub.user) continue;
        const daysLeft = Math.ceil((sub.trialEnd - now) / (1000 * 60 * 60 * 24));
        await emailService.sendTrialEndingEmail(sub.user, daysLeft);
        sub.trialWarningSent = true;
        await sub.save();
        results.trialWarnings++;
      } catch (e) {
        results.errors.push({ subscriptionId: sub._id, error: e.message });
      }
    }

    logger.info('[SubscriptionService] handleExpiredSubscriptions complete', results);
    return ok(results);
  } catch (err) {
    return fail(err.message, 'handleExpiredSubscriptions', err);
  }
}

// ---------------------------------------------------------------------------
// 9. handleFailedPayment
// ---------------------------------------------------------------------------

/**
 * Handle a failed payment event (called from webhook).
 * Increments failure count, notifies user, and schedules a retry.
 */
async function handleFailedPayment(userId, reason = 'Payment failed') {
  const { User, Subscription, Payment } = getModels();
  try {
    const subscription = await Subscription.findOne({
      user: userId,
      status: { $in: ['active', 'paused', 'trialing'] },
    });

    if (!subscription) {
      return fail('No active subscription for failed payment', 'handleFailedPayment');
    }

    subscription.paymentFailureCount = (subscription.paymentFailureCount || 0) + 1;
    subscription.lastPaymentFailedAt = new Date();

    const MAX_FAILURES = 3;
    if (subscription.paymentFailureCount >= MAX_FAILURES) {
      subscription.status = 'past_due';
    }
    await subscription.save();

    // record failed payment
    const payment = await recordPayment(
      { User, Payment },
      userId,
      subscription._id,
      subscription.amount,
      'INR',
      'failed',
      subscription.gateway,
      null,
      null,
      `Payment failed: ${reason}`,
      {
        failureCount: subscription.paymentFailureCount,
        reason,
      }
    );

    // notify user
    const user = await User.findById(userId);
    if (user) {
      emailService
        .sendPaymentFailedEmail(user, payment, reason)
        .catch((e) => logger.error('[SubscriptionService] Email error', { error: e.message }));
    }

    // Schedule retry (handled externally by a queue / cron based on retryAfter)
    const retryDelayDays = [1, 3, 5]; // retry on day 1, 3, 5
    const retryAfter = new Date();
    const delayDayIndex = Math.min(subscription.paymentFailureCount - 1, retryDelayDays.length - 1);
    retryAfter.setDate(retryAfter.getDate() + retryDelayDays[delayDayIndex]);
    subscription.retryPaymentAfter = retryAfter;
    await subscription.save();

    logger.warn('[SubscriptionService] Payment failed', {
      userId,
      subscriptionId: subscription._id,
      failureCount: subscription.paymentFailureCount,
      retryAfter,
    });

    return ok({ subscription, payment, retryAfter });
  } catch (err) {
    return fail(err.message, 'handleFailedPayment', err);
  }
}

// ---------------------------------------------------------------------------
// 10. getSubscriptionDetails
// ---------------------------------------------------------------------------

async function getSubscriptionDetails(userId) {
  const { Subscription } = getModels();
  try {
    const subscription = await Subscription.findOne({ user: userId })
      .sort({ createdAt: -1 })
      .populate('plan')
      .populate('coupon')
      .lean();

    if (!subscription) {
      return ok(null);
    }

    return ok(subscription);
  } catch (err) {
    return fail(err.message, 'getSubscriptionDetails', err);
  }
}

// ---------------------------------------------------------------------------
// 11. applyTrial
// ---------------------------------------------------------------------------

/**
 * Start a trial period for a user.
 * @param {number} trialDays – length of trial in days
 */
async function applyTrial(userId, planId, trialDays = 14) {
  const { User, Subscription, Plan } = getModels();
  try {
    const [user, plan] = await Promise.all([
      User.findById(userId),
      Plan.findById(planId),
    ]);

    if (!user) return fail('User not found', 'applyTrial');
    if (!plan) return fail('Plan not found', 'applyTrial');

    // Check if user already had a trial
    const existingTrial = await Subscription.findOne({ user: userId, status: 'trialing' });
    if (existingTrial) {
      return fail('User already has an active trial', 'applyTrial');
    }

    const previousTrial = await Subscription.findOne({ user: userId, trialEnd: { $exists: true } });
    if (previousTrial) {
      return fail('User has already used a trial', 'applyTrial');
    }

    const now = new Date();
    const trialEnd = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

    const subscription = new Subscription({
      user: userId,
      plan: planId,
      gateway: 'none',
      status: 'trialing',
      billingCycle: 'monthly',
      amount: 0,
      currency: 'INR',
      trialEnd,
      trialDays,
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd,
      cancelAtPeriodEnd: false,
      createdAt: now,
    });
    await subscription.save();

    await User.findByIdAndUpdate(userId, {
      subscription: subscription._id,
      subscriptionStatus: 'trialing',
    });

    logger.info('[SubscriptionService] Trial started', {
      userId,
      planId,
      trialDays,
      trialEnd,
    });

    return ok({ subscription, trialEnd, trialDays });
  } catch (err) {
    return fail(err.message, 'applyTrial', err);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  createSubscription,
  activateSubscription,
  cancelSubscription,
  upgradeSubscription,
  downgradeSubscription,
  pauseSubscription,
  resumeSubscription,
  handleExpiredSubscriptions,
  handleFailedPayment,
  getSubscriptionDetails,
  applyTrial,
};
