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
# Whatever listens on the port must be this folder's server: running from this folder, or naming this folder's
# server.js on its command line (node /path/to/hub/server.js started from elsewhere). Another hub (another install,
# the default port when .env has none) is never stopped or restarted from here.
listener_cwd() {
  if [ -e "/proc/$1/cwd" ]; then readlink "/proc/$1/cwd" 2>/dev/null
  elif command -v lsof >/dev/null 2>&1; then lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
  fi
}
real_dir() { [ -n "$1" ] && [ -d "$1" ] && (cd "$1" && pwd -P); }   # real paths on both sides: a symlinked install folder is still this one
PROJECT_DIR_REAL="$(cd "$PROJECT_DIR" && pwd -P)"
is_this_hub() {
  local p="$1" d a f
  [ -n "$p" ] || return 1
  d=$(listener_cwd "$p")
  [ -n "$d" ] && [ "$(real_dir "$d")" = "$PROJECT_DIR_REAL" ] && return 0
  if [ -r "/proc/$p/cmdline" ]; then
    while IFS= read -r -d '' a; do
      case "$a" in server.js|*/server.js) ;; *) continue ;; esac
      case "$a" in /*) f="$a" ;; *) [ -n "$d" ] || continue; f="$d/$a" ;; esac
      [ -f "$f" ] && [ "$(real_dir "$(dirname "$f")")" = "$PROJECT_DIR_REAL" ] && return 0
    done < "/proc/$p/cmdline"
    return 1
  fi
  a=$(ps -o args= -p "$p" 2>/dev/null) || return 1
  case " $a " in *" $PROJECT_DIR_REAL/server.js "*|*" $PROJECT_DIR/server.js "*) return 0 ;; esac
  return 1
}
_lp=$(find_listener | head -1)
if [ -n "$_lp" ] && ! is_this_hub "$_lp"; then
  _lcwd=$(listener_cwd "$_lp")
  echo "❌ Port $HUB_PORT is served by PID $_lp running from ${_lcwd:-an unknown folder}, not $PROJECT_DIR. Not touching it." >&2
  exit 1
fi

# ── Is the server a service's own process? ──
# A service counts only when the process it reports is this server, or the shell / npm the service manager started to
# run it (ExecStart=bash -lc '… node server.js' for nvm, npm start). A hub started by hand from inside another hub's
# service (an agent's shell) sits in that service's cgroup too: restarting the service would restart the other hub.
ppid_of() { if [ -r "/proc/$1/status" ]; then sed -n 's/^PPid:[[:space:]]*//p' "/proc/$1/status"; else ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; fi; }
comm_of() { if [ -r "/proc/$1/comm" ]; then cat "/proc/$1/comm"; else basename "$(ps -o comm= -p "$1" 2>/dev/null)" 2>/dev/null; fi; }
is_manager() { [ "$1" = "1" ] || [ "$(comm_of "$1")" = "systemd" ]; }
is_wrapper() {
  case "$(comm_of "$1")" in
    sh|bash|dash|zsh|ksh|npm|npm\ *) return 0 ;;
    node) if [ -r "/proc/$1/cmdline" ]; then tr '\0' '\n' < "/proc/$1/cmdline" | sed -n 2p; else ps -o args= -p "$1" 2>/dev/null | awk '{print $2}'; fi | grep -qE '(^|/)(npm|npm-cli\.js)$' ;;
    *) return 1 ;;
  esac
}
# service_runs <server pid> <pid the service manager reports>: that pid is the server, or a shell / npm the manager started
service_runs() {
  local pp
  [ "$2" = "$1" ] && return 0
  { [ -n "$2" ] && [ "$2" != "0" ]; } || return 1
  pp=$(ppid_of "$1")
  [ "$2" = "$pp" ] && is_wrapper "$pp" && is_manager "$(ppid_of "$pp")"
}
# started_by_manager <server pid>: the service manager started it, directly or through a shell / npm. Only for when the
# manager can't be asked: a server left behind by a shell that exited is adopted by the manager and looks the same, so
# this never restarts a unit, it only asks this one server to exit.
started_by_manager() {
  local pp
  pp=$(ppid_of "$1")
  [ -n "$pp" ] || return 1
  is_manager "$pp" && return 0
  is_wrapper "$pp" && is_manager "$(ppid_of "$pp")"
}

