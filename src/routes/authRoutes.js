'use strict';

/**
 * Auth routes — /auth/*
 *
 * Public-facing authentication routes. Login and register show pages are
 * protected by requireGuest so already-authenticated users are bounced back
 * to the dashboard. Rate limiting via authLimiter / strictLimiter is applied
 * to brute-force-sensitive POST endpoints.
 */

const express = require('express');
const router  = express.Router();

const authController                   = require('../controllers/authController');
const { requireAuth }                  = require('../middleware/auth');
const { requireGuest }                 = require('../middleware/authMiddleware');
const { authLimiter, strictLimiter }   = require('../middleware/rateLimiter');

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/** GET /auth/login — show login form (guests only) */
router.get('/login', requireGuest, authController.showLogin);

/** POST /auth/login — process credentials */
router.post('/login', requireGuest, authLimiter, authController.login);

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

/** GET /auth/register — show registration form (guests only) */
router.get('/register', requireGuest, authController.showRegister);

/** POST /auth/register — process new account creation */
router.post('/register', requireGuest, authLimiter, ...authController.register);

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

/** POST /auth/logout — destroy session and redirect home */
router.post('/logout', authController.logout);

/** GET /auth/logout — convenience alias for link-based logout */
router.get('/logout', authController.logout);

// ---------------------------------------------------------------------------
// Forgot / reset password
// ---------------------------------------------------------------------------

/** GET /auth/forgot-password — show forgot-password form */
router.get('/forgot-password', authController.showForgotPassword);

/** POST /auth/forgot-password — send reset email */
router.post('/forgot-password', authLimiter, authController.forgotPassword);

/** GET /auth/reset-password/:token — show reset form */
router.get('/reset-password/:token', authController.showResetPassword);

/** POST /auth/reset-password/:token — apply new password */
router.post('/reset-password/:token', authLimiter, authController.resetPassword);

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

/** GET /auth/verify-email/:token — verify email address via link */
router.get('/verify-email/:token', authController.verifyEmail);

/** POST /auth/resend-verification — resend verification email (authenticated) */
router.post(
  '/resend-verification',
  requireAuth,
  strictLimiter,
  authController.resendVerification,
);

// ---------------------------------------------------------------------------
// Two-factor authentication setup
// ---------------------------------------------------------------------------

/** GET /auth/2fa/setup — show TOTP setup page (authenticated) */
router.get('/2fa/setup', requireAuth, authController.showTwoFactor);

/** POST /auth/2fa/setup — enable TOTP (authenticated) */
router.post('/2fa/setup', requireAuth, authController.setupTwoFactor);

module.exports = router;
