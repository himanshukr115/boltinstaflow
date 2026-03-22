#!/usr/bin/env bash
# =============================================================================
# backup.sh – MongoDB backup for InstaFlow SaaS
#
# Usage (called by cron or manually):
#   ENV_FILE=/var/www/instaflow/.env /usr/local/bin/instaflow-backup
#
# Exit codes:
#   0  – backup completed successfully
#   1  – mongodump failed
#   2  – S3 upload failed (backup still exists locally; non-fatal by default)
#   3  – configuration error (missing required variables)
#
# Logs all activity to /var/log/instaflow-backup.log
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SCRIPT_NAME="instaflow-backup"
LOG_FILE="/var/log/instaflow-backup.log"
BACKUP_ROOT="/backups/instaflow"
RETAIN_DAYS=7
TIMESTAMP=$(date -u +"%Y-%m-%d-%H")
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"

# ---------------------------------------------------------------------------
# Logging helpers – all output goes to stdout AND the log file
# ---------------------------------------------------------------------------
exec > >(tee -a "${LOG_FILE}") 2>&1

log()   { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [${SCRIPT_NAME}] [INFO]  $*"; }
warn()  { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [${SCRIPT_NAME}] [WARN]  $*"; }
error() { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [${SCRIPT_NAME}] [ERROR] $*"; }

# ---------------------------------------------------------------------------
# Load environment variables from .env file if available
# ---------------------------------------------------------------------------
ENV_FILE="${ENV_FILE:-/var/www/instaflow/.env}"
if [[ -f "${ENV_FILE}" ]]; then
    # shellcheck disable=SC1090
    set -o allexport
    source "${ENV_FILE}"
    set +o allexport
    log "Loaded environment from ${ENV_FILE}"
fi

# ---------------------------------------------------------------------------
# Validate required variables
# ---------------------------------------------------------------------------
if [[ -z "${MONGO_URI:-}" ]]; then
    # Attempt to construct MONGO_URI from parts if full URI is not set
    MONGO_ROOT_USER="${MONGO_ROOT_USER:-admin}"
    MONGO_ROOT_PASSWORD="${MONGO_ROOT_PASSWORD:-}"
    MONGO_DB_NAME="${MONGO_DB_NAME:-instaflow}"

    if [[ -z "${MONGO_ROOT_PASSWORD}" ]]; then
        error "MONGO_URI or MONGO_ROOT_PASSWORD must be set. Aborting."
        exit 3
    fi
    MONGO_URI="mongodb://${MONGO_ROOT_USER}:${MONGO_ROOT_PASSWORD}@localhost:27017/${MONGO_DB_NAME}?authSource=admin"
fi

# ---------------------------------------------------------------------------
# Ensure backup directory exists
# ---------------------------------------------------------------------------
mkdir -p "${BACKUP_DIR}"
log "Starting backup → ${BACKUP_DIR}"

# ---------------------------------------------------------------------------
# Run mongodump
# ---------------------------------------------------------------------------
# --uri           – full connection string (includes auth, replica set option)
# --gzip          – compress each BSON file individually
# --out           – output directory
#
# If the app is running inside Docker, connect to the exposed Mongo port.
# Adjust the host inside MONGO_URI if running from within the same Docker
# network (use "mongo" as the hostname instead of "localhost").
# ---------------------------------------------------------------------------
log "Running mongodump..."

if ! mongodump \
        --uri="${MONGO_URI}" \
        --gzip \
        --out="${BACKUP_DIR}/dump" \
        2>&1; then
    error "mongodump failed. Exit code: $?"
    rm -rf "${BACKUP_DIR}"
    exit 1
fi
log "mongodump completed successfully."

# ---------------------------------------------------------------------------
# Compress the entire dump directory into a single archive
# Archive name format: instaflow-backup-YYYY-MM-DD-HH.tar.gz
# ---------------------------------------------------------------------------
ARCHIVE="${BACKUP_ROOT}/instaflow-backup-${TIMESTAMP}.tar.gz"
log "Compressing dump to ${ARCHIVE}..."

tar -czf "${ARCHIVE}" -C "${BACKUP_DIR}" dump
ARCHIVE_SIZE=$(du -sh "${ARCHIVE}" | cut -f1)
log "Archive created: ${ARCHIVE} (${ARCHIVE_SIZE})"

# Remove the uncompressed dump directory after successful archiving
rm -rf "${BACKUP_DIR}"
log "Removed uncompressed dump directory."

# ---------------------------------------------------------------------------
# Upload to S3 (optional)
# Set AWS_BACKUP_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY in .env
# to enable S3 uploads.
# ---------------------------------------------------------------------------
S3_EXIT_CODE=0
if [[ -n "${AWS_BACKUP_BUCKET:-}" ]]; then
    AWS_REGION="${AWS_REGION:-ap-south-1}"
    S3_KEY="mongodb-backups/$(date -u +%Y/%m)/instaflow-backup-${TIMESTAMP}.tar.gz"
    S3_URI="s3://${AWS_BACKUP_BUCKET}/${S3_KEY}"

    log "Uploading backup to ${S3_URI}..."

    if AWS_DEFAULT_REGION="${AWS_REGION}" \
       aws s3 cp "${ARCHIVE}" "${S3_URI}" \
           --storage-class STANDARD_IA \
           --only-show-errors 2>&1; then
        log "S3 upload successful: ${S3_URI}"
    else
        S3_EXIT_CODE=$?
        warn "S3 upload failed (exit ${S3_EXIT_CODE}). Backup is still available locally."
        # We treat S3 failure as a non-fatal warning so the cron job does not
        # page on-call if only the upload is broken while the local backup exists.
    fi
else
    log "AWS_BACKUP_BUCKET not set – skipping S3 upload."
fi

# ---------------------------------------------------------------------------
# Prune local backups older than RETAIN_DAYS days
# ---------------------------------------------------------------------------
log "Pruning backups older than ${RETAIN_DAYS} days from ${BACKUP_ROOT}..."
PRUNED=0
while IFS= read -r -d '' old_archive; do
    rm -f "${old_archive}"
    log "  Deleted: ${old_archive}"
    ((PRUNED++)) || true
done < <(find "${BACKUP_ROOT}" \
    -maxdepth 1 \
    -name "instaflow-backup-*.tar.gz" \
    -mtime "+${RETAIN_DAYS}" \
    -print0)

if [[ ${PRUNED} -eq 0 ]]; then
    log "No old backups to prune."
else
    log "Pruned ${PRUNED} backup archive(s)."
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log "Backup complete."
log "  Archive : ${ARCHIVE} (${ARCHIVE_SIZE})"
log "  S3      : ${AWS_BACKUP_BUCKET:+${S3_URI}} ${AWS_BACKUP_BUCKET:-skipped}"
log "  Pruned  : ${PRUNED} archive(s)"

# Return non-zero only for S3 failures (exit 2), so monitoring systems can
# distinguish between a total backup failure (exit 1) and an upload problem.
if [[ ${S3_EXIT_CODE} -ne 0 ]]; then
    exit 2
fi

exit 0
