#!/usr/bin/env bash
# Kindra Bot installer — RY GROUP
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/kindra-bot/main/install.sh)
#
# Asks for two things: a Telegram bot token, and whether to import an existing wallet or create a
# fresh one. Everything else is automatic.
set -euo pipefail

REPO="${KINDRA_REPO:-https://github.com/rygroup-dev/kindra-bot.git}"
DIR="${KINDRA_DIR:-$HOME/kindra-bot}"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
die()   { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# Prompt even when the script itself arrived on stdin: `bash <(curl …)` reads the script from a
# process substitution, so /dev/tty is the only reliable place to talk to the user.
#
# Must survive having no terminal at all (CI, `| bash`, a container without a tty): under `set -u`
# an unassigned `var` aborts the whole install, and `read` from a missing /dev/tty fails outright.
# In that case we return empty and every caller falls back to its default.
ask() {
  local prompt="$1"
  local var=""
  # `[ -r /dev/tty ]` is not enough: the node can exist and still fail to open when the process has
  # no controlling terminal, which prints an ugly error before falling through. Test the open.
  if { : < /dev/tty; } 2>/dev/null; then
    read -r -p "$prompt" var < /dev/tty 2>/dev/null || var=""
  elif [ -t 0 ]; then
    read -r -p "$prompt" var || var=""
  else
    printf '%s\n' "$prompt(no terminal — using the default)" >&2
  fi
  printf '%s' "$var"
}

# True when there is nobody to answer a prompt.
noninteractive() { ! { : < /dev/tty; } 2>/dev/null && [ ! -t 0 ]; }

echo
bold "🌿  Kindra Bot — RY GROUP"
info "    playkindra.com · Robinhood Chain 4663"
echo

# ---------------------------------------------------------------- dependencies
need_pkg=""
command -v git  >/dev/null 2>&1 || need_pkg="$need_pkg git"
command -v node >/dev/null 2>&1 || need_pkg="$need_pkg nodejs"

if [ -n "$need_pkg" ]; then
  warn "Missing:$need_pkg — trying to install…"
  if   command -v apt-get >/dev/null 2>&1; then sudo apt-get update -qq && sudo apt-get install -y $need_pkg
  elif command -v dnf     >/dev/null 2>&1; then sudo dnf install -y $need_pkg
  elif command -v pacman  >/dev/null 2>&1; then sudo pacman -Sy --noconfirm $need_pkg
  elif command -v brew    >/dev/null 2>&1; then brew install $need_pkg
  else die "Install$need_pkg manually, then re-run this script."
  fi
fi

command -v node >/dev/null 2>&1 || die "Node.js is required — https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node $NODE_MAJOR is too old — Kindra Bot needs 18 or newer."
ok "✓ node $(node -v), git $(git --version | awk '{print $3}')"

# ---------------------------------------------------------------------- source
if [ -d "$DIR/.git" ]; then
  info "→ updating $DIR"
  git -C "$DIR" pull --ff-only >/dev/null 2>&1 || warn "  (couldn't fast-forward; keeping what's there)"
else
  info "→ cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR" >/dev/null 2>&1 || die "Clone failed — is $REPO reachable?"
fi
cd "$DIR"

info "→ installing dependencies"
npm install --no-audit --no-fund --loglevel=error
ok "✓ dependencies ready"

# Kindra publishes its own balance table (shared.js is imported by its client AND its server), so
# the bot reads the live rules instead of shipping a copy that goes stale on the next patch.
info "→ fetching the game's rule table"
node tools/fetch-rules.js --if-missing
ok "✓ game rules ready"

# -------------------------------------------------------------- telegram token
echo
if [ -f .env ] && grep -q '^TELEGRAM_BOT_TOKEN=.\+' .env 2>/dev/null; then
  ok "✓ Telegram token already configured"
else
  TOKEN="${TELEGRAM_BOT_TOKEN:-}"
  if [ -z "$TOKEN" ]; then
    bold "Telegram bot"
    info "  Open @BotFather, send /newbot, and paste the token it gives you."
    TRIES=0
    while [ -z "$TOKEN" ]; do
      TRIES=$((TRIES + 1))
      if [ "$TRIES" -gt 3 ] || noninteractive; then
        warn "  No token given — writing .env without one."
        warn "  Add TELEGRAM_BOT_TOKEN to $DIR/.env before starting."
        break
      fi
      TOKEN="$(ask '  Bot token: ')"
      case "$TOKEN" in
        *:*) ;;
        '') ;;
        *) warn "  That doesn't look like a token (expected 123456:AA…)."; TOKEN="" ;;
      esac
    done
  fi
  cat > .env <<EOF
TELEGRAM_BOT_TOKEN=$TOKEN
TELEGRAM_CHAT_ID=
WALLET_PRIVATE_KEY=
KINDRA_NAME=
KINDRA_WORLD=${KINDRA_WORLD:-valley}
KINDRA_AUTOSTART=0
RH_RPC=https://rpc.mainnet.chain.robinhood.com
EOF
  chmod 600 .env
  ok "✓ .env written (chmod 600)"
