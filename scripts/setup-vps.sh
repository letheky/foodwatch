#!/bin/bash
set -e

echo "=== FoodWatch VPS Setup ==="

# 1. Node.js 20
if ! command -v node &>/dev/null; then
  echo "[1/6] Cai Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
else
  echo "[1/6] Node.js da co: $(node -v)"
fi

# 2. Google Chrome
if ! command -v google-chrome &>/dev/null; then
  echo "[2/6] Cai Google Chrome..."
  wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add -
  echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
  apt update && apt install -y google-chrome-stable
else
  echo "[2/6] Chrome da co: $(google-chrome --version)"
fi

# 3. Nginx
if ! command -v nginx &>/dev/null; then
  echo "[3/6] Cai Nginx..."
  apt install -y nginx
else
  echo "[3/6] Nginx da co"
fi

# 4. PM2
if ! command -v pm2 &>/dev/null; then
  echo "[4/6] Cai PM2..."
  npm install -g pm2
else
  echo "[4/6] PM2 da co"
fi

# 5. Clone repo
echo "[5/6] Clone foodwatch..."
mkdir -p /opt
if [ -d /opt/foodwatch ]; then
  echo "  Thu muc /opt/foodwatch da ton tai, git pull..."
  cd /opt/foodwatch && git pull
else
  cd /opt && git clone https://github.com/letheky/foodwatch.git
fi
cd /opt/foodwatch
npm install

# 6. Tao .env neu chua co
if [ ! -f /opt/foodwatch/.env ]; then
  echo "[6/6] Tao .env..."
  cp /opt/foodwatch/.env.example /opt/foodwatch/.env
  # Sinh AUTH_TOKEN ngau nhien
  TOKEN=$(openssl rand -hex 16)
  sed -i "s/your_secret_token_here/$TOKEN/" /opt/foodwatch/.env
  echo ""
  echo ">>> AUTH_TOKEN tu dong sinh: $TOKEN"
  echo ">>> Luu lai token nay!"
else
  echo "[6/6] .env da ton tai, giu nguyen"
fi

# 7. PM2 start
echo "[7] Khoi dong PM2..."
cd /opt/foodwatch
pm2 describe foodwatch &>/dev/null && pm2 restart foodwatch || pm2 start src/index.js --name foodwatch
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null | grep "sudo\|systemctl" | bash || true

# 8. Nginx config
echo "[8] Cau hinh Nginx..."
cat > /etc/nginx/sites-available/foodwatch << 'NGINX'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3101;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
        client_max_body_size 10m;
    }
}
NGINX

# Xoa default neu con
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/foodwatch /etc/nginx/sites-enabled/foodwatch
nginx -t && systemctl reload nginx

echo ""
echo "=== XONG ==="
echo "Health check: curl http://localhost:3101/api/health"
echo "Xem log:      pm2 logs foodwatch --lines 30"
echo ""
echo "Buoc tiep theo:"
echo "  1. Chinh sua domain trong /etc/nginx/sites-available/foodwatch"
echo "  2. Tro A record domain ve 213.199.45.68 tren Cloudflare"
