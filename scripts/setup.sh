#!/usr/bin/env bash
# =============================================================================
# setup.sh – Initial production server setup for InstaFlow SaaS
#
# Tested on: Ubuntu 22.04 LTS
# Run as:    sudo bash scripts/setup.sh
#
# What this script does:
#   1. Updates the system and installs Docker, Docker Compose v2, Nginx, Certbot
#   2. Creates the application directory at /var/www/instaflow
#   3. Configures UFW firewall (allow SSH, HTTP, HTTPS)
#   4. Creates a systemd service that manages the Docker Compose stack
#   5. Sets up logrotate for application logs
#   6. Interactively prompts for critical .env values and writes .env
#   7. Generates a self-signed TLS certificate for initial use before
#      Let's Encrypt is configured
#   8. Creates a daily mongodump backup cron job
#   9. Prints post-setup instructions
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Must run as root
# ---------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || error "Please run this script as root: sudo bash $0"

APP_DIR="/var/www/instaflow"
BACKUP_DIR="/backups/instaflow"
LOG_DIR="/var/log/instaflow"
CERTS_DIR="${APP_DIR}/nginx/certs"

# ---------------------------------------------------------------------------
# 1. System update
# ---------------------------------------------------------------------------
info "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
    curl wget gnupg lsb-release ca-certificates \
    software-properties-common apt-transport-https \
    ufw logrotate cron openssl awscli
success "System packages updated."

# ---------------------------------------------------------------------------
# 2. Install Docker
# ---------------------------------------------------------------------------
if command -v docker &>/dev/null; then
    success "Docker already installed: $(docker --version)"
else
    info "Installing Docker Engine..."
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo \
        "deb [arch=$(dpkg --print-architecture) \
        signed-by=/etc/apt/keyrings/docker.asc] \
        https://download.docker.com/linux/ubuntu \
        $(lsb_release -cs) stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
    success "Docker installed: $(docker --version)"
fi

# ---------------------------------------------------------------------------
# 3. Install Nginx
# ---------------------------------------------------------------------------
if command -v nginx &>/dev/null; then
    success "Nginx already installed: $(nginx -v 2>&1)"
else
    info "Installing Nginx..."
    apt-get install -y -qq nginx
    systemctl enable nginx
    success "Nginx installed."
fi

# ---------------------------------------------------------------------------
# 4. Install Certbot (Let's Encrypt client)
# ---------------------------------------------------------------------------
if command -v certbot &>/dev/null; then
    success "Certbot already installed: $(certbot --version)"
else
    info "Installing Certbot..."
    snap install --classic certbot 2>/dev/null || apt-get install -y -qq certbot python3-certbot-nginx
    success "Certbot installed."
fi

# ---------------------------------------------------------------------------
# 5. Create application directories
# ---------------------------------------------------------------------------
info "Creating application directories..."
mkdir -p \
    "${APP_DIR}" \
    "${APP_DIR}/nginx/certs" \
    "${APP_DIR}/nginx/certbot-webroot" \
    "${APP_DIR}/logs" \
    "${APP_DIR}/public/uploads" \
    "${BACKUP_DIR}" \
    "${LOG_DIR}"

# Ensure Docker can write to mounted volumes
chown -R 1000:1000 "${APP_DIR}/logs" "${APP_DIR}/public/uploads"
chmod 755 "${APP_DIR}"
success "Application directories created at ${APP_DIR}."

# ---------------------------------------------------------------------------
# 6. UFW firewall
# ---------------------------------------------------------------------------
info "Configuring UFW firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   comment 'SSH'
ufw allow 80/tcp   comment 'HTTP'
ufw allow 443/tcp  comment 'HTTPS'
ufw --force enable
success "UFW configured. Active rules:"
ufw status numbered

# ---------------------------------------------------------------------------
# 7. Systemd service for Docker Compose stack
# ---------------------------------------------------------------------------
info "Creating systemd service for Docker Compose..."
cat > /etc/systemd/system/instaflow.service << 'UNIT'
[Unit]
Description=InstaFlow SaaS – Docker Compose Stack
Documentation=https://github.com/your-org/instaflow-saas
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=forking
RemainAfterExit=yes
WorkingDirectory=/var/www/instaflow

