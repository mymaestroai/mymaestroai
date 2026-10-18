#!/bin/bash
# safe-restart.sh — Agent-safe restart for My Maestro AI
#
# Designed to be called by an agent via the Bash tool, or by the hub itself (lib/restart) on installs that are
# not supervised by systemd. Waits for the calling connection to finish, then restarts the server.
#
# Usage: nohup scripts/safe-restart.sh &
# (Must be run detached so it survives the server shutdown)
#
# Output goes to a log the current user can write: data/restart.log, else the temp dir. It used to append to
# server.log, which a systemd unit's StandardOutput=append: creates as root, so the redirect failed and set -e
# killed the script before restart.sh ever ran — silently, because the caller ignored its output.
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$PROJECT_DIR/data/restart.log"
mkdir -p "$PROJECT_DIR/data" 2>/dev/null
if ! ( : >> "$LOG" ) 2>/dev/null; then LOG="${TMPDIR:-/tmp}/agent-hub-restart.log"; fi

echo "[safe-restart] $(date '+%F %T') Waiting 3 seconds for current response to complete..." | tee -a "$LOG"
sleep 3
echo "[safe-restart] Restarting server (log: $LOG)..." | tee -a "$LOG"
if "$PROJECT_DIR/scripts/restart.sh" >> "$LOG" 2>&1; then
  echo "[safe-restart] Done." | tee -a "$LOG"
else
  echo "[safe-restart] restart.sh FAILED (exit $?). See $LOG" | tee -a "$LOG" >&2
  exit 1
fi
