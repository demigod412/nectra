#!/usr/bin/env bash
# ==============================================================================
# NECTRA Platform — Ubuntu/Debian VPS installer (AWS Lightsail, EC2, any VPS)
#
#   sudo bash install.sh
#
# What it does:
#   * swap (small VPS), system packages, Python 3 venv
#   * optional local source copy or git clone into /var/www/nectra-platform
#   * generates a production .env with a fresh MASTER_KEY (never overwrites)
#   * installs Python deps inside .venv, runs the app as a hardened systemd unit
#   * nginx reverse proxy, Cloudflare real-IP, UFW
#   * TLS: Let's Encrypt, Cloudflare Origin cert, or Cloudflare Flexible (HTTP)
#   * optional fixed test accounts
#
# Cloudflare notes are printed at the end and repeated in TESTING-GUIDE.txt.
# ==============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; NC='\033[0m'

[ "$(id -u)" -eq 0 ] || { echo -e "${RED}Run with sudo: sudo bash install.sh${NC}"; exit 1; }

APP_USER="${SUDO_USER:-ubuntu}"
id "$APP_USER" >/dev/null 2>&1 || APP_USER="$(whoami)"
INSTALL_DIR="/var/www/nectra-platform"
DEFAULT_REPO="https://github.com/demigod412/nectra.git"

clear
cat <<'EOF'
  _   _ _____ ____ _____ ____      _
 | \ | | ____/ ___|_   _|  _ \    / \
 |  \| |  _|| |     | | | |_) |  / _ \
 | |\  | |__| |___  | | |  _ <  / ___ \
 |_| \_|_____\____| |_| |_| \_\/_/   \_\
        NECTRA production installer (Ubuntu)
EOF

echo -e "${CYAN}----------------------------------------------------------------${NC}"
echo -e "${BOLD}Step 1 — domain, admin, mode${NC}"
read -rp "Fully qualified domain (e.g. app.example.com): " DOMAIN
DOMAIN="$(echo "${DOMAIN:-}" | tr -d ' ' | tr '[:upper:]' '[:lower:]')"
[[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo -e "${RED}Invalid domain.${NC}"; exit 1; }

read -rp "Admin email (SSL alerts, super admin login): " ADMIN_EMAIL
[[ "$ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$ ]] || {
  echo -e "${RED}Invalid email.${NC}"; exit 1; }

read -rsp "Super admin password (empty = generate): " ADMIN_PASS; echo ""
if [ -z "${ADMIN_PASS:-}" ]; then
  ADMIN_PASS="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9!@#%^&*' | head -c 20)"
  echo -e "${CYAN}Generated password: ${BOLD}${ADMIN_PASS}${NC}"
fi

read -rp "Run in demo mode? (simulated chain actions, on-screen codes) [Y/n]: " DEMO
case "${DEMO:-Y}" in [Nn]*) DEMO_MODE=0;; *) DEMO_MODE=1;; esac

echo ""
echo -e "${BOLD}Step 2 — source${NC}"
if [ -f "$(pwd)/py_server/app.py" ]; then
  echo -e "${GREEN}Source detected in $(pwd).${NC}"
  read -rp "Deploy this directory? [Y/n]: " USE_LOCAL
  case "${USE_LOCAL:-Y}" in
    [Nn]*) read -rp "Git repository [$DEFAULT_REPO]: " GIT_REPO; GIT_REPO="${GIT_REPO:-$DEFAULT_REPO}"; SRC=GIT;;
    *) SRC=LOCAL;;
  esac
else
  read -rp "Git repository [$DEFAULT_REPO]: " GIT_REPO; GIT_REPO="${GIT_REPO:-$DEFAULT_REPO}"; SRC=GIT
fi

echo ""
echo -e "${BOLD}Step 3 — TLS${NC}"
echo "  1) Let's Encrypt via Certbot (A record direct, no Cloudflare proxy)"
echo "  2) Cloudflare Origin Certificate (proxy on, SSL mode Full (strict))  [recommended with Cloudflare]"
echo "  3) Cloudflare Flexible (proxy on, Cloudflare terminates TLS, origin HTTP)"
read -rp "Choose [1-3, default 2]: " SSL_MODE; SSL_MODE="${SSL_MODE:-2}"

