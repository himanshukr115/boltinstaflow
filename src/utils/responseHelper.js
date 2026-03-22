'use strict';

// ─── Internal Builder ─────────────────────────────────────────────────────────

/**
 * Build a consistent response envelope and send it.
 * @param {import('express').Response} res
 * @param {number}  statusCode
 * @param {object}  body
 * @returns {import('express').Response}
 */
function send(res, statusCode, body) {
  return res.status(statusCode).json({
    ...body,
    timestamp: new Date().toISOString(),
  });
}

// ─── Success Responses ────────────────────────────────────────────────────────

/**
 * Send a generic success response.
 * Shape: { success: true, message, data, timestamp }
 *
 * @param {import('express').Response} res
 * @param {*}      [data=null]        Response payload
 * @param {string} [message='Success']
 * @param {number} [statusCode=200]
 * @returns {import('express').Response}
 */
function success(res, data = null, message = 'Success', statusCode = 200) {
  return send(res, statusCode, {
    success: true,
    message,
    data,
  });
}

/**
 * Send a paginated list response.
 * Shape: { success: true, message, data, pagination, timestamp }
 *
 * @param {import('express').Response} res
 * @param {Array}  data
 * @param {{ total: number, page: number, pages: number, limit: number, hasNext: boolean, hasPrev: boolean }} pagination
 * @param {string} [message='OK']
 * @returns {import('express').Response}
 */
function paginated(res, data, pagination, message = 'OK') {
  return send(res, 200, {
    success: true,
    message,
    data,
    pagination,
  });
}

// ─── Error Responses ──────────────────────────────────────────────────────────

/**
 * Send a generic error response.
 * Shape: { success: false, message, errors, timestamp }
 *
 * @param {import('express').Response} res
 * @param {string} [message='An error occurred']
 * @param {number} [statusCode=500]
 * @param {Array|object|null} [errors=null]   Detailed error list or object
 * @returns {import('express').Response}
 */
function error(res, message = 'An error occurred', statusCode = 500, errors = null) {
  return send(res, statusCode, {
    success: false,
    message,
    errors,
  });
}

/**
 * Send a 401 Unauthorized response.
 * @param {import('express').Response} res
 * @param {string} [message='Unauthorized – authentication is required']
 * @returns {import('express').Response}
 */
function unauthorized(res, message = 'Unauthorized – authentication is required') {
  return send(res, 401, {
    success: false,
    message,
    errors: null,
  });
}

/**
 * Send a 403 Forbidden response.
 * @param {import('express').Response} res
 * @param {string} [message='Forbidden – you do not have permission to perform this action']
 * @returns {import('express').Response}
 */
function forbidden(res, message = 'Forbidden – you do not have permission to perform this action') {
  return send(res, 403, {
    success: false,
    message,
    errors: null,
  });
}

/**
 * Send a 404 Not Found response.
 * @param {import('express').Response} res
 * @param {string} [message='The requested resource was not found']
 * @returns {import('express').Response}
 */
function notFound(res, message = 'The requested resource was not found') {
  return send(res, 404, {
    success: false,
    message,
    errors: null,
  });
}

/**
 * Send a 422 Unprocessable Entity (validation error) response.
 * Shape: { success: false, message, errors: [{field, message},...], timestamp }
 *
 * @param {import('express').Response} res
 * @param {Array<{field: string, message: string}>|string[]} errors
 * @returns {import('express').Response}
 */
function validationError(res, errors) {
  const normalizedErrors = normalizeValidationErrors(errors);
  return send(res, 422, {
    success: false,
    message: 'Validation failed',
    errors: normalizedErrors,
  });
}

/**
 * Send a 429 Too Many Requests response.
 * Sets the Retry-After header when retryAfter is provided.
 *
 * @param {import('express').Response} res
 * @param {number|string} [retryAfter]  Seconds until the client may retry (also sent as header)
 * @returns {import('express').Response}
 */
function tooManyRequests(res, retryAfter) {
  if (retryAfter !== undefined && retryAfter !== null) {
    res.set('Retry-After', String(retryAfter));
  }
  return send(res, 429, {
    success: false,
    message: retryAfter
      ? `Too many requests – please retry after ${retryAfter} seconds`
      : 'Too many requests – please slow down',
    errors: null,
  });
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize a variety of validation error formats into a consistent array.
 * Accepts:
 *   - Array of strings           → [{field: null, message: str}]
 *   - Array of {field, message}  → passed through as-is
 *   - Express-validator result   → mapped to {field, message}
 *   - Mongoose ValidationError   → mapped to {field, message}
 *   - Plain object               → [{field: key, message: value}]
 * @param {*} errors
 * @returns {Array<{field: string|null, message: string}>}
 */
function normalizeValidationErrors(errors) {
  if (!errors) return [];

  // Array of strings or objects
  if (Array.isArray(errors)) {
    return errors.map((e) => {
      if (typeof e === 'string') return { field: null, message: e };
      // express-validator style: { param, msg } or { path, msg }
      if (e.param || e.path) {
        return { field: e.param || e.path, message: e.msg || e.message || String(e) };
      }
      // Already normalised
      if (e.field !== undefined || e.message !== undefined) {
        return { field: e.field || null, message: e.message || String(e) };
      }
      return { field: null, message: String(e) };
    });
  }

  // Mongoose ValidationError
  if (errors.errors && typeof errors.errors === 'object') {
    return Object.entries(errors.errors).map(([field, err]) => ({
      field,
      message: err.message || String(err),
    }));
  }

  // Plain object mapping field → message
  if (typeof errors === 'object') {
    return Object.entries(errors).map(([field, message]) => ({
      field,
      message: typeof message === 'string' ? message : String(message),
    }));
  }

  // Fallback: plain string
  return [{ field: null, message: String(errors) }];
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  success,
  error,
  paginated,
  unauthorized,
  forbidden,
  notFound,
  validationError,
  tooManyRequests,
};
