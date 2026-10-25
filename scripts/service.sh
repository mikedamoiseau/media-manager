#!/bin/sh
# Run Media Manager in the background at login (macOS LaunchAgent).
#   scripts/service.sh install    build the web app, install and start the agent
#   scripts/service.sh uninstall  stop and remove the agent
#   scripts/service.sh restart    restart after an update
#   scripts/service.sh status     show whether it is running
set -e

LABEL="com.mediamanager.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PORT="${PORT:-8642}"
DOMAIN="gui/$(id -u)"

case "$1" in
  install)
    [ -n "$NODE" ] || { echo "node not found on PATH"; exit 1; }
    (cd "$ROOT" && npm run build >/dev/null)
    mkdir -p "$ROOT/data/logs" "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/server/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ROOT/data/logs/server.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/logs/server.log</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed. Open http://localhost:$PORT (or http://$(ipconfig getifaddr en0 || ipconfig getifaddr en1):$PORT on your phone)."
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed."
    ;;
  restart)
    (cd "$ROOT" && npm run build >/dev/null)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Restarted."
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state|pid" || echo "Not installed."
    ;;
  *)
    echo "usage: $0 install|uninstall|restart|status"
    exit 1
    ;;
esac
