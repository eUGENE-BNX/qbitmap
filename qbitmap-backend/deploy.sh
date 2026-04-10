#!/usr/bin/env bash
set -euo pipefail

# QBitmap Backend Deploy Script
# Protects uploads/, db files, and pem keys from accidental deletion.

SERVER="root@91.99.219.248"
REMOTE_PATH="/opt/qbitmap-backend"
LOCAL_PATH="$(cd "$(dirname "$0")" && pwd)"

# --- Safety excludes (NEVER remove these) ---
EXCLUDES=(
  --exclude='.git'
  --exclude='node_modules'
  --exclude='*.db'
  --exclude='*.db-wal'
  --exclude='*.db-shm'
  --exclude='uploads'
  --exclude='*.pem'
)

echo "=== QBitmap Backend Deploy ==="
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

# Step 3: Fix permissions & restart
echo ""
echo "--- Setting permissions & restarting service ---"
ssh "$SERVER" "chown -R qbitmap:qbitmap $REMOTE_PATH && systemctl restart qbitmap-backend"

echo ""
echo "=== Deploy complete ==="
