#!/usr/bin/env bash
# =============================================================================
# deploy.sh – Zero-downtime deployment for InstaFlow SaaS (bare-metal / PM2)
#
# Prerequisites:
#   - PM2 installed globally: npm install -g pm2
#   - App cloned to APP_DIR
#   - .env present and configured
#   - MongoDB and Redis running
#
# Usage:
#   bash scripts/deploy.sh [--skip-tests] [--branch <branch>]
#
# What it does:
#   1. Pulls latest code from git
#   2. Installs production dependencies
#   3. Builds CSS (Tailwind)
#   4. Runs database seeder / migrations (idempotent)
#   5. Zero-downtime reload of the web cluster via PM2
#   6. Restarts the worker and scheduler processes
#   7. Polls /healthz with retry logic
#   8. Rolls back to previous commit if health check fails
#   9. Sends Slack / webhook notification on success or failure
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration – override via environment variables before calling the script
# ---------------------------------------------------------------------------
APP_DIR="${APP_DIR:-/var/www/instaflow}"
BRANCH="${BRANCH:-main}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/healthz}"
HEALTH_MAX_ATTEMPTS="${HEALTH_MAX_ATTEMPTS:-10}"
HEALTH_RETRY_DELAY="${HEALTH_RETRY_DELAY:-5}"
# Slack incoming webhook URL (optional; leave empty to skip notifications)
SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"
# Generic webhook URL (optional, receives JSON POST on success/failure)
NOTIFY_WEBHOOK_URL="${NOTIFY_WEBHOOK_URL:-}"
LOG_FILE="${APP_DIR}/logs/deploy.log"

# ---------------------------------------------------------------------------
# Colour / logging helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'

log()     { echo -e "${BLUE}[$(date -u +"%H:%M:%S")]${NC} $*" | tee -a "${LOG_FILE}"; }
success() { echo -e "${GREEN}[$(date -u +"%H:%M:%S")] OK${NC} $*" | tee -a "${LOG_FILE}"; }
warn()    { echo -e "${YELLOW}[$(date -u +"%H:%M:%S")] WARN${NC} $*" | tee -a "${LOG_FILE}"; }
error()   { echo -e "${RED}[$(date -u +"%H:%M:%S")] ERROR${NC} $*" | tee -a "${LOG_FILE}" >&2; }

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
SKIP_TESTS=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-tests) SKIP_TESTS=true; shift ;;
        --branch)     BRANCH="$2"; shift 2 ;;
        *) error "Unknown argument: $1"; exit 1 ;;
    esac
done

# ---------------------------------------------------------------------------
# Validate environment
# ---------------------------------------------------------------------------
[[ -d "${APP_DIR}" ]] || { error "APP_DIR ${APP_DIR} does not exist."; exit 1; }
command -v pm2 &>/dev/null || { error "pm2 is not installed. Run: npm install -g pm2"; exit 1; }
command -v git &>/dev/null || { error "git is not installed."; exit 1; }
mkdir -p "$(dirname "${LOG_FILE}")"

# ---------------------------------------------------------------------------
# Record deployment start time and current commit for rollback
# ---------------------------------------------------------------------------
DEPLOY_START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cd "${APP_DIR}"

PREVIOUS_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
log "Deploy started at ${DEPLOY_START}"
log "APP_DIR         : ${APP_DIR}"
log "Branch          : ${BRANCH}"
log "Previous commit : ${PREVIOUS_COMMIT}"

# ---------------------------------------------------------------------------
# Notification helpers
# ---------------------------------------------------------------------------
notify_slack() {
    local status="$1" message="$2"
    [[ -z "${SLACK_WEBHOOK_URL}" ]] && return 0

    local icon=":white_check_mark:"
    [[ "${status}" == "failure" ]] && icon=":x:"

    local payload
    payload=$(printf '{"text": "%s *InstaFlow Deploy %s*\\n%s"}' \
        "${icon}" "${status}" "${message}")

    curl -sf -X POST \
        -H 'Content-type: application/json' \
        --data "${payload}" \
        "${SLACK_WEBHOOK_URL}" >/dev/null 2>&1 || \
        warn "Failed to send Slack notification."
}

