'use strict';

const helmet = require('helmet');
const cors = require('cors');
const hpp = require('hpp');
const mongoSanitize = require('express-mongo-sanitize');
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');

// ---------------------------------------------------------------------------
// CORS whitelist
// ---------------------------------------------------------------------------

/**
 * Parse the CORS_WHITELIST environment variable into an array of allowed origins.
 * The variable should be a comma-separated list of URLs.
 * Falls back to allowing only the APP_URL when not set.
 *
 * @returns {string[]}
 */
function buildCorsWhitelist() {
  const raw = process.env.CORS_WHITELIST || process.env.APP_URL || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build a CORS options object with a dynamic origin validator.
 * @returns {import('cors').CorsOptions}
 */
function buildCorsOptions() {
  const whitelist = buildCorsWhitelist();
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    origin(origin, callback) {
      // Allow server-to-server / curl requests in development (no Origin header)
      if (!origin && !isProduction) return callback(null, true);

      // Allow requests with no origin (mobile apps, Postman) in non-production
      if (!origin) return callback(null, false);

      if (whitelist.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        Object.assign(new Error(`Origin "${origin}" is not allowed by CORS policy.`), {
          statusCode: 403,
        })
      );
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'X-Request-ID',
      'Accept',
      'Accept-Language',
    ],
    exposedHeaders: ['X-Request-ID', 'X-Response-Time', 'RateLimit-Remaining', 'RateLimit-Reset'],
    credentials: true,
    maxAge: 86400, // 24 hours preflight cache
    optionsSuccessStatus: 204,
  };
}

// ---------------------------------------------------------------------------
// Helmet CSP
// ---------------------------------------------------------------------------

/**
 * Build a strict Content-Security-Policy configuration.
 * @returns {import('helmet').ContentSecurityPolicyOptions}
 */
function buildCspOptions() {
  const appUrl = process.env.APP_URL || '';
  const cdnUrl = process.env.CDN_URL || '';

  const scriptSources = ["'self'"];
  const styleSources = ["'self'", "'unsafe-inline'"]; // unsafe-inline needed for inline Tailwind
  const imgSources = ["'self'", 'data:', 'blob:'];
  const connectSources = ["'self'"];
  const fontSources = ["'self'", 'data:'];
  const frameSources = ["'none'"];

  if (cdnUrl) {
    scriptSources.push(cdnUrl);
    styleSources.push(cdnUrl);
    imgSources.push(cdnUrl);
    fontSources.push(cdnUrl);
  }

  if (appUrl) {
    connectSources.push(appUrl);
  }

  return {
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: scriptSources,
      styleSrc: styleSources,
      imgSrc: imgSources,
      connectSrc: connectSources,
      fontSrc: fontSources,
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: frameSources,
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
    reportOnly: false,
  };
}

// ---------------------------------------------------------------------------
// Compression filter
// ---------------------------------------------------------------------------

/**
 * Only compress responses that benefit from it (skips already-compressed
 * content-types like images/video and very small responses).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean}
 */
function shouldCompress(req, res) {
  if (req.headers['x-no-compression']) return false;
  return compression.filter(req, res);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Apply all security-related middleware to the Express app.
 *
 * Call this function early in the middleware chain, before routes are
 * registered.
 *
 * @param {import('express').Application} app - The Express application instance.
 */
function applySecurityMiddleware(app) {
  const isProduction = process.env.NODE_ENV === 'production';

  // ── Trust proxy (Nginx / load-balancer) ──────────────────────────────────
  // Set to the number of proxies between the user and the app, or 'loopback'
  // when Nginx runs on the same host.
  const trustProxy = process.env.TRUST_PROXY || (isProduction ? 1 : false);
  app.set('trust proxy', trustProxy);

  // ── X-Request-ID ─────────────────────────────────────────────────────────
  app.use((req, res, next) => {
    // Accept an upstream request ID (e.g. from Nginx) or generate a new one
    const requestId = req.headers['x-request-id'] || uuidv4();
    req.id = requestId;
    res.setHeader('X-Request-ID', requestId);
    next();
  });

  // ── Request timing ───────────────────────────────────────────────────────
  app.use((req, res, next) => {
    const startAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationNs = process.hrtime.bigint() - startAt;
      const durationMs = Number(durationNs) / 1e6;
      // Header is already sent at this point; set it before finish if needed
      // This is exposed via morgan's :response-time token instead
      req._responseTimeMs = durationMs;
    });

    next();
  });

  // ── Helmet (HTTP security headers) ───────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: buildCspOptions(),
      hsts: isProduction
        ? {
            maxAge: 31536000, // 1 year
            includeSubDomains: true,
            preload: true,
          }
        : false,
      noSniff: true,
      xssFilter: true,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      crossOriginEmbedderPolicy: false, // Avoid breaking OAuth redirects
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      originAgentCluster: true,
      dnsPrefetchControl: { allow: false },
      frameguard: { action: 'deny' },
      permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    })
  );

  // ── CORS ─────────────────────────────────────────────────────────────────
  app.use(cors(buildCorsOptions()));
  // Handle pre-flight for all routes
  app.options('*', cors(buildCorsOptions()));

  // ── HTTP Parameter Pollution protection ──────────────────────────────────
  app.use(
    hpp({
      // Allow arrays for these legitimate query params
      whitelist: ['tags', 'features', 'ids', 'status'],
    })
  );

  // ── NoSQL injection sanitization ─────────────────────────────────────────
  app.use(
    mongoSanitize({
      replaceWith: '_',
      onSanitize: ({ req, key }) => {
        console.warn(
          `[Security] Potential NoSQL injection attempt sanitized. Key: "${key}" IP: ${req.ip}`
        );
      },
    })
  );

  // ── Response compression ─────────────────────────────────────────────────
  app.use(
    compression({
      level: 6,
      threshold: 1024, // Only compress responses > 1 KB
      filter: shouldCompress,
    })
  );
}

module.exports = { applySecurityMiddleware };
