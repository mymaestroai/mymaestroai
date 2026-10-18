#!/bin/bash
# Publish the hub to your tailnet (phone, laptop, ...) with `tailscale serve`.
#
# The hub keeps listening on 127.0.0.1 only; Tailscale terminates HTTPS on
# https://<this-mac>.<tailnet>.ts.net and proxies to it. Only devices signed in
# to your tailnet can reach that URL.
#
# Usage: scripts/tailscale-setup.sh          set up (idempotent)
#        scripts/tailscale-setup.sh --off    stop serving
set -euo pipefail

cd "$(dirname "$0")/.."
HUB_PORT="${PORT:-$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)}"
HUB_PORT="${HUB_PORT:-8888}"

TS="$(command -v tailscale || true)"
[ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
if [ -z "$TS" ]; then
  if [ "$(uname -s)" = Darwin ]; then
    echo "Tailscale is not installed. Install \"Tailscale\" from the Mac App Store (or: brew install --cask tailscale-app),"
    echo "open it from Applications, sign in, and run this script again."
  else
    echo "Tailscale is not installed. Run:"
    echo "  curl -fsSL https://tailscale.com/install.sh | sh"
    echo "  sudo tailscale up"
    echo "then run this script again."
  fi
  exit 1
fi
# The hub's own Node (installer) or the system one, to restart the hub through its service afterwards.
NODE="$(sed -n 's/.*"node": *"\([^"]*\)".*/\1/p' data/install.json 2>/dev/null | head -1)"
[ -x "${NODE:-}" ] || NODE="$(command -v node || true)"

if [ "${1:-}" = "--off" ]; then
  "$TS" serve --https=443 off || true
  echo "Stopped serving the hub on the tailnet."
  exit 0
fi

if ! "$TS" status >/dev/null 2>&1; then
  echo "Tailscale is not connected. Opening sign-in..."
  if [ "$(uname -s)" = Darwin ]; then open -a Tailscale 2>/dev/null || true; "$TS" up
  else echo "Run:  sudo tailscale up   (it prints a sign-in link), then run this script again."; exit 1; fi
fi

if [ -n "$NODE" ]; then
  DNS_NAME="$("$TS" status --json | "$NODE" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,""))}catch{console.log("")}})')"
else
  DNS_NAME="$("$TS" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
fi
if [ -z "$DNS_NAME" ]; then
  echo "Could not read this computer's tailnet name. Enable MagicDNS in the Tailscale admin console."
  exit 1
fi

echo "Serving http://127.0.0.1:$HUB_PORT at https://$DNS_NAME ..."
echo "(If asked, enable HTTPS certificates for your tailnet at the link shown.)"
if ! "$TS" serve --bg "$HUB_PORT"; then
  if [ "$(uname -s)" != Darwin ]; then
    echo
    echo "Tailscale needs permission to publish for your user. Run once:"
    echo "  sudo tailscale set --operator=$USER"
    echo "then run this script again."
  fi
  exit 1
fi

# Let the browser event stream accept the tailnet hostname (lib/bind-host.js).
touch .env
if grep -q '^HUB_ALLOWED_HOSTS=' .env; then
  sed "s|^HUB_ALLOWED_HOSTS=.*|HUB_ALLOWED_HOSTS=$DNS_NAME|" .env > .env.tmp && mv .env.tmp .env && chmod 600 .env
else
  [ -s .env ] && [ "$(tail -c1 .env)" != "" ] && echo >> .env
  echo "HUB_ALLOWED_HOSTS=$DNS_NAME" >> .env
fi
echo "Set HUB_ALLOWED_HOSTS=$DNS_NAME in .env"

echo "Restarting the hub so it accepts the new address (open pages reload by themselves)..."
if [ -n "$NODE" ]; then "$NODE" scripts/hub-cli.js restart; else bash scripts/restart.sh; fi

echo
echo "Done. On your phone: install Tailscale, sign in with the same account, then open"
echo "  https://$DNS_NAME"
echo "and add it to the home screen (iPhone: Share > Add to Home Screen; Android: menu > Install app)."
echo "Then, in the phone app's menu, turn on notifications and send a test notification."
