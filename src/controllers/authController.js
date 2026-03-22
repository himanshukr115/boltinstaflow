'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');

const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const emailService = require('../services/emailService');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Helper – generate a cryptographically-random hex token and return both the
// raw token (sent in the email) and its SHA-256 hash (stored in the DB).
// ---------------------------------------------------------------------------
function generateToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

// ---------------------------------------------------------------------------
// Minimal TOTP implementation (RFC 6238) – avoids the need for speakeasy.
// Uses HMAC-SHA1 over the current 30-second window counter.
// ---------------------------------------------------------------------------
function generateTotpSecret() {
  // 20 random bytes → base32-encoded secret for authenticator apps
  const bytes = crypto.randomBytes(20);
  const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      secret += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    secret += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  return secret;
}

function base32Decode(encoded) {
  const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const output = [];
  const str = encoded.toUpperCase().replace(/=+$/, '');
  for (let i = 0; i < str.length; i++) {
    const idx = BASE32_CHARS.indexOf(str[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function verifyTotp(secret, token) {
  const key = base32Decode(secret);
  const now = Math.floor(Date.now() / 1000 / 30);
  // Accept current window ±1 for clock skew
  for (let delta = -1; delta <= 1; delta++) {
    const counter = now + delta;
    const buf = Buffer.alloc(8);
    // Write 64-bit big-endian counter
    buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[19] & 0x0f;
    const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000)
      .toString()
      .padStart(6, '0');
    if (code === String(token)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// showLogin
// ---------------------------------------------------------------------------
const showLogin = (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.render('auth/login', {
    title: 'Sign In',
    csrfToken: req.csrfToken ? req.csrfToken() : '',
    error: req.flash('error'),
    success: req.flash('success'),
  });
};

// ---------------------------------------------------------------------------
// login  (POST /auth/login)
// ---------------------------------------------------------------------------
const login = (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      req.flash('error', info && info.message ? info.message : 'Invalid credentials.');
      return res.redirect('/auth/login');
    }
    if (user.isSuspended) {
      req.flash('error', 'Your account has been suspended. Please contact support.');
      return res.redirect('/auth/login');
    }
    req.logIn(user, async (loginErr) => {
      if (loginErr) return next(loginErr);
      try {
        user.lastLoginAt = new Date();
        user.lastLoginIp = req.ip;
        await user.save();
        await AuditLog.create({
          userId: user._id,
          action: 'user.login',
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          meta: {},
        });
      } catch (auditErr) {
        logger.warn('Failed to record login audit', { error: auditErr.message });
      }
      const redirectTo = req.session.returnTo || '/dashboard';
      delete req.session.returnTo;
      return res.redirect(redirectTo);
    });
  })(req, res, next);
};

// ---------------------------------------------------------------------------
// showRegister
// ---------------------------------------------------------------------------
const showRegister = (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.render('auth/register', {
    title: 'Create Account',
    csrfToken: req.csrfToken ? req.csrfToken() : '',
    errors: [],
    formData: {},
    error: req.flash('error'),
    success: req.flash('success'),
  });
};

// ---------------------------------------------------------------------------
// register  (POST /auth/register)
// ---------------------------------------------------------------------------
const registerValidators = [
  body('name').trim().notEmpty().withMessage('Name is required.').isLength({ max: 100 }),
  body('email').trim().isEmail().withMessage('A valid email is required.').normalizeEmail(),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters.')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter.')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number.'),
  body('confirmPassword').custom((value, { req: r }) => {
    if (value !== r.body.password) throw new Error('Passwords do not match.');
    return true;
  }),
];

const register = [
  ...registerValidators,
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('auth/register', {
        title: 'Create Account',
        csrfToken: req.csrfToken ? req.csrfToken() : '',
        errors: errors.array(),
        formData: { name: req.body.name, email: req.body.email },
        error: [],
        success: [],
      });
    }

    try {
      const { name, email, password } = req.body;

      const existing = await User.findOne({ email });
      if (existing) {
        return res.render('auth/register', {
          title: 'Create Account',
          csrfToken: req.csrfToken ? req.csrfToken() : '',
          errors: [{ msg: 'An account with that email already exists.' }],
          formData: { name, email },
          error: [],
          success: [],
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const { raw: emailVerifyToken, hash: emailVerifyHash } = generateToken();

      const user = await User.create({
        name,
        email,
        passwordHash,
        emailVerifyToken: emailVerifyHash,
        emailVerifyExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
        isEmailVerified: false,
        apiKey: uuidv4(),
      });

      // Send welcome + verification email asynchronously (do not await)
      emailService
        .sendWelcomeEmail(user, emailVerifyToken)
        .catch((err) => logger.error('Welcome email failed', { error: err.message, userId: user._id }));

      // Audit log
      await AuditLog.create({
        userId: user._id,
        action: 'user.register',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { email },
      });

      // Auto-login after registration
      req.logIn(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        req.flash('success', 'Welcome! Please verify your email address.');
        return res.redirect('/dashboard');
      });
    } catch (err) {
      logger.error('Registration error', { error: err.message });
      return next(err);
    }
  },
];

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------
const logout = (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy((destroyErr) => {
      if (destroyErr) logger.warn('Session destroy failed', { error: destroyErr.message });
      res.clearCookie('connect.sid');
      res.redirect('/');
    });
  });
};

