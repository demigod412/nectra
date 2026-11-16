#!/usr/bin/env bash
# ==============================================================================
# NECTRA Platform — Production Installation & Setup Script
# Target: Ubuntu 22.04 / 24.04 LTS (AWS Lightsail / DigitalOcean / Vultr / Linode)
# Features:
#   - Automated Swap creation (prevents OOM on 1GB/2GB VPS)
#   - Node.js 22 LTS installation via official NodeSource repository
#   - System packages & build tools (Nginx, Certbot, Git, UFW)
#   - GitHub repository cloning or local directory deployment
#   - Cryptographic MASTER_KEY generation & production .env configuration
#   - Cloudflare-ready Nginx reverse proxy (Real-IP restoration & WebSockets)
#   - Automated SSL generation (Certbot Let's Encrypt / Cloudflare SSL)
#   - Systemd supervisor service (auto-restart, crash backoff, process isolation)
#   - Firewall configuration (UFW)
# ==============================================================================

set -euo pipefail

# ANSI Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

clear
cat << "EOF"
  _   _ _____ ____ _____ ____      _    
 | \ | | ____/ ___|_   _|  _ \    / \   
 |  \| |  _|| |     | | | |_) |  / _ \  
 | |\  | |__| |___  | | |  _ <  / ___ \ 
 |_| \_|_____\____| |_| |_| \_\/_/   \_\
                                        
   NECTRA Platform Production Installer
EOF

echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN} AWS Lightsail & Ubuntu Server Automated Production Deployment ${NC}"
echo -e "${CYAN}================================================================${NC}\n"

# 1. Root / Sudo Check
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR] This script must be run as root or with sudo privileges.${NC}"
  echo -e "Please re-run: ${BOLD}sudo bash install.sh${NC}"
  exit 1
fi

CURRENT_USER="${SUDO_USER:-$(whoami)}"
INSTALL_DIR="/var/www/nectra-platform"

# 2. Interactive Configuration Prompts
echo -e "${BOLD}--- Step 1: Deployment & Domain Configuration ---${NC}"

