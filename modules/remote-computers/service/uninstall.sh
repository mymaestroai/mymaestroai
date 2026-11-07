#!/usr/bin/env bash
# My Maestro - Remote computers: remove the MeshCentral systemd service made by install.sh.
#
# Usage: uninstall.sh [--name NAME] [--keep-data]
#   --name NAME   the service name (default mymaestro-remote)
#   --keep-data   keep /var/lib/NAME (the MeshCentral database and certificates)
# Must run as root (for example with sudo). Running it again is safe: it finds nothing left and changes nothing.
set -euo pipefail
umask 077
export LC_ALL=C
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

NAME_RE='^mymaestro-remote(-[a-z0-9]{1,16})?$'
PATH_RE='^/[A-Za-z0-9._/-]+$'

die() { printf 'uninstall.sh: refused: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: uninstall.sh [--name NAME] [--keep-data]
  --name NAME   the service name (default mymaestro-remote)
  --keep-data   keep /var/lib/NAME (the MeshCentral database and certificates)
  --help        show this text
Must run as root (for example with sudo).
EOF
}

N=mymaestro-remote
KEEP=0
while (($#)); do
  case $1 in
    --help | -h) usage; exit 0 ;;
    --keep-data) KEEP=1 ;;
    --name)
      (($# >= 2)) || die "--name needs a value."
      N=$2
      shift
      ;;
    *) usage >&2; die "Unknown option '$1'." ;;
  esac
  shift
done
[[ $N =~ $NAME_RE ]] || die "The name must look like mymaestro-remote or mymaestro-remote-abc."
((EUID == 0)) || die "This must run as root. Run: sudo $0 --name $N"
# One install or removal of this service at a time.
exec 9>"/run/lock/mymaestro-$N.lock" || die "Cannot take the lock /run/lock/mymaestro-$N.lock."
flock -n 9 || die "An install or removal of $N is running. Wait for it to finish."

unit=/etc/systemd/system/$N.service
prog=/opt/$N
state=/var/lib/$N
removed=()

# The hub folder and the hub account the unit was made for, if the unit names them in the expected form.
hub_home=
hub_ids=
if [[ -f $unit && ! -L $unit ]]; then
  hub_home=$(sed -n 's/^# My Maestro hub home: //p' -- "$unit" | head -n 1 || true)
  if [[ $hub_home =~ $PATH_RE ]]; then
    case "/$hub_home/" in
      */./* | */../*) hub_home= ;;
    esac
  else
    hub_home=
  fi
  hub_ids=$(sed -n 's/^# My Maestro hub account: //p' -- "$unit" | head -n 1 || true)
  [[ $hub_ids =~ ^[1-9][0-9]*:[0-9]+$ ]] || hub_ids=
fi

if [[ -e $unit || -L $unit ]]; then
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl disable --now "$N.service" >/dev/null 2>&1 || note "Note: systemctl could not stop or disable $N.service (it may not be loaded)."
  fi
  rm -f -- "$unit"
  removed+=("$unit")
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl daemon-reload || true
    systemctl reset-failed "$N.service" >/dev/null 2>&1 || true
  fi
fi

if [[ -L $prog ]]; then
  note "Left $prog alone: it is a symbolic link."
elif [[ -d $prog ]]; then
  rm -rf --one-file-system -- "$prog"
  removed+=("$prog")
fi
# Copies a failed or cut-off install left aside (/opt/.NAME.new.PID, /opt/.NAME.old.PID), and the root-only folders a failed
# rollback kept (/tmp/mymaestro-remote-install.*; they hold a request with password hashes).
for d in /opt/."$N".new.* /opt/."$N".old.* /tmp/mymaestro-remote-install.*; do
  if [[ -d $d && ! -L $d && $(stat -c '%u' -- "$d") == 0 ]]; then
    rm -rf --one-file-system -- "$d"
    removed+=("$d")
  fi
done

if ((KEEP)); then
  [[ ! -e $state ]] || note "Kept $state (--keep-data)."
else
  for d in "$state" "/var/lib/private/$N"; do
    if [[ -L $d ]]; then
      note "Left $d alone: it is a symbolic link."
    elif [[ -d $d ]]; then
      rm -rf --one-file-system -- "$d"
      removed+=("$d")
    fi
  done
fi

# The service account, only if it is the system account install.sh made. With --keep-data it stays, so the kept files never
# belong to a number another account could be given later.
if ((KEEP)); then
  if getent passwd "$N" >/dev/null 2>&1; then note "Kept the account $N, which owns the kept data."; fi
elif pw=$(getent passwd "$N"); then
  puid=$(printf '%s' "$pw" | cut -d: -f3)
  phome=$(printf '%s' "$pw" | cut -d: -f6)
  if [[ $puid =~ ^[0-9]+$ ]] && ((puid < 1000)) && [[ $phome == "$state" ]]; then
    userdel "$N" >/dev/null 2>&1 || note "Note: userdel could not remove the account $N."
    removed+=("account $N")
  else
    note "Left the account $N alone: it is not the service account made by install.sh."
  fi
fi
if ((!KEEP)) && getent group "$N" >/dev/null 2>&1; then
  if ! getent passwd "$N" >/dev/null 2>&1; then
    groupdel "$N" >/dev/null 2>&1 || note "Note: groupdel could not remove the group $N."
    removed+=("group $N")
  fi
fi

# The two files install.sh gave back to the hub, removed with the hub account the unit names (never as root), so a swapped
# folder there can only lead to files that account could remove anyway. Nothing else in its folder is touched.
if [[ -n $hub_home && -n $hub_ids ]]; then
  sdir=$hub_home/service
  if timeout 60 setpriv --reuid="${hub_ids%%:*}" --regid="${hub_ids##*:}" --clear-groups --no-new-privs -- env -i PATH=/usr/bin:/bin \
    bash --noprofile --norc -c 'cd -P -- "$1" 2>/dev/null || exit 0; rm -f -- root-cert-public.crt installed.json request.env' _ "$sdir"; then
    removed+=("$sdir/root-cert-public.crt, installed.json and request.env (if they were there)")
  else
    note "Note: could not remove the hand-back files in $sdir with the hub's account."
  fi
fi

if ((${#removed[@]})); then
  note "Removed:"
  printf '  %s\n' "${removed[@]}"
else
  note "Nothing to remove for $N."
fi
note "Done."
