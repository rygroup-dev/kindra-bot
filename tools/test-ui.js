#!/usr/bin/env node
// test-ui.js — renders every Telegram panel offline and asserts the UI is internally consistent.
//
// The bot is driven entirely from a phone, so a dead button is a dead feature. This checks:
//   1. every panel renders without throwing, on a fleet that is loaded but NOT connected
//   2. every button's callback_data resolves to a real route
//   3. no message exceeds Telegram's limit
//   4. Markdown entities are balanced (an odd * or ` silently mangles the whole message)
import { CFG } from '../lib/config.js';
import { Fleet } from '../lib/fleet.js';
import { Telegram } from '../lib/telegram.js';
import { buildRoutes } from '../lib/panels.js';

const fleet = new Fleet({ onLog: () => {} });
fleet.load();
const tg = new Telegram({ token: 'test', chatId: '0', onLog: () => {} });
tg.send = async () => {};
const { ROUTES } = buildRoutes({ fleet, tg, world: CFG.world });

const first = [...fleet.bots.values()][0]?.label || 'kindra-01';
// Read-only panels only — the mutating routes (sell, run, cashout…) would hit the live server.
const SCREENS = [
  ['home', []], ['help', []], ['fleet', []], ['newmenu', []],
  ['acct', [first]], ['caps', [first]], ['bag', [first]], ['quests', [first]],
  ['skills', [first]], ['where', [first]], ['log', [first]], ['accounts', []], ['status', []],
  ['upgrades', [first]], ['boss', [first]], ['jobs', [first]], ['garden', [first]],
];

let fail = 0, checked = 0;
const seenButtons = new Set();

for (const [name, args] of SCREENS) {
  const fn = ROUTES[name];
  if (!fn) { console.log(`✗ ${name}: no such route`); fail++; continue; }
  let out;
  try { out = await fn(args); }
  catch (e) { console.log(`✗ ${name}: threw ${e.message}`); fail++; continue; }

  const text = typeof out === 'string' ? out : out?.text;
  const kb = typeof out === 'object' ? out?.keyboard : null;
  if (!text) { console.log(`✗ ${name}: rendered nothing`); fail++; continue; }
  if (text.length > 4000) { console.log(`✗ ${name}: ${text.length} chars exceeds Telegram's limit`); fail++; }

  // Unbalanced Markdown breaks the whole message, not just the run it opens.
  for (const [ch, label] of [['`', 'backtick'], ['*', 'asterisk']]) {
    const n = (text.match(new RegExp('\\' + ch, 'g')) || []).length;
    if (n % 2 !== 0) { console.log(`✗ ${name}: odd number of ${label}s (${n}) — Markdown will mangle`); fail++; }
  }

  for (const row of kb?.inline_keyboard || []) {
    for (const btn of row) {
      if (btn.url) continue;
      const route = String(btn.callback_data).split(':')[0];
      seenButtons.add(`${name} → ${btn.text} [${route}]`);
      if (!ROUTES[route]) { console.log(`✗ ${name}: button "${btn.text}" points at missing route "${route}"`); fail++; }
      if (btn.callback_data.length > 64) { console.log(`✗ ${name}: callback_data too long for "${btn.text}"`); fail++; }
      checked++;
    }
  }
  console.log(`✓ ${name.padEnd(10)} ${String(text.length).padStart(4)} chars, ${(kb?.inline_keyboard || []).flat().length} buttons`);
}

// Every route should be reachable by a button or documented as a command.
const unreachable = Object.keys(ROUTES).filter((r) => ![...seenButtons].some((b) => b.endsWith(`[${r}]`)));
console.log(`\n${checked} buttons verified across ${SCREENS.length} screens`);
if (unreachable.length) console.log(`ℹ️  command-only routes (no button): ${unreachable.join(', ')}`);
console.log(fail === 0 ? '\n✅ UI consistent — no dead buttons, no broken markdown' : `\n❌ ${fail} problem(s)`);
process.exit(fail === 0 ? 0 : 1);