# ── Run by launchd (macOS)? Let launchd restart it, but only the job whose process IS this hub ──
# The listener (checked above to be this folder's) must be the very process launchd reports for the job. A label alone
# proves nothing: another hub on this Mac may use it (the legacy com.agent-hub). Killing the server ourselves would
# race KeepAlive's respawn against the nohup copy below.
if [ "$(uname)" = "Darwin" ] && [ -n "$_lp" ]; then
  for _plist in "$HOME"/Library/LaunchAgents/*.plist; do
    [ -f "$_plist" ] || continue
    _label=$(basename "$_plist" .plist)
    _jpid=$(launchctl print "gui/$(id -u)/$_label" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)[[:space:]]*$/\1/p' | head -1)
    if [ -n "$_jpid" ] && service_runs "$_lp" "$_jpid"; then
      echo "[restart] Restarting launchd service $_label (PID $_lp)..."
      launchctl kickstart -k "gui/$(id -u)/$_label"
      echo "✅ Service restarted"
      exit 0
    fi
  done
fi

# ── Running under systemd (Linux)? Let systemd restart it ──
# Only the unit whose own process is this server (above): ask systemd to restart it (user or system scope). Killing
# it ourselves and starting a nohup copy would race systemd's own respawn and leave two servers fighting for the port.
# When systemctl is not permitted (a system unit, run as the service user), signal the server to exit for a restart
# instead: SIGUSR2 -> graceful shutdown -> exit 75, which Restart=always and Restart=on-failure both bring back.
if command -v systemctl >/dev/null 2>&1 && [ -n "$_lp" ] && [ -r "/proc/$_lp/cgroup" ]; then
  _unit=$(grep -oE '[A-Za-z0-9@._:-]+\.service' "/proc/$_lp/cgroup" | grep -vE '^user@[0-9]+\.service$' | tail -1)
  if [ -n "$_unit" ]; then
    _scope=""; grep -q "/user@" "/proc/$_lp/cgroup" 2>/dev/null && _scope="--user"
    _main=$(systemctl $_scope show -p MainPID "$_unit" 2>/dev/null | sed -n 's/^MainPID=\([0-9][0-9]*\)$/\1/p')
    if [ -n "$_main" ] && service_runs "$_lp" "$_main"; then
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
    if [ -z "$_main" ] && started_by_manager "$_lp"; then
      echo "[restart] systemd can't be asked about $_unit, and it started PID $_lp: asking the server to exit for a restart (SIGUSR2 -> exit 75)..."
      if kill -USR2 "$_lp" 2>/dev/null; then
        echo "✅ Restart requested; systemd brings the server back if it is $_unit's own process (it couldn't be asked to confirm)"
        exit 0
      fi
      echo "❌ Could not signal PID $_lp"
      exit 1
    fi
    echo "[restart] PID $_lp is inside $_unit but is not that unit's own process (started by hand from inside it): restarting the server by itself"
  fi
fi

# ── Stop the running server ──

# Try PID file first
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE" 2>/dev/null)
  # only this folder's server: a stale file may name a pid that now belongs to something else
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null && is_this_hub "$OLD_PID"; then
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

# Kill what still listens on the port: this folder's server only (the port may have changed hands meanwhile)
for LISTEN_PID in $(find_listener); do
  if ! is_this_hub "$LISTEN_PID"; then
    echo "❌ Port $HUB_PORT is now served by PID $LISTEN_PID, which is not $PROJECT_DIR's server. Not touching it." >&2
    exit 1
  fi
  echo "[restart] Killing listener on port $HUB_PORT (PID $LISTEN_PID)..."
  kill -9 "$LISTEN_PID" 2>/dev/null || true
done

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
for _v in PATH HOME USER LOGNAME SHELL LANG LANGUAGE TZ TMPDIR TMP TEMP HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS SSH_AUTH_SOCK CLAUDE_CONFIG_DIR CODEX_HOME $(env | sed -n 's/^\(LC_[A-Za-z_]*\)=.*/\1/p'); do
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
