'use strict';

const express = require('express');
const router = express.Router();

// ---------------------------------------------------------------------------
// Sub-router imports
// ---------------------------------------------------------------------------
const authRoutes         = require('./authRoutes');
const dashboardRoutes    = require('./dashboardRoutes');
const instagramRoutes    = require('./instagramRoutes');
const automationRoutes   = require('./automationRoutes');
const campaignRoutes     = require('./campaignRoutes');
const contactRoutes      = require('./contactRoutes');
const linkPageRoutes     = require('./linkPageRoutes');
const subscriptionRoutes = require('./subscriptionRoutes');
const adminRoutes        = require('./adminRoutes');
const apiRoutes          = require('./apiRoutes');
const webhookRoutes      = require('./webhookRoutes');

// ---------------------------------------------------------------------------
// Public home page
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/dashboard');
  return res.render('home', {
    title: 'InstaFlow - Instagram Automation SaaS',
    layout: 'layouts/public',
  });
});

// ---------------------------------------------------------------------------
// Auth  →  /auth/*
// ---------------------------------------------------------------------------
router.use('/auth', authRoutes);

// ---------------------------------------------------------------------------
// Dashboard  →  /dashboard
// ---------------------------------------------------------------------------
router.use('/dashboard', dashboardRoutes);

// ---------------------------------------------------------------------------
// Instagram accounts  →  /dashboard/instagram
// ---------------------------------------------------------------------------
router.use('/dashboard/instagram', instagramRoutes);

// ---------------------------------------------------------------------------
// Automations  →  /dashboard/automations
// ---------------------------------------------------------------------------
router.use('/dashboard/automations', automationRoutes);

// ---------------------------------------------------------------------------
// Campaigns  →  /dashboard/campaigns
// ---------------------------------------------------------------------------
router.use('/dashboard/campaigns', campaignRoutes);

// ---------------------------------------------------------------------------
// Contacts  →  /dashboard/contacts
// ---------------------------------------------------------------------------
router.use('/dashboard/contacts', contactRoutes);

// ---------------------------------------------------------------------------
// Link-in-bio pages  →  /dashboard/link-pages  (dashboard management)
// Public link page view  →  /p/:slug
// ---------------------------------------------------------------------------
router.use('/dashboard/link-pages', linkPageRoutes);
router.use('/p', linkPageRoutes);

// ---------------------------------------------------------------------------
// Subscription / billing  →  /subscription
// Convenience alias: /pricing
// ---------------------------------------------------------------------------
router.use('/subscription', subscriptionRoutes);
router.get('/pricing', (req, res, next) => {
  req.url = '/pricing';
  subscriptionRoutes(req, res, next);
});

// ---------------------------------------------------------------------------
// Admin  →  /admin
// ---------------------------------------------------------------------------
router.use('/admin', adminRoutes);

// ---------------------------------------------------------------------------
// REST API  →  /api/v1
// ---------------------------------------------------------------------------
router.use('/api/v1', apiRoutes);

// ---------------------------------------------------------------------------
// Webhooks  →  /webhooks  (CSRF excluded at route level)
// ---------------------------------------------------------------------------
router.use('/webhooks', webhookRoutes);

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------
router.use((req, res) => {
  return res.status(404).render('errors/404', {
    title: 'Page Not Found',
    user: req.user || null,
  });
});

module.exports = router;