// ---------------------------------------------------------------------------
// showForgotPassword
// ---------------------------------------------------------------------------
const showForgotPassword = (req, res) => {
  res.render('auth/forgot-password', {
    title: 'Forgot Password',
    csrfToken: req.csrfToken ? req.csrfToken() : '',
    error: req.flash('error'),
    success: req.flash('success'),
  });
};

// ---------------------------------------------------------------------------
// forgotPassword  (POST /auth/forgot-password)
// ---------------------------------------------------------------------------
const forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.flash('error', 'Please enter a valid email address.');
    return res.redirect('/auth/forgot-password');
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase().trim() });

    // Always show success to prevent email enumeration
    if (!user) {
      req.flash('success', 'If that email exists, a reset link has been sent.');
      return res.redirect('/auth/forgot-password');
    }

    const { raw, hash } = generateToken();
    user.resetPasswordToken = hash;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    await emailService.sendPasswordResetEmail(user, raw);

    req.flash('success', 'A password reset link has been sent to your email.');
    return res.redirect('/auth/forgot-password');
  } catch (err) {
    logger.error('Forgot password error', { error: err.message });
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/auth/forgot-password');
  }
};

// ---------------------------------------------------------------------------
// showResetPassword  (GET /auth/reset-password/:token)
// ---------------------------------------------------------------------------
const showResetPassword = async (req, res) => {
  const { token } = req.params;
  if (!token) {
    req.flash('error', 'Invalid or missing reset token.');
    return res.redirect('/auth/forgot-password');
  }

  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      resetPasswordToken: hash,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      req.flash('error', 'This password reset link is invalid or has expired.');
      return res.redirect('/auth/forgot-password');
    }

    return res.render('auth/reset-password', {
      title: 'Reset Password',
      csrfToken: req.csrfToken ? req.csrfToken() : '',
      token,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Show reset password error', { error: err.message });
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/auth/forgot-password');
  }
};

// ---------------------------------------------------------------------------
// resetPassword  (POST /auth/reset-password/:token)
// ---------------------------------------------------------------------------
const resetPassword = async (req, res) => {
  const { token } = req.params;
  const { password, confirmPassword } = req.body;

  if (!password || password.length < 8) {
    req.flash('error', 'Password must be at least 8 characters.');
    return res.redirect(`/auth/reset-password/${token}`);
  }
  if (password !== confirmPassword) {
    req.flash('error', 'Passwords do not match.');
    return res.redirect(`/auth/reset-password/${token}`);
  }

  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      resetPasswordToken: hash,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      req.flash('error', 'This password reset link is invalid or has expired.');
      return res.redirect('/auth/forgot-password');
    }

    user.passwordHash = await bcrypt.hash(password, 12);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    // Send confirmation email asynchronously
    emailService
      .sendPasswordChangedEmail(user)
      .catch((err) => logger.error('Password changed email failed', { error: err.message }));

    await AuditLog.create({
      userId: user._id,
      action: 'user.passwordReset',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: {},
    });

    req.flash('success', 'Your password has been reset. You can now log in.');
    return res.redirect('/auth/login');
  } catch (err) {
    logger.error('Reset password error', { error: err.message });
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect(`/auth/reset-password/${token}`);
  }
};

