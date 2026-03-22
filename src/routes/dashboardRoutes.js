'use strict';

/**
 * Dashboard routes — /dashboard/*
 *
 * All routes in this file require the user to be authenticated.
 * The requireAuth middleware from auth.js handles both session-based
 * (Passport) and JWT Bearer token authentication and redirects
 * unauthenticated browser requests to /auth/login.
 */

const express = require('express');
const router  = express.Router();

const dashboardController          = require('../controllers/dashboardController');
const { requireAuth }              = require('../middleware/auth');

// ---------------------------------------------------------------------------
// Global guard — every route in this router requires authentication
// ---------------------------------------------------------------------------
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Dashboard home  →  GET /dashboard
// ---------------------------------------------------------------------------
router.get('/', dashboardController.index);

// ---------------------------------------------------------------------------
// User profile
// ---------------------------------------------------------------------------

/** GET /dashboard/profile — show profile settings page */
router.get('/profile', dashboardController.profile);

/** POST /dashboard/profile — update profile (handles multer avatar upload) */
router.post('/profile', ...dashboardController.updateProfile);

// ---------------------------------------------------------------------------
// Security / password management
// ---------------------------------------------------------------------------

/** GET /dashboard/security — show security settings */
router.get('/security', dashboardController.security);

/** POST /dashboard/security/password — change password */
router.post('/security/password', dashboardController.updatePassword);

// ---------------------------------------------------------------------------
// API key management
// ---------------------------------------------------------------------------

/** GET /dashboard/api-key — view current API key */
router.get('/api-key', dashboardController.apiKey);

/** POST /dashboard/api-key/regenerate — regenerate API key (returns JSON) */
router.post('/api-key/regenerate', dashboardController.regenerateApiKey);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** GET /dashboard/notifications — paginated notification list */
router.get('/notifications', dashboardController.notifications);

module.exports = router;
