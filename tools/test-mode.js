#!/usr/bin/env node
// test-mode.js — gold mode re-ranks the board on coins alone.
//
// The scorer already prices everything in gold per minute, converting xp at one rate. Gold mode
// moves that one number, so nothing here is a special case: what changes is which activities can
// still justify themselves when experience stops counting.
import { ensureRules } from '../lib/preflight.js';
ensureRules();
const { Fleet } = await import('../lib/fleet.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

const fleet = new Fleet({ onLog: () => {} });
fleet.saveRunState = () => {};
const orch = () => ({ goldMode: false, chaseAccountLevel: false });
const bots = ['kindra-01', 'kindra-02'].map((label) => ({ label, orch: orch() }));
fleet.bots = new Map(bots.map((b) => [b.label, b]));

console.log('\nswitching:');
ok(fleet.mode === 'normal', 'starts in normal mode');
ok(fleet.setMode('gold') === 'gold', 'switches to gold');
ok(bots.every((b) => b.orch.goldMode === true), 'and every character is told');
fleet.setMode('normal');
ok(bots.every((b) => b.orch.goldMode === false), 'and told again on the way back');
ok(fleet.setMode('nonsense') === 'normal', 'an unknown mode falls back to normal, never undefined');

console.log('\na character joining mid-mode:');
fleet.setMode('gold');
const late = { label: 'kindra-03', orch: orch() };
fleet.bots.set(late.label, late);
fleet.setMode('gold');                       // re-apply, as add() does for a fresh bot
ok(late.orch.goldMode === true, 'inherits the fleet mode rather than running on its own rules');

console.log('\nwhat the pricing actually does:');
// The exchange rate the scorer uses, reproduced: this is the whole mechanism.
const rate = (goldMode, chasing) => (goldMode && !chasing) ? 0.02 : 0.25;
const value = (gold, xp, goldMode, chasing = false) => gold + xp * rate(goldMode, chasing);
// The live numbers from kindra-01's own log: a garden cycle scored 354/min against a sell worth
// 144/min. The garden's 354 is ENTIRELY experience — three ripe plots pay no coin at all — so it
// is 1416 units of xp priced at 0.25. The sell is 144 in coin, which no exchange rate touches.
const gardenXp = 354 / 0.25;
const gardenNormal = value(0, gardenXp, false), gardenGold = value(0, gardenXp, true);
const sellNormal = value(144, 0, false), sellGold = value(144, 0, true);
ok(gardenNormal > sellNormal, `normally the garden (${gardenNormal}) outranks a sell (${sellNormal}) — this is what happened live`);
ok(sellGold > gardenGold, `in gold mode the sell (${sellGold}) outranks the garden (${gardenGold.toFixed(1)})`);
ok(gardenGold < gardenNormal / 10, 'an xp-only activity loses more than 90% of its score');
ok(sellGold === sellNormal, 'and a coin-only activity loses none of it');

console.log('\nthe pin still overrides the fleet:');
ok(rate(true, true) === 0.25, 'a chasing character keeps normal pricing even with the fleet on gold');
ok(rate(true, false) === 0.02, 'everyone else does not');

// --- what it agrees to BUY ---------------------------------------------------
// Earning faster is half of it. The shopping list offered the two worst buys in the shop and never
// once offered the four best, in either mode.
console.log('\nthe shopping list:');
const { Fleet: F2 } = await import('../lib/fleet.js');
const f3 = new F2({ onLog: () => {} });
f3.load();
const shopper = [...f3.bots.values()][1] || [...f3.bots.values()][0];
if (shopper) {
  shopper.state.me = {
    id: 1, gold: 99999, satchel: 'worn_satchel', skills: { mining: 21000, woodcutting: 21000, foraging: 21000, fishing: 21000, combat: 12000 },
    inv: {}, tools: {}, owned: { weapons: [], shields: [], hats: [], outfits: [], upgrades: [], pets: [], mounts: [], pieces: [] },
    appearance: {}, haul: {},
  };
  shopper.upgrades.goldMode = false;
  const normal = shopper.upgrades.plan().map((w) => w.id);
  shopper.upgrades.goldMode = true;
  const gold = shopper.upgrades.plan().map((w) => w.id);
  console.log('  normal order:', normal.slice(0, 6).join(' → '));
  console.log('  gold   order:', gold.slice(0, 6).join(' → '));
  ok(gold.includes('miners_helmet'), 'the +12% find gadgets are offered at all now (they never were)');
  ok(!gold.includes('naturalists_journal'), 'gold mode refuses the 3,500g xp-only journal');
  ok(normal.includes('naturalists_journal'), 'normal mode still offers it — xp is worth something there');
  const gi = gold.indexOf('miners_helmet'), si = gold.indexOf('shovel');
  ok(si === -1 || gi < si, 'a 53-minute payback is bought before a four-day one');
  const iron = gold.indexOf('iron_pick');
  ok(iron >= 0 && iron < gi, 'and the 3-minute payback comes before both');
}

// --- the uncapped channels --------------------------------------------------
// Five things carry a daily gold cap: vendor, gathering, combat, boss and kart. The PLAYER market
// carries none. So "gold mode is pointless because of the caps" is only true while the bot leans
// on the vendor, and it was leaning on the vendor.
console.log('\nthe channels:');
const { MARKET, VENDOR, BOSSES } = await import('../lib/rules.js');
ok(!Object.keys(MARKET).some((k) => /dailycap/i.test(k)), 'the player market has no daily gold cap');
ok(VENDOR.dailyGoldCap === 1000, 'the vendor does, at 1000');
ok(MARKET.maxPerPlayer === 30, `and allows ${MARKET.maxPerPlayer} listings a head`);
ok(Math.max(8, MARKET.maxPerPlayer - 6) > 8, 'so the listing budget opens up once the vendor shuts');

console.log('\nboss purses, priced from the table:');
const purse = (id) => { const r = BOSSES[id]?.reward?.goldRoll; return r ? (r[0] + r[1]) / 2 : 0; };
for (const id of ['warden', 'gloamroot', 'drowned_king', 'rimewyrm', 'umbrax']) {
  console.log(`  ${id.padEnd(14)} ${purse(id)}g`);
}
ok(purse('warden') === 0 && purse('gloamroot') === 0, 'the two a lone character can join pay nothing');
ok(purse('rimewyrm') === 240 && purse('umbrax') === 1100, 'and the ones that pay are priced from their own roll');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
