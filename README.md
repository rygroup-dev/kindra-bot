<div align="center">

# 🌿 Kindra Bot

**Headless fleet automation for [Kindra](https://playkindra.com) — a 3D skilling MMO on Robinhood Chain.**

*a RY GROUP project*

🪓 Woodcutting · ⛏ Mining · 🎣 Fishing · 🌱 Foraging · 🍳 Cooking · 🔨 Crafting · ⚔️ Combat
📜 Quests · 🐲 Bosses · 🐴 Trade Roads · 🌻 Garden · 🎡 Dailies · 🧺 Market · 🪺 On-chain $KINDRA

[![node](https://img.shields.io/badge/node-%E2%89%A518-43853d?logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![chain](https://img.shields.io/badge/Robinhood%20Chain-4663-7ac74f)](https://robinhoodchain.blockscout.com)

</div>

## Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/kindra-bot/main/install.sh)
```

The installer asks for exactly two things:

1. **A Telegram bot token** — get one from [@BotFather](https://t.me/BotFather) in about thirty seconds.
2. **Create a new wallet, or import one you already have.**

Everything else — Node, git, dependencies, the game's rule table, a systemd service — is handled for
you. When it finishes, open your bot and press **/start**. After that it is all buttons.

<details>
<summary>Manual install</summary>

```bash
git clone https://github.com/rygroup-dev/kindra-bot.git && cd kindra-bot
npm install
npm run rules                 # fetch the game's balance table
cp .env.example .env          # add your TELEGRAM_BOT_TOKEN
npm start
```
</details>

## No browser

Most game bots drive a headless Chromium and then spend their life losing an arms race against
fingerprint detection. This one runs no browser at all — no Playwright, no Puppeteer, no Camoufox.
There is no `navigator.webdriver` to patch, no canvas hash to spoof, no automation artifact to hide,
because none of that exists in the first place.

What it does instead:

- **Behaves like a client that is actually rendering.** Every wait is jittered, sessions take short
  breaks and occasional long ones, and joins are staggered.
- **Looks like a person, not a row in a spreadsheet.** Character names, appearance and device
  profile are all derived from the wallet and stay stable for that character's life. Your fleet is
  `Loamreed` and `Bryn398`, never `bot-01` and `bot-02`.
- **Routes through proxies when you want it to** — one exit IP per account, set per-wallet.

## What the bot understands about the game

Three facts shape every decision it makes.

**Gold is capped per source, per day.** Combat, bosses, the vendor, the Trade Roads and gathering
each have their own daily ceiling, and grinding one past its limit earns *nothing*. The server
reports the live counters, so the bot reads them rather than guessing — and rotates the moment a
source is spent.

**Gathering decays.** A long uninterrupted grind on one skill drops to a fraction of its starting
yield and only recovers while you are idle. A bot that never stops is a bot working at quarter rate.
This one tracks the curve and rotates before it bites.

**Quest rewards ignore every cap.** The daily objectives are things the bot is doing anyway, so open
quests *steer* which activity runs next rather than being a separate chore.

On top of that it buys its own tools when the payback is short, cooks its own rations instead of
buying them, prices each stack against both the vendor and the player market before selling, tends a
garden that earns while it is elsewhere, and only joins a boss that other players are already
holding.

## Multi-account

Every cap above is **per character**, so one character has a hard daily ceiling no matter how well it
plays. Ten characters have ten ceilings. Characters are free — a wallet signature creates one.

Two things to know:

- **The server allows 3 characters online per IP.** A fourth is refused. Either give accounts a
  `proxy` in `wallets.json` (each exit IP gets its own allowance), or turn on **⏳ Shifts** and the
  fleet rotates its online set through the day — the caps are daily, so time-slicing costs nothing.
  Accounts held back are marked `queued`, never `failed`.
- **Standing together pays.** Kindra rewards characters for gathering near other players, and your
  own fleet counts. The bot picks a dense node cluster, agrees on one skill, and commits to the walk
  — because per-node scoring alone will always prefer the tree underfoot to a better patch a
  half-minute away.

## Telegram

Everything is a button; the message is edited in place as you navigate, so the chat stays one living
dashboard instead of a wall of replies. Typed commands work too — both run through the same table, so
they cannot drift apart (`npm test` asserts it).

| | |
|---|---|
| **Fleet** | `/status` `/accounts` `/run` `/stop` `/new n` `/shifts` |
| **Character** | `/caps` `/quests` `/skills` `/bag` `/where` `/log` |
| **Activities** | `/boss` `/jobs` `/garden` `/upgrades` |
| **Actions** | `/sell` `/cook` `/food n` `/spin` `/claim` `/tend` |
| **Wallets** | `/wallets` — balances, primary, gas top-up, sweep |
| **On-chain** | `/kgold` `/cashout keep` |

Add an account name to target one: `/bag kindra-02`.

## Wallets and money

**Playing needs no gas at all.** Signing in is a signature, and selling gold on the in-game $KINDRA
book is escrowed server-side — a character can farm and cash out for its entire life on a zero
balance. Gas is only needed to *buy* on the book or to move tokens.

The `/wallets` panel gives you:

- ⭐ **Primary** — one wallet is the fleet's treasury. Sweeps land here; gas is paid out of here.
- ⛽ **Fund gas** — top up any character below the gas floor, from the primary.
- 🧹 **Sweep** — pull $KINDRA from every sub-account back to the primary.

Cashing out is `/cashout`: it lists your surplus gold on the in-game book just under the best live
ask so it actually clears, and the buyer's wallet pays yours in real ERC-20 **$KINDRA** directly.

### No referrals — and why the code refuses to add them

Kindra pays a referrer **500 gold + 200 on-chain $KINDRA** for every character that joins through
them and reaches account Lv 5. It is the best-looking income a fleet has. It is a trap.

This project tried it: one character was pushed to the Lv-10 referring gate and every new wallet was
minted naming it. Eleven of them reached Lv 5 and converted. Within hours **all eleven were banned
for a year — and so was the character that collected.** Referral payouts are visible to the operator,
and a cluster of accounts crediting one of their own from a single connection is the most legible
abuse pattern in the game.

So there is no referral code left in this bot. No `ref` is sent on any join, new character or old;
there is no setting that turns it back on; nothing is stamped on a minted wallet. If you want that
reward, refer real people from real accounts.

An account that does get banned is now recognised from the server's own refusal, written into the
wallet book with its expiry, and dropped from the rotation and from Telegram — so it stops burning
one of your three per-IP slots on a join that can only ever be refused.

## Layout

```
lib/
  auth.js         wallet sign-in          net.js        socket + reconnect
  state.js        live world mirror       movement.js   walk simulation
  gather.js       node selection          combat.js     survivability-first fighting
  economy.js      vendor vs market        crafting.js   cooking, crafting, potions
  quests.js       dailies and events      garden.js     8 plots that earn while away
  bosses.js       boss assist             jobs.js       the Trade Roads
  upgrades.js     tools worth buying
  orchestrator.js the brain               fleet.js      many accounts, one process
  chain.js        on-chain reads          treasury.js   primary, gas, sweep
  stealth.js      timing and identity     panels.js     the Telegram dashboard
tools/
  telegram-bot.js  main entry point       run.js        headless runner
  fetch-rules.js   game rule table        test-ui.js    asserts the panel is consistent
```

## Configuration

Everything lives in `.env` (see `.env.example`). The useful knobs:

| Variable | Default | What it does |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | required |
| `TELEGRAM_CHAT_ID` | *(first chat wins)* | lock the bot to one chat |
| `KINDRA_WORLD` | `valley` | `valley` (EU) or `us` |
| `KINDRA_AUTOSTART` | `0` | start farming when the service comes up |
| `KINDRA_MAX_PER_IP` | `3` | the server's own limit; lower it if you like |
| `KINDRA_GAS_TOPUP` | `0.001` | ETH sent per wallet by ⛽ Fund gas |
| `KINDRA_GOLD_RESERVE` | `300` | gold each character keeps; the rest is listed for $KINDRA |
| `KINDRA_CASHOUT_LOT` | `1000` | size of each auto cash-out lot (the book's minimum) |

## Safety

Private keys live in `.env` and `wallets.json`, both `chmod 600` and git-ignored. Nothing leaves your
machine except the sign-in signature the game itself asks for.

> ⚠️ **`wallets.json` is the only copy of your fleet's keys. Back it up.**

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">
<sub>Not affiliated with Kindra. Automating a game may be against its terms; use at your own risk.</sub>
</div>
