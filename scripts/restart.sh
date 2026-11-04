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
    fuser "$HUB_PORT/tcp" 2>/dev/null | tr -s '[:space:]' '\n' | sed '/^$/d' || true
  fi
}

# ── Only ever this folder's hub ──
# Whatever listens on the port must be this folder's server: a node process whose script is this folder's server.js
# (resolved against its working directory). The working directory alone doesn't count (a shell or a build in the
# folder isn't the hub). Another hub (another install, the default port when .env has none) is never touched.
listener_cwd() {
  if [ -e "/proc/$1/cwd" ]; then readlink "/proc/$1/cwd" 2>/dev/null
  elif command -v lsof >/dev/null 2>&1; then lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
  fi
}
real_dir() { [ -n "$1" ] && [ -d "$1" ] && (cd "$1" && pwd -P); }   # real paths on both sides: a symlinked install folder is still this one
PROJECT_DIR_REAL="$(cd "$PROJECT_DIR" && pwd -P)"
is_this_hub() {
  local p="$1" d a f n=0 skip="" args
  [ -n "$p" ] || return 1
  d=$(listener_cwd "$p")
  if [ -r "/proc/$p/cmdline" ]; then
    while IFS= read -r -d '' a; do
      n=$((n+1))
      if [ "$n" = 1 ]; then case "$(basename "$a")" in node|nodejs|node[0-9]*) continue ;; *) return 1 ;; esac; fi
      if [ -n "$skip" ]; then skip=""; continue; fi
      case "$a" in
        -e*|-p*|-c|-i|--eval|--eval=*|--print|--print=*|--check|--interactive) return 1 ;;   # code from the command line
        -r|--require|--import|--loader|--experimental-loader|--title|--env-file|-C|--conditions|--input-type) skip=1; continue ;;
        -*) continue ;;
      esac
      case "$a" in /*) f="$a" ;; *) [ -n "$d" ] || return 1; f="$d/$a" ;; esac
      [ "$(basename "$f")" = "server.js" ] && [ -f "$f" ] && [ "$(real_dir "$(dirname "$f")")" = "$PROJECT_DIR_REAL" ]
      return
    done < "/proc/$p/cmdline"
    return 1
  fi
  # no /proc (macOS): node's whole command line from ps must be `node [options] <this folder's server.js>`: the node
  # binary first, only options between, the script last (it may contain spaces); its working directory from lsof
  args=$(ps -o args= -p "$p" 2>/dev/null) || return 1
  local opts='( -[^ ]+)*'
  printf '%s\n' "$args" | grep -qE '^[^ ]*node[0-9]*( -[^ ]+)* +(-[epci][^ ]*|--(eval|print|check|interactive)(=[^ ]*)?)( |$)' && return 1
  for f in "$PROJECT_DIR_REAL/server.js" "$PROJECT_DIR/server.js"; do
    case "$args" in *" $f") [ "$(printf '%s' "${args% "$f"}" | sed -E "s/^([^ ]*\/)?(node|nodejs|node[0-9]+)$opts\$//")" = "" ] && return 0 ;; esac
  done
  if [ -n "$d" ] && [ "$(real_dir "$d")" = "$PROJECT_DIR_REAL" ]; then
    case "$args" in *" server.js"|*" ./server.js") [ "$(printf '%s' "${args% *}" | sed -E "s/^([^ ]*\/)?(node|nodejs|node[0-9]+)$opts\$//")" = "" ] && return 0 ;; esac
  fi
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
# a shell, npm or npx: how a service runs node through nvm (bash -lc '… node server.js'), a start script (a #! script
# runs as its interpreter: argv[0] is the shell, comm the script's name) or npm start
is_wrapper() {
  local pid="$1" c a0 a1 args
  c=$(comm_of "$pid")
  if [ -r "/proc/$pid/cmdline" ]; then
    a0=$(tr '\0' '\n' < "/proc/$pid/cmdline" | sed -n 1p); a1=$(tr '\0' '\n' < "/proc/$pid/cmdline" | sed -n 2p)
  else
    args=$(ps -o args= -p "$pid" 2>/dev/null); a0=${args%% *}; a1=$(printf '%s\n' "$args" | awk '{print $2}')
  fi
  a0=$(basename "${a0:-x}")
  case "$c" in sh|bash|dash|zsh|ksh|npm|npm\ *) return 0 ;; esac
  case "$a0" in sh|bash|dash|zsh|ksh|npm|npx) return 0 ;; esac
  case "$c/$a0" in node/*|*/node) printf '%s\n' "$a1" | grep -qE '(^|/)(npm|npm-cli\.js|npx|npx-cli\.js)$' && return 0 ;; esac
  return 1
}
# service_runs <server pid> <pid the service manager reports>: 0 when that pid is the server, 2 when it is a chain of
# shells / npm the manager started that ends at the server, 1 otherwise
service_runs() {
  local cur="$1" pp hops=0
  [ "$2" = "$1" ] && return 0
  { [ -n "$2" ] && [ "$2" != "0" ]; } || return 1
  while [ "$hops" -lt 4 ]; do
    pp=$(ppid_of "$cur"); [ -n "$pp" ] || return 1
    is_wrapper "$pp" || return 1
    if [ "$pp" = "$2" ]; then is_manager "$(ppid_of "$pp")" && return 2; return 1; fi
    cur="$pp"; hops=$((hops+1))
  done
  return 1
}
# started_by_manager <server pid>: the service manager started it, directly or through wrappers. Only for when the
# manager can't be asked: a server left behind by a shell that exited is adopted by the manager and looks the same, so
# the unit's own file decides too, and this never restarts a unit: it only asks this one server to exit.
started_by_manager() {
  local cur="$1" pp hops=0
  while [ "$hops" -lt 5 ]; do
    pp=$(ppid_of "$cur"); [ -n "$pp" ] || return 1
    is_manager "$pp" && return 0
    is_wrapper "$pp" || return 1
    cur="$pp"; hops=$((hops+1))
  done
  return 1
}
# node for the checks below, found now: the profiles and nvm are only read for the start further down. Without it every
# service file reads as "can't tell", which refuses rather than guesses.
HELPER_NODE=$(command -v node 2>/dev/null || ls -1dt "$HOME"/.mymaestroai/node/bin/node "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | head -1)
# owner_of: stdin is a unit file or plist; prints whose hub it runs: ours, other or unknown (lib/service-manager; start
# scripts it names are read too)
owner_of() {
  [ -n "$HELPER_NODE" ] || { cat > /dev/null; echo unknown; return; }
  "$HELPER_NODE" -e 'let t = ""; process.stdin.on("data", (d) => { t += d; }).on("end", () => { try { const sm = require(process.argv[1]); console.log(t ? sm.serviceOwnership(t, process.argv[2], { readScript: (f) => sm.readStartScript(f) }) : "unknown"); } catch { console.log("unknown"); } });' "$PROJECT_DIR/lib/service-manager.js" "$PROJECT_DIR_REAL" 2>/dev/null || echo unknown
}
# a unit's files as systemd loads them, from disk (for when systemd can't be asked)
unit_files() { [ -n "$HELPER_NODE" ] || return 0; "$HELPER_NODE" -e 'try { process.stdout.write(require(process.argv[1]).serviceFileText(process.argv[2], process.argv[3])); } catch {}' "$PROJECT_DIR/lib/service-manager.js" "$1" "$2" 2>/dev/null || true; }
# refuse <service> <command> [other]: the hub runs under a service whose file doesn't show it runs only this hub
refuse_wrapped() {
  if [ -n "${3:-}" ]; then echo "❌ PID $_lp runs under $1, whose file also starts something else: restarting it here would stop that too. Restart it with: $2" >&2
  else echo "❌ PID $_lp runs under $1 through a shell or script, and the service's file doesn't show that it runs only this hub: restarting it here could stop something else. Restart it with: $2" >&2; fi
  exit 1
}
# A node process whose script is some folder's server.js (a hub); an agent client (Claude, Codex)
is_hub_server() {
  local a n=0
  [ -r "/proc/$1/cmdline" ] || return 1
  while IFS= read -r -d '' a; do
    n=$((n+1))
    if [ "$n" = 1 ]; then case "$(basename "$a")" in node|nodejs|node[0-9]*) continue ;; *) return 1 ;; esac; fi
    case "$a" in -*) continue ;; esac
    [ "$(basename "$a")" = "server.js" ]; return
  done < "/proc/$1/cmdline"
  return 1
}
is_agent_runner() { case "$(comm_of "$1")" in claude*|codex*) return 0 ;; esac; tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -qE '@anthropic-ai/claude-code|@openai/codex'; }
# supervisor_of <server pid> <unit>: what inside the unit runs the server and would start it again (pm2, forever, a
# script that waits), through any shells in between; nothing for an agent's shell (Claude, Codex, a hub)
supervisor_of() {
  local cur="$1" pp hops=0
  while [ "$hops" -lt 6 ]; do
    pp=$(ppid_of "$cur"); [ -n "$pp" ] || return 0
    is_manager "$pp" && return 0
    if is_wrapper "$pp"; then cur="$pp"; hops=$((hops+1)); continue; fi
    if [ -r "/proc/$pp/cgroup" ] && grep -qF "/$2" "/proc/$pp/cgroup" && ! is_hub_server "$pp" && ! is_agent_runner "$pp"; then echo "$pp"; fi
    return 0
  done
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
    _how=1; if [ -n "$_jpid" ]; then service_runs "$_lp" "$_jpid" && _how=0 || _how=$?; fi
    # through a wrapper, only a job whose plist shows it runs this hub alone (one wrapper may start two hubs)
    if [ "$_how" = 2 ] && [ "$(owner_of < "$_plist")" != "ours" ]; then refuse_wrapped "launchd job $_label" "launchctl kickstart -k gui/$(id -u)/$_label"; fi
    if [ "$_how" = 0 ] || [ "$_how" = 2 ]; then
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
  _unit=$(grep -oE '([A-Za-z0-9@._:-]|\\x[0-9a-fA-F]{2})+\.service' "/proc/$_lp/cgroup" | grep -vE '^user@[0-9]+\.service$' | tail -1)
  if [ -n "$_unit" ]; then
    _scope=""; grep -q "/user@" "/proc/$_lp/cgroup" 2>/dev/null && _scope="--user"
    _cguid=$(sed -n 's|.*/user@\([0-9][0-9]*\)\.service/.*|\1|p' "/proc/$_lp/cgroup" | head -1)
    _main=""
    # another user's manager can't be asked from here: `systemctl --user` would ask this user's own
    if [ -z "$_cguid" ] || [ "$_cguid" = "$(id -u)" ]; then
      _main=$(systemctl $_scope show -p MainPID "$_unit" 2>/dev/null | sed -n 's/^MainPID=\([0-9][0-9]*\)$/\1/p')
    fi
    _how=1; if [ -n "$_main" ]; then service_runs "$_lp" "$_main" && _how=0 || _how=$?; fi
    # the unit's own process, but its file may start another hub too (ExecStartPost): restarting would stop it
    if [ "$_how" = 0 ] && [ "$(systemctl $_scope cat "$_unit" 2>/dev/null | owner_of)" = "other" ]; then refuse_wrapped "systemd unit $_unit" "systemctl $_scope restart $_unit" other; fi
    # through a wrapper, only a unit whose own file shows it runs this hub alone (one wrapper may start two hubs):
    # restarting it otherwise could stop another hub, and restarting the server by hand would race the unit's respawn
    if [ "$_how" = 2 ] && [ "$(systemctl $_scope cat "$_unit" 2>/dev/null | owner_of)" != "ours" ]; then refuse_wrapped "systemd unit $_unit" "systemctl $_scope restart $_unit"; fi
    if [ "$_how" = 0 ] || [ "$_how" = 2 ]; then
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
      # systemd can't be asked, and it (or a wrapper it started) started the server; a hub left behind by a shell that
      # exited is adopted by the manager and looks the same, so the unit's own file on disk decides
      _owner=$(unit_files "$_unit" "$([ -n "$_scope" ] && echo user || echo system)" | owner_of)
      if [ "$_owner" = "ours" ]; then
        echo "[restart] systemd can't be asked about $_unit; it started PID $_lp and its file runs this hub: asking the server to exit for a restart (SIGUSR2 -> exit 75)..."
        if kill -USR2 "$_lp" 2>/dev/null; then
          echo "✅ Restart requested; systemd brings the service back"
          exit 0
        fi
        echo "❌ Could not signal PID $_lp"
        exit 1
      fi
      if [ "$_owner" != "other" ]; then
        echo "❌ systemd can't be asked about $_unit, and its file doesn't show whether it runs this hub. Restart it with: systemctl $_scope restart $_unit" >&2
        exit 1
      fi
    fi
    # Something inside the unit runs the server and would start it again (pm2, forever; directly or through a shell):
    # killing it here would race that supervisor. An agent's shell (Claude, Codex, a hub) is the hand-started case.
    _sp=$(supervisor_of "$_lp" "$_unit")
    if [ -n "$_sp" ]; then
      echo "❌ PID $_lp is run by PID $_sp ($(comm_of "$_sp")) inside $_unit: restart that instead." >&2
      exit 1
    fi
    echo "[restart] PID $_lp is inside $_unit but is not that unit's own process (started by hand from inside it): restarting the server by itself"
  fi
fi

# ── Never another user's server ──
# Run as another user than the server's (sudo restart.sh), stopping it here and starting a copy as this user would leave
# a hub running under the wrong account: restart it as the user it runs as.
if [ -n "$_lp" ]; then
  _luid=$(stat -c %u "/proc/$_lp" 2>/dev/null || ps -o uid= -p "$_lp" 2>/dev/null | tr -d ' ')
  if [ -n "$_luid" ] && [ "$_luid" != "$(id -u)" ]; then
    echo "❌ PID $_lp runs as another user (uid $_luid). Run this script as that user." >&2
    exit 1
  fi
fi

# ── Stop the running server ──

# Try PID file first
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE" 2>/dev/null)
  # only this folder's server: a stale file may name a pid that now belongs to something else
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null && is_this_hub "$OLD_PID"; then
    echo "[restart] Stopping server (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    for i in 1 2 3 4 5; do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$OLD_PID" 2>/dev/null && is_this_hub "$OLD_PID" && kill -9 "$OLD_PID" 2>/dev/null || true
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
