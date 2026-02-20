#!/bin/bash
# Auto-deploy: pull latest code + restart VPS gateway
# Called by the /deploy webhook endpoint (detached from parent)
# Configure DEPLOY_DIR in .env or set it here

LOG="/tmp/deploy-$(date +%Y%m%d-%H%M%S).log"
exec > "$LOG" 2>&1

echo "=== Deploy started at $(date) ==="

# Wait for webhook response to be sent
sleep 2

# Default to current script's directory
DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$(dirname "$0")" && pwd)}"
cd "$DEPLOY_DIR" || exit 1

# Pull latest
echo "Pulling latest..."
git pull origin "${DEPLOY_BRANCH:-master}" 2>&1

# Install dependencies if lockfile changed
if git diff HEAD@{1} --name-only 2>/dev/null | grep -q "bun.lock\|package.json"; then
  echo "Dependencies changed, installing..."
  bun install 2>&1
fi

# Restart gateway — use PM2 if available, else nohup fallback
if command -v pm2 &>/dev/null && pm2 describe go-bot &>/dev/null; then
  echo "Restarting via PM2..."
  pm2 restart go-bot 2>&1
  echo "PM2 restart complete"
else
  echo "Killing gateway (nohup mode)..."
  kill $(pgrep -f "bun.*vps-gateway.ts") 2>/dev/null
  sleep 1
  echo "Starting gateway..."
  nohup bun run src/vps-gateway.ts > /tmp/gateway.log 2>&1 &
  echo "New PID: $!"
fi

echo "=== Deploy complete at $(date) ==="
