'use strict';

const jwt = require('jsonwebtoken');
const User = require('../models/User');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'instaflow-api';
const JWT_ISSUER = process.env.JWT_ISSUER || 'instaflow';

/**
 * Determine if the request prefers a JSON response.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function prefersJson(req) {
  const accept = req.headers.accept || '';
  return accept.includes('application/json') || accept.includes('*/*') === false
    ? accept.includes('application/json')
    : !!(req.xhr || (req.headers['content-type'] || '').includes('application/json'));
}

/**
 * Extract the raw JWT string from the Authorization header.
 * Returns null when the header is absent or malformed.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractBearerToken(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verify and decode a JWT. Returns the decoded payload or null.
 * @param {string} token
 * @returns {object|null}
 */
function verifyJwt(token) {
  try {
    return jwt.verify(token, JWT_SECRET, {
      audience: JWT_AUDIENCE,
      issuer: JWT_ISSUER,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// loadUserFromToken
// ---------------------------------------------------------------------------

/**
 * Middleware that reads a JWT from the Authorization header, verifies it, and
 * loads the corresponding User document into req.user. If no valid token is
 * present the middleware continues without setting req.user.
 *
 * @type {import('express').RequestHandler}
 */
async function loadUserFromToken(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) return next();

    const payload = verifyJwt(token);
    if (!payload || !payload.sub) return next();

    const user = await User.findById(payload.sub)
      .select('-password')
      .populate('subscription')
      .lean(false);

    if (user && user.isActive !== false) {
      req.user = user;
      req.authMethod = 'jwt';
    }

    next();
  } catch (err) {
    // Non-fatal – continue without authenticated user
    next();
  }
}

// ---------------------------------------------------------------------------
// optionalAuth
// ---------------------------------------------------------------------------

/**
 * Middleware that attempts session-based or JWT-based authentication but
 * always calls next() regardless of outcome. Sets req.user when successful.
 *
 * @type {import('express').RequestHandler}
 */
async function optionalAuth(req, res, next) {
  // Session auth already populated req.user via Passport deserializeUser
  if (req.isAuthenticated && req.isAuthenticated() && req.user) {
    return next();
  }

  // Fall back to JWT
  await loadUserFromToken(req, res, next);
}

// ---------------------------------------------------------------------------
// requireAuth
// ---------------------------------------------------------------------------

/**
 * Middleware that enforces authentication.
 * - Accepts session-based (Passport) or JWT Bearer authentication.
 * - Returns 401 JSON when the Accept header signals an API client.
 * - Redirects to /auth/login for browser requests.
 *
 * @type {import('express').RequestHandler}
 */
async function requireAuth(req, res, next) {
  // 1. Session / Passport
  if (req.isAuthenticated && req.isAuthenticated() && req.user) {
    return next();
  }

  // 2. JWT Bearer token
  const token = extractBearerToken(req);
  if (token) {
    const payload = verifyJwt(token);
    if (payload && payload.sub) {
      try {
        const user = await User.findById(payload.sub)
          .select('-password')
          .populate('subscription')
          .lean(false);

        if (user && user.isActive !== false) {
          req.user = user;
          req.authMethod = 'jwt';
          return next();
        }
      } catch {
        // Fall through to 401
      }
    }
  }

  // 3. Unauthenticated – respond appropriately
  if (prefersJson(req)) {
    return res.status(401).json({
      success: false,
      statusCode: 401,
      message: 'Authentication required. Please provide a valid session or Bearer token.',
    });
  }

  // Browser redirect – persist original URL so the login page can redirect back
  req.session.returnTo = req.originalUrl;
  return res.redirect('/auth/login');
}

// ---------------------------------------------------------------------------
// requireAdmin
// ---------------------------------------------------------------------------

/**
 * Middleware that requires the authenticated user to have the 'admin' role.
 * Must be placed after requireAuth.
 *
 * @type {import('express').RequestHandler}
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return prefersJson(req)
      ? res.status(401).json({ success: false, statusCode: 401, message: 'Not authenticated.' })
      : res.redirect('/auth/login');
  }

  if (req.user.role !== 'admin') {
    return prefersJson(req)
      ? res.status(403).json({
          success: false,
          statusCode: 403,
          message: 'Access denied. Administrator privileges required.',
        })
      : res.redirect('/dashboard');
  }

  next();
}

// ---------------------------------------------------------------------------
// requireActiveSubscription
// ---------------------------------------------------------------------------

/**
 * Allowed subscription statuses that grant access.
 */
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

/**
 * Middleware that requires the authenticated user to have an active
 * subscription or an ongoing trial. Must be placed after requireAuth.
 *
 * @type {import('express').RequestHandler}
 */
function requireActiveSubscription(req, res, next) {
  if (!req.user) {
    return prefersJson(req)
      ? res.status(401).json({ success: false, statusCode: 401, message: 'Not authenticated.' })
      : res.redirect('/auth/login');
  }

  const sub = req.user.subscription;

  // Admins bypass subscription checks
  if (req.user.role === 'admin') return next();

  const hasActiveSub =
    sub &&
    ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status) &&
    (!sub.currentPeriodEnd || new Date(sub.currentPeriodEnd) > new Date());

  if (!hasActiveSub) {
    return prefersJson(req)
      ? res.status(402).json({
          success: false,
          statusCode: 402,
          message: 'An active subscription is required to access this feature.',
          redirectUrl: '/pricing',
        })
      : res.redirect('/pricing');
  }

  next();
}

// ---------------------------------------------------------------------------
// requireInstagramConnected
// ---------------------------------------------------------------------------

/**
 * Middleware that requires the authenticated user to have at least one active
 * Instagram account connected. Must be placed after requireAuth.
 *
 * @type {import('express').RequestHandler}
 */
async function requireInstagramConnected(req, res, next) {
  if (!req.user) {
    return prefersJson(req)
      ? res.status(401).json({ success: false, statusCode: 401, message: 'Not authenticated.' })
      : res.redirect('/auth/login');
  }

  try {
    // Avoid circular dependency by requiring lazily
    const InstagramAccount = require('../models/InstagramAccount');

    const count = await InstagramAccount.countDocuments({
      userId: req.user._id,
      isActive: true,
    });

    if (count === 0) {
      return prefersJson(req)
        ? res.status(403).json({
            success: false,
            statusCode: 403,
            message: 'You must connect at least one Instagram account to use this feature.',
            redirectUrl: '/dashboard/instagram',
          })
        : res.redirect('/dashboard/instagram');
    }

    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  requireAuth,
  requireAdmin,
  requireActiveSubscription,
  requireInstagramConnected,
  optionalAuth,
  loadUserFromToken,
};
