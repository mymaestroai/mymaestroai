#!/usr/bin/env bash
# My Maestro AI installer.
#
#   curl -fsSL https://mymaestroai.ai/install.sh | bash
#
# Or download, read, then run:   curl -fsSLO https://mymaestroai.ai/install.sh && less install.sh && bash install.sh
#
# What it does, all inside your home folder, without sudo:
#   1. Downloads Node.js (nodejs.org, checksum verified) into ~/.mymaestroai/node, used only by My Maestro AI.
#   2. Downloads My Maestro AI into ~/mymaestroai and installs its packages.
#   3. Sets it to start by itself (a systemd user service on Linux, a launchd agent on macOS).
#   4. Opens the Welcome page in your browser to create your account and connect your first AI.
# It never asks for API keys in the terminal and never sends anything anywhere except the downloads above.
#
# Options: --dir <folder>  --port <n>  --channel stable|experimental  --repo <git url>  --no-service  --no-open
#          --no-profile  --yes  --dry-run  --uninstall
# Environment (advanced): MM_STATE_DIR (default ~/.mymaestroai), MM_BIN_DIR (default ~/.local/bin), MM_DESKTOP_DIR.

set -u
umask 077
export LC_ALL=C

PRODUCT="My Maestro AI"
NODE_VERSION="22.23.4"
# SHA-256 of the official node-v22.23.4 archives (nodejs.org SHASUMS256.txt, release-key signature checked when this
# installer was published).
NODE_SHA_darwin_arm64="c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428"
NODE_SHA_darwin_x64="efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819"
NODE_SHA_linux_arm64="f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9"
NODE_SHA_linux_x64="b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406"
# The one place the code's GitHub location is set (owner/name). MM_REPO_SLUG overrides it; --repo takes any git URL.
REPO_SLUG="${MM_REPO_SLUG:-mymaestroai/mymaestroai}"
REPO_HTTPS="https://github.com/$REPO_SLUG.git"
REPO_SSH="git@github.com:$REPO_SLUG.git"

