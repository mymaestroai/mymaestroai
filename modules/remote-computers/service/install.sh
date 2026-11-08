#!/usr/bin/env bash
# My Maestro - Remote computers: install MeshCentral as its own locked-down systemd service.
#
# Usage:
#   install.sh --check REQUEST       validate the request only and print "ok" (no root needed)
#   install.sh --print-unit REQUEST  validate, then print the systemd unit to stdout (no root needed)
#   install.sh [--replace] REQUEST   full install (must run as root, for example with sudo)
#   install.sh --help
#
# REQUEST is the file HOME_DIR/service/request.env that the hub wrote. Running this script with sudo trusts My Maestro's
# own files as they are at that moment, as installing My Maestro did. Within that, it never runs anything from the hub's
# folders as root and never lets the hub's folders steer what root reads or writes:
# - files in the hub's folders are read and written with the hub's own account (setpriv), so a link swapped in there
#   can only reach what that account could reach anyway;
# - files in the service's own folder are read and written with the service's account, inside the service's sandbox;
# - the node binary and the MeshCentral files are COPIED into /opt/NAME (root-owned, private until checked);
# - everything MeshCentral does, including making its accounts, runs as the service user inside the same sandbox
#   as the service (systemd-run), never outside it.
# Every value in the request is checked with a strict pattern first; anything unexpected is refused with exit 1.
set -euo pipefail
umask 077
export LC_ALL=C
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
BASH_BIN=$(command -v bash)   # /usr/bin/bash or /bin/bash, both visible in the sandbox
DD_BIN=$(command -v dd)

MESH_VERSION=1.3.1
MAX_REQUEST_BYTES=8192
MAX_CONFIG_BYTES=65536

die() { printf 'install.sh: refused: %s\n' "$*" >&2; exit 1; }
fail() { printf 'install.sh: error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage:
  install.sh --check REQUEST       validate the request only; prints "ok" (no root needed)
  install.sh --print-unit REQUEST  validate, then print the systemd unit file (no root needed)
  install.sh [--replace] REQUEST   full install; must be run as root (for example with sudo)
  install.sh --help

REQUEST is the file service/request.env that the hub wrote in its folder.
--replace lets the install take over a service of the same name that was made for a different hub folder.
EOF
}

# Temporary files (private to whoever runs this) and what to undo when a full install fails half way.
TMPD=$(mktemp -d /var/tmp/mymaestro-remote-install.XXXXXXXX)   # /var/tmp: kept copies survive a restart
NEW_DIR=
ROLLBACK=0     # set once the previous state is saved: from then on a failure puts it back
COMMITTED=0    # set once the new service answers: from then on nothing is put back
WAS_RUNNING=0  # the service ran (or was restarting) before this install stopped it
OLD_PROG=      # the previous /opt/NAME, moved aside until the new one answers
PREV_UNIT=0    # the previous unit file is saved in $TMPD/unit.prev
PREV_CFG=0     # the previous MeshCentral config is saved in $TMPD/config.prev
UNIT_WRITTEN=0
CFG_TOUCHED=0    # the new MeshCentral config was written over the previous one
FIRST_INSTALL=0  # neither a unit nor a program existed before this install
KEEP_TMP=0
# True when the unit is active and keeps the same process with no restart for five seconds.
stays_up() {
  local pid0 nr0
  [[ $(svc_state) == active ]] || return 1
  pid0=$(systemctl show -p MainPID --value "$N.service")
  nr0=$(systemctl show -p NRestarts --value "$N.service")
  sleep 5
  [[ $(svc_state) == active && $(systemctl show -p MainPID --value "$N.service") == "$pid0" \
    && $(systemctl show -p NRestarts --value "$N.service") == "$nr0" ]]
}
# Puts the previous state back. Runs without errexit, so a failed step (or a closed terminal) never skips the reporting;
# a step that later steps depend on stops it. Returns 1 when something could not be put back; the saved copies are then kept.
rollback() {
  set +e
  local bad=0 st
  printf 'install.sh: the install did not finish; putting the previous state back ...\n' >&2
  st=$(svc_state)
  if [[ -n $st && $st != inactive && $st != failed ]]; then
    systemctl stop "$N.service" >/dev/null 2>&1 || { printf 'install.sh: could not stop %s.service.\n' "$N" >&2; return 1; }
  fi
  if [[ -n $OLD_PROG && -d $OLD_PROG && ! -L $OLD_PROG ]]; then
    if [[ -e /opt/$N || -L /opt/$N ]]; then
      rm -rf --one-file-system -- "/opt/$N" || { printf 'install.sh: could not remove the new /opt/%s.\n' "$N" >&2; return 1; }
    fi
    mv -T -- "$OLD_PROG" "/opt/$N" || { printf 'install.sh: could not move %s back to /opt/%s.\n' "$OLD_PROG" "$N" >&2; return 1; }
    OLD_PROG=
  elif ((FIRST_INSTALL)) && [[ -d /opt/$N && ! -L /opt/$N ]]; then
    rm -rf --one-file-system -- "/opt/$N" || bad=1
  fi
  if ((CFG_TOUCHED && PREV_CFG)); then write_service_file "$TMPD/config.prev" config.json || bad=1; fi
  if ((PREV_UNIT)); then
    install -m 0644 -o root -g root "$TMPD/unit.prev" "/etc/systemd/system/$N.service" || bad=1
  elif ((UNIT_WRITTEN)); then
    # a first install that failed leaves no service behind that starts over and over
    systemctl disable "$N.service" >/dev/null 2>&1
    rm -f -- "/etc/systemd/system/$N.service" || bad=1
  fi
  systemctl daemon-reload >/dev/null 2>&1 || bad=1
  if ((WAS_RUNNING)); then
    if ((bad)); then   # not started on a half-restored state
      printf 'install.sh: the previous %s.service is not started again, because not everything above could be put back.\n' "$N" >&2
      return 1
    fi
    if systemctl start "$N.service" >/dev/null 2>&1 && stays_up; then
      printf 'install.sh: the previous %s.service runs again.\n' "$N" >&2
    else
      printf 'install.sh: the previous %s.service did not stay up after it was put back.\n' "$N" >&2
      bad=1
    fi
  fi
  return $bad
}
on_exit() {
  local rc=$?
  trap '' HUP INT TERM QUIT PIPE   # nothing may cut the rollback short
  set +e
  if ((rc != 0 && ROLLBACK && !COMMITTED)); then
    if ! rollback; then
      KEEP_TMP=1
      printf 'install.sh: the previous state could not be put back completely. The saved copies are kept in %s%s;\n' "$TMPD" "${OLD_PROG:+ and $OLD_PROG}" >&2
      printf 'install.sh: recovery is incomplete. Keep those copies (root-only; they hold the request with the password hashes)\n' >&2
      printf 'install.sh: and put the previous program, unit and config back from them before running the install again.\n' >&2
    fi
  fi
  if [[ -n $NEW_DIR && -d $NEW_DIR && ! -L $NEW_DIR ]]; then rm -rf --one-file-system -- "$NEW_DIR"; fi
  if ((!KEEP_TMP)) && [[ -n $TMPD && -d $TMPD && ! -L $TMPD ]]; then rm -rf --one-file-system -- "$TMPD"; fi
  return 0
}
trap on_exit EXIT

