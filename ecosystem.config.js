/**
 * PM2 Ecosystem Configuration – InstaFlow SaaS
 *
 * Usage:
 *   pm2 start ecosystem.config.js --env production
 *   pm2 reload ecosystem.config.js --env production   (zero-downtime for cluster apps)
 *   pm2 restart ecosystem.config.js --env production
 *
 * Three process groups:
 *   instaflow-web       – Express HTTP server, runs in cluster mode across all CPUs
 *   instaflow-worker    – BullMQ job processors, 2 instances in cluster mode
 *   instaflow-scheduler – Singleton cron/scheduler (START_SCHEDULER=true), fork mode
 *
 * Logs are written to ./logs/ and rotated by pm2-logrotate.
 * Install: pm2 install pm2-logrotate
 */

"use strict";

module.exports = {
  apps: [
    // =========================================================================
    // Web server
    // Handles all inbound HTTP requests.  Cluster mode distributes connections
    // across all available CPU cores using Node.js built-in cluster module.
    // =========================================================================
    {
      name: "instaflow-web",
      script: "server.js",

      // "max" tells PM2 to spawn one worker per logical CPU core.
      instances: "max",
      exec_mode: "cluster",

      // -------------------------------------------------------------------
      // Memory guard
      // PM2 will perform a graceful reload if a process exceeds 500 MB RSS.
      // The rolling restart keeps at least one instance alive at all times.
      // -------------------------------------------------------------------
      max_memory_restart: "500M",

      // -------------------------------------------------------------------
      // Restart policy
      // -------------------------------------------------------------------
      // Wait 4 s before restarting a crashed process (prevents tight crash loops).
      restart_delay: 4000,
      // Give up after 10 restarts within the min_uptime window.
      max_restarts: 10,
      // A process must stay up for at least 10 s to be considered "stable".
      min_uptime: "10s",
      // Do not watch the filesystem – changes are deployed via pm2 reload.
      watch: false,
      // Source maps support for stack traces pointing at original TypeScript/TS.
      source_map_support: true,

      // -------------------------------------------------------------------
      // Logging
      // -------------------------------------------------------------------
      log_file:        "./logs/pm2-web-combined.log",
      error_file:      "./logs/pm2-web-error.log",
      out_file:        "./logs/pm2-web-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs:      true,

      // -------------------------------------------------------------------
      // Environment
      // These values are MERGED on top of the host environment.
      // Secrets (DB URIs, API keys) live in the server's system environment
      // or a .env file loaded by dotenv at application startup – not here.
      // -------------------------------------------------------------------
      env_production: {
        NODE_ENV:    "production",
        PORT:        3000,
        // Ensure unhandled rejections crash the process so PM2 can restart it.
        NODE_OPTIONS: "--unhandled-rejections=throw",
      },

      env_development: {
        NODE_ENV: "development",
        PORT:     3000,
      },
    },

    // =========================================================================
    // BullMQ job workers
    // Processes Instagram automation jobs, email sends, PDF exports, etc.
    // Runs in cluster mode with 2 instances so one can drain while the other
    // handles new jobs, enabling graceful restarts without job loss.
    //
    // INSTANCE_VAR trick:
    //   PM2 sets the variable named by `instance_var` to the instance index
    //   (0, 1, 2 …).  The worker entrypoint reads process.env.NODE_APP_INSTANCE
    //   and starts the scheduler only on instance 0, ensuring the cron runs
    //   exactly once even when multiple worker processes are alive.
    // =========================================================================
    {
      name: "instaflow-worker",
      script: "src/workers/index.js",

      instances: 2,
      exec_mode: "cluster",

      // Name of the env var PM2 populates with the instance index.
      instance_var: "NODE_APP_INSTANCE",

      max_memory_restart: "400M",
      restart_delay:      4000,
      max_restarts:       10,
      min_uptime:         "10s",
      watch:              false,
      source_map_support: true,

      log_file:        "./logs/pm2-worker-combined.log",
      error_file:      "./logs/pm2-worker-error.log",
      out_file:        "./logs/pm2-worker-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs:      true,

      env_production: {
        NODE_ENV:    "production",
        NODE_OPTIONS: "--unhandled-rejections=throw",
        // The worker entrypoint should check:
        //   const shouldSchedule = process.env.NODE_APP_INSTANCE === "0";
        // START_SCHEDULER is deliberately NOT set here; the scheduler process
        // below is the canonical place for cron jobs.
      },

      env_development: {
        NODE_ENV: "development",
      },
    },

    // =========================================================================
    // Scheduler (singleton)
    // Runs node-cron jobs: Instagram token refresh, subscription renewal checks,
    // analytics aggregation, report emails, etc.
    //
    // Uses fork mode (not cluster) because there must be exactly ONE scheduler
    // instance at a time to avoid duplicate cron firings.
    //
    // If the scheduler crashes PM2 restarts it automatically.
    // =========================================================================
    {
      name: "instaflow-scheduler",
      script: "src/workers/index.js",

      // Singleton – exactly one process.
      instances: 1,
      exec_mode: "fork",

      max_memory_restart: "300M",
      restart_delay:      5000,
      max_restarts:       10,
      min_uptime:         "10s",
      watch:              false,
      source_map_support: true,

      log_file:        "./logs/pm2-scheduler-combined.log",
      error_file:      "./logs/pm2-scheduler-error.log",
      out_file:        "./logs/pm2-scheduler-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs:      true,

      env_production: {
        NODE_ENV:        "production",
        START_SCHEDULER: "true",
        NODE_OPTIONS:    "--unhandled-rejections=throw",
      },

      env_development: {
        NODE_ENV:        "development",
        START_SCHEDULER: "true",
      },
    },
  ],
};