fi

# --------------------------------------------------------------------- wallets
echo
if [ -f wallets.json ]; then
  COUNT="$(node -p "require('./wallets.json').length" 2>/dev/null || echo 0)"
  ok "✓ wallets.json already holds $COUNT character(s)"
else
  bold "Wallet"
  info "  A character is created by a wallet signature — no gas, no captcha, no cost."
  echo   "    1) Create a new wallet  (recommended)"
  echo   "    2) Import a private key you already have"
  CHOICE="${KINDRA_WALLET_MODE:-}"
  if [ -z "$CHOICE" ] && noninteractive; then CHOICE=1; fi
  while [ "$CHOICE" != "1" ] && [ "$CHOICE" != "2" ]; do
    CHOICE="$(ask '  Choose [1/2]: ')"
    [ -z "$CHOICE" ] && CHOICE=1
  done

  if [ "$CHOICE" = "2" ]; then
    PK="${WALLET_PRIVATE_KEY:-}"
    while [ -z "$PK" ]; do
      PK="$(ask '  Private key (0x…64 hex): ')"
      if ! printf '%s' "$PK" | grep -qE '^(0x)?[0-9a-fA-F]{64}$'; then
        warn "  That is not a 32-byte hex key."; PK=""
      fi
    done
    node --input-type=module -e "
      const { Fleet } = await import('./lib/fleet.js');
      const { privateKeyToAccount } = await import('viem/accounts');
      let pk = process.argv[1]; if (!pk.startsWith('0x')) pk = '0x' + pk;
      const a = privateKeyToAccount(pk);
      Fleet.saveWallets([{ label: 'kindra-01', privateKey: pk, address: a.address, world: process.env.KINDRA_WORLD || 'valley', name: '', primary: true, createdAt: new Date().toISOString() }]);
      console.log('   imported ' + a.address);
    " "$PK"
    ok "✓ wallet imported (marked as your primary wallet)"
  else
    HOWMANY="${KINDRA_COUNT:-}"
    [ -z "$HOWMANY" ] && HOWMANY="$(ask '  How many characters? [1]: ')"
    case "$HOWMANY" in ''|*[!0-9]*) HOWMANY=1 ;; esac
    [ "$HOWMANY" -lt 1 ] && HOWMANY=1
    [ "$HOWMANY" -gt 20 ] && HOWMANY=20
    node --input-type=module -e "
      const { Fleet } = await import('./lib/fleet.js');
      const { DEFAULT_REFERRER } = await import('./lib/config.js');
      // A fresh install has no character at the Lv-10 referring threshold, so without this the
      // 500g + 200 \$KINDRA a conversion pays would go to nobody at all. Change or clear it with
      // KINDRA_REFERRER in .env — see the README.
      const made = Fleet.createWallets(Number(process.argv[1]), { world: process.env.KINDRA_WORLD || 'valley', referrer: DEFAULT_REFERRER || null });
      const all = Fleet.loadWallets(); if (all.length) { all[0].primary = true; Fleet.saveWallets(all); }
      for (const m of made) console.log('   ' + m.label + '  ' + m.address);
      if (DEFAULT_REFERRER) console.log('   referred by ' + DEFAULT_REFERRER + ' (override with KINDRA_REFERRER in .env)');
    " "$HOWMANY"
    ok "✓ $HOWMANY wallet(s) created"
  fi
  chmod 600 wallets.json 2>/dev/null || true
  warn "  ⚠  wallets.json is the ONLY copy of these keys. Back it up."
fi

# --------------------------------------------------------------------- service
echo
if command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
  # Refuse to hijack an existing install. A second copy pointed at a different directory would poll
  # the same Telegram token as the first, and two pollers fight over every update.
  EXISTING="$(grep -m1 '^WorkingDirectory=' /etc/systemd/system/kindra-bot.service 2>/dev/null | cut -d= -f2- || true)"
  if [ -n "$EXISTING" ] && [ "$EXISTING" != "$DIR" ]; then
    warn "→ a kindra-bot service already points at $EXISTING"
    warn "  Leaving it alone. Start this copy manually, or remove that service first."
    echo
    bold "✅  Done (service untouched)."
    info "    cd $DIR && npm start"
    exit 0
  fi
  sed "s#^WorkingDirectory=.*#WorkingDirectory=$DIR#; s#^StandardOutput=.*#StandardOutput=append:$DIR/data/service.log#; s#^StandardError=.*#StandardError=append:$DIR/data/service.log#" \
    kindra-bot.service > /etc/systemd/system/kindra-bot.service
  mkdir -p "$DIR/data"
  systemctl daemon-reload
  systemctl enable --now kindra-bot.service >/dev/null 2>&1
  ok "✓ systemd service 'kindra-bot' installed and running"
  info "   logs:  journalctl -u kindra-bot -f"
else
  warn "→ no systemd (or not root). Start it yourself:"
  info "   cd $DIR && npm start"
fi

echo
bold "✅  Done."
info "    Open your Telegram bot and press /start — everything after that is buttons."
echo