read -rp "Create fixed test accounts (admin/ops/officer/compliance/trader)? [Y/n]: " SEED
case "${SEED:-Y}" in [Nn]*) SEED_TEST=0;; *) SEED_TEST=1;; esac

echo -e "\n${GREEN}Starting installation…${NC}"

# ---------------------------------------------------------------- system
if [ "$(swapon --show | wc -l)" -le 1 ]; then
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile; mkswap /swapfile; swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null; echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl wget git build-essential nginx ufw certbot python3-certbot-nginx \
  python3 python3-venv python3-dev ca-certificates openssl sqlite3

# ---------------------------------------------------------------- source
mkdir -p /var/www
if [ "$SRC" = "LOCAL" ]; then
  if [ "$(pwd)" != "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"; mkdir -p "$INSTALL_DIR"; cp -a "$(pwd)"/. "$INSTALL_DIR"/
  fi
else
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" fetch origin && git -C "$INSTALL_DIR" reset --hard origin/main
  else
    rm -rf "$INSTALL_DIR"; git clone "$GIT_REPO" "$INSTALL_DIR"
  fi
fi
cd "$INSTALL_DIR"
[ -f py_server/app.py ] || { echo -e "${RED}py_server/app.py missing.${NC}"; exit 1; }

# ---------------------------------------------------------------- python
python3 -m venv "$INSTALL_DIR/.venv"
"$INSTALL_DIR/.venv/bin/pip" install --upgrade pip wheel >/dev/null
"$INSTALL_DIR/.venv/bin/pip" install -r py_server/requirements.txt

mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/data/backups"
chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR/data"

# ---------------------------------------------------------------- env
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cat > "$INSTALL_DIR/.env" <<EOF
PORT=3000
HOST=127.0.0.1
PUBLIC_URL=https://${DOMAIN}
CORS_ORIGINS=https://${DOMAIN}
TRUST_PROXY=1
COOKIE_SECURE=1
RELOAD=0
LOG_REQUESTS=0
DEMO_MODE=${DEMO_MODE}
MASTER_KEY=$(openssl rand -hex 32)
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASS}
SEED_STAFF=1
OPS_EMAIL=ops@nectra.local
OFFICER_EMAIL=officer@nectra.local
DB_PATH=${INSTALL_DIR}/data/nectra.db
BACKUP_KEEP_DAYS=14
EOF
  chmod 600 "$INSTALL_DIR/.env"
  chown "$APP_USER:$APP_USER" "$INSTALL_DIR/.env"
  echo -e "${GREEN}Wrote ${INSTALL_DIR}/.env (MASTER_KEY generated — back it up).${NC}"
else
  echo -e "${YELLOW}.env exists — keeping it (rotating MASTER_KEY loses collector keys).${NC}"
fi

# ---------------------------------------------------------------- systemd
cat > /etc/systemd/system/nectra.service <<EOF
[Unit]
Description=NECTRA Platform (FastAPI)
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${INSTALL_DIR}/.venv/bin/python -m uvicorn app:app --app-dir py_server --host 127.0.0.1 --port 3000
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${INSTALL_DIR}/data

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now nectra

