#!/bin/bash
# Install Jarvis as a macOS launchd daemon (user agent)

set -euo pipefail

PLIST_NAME="com.jeetvaidya.jarvis.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SOURCE_PLIST="$SCRIPT_DIR/jarvis.plist"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/$PLIST_NAME"
NODE_PATH="$(which node)"

echo "Jarvis Daemon Installer"
echo "======================="
echo "Project: $PROJECT_DIR"
echo "Node: $NODE_PATH"
echo ""

# Build first
echo "Building..."
cd "$PROJECT_DIR"
npm run build

# Ensure logs directory exists
mkdir -p "$PROJECT_DIR/logs"

# Create a customized plist with correct node path
sed "s|/usr/local/bin/node|$NODE_PATH|g" "$SOURCE_PLIST" > "$TARGET_PLIST"

# Load .env into plist EnvironmentVariables
if [ -f "$PROJECT_DIR/.env" ]; then
  echo "Loading .env variables into plist..."
  # Parse .env and add to plist (simple key=value lines, skip comments)
  ENV_XML=""
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip empty lines and comments
    [[ -z "$line" || "$line" =~ ^# ]] && continue
    KEY="${line%%=*}"
    VALUE="${line#*=}"
    # Skip if key is empty
    [[ -z "$KEY" ]] && continue
    ENV_XML="$ENV_XML        <key>$KEY</key>\n        <string>$VALUE</string>\n"
  done < "$PROJECT_DIR/.env"

  # Insert env vars into plist before the closing </dict> of EnvironmentVariables
  if [ -n "$ENV_XML" ]; then
    # Use perl for reliable multi-line replacement
    perl -i -pe "s|(<key>NODE_ENV</key>\s*<string>production</string>)|\\1\n$ENV_XML|" "$TARGET_PLIST"
  fi
fi

# Unload if already running
launchctl unload "$TARGET_PLIST" 2>/dev/null || true

# Load the daemon
launchctl load "$TARGET_PLIST"

echo ""
echo "Daemon installed and started!"
echo ""

# Verify
sleep 2
if launchctl list | grep -q "com.jeetvaidya.jarvis"; then
  echo "Status: RUNNING"
  echo ""
  echo "Useful commands:"
  echo "  launchctl list | grep jarvis     # Check status"
  echo "  launchctl unload $TARGET_PLIST   # Stop daemon"
  echo "  launchctl load $TARGET_PLIST     # Start daemon"
  echo "  tail -f $PROJECT_DIR/logs/daemon-stdout.log  # View logs"
else
  echo "Status: NOT RUNNING — check logs:"
  echo "  tail $PROJECT_DIR/logs/daemon-stderr.log"
fi
