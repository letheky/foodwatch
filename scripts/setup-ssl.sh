#!/bin/bash
set -e

DOMAIN="foodwatch.duckdns.org"
TOKEN="${1:?Thieu DuckDNS token. Chay: bash setup-ssl.sh <token>}"

echo "=== FoodWatch SSL Setup ==="

# 1. Cập nhật IP trên DuckDNS
echo "[1] Cap nhat IP DuckDNS..."
RESULT=$(curl -s "https://www.duckdns.org/update?domains=foodwatch&token=$TOKEN&ip=")
echo "  DuckDNS: $RESULT"
if [ "$RESULT" != "OK" ]; then
  echo "  WARN: DuckDNS tra ve '$RESULT', kiem tra lai token/domain"
fi

# 2. Nginx config với domain thật
echo "[2] Cap nhat Nginx config..."
cat > /etc/nginx/sites-available/foodwatch << NGINX
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://localhost:3101;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 120s;
        client_max_body_size 10m;
    }
}
NGINX
nginx -t && systemctl reload nginx

# 3. Cài Certbot
echo "[3] Cai Certbot..."
apt install -y certbot python3-certbot-nginx -q

# 4. Lấy SSL cert (Let's Encrypt)
echo "[4] Lay chung chi SSL..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "noreply@duckdns.org" --redirect

# 5. Auto-update IP DuckDNS mỗi 5 phút (phòng VPS đổi IP)
echo "[5] Setup cron auto-update DuckDNS..."
mkdir -p /opt/duckdns
cat > /opt/duckdns/update.sh << DUCK
#!/bin/bash
curl -s "https://www.duckdns.org/update?domains=foodwatch&token=$TOKEN&ip=" >> /opt/duckdns/duck.log 2>&1
DUCK
chmod +x /opt/duckdns/update.sh
(crontab -l 2>/dev/null | grep -v duckdns; echo "*/5 * * * * /opt/duckdns/update.sh") | crontab -

echo ""
echo "=== XONG ==="
echo "Truy cap: https://$DOMAIN"
curl -s http://localhost:3101/api/health
