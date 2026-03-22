'use strict';

const rateLimit = require('express-rate-limit');

function keyGenerator(req) {
  const userId = req.user ? String(req.user._id) : 'anon';
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return `rl:${ip}:${userId}`;
}

function rateLimitHandler(req, res) {
  const retryAfter = res.getHeader('Retry-After');
  res.status(429).json({
    success: false,
    statusCode: 429,
    message: 'Too many requests. Please slow down and try again later.',
    retryAfter: retryAfter ? Number(retryAfter) : undefined,
  });
}

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator,
  handler: rateLimitHandler,
  skip: (req) => req.user && req.user.role === 'admin',
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return `rl:auth:${ip}`;
  },
  handler: rateLimitHandler,
  skipSuccessfulRequests: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator,
  handler: rateLimitHandler,
  skip: (req) => !req.user,
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return `rl:webhook:${ip}`;
  },
  handler: rateLimitHandler,
});

const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const userId = req.user ? String(req.user._id) : 'anon';
    return `rl:strict:${ip}:${userId}`;
  },
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      statusCode: 429,
      message: 'You have exceeded the allowed number of attempts. Please wait 1 hour before trying again.',
    });
  },
});

module.exports = {
  globalLimiter,
  authLimiter,
  apiLimiter,
  webhookLimiter,
  strictLimiter,
  keyGenerator,
};
