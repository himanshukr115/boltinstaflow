'use strict';

const { body, param, query, validationResult } = require('express-validator');
const Joi = require('joi');
const sanitizeHtml = require('sanitize-html');

// ---------------------------------------------------------------------------
// Sanitize-HTML default options (strips all HTML tags / attributes)
// ---------------------------------------------------------------------------

const SANITIZE_OPTIONS = {
  allowedTags: [],
  allowedAttributes: {},
  disallowedTagsMode: 'discard',
  enforceHtmlBoundary: false,
};

// ---------------------------------------------------------------------------
// Password complexity regex
// At least 8 chars, one uppercase, one lowercase, one digit, one special char
// ---------------------------------------------------------------------------

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;

// ---------------------------------------------------------------------------
// handleValidationErrors
// ---------------------------------------------------------------------------

/**
 * Middleware that reads express-validator's validation result and responds
 * with 422 Unprocessable Entity when any validation failures are present.
 *
 * @type {import('express').RequestHandler}
 */
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map((err) => ({
      field: err.path || err.param,
      message: err.msg,
      value: err.value !== undefined ? String(err.value).slice(0, 100) : undefined,
    }));

    return res.status(422).json({
      success: false,
      statusCode: 422,
      message: 'Validation failed. Please correct the highlighted fields.',
      errors: formattedErrors,
    });
  }

  next();
}

// ---------------------------------------------------------------------------
// sanitizeInputs
// ---------------------------------------------------------------------------

/**
 * Middleware that walks all string properties in req.body, req.query, and
 * req.params and strips any HTML / script content using sanitize-html.
 *
 * @type {import('express').RequestHandler}
 */
function sanitizeInputs(req, res, next) {
  /**
   * Recursively sanitize all string values in an object.
   * @param {Record<string, unknown>} obj
   * @returns {Record<string, unknown>}
   */
  function sanitizeObject(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string') {
        obj[key] = sanitizeHtml(val.trim(), SANITIZE_OPTIONS);
      } else if (Array.isArray(val)) {
        obj[key] = val.map((item) =>
          typeof item === 'string' ? sanitizeHtml(item.trim(), SANITIZE_OPTIONS) : item
        );
      } else if (val && typeof val === 'object') {
        sanitizeObject(val);
      }
    }
    return obj;
  }

  if (req.body) sanitizeObject(req.body);
  if (req.query) sanitizeObject(req.query);
  if (req.params) sanitizeObject(req.params);

  next();
}

// ---------------------------------------------------------------------------
// validateRegistration
// ---------------------------------------------------------------------------

/**
 * Validates user registration input.
 * @type {import('express-validator').ValidationChain[]}
 */
const validateRegistration = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required.')
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters.')
    .matches(/^[a-zA-Z\s\-'.]+$/)
    .withMessage('Name may only contain letters, spaces, hyphens, apostrophes, and periods.'),

  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email address is required.')
    .isEmail()
    .withMessage('Please enter a valid email address.')
    .normalizeEmail()
    .isLength({ max: 254 })
    .withMessage('Email address is too long.'),

  body('password')
    .notEmpty()
    .withMessage('Password is required.')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long.')
    .matches(PASSWORD_REGEX)
    .withMessage(
      'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character.'
    ),

  body('confirmPassword')
    .notEmpty()
    .withMessage('Password confirmation is required.')
    .custom((value, { req }) => {
      if (value !== req.body.password) {
        throw new Error('Passwords do not match.');
      }
      return true;
    }),
];

// ---------------------------------------------------------------------------
// validateLogin
// ---------------------------------------------------------------------------

/**
 * Validates login input.
 * @type {import('express-validator').ValidationChain[]}
 */
const validateLogin = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email address is required.')
    .isEmail()
    .withMessage('Please enter a valid email address.')
    .normalizeEmail(),

  body('password')
    .notEmpty()
    .withMessage('Password is required.')
    .isLength({ min: 1, max: 512 })
    .withMessage('Password is invalid.'),
];

// ---------------------------------------------------------------------------
// validatePlan
// ---------------------------------------------------------------------------

/**
 * Joi schema for plan creation/update.
 */
const planJoiSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required().messages({
    'string.min': 'Plan name must be at least 2 characters.',
    'string.max': 'Plan name cannot exceed 100 characters.',
    'any.required': 'Plan name is required.',
  }),
  slug: Joi.string()
    .trim()
    .lowercase()
    .pattern(/^[a-z0-9-]+$/)
    .max(60)
    .optional(),
  description: Joi.string().trim().max(500).optional().allow(''),
  price: Joi.object({
    monthly: Joi.number().min(0).required(),
    annual: Joi.number().min(0).optional(),
  }).required(),
  currency: Joi.string().uppercase().length(3).default('USD'),
  features: Joi.array()
    .items(
      Joi.object({
        key: Joi.string().required(),
        label: Joi.string().required(),
        included: Joi.boolean().default(true),
        limit: Joi.number().integer().min(-1).optional(), // -1 = unlimited
      })
    )
    .min(1)
    .required(),
  limits: Joi.object({
    instagramAccounts: Joi.number().integer().min(1).required(),
    dailyDms: Joi.number().integer().min(-1).required(),
    contacts: Joi.number().integer().min(-1).required(),
    automations: Joi.number().integer().min(-1).required(),
    campaigns: Joi.number().integer().min(-1).required(),
  }).required(),
  isActive: Joi.boolean().default(true),
  trialDays: Joi.number().integer().min(0).max(90).default(0),
  sortOrder: Joi.number().integer().min(0).default(0),
});