DIR="$HOME/mymaestroai"
PORT=""
CHANNEL="stable"
REPO=""
SERVICE=1
OPEN=1
PROFILE=1
YES=0
DRY=0
UNINSTALL=0
STATE_DIR="${MM_STATE_DIR:-$HOME/.mymaestroai}"
BIN_DIR="${MM_BIN_DIR:-$HOME/.local/bin}"
LOG=""
CRED_FILE=""

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\n  ! %s\n' "$*" >&2; }
die()  { printf '\n✗ %s\n' "$*" >&2; [ -n "$LOG" ] && printf '%s failed: %s\n' "$(date '+%F %T')" "$*" >> "$LOG" 2>/dev/null; exit 1; }
step() { printf '\n→ %s\n' "$*"; [ -n "$LOG" ] && printf '%s step: %s\n' "$(date '+%F %T')" "$*" >> "$LOG" 2>/dev/null; return 0; }
tty_ok() { [ -r /dev/tty ] && [ -w /dev/tty ] && { : < /dev/tty; } 2>/dev/null; }
ask() { # ask "question" default -> echoes the answer
  local q="$1" d="${2:-}" a=""
  if [ "$YES" = 1 ] || ! tty_ok; then printf '%s' "$d"; return 0; fi
  printf '%s ' "$q" > /dev/tty; IFS= read -r a < /dev/tty || a=""
  printf '%s' "${a:-$d}"
}
confirm() { local a; a="$(ask "$1 [Y/n]" y)"; case "$a" in [nN]*) return 1 ;; *) return 0 ;; esac; }
run() { if [ "$DRY" = 1 ]; then info "would run: $*"; return 0; fi; "$@"; }
have() { command -v "$1" >/dev/null 2>&1; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) DIR="${2:?--dir needs a folder}"; shift 2 ;;
      --port) PORT="${2:?--port needs a number}"; shift 2 ;;
      --channel) CHANNEL="${2:?--channel needs stable or experimental}"; shift 2 ;;
      --repo) REPO="${2:?--repo needs a git URL}"; shift 2 ;;
      --no-service) SERVICE=0; shift ;;
      --no-open) OPEN=0; shift ;;
      --no-profile) PROFILE=0; shift ;;
      --yes|-y) YES=1; shift ;;
      --dry-run) DRY=1; shift ;;
      --uninstall) UNINSTALL=1; shift ;;
      -h|--help) sed -n '2,22p' "$0" 2>/dev/null || true; exit 0 ;;
      *) die "Unknown option: $1 (see --help)" ;;
    esac
  done
  case "$CHANNEL" in stable) BRANCH=main ;; experimental) BRANCH=dev ;; *) die "--channel is stable or experimental" ;; esac
  case "$DIR" in /*) ;; *) DIR="$PWD/$DIR" ;; esac
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux) OS=linux ;;
    *) die "This installer supports macOS and Linux. On Windows, install it inside WSL (Ubuntu)." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) die "Unsupported processor: $(uname -m)" ;;
  esac
  if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then ARCH=arm64; fi   # Terminal under Rosetta
  DISTRO=""
  if [ "$OS" = linux ] && [ -r /etc/os-release ]; then
    DISTRO="$(. /etc/os-release; printf '%s %s' "${ID:-}" "${ID_LIKE:-}")"
    case "$DISTRO" in *debian*|*ubuntu*) ;; *) warn "Tested on Ubuntu and Debian. On ${DISTRO% } it may still work; if something is missing, the message will say what." ;; esac
  fi
}

wait_for_git() {
  if have git && git --version >/dev/null 2>&1; then return 0; fi
  if [ "$OS" = darwin ]; then
    step "Installing Apple's command line tools (needed for git)"
    info "A window will ask to install the command line developer tools. Click Install."
    info "It can take up to 10 minutes. This installer waits and continues by itself."
    run xcode-select --install >/dev/null 2>&1 || true
  else
    step "git is needed"
    info "Open another terminal and run:   sudo apt-get install -y git"
    info "This installer waits and continues by itself once git is installed."
  fi
  [ "$DRY" = 1 ] && return 0
  local i=0
  while [ $i -lt 360 ]; do have git && git --version >/dev/null 2>&1 && { info "git is ready."; return 0; }; sleep 5; i=$((i + 1)); done
  die "git did not appear within 30 minutes. Install it, then run the installer again."
}

sha256_of() { if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

install_node() {
  NODE_DIR="$STATE_DIR/node"
  NODE="$NODE_DIR/bin/node"
  if [ -x "$NODE" ] && [ "$("$NODE" --version 2>/dev/null)" = "v$NODE_VERSION" ]; then info "Node.js $NODE_VERSION is already here."; return 0; fi
  step "Downloading Node.js $NODE_VERSION for $OS/$ARCH (nodejs.org)"
  local name="node-v$NODE_VERSION-$OS-$ARCH" var="NODE_SHA_${OS}_${ARCH}" expected tmp got
  expected="$(eval "printf '%s' \"\${$var:-}\"")"
  [ -n "$expected" ] || die "No checksum for $OS/$ARCH in this installer."
  [ "$DRY" = 1 ] && { info "would download https://nodejs.org/dist/v$NODE_VERSION/$name.tar.gz and check SHA-256 $expected"; return 0; }
  tmp="$(mktemp -d)" || die "Could not make a temporary folder."
  curl -fL --retry 3 --progress-bar -o "$tmp/node.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.gz" || die "Could not download Node.js. Check the internet connection (and HTTPS_PROXY if you use a proxy)."
  got="$(sha256_of "$tmp/node.tar.gz")"
  [ "$got" = "$expected" ] || die "The Node.js download did not match its published checksum (got $got). Nothing was installed."
  mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
  tar -xzf "$tmp/node.tar.gz" -C "$tmp" || die "Could not unpack Node.js."
  rm -rf "$NODE_DIR.new" && mv "$tmp/$name" "$NODE_DIR.new" && rm -rf "$NODE_DIR" && mv "$NODE_DIR.new" "$NODE_DIR"
  rm -rf "$tmp"
  info "Node.js $("$NODE" --version) installed in $NODE_DIR (checksum verified)."
}

find_repo_access() {
  if [ -n "$REPO" ]; then info "Using $REPO"; return 0; fi
  step "Checking access to the code"
  if GIT_TERMINAL_PROMPT=0 git ls-remote "$REPO_HTTPS" HEAD >/dev/null 2>&1; then REPO="$REPO_HTTPS"; info "Public download."; return 0; fi
  if GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10" git ls-remote "$REPO_SSH" HEAD >/dev/null 2>&1; then
    REPO="$REPO_SSH"; info "Using your GitHub SSH key."; return 0
  fi
  say ""
  say "  The repository $REPO_SLUG is private. You need a GitHub account with access to it."
  say "  Create a read-only token for it:"
  say "    1. Open https://github.com/settings/personal-access-tokens/new"
  say "    2. Repository access: Only select repositories → $REPO_SLUG"
  say "    3. Permissions → Repository permissions → Contents: Read-only"
  say "    4. Generate the token and copy it."
  tty_ok || die "No terminal to ask for the token. Run the installer from a terminal, or pass --repo."
  CRED_FILE="$STATE_DIR/git-credentials"
  mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
  local n=0 token=""
  while [ $n -lt 3 ]; do
    printf '\n  Paste the token (it is not shown) and press Enter: ' > /dev/tty
    stty -echo < /dev/tty 2>/dev/null; IFS= read -r token < /dev/tty || token=""; stty echo < /dev/tty 2>/dev/null; printf '\n' > /dev/tty
    token="$(printf '%s' "$token" | tr -d '[:space:]')"
    if [ -n "$token" ]; then
      printf 'https://x-access-token:%s@github.com\n' "$token" > "$CRED_FILE"; chmod 600 "$CRED_FILE"
      if GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c "credential.helper=store --file=$CRED_FILE" ls-remote "$REPO_HTTPS" HEAD >/dev/null 2>&1; then
        REPO="$REPO_HTTPS"; token=""; info "Token accepted. It is kept in $CRED_FILE (only you can read it) so updates work later."; return 0
      fi
      warn "GitHub did not accept that token for $REPO_SLUG. Check the repository and the Contents: Read-only permission."
    fi
    n=$((n + 1))
  done
  rm -f "$CRED_FILE"
  die "Could not get access to the code. Ask the repository's owner for access for your GitHub account, then run the installer again."
}

git_cred() { if [ -n "$CRED_FILE" ]; then git -c credential.helper= -c "credential.helper=store --file=$CRED_FILE" "$@"; else git "$@"; fi; }

get_code() {
  if [ -d "$DIR/.git" ]; then
    local origin; origin="$(git -C "$DIR" remote get-url origin 2>/dev/null || true)"
    case "$origin" in *agent-hub*|*mymaestro*|"$REPO") ;; *) die "$DIR already holds a different git project ($origin). Choose another folder with --dir." ;; esac
    step "Updating the existing install in $DIR"
    confirm "  Update it to the newest $CHANNEL version? Your data stays as it is." || die "Stopped. Nothing was changed."
    [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no 2>/dev/null)" ] && die "$DIR has local code changes. Commit or stash them, or use the Update button in the hub."
    run git_cred -C "$DIR" fetch --quiet origin "$BRANCH" || die "Could not fetch updates."
    run git -C "$DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH" || die "Could not switch to the $CHANNEL channel."
  elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    die "$DIR exists and is not empty. Choose another folder with --dir."
  else
    step "Downloading $PRODUCT ($CHANNEL channel) into $DIR"
    run git_cred clone --quiet --branch "$BRANCH" "$REPO" "$DIR" || die "Could not download the code."
  fi
  if [ -n "$CRED_FILE" ] && [ "$DRY" != 1 ]; then git -C "$DIR" config credential.helper "store --file=$CRED_FILE"; fi
  if [ "$DRY" != 1 ] && [ ! -f "$DIR/scripts/hub-cli.js" ]; then
    die "The $CHANNEL channel is a version from before this installer. Run the installer again with:  --channel experimental"
  fi
  [ "$DRY" = 1 ] || info "Version $(git -C "$DIR" rev-parse --short HEAD) on $BRANCH."
}

install_packages() {
  step "Installing packages"
  [ "$DRY" = 1 ] && { info "would run: npm ci --omit=dev --ignore-scripts, then npm rebuild better-sqlite3"; return 0; }
  ( cd "$DIR" && PATH="$NODE_DIR/bin:$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error ) || die "npm could not install the packages. See the messages above."
  if ! ( cd "$DIR" && PATH="$NODE_DIR/bin:$PATH" npm rebuild better-sqlite3 --loglevel=error >/dev/null 2>&1 ); then
    if [ "$OS" = darwin ]; then die "The database module needs Apple's command line tools: run  xcode-select --install  then run the installer again."
    else die "The database module needs build tools: run  sudo apt-get install -y build-essential python3  then run the installer again."; fi
  fi
  ( cd "$DIR" && "$NODE" -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()" ) || die "The database module does not load on this machine."
  info "Packages installed."
}

port_free() { "$NODE" -e "const s=require('net').createServer();s.once('error',()=>process.exit(1));s.listen($1,'127.0.0.1',()=>s.close(()=>process.exit(0)))" 2>/dev/null; }

configure() {
  step "Configuring"
  if [ "$DRY" = 1 ]; then info "would create $DIR/data (private) and $DIR/.env with the port, and data/install.json"; PORT="${PORT:-8888}"; return 0; fi
  mkdir -p "$DIR/data" && chmod 700 "$DIR/data"
  local existing=""
  [ -f "$DIR/.env" ] && existing="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DIR/.env" | head -1)"
  if [ -n "$existing" ] && [ -n "$PORT" ] && [ "$PORT" != "$existing" ]; then
    sed "s/^[[:space:]]*PORT[[:space:]]*=.*/PORT=$PORT/" "$DIR/.env" > "$DIR/.env.tmp" && mv "$DIR/.env.tmp" "$DIR/.env"
  elif [ -n "$existing" ]; then PORT="$existing"
  elif [ -z "$PORT" ]; then PORT=8888; while ! port_free "$PORT"; do PORT=$((PORT + 1)); [ "$PORT" -gt 8999 ] && die "No free port between 8888 and 8999. Pass --port."; done
  fi
  if [ ! -f "$DIR/.env" ]; then printf '# %s settings. Provider keys are added in the browser (Settings), not here.\nPORT=%s\n' "$PRODUCT" "$PORT" > "$DIR/.env"
  elif [ -z "$existing" ]; then printf 'PORT=%s\n' "$PORT" >> "$DIR/.env"; fi
  chmod 600 "$DIR/.env"
  MM_DIR="$DIR" MM_PORT="$PORT" MM_NODE="$NODE" MM_NODE_DIR="$NODE_DIR" MM_STATE="$STATE_DIR" MM_BIN="$BIN_DIR/mymaestro" MM_CHANNEL="$CHANNEL" MM_REPO="$REPO" \
    "$NODE" -e "
      const fs=require('fs'),p=process.env.MM_DIR+'/data/install.json';let cur={};try{cur=JSON.parse(fs.readFileSync(p,'utf8'))}catch{}
      const next={...cur,product:'My Maestro AI',dir:process.env.MM_DIR,port:Number(process.env.MM_PORT),node:process.env.MM_NODE,nodeDir:process.env.MM_NODE_DIR,stateDir:process.env.MM_STATE,bin:process.env.MM_BIN,channel:process.env.MM_CHANNEL,repo:process.env.MM_REPO,installedAt:cur.installedAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
      fs.writeFileSync(p,JSON.stringify(next,null,2)+'\n',{mode:0o600});" || die "Could not write data/install.json."
  info "Address: http://localhost:$PORT (this computer only)."
}

