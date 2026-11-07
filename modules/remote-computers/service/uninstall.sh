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

unit=/etc/systemd/system/$N.service
prog=/opt/$N
state=/var/lib/$N
removed=()

# The hub folder the unit was made for, if the unit names one in the expected form.
hub_home=
if [[ -f $unit && ! -L $unit ]]; then
  hub_home=$(sed -n 's/^# My Maestro hub home: //p' -- "$unit" | head -n 1 || true)
  if [[ $hub_home =~ $PATH_RE ]]; then
    case "/$hub_home/" in
      */./* | */../*) hub_home= ;;
    esac
  else
    hub_home=
  fi
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

# The service account, only if it is the system account install.sh made.
if pw=$(getent passwd "$N"); then
  puid=$(printf '%s' "$pw" | cut -d: -f3)
  phome=$(printf '%s' "$pw" | cut -d: -f6)
  if [[ $puid =~ ^[0-9]+$ ]] && ((puid < 1000)) && [[ $phome == "$state" ]]; then
    userdel "$N" >/dev/null 2>&1 || note "Note: userdel could not remove the account $N."
    removed+=("account $N")
  else
    note "Left the account $N alone: it is not the service account made by install.sh."
  fi
fi
if getent group "$N" >/dev/null 2>&1; then
  if ! getent passwd "$N" >/dev/null 2>&1; then
    groupdel "$N" >/dev/null 2>&1 || note "Note: groupdel could not remove the group $N."
    removed+=("group $N")
  fi
fi

# The two files install.sh gave back to the hub; nothing else in its folder is touched.
if [[ -n $hub_home ]]; then
  sdir=$hub_home/service
  if [[ -d $sdir && ! -L $sdir ]] && cd -P -- "$sdir" 2>/dev/null && [[ $(stat -c '%u' -- .) != 0 ]]; then
    for f in root-cert-public.crt installed.json; do
      if [[ -e ./$f || -L ./$f ]]; then
        rm -f -- "./$f"
        removed+=("$sdir/$f")
      fi
    done
  fi
fi

if ((${#removed[@]})); then
  note "Removed:"
  printf '  %s\n' "${removed[@]}"
else
  note "Nothing to remove for $N."
fi
note "Done."