notify_webhook() {
    local status="$1" message="$2"
    [[ -z "${NOTIFY_WEBHOOK_URL}" ]] && return 0

    local payload
    payload=$(printf '{"status":"%s","app":"instaflow","message":"%s","commit":"%s","timestamp":"%s"}' \
        "${status}" "${message}" "${CURRENT_COMMIT:-unknown}" "${DEPLOY_START}")

    curl -sf -X POST \
        -H 'Content-type: application/json' \
        --data "${payload}" \
        "${NOTIFY_WEBHOOK_URL}" >/dev/null 2>&1 || \
        warn "Failed to send webhook notification."
}

# ---------------------------------------------------------------------------
# Rollback function – called on health check failure
# ---------------------------------------------------------------------------
rollback() {
    error "Health check failed. Initiating rollback to ${PREVIOUS_COMMIT}..."

    cd "${APP_DIR}"
    git checkout "${PREVIOUS_COMMIT}" -- . 2>&1 | tee -a "${LOG_FILE}" || {
        error "git checkout rollback failed. Manual intervention required."
        notify_slack "failure" "Rollback FAILED. Manual intervention required. Previous commit: ${PREVIOUS_COMMIT}"
        notify_webhook "rollback_failed" "Rollback failed – manual intervention required"
        exit 1
    }

    # Re-install deps for the rolled-back version
    npm ci --only=production 2>&1 | tee -a "${LOG_FILE}" || true

    # Zero-downtime reload back to the old code
    pm2 reload instaflow-web --update-env 2>&1 | tee -a "${LOG_FILE}" || true
    pm2 restart instaflow-worker  2>&1 | tee -a "${LOG_FILE}" || true
    pm2 restart instaflow-scheduler 2>&1 | tee -a "${LOG_FILE}" || true

    error "Rollback complete. App is running commit ${PREVIOUS_COMMIT}."
    notify_slack "failure" "Deployment rolled back to ${PREVIOUS_COMMIT}"
    notify_webhook "rollback_success" "Rolled back to ${PREVIOUS_COMMIT}"
    exit 1
}

# ---------------------------------------------------------------------------
# Step 1: Pull latest code
# ---------------------------------------------------------------------------
log "Step 1/7 – Pulling latest code from origin/${BRANCH}..."
git fetch origin "${BRANCH}" 2>&1 | tee -a "${LOG_FILE}"
git checkout "${BRANCH}"    2>&1 | tee -a "${LOG_FILE}"
git pull origin "${BRANCH}" 2>&1 | tee -a "${LOG_FILE}"

CURRENT_COMMIT=$(git rev-parse HEAD)
log "New commit: ${CURRENT_COMMIT}"

if [[ "${CURRENT_COMMIT}" == "${PREVIOUS_COMMIT}" ]]; then
    warn "No new commits. Nothing to deploy."
    exit 0
fi

# ---------------------------------------------------------------------------
# Step 2: Install production dependencies
# ---------------------------------------------------------------------------
log "Step 2/7 – Installing production dependencies..."
npm ci --only=production 2>&1 | tee -a "${LOG_FILE}"
success "npm ci completed."

# ---------------------------------------------------------------------------
# Step 3: Build CSS
# ---------------------------------------------------------------------------
log "Step 3/7 – Building Tailwind CSS..."
# Install dev deps temporarily for the build, then remove them
npm install --include=dev --ignore-scripts 2>&1 | tee -a "${LOG_FILE}"
npm run build:css 2>&1 | tee -a "${LOG_FILE}"
# Remove dev deps to keep the installation clean for production
npm prune --production 2>&1 | tee -a "${LOG_FILE}"
success "CSS build complete."

