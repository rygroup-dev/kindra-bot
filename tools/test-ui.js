#!/usr/bin/env node
// test-ui.js — renders every Telegram panel and asserts the UI is internally consistent.
//
// The bot is driven entirely from a phone, so a dead button is a dead feature. Two passes:
//
//   OFFLINE — panels rendered against a fleet that is loaded but not connected. Exercises the
//             "no character yet" branches.
//   LIVE    — panels rendered against a fleet hydrated with a realistic in-game state. This is the
//             pass that matters: the offline pass never touches the code that formats gold, caps,
//             quests, skills or inventory, which is most of what the panel actually shows.
//
// Both check: every panel renders, every button resolves to a real route, nothing exceeds
// Telegram's message limit, and Markdown entities are balanced (one stray * mangles the message).
import { ensureRules } from '../lib/preflight.js';
ensureRules();

const { CFG } = await import('../lib/config.js');
const { Fleet } = await import('../lib/fleet.js');
const { Telegram } = await import('../lib/telegram.js');
const { buildRoutes } = await import('../lib/panels.js');

const fleet = new Fleet({ onLog: () => {} });
fleet.load();
const tg = new Telegram({ token: 'test', chatId: '0', onLog: () => {} });
tg.send = async () => {};
const { ROUTES } = buildRoutes({ fleet, tg, world: CFG.world });

// A character mid-session: levelled unevenly, satchel part full, one cap spent, quests in progress.
// Shaped like the server's own `init.you` so the panels take their real branches.
function hydrate(bot) {
  bot.state.me = {
    id: 133, name: 'Dainfield', wallet: bot.address, tl: 11, x: -37.4, z: -73.2, hp: 64,
    gold: 4213, kbal: 12.5, satchel: 'leather_satchel',
    skills: { woodcutting: 26_100, mining: 1_450, fishing: 620, cooking: 980, crafting: 310, foraging: 18_400, combat: 7_250 },
    inv: { log: 61, ore: 24, herb: 12, ancient_log: 2, gem: 4, cookedfish: 6, health_potion: 1, torn_map: 1 },
    tools: { woodcutting: 'iron_axe', foraging: 'iron_sickle' },
    owned: { hats: [], pets: [], weapons: [], shields: [], outfits: [], upgrades: [], mounts: [], pieces: [] },
    appearance: { skin: 2, hair: 3, shirt: 1, character: 'Rogue', hat: null, pet: null, weapon: null, shield: null, outfit: null, mount: null },
    job: { jobXp: 240, jobLevel: 2, caravan: null, deliveries: 1, role: null, karma: 0 },
    haul: { combat: 2000, combatCap: 2000, boss: 0, bossCap: 5000, vendor: 640, vendorCap: 1000, trade: 0, tradeCap: 2000, bounty: 1, bountyCap: 5, kart: 0, kartCap: 500 },
  };
  bot.state.haul = bot.state.me.haul;
  bot.state.quests = [
    { id: 'chop', label: 'Chop 15 Logs', need: 15, gold: 20, xp: 80, prog: 15, claimed: false },
    { id: 'cook', label: 'Cook 6 Meals', need: 6, gold: 25, xp: 90, prog: 2, claimed: false },
    { id: 'craft', label: 'Craft 8 Goods', need: 8, gold: 25, xp: 90, prog: 8, claimed: true },
  ];
  bot.state.marketPrices = { log: 2, ore: 1, herb: 2, ancient_log: 2, gem: 6, cookedfish: 1 };
  bot.state.market = [{ id: 1, item: 'ancient_log', qty: 1, price: 81, kind: 'item', cur: 'gold' }];
  bot.state.nodes.set(1, { id: 1, type: 'tree', x: -37, z: -73, hitsLeft: 4, depleted: false, respawnAt: 0 });
  bot.state.creatures.set(2, { id: 2, x: -30, z: -70, hp: 32, maxHp: 32, dead: false, kind: 'critter', level: 2 });
  bot.state.bosses.set('warden', { id: 'warden', x: -82, z: -8, hp: 640, maxHp: 900, alive: true });
  bot.orch.baseline = { at: Date.now() - 42 * 60_000, gold: 900, kbal: 0, skills: {}, totalXp: 12_000 };
  bot.orch.current = 'gather:woodcutting';
  bot.orch.cycle = 17;
  bot.status = 'running';
  bot.net.ready = true;     // makes bot.live true, which is what the panels branch on
  bot.referral.status = { pending: 3, converted: 1, claimable: 200 };
  bot.garden.plots.set(0, { id: 0, seed: 'sunflower_seed', plantedAt: Date.now() - 800_000, owner: 'Dainfield' });
  return bot;
}

const first = [...fleet.bots.values()][0];
const SCREENS = [
  ['home', []], ['help', []], ['fleet', []], ['newmenu', []], ['newclass', ['3']], ['newclass', ['10']], ['newpick', ['5']], ['accounts', []], ['status', []],
  ['acct', [first?.label]], ['caps', [first?.label]], ['bag', [first?.label]], ['quests', [first?.label]],
  ['skills', [first?.label]], ['where', [first?.label]], ['log', [first?.label]],
  ['upgrades', [first?.label]], ['boss', [first?.label]], ['jobs', [first?.label]], ['garden', [first?.label]], ['realms', [first?.label]],
];

let fail = 0, checked = 0;

async function pass(name) {
  console.log(`\n── ${name} ──`);
  for (const [route, args] of SCREENS) {
    const fn = ROUTES[route];
    if (!fn) { console.log(`✗ ${route}: no such route`); fail++; continue; }
    let out;
    try { out = await fn(args); }
    catch (e) { console.log(`✗ ${route}: threw ${e.message}`); fail++; continue; }

    const text = typeof out === 'string' ? out : out?.text;
    const kb = typeof out === 'object' ? out?.keyboard : null;
    if (!text) { console.log(`✗ ${route}: rendered nothing`); fail++; continue; }
    if (text.length > 4000) { console.log(`✗ ${route}: ${text.length} chars exceeds Telegram's limit`); fail++; }
    if (/undefined|NaN|\[object Object\]/.test(text)) {
      console.log(`✗ ${route}: renders a placeholder value — ${text.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,20}/)?.[0]}`);
      fail++;
    }
    for (const [ch, label] of [['`', 'backtick'], ['*', 'asterisk']]) {
      const n = (text.match(new RegExp('\\' + ch, 'g')) || []).length;
      if (n % 2 !== 0) { console.log(`✗ ${route}: odd number of ${label}s (${n}) — Markdown will mangle`); fail++; }
    }
    for (const row of kb?.inline_keyboard || []) {
      for (const btn of row) {
        if (btn.url) continue;
        const target = String(btn.callback_data).split(':')[0];
        if (!ROUTES[target]) { console.log(`✗ ${route}: button "${btn.text}" points at missing route "${target}"`); fail++; }
        if (btn.callback_data.length > 64) { console.log(`✗ ${route}: callback_data too long for "${btn.text}"`); fail++; }
        checked++;
      }
    }
    console.log(`✓ ${route.padEnd(10)} ${String(text.length).padStart(4)} chars, ${(kb?.inline_keyboard || []).flat().length} buttons`);
  }
}

await pass('offline: no character joined yet');
if (first) { hydrate(first); await pass('live: character mid-session'); }
else console.log('\n(no accounts in wallets.json — live pass skipped)');

console.log(`\n${checked} buttons verified`);
console.log(fail === 0 ? '✅ UI consistent — no dead buttons, no broken markdown, no placeholder values'
                       : `❌ ${fail} problem(s)`);
process.exit(fail === 0 ? 0 : 1);
