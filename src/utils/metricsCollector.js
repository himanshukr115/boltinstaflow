'use strict';

/**
 * Application Metrics Collector
 *
 * Stores counters and histograms in Redis using structured key namespaces.
 * Designed to be scraped by a /metrics endpoint and forwarded to Prometheus
 * (via prom-client push-gateway or direct text exposition).
 *
 * Key scheme:
 *   metrics:req:{method}:{route}:{statusCode}  → INCR counter
 *   metrics:req_duration:{method}:{route}       → JSON list of durations (ms)
 *   metrics:err:{type}                          → INCR counter
 *   metrics:queue:{queueName}:{jobType}:count   → INCR counter
 *   metrics:queue:{queueName}:{jobType}:duration→ JSON list of durations
 *   metrics:queue:{queueName}:{jobType}:failures→ INCR counter
 *
 * All keys are given a 25-hour TTL so stale data does not accumulate.
 */

const { getRedisClient } = require('../config/redis');
const logger = require('../config/logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const KEY_PREFIX = 'metrics:';
const TTL_SECONDS = 25 * 60 * 60;              // 25 hours rolling window
const MAX_DURATION_SAMPLES = 1000;              // cap per key to avoid memory blow-up
const APP_NAME = process.env.APP_NAME || 'instabot';
const APP_ENV = process.env.NODE_ENV || 'development';

// ─── Key Helpers ──────────────────────────────────────────────────────────────

function safeSegment(str) {
  // Replace characters that would break Prometheus label syntax or Redis key conventions
  return String(str).replace(/[^a-zA-Z0-9_\-/.]/g, '_').slice(0, 64);
}

function reqCountKey(method, route, statusCode) {
  return `${KEY_PREFIX}req:${safeSegment(method)}:${safeSegment(route)}:${statusCode}`;
}

function reqDurationKey(method, route) {
  return `${KEY_PREFIX}req_duration:${safeSegment(method)}:${safeSegment(route)}`;
}

function errKey(type) {
  return `${KEY_PREFIX}err:${safeSegment(type)}`;
}

function queueCountKey(queueName, jobType, succeeded) {
  const suffix = succeeded ? 'success' : 'failure';
  return `${KEY_PREFIX}queue:${safeSegment(queueName)}:${safeSegment(jobType)}:${suffix}`;
}

function queueDurationKey(queueName, jobType) {
  return `${KEY_PREFIX}queue_duration:${safeSegment(queueName)}:${safeSegment(jobType)}`;
}

// ─── Redis helpers ────────────────────────────────────────────────────────────

/**
 * Increment a Redis key and refresh its TTL.
 * Silently swallows errors so metrics never crash the request.
 * @param {string} key
 * @param {number} [amount=1]
 */
async function redisIncr(key, amount = 1) {
  try {
    const client = getRedisClient();
    const pipeline = client.pipeline();
    pipeline.incrby(key, amount);
    pipeline.expire(key, TTL_SECONDS);
    await pipeline.exec();
  } catch (err) {
    logger.debug(`[Metrics] redisIncr failed for key "${key}": ${err.message}`);
  }
}

/**
 * Push a numeric sample to a capped Redis list.
 * @param {string} key
 * @param {number} value
 */
async function redisPushSample(key, value) {
  try {
    const client = getRedisClient();
    const pipeline = client.pipeline();
    pipeline.rpush(key, String(value));
    pipeline.ltrim(key, -MAX_DURATION_SAMPLES, -1);   // keep only the last N entries
    pipeline.expire(key, TTL_SECONDS);
    await pipeline.exec();
  } catch (err) {
    logger.debug(`[Metrics] redisPushSample failed for key "${key}": ${err.message}`);
  }
}

/**
 * Retrieve all keys matching a pattern and their values.
 * @param {string} pattern  Redis KEYS glob pattern
 * @returns {Promise<Array<{key: string, value: string}>>}
 */
async function redisScan(pattern) {
  const results = [];
  try {
    const client = getRedisClient();
    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        const values = await client.mget(...keys);
        for (let i = 0; i < keys.length; i++) {
          results.push({ key: keys[i], value: values[i] });
        }
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.debug(`[Metrics] redisScan failed for pattern "${pattern}": ${err.message}`);
  }
  return results;
}

/**
 * Retrieve all entries in a Redis list as numbers.
 * @param {string} key
 * @returns {Promise<number[]>}
 */
async function redisLrange(key) {
  try {
    const client = getRedisClient();
    const items = await client.lrange(key, 0, -1);
    return items.map(Number).filter((n) => !isNaN(n));
  } catch {
    return [];
  }
}

// ─── Statistical helpers ──────────────────────────────────────────────────────

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a single HTTP request.
 * @param {string} method       HTTP method (GET, POST, …)
 * @param {string} route        Route pattern (e.g. /api/v1/users/:id)
 * @param {number} statusCode   HTTP status code
 * @param {number} duration     Response time in milliseconds
 */
async function recordRequest(method, route, statusCode, duration) {
  const normalizedMethod = String(method).toUpperCase();
  const normalizedStatus = parseInt(statusCode, 10) || 0;

  await Promise.all([
    redisIncr(reqCountKey(normalizedMethod, route, normalizedStatus)),
    redisPushSample(reqDurationKey(normalizedMethod, route), duration),
  ]);
}

/**
 * Record an application error event.
 * @param {string} type      Error category (e.g. 'ValidationError', 'MongoError', 'UnhandledRejection')
 * @param {string} [message] Optional message (for structured logging only, not stored in Redis)
 */
async function recordError(type, message) {
  const errorType = safeSegment(type || 'UnknownError');
  if (message) {
    logger.debug(`[Metrics] Error recorded – type=${errorType} msg=${message}`);
  }
  await redisIncr(errKey(errorType));
}

/**
 * Record a BullMQ job execution.
 * @param {string}  queueName  Queue name (e.g. 'email', 'automation')
 * @param {string}  jobType    Job name/type
 * @param {number}  duration   Processing time in milliseconds
 * @param {boolean} success    Whether the job completed successfully
 */
async function recordQueueMetric(queueName, jobType, duration, success) {
  await Promise.all([
    redisIncr(queueCountKey(queueName, jobType, success)),
    redisPushSample(queueDurationKey(queueName, jobType), duration),
  ]);
}

/**
 * Retrieve all metrics and aggregate them into a structured object.
 * This is designed to be called by a /metrics route handler.
 * @returns {Promise<object>}
 */
async function getMetrics() {
  const metrics = {
    app: APP_NAME,
    env: APP_ENV,
    collectedAt: new Date().toISOString(),
    requests: {},
    errors: {},
    queues: {},
  };

  // ── Request counters ───────────────────────────────────────────────────────
  const reqCountEntries = await redisScan(`${KEY_PREFIX}req:*`);
  for (const { key, value } of reqCountEntries) {
    // key format: metrics:req:{method}:{route}:{statusCode}
    const parts = key.replace(KEY_PREFIX + 'req:', '').split(':');
    if (parts.length < 3) continue;
    const statusCode = parts[parts.length - 1];
    const method = parts[0];
    const route = parts.slice(1, -1).join(':');
    const labelKey = `${method} ${route}`;
    if (!metrics.requests[labelKey]) {
      metrics.requests[labelKey] = { statusCodes: {}, p50_ms: 0, p95_ms: 0, p99_ms: 0, avg_ms: 0, total: 0 };
    }
    metrics.requests[labelKey].statusCodes[statusCode] = parseInt(value, 10) || 0;
    metrics.requests[labelKey].total += parseInt(value, 10) || 0;
  }

  // ── Request durations ──────────────────────────────────────────────────────
  const reqDurationKeys = await redisScan(`${KEY_PREFIX}req_duration:*`);
  for (const { key } of reqDurationKeys) {
    const routePart = key.replace(KEY_PREFIX + 'req_duration:', '');
    const colonIdx = routePart.indexOf(':');
    if (colonIdx === -1) continue;
    const method = routePart.slice(0, colonIdx);
    const route = routePart.slice(colonIdx + 1);
    const labelKey = `${method} ${route}`;
    const samples = await redisLrange(key);
    if (samples.length) {
      samples.sort((a, b) => a - b);
      if (!metrics.requests[labelKey]) {
        metrics.requests[labelKey] = { statusCodes: {}, p50_ms: 0, p95_ms: 0, p99_ms: 0, avg_ms: 0, total: 0 };
      }
      metrics.requests[labelKey].p50_ms = Math.round(percentile(samples, 50));
      metrics.requests[labelKey].p95_ms = Math.round(percentile(samples, 95));
      metrics.requests[labelKey].p99_ms = Math.round(percentile(samples, 99));
      metrics.requests[labelKey].avg_ms = Math.round(avg(samples));
      metrics.requests[labelKey].sampleCount = samples.length;
    }
  }

  // ── Error counters ─────────────────────────────────────────────────────────
  const errEntries = await redisScan(`${KEY_PREFIX}err:*`);
  for (const { key, value } of errEntries) {
    const errorType = key.replace(KEY_PREFIX + 'err:', '');
    metrics.errors[errorType] = parseInt(value, 10) || 0;
  }

  // ── Queue success/failure counters ─────────────────────────────────────────
  const queueCountEntries = await redisScan(`${KEY_PREFIX}queue:*`);
  for (const { key, value } of queueCountEntries) {
    // key format: metrics:queue:{queueName}:{jobType}:{success|failure}
    const parts = key.replace(KEY_PREFIX + 'queue:', '').split(':');
    if (parts.length < 3) continue;
    const outcome = parts[parts.length - 1];           // success | failure
    const jobType = parts[parts.length - 2];
    const queueName = parts.slice(0, -2).join(':');
    const qKey = `${queueName}:${jobType}`;
    if (!metrics.queues[qKey]) {
      metrics.queues[qKey] = { success: 0, failure: 0, p50_ms: 0, p95_ms: 0, avg_ms: 0 };
    }
    metrics.queues[qKey][outcome] = parseInt(value, 10) || 0;
  }

  // ── Queue duration samples ─────────────────────────────────────────────────
  const queueDurationEntries = await redisScan(`${KEY_PREFIX}queue_duration:*`);
  for (const { key } of queueDurationEntries) {
    const routePart = key.replace(KEY_PREFIX + 'queue_duration:', '');
    const colonIdx = routePart.indexOf(':');
    if (colonIdx === -1) continue;
    const queueName = routePart.slice(0, colonIdx);
    const jobType = routePart.slice(colonIdx + 1);
    const qKey = `${queueName}:${jobType}`;
    const samples = await redisLrange(key);
    if (samples.length) {
      samples.sort((a, b) => a - b);
      if (!metrics.queues[qKey]) {
        metrics.queues[qKey] = { success: 0, failure: 0, p50_ms: 0, p95_ms: 0, avg_ms: 0 };
      }
      metrics.queues[qKey].p50_ms = Math.round(percentile(samples, 50));
      metrics.queues[qKey].p95_ms = Math.round(percentile(samples, 95));
      metrics.queues[qKey].avg_ms = Math.round(avg(samples));
      metrics.queues[qKey].sampleCount = samples.length;
    }
  }

  return metrics;
}

/**
 * Serialize metrics in Prometheus text exposition format (version 0.0.4).
 * Suitable for direct consumption by a Prometheus scraper.
 * @returns {Promise<string>} Prometheus text format string
 */
async function getPrometheusMetrics() {
  const data = await getMetrics();
  const lines = [];
  const appLabel = `app="${APP_NAME}",env="${APP_ENV}"`;

  // ── Request counters ───────────────────────────────────────────────────────
  lines.push('# HELP http_requests_total Total number of HTTP requests');
  lines.push('# TYPE http_requests_total counter');
  for (const [route, stats] of Object.entries(data.requests)) {
    const [method, ...routeParts] = route.split(' ');
    const routePath = routeParts.join(' ');
    for (const [status, count] of Object.entries(stats.statusCodes)) {
      lines.push(
        `http_requests_total{${appLabel},method="${method}",route="${routePath}",status="${status}"} ${count}`
      );
    }
  }

  // ── Request duration histograms (summary approximation) ───────────────────
  lines.push('# HELP http_request_duration_ms HTTP request duration in milliseconds');
  lines.push('# TYPE http_request_duration_ms summary');
  for (const [route, stats] of Object.entries(data.requests)) {
    const [method, ...routeParts] = route.split(' ');
    const routePath = routeParts.join(' ');
    const baseLabel = `${appLabel},method="${method}",route="${routePath}"`;
    lines.push(`http_request_duration_ms{${baseLabel},quantile="0.5"} ${stats.p50_ms}`);
    lines.push(`http_request_duration_ms{${baseLabel},quantile="0.95"} ${stats.p95_ms}`);
    lines.push(`http_request_duration_ms{${baseLabel},quantile="0.99"} ${stats.p99_ms}`);
    lines.push(`http_request_duration_ms_avg{${baseLabel}} ${stats.avg_ms}`);
  }

  // ── Error counters ─────────────────────────────────────────────────────────
  lines.push('# HELP app_errors_total Total number of application errors by type');
  lines.push('# TYPE app_errors_total counter');
  for (const [type, count] of Object.entries(data.errors)) {
    lines.push(`app_errors_total{${appLabel},type="${type}"} ${count}`);
  }

  // ── Queue metrics ──────────────────────────────────────────────────────────
  lines.push('# HELP queue_jobs_total Total number of queue jobs processed');
  lines.push('# TYPE queue_jobs_total counter');
  for (const [qKey, stats] of Object.entries(data.queues)) {
    const [queue, job] = qKey.split(':');
    const baseLabel = `${appLabel},queue="${queue}",job="${job}"`;
    lines.push(`queue_jobs_total{${baseLabel},outcome="success"} ${stats.success}`);
    lines.push(`queue_jobs_total{${baseLabel},outcome="failure"} ${stats.failure}`);
  }

  lines.push('# HELP queue_job_duration_ms Queue job processing duration in milliseconds');
  lines.push('# TYPE queue_job_duration_ms summary');
  for (const [qKey, stats] of Object.entries(data.queues)) {
    const [queue, job] = qKey.split(':');
    const baseLabel = `${appLabel},queue="${queue}",job="${job}"`;
    lines.push(`queue_job_duration_ms{${baseLabel},quantile="0.5"} ${stats.p50_ms}`);
    lines.push(`queue_job_duration_ms{${baseLabel},quantile="0.95"} ${stats.p95_ms}`);
    lines.push(`queue_job_duration_ms_avg{${baseLabel}} ${stats.avg_ms}`);
  }

  // Prometheus text format requires a trailing newline
  return lines.join('\n') + '\n';
}

/**
 * Express middleware that records request metrics automatically.
 * Mount once via app.use(metricsCollector.requestMiddleware()).
 * @returns {import('express').RequestHandler}
 */
function requestMiddleware() {
  return function metricsMiddleware(req, res, next) {
    const startTime = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      // Normalise dynamic route segments so metrics don't explode with cardinality
      // Express sets req.route.path when a route is matched
      const route =
        (req.route && req.route.path) ||
        req.path ||
        'unknown';

      recordRequest(req.method, route, res.statusCode, duration).catch(() => {
        // never let metrics break the app
      });
    });

    next();
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  recordRequest,
  recordError,
  getMetrics,
  recordQueueMetric,
  getPrometheusMetrics,
  requestMiddleware,
};
