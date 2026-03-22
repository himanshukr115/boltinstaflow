'use strict';

const winston = require('winston');
const path = require('path');

// ---------------------------------------------------------------------------
// AppError – operational errors that should be surfaced to the client
// ---------------------------------------------------------------------------

/**
 * Custom application error class.
 * Operational errors (isOperational = true) are expected failures such as
 * invalid input or not-found resources; they are safe to send to the client.
 * Programming errors are unexpected and should not expose details in production.
 */
class AppError extends Error {
  /**
   * @param {string} message      - Human-readable error message.
   * @param {number} statusCode   - HTTP status code (default 500).
   * @param {boolean} isOperational - Whether this is a known/expected error.
   * @param {Record<string, unknown>} [meta] - Optional extra metadata.
   */
  constructor(message, statusCode = 500, isOperational = true, meta = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.meta = meta;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ---------------------------------------------------------------------------
// Logger (shared with requestLogger.js when available)
// ---------------------------------------------------------------------------

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'error',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'instaflow-error' },
  transports: [
    new winston.transports.Console({
      silent: process.env.NODE_ENV === 'test',
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, stack }) => {
          return `${timestamp} [${level}]: ${message}${stack ? '\n' + stack : ''}`;
        })
      ),
    }),
  ],
});

// Add file transport in production
if (process.env.NODE_ENV === 'production') {
  const { createLogger, transports, format } = winston;
  const DailyRotateFile = require('winston-daily-rotate-file');

  logger.add(
    new DailyRotateFile({
      filename: path.join(process.cwd(), 'logs', 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
      level: 'error',
      format: format.combine(format.timestamp(), format.json()),
    })
  );
}

// ---------------------------------------------------------------------------
// Error classification helpers
// ---------------------------------------------------------------------------

/**
 * Convert well-known third-party errors into AppError instances.
 * @param {Error} err
 * @returns {AppError}
 */
function normalizeError(err) {
  // Already an AppError
  if (err instanceof AppError) return err;

  // ── Mongoose validation error ────────────────────────────────────────────
  if (err.name === 'ValidationError' && err.errors) {
    const messages = Object.values(err.errors)
      .map((e) => e.message)
      .join(' ');
    return new AppError(messages || 'Validation failed.', 422, true, {
      fields: Object.keys(err.errors),
    });
  }

  // ── Mongoose duplicate key (MongoDB E11000) ──────────────────────────────
  if (err.code === 11000 || err.code === 11001) {
    const field = err.keyValue ? Object.keys(err.keyValue).join(', ') : 'field';
    const value = err.keyValue ? Object.values(err.keyValue).join(', ') : '';
    return new AppError(
      `A record with that ${field} (${value}) already exists.`,
      409,
      true,
      { field, value }
    );
  }

  // ── Mongoose cast error (invalid ObjectId etc.) ──────────────────────────
  if (err.name === 'CastError') {
    return new AppError(
      `Invalid value "${err.value}" for field "${err.path}".`,
      400,
      true
    );
  }

  // ── JWT errors ───────────────────────────────────────────────────────────
  if (err.name === 'JsonWebTokenError') {
    return new AppError('Invalid token. Please log in again.', 401, true);
  }
  if (err.name === 'TokenExpiredError') {
    return new AppError('Your session has expired. Please log in again.', 401, true);
  }
  if (err.name === 'NotBeforeError') {
    return new AppError('Token not yet active.', 401, true);
  }

  // ── Rate limit errors ────────────────────────────────────────────────────
  if (err.statusCode === 429 || err.status === 429) {
    return new AppError(
      'Too many requests. Please slow down and try again later.',
      429,
      true
    );
  }

  // ── Multer errors ────────────────────────────────────────────────────────
  if (err.code === 'LIMIT_FILE_SIZE') {
    return new AppError('File too large. Maximum allowed size is 5 MB.', 400, true);
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return new AppError('Unexpected file field in the upload.', 400, true);
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return new AppError('Too many files uploaded at once.', 400, true);
  }

  // ── SyntaxError (malformed JSON body) ────────────────────────────────────
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return new AppError('Invalid JSON in request body.', 400, true);
  }

  // ── CORS errors ──────────────────────────────────────────────────────────
  if (err.message && err.message.startsWith('Origin') && err.statusCode === 403) {
    return new AppError(err.message, 403, true);
  }

  // ── Generic / unknown error ───────────────────────────────────────────────
  return new AppError(
    process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred. Please try again later.'
      : err.message || 'Internal server error.',
    err.statusCode || err.status || 500,
    false
  );
}

// ---------------------------------------------------------------------------
// notFound – 404 handler
// ---------------------------------------------------------------------------

/**
 * Middleware to handle requests that did not match any route.
 * Must be registered AFTER all routes.
 *
 * @type {import('express').RequestHandler}
 */
function notFound(req, res, next) {
  const accept = req.headers.accept || '';
  const isJson = accept.includes('application/json');

  if (isJson) {
    return res.status(404).json({
      success: false,
      statusCode: 404,
      message: `Cannot ${req.method} ${req.originalUrl}`,
    });
  }

  // Render view if it exists, else fall back to JSON
  res.status(404);
  if (res.render) {
    try {
      return res.render('errors/404', {
        title: 'Page Not Found',
        url: req.originalUrl,
        method: req.method,
      });
    } catch {
      // View not found – fall through
    }
  }

  res.json({
    success: false,
    statusCode: 404,
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
}

// ---------------------------------------------------------------------------
// errorHandler – global error handler
// ---------------------------------------------------------------------------

/**
 * Express global error handling middleware.
 * Must be registered with FOUR parameters and AFTER all routes and other
 * middleware.
 *
 * @type {import('express').ErrorRequestHandler}
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const normalizedErr = normalizeError(err);
  const isProduction = process.env.NODE_ENV === 'production';
  const statusCode = normalizedErr.statusCode || 500;

  // ── Logging ───────────────────────────────────────────────────────────────
  const logMeta = {
    statusCode,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userId: req.user ? String(req.user._id) : 'anonymous',
    requestId: req.id || req.headers['x-request-id'],
    userAgent: req.headers['user-agent'],
    ...(normalizedErr.meta || {}),
  };

  if (statusCode >= 500) {
    logger.error(err.message, { ...logMeta, stack: err.stack });
  } else if (statusCode >= 400) {
    logger.warn(normalizedErr.message, logMeta);
  }

  // ── Response ─────────────────────────────────────────────────────────────
  const accept = req.headers.accept || '';
  const isJson = accept.includes('application/json');

  const responseBody = {
    success: false,
    statusCode,
    message: normalizedErr.message,
    ...(normalizedErr.meta && Object.keys(normalizedErr.meta).length > 0
      ? { details: normalizedErr.meta }
      : {}),
    // Include stack trace only in non-production environments and only for
    // operational errors (programming errors expose stack in dev)
    ...(!isProduction ? { stack: err.stack } : {}),
    requestId: req.id || req.headers['x-request-id'],
  };

  if (isJson) {
    return res.status(statusCode).json(responseBody);
  }

  res.status(statusCode);
  if (res.render) {
    try {
      return res.render('errors/error', {
        title: `Error ${statusCode}`,
        statusCode,
        message: normalizedErr.message,
        // Never expose stack in production views
        stack: !isProduction ? err.stack : undefined,
        requestId: req.id,
      });
    } catch {
      // View not found – fall through to JSON
    }
  }

  res.json(responseBody);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  AppError,
  notFound,
  errorHandler,
  normalizeError,
  logger,
};