# Domain Prompt
while true; do
  read -rp "Enter your fully qualified domain name (e.g., trade.example.com): " DOMAIN
  DOMAIN=$(echo "$DOMAIN" | tr -d ' ' | tr '[:upper:]' '[:lower:]')
  if [[ -n "$DOMAIN" && "$DOMAIN" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
    break
  else
    echo -e "${YELLOW}Please enter a valid domain name (without http:// or /).${NC}"
  fi
done

# Email Prompt (for SSL renewal alerts)
while true; do
  read -rp "Enter administrator email (for SSL renewal & login): " ADMIN_EMAIL
  ADMIN_EMAIL=$(echo "$ADMIN_EMAIL" | tr -d ' ')
  if [[ -n "$ADMIN_EMAIL" && "$ADMIN_EMAIL" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
    break
  else
    echo -e "${YELLOW}Please enter a valid email address.${NC}"
  fi
done

# Admin Password Prompt
read -rsp "Enter super admin password (leave empty to generate a random secure one): " ADMIN_PASS
echo ""
if [ -z "$ADMIN_PASS" ]; then
  ADMIN_PASS=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9!@#%^&*' | head -c 16)
  echo -e "${CYAN}[INFO] Generated Super Admin Password: ${BOLD}${ADMIN_PASS}${NC}"
fi

# Git Repository Source
echo ""
echo -e "${BOLD}--- Step 2: Repository Source ---${NC}"
DEFAULT_REPO="https://github.com/demigod412/nectra.git"
# If running inside existing clone, allow using current directory
if [ -f "$(pwd)/server/index.js" ]; then
  echo -e "${GREEN}Detected NECTRA source code in current directory ($(pwd)).${NC}"
  read -rp "Use current directory for deployment? [Y/n]: " USE_CURR
  USE_CURR=${USE_CURR:-Y}
  if [[ "$USE_CURR" =~ ^[Yy]$ ]]; then
    REPO_SOURCE="LOCAL"
  else
    read -rp "Enter GitHub repository URL [${DEFAULT_REPO}]: " GIT_REPO
    GIT_REPO=${GIT_REPO:-$DEFAULT_REPO}
    REPO_SOURCE="GIT"
  fi
else
  read -rp "Enter GitHub repository URL [${DEFAULT_REPO}]: " GIT_REPO
  GIT_REPO=${GIT_REPO:-$DEFAULT_REPO}
  REPO_SOURCE="GIT"
fi

# SSL Configuration Mode
echo ""
echo -e "${BOLD}--- Step 3: SSL / HTTPS Mode (Cloudflare Compatible) ---${NC}"
echo "1) Automatic Let's Encrypt SSL via Certbot (Recommended for Cloudflare DNS / Direct A-Record)"
echo "2) Cloudflare Origin Certificate (Paste your 15-year Cloudflare Origin Certificate & Private Key)"
echo "3) Cloudflare Flexible SSL / HTTP-only on origin (Cloudflare terminates SSL)"
read -rp "Select SSL mode [1-3, default: 1]: " SSL_MODE
SSL_MODE=${SSL_MODE:-1}

echo -e "\n${GREEN}[✓] Configuration gathered. Beginning server setup...${NC}\n"
sleep 1

# 3. Swap Configuration (Crucial for 1GB/2GB Lightsail Instances)
echo -e "${CYAN}[1/8] Checking system swap memory...${NC}"
SWAP_EXISTS=$(swapon --show | wc -l)
if [ "$SWAP_EXISTS" -le 1 ]; then
  echo -e "Creating 2GB swap file to prevent memory exhaustion during builds..."
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  sysctl vm.swappiness=10
  echo 'vm.swappiness=10' >> /etc/sysctl.conf
  echo -e "${GREEN}[✓] 2GB Swap activated.${NC}"
else
  echo -e "${GREEN}[✓] Swap is already configured.${NC}"
fi

# 4. System Updates & Essential Packages
echo -e "\n${CYAN}[2/8] Updating system packages and installing prerequisites...${NC}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl wget git build-essential nginx ufw certbot python3-certbot-nginx ca-certificates gnupg software-properties-common

# 5. Install Node.js 22 LTS
echo -e "\n${CYAN}[3/8] Installing Node.js 22 LTS...${NC}"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 22 ]; then
    echo -e "${GREEN}[✓] Node.js $NODE_VER already installed.${NC}"
    NEED_NODE=0
  fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
  echo -e "${GREEN}[✓] Installed $(node -v) and npm $(npm -v).${NC}"
fi

# 6. Deploy Project Files
echo -e "\n${CYAN}[4/8] Setting up application directory at ${INSTALL_DIR}...${NC}"
mkdir -p /var/www

if [ "$REPO_SOURCE" = "LOCAL" ]; then
  SRC_DIR="$(pwd)"
  if [ "$SRC_DIR" != "$INSTALL_DIR" ]; then
    echo "Copying files from $SRC_DIR to $INSTALL_DIR..."
    rm -rf "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    cp -a "$SRC_DIR"/. "$INSTALL_DIR"/
  fi
  # Ensure git repository is initialized for future seamless updates
  if [ ! -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR"
    git init
    git remote add origin "$GIT_REPO" || git remote set-url origin "$GIT_REPO"
    git branch -M main || true
  fi
else
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "Existing git repository found at $INSTALL_DIR. Pulling latest main branch..."
    cd "$INSTALL_DIR"
    git fetch origin
    git reset --hard origin/main
  else
    echo "Cloning $GIT_REPO into $INSTALL_DIR..."
    rm -rf "$INSTALL_DIR"
    git clone "$GIT_REPO" "$INSTALL_DIR"
  fi
fi

cd "$INSTALL_DIR"

# Install NPM dependencies
echo "Installing NPM production dependencies..."
npm install --omit=dev

# 7. Configure Environment (.env)
echo -e "\n${CYAN}[5/8] Generating secure production environment (.env)...${NC}"
MASTER_KEY=$(openssl rand -hex 32)
COOKIE_SECURE=1
TRUST_PROXY=1

cat > "$INSTALL_DIR/.env" << EOF
# ==============================================================================
# NECTRA Production Environment Configuration
# Generated on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# ==============================================================================

NODE_ENV=production
PORT=3000
HOST=127.0.0.1
PUBLIC_URL=https://${DOMAIN}
TRUST_PROXY=${TRUST_PROXY}
COOKIE_SECURE=${COOKIE_SECURE}
LOG_REQUESTS=0

# Master Vault Encryption Key (CRITICAL: Do NOT delete or lose this key)
MASTER_KEY=${MASTER_KEY}

# Administrative Setup
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASS}
DEMO_MODE=0

# Blockchain Networks
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC=https://api.mainnet-beta.solana.com

# Database Location
DB_PATH=${INSTALL_DIR}/data/nectra.db
EOF

mkdir -p "$INSTALL_DIR/data"
chmod 600 "$INSTALL_DIR/.env"
echo -e "${GREEN}[✓] Production .env created with cryptographically secure MASTER_KEY.${NC}"

# 8. Configure Nginx Reverse Proxy with Cloudflare Support
echo -e "\n${CYAN}[6/8] Configuring Nginx reverse proxy with Cloudflare Real-IP support...${NC}"

# Generate Cloudflare Real-IP config so server logs real visitor IPs
cat > /etc/nginx/conf.d/cloudflare.conf << 'EOF'
# Cloudflare IPv4
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;
set_real_ip_from 103.31.4.0/22;
set_real_ip_from 141.101.64.0/18;
set_real_ip_from 108.162.192.0/18;
set_real_ip_from 190.93.240.0/20;
set_real_ip_from 188.114.96.0/20;
set_real_ip_from 197.234.240.0/22;
set_real_ip_from 198.41.128.0/17;
set_real_ip_from 162.158.0.0/15;
set_real_ip_from 104.16.0.0/13;
set_real_ip_from 104.24.0.0/14;
set_real_ip_from 172.64.0.0/13;
set_real_ip_from 131.0.72.0/22;

# Cloudflare IPv6
set_real_ip_from 2400:cb00::/32;
set_real_ip_from 2606:4700::/32;
set_real_ip_from 2803:f800::/32;
set_real_ip_from 2405:b500::/32;
set_real_ip_from 2405:8100::/32;
set_real_ip_from 2a06:98c0::/29;
set_real_ip_from 2c0f:f248::/32;

real_ip_header CF-Connecting-IP;
EOF

# Initial HTTP Nginx block
cat > "/etc/nginx/sites-available/$DOMAIN" << EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    client_max_body_size 50M;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
EOF

ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/"
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# Handle SSL Setup
if [ "$SSL_MODE" -eq 1 ]; then
  echo -e "\nObtaining Let's Encrypt SSL certificate via Certbot for ${DOMAIN}..."
  mkdir -p /var/www/html
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ADMIN_EMAIL" --redirect; then
    echo -e "${GREEN}[✓] Let's Encrypt SSL installed successfully!${NC}"
  else
    echo -e "${YELLOW}[!] Certbot could not verify domain automatically.${NC}"
    echo -e "${YELLOW}Ensure your Cloudflare DNS A-record points to this server IP and SSL is set to Full.${NC}"
    echo -e "You can rerun certbot at any time: ${BOLD}certbot --nginx -d $DOMAIN${NC}"
  fi
elif [ "$SSL_MODE" -eq 2 ]; then
  echo -e "\nSetting up Cloudflare Origin Certificate..."
  mkdir -p /etc/ssl/certs /etc/ssl/private
  CERT_PATH="/etc/ssl/certs/${DOMAIN}.pem"
  KEY_PATH="/etc/ssl/private/${DOMAIN}.key"

  echo "Please paste your Cloudflare Origin Certificate (including BEGIN and END CERTIFICATE lines):"
  echo "Press Ctrl+D when finished:"
  cat > "$CERT_PATH"
  chmod 644 "$CERT_PATH"

  echo "Please paste your Cloudflare Origin Private Key (including BEGIN and END PRIVATE KEY lines):"
  echo "Press Ctrl+D when finished:"
  cat > "$KEY_PATH"
  chmod 600 "$KEY_PATH"

  cat > "/etc/nginx/sites-available/$DOMAIN" << EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate ${CERT_PATH};
    ssl_certificate_key ${KEY_PATH};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
EOF
  nginx -t && systemctl reload nginx
  echo -e "${GREEN}[✓] Cloudflare Origin Certificate configured.${NC}"
else
  echo -e "${GREEN}[✓] HTTP proxy configured for Cloudflare Flexible SSL.${NC}"
fi

# 9. Configure Systemd Supervisor Service
echo -e "\n${CYAN}[7/8] Configuring Systemd process supervisor...${NC}"

# Ensure proper permissions
chown -R "$CURRENT_USER:$CURRENT_USER" "$INSTALL_DIR"

cat > /etc/systemd/system/nectra.service << EOF
[Unit]
Description=NECTRA Platform Supervisor (Web & Bot Runner)
After=network.target

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node) scripts/supervisor.js
Restart=always
RestartSec=5s

# Start limits: max 5 restarts in 60s
StartLimitIntervalSec=60s
StartLimitBurst=5

# Environment
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=SEPARATE_BOT_PROCESS=1

# Process management
KillMode=mixed
TimeoutStopSec=15s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable nectra.service
systemctl restart nectra.service

# 10. Configure Firewall (UFW)
echo -e "\n${CYAN}[8/8] Configuring UFW Firewall...${NC}"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true
echo -e "${GREEN}[✓] Firewall configured (SSH, HTTP, HTTPS enabled).${NC}"

# 11. Health Verification
echo -e "\nWaiting for service initialization..."
sleep 4
if systemctl is-active --quiet nectra.service; then
  echo -e "${GREEN}[✓] NECTRA Service is running and supervised.${NC}"
else
  echo -e "${YELLOW}[!] Service status check:${NC}"
  systemctl status nectra.service --no-pager || true
fi

# 12. Final Installation Summary
PUBLIC_IP=$(curl -s https://api.ipify.org || echo "YOUR_SERVER_IP")

echo -e "\n${GREEN}================================================================${NC}"
echo -e "${GREEN}             🎉 NECTRA INSTALLATION COMPLETE!                  ${NC}"
echo -e "${GREEN}================================================================${NC}\n"

echo -e "${BOLD}Platform Access URLs:${NC}"
echo -e "  • Public Web App:     ${CYAN}https://${DOMAIN}/${NC}"
echo -e "  • Admin Console:      ${CYAN}https://${DOMAIN}/admin${NC}"
echo -e "  • Server Public IP:   ${CYAN}${PUBLIC_IP}${NC}"
echo ""
echo -e "${BOLD}First-Time Super Admin Credentials:${NC}"
echo -e "  • Email:              ${YELLOW}${ADMIN_EMAIL}${NC}"
echo -e "  • Password:           ${YELLOW}${ADMIN_PASS}${NC}"
echo ""
echo -e "${BOLD}System Management Commands:${NC}"
echo -e "  • View live logs:     ${CYAN}journalctl -u nectra -f${NC}"
echo -e "  • Restart service:    ${CYAN}sudo systemctl restart nectra${NC}"
echo -e "  • Stop service:       ${CYAN}sudo systemctl stop nectra${NC}"
echo -e "  • Check status:       ${CYAN}sudo systemctl status nectra${NC}"
echo ""
echo -e "${YELLOW}Important Cloudflare Notes:${NC}"
echo -e "  1. In Cloudflare DNS, create an ${BOLD}A Record${NC} pointing ${BOLD}${DOMAIN}${NC} to ${BOLD}${PUBLIC_IP}${NC}."
echo -e "  2. In Cloudflare SSL/TLS settings, set encryption mode to ${BOLD}Full${NC} or ${BOLD}Full (strict)${NC}."
echo -e "  3. Keep WebSockets enabled in Cloudflare Network settings (enabled by default)."
echo ""
echo -e "${GREEN}All configuration and vault keys are saved in:${NC} ${INSTALL_DIR}/.env"
echo -e "${GREEN}================================================================${NC}\n"
