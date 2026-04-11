#!/usr/bin/env bash
set -euo pipefail

# H3 Service Deploy Script

SERVER="root@46.224.128.93"
REMOTE_PATH="/opt/h3-service"
LOCAL_PATH="$(cd "$(dirname "$0")" && pwd)"

# --- Safety excludes ---
EXCLUDES=(
  --exclude='.git'
  --exclude='node_modules'
  --exclude='.env'
)

echo "=== H3 Service Deploy ==="
echo "Local:  $LOCAL_PATH"
echo "Remote: $SERVER:$REMOTE_PATH"
echo ""

# Step 1: Dry run
echo "--- Dry run (nothing will be changed yet) ---"
rsync -avz --delete --dry-run "${EXCLUDES[@]}" "$LOCAL_PATH/" "$SERVER:$REMOTE_PATH/"

echo ""
read -p "Proceed with deploy? (y/N) " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# Step 2: Actual deploy
echo ""
echo "--- Deploying... ---"
rsync -avz --delete "${EXCLUDES[@]}" "$LOCAL_PATH/" "$SERVER:$REMOTE_PATH/"

# Step 3: Install deps & restart
echo ""
echo "--- Installing deps & restarting service ---"
ssh "$SERVER" "cd $REMOTE_PATH && npm install --production && chown -R h3service:h3service $REMOTE_PATH && systemctl restart h3-service"

echo ""
echo "=== H3 Service deploy complete ==="