# ---------------------------------------------------------------------------------------------------------------
# Reading and writing in the hub's folders: always with the hub's own account when running as root
# ---------------------------------------------------------------------------------------------------------------
HUB_UID=
HUB_GID=
as_hub() {   # command args...
  timeout 60 setpriv --reuid="$HUB_UID" --regid="$HUB_GID" --clear-groups --no-new-privs -- env -i PATH=/usr/bin:/bin "$@"
}
read_hub_file() {   # path -> stdout
  if ((EUID == 0)); then as_hub cat -- "$1"; else timeout 60 cat -- "$1"; fi
}
# Writes SRC (a root-private file) as NAME into the hub's service folder with the hub's own account.
hand_back() {   # src name
  as_hub bash --noprofile --norc -c 'set -eu; umask 022; cd -P -- "$1"; rm -f -- "$2"; set -C; cat >"$2"' _ "$SERVICE_DIR" "$2" <"$1" \
    || fail "Could not write $2 into $SERVICE_DIR with the hub's account."
}
# Inside the service's own folder (/var/lib/NAME) root never reads or writes by path: the service's account does, so a
# link or a pipe the service planted there can only ever lead to what that account could reach anyway. It does so inside
# the service's own sandbox (the same file-system allow list, no network), so not even a short helper of that account runs
# where a running service could reach the rest of the computer through /proc/PID/root. Standard input and output pass through.
as_service() {   # command args...
  local -a props=()
  local p
  for p in "${SANDBOX[@]}"; do props+=(-p "$p"); done
  timeout 120 systemd-run --quiet --wait --pipe --collect --service-type=exec \
    --unit="$N-files-$$-$RANDOM" --uid="$N" --gid="$N" \
    -p WorkingDirectory=/ -p Environment=LC_ALL=C -p RuntimeMaxSec=100 -p PrivateNetwork=yes "${props[@]}" -- "$@"
}
# Reads at most MAX bytes, without following a final link and without waiting on a pipe.
read_service_file() {   # path max -> stdout
  as_service "$DD_BIN" if="$1" bs="$2" count=1 iflag=nofollow,nonblock,fullblock status=none </dev/null
}
# Writes SRC (a root-private file) as NAME into /var/lib/NAME/meshcentral-data.
write_service_file() {   # src name
  as_service "$BASH_BIN" --noprofile --norc -c 'set -eu; umask 077; cd -P -- "$1"; rm -f -- "$2"; set -C; cat >"$2"' _ "/var/lib/$N/meshcentral-data" "$2" <"$1"
}
# Saves the current MeshCentral config into $TMPD/config.prev. Returns 0 when saved; 3 when there is none (its folder can be
# searched and holds no such name, or there is no such folder); 4 when what is there is not a config file at all (a link,
# not a plain file, or empty); anything else when it could not be looked at or read in full, including a folder the
# service's account cannot search and a file over 64 KB: then nothing may be replaced.
save_previous_config() {
  local rc=0
  # (No ${...} in a script given to systemd-run: systemd expands those forms itself, before bash sees them.)
  as_service "$BASH_BIN" --noprofile --norc -c '
    f=$1 d=$4 top=$5
    [ -d "$top" ] && [ -x "$top" ] || exit 5
    if [ -e "$d" ] || [ -L "$d" ]; then
      { [ -d "$d" ] && [ ! -L "$d" ] && [ -x "$d" ] && [ -r "$d" ]; } || exit 5
    else
      exit 3
    fi
    if [ ! -e "$f" ] && [ ! -L "$f" ]; then exit 3; fi
    if [ -L "$f" ] || [ ! -f "$f" ]; then exit 4; fi
    exec "$3" if="$f" bs="$2" count=1 iflag=nofollow,nonblock,fullblock status=none' \
    _ "/var/lib/$N/meshcentral-data/config.json" $((MAX_CONFIG_BYTES + 1)) "$DD_BIN" "/var/lib/$N/meshcentral-data" "/var/lib/$N" </dev/null >"$TMPD/config.prev" || rc=$?
  ((rc == 0)) || return $rc
  [[ -s $TMPD/config.prev ]] || return 4
  (($(stat -c '%s' -- "$TMPD/config.prev") <= MAX_CONFIG_BYTES)) || return 6
  return 0
}

# ---------------------------------------------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------------------------------------------
PATH_RE='^/[A-Za-z0-9._/-]+$'
NAME_RE='^mymaestro-remote(-[a-z0-9]{1,16})?$'
USER_RE='^[a-z][a-z0-9_-]{0,31}$'
# MeshCentral's hash: base64 of 128 random bytes (172 characters, one "=") "," base64 of a 128-byte key (172 characters, one "=").
HASH_RE='^[A-Za-z0-9+/]{171}=,[A-Za-z0-9+/]{171}=$'
KEYS="MMR_VERSION MMR_NAME MMR_HUB_HOME MMR_APP_DIR MMR_RUNTIME_DIR MMR_NODE MMR_MESH_VERSION MMR_CONTROL_PORT MMR_AGENT_ALLOWED MMR_ADMIN_USER MMR_ADMIN_HASH MMR_AGENT_USER MMR_AGENT_HASH"

