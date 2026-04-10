#!/usr/bin/env bash
set -euo pipefail

# QBitmap Frontend Deploy Script
# Builds and deploys dist/. Protects maps/, uploads/, teslacam/, 3d/, model/, videos/.

SERVER="root@91.99.219.248"
REMOTE_PATH="/opt/qbitmap"
LOCAL_PATH="$(cd "$(dirname "$0")" && pwd)"

# --- Safety excludes (NEVER remove these) ---
EXCLUDES=(
  --exclude='maps'
  --exclude='uploads'
  --exclude='teslacam'
  --exclude='3d'
  --exclude='model'
  --exclude='videos'
)

echo "=== QBitmap Frontend Deploy ==="

# Step 1: Build
echo "--- Building... ---"
cd "$LOCAL_PATH"
npm run build

echo ""
echo "Local:  $LOCAL_PATH/dist/"
echo "Remote: $SERVER:$REMOTE_PATH/"
echo ""

# Step 2: Dry run
echo "--- Dry run (nothing will be changed yet) ---"
rsync -avz --delete --dry-run "${EXCLUDES[@]}" "$LOCAL_PATH/dist/" "$SERVER:$REMOTE_PATH/"

echo ""
read -p "Proceed with deploy? (y/N) " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# Step 3: Actual deploy
echo ""
echo "--- Deploying... ---"
rsync -avz --delete "${EXCLUDES[@]}" "$LOCAL_PATH/dist/" "$SERVER:$REMOTE_PATH/"

echo ""
echo "=== Deploy complete ==="