install_command() {
  step "Adding the mymaestro command"
  local target="$BIN_DIR/mymaestro"
  if [ "$DRY" = 1 ]; then info "would write $target"; return 0; fi
  mkdir -p "$BIN_DIR"
  if [ -e "$target" ] && ! grep -q 'hub-cli.js' "$target" 2>/dev/null; then warn "$target exists and is something else; not replacing it. Use $NODE $DIR/scripts/hub-cli.js instead."; return 0; fi
  printf '#!/bin/sh\n# My Maestro AI command (written by the installer)\nexec "%s" "%s" "$@"\n' "$NODE" "$DIR/scripts/hub-cli.js" > "$target"
  chmod 755 "$target"
  case ":$PATH:" in *":$BIN_DIR:"*) info "Type mymaestro in a terminal to check on it." ; return 0 ;; esac
  if [ "$PROFILE" = 1 ]; then
    local rc
    case "${SHELL:-}" in */zsh) rc="$HOME/.zshrc" ;; */bash) if [ "$OS" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;; *) rc="$HOME/.profile" ;; esac
    if ! grep -qs 'added by the My Maestro AI installer' "$rc"; then
      printf '\nexport PATH="%s:$PATH"  # added by the My Maestro AI installer\n' "$BIN_DIR" >> "$rc"
      info "Added $BIN_DIR to your PATH in $rc (new terminal windows will have it)."
    fi
  fi
}