// ---------------------------------------------------------------------------
// verifyEmail  (GET /auth/verify-email/:token)
// ---------------------------------------------------------------------------
const verifyEmail = async (req, res) => {
  const { token } = req.params;
  if (!token) {
    req.flash('error', 'Invalid verification link.');
    return res.redirect('/dashboard');
  }

  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      emailVerifyToken: hash,
      emailVerifyExpires: { $gt: new Date() },
      isEmailVerified: false,
    });

    if (!user) {
      req.flash('error', 'This verification link is invalid or has already been used.');
      return res.redirect('/dashboard');
    }

    user.isEmailVerified = true;
    user.emailVerifyToken = undefined;
    user.emailVerifyExpires = undefined;
    await user.save();

    await AuditLog.create({
      userId: user._id,
      action: 'user.emailVerified',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: {},
    });

    req.flash('success', 'Your email has been verified successfully!');
    return res.redirect('/dashboard');
  } catch (err) {
    logger.error('Email verification error', { error: err.message });
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/dashboard');
  }
};

// ---------------------------------------------------------------------------
// resendVerification  (POST /auth/resend-verification)
// Rate limited at route level
// ---------------------------------------------------------------------------
const resendVerification = async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ success: false, message: 'Not authenticated.' });
  }

  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.isEmailVerified) {
      return res.status(400).json({ success: false, message: 'Email is already verified.' });
    }

    const { raw, hash } = generateToken();
    user.emailVerifyToken = hash;
    user.emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    await emailService.sendVerificationEmail(user, raw);

    return res.json({ success: true, message: 'Verification email resent.' });
  } catch (err) {
    logger.error('Resend verification error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to resend verification email.' });
  }
};

// ---------------------------------------------------------------------------
// showTwoFactor  (GET /auth/2fa/setup)
// ---------------------------------------------------------------------------
const showTwoFactor = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('+twoFactorSecret');
    const secret = user.twoFactorSecret || generateTotpSecret();

    // Build an otpauth URL for QR code display in the view
    const otpauthUrl = `otpauth://totp/InstaFlow:${encodeURIComponent(user.email)}?secret=${secret}&issuer=InstaFlow`;

    return res.render('auth/two-factor-setup', {
      title: 'Two-Factor Authentication Setup',
      csrfToken: req.csrfToken ? req.csrfToken() : '',
      secret,
      otpauthUrl,
      isEnabled: user.twoFactorEnabled || false,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Show 2FA error', { error: err.message });
    req.flash('error', 'Could not load 2FA setup page.');
    return res.redirect('/dashboard');
  }
};

// ---------------------------------------------------------------------------
// setupTwoFactor  (POST /auth/2fa/setup)
// ---------------------------------------------------------------------------
const setupTwoFactor = async (req, res) => {
  const { secret, token } = req.body;

  if (!secret || !token) {
    req.flash('error', 'Secret and verification code are required.');
    return res.redirect('/auth/2fa/setup');
  }

  try {
    const isValid = verifyTotp(secret, token.trim());
    if (!isValid) {
      req.flash('error', 'Invalid verification code. Please try again.');
      return res.redirect('/auth/2fa/setup');
    }

    const user = await User.findById(req.user._id);
    user.twoFactorSecret = secret;
    user.twoFactorEnabled = true;
    await user.save();

    await AuditLog.create({
      userId: user._id,
      action: 'user.twoFactorEnabled',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: {},
    });

    req.flash('success', 'Two-factor authentication has been enabled.');
    return res.redirect('/dashboard/security');
  } catch (err) {
    logger.error('Setup 2FA error', { error: err.message });
    req.flash('error', 'Failed to enable 2FA. Please try again.');
    return res.redirect('/auth/2fa/setup');
  }
};

module.exports = {
  showLogin,
  login,
  showRegister,
  register,
  logout,
  showForgotPassword,
  forgotPassword,
  showResetPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
  showTwoFactor,
  setupTwoFactor,
};
