#!/bin/bash
# My Maestro AI — restart script
# Usage: ./scripts/restart.sh
#
# Reads PORT from .env, stops the running server, restarts it.
# Works on Linux and macOS.

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$PROJECT_DIR/.server.pid"
LOG="$PROJECT_DIR/server.log"

# Read PORT from .env (default 8888)
HUB_PORT=8888
if [ -f "$PROJECT_DIR/.env" ]; then
  _port=$(grep -E '^PORT=' "$PROJECT_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')
  [ -n "$_port" ] && HUB_PORT="$_port"
fi

echo "[restart] Hub port: $HUB_PORT"

# ── Find process listening on the hub port ──
find_listener() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti TCP:"$HUB_PORT" -sTCP:LISTEN 2>/dev/null || true
  elif command -v ss >/dev/null 2>&1; then
    ss -tlnp "sport = :$HUB_PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$HUB_PORT/tcp" 2>/dev/null | tr -d '[:space:]' || true
  fi
}

# ── Only ever this folder's hub ──
# Whatever listens on the port must be running from this folder; another hub (another install, the default port when
# .env has none) is never stopped or restarted from here.
listener_cwd() {
  if [ -e "/proc/$1/cwd" ]; then readlink "/proc/$1/cwd" 2>/dev/null
  elif command -v lsof >/dev/null 2>&1; then lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
  fi
}
PROJECT_DIR_REAL="$(cd "$PROJECT_DIR" && pwd -P)"
_lp=$(find_listener | head -1)
if [ -n "$_lp" ]; then
  _lcwd=$(listener_cwd "$_lp")
  [ -n "$_lcwd" ] && [ -d "$_lcwd" ] && _lcwd="$(cd "$_lcwd" && pwd -P)"   # real paths on both sides: a symlinked install folder is still this one
  if [ "$_lcwd" != "$PROJECT_DIR_REAL" ] && [ "$_lcwd" != "$PROJECT_DIR" ]; then
    echo "❌ Port $HUB_PORT is served by PID $_lp running from ${_lcwd:-an unknown folder}, not $PROJECT_DIR. Not touching it." >&2
    exit 1
  fi
fi

# ── Run by launchd (macOS)? Let launchd restart it, but only the job whose process IS this hub ──
# The listener (checked above to be this folder's) must be the very process launchd reports for the job. A label alone
# proves nothing: another hub on this Mac may use it (the legacy com.agent-hub). Killing the server ourselves would
# race KeepAlive's respawn against the nohup copy below.
if [ "$(uname)" = "Darwin" ] && [ -n "$_lp" ]; then
  for _plist in "$HOME"/Library/LaunchAgents/*.plist; do
    [ -f "$_plist" ] || continue
    _label=$(basename "$_plist" .plist)
    _jpid=$(launchctl print "gui/$(id -u)/$_label" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)[[:space:]]*$/\1/p' | head -1)
    if [ "$_jpid" = "$_lp" ]; then
      echo "[restart] Restarting launchd service $_label (PID $_lp)..."
      launchctl kickstart -k "gui/$(id -u)/$_label"
      echo "✅ Service restarted"
      exit 0
    fi
  done
fi

# ── Running under systemd (Linux)? Let systemd restart it ──
# The listener belongs to a unit: ask systemd to restart that unit (user or system scope). Killing it ourselves and
# starting a nohup copy would race systemd's own respawn and leave two servers fighting for the port. When systemctl
# is not permitted (a system unit, run as the service user), signal the server to exit for a restart instead:
# SIGUSR2 -> graceful shutdown -> exit 75, which Restart=always and Restart=on-failure both bring back.
if command -v systemctl >/dev/null 2>&1; then
  _lp=$(find_listener)
  if [ -n "$_lp" ] && [ -r "/proc/$_lp/cgroup" ]; then
    _unit=$(grep -oE '[A-Za-z0-9@._-]+\.service' "/proc/$_lp/cgroup" | tail -1)
    if [ -n "$_unit" ] && [ "$_unit" != "user@$(id -u).service" ]; then
      _scope=""; grep -q "/user@" "/proc/$_lp/cgroup" 2>/dev/null && _scope="--user"
      echo "[restart] systemd unit $_unit (PID $_lp): asking systemd to restart it..."
      if systemctl $_scope restart "$_unit" 2>/dev/null; then
        echo "✅ Service restarted by systemd"
        exit 0
      fi
      echo "[restart] systemctl refused (no permission?); asking the server to exit for a restart (SIGUSR2 -> exit 75)..."
      if kill -USR2 "$_lp" 2>/dev/null; then
        echo "✅ Restart requested; systemd brings the service back"
        exit 0
      fi
      echo "❌ Could not signal PID $_lp"
      exit 1
    fi
  fi
fi

# ── Stop the running server ──

# Try PID file first
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[restart] Stopping server (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null
    for i in 1 2 3 4 5; do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null
  fi
  rm -f "$PIDFILE"
fi

# Kill whatever is listening on the port
LISTEN_PID=$(find_listener)
if [ -n "$LISTEN_PID" ]; then
  echo "[restart] Killing listener on port $HUB_PORT (PID $LISTEN_PID)..."
  kill -9 "$LISTEN_PID" 2>/dev/null || true
fi

# Wait until port is free (up to 10 seconds)
for i in $(seq 1 10); do
  [ -z "$(find_listener)" ] && break
  sleep 1
done
if [ -n "$(find_listener)" ]; then
  echo "❌ Port $HUB_PORT still in use after 10 seconds"
  exit 1
fi

# ── Source environment ──
for _profile in "$HOME/.zprofile" "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  if [ -f "$_profile" ]; then
    set +e
    source "$_profile" 2>/dev/null
    set -e
  fi
done
unset _profile

# ── Start server ──
cd "$PROJECT_DIR"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

echo "[restart] Starting My Maestro AI..."
echo "  Directory: $PROJECT_DIR"
echo "  Node:      $(node --version)"
echo "  Port:      $HUB_PORT"
echo "  Log:       $LOG"

# An allow-listed environment (lib/service-manager START_ENV_KEEP): the profiles above are read for PATH (nvm, Homebrew),
# but their provider keys, tokens and HUB_* settings don't reach the hub, which reads its own .env and settings.
_keep=()
for _v in PATH HOME USER LOGNAME SHELL LANG LANGUAGE TZ TMPDIR TMP TEMP HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS $(env | sed -n 's/^\(LC_[A-Za-z_]*\)=.*/\1/p'); do
  [ -n "${!_v+x}" ] && _keep+=("$_v=${!_v}")
done
# What the shell set that the hub won't receive now (a provider key, PORT, HUB_HOME): named, never shown.
node -e 'for (const n of require(process.argv[1]).envNotices({ dir: process.argv[2] })) console.log(`[restart] Note: ${n}`)' "$PROJECT_DIR/lib/service-manager.js" "$PROJECT_DIR" 2>/dev/null || true
nohup env -i "${_keep[@]}" node server.js >> "$LOG" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"

sleep 2
if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "✅ Server started (PID $NEW_PID)"
  echo "   http://127.0.0.1:$HUB_PORT"
else
  echo "❌ Server failed to start. Check $LOG"
  tail -20 "$LOG"
  exit 1
fi