start_hub() {
  if [ "$DRY" = 1 ]; then info "would install the service and start it"; return 0; fi
  if [ "$SERVICE" = 1 ]; then
    step "Setting it to start by itself"
    if ! "$NODE" "$DIR/scripts/hub-cli.js" service install; then
      warn "The service could not be installed; starting it directly instead (it will not restart after a reboot)."
      "$NODE" "$DIR/scripts/hub-cli.js" start >/dev/null || die "Could not start $PRODUCT. See: $DIR/server.log"
    fi
  else
    step "Starting $PRODUCT"
    "$NODE" "$DIR/scripts/hub-cli.js" start >/dev/null || die "Could not start $PRODUCT. See: $DIR/server.log"
  fi
  local i=0
  while [ $i -lt 90 ]; do curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/health" && break; sleep 1; i=$((i + 1)); done
  if [ $i -ge 90 ]; then
    warn "$PRODUCT did not answer within 90 seconds. The last lines of its log:"
    tail -n 30 "$DIR/server.log" 2>/dev/null >&2
    die "To see it run in the foreground:  cd \"$DIR\" && \"$NODE\" server.js"
  fi
  info "Running."
}

add_shortcut() {
  [ "$DRY" = 1 ] && return 0
  local desk="${MM_DESKTOP_DIR:-$HOME/Desktop}" url="http://localhost:$PORT/"
  [ -d "$desk" ] || return 0
  if [ "$OS" = darwin ]; then
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>URL</key><string>%s</string></dict></plist>\n' "$url" > "$desk/My Maestro AI.webloc"
  else
    printf '[Desktop Entry]\nType=Link\nName=My Maestro AI\nURL=%s\nIcon=web-browser\n' "$url" > "$desk/my-maestro-ai.desktop"
    chmod 755 "$desk/my-maestro-ai.desktop" 2>/dev/null || true
  fi
  SHORTCUT="$desk"   # finish() tells the owner: the shortcut opens the hub, and an unfinished setup resumes there
}

