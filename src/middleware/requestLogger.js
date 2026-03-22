'use strict';

const morgan = require('morgan');
const winston = require('winston');
const path = require('path');

// ---------------------------------------------------------------------------
// Winston logger
// ---------------------------------------------------------------------------

const transports = [
  new winston.transports.Console({
    silent: process.env.NODE_ENV === 'test',
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf((info) => info.message)
    ),
  }),
];

// In production, also write to a daily rotating file
if (process.env.NODE_ENV === 'production') {
  const DailyRotateFile = require('winston-daily-rotate-file');

  transports.push(
    new DailyRotateFile({
      filename: path.join(process.cwd(), 'logs', 'access-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '50m',
      maxFiles: '30d',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    })
  );
}

const accessLogger = winston.createLogger({
  level: 'http',
  levels: { ...winston.config.npm.levels, http: 5 },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf((info) => info.message)
  ),
  transports,
});

// ---------------------------------------------------------------------------
// Morgan write stream – pipe into winston
// ---------------------------------------------------------------------------

const morganStream = {
  write(message) {
    // Trim trailing newline that morgan appends
    accessLogger.http(message.trimEnd());
  },
};

// ---------------------------------------------------------------------------
// Custom Morgan tokens
// ---------------------------------------------------------------------------

/**
 * :userId – the authenticated user's ID, or '-' for anonymous requests.
 */
morgan.token('userId', (req) => {
  if (req.user && req.user._id) return String(req.user._id);
  return '-';
});

/**
 * :requestId – the X-Request-ID header value (set by security.js).
 */
morgan.token('requestId', (req) => req.id || req.headers['x-request-id'] || '-');

/**
 * :body – a truncated, sanitized snapshot of the request body (never log passwords).
 */
morgan.token('body', (req) => {
  if (!req.body || Object.keys(req.body).length === 0) return '-';

  // Redact sensitive fields
  const redactedBody = Object.assign({}, req.body);
  const SENSITIVE_KEYS = [
    'password',
    'confirmPassword',
    'currentPassword',
    'token',
    'secret',
    'cardNumber',
    'cvv',
    'otp',
  ];
  SENSITIVE_KEYS.forEach((key) => {
    if (redactedBody[key] !== undefined) redactedBody[key] = '[REDACTED]';
  });

  try {
    return JSON.stringify(redactedBody).slice(0, 500);
  } catch {
    return '-';
  }
});

// ---------------------------------------------------------------------------
// Skip predicates
// ---------------------------------------------------------------------------

/**
 * Skip health-check and static-asset requests to reduce log noise.
 * @param {import('express').Request} req
 * @returns {boolean} true = skip logging
 */
function skipHealthChecks(req) {
  const url = req.originalUrl || req.url || '';
  return (
    url === '/health' ||
    url === '/healthz' ||
    url === '/ping' ||
    url.startsWith('/public/') ||
    url.startsWith('/static/') ||
    url.startsWith('/favicon')
  );
}

// ---------------------------------------------------------------------------
// Format strings
// ---------------------------------------------------------------------------

/**
 * Development format – concise, coloured output.
 * ':method :url :status :response-time ms - :res[content-length] - user::userId - :remote-addr'
 */
const DEV_FORMAT =
  ':method :url :status :response-time ms - :res[content-length] - user::userId - :remote-addr';

/**
 * Production format – Apache "combined" with extra fields appended for
 * structured ingestion (e.g. Loki / ELK).
 * The combined format is:
 *   :remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version"
 *   :status :res[content-length] ":referrer" ":user-agent"
 * We append request-ID and user-ID as extra tokens.
 */
const PROD_FORMAT =
  ':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" ' +
  ':status :res[content-length] ":referrer" ":user-agent" ' +
  'rid=:requestId uid=:userId';

// ---------------------------------------------------------------------------
// Exported middleware
// ---------------------------------------------------------------------------

/**
 * Morgan HTTP request logger middleware.
 *
 * - Development: concise single-line format to stdout via winston.
 * - Production: Apache combined format with extra tokens, written to both
 *   stdout and a daily-rotating log file.
 *
 * @type {import('express').RequestHandler}
 */
const requestLogger = morgan(
  process.env.NODE_ENV === 'production' ? PROD_FORMAT : DEV_FORMAT,
  {
    stream: morganStream,
    skip: skipHealthChecks,
    // Immediate mode logs when the request arrives; default logs on response.
    // Keep default (response) so we have the status code and response size.
    immediate: false,
  }
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  requestLogger,
  accessLogger,
  morganStream,
  skipHealthChecks,
  DEV_FORMAT,
  PROD_FORMAT,
};
