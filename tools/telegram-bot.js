#!/usr/bin/env node
// telegram-bot.js — the control surface entry point.
//
// Every screen lives in lib/panels.js so it can be rendered and asserted offline by
// tools/test-ui.js. This file only wires the fleet, the routes and the notifications together.
import { ensureRules } from '../lib/preflight.js';

// Node resolves the entire STATIC import graph before the first statement executes, so a preflight
// check can never guard a statically-imported module — the missing rule table would surface as an
// ERR_MODULE_NOT_FOUND on a path nobody recognises. Everything downstream of lib/rules.js is
// therefore loaded dynamically, after the check has had a chance to explain itself.
ensureRules();

const { CFG } = await import('../lib/config.js');
const { Fleet } = await import('../lib/fleet.js');
const { Telegram } = await import('../lib/telegram.js');
const { buildRoutes } = await import('../lib/panels.js');
const { E, esc, statusDot, activityLabel } = await import('../lib/ui.js');
if (!CFG.telegramToken) {
  console.error('TELEGRAM_BOT_TOKEN is not set — put it in .env (get one from @BotFather).');
  process.exit(1);
}

const tg = new Telegram({ token: CFG.telegramToken, chatId: CFG.telegramChatId });
const fleet = new Fleet({ onLog: (l) => console.log(l) });
fleet.load();

const { ROUTES } = buildRoutes({ fleet, tg, world: CFG.world });

// One table drives BOTH the typed commands and the inline buttons, so the two can never disagree.
for (const [name, fn] of Object.entries(ROUTES)) {
  tg.onCallback(name, (args) => fn(args));
  tg.on(`/${name}`, (args) => fn(args));
}
tg.on('/start', () => ROUTES.home([]));
tg.on('/menu', () => ROUTES.home([]));

// --- notifications -------------------------------------------------------
// Only things worth interrupting someone for, and never the same thing twice in a row. A bot that
// pings on every gather trains you to ignore it, which means you also miss the one that mattered.
const lastSent = new Map();
function notify(key, text, { minGapMs = 60000 } = {}) {
  const now = Date.now();
  if (now - (lastSent.get(key) || 0) < minGapMs) return;
  lastSent.set(key, now);
  tg.send(text).catch(() => {});
}

function wire(b) {
  const who = () => esc(b.state.me?.name || b.label);

  // Progress you can watch. The bot works quietly for hours, and silence is indistinguishable from
  // being stuck — so the events that mean "something moved" get reported even though none of them
  // is urgent on its own.
  b.on('log', (line) => {
    const m = /\[(gather|combat|econ|orch|quest|upgrade|kgold)\]\s(.*)$/.exec(line);
    if (!m) return;
    const [, tag, rest] = m;

    if (tag === 'upgrade' && /bought/.test(rest)) {
      notify(`up:${b.label}:${rest.slice(0, 24)}`, `${E.shop} *${who()}* ${esc(rest)}`, { minGapMs: 0 });
    }
    if (tag === 'econ' && /filled a buy order/.test(rest)) {
      notify(`bo:${b.label}:${Date.now()}`, `${E.sell} *${who()}* ${esc(rest)}`, { minGapMs: 0 });
    }
    if (tag === 'econ' && /vendor: /.test(rest)) {
      notify(`sold:${b.label}`, `${E.sell} *${who()}* ${esc(rest)}`, { minGapMs: 900000 });
    }
    if (tag === 'orch' && /account Lv \d+ reached/.test(rest)) {
      notify(`gate:${b.label}`, `🎯 *${who()}* ${esc(rest)}`, { minGapMs: 0 });
    }
    if (tag === 'quest' && /LEVELUP/.test(rest)) return;   // covered by the milestone handler
  });

  // Skill level-ups are deliberately NOT announced. Fifty characters levelling eleven skills each
  // is a message every few seconds, and a chat that never stops is a chat nobody reads — the one
  // notification that mattered gets buried under "foraging Lv 12". The panel shows every level on
  // demand; nothing here needs to interrupt.

  b.on('rejected', (m) => {
    if (b.banned) return;   // the ban handler below says it properly, once, and says what it means
    notify(`reject:${b.label}`,
      `${E.dead} *${esc(b.label)}* was refused entry\n${esc(m?.reason || JSON.stringify(m))}`, { minGapMs: 300000 });
  });

  // The one notification worth keeping loud. An account is gone for about a year, the fleet is
  // permanently one character smaller, and nothing else in the chat would ever tell you.
  b.on('banned', (x) => notify(`ban:${b.label}`,
    `🚫 *${esc(b.label)}* is BANNED for ~${Math.round(x.hours / 24)} days.\nIt has been taken out of the rotation permanently — no slot will be spent on it again.`, { minGapMs: 0 }));

  // Says what happens, not what we wish happened. Measured over 135 deaths: 25 sacks recovered,
  // 134 corpse runs that ended in a NaN distance. Promising automatic recovery was wrong three
  // times in four, and a notification that lies is worse than no notification.
  b.state.on('death', () => notify(`death:${b.label}`,
    `☠️ *${who()}* died — gear and gold are safe, the satchel spilled into a sack that expires in 30 min. A corpse run is attempted; it does not always get there.`, { minGapMs: 120000 }));

  // A spent cap means the brain has rotated away from a whole income source.
  b.state.on('haul', (h) => {
    for (const k of ['combat', 'boss', 'vendor', 'trade']) {
      if (h[`${k}Cap`] && h[k] >= h[`${k}Cap`]) {
        notify(`cap:${b.label}:${k}:${new Date().toDateString()}`,
          `${E.cap} *${who()}* maxed the daily *${k}* gold cap (${h[k]}/${h[`${k}Cap`]}).`, { minGapMs: 3600000 });
      }
    }
  });

  // Real money moving.
  b.net.on('kgoldDone', (m) => notify(`kgold:${b.label}:${Date.now()}`,
    `${E.token} *${who()}* — a $KINDRA order settled.\n\`${esc(JSON.stringify(m).slice(0, 300))}\``, { minGapMs: 0 }));
  b.net.on('bossSpoils', () => notify(`spoils:${b.label}`,
    `${E.boss} *${who()}* took a share of boss spoils.`, { minGapMs: 120000 }));

  // A closed socket is NOT announced. Rotation disconnects characters every shift by design, so
  // "went offline" fired on healthy behaviour and said nothing about a real fault. What a genuine
  // fault looks like is a refused join, which is reported just above, and a flat gold line in the
  // pulse digest.
}
for (const b of fleet.bots.values()) wire(b);
const origAdd = fleet.add.bind(fleet);
fleet.add = (entry) => { const b = origAdd(entry); if (!b.__wired) { b.__wired = true; wire(b); } return b; };

