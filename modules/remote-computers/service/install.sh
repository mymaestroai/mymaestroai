#!/usr/bin/env bash
# My Maestro - Remote computers: install MeshCentral as its own locked-down systemd service.
#
# Usage:
#   install.sh --check REQUEST       validate the request only and print "ok" (no root needed)
#   install.sh --print-unit REQUEST  validate, then print the systemd unit to stdout (no root needed)
#   install.sh [--replace] REQUEST   full install (must run as root, for example with sudo)
#   install.sh --help
#
# REQUEST is the file HOME_DIR/service/request.env that the hub wrote. This script runs as root, so it never runs
# any program or code that comes from the hub's folders as root: the node binary and the MeshCentral files are
# COPIED into /opt/NAME (root-owned), and everything MeshCentral does runs as the service user (runuser).
# Every value in the request is checked with a strict pattern first; anything unexpected is refused with exit 1.
set -euo pipefail
umask 077
export LC_ALL=C
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

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

# ---------------------------------------------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------------------------------------------
PATH_RE='^/[A-Za-z0-9._/-]+$'
NAME_RE='^mymaestro-remote(-[a-z0-9]{1,16})?$'
USER_RE='^[a-z][a-z0-9_-]{0,31}$'
# MeshCentral's hash: base64 of 128 random bytes (172 characters, one "=") "," base64 of a 128-byte key (172 characters, one "=").
HASH_RE='^[A-Za-z0-9+/]{171}=,[A-Za-z0-9+/]{171}=$'
KEYS="MMR_VERSION MMR_NAME MMR_HUB_HOME MMR_RUNTIME_DIR MMR_NODE MMR_MESH_VERSION MMR_CONTROL_PORT MMR_AGENT_ALLOWED MMR_ADMIN_USER MMR_ADMIN_HASH MMR_AGENT_USER MMR_AGENT_HASH"

