# InstaFlow SaaS – Deployment Guide

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start with Docker Compose](#quick-start-with-docker-compose)
3. [Manual VPS Setup](#manual-vps-setup)
4. [Environment Variables](#environment-variables)
5. [MongoDB Replica Set Setup](#mongodb-replica-set-setup)
6. [Redis Configuration](#redis-configuration)
7. [Nginx and SSL with Let's Encrypt](#nginx-and-ssl-with-lets-encrypt)
8. [PM2 Setup and Management](#pm2-setup-and-management)
9. [Scaling Guidance](#scaling-guidance)
10. [Monitoring Stack](#monitoring-stack)
11. [Backup and Restore](#backup-and-restore)
12. [Troubleshooting](#troubleshooting)
13. [Security Checklist](#security-checklist)

---

## Prerequisites

### Minimum VPS Specifications

| Resource | Minimum | Recommended (10K concurrent users) |
|----------|---------|-------------------------------------|
| CPU      | 2 vCPU  | 4 vCPU                              |
| RAM      | 4 GB    | 8 GB                                |
| Disk     | 50 GB SSD | 100 GB NVMe SSD                   |
| Network  | 100 Mbps | 1 Gbps                             |
| OS       | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS          |

### Required Software

- Docker Engine 24.x or later
- Docker Compose v2.20 or later
- Git 2.x
- Node.js 18.x (for bare-metal PM2 deployments only)
- PM2 5.x (for bare-metal deployments only)

### Required External Services

- MongoDB Atlas **or** a self-hosted MongoDB 7.0 replica set
- Redis 7.2 (managed or self-hosted)
- A domain name with DNS pointed to your VPS
- SMTP relay (Postmark, SendGrid, or SES)
- Instagram Developer App (approved for Instagram Basic Display or Graph API)
- Razorpay account (or Stripe, if adapted)

---

## Quick Start with Docker Compose

This is the recommended deployment method. The entire stack — app, worker,
MongoDB, Redis, and Nginx — starts with a single command.

### Step 1: Clone the repository

```bash
git clone https://github.com/your-org/instaflow-saas.git /var/www/instaflow
cd /var/www/instaflow
```

### Step 2: Run the server setup script

The setup script installs Docker, configures the firewall, and walks you
through the `.env` configuration interactively.

```bash
sudo bash scripts/setup.sh
```

### Step 3: Generate the MongoDB keyfile

This is required for replica set authentication even with a single node.

```bash
openssl rand -base64 756 > /var/www/instaflow/mongo-keyfile
chmod 400 /var/www/instaflow/mongo-keyfile
sudo chown 999:999 /var/www/instaflow/mongo-keyfile
```

### Step 4: Start the stack

```bash
cd /var/www/instaflow
docker compose up -d
```

### Step 5: Initialise the MongoDB replica set (first run only)

```bash
MONGO_PASS=$(grep '^MONGO_ROOT_PASSWORD=' .env | cut -d= -f2)

docker compose exec mongo mongosh \
  --username admin \
  --password "${MONGO_PASS}" \
  --authenticationDatabase admin \
  --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"mongo:27017"}]})'
```

Verify with:

```bash
docker compose exec mongo mongosh \
  --username admin --password "${MONGO_PASS}" --authenticationDatabase admin \
  --eval 'rs.status().ok'
# Expected output: 1
```

### Step 6: Verify the stack is healthy

```bash
docker compose ps
curl -sf http://localhost:3000/healthz
```

### Step 7: Configure TLS with Let's Encrypt

See the [Nginx and SSL](#nginx-and-ssl-with-lets-encrypt) section below.

---

## Manual VPS Setup

Use this approach if you prefer to run the app with PM2 directly on the host
without Docker.

### Install Node.js 18

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # must be >= 18.0.0
```

### Install PM2

```bash
sudo npm install -g pm2
pm2 --version    # must be >= 5.0.0
```

### Install MongoDB 7.0

```bash
# Import MongoDB public GPG key
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor

echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] \
  https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list

sudo apt-get update
sudo apt-get install -y mongodb-org
sudo systemctl enable --now mongod
mongod --version   # must be >= 7.0
```

### Install Redis 7.2

```bash
curl -fsSL https://packages.redis.io/gpg | \
  sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg

echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] \
  https://packages.redis.io/deb $(lsb_release -cs) main" | \
  sudo tee /etc/apt/sources.list.d/redis.list

sudo apt-get update
sudo apt-get install -y redis
sudo systemctl enable --now redis-server
redis-cli ping   # must return PONG
```

### Clone and configure the app

```bash
git clone https://github.com/your-org/instaflow-saas.git /var/www/instaflow
cd /var/www/instaflow
cp .env.example .env
nano .env   # fill in all required values
npm ci --only=production
npm run build:css
```

### Start with PM2

```bash
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup   # follow the printed command to enable PM2 on boot
```

---

## Environment Variables

All variables must be set in `/var/www/instaflow/.env` before starting
the application. The file must be `chmod 600`.

### Application

| Variable       | Required | Description                                     |
|----------------|----------|-------------------------------------------------|
| `NODE_ENV`     | Yes      | Must be `production`                            |
| `PORT`         | No       | HTTP listen port. Default: `3000`               |
| `DOMAIN`       | Yes      | Public domain name e.g. `instaflow.io`          |

### MongoDB

| Variable              | Required | Description                                                                                        |
|-----------------------|----------|----------------------------------------------------------------------------------------------------|
| `MONGO_URI`           | Yes      | Full connection URI. Example: `mongodb://admin:pass@localhost:27017/instaflow?authSource=admin&replicaSet=rs0` |
| `MONGO_ROOT_USER`     | Yes      | MongoDB root username (Docker Compose only)                                                        |
| `MONGO_ROOT_PASSWORD` | Yes      | MongoDB root password (Docker Compose only). Use `openssl rand -hex 32` to generate.              |
| `MONGO_DB_NAME`       | Yes      | Database name. Default: `instaflow`                                                                |

### Redis

| Variable         | Required | Description                                                          |
|------------------|----------|----------------------------------------------------------------------|
| `REDIS_URL`      | Yes      | Redis connection URL. Example: `redis://:password@localhost:6379`    |
| `REDIS_PASSWORD` | Yes      | Redis AUTH password. Use `openssl rand -hex 32` to generate.        |

### Security

| Variable         | Required | Description                                                          |
|------------------|----------|----------------------------------------------------------------------|
| `SESSION_SECRET` | Yes      | Express session secret. Use `openssl rand -hex 64` to generate.     |
| `JWT_SECRET`     | Yes      | JWT signing secret. Use `openssl rand -hex 64` to generate.         |

### Instagram API

| Variable                          | Required | Description                                  |
|-----------------------------------|----------|----------------------------------------------|
| `INSTAGRAM_APP_ID`                | Yes      | Instagram Developer App ID                   |
| `INSTAGRAM_APP_SECRET`            | Yes      | Instagram Developer App Secret               |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`  | Yes      | Token used to verify webhook subscriptions   |

### Razorpay

| Variable              | Required | Description              |
|-----------------------|----------|--------------------------|
| `RAZORPAY_KEY_ID`     | Yes      | Razorpay API Key ID      |
| `RAZORPAY_KEY_SECRET` | Yes      | Razorpay API Key Secret  |

### SMTP / Email

| Variable    | Required | Description                                    |
|-------------|----------|------------------------------------------------|
| `SMTP_HOST` | Yes      | SMTP server hostname                           |
| `SMTP_PORT` | No       | SMTP port. Default: `587`                      |
| `SMTP_USER` | Yes      | SMTP username or API key                       |
| `SMTP_PASS` | Yes      | SMTP password                                  |
| `EMAIL_FROM`| Yes      | Sender address e.g. `noreply@instaflow.io`     |

### AWS S3 (optional, for backups)

| Variable              | Required | Description                          |
|-----------------------|----------|--------------------------------------|
| `AWS_ACCESS_KEY_ID`   | No       | AWS IAM access key ID                |
| `AWS_SECRET_ACCESS_KEY` | No     | AWS IAM secret access key            |
| `AWS_BACKUP_BUCKET`   | No       | S3 bucket name for MongoDB backups   |
| `AWS_REGION`          | No       | AWS region. Default: `ap-south-1`   |

### Notifications (optional)

| Variable            | Required | Description                                      |
|---------------------|----------|--------------------------------------------------|
| `SLACK_WEBHOOK_URL` | No       | Slack incoming webhook for deploy notifications  |
| `NOTIFY_WEBHOOK_URL`| No       | Generic webhook URL for deploy status updates    |

---

## MongoDB Replica Set Setup

A replica set is required in production for:
- BullMQ change streams (used for real-time job monitoring)
- Multi-document ACID transactions
- Zero-downtime failover

### Docker Compose (single-node replica set)

After the initial `docker compose up -d`, run:

```bash
MONGO_PASS=$(grep '^MONGO_ROOT_PASSWORD=' .env | cut -d= -f2)

docker compose exec mongo mongosh \
  --username admin --password "${MONGO_PASS}" --authenticationDatabase admin \
  --eval '
    rs.initiate({
      _id: "rs0",
      members: [{ _id: 0, host: "mongo:27017" }]
    })
  '
```

### Bare-metal / MongoDB Atlas

For MongoDB Atlas (recommended for production at scale), use the connection
string provided by Atlas. Replica sets are managed automatically.

For bare-metal three-node replica set:

```bash
# On each of the three nodes, edit /etc/mongod.conf:
replication:
  replSetName: "rs0"
net:
  bindIp: 0.0.0.0

# On the primary node, initialise the replica set:
mongosh --eval '
  rs.initiate({
    _id: "rs0",
    members: [
      { _id: 0, host: "mongo1.instaflow.io:27017", priority: 2 },
      { _id: 1, host: "mongo2.instaflow.io:27017", priority: 1 },
      { _id: 2, host: "mongo3.instaflow.io:27017", priority: 1 }
    ]
  })
'
```

### Useful replica set commands

```bash
# Check replica set status
mongosh --eval 'rs.status()'

# Check replication lag
mongosh --eval 'rs.printSecondaryReplicationInfo()'

# Step down primary (useful for maintenance)
mongosh --eval 'rs.stepDown()'
```

---

## Redis Configuration

### Production tuning (applied via Docker Compose command flags)

```
maxmemory 512mb
maxmemory-policy allkeys-lru
appendonly yes
appendfsync everysec
tcp-keepalive 60
timeout 300
```

The `allkeys-lru` eviction policy means Redis will evict the least-recently-
used keys when memory is full, ensuring the cache never fills up and returns
errors to the app. BullMQ job data is stored with TTLs, so eviction is safe.

### Redis persistence

AOF (`appendonly yes`) is enabled with `everysec` fsync. This provides at-most
one second of data loss on crash, which is acceptable for queue data since
BullMQ has at-least-once delivery semantics.

### Redis sentinel / cluster (scaling)

For high availability at scale, use Redis Sentinel (3 nodes) or Redis Cluster
(6 nodes minimum). Update `REDIS_URL` to a Sentinel or cluster connection
string and update the `ioredis` client configuration in `src/config/redis.js`.

---

## Nginx and SSL with Let's Encrypt

### Initial setup (self-signed certificate)

The `scripts/setup.sh` script generates a self-signed certificate so Nginx
can start before you obtain a real certificate. This certificate will trigger
browser warnings – replace it immediately after DNS is configured.

### Obtaining a Let's Encrypt certificate

Ensure the domain points to your server's IP before running:

```bash
# Stop Nginx temporarily if it is running on port 80
docker compose stop nginx

certbot certonly \
  --standalone \
  -d instaflow.io \
  -d www.instaflow.io \
  --email admin@instaflow.io \
  --agree-tos \
  --non-interactive

# Copy certs to the Nginx certs volume directory
cp /etc/letsencrypt/live/instaflow.io/fullchain.pem \
   /var/www/instaflow/nginx/certs/fullchain.pem
cp /etc/letsencrypt/live/instaflow.io/privkey.pem \
   /var/www/instaflow/nginx/certs/privkey.pem
cp /etc/letsencrypt/live/instaflow.io/chain.pem \
   /var/www/instaflow/nginx/certs/chain.pem

docker compose start nginx
```

### Automatic certificate renewal

Certbot installs a systemd timer that runs twice daily. To also reload Nginx
after renewal, add a deploy hook:

```bash
cat > /etc/letsencrypt/renewal-hooks/deploy/instaflow-nginx.sh << 'EOF'
#!/bin/bash
cp /etc/letsencrypt/live/instaflow.io/fullchain.pem \
   /var/www/instaflow/nginx/certs/fullchain.pem
cp /etc/letsencrypt/live/instaflow.io/privkey.pem \
   /var/www/instaflow/nginx/certs/privkey.pem
cp /etc/letsencrypt/live/instaflow.io/chain.pem \
   /var/www/instaflow/nginx/certs/chain.pem
docker exec instaflow-nginx nginx -s reload
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/instaflow-nginx.sh
```

Test the renewal process:

```bash
certbot renew --dry-run
```

---

## PM2 Setup and Management

PM2 is used for bare-metal deployments (not Docker Compose).

### Starting the application

```bash
cd /var/www/instaflow
pm2 start ecosystem.config.js --env production
pm2 save
```

### Common management commands

```bash
# List all processes with status
pm2 list

# Watch real-time logs for all processes
pm2 logs

# Watch logs for a specific process
pm2 logs instaflow-web

# Monitor CPU and memory usage in real time
pm2 monit

# Zero-downtime reload of the web cluster (rolling restart)
pm2 reload instaflow-web --update-env

# Hard restart (brief downtime) of all processes
pm2 restart all --update-env

# Stop all processes
pm2 stop all

# Delete all processes from PM2 registry
pm2 delete all

# Show detailed info for a process
pm2 show instaflow-web

# Flush log files
pm2 flush

# Reload PM2 itself without losing process state
pm2 update
```

### Configuring PM2 to start on server boot

```bash
# Generate and print the startup command for your init system
pm2 startup

# Run the printed command (it starts with "sudo env PATH=...")
# Then save the current process list:
pm2 save
```

### Log rotation with pm2-logrotate

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
```

---

## Scaling Guidance

### When to scale vertically (single server)

- CPU consistently above 70%: upgrade to a larger instance or add vCPUs
- Memory usage above 75%: add RAM, or increase Redis `maxmemory`
- Disk I/O saturated: move MongoDB data to a separate NVMe volume

### When to scale horizontally (multiple servers)

- Sustained traffic above 5,000 concurrent users
- Needing zero-downtime deploys without the rolling-restart window
- Regional latency requirements (multi-region)

### Horizontal scaling approach

1. Put a load balancer (Nginx, HAProxy, or a managed LB) in front of multiple
   app server instances.
2. Move MongoDB to MongoDB Atlas (or a dedicated 3-node replica set).
3. Move Redis to a managed Redis service (Redis Cloud, Elasticache) or
   configure Redis Sentinel (3 nodes) for HA.
4. Use a shared volume (NFS, S3 FUSE, or move uploads to S3 directly) so all
   app instances can access user-uploaded files.

### Redis Cluster setup (6-node minimum)

```bash
# Start 6 Redis nodes (3 primaries + 3 replicas)
redis-cli --cluster create \
  redis1:6379 redis2:6379 redis3:6379 \
  redis4:6379 redis5:6379 redis6:6379 \
  --cluster-replicas 1 \
  -a "${REDIS_PASSWORD}"
```

Update `REDIS_URL` to use the cluster connection format supported by ioredis:
```
REDIS_URL=redis+cluster://user:password@redis1:6379,redis2:6379,redis3:6379
```

### MongoDB Atlas (recommended for production at scale)

1. Create an M10 or larger cluster on MongoDB Atlas.
2. Enable network peering or IP allowlisting.
3. Copy the connection string from Atlas and set it as `MONGO_URI`.
4. The replica set is managed by Atlas; no manual `rs.initiate()` required.

### Performance benchmarks target

The following configuration targets 10,000 concurrent users:

| Component         | Configuration                          | Capacity     |
|-------------------|----------------------------------------|--------------|
| App servers       | 2x 4 vCPU / 8 GB RAM (PM2 cluster)    | ~5K req/s    |
| Nginx             | 1x 2 vCPU (rate limiting + TLS)        | 20K req/s    |
| MongoDB           | Atlas M30 (3-node RS, 8 GB RAM)        | 10K ops/s    |
| Redis             | Redis Cloud 1 GB / Sentinel            | 100K ops/s   |
| BullMQ workers    | 4 worker processes                     | 500 jobs/min |

---

## Monitoring Stack

### Prometheus + Grafana

#### Install Prometheus

```bash
docker run -d \
  --name prometheus \
  --network instaflow_app-network \
  -p 9090:9090 \
  -v /var/www/instaflow/monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro \
  prom/prometheus:latest
```

Sample `prometheus.yml`:

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'instaflow-app'
    static_configs:
      - targets: ['app:3000']
    metrics_path: '/metrics'

  - job_name: 'mongodb-exporter'
    static_configs:
      - targets: ['mongodb-exporter:9216']

  - job_name: 'redis-exporter'
    static_configs:
      - targets: ['redis-exporter:9121']

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']
```

#### Install Grafana

```bash
docker run -d \
  --name grafana \
  --network instaflow_app-network \
  -p 3001:3000 \
  -e GF_SECURITY_ADMIN_PASSWORD=your_grafana_password \
  -v grafana_data:/var/lib/grafana \
  grafana/grafana:latest
```

Import the following Grafana dashboard IDs:
- **Node.js**: 11159 (Node.js Application Dashboard)
- **MongoDB**: 7353 (MongoDB Overview)
- **Redis**: 763 (Redis Dashboard for Prometheus)
- **Nginx**: 12708 (Nginx Exporter)

### Application metrics endpoint

Expose a `/metrics` endpoint in your Express app using `prom-client`:

```bash
npm install prom-client
```

```javascript
// src/middleware/metrics.js
const client = require('prom-client');
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
  registers: [register],
});

module.exports = { register, httpRequestDuration };
```

### Uptime monitoring

Use UptimeRobot, Better Uptime, or a self-hosted Uptime Kuma instance to
monitor `https://instaflow.io/healthz` every 1 minute.

---

## Backup and Restore

### Taking a manual backup

```bash
ENV_FILE=/var/www/instaflow/.env bash /usr/local/bin/instaflow-backup
```

### Restore from a local archive

```bash
# Decompress the archive
tar -xzf /backups/instaflow/instaflow-backup-2025-01-15-02.tar.gz \
  -C /tmp/restore

# Restore to MongoDB
MONGO_PASS=$(grep '^MONGO_ROOT_PASSWORD=' /var/www/instaflow/.env | cut -d= -f2)

mongorestore \
  --uri="mongodb://admin:${MONGO_PASS}@localhost:27017/?authSource=admin" \
  --gzip \
  --drop \
  /tmp/restore/dump

rm -rf /tmp/restore
```

### Restore from S3

```bash
aws s3 cp \
  s3://your-backup-bucket/mongodb-backups/2025/01/instaflow-backup-2025-01-15-02.tar.gz \
  /tmp/instaflow-backup.tar.gz

tar -xzf /tmp/instaflow-backup.tar.gz -C /tmp/restore

mongorestore \
  --uri="mongodb://admin:${MONGO_PASS}@localhost:27017/?authSource=admin" \
  --gzip \
  --drop \
  /tmp/restore/dump
```

### Backup verification

Test your backups monthly:

```bash
# Restore to a test database to verify integrity
mongorestore \
  --uri="mongodb://admin:${MONGO_PASS}@localhost:27017/?authSource=admin" \
  --gzip \
  --nsFrom='instaflow.*' \
  --nsTo='instaflow_restore_test.*' \
  /tmp/restore/dump

# Count documents to confirm data is intact
mongosh --username admin --password "${MONGO_PASS}" --authenticationDatabase admin \
  --eval 'db.getSiblingDB("instaflow_restore_test").users.countDocuments()'

# Drop the test database after verification
mongosh --username admin --password "${MONGO_PASS}" --authenticationDatabase admin \
  --eval 'db.getSiblingDB("instaflow_restore_test").dropDatabase()'
```

---

## Troubleshooting

### App container exits immediately

```bash
# Check container logs
docker compose logs app --tail=100

# Check if port 3000 is already bound
ss -tlnp | grep 3000

# Inspect the container exit code
docker inspect instaflow-app --format='{{.State.ExitCode}}'
```

### Cannot connect to MongoDB

```bash
# Test connectivity from the app container
docker compose exec app mongosh \
  --uri="${MONGO_URI}" \
  --eval 'db.adminCommand("ping")'

# Check if the replica set is initialised
docker compose exec mongo mongosh \
  --username admin --password "${MONGO_PASS}" --authenticationDatabase admin \
  --eval 'rs.status().set'

# Verify the keyfile permissions (must be 400, owned by UID 999)
ls -la /var/www/instaflow/mongo-keyfile
```

### BullMQ jobs not processing

```bash
# Check Redis connectivity
docker compose exec app redis-cli -u "${REDIS_URL}" ping

# Check worker process logs
docker compose logs worker --tail=200

# Check BullMQ queue state via Redis CLI
docker compose exec redis redis-cli -a "${REDIS_PASSWORD}" \
  KEYS "bull:*"

# Pause and resume a queue (useful for draining before redeploy)
# In mongosh: await queue.pause()
```

### Nginx returns 502 Bad Gateway

```bash
# Verify the app container is healthy
docker compose ps app

# Test direct access to the app (bypassing Nginx)
curl -sf http://localhost:3000/healthz

# Check Nginx error log
docker compose logs nginx --tail=50
docker compose exec nginx nginx -t   # test config syntax
```

### High memory usage

```bash
# Show memory usage per container
docker stats --no-stream

# Show PM2 process memory (bare-metal)
pm2 list

# Find the largest MongoDB collections
mongosh --eval '
  db.getSiblingDB("instaflow").runCommand({ dbStats: 1, scale: 1048576 })
'

# Check Redis memory usage
redis-cli -a "${REDIS_PASSWORD}" info memory | grep used_memory_human
```

### Disk full

```bash
# Check disk usage
df -h

# Find largest directories
du -sh /var/www/instaflow/logs/*
du -sh /var/www/instaflow/public/uploads/*
du -sh /var/lib/docker/

# Prune old Docker images
docker image prune -a --filter "until=72h"

# Prune old log archives
find /var/www/instaflow/logs -name "*.gz" -mtime +14 -delete
```

---

## Security Checklist

Use this checklist before going live and after each major deployment.

### Server hardening

- [ ] OS is fully patched: `sudo apt-get update && sudo apt-get upgrade -y`
- [ ] UFW firewall is active: only ports 22, 80, 443 are open
- [ ] SSH password authentication is disabled (`PasswordAuthentication no` in `/etc/ssh/sshd_config`)
- [ ] SSH root login is disabled (`PermitRootLogin no`)
- [ ] Fail2ban is installed and configured to block brute-force SSH attempts
- [ ] Non-root user is used for all application operations

### Application secrets

- [ ] `.env` file has `chmod 600` and is owned by the app user
- [ ] `.env` is in `.gitignore` and has never been committed to the repository
- [ ] `SESSION_SECRET` is at least 64 random bytes
- [ ] `JWT_SECRET` is at least 64 random bytes
- [ ] MongoDB root password is a random 32-byte hex string
- [ ] Redis password is a random 32-byte hex string
- [ ] All API keys (Instagram, Razorpay, SMTP) are stored only in `.env`

### TLS / HTTPS

- [ ] TLS certificate is valid and not self-signed (Let's Encrypt or CA-issued)
- [ ] Certificate expiry is monitored (certbot timer is active)
- [ ] HSTS header is present with `includeSubDomains; preload`
- [ ] TLS 1.0 and 1.1 are disabled (only 1.2 and 1.3 allowed)
- [ ] SSL Labs scan returns grade A or A+: https://www.ssllabs.com/ssltest/
- [ ] DH parameters are 2048-bit minimum (`dhparam.pem`)

### HTTP security headers

- [ ] `X-Frame-Options: DENY`
- [ ] `X-Content-Type-Options: nosniff`
- [ ] `Strict-Transport-Security` with `max-age=63072000`
- [ ] `Content-Security-Policy` is configured and tested
- [ ] `Referrer-Policy` is set
- [ ] `Permissions-Policy` disables unnecessary browser features

### Database

- [ ] MongoDB requires authentication (`--auth` flag is set)
- [ ] MongoDB is not accessible from the public internet (bound to internal network only)
- [ ] Redis requires a password (`requirepass` is set)
- [ ] Redis is not accessible from the public internet
- [ ] MongoDB replica set keyfile permissions are `400`
- [ ] Automated backups are running and tested

### Dependency security

- [ ] `npm audit` reports no high or critical vulnerabilities: `npm audit --audit-level=high`
- [ ] Dependencies are kept up to date (use Dependabot or Renovate)
- [ ] Docker images are pinned to specific version tags, not `latest`

### Rate limiting and abuse prevention

- [ ] Nginx rate limiting is active (100 req/min general, 500 req/min webhooks)
- [ ] Express `express-rate-limit` middleware is active on the API routes
- [ ] Instagram webhook verify token is a random string, not a dictionary word
- [ ] Account registration is protected by CAPTCHA or email verification

### Monitoring and alerting

- [ ] Health check endpoint is monitored externally (UptimeRobot, Better Uptime)
- [ ] Alerts are configured for CPU > 85%, memory > 85%, disk > 80%
- [ ] PM2 restart events trigger Slack notifications
- [ ] Failed deployments trigger Slack/PagerDuty alerts
- [ ] MongoDB and Redis backup success/failure is logged and monitored