# ---------------------------------------------------------------- nginx
cat > /etc/nginx/conf.d/cloudflare.conf <<'EOF'
set_real_ip_from 173.245.48.0/20;  set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;  set_real_ip_from 103.31.4.0/22;
set_real_ip_from 141.101.64.0/18;  set_real_ip_from 108.162.192.0/18;
set_real_ip_from 190.93.240.0/20;  set_real_ip_from 188.114.96.0/20;
set_real_ip_from 197.234.240.0/22; set_real_ip_from 198.41.128.0/17;
set_real_ip_from 162.158.0.0/15;   set_real_ip_from 104.16.0.0/13;
set_real_ip_from 104.24.0.0/14;    set_real_ip_from 172.64.0.0/13;
set_real_ip_from 131.0.72.0/22;
set_real_ip_from 2400:cb00::/32;   set_real_ip_from 2606:4700::/32;
set_real_ip_from 2803:f800::/32;   set_real_ip_from 2405:b500::/32;
set_real_ip_from 2405:8100::/32;   set_real_ip_from 2a06:98c0::/29;
set_real_ip_from 2c0f:f248::/32;
real_ip_header CF-Connecting-IP;
EOF

PROXY_BLOCK='    client_max_body_size 50M;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
    }'

if [ "$SSL_MODE" = "2" ]; then
  mkdir -p /etc/ssl/nectra
  echo "Paste the Cloudflare Origin CERTIFICATE, then Ctrl+D:"
  cat > /etc/ssl/nectra/origin.pem
  echo "Paste the Cloudflare Origin PRIVATE KEY, then Ctrl+D:"
  cat > /etc/ssl/nectra/origin.key
  chmod 644 /etc/ssl/nectra/origin.pem; chmod 600 /etc/ssl/nectra/origin.key
  cat > "/etc/nginx/sites-available/$DOMAIN" <<EOF
server { listen 80; server_name $DOMAIN; return 301 https://\$host\$request_uri; }
server {
    listen 443 ssl http2; server_name $DOMAIN;
    ssl_certificate /etc/ssl/nectra/origin.pem;
    ssl_certificate_key /etc/ssl/nectra/origin.key;
    ssl_protocols TLSv1.2 TLSv1.3;
${PROXY_BLOCK}
}
EOF
else
  cat > "/etc/nginx/sites-available/$DOMAIN" <<EOF
server {
    listen 80; listen [::]:80; server_name $DOMAIN;
${PROXY_BLOCK}
}
EOF
fi

ln -sf "/etc/nginx/sites-available/$DOMAIN" /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/html
nginx -t && systemctl reload nginx

if [ "$SSL_MODE" = "1" ]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ADMIN_EMAIL" --redirect \
    || echo -e "${YELLOW}Certbot failed — point the A record here with proxy OFF and rerun: certbot --nginx -d $DOMAIN${NC}"
fi

# ---------------------------------------------------------------- firewall
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

# ---------------------------------------------------------------- seed
sleep 3
if [ "$SEED_TEST" = "1" ]; then
  sudo -u "$APP_USER" "$INSTALL_DIR/.venv/bin/python" "$INSTALL_DIR/scripts/create_test_users.py" || true
fi

if ! systemctl is-active --quiet nectra; then
  echo -e "${RED}Service failed. Logs:${NC}"; journalctl -u nectra -n 40 --no-pager || true
  exit 1
fi
curl -fsS http://127.0.0.1:3000/api/health >/dev/null && echo -e "${GREEN}Health check passed.${NC}"

IP="$(curl -s https://api.ipify.org || echo YOUR_IP)"
echo ""
echo -e "${GREEN}================ INSTALL COMPLETE ================${NC}"
echo "  App:    https://${DOMAIN}"
echo "  Admin:  https://${DOMAIN}/admin"
echo "  Server: ${IP}"
echo ""
echo -e "${BOLD}Next (Cloudflare, if used):${NC}"
echo "  1. A record ${DOMAIN} -> ${IP} (orange cloud ON for modes 2/3)"
echo "  2. SSL/TLS mode: Full (strict) for mode 2, Flexible for mode 3"
echo "  3. Allow WebSockets; set the DNS record to Proxied"
echo ""
echo "  Logs: journalctl -u nectra -f    Restart: systemctl restart nectra"
echo "  Env:  ${INSTALL_DIR}/.env       Data: ${INSTALL_DIR}/data"
echo -e "${YELLOW}Back up MASTER_KEY and .env now. Keep demo mode off in production once done.${NC}"
echo -e "${GREEN}==================================================${NC}"