# ---------------------------------------------------------------------------
# Step 4: Run database seeder / migrations
# ---------------------------------------------------------------------------
log "Step 4/7 – Running database seeder (idempotent)..."
node src/utils/seeder.js 2>&1 | tee -a "${LOG_FILE}" || {
    warn "Seeder exited with non-zero code. Check logs. Continuing deploy..."
}
success "Seeder complete."

# ---------------------------------------------------------------------------
# Step 5: Zero-downtime reload of the web cluster
# pm2 reload performs a rolling restart: it brings up one new worker,
# waits for it to become ready (listen_timeout), then kills the old one.
# At least one instance is always serving traffic during the reload.
# ---------------------------------------------------------------------------
log "Step 5/7 – Zero-downtime reload of instaflow-web..."
pm2 reload instaflow-web --update-env 2>&1 | tee -a "${LOG_FILE}"
success "instaflow-web reloaded."

# ---------------------------------------------------------------------------
# Step 6: Restart worker and scheduler
# Workers processing jobs can be restarted immediately; in-progress jobs
# are picked up again by BullMQ's at-least-once delivery guarantee.
# ---------------------------------------------------------------------------
log "Step 6/7 – Restarting worker and scheduler..."
pm2 restart instaflow-worker    --update-env 2>&1 | tee -a "${LOG_FILE}"
pm2 restart instaflow-scheduler --update-env 2>&1 | tee -a "${LOG_FILE}"
success "Workers restarted."

# ---------------------------------------------------------------------------
# Step 7: Health check with retry
# ---------------------------------------------------------------------------
log "Step 7/7 – Health check (${HEALTH_MAX_ATTEMPTS} attempts, ${HEALTH_RETRY_DELAY}s delay)..."

HEALTHY=false
for attempt in $(seq 1 "${HEALTH_MAX_ATTEMPTS}"); do
    log "  Attempt ${attempt}/${HEALTH_MAX_ATTEMPTS} → ${HEALTH_URL}"
    HTTP_STATUS=$(curl -sf --max-time 10 -o /dev/null -w "%{http_code}" \
        "${HEALTH_URL}" 2>/dev/null || echo "000")

    if [[ "${HTTP_STATUS}" == "200" ]]; then
        HEALTHY=true
        success "Health check passed (HTTP ${HTTP_STATUS}) on attempt ${attempt}."
        break
    fi

    warn "  Health check returned HTTP ${HTTP_STATUS}. Retrying in ${HEALTH_RETRY_DELAY}s..."
    sleep "${HEALTH_RETRY_DELAY}"
done

if [[ "${HEALTHY}" != "true" ]]; then
    rollback
fi

# ---------------------------------------------------------------------------
# Save PM2 process list so it survives server reboots
# ---------------------------------------------------------------------------
pm2 save --force 2>&1 | tee -a "${LOG_FILE}"

# ---------------------------------------------------------------------------
# Print summary
# ---------------------------------------------------------------------------
DEPLOY_END=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo ""
success "============================================================"
success "  Deployment successful!"
success "  Branch  : ${BRANCH}"
success "  Commit  : ${CURRENT_COMMIT}"
success "  Started : ${DEPLOY_START}"
success "  Finished: ${DEPLOY_END}"
success "============================================================"

# Changelog between previous and current commits (last 10 lines)
echo ""
log "Changes deployed:"
git log --oneline "${PREVIOUS_COMMIT}..${CURRENT_COMMIT}" 2>/dev/null \
    | head -10 \
    | tee -a "${LOG_FILE}" || true

# ---------------------------------------------------------------------------
# Success notification
# ---------------------------------------------------------------------------
CHANGE_SUMMARY=$(git log --oneline "${PREVIOUS_COMMIT}..${CURRENT_COMMIT}" \
    2>/dev/null | head -5 | tr '\n' ' ' || echo "(no summary)")

notify_slack "success" \
    "Branch: \`${BRANCH}\` | Commit: \`${CURRENT_COMMIT:0:7}\`\\n${CHANGE_SUMMARY}"

notify_webhook "success" "Deployed ${CURRENT_COMMIT:0:7} to ${BRANCH}"

exit 0