check_path_value() {   # label value
  local label=$1 v=$2
  [[ $v =~ $PATH_RE ]] || die "$label must be an absolute path made of letters, digits and . _ / - only."
  case "/$v/" in
    */./* | */../*) die "$label must not contain a '.' or '..' part." ;;
  esac
}

# Turns the comma separated list into a space separated one in ALLOW; every entry is an IPv4 address (optional /0-32).
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
  [[ $(tr -d '\0' <"$req" | wc -c) -eq $size ]] || die "The request file holds a zero byte."

  local -A V=()
  local line key val k
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    [[ $line == *=* ]] || die "A line in the request file is not KEY=VALUE."
    key=${line%%=*}
    val=${line#*=}
    case $key in
      MMR_VERSION | MMR_NAME | MMR_HUB_HOME | MMR_RUNTIME_DIR | MMR_NODE | MMR_MESH_VERSION | MMR_CONTROL_PORT | MMR_AGENT_ALLOWED | MMR_ADMIN_USER | MMR_ADMIN_HASH | MMR_AGENT_USER | MMR_AGENT_HASH) ;;
      *) die "The request file has an unknown key." ;;
    esac
    [[ -z ${V[$key]+x} ]] || die "The request file has the key $key twice."
    [[ -n $val ]] || die "The request file has an empty value for $key."
    V[$key]=$val
  done <"$req"
  for k in $KEYS; do
    [[ -n ${V[$k]+x} ]] || die "The request file is missing the key $k."
  done

  [[ ${V[MMR_VERSION]} == 1 ]] || die "MMR_VERSION must be 1 (this script does not know version '${V[MMR_VERSION]}')."
  [[ ${V[MMR_NAME]} =~ $NAME_RE ]] || die "MMR_NAME must look like mymaestro-remote or mymaestro-remote-abc (letters a-z and digits, up to 16 after the dash)."
  N=${V[MMR_NAME]}
  check_path_value MMR_HUB_HOME "${V[MMR_HUB_HOME]}"
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

  # Root copies the runtime and Node into /opt, readable by everyone. Both must belong to the hub's account (Node may
  # also be a system program anyone may run), so a changed request cannot make root copy a private file into view.
  RUNTIME_REAL=$(realpath -e -- "$RUNTIME_DIR") || die "MMR_RUNTIME_DIR '$RUNTIME_DIR' does not exist."
  [[ -d $RUNTIME_REAL ]] || die "MMR_RUNTIME_DIR is not a directory."
  [[ $(stat -c '%u' -- "$RUNTIME_REAL") == "$HUB_UID" ]] || die "MMR_RUNTIME_DIR must belong to the same account as the request file."
  local mc=$RUNTIME_REAL/node_modules/meshcentral
  [[ -f $mc/meshcentral.js ]] || die "$mc/meshcentral.js does not exist."
  [[ -f $mc/package.json ]] || die "$mc/package.json does not exist."
  grep -Eq "\"version\"[[:space:]]*:[[:space:]]*\"${MESH_VERSION//./\\.}\"" "$mc/package.json" \
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
}

# ---------------------------------------------------------------------------------------------------------------
# The unit file
# ---------------------------------------------------------------------------------------------------------------
unit_text() {
  cat <<EOF
# Written by My Maestro (Remote computers). Remove with uninstall.sh.
# My Maestro hub home: $HUB_HOME
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
UMask=0077
StateDirectory=$N
StateDirectoryMode=0700
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RemoveIPC=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged
SystemCallErrorNumber=EPERM
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
IPAddressDeny=any
IPAddressAllow=localhost $ALLOW
MemoryMax=2G
TasksMax=512

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
TMPD=
NEW_DIR=
OLD_DIR=
cleanup() {
  [[ -n $TMPD && -d $TMPD ]] && rm -rf --one-file-system -- "$TMPD"
  [[ -n $NEW_DIR && -d $NEW_DIR && ! -L $NEW_DIR ]] && rm -rf --one-file-system -- "$NEW_DIR"
  return 0
}

# One MeshCentral command line as the service user, in the program's own copy, limited to 120 s. Output (both streams) on stdout.
run_mesh() {
  (
    cd "/opt/$N/runtime" || exit 1
    timeout 120 runuser -u "$N" -- env -i PATH=/usr/bin:/bin HOME="/var/lib/$N" NODE_ENV=production \
      "/opt/$N/node" "/opt/$N/runtime/node_modules/meshcentral/meshcentral.js" \
      --datapath "/var/lib/$N/meshcentral-data" --npmpath "/opt/$N/node /opt/$N/no-npm.js" "$@"
  ) 2>&1
}

MESH_OUT=
MESH_OK=0
# Runs one command and sets MESH_OUT / MESH_OK. Like the connector: it worked when MeshCentral printed "Done." and was not killed by the time limit.
mesh_step() {
  local rc=0
  MESH_OUT=$(run_mesh "$@") || rc=$?
  MESH_OK=0
  if printf '%s\n' "$MESH_OUT" | grep -Eq '(^|[^A-Za-z0-9_])Done\.' && ((rc != 124 && rc != 137)); then MESH_OK=1; fi
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
  if ((!MESH_OK)) && printf '%s\n' "$MESH_OUT" | grep -qi 'already exists'; then
    mesh_step --resetaccount "$user" --hashpass "$hash"
    ((MESH_OK)) || mesh_fail "reset the $label account's password" "$hash"
    return 0
  fi
  ((MESH_OK)) || mesh_fail "create the $label account" "$hash"
}

# Copies a file from a folder somebody else controls into DEST as a plain file. cp -P copies a symbolic link as a link, so a file that was swapped for a
# link or a pipe after it was checked is seen here and refused, never followed.
safe_copy() {   # src dest maxbytes
  local src=$1 dest=$2 max=$3
  cp -P --no-preserve=all -- "$src" "$dest" || fail "Could not copy $src."
  if [[ -L $dest || ! -f $dest ]] || (($(stat -c '%s' -- "$dest") > max)); then
    rm -f -- "$dest"
    fail "$src changed while it was being copied; nothing was installed from it."
  fi
}

full_install() {
  local replace=$1
  ((EUID == 0)) || die "The full install must run as root. Run: sudo $0 $REQUEST"
  [[ -d /run/systemd/system ]] || die "This computer does not run systemd, which the service mode needs."

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

  # Something else on the control port.
  if ! systemctl is-active --quiet "$N.service" 2>/dev/null; then
    if ss -Hltn 2>/dev/null | awk '{print $4}' | grep -Eq "^(127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\*|\\[::\\]|\\[::ffff:127\\.0\\.0\\.1\\]):$PORT\$"; then
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

  if systemctl is-active --quiet "$N.service" 2>/dev/null; then
    info "Stopping $N.service ..."
    systemctl stop "$N.service"
  fi

  trap cleanup EXIT
  TMPD=$(mktemp -d)

  # ---- the program: root-owned copies, nothing runs from the hub's folders ----
  NEW_DIR=/opt/.$N.new.$$
  [[ ! -e $NEW_DIR && ! -L $NEW_DIR ]] || die "$NEW_DIR already exists."
  install -d -m 0755 -o root -g root "$NEW_DIR"
  install -m 0755 -o root -g root "$NODE_REAL" "$NEW_DIR/node"
  mkdir "$NEW_DIR/runtime"
  cp -R -P -- "$RUNTIME_REAL/." "$NEW_DIR/runtime/"
  no_npm_text >"$NEW_DIR/no-npm.js"
  chown -R -h root:root "$NEW_DIR"
  chmod -R u+rwX,go+rX,go-w,a-s "$NEW_DIR"
  local mc=$NEW_DIR/runtime/node_modules/meshcentral
  [[ -f $mc/meshcentral.js && ! -L $mc/meshcentral.js ]] || fail "The copy has no meshcentral.js."
  grep -Eq "\"version\"[[:space:]]*:[[:space:]]*\"${MESH_VERSION//./\\.}\"" "$mc/package.json" || fail "The copy is not MeshCentral $MESH_VERSION."
  # A link inside the copy must stay inside the copy.
  local link target
  while IFS= read -r -d '' link; do
    target=$(realpath -m -- "$link")
    [[ $target == "$NEW_DIR/runtime/"* ]] || fail "The runtime holds a link that points out of itself: ${link#"$NEW_DIR"/}."
  done < <(find "$NEW_DIR/runtime" -type l -print0)

  # Swap it in.
  if [[ -e $prog ]]; then
    OLD_DIR=/opt/.$N.old.$$
    mv -- "$prog" "$OLD_DIR"
  fi
  if ! mv -- "$NEW_DIR" "$prog"; then
    [[ -z $OLD_DIR ]] || mv -- "$OLD_DIR" "$prog"
    fail "Could not put the program in place."
  fi
  NEW_DIR=
  [[ -z $OLD_DIR ]] || rm -rf --one-file-system -- "$OLD_DIR"

  # ---- the state ----
  local d
  for d in "$state" "$state/meshcentral-data" "$state/meshcentral-files"; do
    [[ -L $d ]] && fail "$d is a symbolic link."
    install -d -m 0700 -o "$N" -g "$N" "$d"
  done
  safe_copy "$SERVICE_DIR/config.json" "$TMPD/config.json" "$MAX_CONFIG_BYTES"
  install -m 0600 -o "$N" -g "$N" "$TMPD/config.json" "$state/meshcentral-data/config.json"

  # ---- the accounts, with MeshCentral stopped (the same steps as the connector's own first start) ----
  info "Making the MeshCentral accounts ..."
  make_account "$ADMIN_USER" "$ADMIN_HASH" admin
  mesh_step --adminaccount "$ADMIN_USER"
  ((MESH_OK)) || mesh_fail "make $ADMIN_USER an administrator" "$ADMIN_HASH"
  make_account "$AGENT_USER" "$AGENT_HASH" agent

  # ---- the unit ----
  unit_text >"$TMPD/unit"
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

  # ---- hand the public certificate and the result back to the hub ----
  safe_copy "$state/meshcentral-data/root-cert-public.crt" "$TMPD/root-cert-public.crt" 65536
  grep -q -- '-----BEGIN CERTIFICATE-----' "$TMPD/root-cert-public.crt" || fail "The root certificate is not a certificate."
  printf '{"name":"%s","meshVersion":"%s","controlPort":%s,"installedAt":"%s"}\n' \
    "$N" "$MESH_VERSION" "$PORT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$TMPD/installed.json"
  # Work from inside the hub's folder (cd -P) so a swapped folder cannot redirect the writes.
  cd -P -- "$SERVICE_DIR" || fail "Cannot enter $SERVICE_DIR."
  [[ $(stat -c '%u' -- .) == "$HUB_UID" ]] || fail "$SERVICE_DIR is no longer owned by the hub's account."
  install -m 0644 -o "$HUB_UID" -g "$HUB_GID" "$TMPD/root-cert-public.crt" ./root-cert-public.crt
  install -m 0644 -o "$HUB_UID" -g "$HUB_GID" "$TMPD/installed.json" ./installed.json
  rm -f -- ./request.env

  cat <<EOF

Done. The service $N is running.
- It runs under its own account, $N, not under the hub's account.
- Its data in $state can be read only by that account.
- To remove it: sudo $(dirname -- "$(realpath -e -- "$0")")/uninstall.sh --name $N
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