/**
 * Express middleware that validates a plan payload against the Joi schema.
 * @type {import('express').RequestHandler}
 */
function validatePlan(req, res, next) {
  const { error, value } = planJoiSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });

  if (error) {
    const errors = error.details.map((d) => ({
      field: d.path.join('.'),
      message: d.message,
    }));

    return res.status(422).json({
      success: false,
      statusCode: 422,
      message: 'Plan validation failed.',
      errors,
    });
  }

  req.body = value; // replace with sanitized/converted value
  next();
}

// ---------------------------------------------------------------------------
// validateAutomation
// ---------------------------------------------------------------------------

/**
 * Joi schema for automation creation/update.
 */
const automationJoiSchema = Joi.object({
  name: Joi.string().trim().min(2).max(150).required(),
  instagramAccountId: Joi.string()
    .pattern(/^[a-f\d]{24}$/i)
    .required()
    .messages({ 'string.pattern.base': 'instagramAccountId must be a valid MongoDB ObjectId.' }),
  trigger: Joi.object({
    type: Joi.string()
      .valid('new_follower', 'mention', 'comment_keyword', 'story_mention', 'dm_keyword', 'schedule')
      .required(),
    keywords: Joi.array().items(Joi.string().trim().max(100)).optional(),
    schedule: Joi.object({
      cron: Joi.string().optional(),
      timezone: Joi.string().optional(),
    }).optional(),
  }).required(),
  actions: Joi.array()
    .items(
      Joi.object({
        type: Joi.string()
          .valid('send_dm', 'add_to_list', 'remove_from_list', 'add_tag', 'remove_tag', 'webhook')
          .required(),
        payload: Joi.object().optional(),
        delaySeconds: Joi.number().integer().min(0).max(86400).default(0),
      })
    )
    .min(1)
    .max(20)
    .required(),
  isActive: Joi.boolean().default(false),
  description: Joi.string().trim().max(500).optional().allow(''),
});

/**
 * Express middleware that validates an automation payload.
 * @type {import('express').RequestHandler}
 */
function validateAutomation(req, res, next) {
  const { error, value } = automationJoiSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });

  if (error) {
    const errors = error.details.map((d) => ({ field: d.path.join('.'), message: d.message }));
    return res.status(422).json({ success: false, statusCode: 422, message: 'Automation validation failed.', errors });
  }

  req.body = value;
  next();
}

// ---------------------------------------------------------------------------
// validateCampaign
// ---------------------------------------------------------------------------

/**
 * Joi schema for campaign creation/update.
 */
const campaignJoiSchema = Joi.object({
  name: Joi.string().trim().min(2).max(150).required(),
  instagramAccountId: Joi.string()
    .pattern(/^[a-f\d]{24}$/i)
    .required(),
  type: Joi.string().valid('dm_blast', 'story_reply', 'comment_reply', 'follow', 'unfollow').required(),
  audience: Joi.object({
    listIds: Joi.array().items(Joi.string().pattern(/^[a-f\d]{24}$/i)).optional(),
    tags: Joi.array().items(Joi.string().trim().max(50)).optional(),
    filterCriteria: Joi.object().optional(),
  }).optional(),
  message: Joi.object({
    text: Joi.string().trim().max(2000).optional().allow(''),
    mediaUrl: Joi.string().uri().optional().allow(''),
    variables: Joi.array().items(Joi.string().trim()).optional(),
  }).when('type', {
    is: Joi.valid('dm_blast', 'story_reply', 'comment_reply'),
    then: Joi.required(),
  }),
  schedule: Joi.object({
    startAt: Joi.date().iso().min('now').required(),
    endAt: Joi.date().iso().greater(Joi.ref('startAt')).optional(),
    timezone: Joi.string().default('UTC'),
    dailyLimit: Joi.number().integer().min(1).max(500).default(100),
    throttleMs: Joi.number().integer().min(1000).default(3000),
  }).required(),
  isActive: Joi.boolean().default(false),
  description: Joi.string().trim().max(500).optional().allow(''),
});

/**
 * Express middleware that validates a campaign payload.
 * @type {import('express').RequestHandler}
 */
function validateCampaign(req, res, next) {
  const { error, value } = campaignJoiSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });

  if (error) {
    const errors = error.details.map((d) => ({ field: d.path.join('.'), message: d.message }));
    return res.status(422).json({ success: false, statusCode: 422, message: 'Campaign validation failed.', errors });
  }

  req.body = value;
  next();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  validateRegistration,
  validateLogin,
  validatePlan,
  validateAutomation,
  validateCampaign,
  handleValidationErrors,
  sanitizeInputs,
};
