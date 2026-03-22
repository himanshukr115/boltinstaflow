'use strict';

const sanitizeHtmlLib = require('sanitize-html');

// ─── Email ────────────────────────────────────────────────────────────────────

/**
 * Validate an email address using an RFC 5322-inspired regex.
 * Covers the vast majority of real-world email addresses.
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  // RFC 5322 General Email Regex (simplified but robust)
  const RFC_EMAIL_RE =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
  return RFC_EMAIL_RE.test(email.trim()) && email.length <= 254;
}

// ─── Password Strength ────────────────────────────────────────────────────────

/**
 * Check whether a password meets minimum strength requirements:
 *   - At least 8 characters
 *   - At least one uppercase letter
 *   - At least one lowercase letter
 *   - At least one digit
 *   - At least one special character (!@#$%^&* etc.)
 * @param {string} password
 * @returns {{ valid: boolean, errors: string[] }}
 */
function isStrongPassword(password) {
  const errors = [];
  if (typeof password !== 'string' || password.length === 0) {
    return { valid: false, errors: ['Password is required'] };
  }
  if (password.length < 8) errors.push('Password must be at least 8 characters');
  if (!/[A-Z]/.test(password)) errors.push('Password must contain at least one uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('Password must contain at least one lowercase letter');
  if (!/[0-9]/.test(password)) errors.push('Password must contain at least one number');
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }
  return { valid: errors.length === 0, errors };
}

// ─── URL ──────────────────────────────────────────────────────────────────────

/**
 * Validate a URL, requiring http or https protocol.
 * @param {string} url
 * @returns {boolean}
 */
function isValidUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ─── Instagram Username ───────────────────────────────────────────────────────

/**
 * Validate an Instagram username per Instagram's rules:
 *   - 1–30 characters
 *   - Only letters, numbers, underscores, and periods
 *   - Cannot start or end with a period
 *   - No consecutive periods
 * @param {string} username
 * @returns {boolean}
 */
function isValidInstagramUsername(username) {
  if (typeof username !== 'string') return false;
  const stripped = username.startsWith('@') ? username.slice(1) : username;
  if (stripped.length < 1 || stripped.length > 30) return false;
  if (/[^a-zA-Z0-9._]/.test(stripped)) return false;
  if (stripped.startsWith('.') || stripped.endsWith('.')) return false;
  if (/\.{2,}/.test(stripped)) return false;
  return true;
}

// ─── Phone Number ─────────────────────────────────────────────────────────────

/**
 * Basic international phone number validation.
 * Accepts E.164-style strings: optional '+', 7–15 digits.
 * For production use, consider libphonenumber-js for full validation.
 * @param {string} phone
 * @returns {boolean}
 */
function isValidPhoneNumber(phone) {
  if (typeof phone !== 'string') return false;
  // Strip spaces, dashes, parentheses for normalisation
  const normalized = phone.replace(/[\s\-().]/g, '');
  return /^\+?[1-9]\d{6,14}$/.test(normalized);
}

// ─── Slug ─────────────────────────────────────────────────────────────────────

/**
 * Validate a URL slug: lowercase letters, numbers, hyphens; no leading/trailing hyphens.
 * @param {string} slug
 * @returns {boolean}
 */
function isValidSlug(slug) {
  if (typeof slug !== 'string') return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length >= 1 && slug.length <= 100;
}

// ─── HTML Sanitization ────────────────────────────────────────────────────────

/**
 * Strip dangerous HTML tags and attributes, allowing a safe subset.
 * Uses the sanitize-html library under the hood.
 * @param {string} html
 * @returns {string} Sanitized HTML string
 */
function sanitizeHtml(html) {
  if (typeof html !== 'string') return '';
  return sanitizeHtmlLib(html, {
    allowedTags: [
      'b', 'i', 'em', 'strong', 'u', 'br', 'p',
      'ul', 'ol', 'li', 'a', 'blockquote', 'code', 'pre',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'span',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      span: ['class'],
      p: ['class'],
      code: ['class'],
      pre: ['class'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {},
    // Force all links to open in a new tab with safe attributes
    transformTags: {
      a: (tagName, attribs) => ({
        tagName: 'a',
        attribs: {
          ...attribs,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
      }),
    },
  });
}

// ─── Plan Limits ─────────────────────────────────────────────────────────────

/**
 * Validate the shape of a plan limits object.
 * @param {object} limits
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePlanLimits(limits) {
  const errors = [];
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    return { valid: false, errors: ['limits must be a plain object'] };
  }

  const REQUIRED_FIELDS = ['dmPerDay', 'contacts', 'automations', 'campaigns', 'instagramAccounts'];

  for (const field of REQUIRED_FIELDS) {
    if (!(field in limits)) {
      errors.push(`limits.${field} is required`);
    } else {
      const val = limits[field];
      // -1 is the sentinel for "unlimited"
      if (!Number.isInteger(val) || (val < -1)) {
        errors.push(`limits.${field} must be an integer >= -1 (use -1 for unlimited)`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Webhook Payload ─────────────────────────────────────────────────────────

/**
 * Basic structural validation for incoming webhook payloads.
 * @param {object} payload  The parsed request body
 * @param {string} [source='instagram']  'instagram' | 'razorpay' | 'generic'
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateWebhookPayload(payload, source = 'instagram') {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['Payload must be a plain object'] };
  }

  switch (source) {
    case 'instagram': {
      // Facebook/Instagram webhook verification and notification structure
      if (payload.object && payload.object !== 'instagram' && payload.object !== 'page') {
        errors.push('payload.object must be "instagram" or "page"');
      }
      if (payload.entry !== undefined && !Array.isArray(payload.entry)) {
        errors.push('payload.entry must be an array when present');
      }
      break;
    }

    case 'razorpay': {
      if (!payload.event || typeof payload.event !== 'string') {
        errors.push('payload.event (string) is required for Razorpay webhooks');
      }
      if (!payload.payload || typeof payload.payload !== 'object') {
        errors.push('payload.payload (object) is required for Razorpay webhooks');
      }
      if (!payload.created_at || typeof payload.created_at !== 'number') {
        errors.push('payload.created_at (unix timestamp) is required for Razorpay webhooks');
      }
      break;
    }

    case 'generic':
    default: {
      if (!payload.event || typeof payload.event !== 'string') {
        errors.push('payload.event (string) is required');
      }
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  isValidEmail,
  isStrongPassword,
  isValidUrl,
  isValidInstagramUsername,
  isValidPhoneNumber,
  isValidSlug,
  sanitizeHtml,
  validatePlanLimits,
  validateWebhookPayload,
};