// --- pulse ---------------------------------------------------------------
// One compact digest on a timer. Event notifications alone leave long silences during a normal
// grind, and a chat that says nothing for two hours reads as a bot that died.
const PULSE_MS = Number(process.env.KINDRA_PULSE_MIN || 25) * 60_000;
let lastPulse = null;

function pulse() {
  const live = [...fleet.bots.values()].filter((x) => x.live);
  if (!live.length) return;
  const t = fleet.totals();
  const prev = lastPulse;
  lastPulse = { gold: t.gold, kills: t.kills, quests: t.quests, at: Date.now() };
  if (!prev) return;   // first tick establishes the baseline

  const mins = Math.max(1, (lastPulse.at - prev.at) / 60000);
  const dGold = t.gold - prev.gold;
  const lines = live.map((x) => {
    const me = x.state.me;
    return `${statusDot(x.status)} ${esc(me?.name || x.label).padEnd(12).slice(0, 12)} ${String(me?.gold ?? 0).padStart(6)}g  ${activityLabel(x.orch.current)}`;
  });

  const chasing = live.find((x) => x.orch.chasing);
  tg.send([
    `${E.brand} *${live.length} in the valley* · last ${Math.round(mins)}m`,
    '```',
    ...lines,
    '```',
    `${E.gold} ${dGold >= 0 ? '+' : ''}${dGold}g this window (${Math.round(dGold / mins * 60)}/h) · ${E.combat} +${t.kills - prev.kills} kills · ${E.quest} +${t.quests - prev.quests} quests`,
    chasing ? `🎯 ${esc(chasing.state.me?.name || chasing.label)} chasing account Lv 10 — ${chasing.orch.chaseProgress().pct.toFixed(1)}%` : '',
    fleet.shiftsOn ? `${E.clock} next shift in ${Math.round(fleet.nextShiftIn() / 60000)}m` : '',
  ].filter(Boolean).join('\n')).catch(() => {});
}
setInterval(pulse, PULSE_MS);
setTimeout(pulse, 30_000);   // establish the baseline shortly after startup

// A shift change swaps the whole online set — worth saying, since the panel would otherwise show
// three completely different characters with no explanation.
const origShifts = fleet.startShifts.bind(fleet);
fleet.startShifts = (opts) => {
  const r = origShifts(opts);
  notify('shifts:on', `${E.clock} Shift rotation on — swapping the online set every ${Math.round((opts?.everyMs || 45 * 60000) / 60000)} min.`, { minGapMs: 0 });
  return r;
};

process.on('SIGINT', () => { fleet.disconnectAll(); tg.stop(); process.exit(0); });
process.on('SIGTERM', () => { fleet.disconnectAll(); tg.stop(); process.exit(0); });

// The ☰ menu next to the text box. Without registering these the user has to know to type /start
// before anything at all appears.
//
// NEVER fatal. This is a cosmetic registration, but it was a bare top-level await: one connect
// timeout to api.telegram.org took the whole process down before a single character joined, and
// systemd restarted it into the same timeout four times over. A menu is not worth 24 accounts.
await tg.setCommands([
  ['start', '🌿 open the control panel'],
  ['status', '📊 fleet overview'],
  ['accounts', '🌰 list characters'],
  ['run', '▶️ start farming'],
  ['stop', '⏹ stop farming'],
  ['shifts', '⏳ rotate characters past the 3-per-IP limit'],
  ['new', '➕ mint a new character'],
  ['wallets', '🪺 balances, primary, gas and sweep'],
  ['kgold', '🪙 sell gold for real $KINDRA'],
  ['cashout', '💱 list surplus gold on the book'],
  ['caps', '🫙 daily gold caps left'],
  ['quests', '📜 quest board'],
  ['boss', '🐲 boss status'],
  ['jobs', '🐴 trade roads'],
  ['garden', '🌻 garden plots'],
  ['upgrades', '🛒 tools worth buying'],
  ['bag', '🎒 satchel contents'],
  ['sell', '🧺 liquidate now'],
  ['log', '📓 recent activity'],
  ['help', '❓ every command'],
]).catch((e) => console.error('[kindra] could not register the ☰ menu (carrying on):', e.message));

console.log(`[kindra] ${fleet.size} account(s) loaded. Telegram control starting…`);
// Come back up doing whatever we were doing. A deploy, a reboot or a crash otherwise leaves every
// character parked until somebody notices and presses Start all again — which is exactly what
// happened during this session's own restart.
if (process.env.KINDRA_AUTOSTART === '0') {
  console.log('[kindra] autostart disabled (KINDRA_AUTOSTART=0)');
} else {
  fleet.resume().then((r) => { if (r) console.log('[kindra] resumed previous run state'); })
                .catch((e) => console.error('[kindra] resume failed:', e.message));
}
await tg.start();
