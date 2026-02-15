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

# Kill current gateway
echo "Killing gateway..."
kill $(pgrep -f "bun.*vps-gateway.ts") 2>/dev/null
sleep 1

# Restart
echo "Starting gateway..."
nohup bun run src/vps-gateway.ts > /tmp/gateway.log 2>&1 &
echo "New PID: $!"

echo "=== Deploy complete at $(date) ==="
