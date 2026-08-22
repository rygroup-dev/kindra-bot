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
const { E, SKILL_ICON, esc } = await import('../lib/ui.js');
// Not imported from lib/rules.js on purpose: static imports are hoisted above ensureRules(), so
// pulling the rule table in here would bypass the preflight and fail with ERR_MODULE_NOT_FOUND
// instead of the instructions. It is a stable game constant.
const REFERRAL_MIN_LV = 10;

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

  // Skill milestones only — every level would be constant noise at low levels.
  b.on('levelup', (m) => {
    if (!m?.skill || !m.level) return;
    if (m.level % 10 !== 0 && m.level < 5) return;
    if (m.level % 5 !== 0) return;
    notify(`lvl:${b.label}:${m.skill}:${m.level}`,
      `${SKILL_ICON[m.skill] || E.up} *${who()}* — ${esc(m.skill)} **Lv ${m.level}**`, { minGapMs: 0 });
  });

  b.on('rejected', (m) => notify(`reject:${b.label}`,
    `${E.dead} *${esc(b.label)}* was refused entry\n${esc(m?.reason || JSON.stringify(m))}`, { minGapMs: 300000 }));

  b.state.on('death', () => notify(`death:${b.label}`,
    `☠️ *${who()}* died — the loot sack will be recovered automatically (it expires in 30 min).`, { minGapMs: 120000 }));

  // Account level gates the referral reward, so crossing Lv 10 is genuinely worth knowing.
  let lastTl = 0;
  b.state.on('inv', () => {
    const tl = b.state.me?.tl || 0;
    if (tl > lastTl) {
      lastTl = tl;
      if (tl === REFERRAL_MIN_LV) {
        notify(`ref:${b.label}`, `🤝 *${who()}* reached account Lv ${tl} — this character can now refer new ones (500g + 200 $KINDRA each).`, { minGapMs: 0 });
      }
    }
  });

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

  // Something is wrong and farming has stopped.
  b.net.on('closed', () => notify(`off:${b.label}`,
    `${E.off} *${esc(b.label)}* went offline.`, { minGapMs: 600000 }));
}
for (const b of fleet.bots.values()) wire(b);
const origAdd = fleet.add.bind(fleet);
fleet.add = (entry) => { const b = origAdd(entry); if (!b.__wired) { b.__wired = true; wire(b); } return b; };

process.on('SIGINT', () => { fleet.disconnectAll(); tg.stop(); process.exit(0); });
process.on('SIGTERM', () => { fleet.disconnectAll(); tg.stop(); process.exit(0); });

// The ☰ menu next to the text box. Without registering these the user has to know to type /start
// before anything at all appears.
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
]);

console.log(`[kindra] ${fleet.size} account(s) loaded. Telegram control starting…`);
if (process.env.KINDRA_AUTOSTART === '1') fleet.startAll().catch((e) => console.error(e));
await tg.start();
