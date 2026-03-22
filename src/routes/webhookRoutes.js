'use strict';

/**
 * Webhook routes — /webhooks/*
 *
 * All routes here are intentionally excluded from CSRF protection because
 * they receive POST requests from external services (Instagram, Razorpay,
 * Cashfree) that cannot include CSRF tokens.
 *
 * The raw body is preserved for HMAC signature verification.
 * Jobs are queued immediately and a 200 response is returned — this follows
 * the webhook best-practice of acknowledging receipt quickly and processing
 * asynchronously.
 */

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const { webhookLimiter }  = require('../middleware/rateLimiter');
const { addWebhookJob }   = require('../queues/index');
const logger              = require('../config/logger');

// ---------------------------------------------------------------------------
// Mark every request on this router as CSRF-excluded so the global CSRF
// middleware (if applied after routes) can skip them.
// ---------------------------------------------------------------------------
router.use((req, res, next) => {
  req.csrfExcluded = true;
  next();
});

// Apply rate limiter to all webhook endpoints
router.use(webhookLimiter);

// ---------------------------------------------------------------------------
// Raw body parser for signature verification
// The app.js already applies express.raw() to /webhooks/* paths but we also
// define it here for completeness in case this router is mounted standalone.
// ---------------------------------------------------------------------------
const rawBodyParser = express.raw({ type: ['application/json', '*/*'], limit: '1mb' });

// ---------------------------------------------------------------------------
// Helper — safely read the raw body as a string regardless of whether the
// body has been parsed as a Buffer (raw) or an object (json).
// ---------------------------------------------------------------------------
function getRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return String(req.body || '');
}

// ---------------------------------------------------------------------------
// Instagram webhook — GET /webhooks/instagram (verification challenge)
// Instagram sends a GET with hub.challenge when subscribing a webhook.
// ---------------------------------------------------------------------------
router.get('/instagram', (req, res) => {
  const VERIFY_TOKEN = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || 'instaflow_verify';
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    logger.info('Instagram webhook verified successfully');
    return res.status(200).send(challenge);
  }

  logger.warn('Instagram webhook verification failed', { mode, token });
  return res.status(403).json({ error: 'Webhook verification failed' });
});

// ---------------------------------------------------------------------------
// Instagram webhook — POST /webhooks/instagram (incoming events)
// ---------------------------------------------------------------------------
router.post('/instagram', rawBodyParser, async (req, res) => {
  try {
    const rawBody   = getRawBody(req);
    const signature = req.headers['x-hub-signature-256'] || '';

    // Verify HMAC-SHA256 signature when the app secret is configured
    const appSecret = process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET;
    if (appSecret && signature) {
      const expected = 'sha256=' + crypto
        .createHmac('sha256', appSecret)
        .update(rawBody)
        .digest('hex');

      try {
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
          logger.warn('Instagram webhook signature mismatch');
          return res.status(400).json({ error: 'Invalid signature' });
        }
      } catch {
        // timingSafeEqual throws if buffers differ in length
        logger.warn('Instagram webhook signature length mismatch');
        return res.status(400).json({ error: 'Invalid signature' });
      }
    }

    // Parse body if it arrived as a Buffer
    let payload;
    try {
      payload = Buffer.isBuffer(req.body) ? JSON.parse(rawBody) : req.body;
    } catch {
      logger.warn('Instagram webhook invalid JSON body');
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    // Enqueue for async processing — respond 200 immediately
    await addWebhookJob('instagram', {
      source:    'instagram',
      payload,
      receivedAt: new Date().toISOString(),
    });

    logger.info('Instagram webhook queued', { object: payload && payload.object });
    return res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Instagram webhook handler error', { error: err.message });
    // Still return 200 to prevent Instagram from retrying indefinitely
    return res.status(200).json({ received: true });
  }
});

// ---------------------------------------------------------------------------
// Razorpay webhook — POST /webhooks/razorpay
// ---------------------------------------------------------------------------
router.post('/razorpay', rawBodyParser, async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];

  if (!signature) {
    logger.warn('Razorpay webhook missing signature header');
    return res.status(400).json({ error: 'Missing x-razorpay-signature header' });
  }

  try {
    const rawBody = getRawBody(req);

    // Verify HMAC-SHA256 signature
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (webhookSecret) {
      const expected = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');

      try {
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
          logger.warn('Razorpay webhook signature mismatch');
          return res.status(400).json({ error: 'Invalid signature' });
        }
      } catch {
        logger.warn('Razorpay webhook signature length mismatch');
        return res.status(400).json({ error: 'Invalid signature' });
      }
    }

    let payload;
    try {
      payload = Buffer.isBuffer(req.body) ? JSON.parse(rawBody) : req.body;
    } catch {
      logger.warn('Razorpay webhook invalid JSON body');
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    // Queue for async processing
    await addWebhookJob('razorpay', {
      source:    'razorpay',
      event:     payload && payload.event,
      payload,
      receivedAt: new Date().toISOString(),
    });

    logger.info('Razorpay webhook queued', { event: payload && payload.event });
    return res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Razorpay webhook handler error', { error: err.message });
    return res.status(200).json({ received: true });
  }
});

// ---------------------------------------------------------------------------
// Cashfree webhook — POST /webhooks/cashfree
// ---------------------------------------------------------------------------
router.post('/cashfree', rawBodyParser, async (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];

  if (!signature || !timestamp) {
    logger.warn('Cashfree webhook missing signature or timestamp header');
    return res.status(400).json({ error: 'Missing signature headers' });
  }

  try {
    const rawBody = getRawBody(req);

    // Verify HMAC-SHA256 over (timestamp + rawBody)
    const secretKey = process.env.CASHFREE_SECRET_KEY;
    if (secretKey) {
      const signedData = `${timestamp}${rawBody}`;
      const expected   = crypto
        .createHmac('sha256', secretKey)
        .update(signedData)
        .digest('base64');

      if (signature !== expected) {
        logger.warn('Cashfree webhook signature mismatch');
        return res.status(400).json({ error: 'Invalid signature' });
      }
    }

    let payload;
    try {
      payload = Buffer.isBuffer(req.body) ? JSON.parse(rawBody) : req.body;
    } catch {
      logger.warn('Cashfree webhook invalid JSON body');
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    // Queue for async processing
    await addWebhookJob('cashfree', {
      source:    'cashfree',
      type:      payload && payload.type,
      payload,
      receivedAt: new Date().toISOString(),
    });

    logger.info('Cashfree webhook queued', { type: payload && payload.type });
    return res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Cashfree webhook handler error', { error: err.message });
    return res.status(200).json({ received: true });
  }
});

module.exports = router;