# Is Claude Code on this computer, and signed in? Informational: the Welcome page proves it with one real question.
# Signed in = the token the client uses exists (its sign-in file, or the macOS Keychain entry), as the hub reads it.
claude_status() {
  local bin="" signed=0
  bin="$(command -v claude 2>/dev/null || true)"
  if [ -z "$bin" ] && [ -x "$HOME/.local/bin/claude" ]; then bin="$HOME/.local/bin/claude"; fi
  if [ -z "$bin" ] && [ -x "$HOME/.claude/local/claude" ]; then bin="$HOME/.claude/local/claude"; fi
  if [ -s "$HOME/.claude/.credentials.json" ]; then signed=1; fi
  if [ "$signed" = 0 ] && [ "${OS:-}" = darwin ] && have security; then
    if security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then signed=1; fi
  fi
  if [ "$signed" = 1 ]; then echo signed-in; elif [ -n "$bin" ]; then echo installed; else echo missing; fi
}
claude_line() {
  case "$(claude_status)" in
    signed-in) say "  Claude: Claude Code is on this computer and signed in. The Welcome page confirms it with one quick question." ;;
    installed) say "  Claude: Claude Code is on this computer but not signed in yet. To use your Claude plan, open a new terminal,"
               say "  type claude, sign in in the browser, then type /exit. The Welcome page checks it." ;;
    *)         say "  Claude: Claude Code is not on this computer. To use a Claude plan, the Welcome page shows the two steps;"
               say "  an API key or a model on this computer works too." ;;
  esac
}