check_path_value() {   # label value
  local label=$1 v=$2
  [[ $v =~ $PATH_RE ]] || die "$label must be an absolute path made of letters, digits and . _ / - only."
  case "/$v/" in
    */./* | */../*) die "$label must not contain a '.' or '..' part." ;;
  esac
}

# Turns the comma separated list into a space separated one in ALLOW; every entry is an IPv4 address (optional /8-32).
parse_allowed() {
  local raw=$1 part entry i o n=0
  local -a parts
  [[ $raw =~ ^[0-9./,\ ]+$ ]] || die "MMR_AGENT_ALLOWED may only hold IPv4 addresses or ranges separated by commas."
  [[ $raw != *, ]] || die "MMR_AGENT_ALLOWED ends with a comma."
  IFS=',' read -r -a parts <<<"$raw"
  ALLOW=
  for part in "${parts[@]}"; do
    entry=${part//[[:space:]]/}
    [[ $entry =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})(/(0|[1-9][0-9]?))?$ ]] \
      || die "MMR_AGENT_ALLOWED has an entry that is not an IPv4 address or range: '$entry'."
    for i in 1 2 3 4; do
      o=${BASH_REMATCH[i]}
      ((10#$o <= 255)) || die "MMR_AGENT_ALLOWED has an address with a part above 255: '$entry'."
    done
    if [[ -n ${BASH_REMATCH[6]:-} ]]; then
      ((10#${BASH_REMATCH[6]} <= 32)) || die "MMR_AGENT_ALLOWED has a range longer than /32: '$entry'."
      # Same rule as the connector: nothing wider than a /8, and never 0.0.0.0.
      ((10#${BASH_REMATCH[6]} >= 8)) || die "MMR_AGENT_ALLOWED has a range wider than /8: '$entry'. Use a narrower range."
    fi
    [[ $entry != 0.0.0.0 && $entry != 0.0.0.0/* ]] || die "MMR_AGENT_ALLOWED must not hold 0.0.0.0."
    ALLOW=${ALLOW:+$ALLOW }$entry
    n=$((n + 1))
  done
  ((n >= 1 && n <= 16)) || die "MMR_AGENT_ALLOWED must hold between 1 and 16 entries (it has $n)."
}

# A folder of the hub's that the service must not see (InaccessiblePaths): it may not be, or hold, anything the service needs.
check_hidden_root() {   # label realpath
  local label=$1 r=$2 p
  [[ $r =~ $PATH_RE ]] || die "$label resolves to a path with unusual characters."
  for p in "/opt/$N" "/var/lib/$N" /var/lib /usr /etc /lib /lib64 /bin /sbin /dev /proc /sys /run /tmp /var/tmp; do
    if [[ $p == "$r" || $p == "$r"/* ]]; then die "$label may not be $r: the service needs what is inside it."; fi
  done
}

validate_request() {
  local req=$1
  [[ -n $req ]] || die "No request file was given."
  [[ -L $req ]] && die "The request file is a symbolic link."
  [[ -f $req ]] || die "The request file '$req' is not a regular file."
  local st size mode uid gid
  st=$(stat -c '%s %a %u %g' -- "$req") || die "Cannot read the request file."
  read -r size mode uid gid <<<"$st"
  ((size <= MAX_REQUEST_BYTES)) || die "The request file is larger than $MAX_REQUEST_BYTES bytes."
  [[ $mode == 600 ]] || die "The request file must have mode 600 (it has $mode)."
  ((uid != 0)) || die "The request file must be owned by the hub's account, not by root."
  HUB_UID=$uid
  HUB_GID=$gid
  REQ_REAL=$(realpath -e -- "$req") || die "Cannot resolve the request file."
  # Everything below reads this private copy, taken with the hub's own account.
  local copy=$TMPD/request.env
  read_hub_file "$req" | head -c $((MAX_REQUEST_BYTES + 1)) >"$copy" || die "Cannot read the request file."
  size=$(stat -c '%s' -- "$copy")
  ((size <= MAX_REQUEST_BYTES)) || die "The request file is larger than $MAX_REQUEST_BYTES bytes."
  [[ $(tr -d '\0' <"$copy" | wc -c) -eq $size ]] || die "The request file holds a zero byte."

  local -A V=()
  local line key val k
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    [[ $line == *=* ]] || die "A line in the request file is not KEY=VALUE."
    key=${line%%=*}
    val=${line#*=}
    case $key in
      MMR_VERSION | MMR_NAME | MMR_HUB_HOME | MMR_APP_DIR | MMR_RUNTIME_DIR | MMR_NODE | MMR_MESH_VERSION | MMR_CONTROL_PORT | MMR_AGENT_ALLOWED | MMR_ADMIN_USER | MMR_ADMIN_HASH | MMR_AGENT_USER | MMR_AGENT_HASH) ;;
      *) die "The request file has an unknown key." ;;
    esac
    [[ -z ${V[$key]+x} ]] || die "The request file has the key $key twice."
    [[ -n $val ]] || die "The request file has an empty value for $key."
    V[$key]=$val
  done <"$copy"
  for k in $KEYS; do
    [[ -n ${V[$k]+x} ]] || die "The request file is missing the key $k."
  done

  [[ ${V[MMR_VERSION]} == 1 ]] || die "MMR_VERSION must be 1 (this script knows only that version)."
  [[ ${V[MMR_NAME]} =~ $NAME_RE ]] || die "MMR_NAME must look like mymaestro-remote or mymaestro-remote-abc (letters a-z and digits, up to 16 after the dash)."
  N=${V[MMR_NAME]}
  check_path_value MMR_HUB_HOME "${V[MMR_HUB_HOME]}"
  check_path_value MMR_APP_DIR "${V[MMR_APP_DIR]}"
  check_path_value MMR_RUNTIME_DIR "${V[MMR_RUNTIME_DIR]}"
  check_path_value MMR_NODE "${V[MMR_NODE]}"
  HUB_HOME=${V[MMR_HUB_HOME]}
  RUNTIME_DIR=${V[MMR_RUNTIME_DIR]}
  NODE_BIN=${V[MMR_NODE]}
  [[ ${V[MMR_MESH_VERSION]} == "$MESH_VERSION" ]] || die "MMR_MESH_VERSION must be $MESH_VERSION (this script is built for exactly that MeshCentral version)."
  [[ ${V[MMR_CONTROL_PORT]} =~ ^[0-9]{4,5}$ ]] || die "MMR_CONTROL_PORT must be a number from 1024 to 65535."
  PORT=$((10#${V[MMR_CONTROL_PORT]}))
  ((PORT >= 1024 && PORT <= 65535)) || die "MMR_CONTROL_PORT must be a number from 1024 to 65535."
  parse_allowed "${V[MMR_AGENT_ALLOWED]}"
  [[ ${V[MMR_ADMIN_USER]} =~ $USER_RE ]] || die "MMR_ADMIN_USER is not a valid account name."
  [[ ${V[MMR_AGENT_USER]} =~ $USER_RE ]] || die "MMR_AGENT_USER is not a valid account name."
  [[ ${V[MMR_ADMIN_USER]} != "${V[MMR_AGENT_USER]}" ]] || die "MMR_ADMIN_USER and MMR_AGENT_USER must be different."
  [[ ${V[MMR_ADMIN_HASH]} =~ $HASH_RE ]] || die "MMR_ADMIN_HASH is not in MeshCentral's salt,hash form."
  [[ ${V[MMR_AGENT_HASH]} =~ $HASH_RE ]] || die "MMR_AGENT_HASH is not in MeshCentral's salt,hash form."
  ADMIN_USER=${V[MMR_ADMIN_USER]}
  ADMIN_HASH=${V[MMR_ADMIN_HASH]}
  AGENT_USER=${V[MMR_AGENT_USER]}
  AGENT_HASH=${V[MMR_AGENT_HASH]}

  # The request must be the one in the hub's own service folder.
  local sdir=$HUB_HOME/service
  [[ -L $sdir ]] && die "$sdir is a symbolic link."
  [[ -d $sdir ]] || die "$sdir is not a directory."
  [[ $(stat -c '%u' -- "$sdir") == "$HUB_UID" ]] || die "$sdir is not owned by the same account as the request file."
  mode=$(stat -c '%a' -- "$sdir")
  ((8#$mode & 8#022)) && die "$sdir can be written by other accounts."
  [[ -e $sdir/request.env ]] || die "$sdir/request.env does not exist."
  [[ $(realpath -e -- "$sdir/request.env") == "$REQ_REAL" ]] || die "The request file must be $sdir/request.env."

  local cfg=$sdir/config.json
  [[ -L $cfg ]] && die "$cfg is a symbolic link."
  [[ -f $cfg ]] || die "$cfg is not a regular file."
  st=$(stat -c '%s %u' -- "$cfg")
  read -r size uid <<<"$st"
  [[ $uid == "$HUB_UID" ]] || die "$cfg is not owned by the same account as the request file."
  ((size <= MAX_CONFIG_BYTES)) || die "$cfg is larger than $MAX_CONFIG_BYTES bytes."

  # The hub's own folders that the service must not see at all (beyond ProtectHome=yes, for installs outside /home).
  HUB_REAL=$(realpath -e -- "$HUB_HOME") || die "MMR_HUB_HOME '$HUB_HOME' does not exist."
  APP_REAL=$(realpath -e -- "${V[MMR_APP_DIR]}") || die "MMR_APP_DIR '${V[MMR_APP_DIR]}' does not exist."
  [[ -d $APP_REAL ]] || die "MMR_APP_DIR is not a directory."
  [[ $(stat -c '%u' -- "$APP_REAL") == "$HUB_UID" ]] || die "MMR_APP_DIR must belong to the same account as the request file."
  check_hidden_root MMR_HUB_HOME "$HUB_REAL"
  check_hidden_root MMR_APP_DIR "$APP_REAL"

  # Root copies the runtime and Node into /opt. Both must belong to the hub's account (Node may also be a system
  # program anyone may run); the copies themselves are read with the hub's account (see full_install).
  RUNTIME_REAL=$(realpath -e -- "$RUNTIME_DIR") || die "MMR_RUNTIME_DIR '$RUNTIME_DIR' does not exist."
  [[ -d $RUNTIME_REAL ]] || die "MMR_RUNTIME_DIR is not a directory."
  [[ $(stat -c '%u' -- "$RUNTIME_REAL") == "$HUB_UID" ]] || die "MMR_RUNTIME_DIR must belong to the same account as the request file."
  local mc=$RUNTIME_REAL/node_modules/meshcentral
  [[ -f $mc/meshcentral.js ]] || die "$mc/meshcentral.js does not exist."
  [[ -f $mc/package.json ]] || die "$mc/package.json does not exist."
  read_hub_file "$mc/package.json" | head -c 1048576 >"$TMPD/package.json" || die "Cannot read $mc/package.json."
  grep -Eq "\"version\"[[:space:]]*:[[:space:]]*\"${MESH_VERSION//./\\.}\"" "$TMPD/package.json" \
    || die "The MeshCentral in $RUNTIME_DIR is not version $MESH_VERSION."
  NODE_REAL=$(realpath -e -- "$NODE_BIN") || die "MMR_NODE '$NODE_BIN' does not exist."
  [[ -f $NODE_REAL && -x $NODE_REAL ]] || die "MMR_NODE must be a regular executable file."
  local nuid nmode
  read -r nuid nmode <<<"$(stat -c '%u %a' -- "$NODE_REAL")"
  if [[ $nuid != "$HUB_UID" ]]; then
    ((nuid == 0 && (8#$nmode & 8#005) == 8#005)) \
      || die "MMR_NODE must belong to the same account as the request file, or be a system program anyone may run."
  fi
  SERVICE_DIR=$sdir
  build_sandbox
}

# ---------------------------------------------------------------------------------------------------------------
# The sandbox: one list, used by the service unit and by every command that runs MeshCentral during the install
# ---------------------------------------------------------------------------------------------------------------
# The file system is an allow list: an empty read-only root with only the system's programs and libraries, a few files from
# /etc that Node reads, the program in /opt/NAME (read-only) and the data in /var/lib/NAME. Nothing else on this computer
# (home folders, data disks, backups, My Maestro's folders wherever they are) exists for the service. It can accept connections
# but never open one or send anything that is not a reply on an accepted connection (connect, sendto, sendmsg, sendmmsg and
# io_uring are refused; stream writes still work), and the addresses it may talk with are 127.0.0.1 (where the hub connects
# from; not the rest of 127/8, where the local DNS resolvers listen) and the allowed agent addresses.
build_sandbox() {
  SANDBOX=(
    "UMask=0077"
    "StateDirectory=$N"
    "StateDirectoryMode=0700"
    "TemporaryFileSystem=/:ro"
    "BindReadOnlyPaths=/usr -/lib -/lib64 -/bin -/sbin -/etc/ld.so.cache -/etc/localtime -/etc/passwd -/etc/group -/etc/nsswitch.conf -/opt/$N"
    "MountAPIVFS=yes"
    "NoNewPrivileges=yes"
    "ProtectHome=yes"
    "InaccessiblePaths=-$APP_REAL -$HUB_REAL -/usr/local"
    "PrivateTmp=yes"
    "PrivateDevices=yes"
    "ProtectKernelTunables=yes"
    "ProtectKernelModules=yes"
    "ProtectKernelLogs=yes"
    "ProtectControlGroups=yes"
    "ProtectClock=yes"
    "ProtectHostname=yes"
    "ProtectProc=invisible"
    "RestrictNamespaces=yes"
    "RestrictRealtime=yes"
    "RestrictSUIDSGID=yes"
    "LockPersonality=yes"
    "RemoveIPC=yes"
    "CapabilityBoundingSet="
    "AmbientCapabilities="
    "SystemCallArchitectures=native"
    "SystemCallFilter=@system-service"
    "SystemCallFilter=~@privileged"
    "SystemCallFilter=~connect sendto sendmsg sendmmsg io_uring_setup io_uring_enter io_uring_register"
    "SystemCallErrorNumber=EPERM"
    "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK"
    "IPAddressDeny=any"
    "IPAddressAllow=127.0.0.1/32 ::1/128 $ALLOW"
    "MemoryMax=2G"
    "TasksMax=512"
  )
}

unit_text() {
  cat <<EOF
# Written by My Maestro (Remote computers). Remove with uninstall.sh.
# My Maestro hub home: $HUB_HOME
# My Maestro hub account: $HUB_UID:$HUB_GID
[Unit]
Description=My Maestro remote computers (MeshCentral)
After=network-online.target tailscaled.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$N
Group=$N
WorkingDirectory=/opt/$N/runtime
Environment=NODE_ENV=production
Environment=HOME=/var/lib/$N
ExecStart=/opt/$N/node /opt/$N/runtime/node_modules/meshcentral/meshcentral.js --datapath /var/lib/$N/meshcentral-data --npmpath "/opt/$N/node /opt/$N/no-npm.js"
Restart=always
RestartSec=10
TimeoutStopSec=20
EOF
  printf '%s\n' "${SANDBOX[@]}"
  cat <<'EOF'

[Install]
WantedBy=multi-user.target
EOF
}

# The same text as lib/no-npm.js of the connector, written here so nothing is copied from the hub's folders.
no_npm_text() {
  cat <<'EOF'
'use strict';
// MeshCentral runs "<--npmpath value> install ..." through a shell whenever a module it wants is missing (meshcentral.js:4320-4322),
// and the same value for its update checks (meshcentral.js:632-794). This stands in for npm: it installs nothing, says so, and fails.
process.stderr.write('runtime installs are disabled; reinstall the connector\n');
process.stdout.write('runtime installs are disabled; reinstall the connector\n');
process.exit(1);
EOF
}

# ---------------------------------------------------------------------------------------------------------------
# Full install helpers
# ---------------------------------------------------------------------------------------------------------------
# One command as the service user, inside a transient unit with the service's sandbox and no network at all, without the
# caller's terminal. Output (both streams) on stdout; returns the command's exit status. Leftover processes die with the unit.
run_in_sandbox() {   # workdir extra-property-or-empty command args...
  local wd=$1 extra=$2
  shift 2
  local -a props=()
  local p
  for p in "${SANDBOX[@]}"; do props+=(-p "$p"); done
  [[ -z $extra ]] || props+=(-p "$extra")
  timeout 180 systemd-run --quiet --wait --pipe --collect --service-type=exec \
    --unit="$N-setup-$$-$RANDOM" --uid="$N" --gid="$N" \
    -p WorkingDirectory="$wd" -p Environment=NODE_ENV=production -p Environment=HOME="/var/lib/$N" -p Environment=LC_ALL=C \
    -p RuntimeMaxSec=150 -p PrivateNetwork=yes "${props[@]}" \
    -- "$@" </dev/null 2>&1
}
run_sandboxed() { run_in_sandbox "/opt/$N/runtime" "" "$@"; }

run_mesh() {
  run_sandboxed "/opt/$N/node" "/opt/$N/runtime/node_modules/meshcentral/meshcentral.js" \
    --datapath "/var/lib/$N/meshcentral-data" --npmpath "/opt/$N/node /opt/$N/no-npm.js" "$@"
}

MESH_OUT=
MESH_OK=0
# Runs one command and sets MESH_OUT / MESH_OK: it worked when it exited 0 and MeshCentral printed "Done.".
mesh_step() {
  local rc=0
  MESH_OUT=$(run_mesh "$@") || rc=$?
  MESH_OK=0
  if ((rc == 0)) && grep -Eq '(^|[^A-Za-z0-9_])Done\.' <<<"$MESH_OUT"; then MESH_OK=1; fi
  return 0
}

mesh_fail() {   # what hash
  local what=$1 hash=$2 salt shown
  salt=${hash%%,*}
  shown=${MESH_OUT//"$hash"/[secret]}
  shown=${shown//"$salt"/[secret]}
  shown=$(printf '%s\n' "$shown" | sed -E 's/(--(hash)?pass(word)?(=|[[:space:]]+))[^[:space:]]+/\1[secret]/g' | tr -cd '\11\12\40-\176' | tail -n 4 | tr '\n' '|')
  fail "Could not $what: ${shown:-no output}"
}

make_account() {   # user hash label
  local user=$1 hash=$2 label=$3
  mesh_step --createaccount "$user" --hashpass "$hash"
  if ((!MESH_OK)) && grep -qi 'already exists' <<<"$MESH_OUT"; then
    mesh_step --resetaccount "$user" --hashpass "$hash"
    ((MESH_OK)) || mesh_fail "reset the $label account's password" "$hash"
    return 0
  fi
  ((MESH_OK)) || mesh_fail "create the $label account" "$hash"
}

svc_state() { systemctl show -p ActiveState --value "$N.service" 2>/dev/null || true; }
# Every interrupting signal ends the install through the EXIT trap (which rolls back).
arm_signals() {
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 131' QUIT
  trap 'exit 143' TERM
}

full_install() {
  local replace=$1
  ((EUID == 0)) || die "The full install must run as root. Run: sudo $0 $REQUEST"
  [[ -d /run/systemd/system ]] || die "My Maestro's computer does not run systemd, which the service mode needs."
  command -v setpriv >/dev/null 2>&1 || die "setpriv (from util-linux) is needed and was not found."
  command -v systemd-run >/dev/null 2>&1 || die "systemd-run is needed and was not found."
  command -v flock >/dev/null 2>&1 || die "flock (from util-linux) is needed and was not found."
  local sv
  sv=$(systemctl --version 2>/dev/null | head -n 1 | awk '{print $2}')
  [[ $sv =~ ^[0-9]+$ ]] && ((sv >= 247)) || die "The service needs systemd 247 or newer (My Maestro's computer has ${sv:-an unknown version})."
  # One install or removal of this service at a time (a terminal and Ask Maestro at once).
  exec 9>"/run/lock/mymaestro-$N.lock" || die "Cannot take the lock /run/lock/mymaestro-$N.lock."
  flock -n 9 || die "Another install or removal of $N is running. Wait for it to finish."
  # The temporary folder carries the service's name from the start, so uninstall.sh can remove it even after a hard kill.
  printf '%s\n' "$N" >"$TMPD/service-name" || die "Cannot write in $TMPD."

  local unit=/etc/systemd/system/$N.service prog=/opt/$N state=/var/lib/$N
  [[ -L $prog ]] && die "$prog is a symbolic link."
  [[ -L $state ]] && die "$state is a symbolic link."

  # An existing service for a different hub folder is not taken over silently.
  if [[ -e $unit || -L $unit ]]; then
    local old_home
    old_home=$(sed -n 's/^# My Maestro hub home: //p' -- "$unit" 2>/dev/null | head -n 1 || true)
    if [[ $old_home != "$HUB_HOME" && $replace != 1 ]]; then
      die "The service $N already exists for another hub folder (${old_home:-unknown}). Use --replace to take it over."
    fi
  fi

  # Something else on the control port (looked at only when no copy of this service runs or is between restarts).
  local st0
  st0=$(svc_state)
  if [[ -z $st0 || $st0 == inactive || $st0 == failed ]]; then
    local lst
    lst=$(ss -Hltn 2>/dev/null | awk '{print $4}' || true)
    if grep -Eq "^(127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\*|\\[::\\]|\\[::ffff:127\\.0\\.0\\.1\\]):$PORT\$" <<<"$lst"; then
      die "Something already listens on 127.0.0.1:$PORT. Choose another control port."
    fi
  fi

  # The service user.
  local pw
  if pw=$(getent passwd "$N"); then
    local puid phome
    puid=$(printf '%s' "$pw" | cut -d: -f3)
    phome=$(printf '%s' "$pw" | cut -d: -f6)
    if [[ ! $puid =~ ^[0-9]+$ ]] || ((puid >= 1000)) || [[ $phome != "$state" ]]; then
      die "An account named $N already exists and is not a service account made for this (uid $puid, home $phome). It is not taken over."
    fi
  else
    getent group "$N" >/dev/null && die "A group named $N exists without a user of that name."
    useradd --system --user-group --home-dir "$state" --no-create-home --shell /usr/sbin/nologin \
      --comment 'My Maestro remote computers' "$N"
  fi

  [[ -e $unit || -L $unit || -e $prog ]] || FIRST_INSTALL=1

  # Save what a failed install must put back (refusing to go on when it cannot be saved), then stop the service if it
  # runs or is between restarts. From here on a failure puts the previous state back.
  if [[ -e $unit || -L $unit ]]; then
    [[ -f $unit && ! -L $unit ]] || die "$unit is not a regular file."
    cp -P --no-preserve=all -- "$unit" "$TMPD/unit.prev" || die "Could not save the current $unit."
    PREV_UNIT=1
  fi
  # A closed output pipe now makes a write fail (and the install roll back) instead of killing the script on the spot, and
  # every interrupting signal ends it through the EXIT trap, which rolls back.
  trap '' PIPE
  arm_signals
  ROLLBACK=1
  case $(svc_state) in
    "" | inactive | failed) ;;
    *) WAS_RUNNING=1; info "Stopping $N.service ..."; systemctl stop "$N.service" ;;
  esac
  # The current MeshCentral config, kept for a failed install to put back. A real config that cannot be saved stops the
  # install before anything is replaced; one that is not a usable config at all (MeshCentral could not have run with it)
  # is replaced without a copy.
  if [[ -d $state && ! -L $state ]]; then
    local src=0
    save_previous_config || src=$?
    case $src in
      0) PREV_CFG=1 ;;
      3) ;;
      4) info "What is in place of the MeshCentral config is not a config file (a link, not a plain file, or empty); it is replaced without a copy." ;;
      6) fail "The current MeshCentral config is larger than $MAX_CONFIG_BYTES bytes, so it cannot be saved; nothing was replaced. Move it aside by hand to go on." ;;
      *) fail "Could not save the current MeshCentral config (as $N, in its sandbox), so nothing was replaced. If an owner was changed, run: sudo chown -R $N:$N $state (a link in place of $state/meshcentral-data must be removed by hand)" ;;
    esac
  fi

  # ---- the program: a root-owned copy, private until it has been checked ----
  [[ ! -e /opt/.$N.new.$$ && ! -L /opt/.$N.new.$$ ]] || die "/opt/.$N.new.$$ already exists (left by an earlier install); move it away first."
  NEW_DIR=/opt/.$N.new.$$
  install -d -m 0700 -o root -g root "$NEW_DIR"
  read_hub_file "$NODE_REAL" >"$NEW_DIR/node" || fail "Could not read $NODE_BIN with the hub's account."
  [[ -s $NEW_DIR/node ]] || fail "$NODE_BIN is empty."
  mkdir -m 0700 "$NEW_DIR/runtime"
  # Enter the runtime folder first and check the folder entered, then copy what is inside it: no path is looked up again.
  ( cd -P -- "$RUNTIME_REAL" && [[ $(stat -c '%u' -- .) == "$HUB_UID" ]] && exec cp -R -P --one-file-system -- . "$NEW_DIR/runtime/" ) \
    || fail "Could not copy the runtime from $RUNTIME_DIR."
  no_npm_text >"$NEW_DIR/no-npm.js"
  chown -R -h root:root "$NEW_DIR"
  local mc=$NEW_DIR/runtime/node_modules/meshcentral
  [[ -f $mc/meshcentral.js && ! -L $mc/meshcentral.js ]] || fail "The copy has no meshcentral.js."
  [[ -f $mc/package.json && ! -L $mc/package.json ]] || fail "The copy has no MeshCentral package.json."
  grep -Eq "\"version\"[[:space:]]*:[[:space:]]*\"${MESH_VERSION//./\\.}\"" "$mc/package.json" || fail "The copy is not MeshCentral $MESH_VERSION."
  [[ -f $mc/agents/agent-defaults.json && -f $mc/agents/MeshService64.exe ]] \
    || fail "The runtime has no MeshCentral agent files. Open the Remote computers setup again so My Maestro fetches them, then run this again."
  # A link inside the copy must stay inside the copy.
  local link target
  while IFS= read -r -d '' link; do
    target=$(realpath -m -- "$link")
    [[ $target == "$NEW_DIR/runtime/"* ]] || fail "The runtime holds a link that points out of itself: ${link#"$NEW_DIR"/}."
  done < <(find "$NEW_DIR/runtime" -type l -print0)
  # Only now is it opened up.
  chmod -R u+rwX,go+rX,go-w,a-s "$NEW_DIR"
  chmod 0755 "$NEW_DIR/node"
  # Node must run as the service user inside the sandbox before anything of the previous install is replaced.
  local nv
  nv=$(run_in_sandbox / "BindReadOnlyPaths=$NEW_DIR" "$NEW_DIR/node" --version) \
    || fail "The copied Node does not run as $N inside the sandbox: $(printf '%s' "$nv" | tr -cd '\40-\176' | tail -c 300)"
  [[ $nv =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] || fail "The copied Node did not report a version."
  # The sandbox must really refuse opening connections on this computer (an old libseccomp could skip names quietly).
  # Both a connection and a datagram (Node's own UDP send uses sendmsg) must be refused.
  local probe
  probe=$(run_in_sandbox / "" "$BASH_BIN" -c 'exec 3<>/dev/tcp/127.0.0.1/9' || true)
  [[ $probe == *"not permitted"* ]] || fail "The sandbox on My Maestro's computer does not refuse network connections, so the service is not installed."
  probe=$(run_in_sandbox / "BindReadOnlyPaths=$NEW_DIR" "$NEW_DIR/node" -e \
    "const s=require('dgram').createSocket('udp4');s.send('x',9,'127.0.0.1',(e)=>{process.stdout.write(e?String(e.code):'SENT');process.exit(0)})" || true)
  [[ $probe == EPERM ]] || fail "The sandbox on My Maestro's computer does not refuse sending datagrams (got '${probe:0:40}'), so the service is not installed."

  # The hub's MeshCentral config, read and checked before anything is replaced.
  read_hub_file "$SERVICE_DIR/config.json" | head -c $((MAX_CONFIG_BYTES + 1)) >"$TMPD/config.json" \
    || fail "Could not read $SERVICE_DIR/config.json with the hub's account."
  (($(stat -c '%s' -- "$TMPD/config.json") <= MAX_CONFIG_BYTES)) || fail "config.json is larger than $MAX_CONFIG_BYTES bytes."
  local agent_port   # the agent port the service must open (MeshCentral reads the keys in any case)
  agent_port=$(grep -Eio '"agentport"[[:space:]]*:[[:space:]]*[0-9]{4,5}' "$TMPD/config.json" | grep -Eo '[0-9]+$' | head -n 1 || true)
  [[ $agent_port =~ ^[0-9]{4,5}$ ]] || fail "The hub's MeshCentral config names no agent port."

  # Swap it in; the previous program is kept until the new service answers. Checked first, noted only once it moved, and
  # with interrupting signals ignored for that moment, so the move and the note of where the program went cannot be split.
  if [[ -e $prog ]]; then
    local candidate=/opt/.$N.old.$$
    [[ ! -e $candidate && ! -L $candidate ]] || fail "$candidate already exists (left by an earlier failed install); move it away first."
    trap '' HUP INT TERM QUIT
    if ! mv -T -- "$prog" "$candidate"; then arm_signals; fail "Could not move the previous program aside."; fi
    OLD_PROG=$candidate
    arm_signals
  fi
  mv -T -- "$NEW_DIR" "$prog" || fail "Could not put the program in place."
  NEW_DIR=

  # ---- the state: root makes /var/lib/NAME itself (its parent is root's); what is inside, the service's account makes ----
  [[ -L $state ]] && fail "$state is a symbolic link."
  install -d -m 0700 -o "$N" -g "$N" "$state"
  chown -R -h "$N:$N" "$state"   # files kept from an earlier install belong to this account again (-h and no -L: links are never followed)
  as_service "$BASH_BIN" --noprofile --norc -c 'set -eu; umask 077; cd -P -- "$1"
    for d in meshcentral-data meshcentral-files; do
      if [ -L "$d" ]; then echo "$1/$d is a symbolic link" >&2; exit 1; fi
      mkdir -p -- "$d"; chmod 0700 -- "$d"
    done' _ "$state" </dev/null || fail "Could not prepare $state with the service's account."
  CFG_TOUCHED=1
  write_service_file "$TMPD/config.json" config.json || fail "Could not write the MeshCentral config with the service's account."

  # ---- the accounts, inside the service's own sandbox (MeshCentral stopped) ----
  info "Making the MeshCentral accounts ..."
  make_account "$ADMIN_USER" "$ADMIN_HASH" admin
  mesh_step --adminaccount "$ADMIN_USER"
  ((MESH_OK)) || mesh_fail "make $ADMIN_USER an administrator" "$ADMIN_HASH"
  make_account "$AGENT_USER" "$AGENT_HASH" agent

  # ---- the unit ----
  unit_text >"$TMPD/unit"
  UNIT_WRITTEN=1
  install -m 0644 -o root -g root "$TMPD/unit" "$unit"
  systemctl daemon-reload
  systemctl enable --now "$N.service"

  # ---- wait until it answers ----
  info "Waiting for MeshCentral to start (up to 90 seconds) ..."
  local i ready=0
  for ((i = 0; i < 90; i++)); do
    if [[ -f $state/meshcentral-data/root-cert-public.crt ]] && timeout 2 bash -c "</dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  if ((!ready)); then
    journalctl -u "$N.service" -n 40 --no-pager || true
    fail "$N.service did not become ready within 90 seconds. The log is above."
  fi
  # MeshCentral exits at once when it cannot open its agent port, after the control port answered: it must stay up, with
  # its agent port open.
  if ! stays_up; then
    journalctl -u "$N.service" -n 40 --no-pager || true
    fail "$N.service did not stay up. The log is above."
  fi
  # ...and the process listening on its agent port must be one of the service's own.
  local owners own_ok=0 p cg
  cg=$(systemctl show -p ControlGroup --value "$N.service" 2>/dev/null || true)
  owners=$(ss -Hltnp "sport = :$agent_port" 2>/dev/null | grep -Eo 'pid=[0-9]+' | cut -d= -f2 || true)
  for p in $owners; do
    # the unit's own control group, compared as text: cgroup v2 ("0::path") or the systemd hierarchy of v1/hybrid
    if [[ -n $cg ]] && awk -F: -v want="$cg" '(($1 == "0" && $2 == "") || $2 == "name=systemd") && $3 == want { found = 1 } END { exit !found }' \
      "/proc/$p/cgroup" 2>/dev/null; then own_ok=1; else own_ok=0; break; fi
  done
  if ((!own_ok)); then
    journalctl -u "$N.service" -n 40 --no-pager || true
    fail "$N.service runs but its agent port $agent_port is not open by the service. The log is above."
  fi

  # The new service answers and stays up: keep it, and drop the previous program.
  COMMITTED=1
  if [[ -n $OLD_PROG && -d $OLD_PROG && ! -L $OLD_PROG ]]; then rm -rf --one-file-system -- "$OLD_PROG"; fi
  OLD_PROG=

  # ---- hand the public certificate and the result back to the hub, with the hub's own account ----
  read_service_file "$state/meshcentral-data/root-cert-public.crt" 65537 >"$TMPD/root-cert-public.crt" \
    || fail "Could not read the root certificate with the service's account."
  (($(stat -c '%s' -- "$TMPD/root-cert-public.crt") <= 65536)) || fail "The root certificate is too large."
  grep -q -- '-----BEGIN CERTIFICATE-----' "$TMPD/root-cert-public.crt" || fail "The root certificate is not a certificate."
  printf '{"name":"%s","meshVersion":"%s","controlPort":%s,"installedAt":"%s"}\n' \
    "$N" "$MESH_VERSION" "$PORT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$TMPD/installed.json"
  hand_back "$TMPD/root-cert-public.crt" root-cert-public.crt
  hand_back "$TMPD/installed.json" installed.json
  as_hub rm -f -- "$SERVICE_DIR/request.env" || fail "Could not remove $SERVICE_DIR/request.env with the hub's account."

  cat <<EOF

Done. The service $N is running.
- It runs under its own account, $N, not under the hub's account.
- Its data in $state can be read only by that account.
- To remove it: sudo bash $(dirname -- "$(realpath -e -- "$0")")/uninstall.sh --name $N
EOF
}

# ---------------------------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------------------------
MODE=install
REPLACE=0
REQUEST=
while (($#)); do
  case $1 in
    --help | -h) usage; exit 0 ;;
    --check) MODE=check ;;
    --print-unit) MODE=unit ;;
    --replace) REPLACE=1 ;;
    -*) usage >&2; die "Unknown option '$1'." ;;
    *) [[ -z $REQUEST ]] || die "Only one request file can be given."; REQUEST=$1 ;;
  esac
  shift
done
[[ -n $REQUEST ]] || { usage >&2; die "No request file was given."; }

if [[ $MODE == install ]] && ((EUID != 0)); then
  die "The full install must run as root. Run: sudo $0 $REQUEST"
fi

validate_request "$REQUEST"
case $MODE in
  check) info ok ;;
  unit) unit_text ;;
  install) full_install "$REPLACE" ;;
esac