ExecStartPre=/usr/bin/docker compose pull --quiet
ExecStart=/usr/bin/docker compose up -d --remove-orphans
ExecStop=/usr/bin/docker compose down
ExecReload=/usr/bin/docker compose up -d --no-deps --remove-orphans app worker

Restart=on-failure
RestartSec=30

StandardOutput=journal
StandardError=journal
SyslogIdentifier=instaflow

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable instaflow.service
success "Systemd service 'instaflow' created and enabled."

# ---------------------------------------------------------------------------
# 8. Logrotate for application logs
# ---------------------------------------------------------------------------
info "Configuring logrotate..."
cat > /etc/logrotate.d/instaflow << 'LOGROTATE'
/var/www/instaflow/logs/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    sharedscripts
    postrotate
        # Signal the app container to reopen log file handles
        docker kill --signal=USR2 instaflow-app 2>/dev/null || true
    endscript
}

/var/log/instaflow/*.log {
    weekly
    missingok
    rotate 8
    compress
    delaycompress
    notifempty
}
LOGROTATE
success "Logrotate configured."

# ---------------------------------------------------------------------------
# 9. Interactive .env configuration
# ---------------------------------------------------------------------------
info "Configuring environment variables..."

ENV_FILE="${APP_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
    warn ".env already exists at ${ENV_FILE}. Skipping interactive setup."
    warn "Edit it manually if you need to change values."
else
    # Helpers
    prompt_required() {
        local var_name=$1 prompt_text=$2
        local value=""
        while [[ -z "${value}" ]]; do
            read -rp "  ${prompt_text}: " value
        done
        echo "${var_name}=${value}" >> "${ENV_FILE}"
    }

    prompt_with_default() {
        local var_name=$1 prompt_text=$2 default_value=$3
        read -rp "  ${prompt_text} [${default_value}]: " value
        echo "${var_name}=${value:-$default_value}" >> "${ENV_FILE}"
    }

    prompt_secret() {
        local var_name=$1 prompt_text=$2
        local value=""
        while [[ -z "${value}" ]]; do
            read -rsp "  ${prompt_text} (hidden): " value
            echo ""
        done
        echo "${var_name}=${value}" >> "${ENV_FILE}"
    }

    # Generate strong random secrets
    SESSION_SECRET=$(openssl rand -hex 64)
    JWT_SECRET=$(openssl rand -hex 64)
    MONGO_ROOT_PASS=$(openssl rand -hex 32)
    REDIS_PASS=$(openssl rand -hex 32)

    echo "# InstaFlow SaaS – Environment Configuration"   > "${ENV_FILE}"
    echo "# Generated by setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "${ENV_FILE}"
    echo ""                                               >> "${ENV_FILE}"

    echo "# --- App ----------------------------------------------------------" >> "${ENV_FILE}"
    prompt_required  "DOMAIN"          "Production domain (e.g. instaflow.io)"
    prompt_with_default "PORT"         "App port" "3000"

    echo ""                                                              >> "${ENV_FILE}"
    echo "# --- Database (auto-generated – copy to MONGO_URI below) --------" >> "${ENV_FILE}"
    echo "MONGO_ROOT_USER=admin"                                        >> "${ENV_FILE}"
    echo "MONGO_ROOT_PASSWORD=${MONGO_ROOT_PASS}"                      >> "${ENV_FILE}"
    prompt_with_default "MONGO_DB_NAME" "MongoDB database name" "instaflow"
    MONGO_DB=$(grep '^MONGO_DB_NAME=' "${ENV_FILE}" | cut -d= -f2)
    echo "MONGO_URI=mongodb://admin:${MONGO_ROOT_PASS}@mongo:27017/${MONGO_DB}?authSource=admin&replicaSet=rs0" >> "${ENV_FILE}"

    echo ""                                               >> "${ENV_FILE}"
    echo "# --- Redis --------------------------------------------------------" >> "${ENV_FILE}"
    echo "REDIS_PASSWORD=${REDIS_PASS}"                  >> "${ENV_FILE}"
    echo "REDIS_URL=redis://:${REDIS_PASS}@redis:6379"  >> "${ENV_FILE}"

    echo ""                                               >> "${ENV_FILE}"
    echo "# --- Security keys (auto-generated) --------------------------------" >> "${ENV_FILE}"
    echo "SESSION_SECRET=${SESSION_SECRET}"              >> "${ENV_FILE}"
    echo "JWT_SECRET=${JWT_SECRET}"                      >> "${ENV_FILE}"

    echo ""                                               >> "${ENV_FILE}"
    echo "# --- Instagram API -----------------------------------------------" >> "${ENV_FILE}"
    prompt_secret "INSTAGRAM_APP_ID"     "Instagram App ID"
    prompt_secret "INSTAGRAM_APP_SECRET" "Instagram App Secret"
    prompt_required "INSTAGRAM_WEBHOOK_VERIFY_TOKEN" "Instagram Webhook Verify Token"

    echo ""                                               >> "${ENV_FILE}"
    echo "# --- Razorpay ----------------------------------------------------" >> "${ENV_FILE}"
    prompt_secret "RAZORPAY_KEY_ID"     "Razorpay Key ID"
    prompt_secret "RAZORPAY_KEY_SECRET" "Razorpay Key Secret"

    echo ""                                               >> "${ENV_FILE}"
    echo "# --- Email (SMTP) ------------------------------------------------" >> "${ENV_FILE}"
    prompt_required "SMTP_HOST"     "SMTP host (e.g. smtp.postmarkapp.com)"
    prompt_with_default "SMTP_PORT" "SMTP port" "587"
    prompt_required "SMTP_USER"     "SMTP username / API key"
    prompt_secret   "SMTP_PASS"     "SMTP password"
    prompt_required "EMAIL_FROM"    "From address (e.g. noreply@instaflow.io)"

    echo ""                                               >> "${ENV_FILE}"
    echo "# --- AWS S3 (optional – for backups) ----------------------------" >> "${ENV_FILE}"
    read -rp "  Configure AWS S3 for backups? [y/N]: " USE_S3
    if [[ "${USE_S3}" =~ ^[Yy]$ ]]; then
        prompt_required "AWS_ACCESS_KEY_ID"     "AWS Access Key ID"
        prompt_secret   "AWS_SECRET_ACCESS_KEY" "AWS Secret Access Key"
        prompt_required "AWS_BACKUP_BUCKET"     "S3 bucket name for backups"
        prompt_with_default "AWS_REGION"        "AWS region" "ap-south-1"
    fi

    chmod 600 "${ENV_FILE}"
    success ".env written to ${ENV_FILE}"
fi

# ---------------------------------------------------------------------------
# 10. MongoDB keyfile (required for replica set auth)
# ---------------------------------------------------------------------------
KEYFILE="${APP_DIR}/mongo-keyfile"
if [[ ! -f "${KEYFILE}" ]]; then
    info "Generating MongoDB keyfile..."
    openssl rand -base64 756 > "${KEYFILE}"
    chmod 400 "${KEYFILE}"
    chown 999:999 "${KEYFILE}"   # UID 999 = mongodb user inside the container
    success "MongoDB keyfile created at ${KEYFILE}."
fi

# ---------------------------------------------------------------------------
# 11. Self-signed TLS certificate (used until Let's Encrypt is configured)
# ---------------------------------------------------------------------------
info "Generating self-signed TLS certificate for initial setup..."
mkdir -p "${CERTS_DIR}"

if [[ ! -f "${CERTS_DIR}/fullchain.pem" ]]; then
    DOMAIN_VALUE=$(grep '^DOMAIN=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2 || echo "localhost")
    openssl req -x509 -nodes -newkey rsa:2048 \
        -keyout "${CERTS_DIR}/privkey.pem" \
        -out    "${CERTS_DIR}/fullchain.pem" \
        -days   90 \
        -subj   "/CN=${DOMAIN_VALUE}/O=InstaFlow/C=IN" \
        2>/dev/null
    cp "${CERTS_DIR}/fullchain.pem" "${CERTS_DIR}/chain.pem"
    # Generate Diffie-Hellman parameters (2048-bit, takes ~30s)
    info "Generating DH parameters (this takes ~30 seconds)..."
    openssl dhparam -out "${CERTS_DIR}/dhparam.pem" 2048 2>/dev/null
    success "Self-signed certificate generated. Replace with Let's Encrypt cert after DNS is live."
else
    success "TLS certificate already exists at ${CERTS_DIR}/fullchain.pem."
fi

# ---------------------------------------------------------------------------
# 12. Daily MongoDB backup cron job
# ---------------------------------------------------------------------------
info "Installing daily backup cron job..."
BACKUP_SCRIPT="/usr/local/bin/instaflow-backup"
cp "${APP_DIR}/scripts/backup.sh" "${BACKUP_SCRIPT}" 2>/dev/null || \
    warn "backup.sh not found in ${APP_DIR}/scripts/ – copy it manually to ${BACKUP_SCRIPT}"

chmod +x "${BACKUP_SCRIPT}" 2>/dev/null || true

# Install cron job at 02:30 UTC every day
CRON_ENTRY="30 2 * * * root ENV_FILE=${ENV_FILE} ${BACKUP_SCRIPT} >> /var/log/instaflow-backup.log 2>&1"
if ! grep -qF "instaflow-backup" /etc/crontab 2>/dev/null; then
    echo "${CRON_ENTRY}" >> /etc/crontab
    success "Backup cron job installed (runs daily at 02:30 UTC)."
else
    success "Backup cron job already present."
fi

# ---------------------------------------------------------------------------
# 13. Post-setup instructions
# ---------------------------------------------------------------------------
DOMAIN_VALUE=$(grep '^DOMAIN=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2 || echo "YOUR_DOMAIN")

echo ""
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}  InstaFlow server setup complete!${NC}"
echo -e "${GREEN}============================================================${NC}"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Copy your application files to ${APP_DIR}/"
echo "     rsync -avz --exclude node_modules . user@${DOMAIN_VALUE}:${APP_DIR}/"
echo ""
echo "  2. Start the stack:"
echo "     cd ${APP_DIR} && docker compose up -d"
echo ""
echo "  3. Initialise the MongoDB replica set (first run only):"
echo "     docker compose exec mongo mongosh \\"
echo "       --username admin --password \$(grep MONGO_ROOT_PASSWORD ${ENV_FILE} | cut -d= -f2) \\"
echo "       --authenticationDatabase admin \\"
echo "       --eval 'rs.initiate({_id:\"rs0\",members:[{_id:0,host:\"mongo:27017\"}]})'"
echo ""
echo "  4. Obtain a Let's Encrypt TLS certificate:"
echo "     certbot certonly --webroot \\"
echo "       -w ${APP_DIR}/nginx/certbot-webroot \\"
echo "       -d ${DOMAIN_VALUE} -d www.${DOMAIN_VALUE} \\"
echo "       --email admin@${DOMAIN_VALUE} --agree-tos --non-interactive"
echo "     cp /etc/letsencrypt/live/${DOMAIN_VALUE}/fullchain.pem ${CERTS_DIR}/"
echo "     cp /etc/letsencrypt/live/${DOMAIN_VALUE}/privkey.pem   ${CERTS_DIR}/"
echo "     cp /etc/letsencrypt/live/${DOMAIN_VALUE}/chain.pem     ${CERTS_DIR}/"
echo "     docker compose restart nginx"
echo ""
echo "  5. Verify health: curl -sf https://${DOMAIN_VALUE}/healthz"
echo ""
echo "  Secrets are stored in ${ENV_FILE} (chmod 600)."
echo "  Back it up securely – it contains all credentials."
echo ""