finish() {
  if [ "$DRY" = 1 ]; then say ""; claude_line; say ""; say "Dry run finished: nothing was changed."; say ""; return 0; fi
  local link=""
  if [ "$DRY" != 1 ]; then link="$("$NODE" "$DIR/scripts/hub-cli.js" setup-link --plain 2>/dev/null || true)"; fi
  [ -n "$link" ] || link="http://localhost:$PORT/"
  local opened=0
  if [ "$OPEN" = 1 ] && [ "$DRY" != 1 ]; then
    if [ "$OS" = darwin ]; then open "$link" >/dev/null 2>&1 && opened=1
    elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && have xdg-open; then xdg-open "$link" >/dev/null 2>&1 & opened=1; fi
  fi
  say ""
  say "✓ $PRODUCT is installed and running."
  say ""
  if [ "$opened" = 1 ]; then say "  Your browser is opening the Welcome page. If it did not, open this link:"
  else say "  Open this link in a browser on this computer to finish setting up:"; fi
  say ""
  say "    $link"
  say ""
  if [ -n "${SSH_CONNECTION:-}" ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    say "  You are connected over SSH. On your own computer, run:"
    say "    ssh -L $PORT:localhost:$PORT $(id -un)@$(hostname)"
    say "  then open the link above there."
    say ""
  fi
  say "  Your hub lives at http://localhost:$PORT (bookmark it)."
  if [ -n "${SHORTCUT:-}" ]; then
    say "  A \"My Maestro AI\" shortcut is on your Desktop. If the setup page gets closed or replaced (signing in to"
    say "  Claude can do that), open the shortcut: setup continues where you left off."
  else
    say "  If the setup page gets closed or replaced, open http://localhost:$PORT again: setup continues where you left off."
  fi
  say ""
  claude_line
  say ""
  say "  Day to day, in a new terminal window:"
  say "    mymaestro status   ·   mymaestro restart   ·   mymaestro logs   ·   mymaestro update   ·   mymaestro backup"
  say ""
}

main() {
  parse_args "$@"
  if [ "$(id -u)" = 0 ]; then die "Run the installer as your normal user, not as root or with sudo."; fi
  if [ "$UNINSTALL" = 1 ]; then
    [ -f "$DIR/scripts/hub-cli.js" ] || die "No $PRODUCT install in $DIR (pass --dir)."
    local node="$STATE_DIR/node/bin/node"; [ -x "$node" ] || node="$(command -v node || true)"
    [ -n "$node" ] || die "Node.js not found."
    exec "$node" "$DIR/scripts/hub-cli.js" uninstall
  fi
  detect_platform
  if [ "$DRY" != 1 ]; then   # a dry run writes nothing, not even the log
    mkdir -p "$STATE_DIR" 2>/dev/null && chmod 700 "$STATE_DIR" 2>/dev/null
    LOG="$STATE_DIR/install.log"
    printf '%s installer started (%s/%s, channel %s, dir %s)\n' "$(date '+%F %T')" "$OS" "$ARCH" "$CHANNEL" "$DIR" >> "$LOG" 2>/dev/null || LOG=""
  fi
  say ""
  say "$PRODUCT installer"
  say ""
  say "  This will, inside your home folder and without sudo:"
  say "    · download Node.js $NODE_VERSION from nodejs.org into $STATE_DIR/node"
  say "    · download $PRODUCT ($CHANNEL channel) into $DIR"
  if [ "$SERVICE" = 1 ]; then say "    · set it to start by itself, then open the Welcome page in your browser"
  else say "    · start it, then open the Welcome page in your browser"; fi
  [ "$DRY" = 1 ] && say "  (dry run: nothing will be changed)"
  confirm "
  Continue?" || die "Stopped. Nothing was changed."
  for t in curl tar gzip; do have "$t" || die "$t is needed. Install it and run the installer again."; done
  wait_for_git
  install_node
  find_repo_access
  get_code
  install_packages
  configure
  install_command
  start_hub
  add_shortcut
  finish
}

main "$@"
