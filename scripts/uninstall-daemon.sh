#!/bin/bash
# Uninstall Jarvis launchd daemon

set -euo pipefail

PLIST_NAME="com.jeetvaidya.jarvis.plist"
TARGET_PLIST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "Jarvis Daemon Uninstaller"
echo "========================="

if [ -f "$TARGET_PLIST" ]; then
  launchctl unload "$TARGET_PLIST" 2>/dev/null || true
  rm "$TARGET_PLIST"
  echo "Daemon uninstalled."
else
  echo "Daemon not installed."
fi
