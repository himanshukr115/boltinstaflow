'use strict';

const crypto = require('crypto');

const User = require('../models/User');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const Payment = require('../models/Payment');
const AuditLog = require('../models/AuditLog');
const WebhookLog = require('../models/WebhookLog');
const AppSettings = require('../models/AppSettings');
const Automation = require('../models/Automation');
const paymentService = require('../services/paymentService');
const analyticsService = require('../services/analyticsService');
const logger = require('../config/logger');

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Encryption helpers for securely storing gateway credentials in DB
// ---------------------------------------------------------------------------
const ENCRYPTION_ALGO = 'aes-256-gcm';

function encryptValue(plaintext) {
  const key = Buffer.from(process.env.SETTINGS_ENCRYPTION_KEY || '', 'hex');
  if (key.length !== 32) throw new Error('SETTINGS_ENCRYPTION_KEY must be a 64-char hex string (32 bytes).');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptValue(ciphertext) {
  const key = Buffer.from(process.env.SETTINGS_ENCRYPTION_KEY || '', 'hex');
  if (key.length !== 32) throw new Error('SETTINGS_ENCRYPTION_KEY must be a 64-char hex string.');
  const [ivHex, authTagHex, encHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encryptedData = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encryptedData) + decipher.final('utf8');
}

// ---------------------------------------------------------------------------
// dashboard  (GET /admin)
// ---------------------------------------------------------------------------
const dashboard = async (req, res, next) => {
  try {
    const [
      totalUsers,
      activeSubscriptions,
      failedPayments,
      totalAutomations,
      mrr,
      recentSignups,
      systemHealth,
    ] = await Promise.all([
      User.countDocuments({ isSuspended: false }),
      Subscription.countDocuments({ status: { $in: ['active', 'trialing'] } }),
      Payment.countDocuments({ status: 'failed', createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }),
      Automation.countDocuments({ status: { $ne: 'archived' } }),
      analyticsService.calculateMRR(),
      User.find({}).sort({ createdAt: -1 }).limit(5).lean(),
      analyticsService.getSystemHealth(),
    ]);

    return res.render('admin/dashboard', {
      title: 'Admin Dashboard',
      stats: {
        totalUsers,
        activeSubscriptions,
        failedPayments,
        totalAutomations,
        mrr,
      },
      recentSignups,
      systemHealth,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Admin dashboard error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// users  (GET /admin/users)
// ---------------------------------------------------------------------------
const users = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * PAGE_SIZE;
    const search = req.query.search ? req.query.search.trim() : '';
    const planFilter = req.query.plan || '';
    const statusFilter = req.query.status || '';

    const query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }
    if (statusFilter === 'suspended') query.isSuspended = true;
    if (statusFilter === 'active') query.isSuspended = false;
    if (statusFilter === 'unverified') query.isEmailVerified = false;

    let userDocs;
    let total;
    if (planFilter) {
      // Join with subscriptions to filter by plan
      const subs = await Subscription.find({ status: 'active' })
        .populate('planId')
        .lean();
      const filteredSubs = subs.filter((s) => s.planId && s.planId.slug === planFilter);
      const userIds = filteredSubs.map((s) => s.userId);
      query._id = { $in: userIds };
    }

    [userDocs, total] = await Promise.all([
      User.find(query).sort({ createdAt: -1 }).skip(skip).limit(PAGE_SIZE).lean(),
      User.countDocuments(query),
    ]);

    // Attach active subscriptions to each user
    const userIds2 = userDocs.map((u) => u._id);
    const activeSubs = await Subscription.find({ userId: { $in: userIds2 }, status: { $in: ['active', 'trialing'] } })
      .populate('planId', 'name slug')
      .lean();
    const subMap = {};
    activeSubs.forEach((s) => { subMap[String(s.userId)] = s; });
    userDocs = userDocs.map((u) => ({ ...u, subscription: subMap[String(u._id)] || null }));

    return res.render('admin/users', {
      title: 'Users',
      users: userDocs,
      currentPage: page,
      totalPages: Math.ceil(total / PAGE_SIZE),
      total,
      search,
      planFilter,
      statusFilter,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Admin users error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// showUser  (GET /admin/users/:id)
// ---------------------------------------------------------------------------
const showUser = async (req, res, next) => {
  try {
    const targetUser = await User.findById(req.params.id).lean();
    if (!targetUser) {
      req.flash('error', 'User not found.');
      return res.redirect('/admin/users');
    }

    const [subscription, payments, recentActivity] = await Promise.all([
      Subscription.findOne({ userId: targetUser._id }).populate('planId').sort({ createdAt: -1 }).lean(),
      Payment.find({ userId: targetUser._id }).sort({ createdAt: -1 }).limit(10).lean(),
      AuditLog.find({ userId: targetUser._id }).sort({ createdAt: -1 }).limit(20).lean(),
    ]);

    return res.render('admin/show-user', {
      title: `User – ${targetUser.name}`,
      targetUser,
      subscription,
      payments,
      recentActivity,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// updateUser  (POST /admin/users/:id)
// ---------------------------------------------------------------------------
const updateUser = async (req, res, next) => {
  try {
    const { name, email, role, isEmailVerified } = req.body;
    const allowedRoles = ['user', 'admin'];

    const updates = {};
    if (name) updates.name = name.trim().substring(0, 100);
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) updates.email = email.toLowerCase().trim();
    if (role && allowedRoles.includes(role)) updates.role = role;
    if (isEmailVerified !== undefined) updates.isEmailVerified = isEmailVerified === 'true';

    await User.findByIdAndUpdate(req.params.id, updates);

    await AuditLog.create({
      userId: req.user._id,
      action: 'admin.userUpdated',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { targetUserId: req.params.id, updates },
    });

    req.flash('success', 'User updated.');
    return res.redirect(`/admin/users/${req.params.id}`);
  } catch (err) {
    logger.error('Admin update user error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// suspendUser  (POST /admin/users/:id/suspend)
// ---------------------------------------------------------------------------
const suspendUser = async (req, res, next) => {
  try {
    const targetUser = await User.findByIdAndUpdate(
      req.params.id,
      { isSuspended: true, suspendedAt: new Date(), suspendedBy: req.user._id },
      { new: true },
    );
    if (!targetUser) {
      req.flash('error', 'User not found.');
      return res.redirect('/admin/users');
    }

    await AuditLog.create({
      userId: req.user._id,
      action: 'admin.userSuspended',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { targetUserId: req.params.id, email: targetUser.email },
    });

    req.flash('success', `User ${targetUser.email} suspended.`);
    return res.redirect(`/admin/users/${req.params.id}`);
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// unsuspendUser  (POST /admin/users/:id/unsuspend)
// ---------------------------------------------------------------------------
const unsuspendUser = async (req, res, next) => {
  try {
    const targetUser = await User.findByIdAndUpdate(
      req.params.id,
      { isSuspended: false, $unset: { suspendedAt: '', suspendedBy: '' } },
      { new: true },
    );
    if (!targetUser) {
      req.flash('error', 'User not found.');
      return res.redirect('/admin/users');
    }

    await AuditLog.create({
      userId: req.user._id,
      action: 'admin.userUnsuspended',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { targetUserId: req.params.id },
    });

    req.flash('success', `User ${targetUser.email} unsuspended.`);
    return res.redirect(`/admin/users/${req.params.id}`);
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// assignPlan  (POST /admin/users/:id/assign-plan)
// ---------------------------------------------------------------------------
const assignPlan = async (req, res, next) => {
  const { planId, expiresAt } = req.body;
  if (!planId) {
    req.flash('error', 'Plan ID is required.');
    return res.redirect(`/admin/users/${req.params.id}`);
  }

  try {
    const plan = await Plan.findById(planId);
    if (!plan) {
      req.flash('error', 'Plan not found.');
      return res.redirect(`/admin/users/${req.params.id}`);
    }

    // Upsert subscription bypassing payment
    await Subscription.findOneAndUpdate(
      { userId: req.params.id },
      {
        userId: req.params.id,
        planId: plan._id,
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: expiresAt ? new Date(expiresAt) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        assignedByAdmin: true,
        assignedBy: req.user._id,
        gateway: 'manual',
      },
      { upsert: true, new: true },
    );

    await AuditLog.create({
      userId: req.user._id,
      action: 'admin.planAssigned',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { targetUserId: req.params.id, planId, planName: plan.name },
    });

    req.flash('success', `Plan "${plan.name}" assigned to user.`);
    return res.redirect(`/admin/users/${req.params.id}`);
  } catch (err) {
    logger.error('Admin assign plan error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// plans  (GET /admin/plans)
// ---------------------------------------------------------------------------
const plans = async (req, res, next) => {
  try {
    const planList = await Plan.find({}).sort({ sortOrder: 1 }).lean();
    return res.render('admin/plans', {
      title: 'Subscription Plans',
      plans: planList,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// createPlan / storePlan  (GET + POST /admin/plans/create)
// ---------------------------------------------------------------------------
const createPlan = (req, res) => {
  return res.render('admin/create-plan', {
    title: 'Create Plan',
    formData: {},
    errors: [],
    user: req.user,
    error: req.flash('error'),
    success: req.flash('success'),
  });
};

const storePlan = async (req, res, next) => {
  const { name, slug, price, currency, billingCycle, features, limits, sortOrder } = req.body;

  if (!name || !price || !billingCycle) {
    req.flash('error', 'Name, price, and billing cycle are required.');
    return res.redirect('/admin/plans/create');
  }

  try {
    const plan = await Plan.create({
      name: name.trim(),
      slug: slug ? slug.trim() : name.toLowerCase().replace(/\s+/g, '-'),
      price: parseFloat(price),
      currency: currency || 'INR',
      billingCycle,
      features: typeof features === 'string' ? features.split('\n').map((f) => f.trim()).filter(Boolean) : [],
      limits: limits || {},
      sortOrder: sortOrder ? parseInt(sortOrder, 10) : 999,
      isActive: false,
    });

    await AuditLog.create({
      userId: req.user._id,
      action: 'admin.planCreated',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { planId: plan._id, name: plan.name },
    });

    req.flash('success', `Plan "${plan.name}" created.`);
    return res.redirect('/admin/plans');
  } catch (err) {
    logger.error('Admin store plan error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// editPlan / updatePlan  (GET + PUT /admin/plans/:id)
// ---------------------------------------------------------------------------
const editPlan = async (req, res, next) => {
  try {
    const plan = await Plan.findById(req.params.id).lean();
    if (!plan) {
      req.flash('error', 'Plan not found.');
      return res.redirect('/admin/plans');
    }
    return res.render('admin/edit-plan', {
      title: `Edit Plan – ${plan.name}`,
      plan,
      formData: plan,
      errors: [],
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

const updatePlan = async (req, res, next) => {
  const { name, price, currency, billingCycle, features, limits, sortOrder } = req.body;

  try {
    const plan = await Plan.findByIdAndUpdate(
      req.params.id,
      {
        name: name ? name.trim() : undefined,
        price: price ? parseFloat(price) : undefined,
        currency: currency || 'INR',
        billingCycle,
        features: typeof features === 'string' ? features.split('\n').map((f) => f.trim()).filter(Boolean) : undefined,
        limits: limits || undefined,
        sortOrder: sortOrder ? parseInt(sortOrder, 10) : undefined,
      },
      { new: true },
    );
    if (!plan) {
      req.flash('error', 'Plan not found.');
      return res.redirect('/admin/plans');
    }

    req.flash('success', 'Plan updated.');
    return res.redirect('/admin/plans');
  } catch (err) {
    logger.error('Admin update plan error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// togglePlanStatus  (POST /admin/plans/:id/toggle)  → JSON
// ---------------------------------------------------------------------------
const togglePlanStatus = async (req, res, next) => {
  try {
    const plan = await Plan.findById(req.params.id);
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found.' });
    plan.isActive = !plan.isActive;
    await plan.save();
    return res.json({ success: true, isActive: plan.isActive });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// deletePlan  (DELETE /admin/plans/:id)
// ---------------------------------------------------------------------------
const deletePlan = async (req, res, next) => {
  try {
    const plan = await Plan.findById(req.params.id);
    if (!plan) {
      req.flash('error', 'Plan not found.');
      return res.redirect('/admin/plans');
    }

    const activeSubCount = await Subscription.countDocuments({ planId: plan._id, status: 'active' });
    if (activeSubCount > 0) {
      req.flash('error', `Cannot delete plan with ${activeSubCount} active subscriptions.`);
      return res.redirect('/admin/plans');
    }

    await plan.deleteOne();
    req.flash('success', `Plan "${plan.name}" deleted.`);
    return res.redirect('/admin/plans');
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// reorderPlans  (POST /admin/plans/reorder)  → JSON
// ---------------------------------------------------------------------------
const reorderPlans = async (req, res, next) => {
  const { order } = req.body; // Array of { id, sortOrder }
  if (!Array.isArray(order)) {
    return res.status(400).json({ success: false, message: 'Order must be an array.' });
  }

  try {
    await Promise.all(
      order.map(({ id, sortOrder }) =>
        Plan.findByIdAndUpdate(id, { sortOrder: parseInt(sortOrder, 10) || 0 }),
      ),
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error('Reorder plans error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// payments  (GET /admin/payments)
// ---------------------------------------------------------------------------
const payments = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * PAGE_SIZE;
    const statusFilter = req.query.status || '';
    const gatewayFilter = req.query.gateway || '';
    const search = req.query.search ? req.query.search.trim() : '';

    const query = {};
    if (statusFilter) query.status = statusFilter;
    if (gatewayFilter) query.gateway = gatewayFilter;
    if (search) {
      query.$or = [
        { orderId: { $regex: search, $options: 'i' } },
        { paymentId: { $regex: search, $options: 'i' } },
      ];
    }

    const [paymentList, total] = await Promise.all([
      Payment.find(query)
        .populate('userId', 'name email')
        .populate('planId', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(PAGE_SIZE)
        .lean(),
      Payment.countDocuments(query),
    ]);

    return res.render('admin/payments', {
      title: 'Payment History',
      payments: paymentList,
      currentPage: page,
      totalPages: Math.ceil(total / PAGE_SIZE),
      total,
      statusFilter,
      gatewayFilter,
      search,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// showPayment  (GET /admin/payments/:id)
// ---------------------------------------------------------------------------
const showPayment = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id)
      .populate('userId', 'name email')
      .populate('planId', 'name')
      .lean();

    if (!payment) {
      req.flash('error', 'Payment not found.');
      return res.redirect('/admin/payments');
    }

    return res.render('admin/show-payment', {
      title: `Payment – ${payment.orderId}`,
      payment,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// refundPayment  (POST /admin/payments/:id/refund)  → JSON
// ---------------------------------------------------------------------------
const refundPayment = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });
    if (payment.status !== 'captured') {
      return res.status(400).json({ success: false, message: 'Only captured payments can be refunded.' });
    }

    const refundResult = await paymentService.initiateRefund(payment);

    payment.status = 'refunded';
    payment.refundId = refundResult.id;
    payment.refundedAt = new Date();
    payment.refundedBy = req.user._id;
    await payment.save();

    await AuditLog.create({
      userId: req.user._id,
      action: 'admin.paymentRefunded',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { paymentId: payment._id, orderId: payment.orderId, refundId: refundResult.id },
    });

    return res.json({ success: true, refundId: refundResult.id });
  } catch (err) {
    logger.error('Admin refund error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// subscriptions  (GET /admin/subscriptions)
// ---------------------------------------------------------------------------
const subscriptions = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * PAGE_SIZE;
    const statusFilter = req.query.status || '';
    const planFilter = req.query.plan || '';

    const query = {};
    if (statusFilter) query.status = statusFilter;
    if (planFilter) {
      const planDoc = await Plan.findOne({ slug: planFilter }).lean();
      if (planDoc) query.planId = planDoc._id;
    }

    const [subList, total] = await Promise.all([
      Subscription.find(query)
        .populate('userId', 'name email')
        .populate('planId', 'name slug')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(PAGE_SIZE)
        .lean(),
      Subscription.countDocuments(query),
    ]);

    return res.render('admin/subscriptions', {
      title: 'Subscriptions',
      subscriptions: subList,
      currentPage: page,
      totalPages: Math.ceil(total / PAGE_SIZE),
      total,
      statusFilter,
      planFilter,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// showSubscription  (GET /admin/subscriptions/:id)
// ---------------------------------------------------------------------------
const showSubscription = async (req, res, next) => {
  try {
    const sub = await Subscription.findById(req.params.id)
      .populate('userId', 'name email')
      .populate('planId')
      .lean();

    if (!sub) {
      req.flash('error', 'Subscription not found.');
      return res.redirect('/admin/subscriptions');
    }

    const relatedPayments = await Payment.find({ userId: sub.userId }).sort({ createdAt: -1 }).limit(10).lean();

    return res.render('admin/show-subscription', {
      title: `Subscription Detail`,
      subscription: sub,
      relatedPayments,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// settings  (GET /admin/settings)
// ---------------------------------------------------------------------------
const settings = async (req, res, next) => {
  try {
    const appSettings = await AppSettings.findOne({ key: 'gateway' }).lean();
    // Never expose actual secrets to the view — only show masked placeholders
    const maskedSettings = appSettings && appSettings.value
      ? {
          razorpay: {
            keyId: appSettings.value.razorpay && appSettings.value.razorpay.keyId
              ? '••••••••' + (appSettings.value.razorpay.keyId.slice(-4) || '')
              : '',
            configured: !!(appSettings.value.razorpay && appSettings.value.razorpay.keyId),
          },
          cashfree: {
            appId: appSettings.value.cashfree && appSettings.value.cashfree.appId
              ? '••••••••' + (appSettings.value.cashfree.appId.slice(-4) || '')
              : '',
            configured: !!(appSettings.value.cashfree && appSettings.value.cashfree.appId),
          },
        }
      : { razorpay: { configured: false }, cashfree: { configured: false } };

    return res.render('admin/settings', {
      title: 'Gateway Settings',
      maskedSettings,
      user: req.user,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// updateSettings  (POST /admin/settings)
// ---------------------------------------------------------------------------
const updateSettings = async (req, res, next) => {
  const {
    razorpayKeyId,
    razorpayKeySecret,
    razorpayWebhookSecret,
    cashfreeAppId,
    cashfreeSecretKey,
    cashfreeWebhookSecret,
  } = req.body;

  try {
    const existing = await AppSettings.findOne({ key: 'gateway' });
    const existingValue = existing && existing.value ? existing.value : {};

    const newValue = { ...existingValue };

    // Only update provided fields; encrypt secrets
    if (razorpayKeyId) {
      newValue.razorpay = {
        ...(newValue.razorpay || {}),
        keyId: razorpayKeyId.trim(),
      };
    }
    if (razorpayKeySecret) {
      newValue.razorpay = {
        ...(newValue.razorpay || {}),
        keySecret: encryptValue(razorpayKeySecret.trim()),
      };
    }
    if (razorpayWebhookSecret) {
      newValue.razorpay = {
        ...(newValue.razorpay || {}),
        webhookSecret: encryptValue(razorpayWebhookSecret.trim()),
      };
    }
    if (cashfreeAppId) {
      newValue.cashfree = {
        ...(newValue.cashfree || {}),
        appId: cashfreeAppId.trim(),
      };
    }
    if (cashfreeSecretKey) {
      newValue.cashfree = {
        ...(newValue.cashfree || {}),
        secretKey: encryptValue(cashfreeSecretKey.trim()),
      };
    }
    if (cashfreeWebhookSecret) {
      newValue.cashfree = {
        ...(newValue.cashfree || {}),
        webhookSecret: encryptValue(cashfreeWebhookSecret.trim()),
      };
    }

    await AppSettings.findOneAndUpdate(
      { key: 'gateway' },
      { key: 'gateway', value: newValue, updatedBy: req.user._id },
      { upsert: true },
    );

    await AuditLog.create({
      userId: req.user._id,
      action: 'admin.settingsUpdated',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { settingsKey: 'gateway' },
    });

    req.flash('success', 'Gateway settings updated successfully.');
    return res.redirect('/admin/settings');
  } catch (err) {
    logger.error('Admin update settings error', { error: err.message });
    req.flash('error', 'Failed to save settings. Check encryption key configuration.');
    return res.redirect('/admin/settings');
  }
};

// ---------------------------------------------------------------------------
// auditLogs  (GET /admin/audit-logs)
// ---------------------------------------------------------------------------
const auditLogs = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * PAGE_SIZE;
    const actionFilter = req.query.action || '';
    const search = req.query.search ? req.query.search.trim() : '';

    const query = {};
    if (actionFilter) query.action = { $regex: `^${actionFilter}`, $options: 'i' };
    if (search) {
      // Search by user email via a join – simplified: find users first
      const matchingUsers = await User.find({
        email: { $regex: search, $options: 'i' },
      }).select('_id').lean();
      query.userId = { $in: matchingUsers.map((u) => u._id) };
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .populate('userId', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(PAGE_SIZE)
        .lean(),
      AuditLog.countDocuments(query),
    ]);

    return res.render('admin/audit-logs', {
      title: 'Audit Logs',
      logs,
      currentPage: page,
      totalPages: Math.ceil(total / PAGE_SIZE),
      total,
      actionFilter,
      search,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// analytics  (GET /admin/analytics)
// ---------------------------------------------------------------------------
const analytics = async (req, res, next) => {
  try {
    const period = req.query.period || '30d';

    const [
      revenueChart,
      userGrowthChart,
      planDistribution,
      topCountries,
      churnRate,
    ] = await Promise.all([
      analyticsService.getRevenueChartData(period),
      analyticsService.getUserGrowthData(period),
      analyticsService.getPlanDistribution(),
      analyticsService.getTopCountries(),
      analyticsService.getChurnRate(period),
    ]);

    return res.render('admin/analytics', {
      title: 'Analytics',
      period,
      revenueChart,
      userGrowthChart,
      planDistribution,
      topCountries,
      churnRate,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Admin analytics error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// webhookLogs  (GET /admin/webhook-logs)
// ---------------------------------------------------------------------------
const webhookLogs = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * PAGE_SIZE;
    const gatewayFilter = req.query.gateway || '';
    const statusFilter = req.query.status || '';

    const query = {};
    if (gatewayFilter) query.gateway = gatewayFilter;
    if (statusFilter) query.status = statusFilter;

    const [logs, total] = await Promise.all([
      WebhookLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(PAGE_SIZE).lean(),
      WebhookLog.countDocuments(query),
    ]);

    return res.render('admin/webhook-logs', {
      title: 'Webhook Logs',
      logs,
      currentPage: page,
      totalPages: Math.ceil(total / PAGE_SIZE),
      total,
      gatewayFilter,
      statusFilter,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  dashboard,
  users,
  showUser,
  updateUser,
  suspendUser,
  unsuspendUser,
  assignPlan,
  plans,
  createPlan,
  storePlan,
  editPlan,
  updatePlan,
  togglePlanStatus,
  deletePlan,
  reorderPlans,
  payments,
  showPayment,
  refundPayment,
  subscriptions,
  showSubscription,
  settings,
  updateSettings,
  auditLogs,
  analytics,
  webhookLogs,
};
