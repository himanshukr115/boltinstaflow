require('dotenv').config();
const http = require('http');
const cluster = require('cluster');
const os = require('os');

console.log('[STARTUP] Loading server modules...');

const logger = require('./src/config/logger');
const { connectDB } = require('./src/config/database');
const { getRedisClient } = require('./src/config/redis');
const { createApp } = require('./src/app');

console.log('[STARTUP] Core modules loaded');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const WORKERS = parseInt(process.env.WEB_CONCURRENCY, 10) || (process.env.NODE_ENV === 'production' ? os.cpus().length : 1);

async function startServer() {
  console.log('[STARTUP] Starting InstaFlow server...');

  try {
    console.log('[STARTUP] Connecting to MongoDB...');
    await connectDB();
    console.log('[STARTUP] MongoDB connection attempt completed');
    logger.info('Database connection attempt completed');

    console.log('[STARTUP] Connecting to Redis...');
    try {
      const redis = getRedisClient();
      await Promise.race([
        redis.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      console.log('[STARTUP] Redis connected successfully');
      logger.info('Redis connection established');
    } catch (redisErr) {
      console.warn(`[STARTUP] Redis unavailable (${redisErr.message}) - continuing without Redis`);
      logger.warn(`Redis unavailable (${redisErr.message}) - continuing without Redis`);
    }

    console.log('[STARTUP] Loading scheduler...');
    let startScheduler;
    try {
      startScheduler = require('./src/workers/scheduler').startScheduler;
      console.log('[STARTUP] Scheduler module loaded');
    } catch (schedErr) {
      console.error('[STARTUP] Failed to load scheduler:', schedErr.message);
      logger.error('Failed to load scheduler', schedErr);
      startScheduler = null;
    }

    console.log('[STARTUP] Creating Express app...');
    let app;
    try {
      app = createApp();
      console.log('[STARTUP] Express app created successfully');
    } catch (appErr) {
      console.error('[STARTUP] Failed to create Express app:', appErr.message);
      console.error('[STARTUP] Stack:', appErr.stack);
      throw appErr;
    }

    const server = http.createServer(app);

    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    server.timeout = 30000;
    server.maxConnections = 10000;

    console.log(`[STARTUP] Starting HTTP server on ${HOST}:${PORT}...`);
    server.listen(PORT, HOST, () => {
      console.log(`[STARTUP] HTTP server listening on http://${HOST}:${PORT}`);
      logger.info(`InstaFlow server running on ${HOST}:${PORT} [${process.env.NODE_ENV || 'development'}] PID:${process.pid}`);
    });

    server.on('error', (err) => {
      console.error('[STARTUP] HTTP server error:', err.message);
      if (err.code === 'EADDRINUSE') {
        console.error(`[STARTUP] Port ${PORT} is already in use`);
      }
    });

    if (process.env.START_SCHEDULER !== 'false' && startScheduler) {
      console.log('[STARTUP] Starting cron scheduler...');
      try {
        startScheduler();
        console.log('[STARTUP] Cron scheduler started');
        logger.info('Scheduler started');
      } catch (schedStartErr) {
        console.error('[STARTUP] Scheduler failed to start:', schedStartErr.message);
        logger.error('Scheduler start error', schedStartErr);
      }
    } else if (!startScheduler) {
      console.warn('[STARTUP] Scheduler skipped (failed to load)');
    }

    const shutdown = async (signal) => {
      logger.info(`Received ${signal}. Gracefully shutting down...`);

      server.close(async () => {
        logger.info('HTTP server closed');
        try {
          const mongoose = require('mongoose');
          await mongoose.connection.close();
          logger.info('MongoDB connection closed');

          const redis = getRedisClient();
          redis.disconnect();
          logger.info('Redis connection closed');

          process.exit(0);
        } catch (err) {
          logger.error('Error during shutdown:', err);
          process.exit(1);
        }
      });

      setTimeout(() => {
        logger.error('Forceful shutdown after timeout');
        process.exit(1);
      }, 30000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (err) => {
      console.error('[ERROR] Uncaught Exception:', err.message);
      console.error('[ERROR] Stack:', err.stack);
      logger.error('Uncaught Exception:', err);
      if (process.env.NODE_ENV === 'production') {
        shutdown('uncaughtException');
      }
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('[ERROR] Unhandled Rejection:', reason instanceof Error ? reason.message : reason);
      if (reason instanceof Error) console.error('[ERROR] Stack:', reason.stack);
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    return server;
  } catch (err) {
    console.error('[STARTUP] FATAL: Failed to start server:', err.message);
    console.error('[STARTUP] Stack:', err.stack);
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV === 'production' && WORKERS > 1 && cluster.isPrimary) {
  logger.info(`Primary ${process.pid} starting ${WORKERS} workers`);

  for (let i = 0; i < WORKERS; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    logger.warn(`Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    cluster.fork();
  });

  cluster.on('online', (worker) => {
    logger.info(`Worker ${worker.process.pid} is online`);
  });
} else {
  startServer().catch((err) => {
    console.error('[STARTUP] Startup error:', err.message);
    logger.error('Startup error:', err);
    process.exit(1);
  });
}

module.exports = { startServer };
