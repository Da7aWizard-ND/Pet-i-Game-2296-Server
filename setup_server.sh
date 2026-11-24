#!/usr/bin/env bash
# i-Pet Cyber Store 2096 lobby server setup, for a fresh Ubuntu server (Oracle Cloud,
# Vultr, or any Ubuntu 22.04/24.04 box).
#
#   bash setup_server.sh <duckdns-name>
#
# e.g. "bash setup_server.sh ipet2096" for ipet2096.duckdns.org.
# It installs Node.js and Caddy, puts the lobby server and website in /opt/peti-lobby,
# keeps it running (and restarts it after a reboot or crash), opens ports
# 80/443, and gets a free security certificate so the game can connect with
# wss://<name>.duckdns.org (the web/phone version needs that).
#
# Safe to run again: that's also how you update the server to a new version
# (upload the complete deployment folder, then run this script again).
set -euo pipefail

NAME="${1:-}"
if [[ -z "$NAME" ]]; then
  echo "Usage: bash setup_server.sh <duckdns-name>   (e.g. ipet2096)"
  exit 1
fi
DOMAIN="$NAME"
[[ "$DOMAIN" == *.* ]] || DOMAIN="$NAME.duckdns.org"
SUDO=""
[[ $EUID -ne 0 ]] && SUDO="sudo"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/website/index.html" && -d "$SCRIPT_DIR/website/img" ]]; then
  SITE_SOURCE="$SCRIPT_DIR/website"
  SITE_MODE="folder"
elif [[ -f "$SCRIPT_DIR/index.html" && -d "$SCRIPT_DIR/img" ]]; then
  SITE_SOURCE="$SCRIPT_DIR"
  SITE_MODE="flat"
else
  echo "Website files not found. Upload website/ or index.html and img/ beside setup_server.sh."
  exit 1
fi

echo "==> i-Pet lobby server for $DOMAIN"

echo "==> Installing Node.js and Caddy (a few minutes the first time)"
$SUDO apt-get update -y -q
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs npm caddy iptables-persistent netfilter-persistent >/dev/null || \
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs npm caddy >/dev/null
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if (( NODE_MAJOR < 18 )); then
  echo "!! Node.js $NODE_MAJOR is too old (need 18+). Use Ubuntu 24.04, or install Node 20 from nodesource.com."
  exit 1
fi

echo "==> Installing the lobby server files in /opt/peti-lobby"
$SUDO mkdir -p /opt/peti-lobby
for FILE in lobby_server.js filter.js store.js social.js codes.js config.js accounts.js package.json package-lock.json; do
  if [[ ! -f "$SCRIPT_DIR/$FILE" ]]; then
    echo "Required server file is missing: $SCRIPT_DIR/$FILE"
    exit 1
  fi
  $SUDO install -m 644 "$SCRIPT_DIR/$FILE" "/opt/peti-lobby/$FILE"
done
id -u peti >/dev/null 2>&1 || $SUDO useradd --system --home /opt/peti-lobby --shell /usr/sbin/nologin peti
(cd /opt/peti-lobby && $SUDO npm install --omit=dev --no-audit --no-fund -q)
echo "==> Installing website files"
$SUDO mkdir -p /opt/peti-lobby/site
if [[ "$SITE_MODE" == "folder" ]]; then
  $SUDO cp -a "$SITE_SOURCE"/. /opt/peti-lobby/site/
else
  $SUDO cp -a "$SITE_SOURCE/index.html" "$SITE_SOURCE/img" /opt/peti-lobby/site/
fi
$SUDO chown -R peti:peti /opt/peti-lobby

echo "==> Keeping it running (systemd service 'peti-lobby')"
$SUDO tee /etc/systemd/system/peti-lobby.service >/dev/null <<'PETI_EOF'
[Unit]
Description=i-Pet Cyber Store 2096 lobby server
After=network.target

[Service]
User=peti
WorkingDirectory=/opt/peti-lobby
Environment=PORT=8080
EnvironmentFile=-/etc/peti-lobby.env
ExecStart=/usr/bin/node lobby_server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
PETI_EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable peti-lobby >/dev/null 2>&1
$SUDO systemctl restart peti-lobby

echo "==> Secure address (Caddy + free certificate) for $DOMAIN"
$SUDO tee /etc/caddy/Caddyfile >/dev/null <<PETI_EOF
$DOMAIN {
	reverse_proxy localhost:8080
}
PETI_EOF
$SUDO systemctl enable caddy >/dev/null 2>&1
$SUDO systemctl restart caddy

echo "==> Opening ports 80 and 443 on this server's own firewall"
# Oracle's Ubuntu images block everything except SSH in iptables.
for PORT in 80 443; do
  if ! $SUDO iptables -C INPUT -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT 2>/dev/null; then
    $SUDO iptables -I INPUT 5 -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT 2>/dev/null || \
      $SUDO iptables -I INPUT -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT
  fi
done
$SUDO netfilter-persistent save >/dev/null 2>&1 || true
if command -v ufw >/dev/null && $SUDO ufw status | grep -q "Status: active"; then
  $SUDO ufw allow 80/tcp >/dev/null; $SUDO ufw allow 443/tcp >/dev/null
fi

echo "==> Checking"
sleep 3
if curl -fsS http://localhost:8080/ >/dev/null; then
  echo "    Lobby server: running"
else
  echo "!!  Lobby server isn't answering. Logs: sudo journalctl -u peti-lobby -n 50"
fi
echo "    Getting the certificate can take a minute. Then open https://$DOMAIN in a browser:"
echo "    it should show the i-Pet Cyber Store 2096 website."
echo
echo "Done. The game's server address is:  wss://$DOMAIN"
echo "Useful later:  sudo systemctl restart peti-lobby   ·   sudo journalctl -u peti-lobby -f   ·   cat /opt/peti-lobby/reports.log"
