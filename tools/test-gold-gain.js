#!/usr/bin/env node
// test-gold-gain.js — does gold mode actually earn more COIN per minute, or just score differently?
//
// The scores the brain compares are gold-per-minute with experience folded in at an exchange rate.
// Gold mode lowers that rate, so of course every score moves — that proves nothing on its own. The
// question is whether the activity it then PICKS mints more actual gold. So this runs the real
// scorer over one realistic character in both modes, takes the winner, and re-prices that winner
// on coins alone: xp valued at zero, which is the only number a purse ever sees.
import { ensureRules } from '../lib/preflight.js';
ensureRules();
const { CFG } = await import('../lib/config.js');
const { Fleet } = await import('../lib/fleet.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

const fleet = new Fleet({ onLog: () => {} });
fleet.load();
// NOT the primary. load() puts the primary in chase mode by default -- it is the fleet's
// referrer-to-be -- and a chasing character deliberately ignores gold mode, so scoring that one
// would compare a mode against itself. This test caught exactly that mistake.
const bot = [...fleet.bots.values()].find((b) => !b.orch.chaseAccountLevel);
if (!bot) { console.log('no non-chasing account to score'); process.exit(0); }
console.log(`scoring ${bot.label} (chase mode: ${bot.orch.chaseAccountLevel ? 'on' : 'off'})`);

// A character mid-session, shaped like the server's own init.you: part-full satchel, goods worth
// selling, ripe garden plots, live nodes and a creature in reach. The state a real cycle sees.
bot.state.me = {
  id: 1, name: 'Probe', wallet: bot.address, tl: 6, x: 0, z: 0, hp: 100,
  gold: 900, kbal: 0, satchel: 'leather_satchel',
  skills: { woodcutting: 26100, mining: 21000, fishing: 620, cooking: 980, crafting: 310, foraging: 18400, combat: 12000 },
  inv: { log: 40, ore: 30, raw_amber: 12, gem: 3, cookedfish: 8 },
  tools: { mining: 'iron_pick', woodcutting: 'iron_axe' },
  owned: { hats: [], pets: [], weapons: ['iron_sword'], shields: ['iron_shield'], outfits: [], upgrades: [], mounts: [], pieces: [] },
  appearance: { skin: 2, hair: 3, shirt: 1, character: 'Knight', weapon: 'iron_sword', shield: 'iron_shield' },
  job: { jobXp: 240, jobLevel: 2, caravan: null, deliveries: 1, role: null, karma: 0 },
  haul: { combat: 0, combatCap: 2000, boss: 0, bossCap: 5000, vendor: 0, vendorCap: 1000, trade: 0, tradeCap: 2000, bounty: 0, bountyCap: 5, kart: 0, kartCap: 500 },
};
for (let i = 0; i < 40; i++) bot.state.nodes.set(i, { id: i, type: 'amber_deposit', x: i, z: 0, hitsLeft: 7, depleted: false, respawnAt: 0 });
bot.state.creatures.set(900, { id: 900, x: 3, z: 0, hp: 40, maxHp: 40, dead: false, kind: 'critter', level: 8 });
bot.garden.plots.set(0, { id: 0, seed: 'sunflower_seed', plantedAt: Date.now() - 900000, owner: 'Probe' });
bot.garden.plots.set(1, { id: 1, seed: 'sunflower_seed', plantedAt: Date.now() - 900000, owner: 'Probe' });
bot.garden.plots.set(2, { id: 2, seed: 'sunflower_seed', plantedAt: Date.now() - 900000, owner: 'Probe' });

const XP_RATE = 0.25;
// Re-price a score on coins alone. A score is (gold + xp*rate) per minute, so stripping the xp is
// exactly: score - (that score's xp share). We recover the xp share by scoring the same board with
// the rate at zero — the difference between the two IS the experience, whatever branch produced it.
function board(goldMode) {
  bot.orch.goldMode = goldMode;
  return bot.orch.scoreActivities();
}
function coinOnly(activity) {
  const saved = bot.orch.goldMode;
  bot.orch.goldMode = false;                        // normal rate
  const withXp = bot.orch.scoreActivities().find((r) => r.activity === activity)?.score ?? 0;
  bot.orch.goldMode = true;                         // rate 0.02
  const nearlyNone = bot.orch.scoreActivities().find((r) => r.activity === activity)?.score ?? 0;
  bot.orch.goldMode = saved;
  // score = gold + xp*rate. Two rates give two equations; solve for gold.
  const xpPerMin = (withXp - nearlyNone) / (XP_RATE - 0.02);
  return Math.max(0, withXp - xpPerMin * XP_RATE);
}

const normal = board(false), gold = board(true);
const nWin = normal[0], gWin = gold[0];

console.log('\nnormal mode, top of the board:');
for (const r of normal.slice(0, 4)) console.log(`  ${String(r.skill || r.activity).padEnd(18)} ${r.score.toFixed(0).padStart(6)}/min   ${r.why}`);
console.log('\ngold mode, top of the board:');
for (const r of gold.slice(0, 4)) console.log(`  ${String(r.skill || r.activity).padEnd(18)} ${r.score.toFixed(0).padStart(6)}/min   ${r.why}`);

const nCoin = coinOnly(nWin.activity), gCoin = coinOnly(gWin.activity);
console.log('\nre-priced on COIN ALONE (xp valued at zero — what the purse actually sees):');
console.log(`  normal mode picks ${nWin.skill || nWin.activity}: ${nCoin.toFixed(1)} gold/min`);
console.log(`  gold   mode picks ${gWin.skill || gWin.activity}: ${gCoin.toFixed(1)} gold/min`);
const delta = nCoin > 0 ? ((gCoin - nCoin) / nCoin * 100) : Infinity;
console.log(`  difference: ${gCoin >= nCoin ? '+' : ''}${delta.toFixed(0)}%`);

console.log('\nassertions:');
ok(gCoin >= nCoin, `gold mode's pick mints at least as much real coin (${gCoin.toFixed(1)} vs ${nCoin.toFixed(1)})`);
ok(gold.find((r) => r.activity === 'garden')?.score < normal.find((r) => r.activity === 'garden')?.score,
   'an xp-only activity is worth less under gold mode');
ok(Math.abs(coinOnly('sell') - (normal.find((r) => r.activity === 'sell')?.score ?? 0)) < 0.5,
   'a coin-only activity is priced identically in both — the rate never touches it');

// --- scenario two: the satchel is heavy with goods worth real money ----------
// The first scenario found gold mode changing the ORDER without changing the pick, because mining
// amber pays coin as well as xp and wins either way. That is an honest null result and worth
// keeping. Gold mode earns its name in the other case: when an xp-heavy activity is beating a
// coin-heavy one, which is exactly what kindra-01 spent 571 cycles doing.
console.log('\n--- with a satchel full of sellable goods ---');
bot.state.me.inv = { log: 90, ore: 80, raw_amber: 40, gem: 12, amber_pelt: 20, cookedfish: 8 };
const n2 = board(false), g2 = board(true);
console.log('  normal picks:', (n2[0].skill || n2[0].activity), n2[0].score.toFixed(0) + '/min  ·  ' + n2[0].why);
console.log('  gold   picks:', (g2[0].skill || g2[0].activity), g2[0].score.toFixed(0) + '/min  ·  ' + g2[0].why);
const n2coin = coinOnly(n2[0].activity), g2coin = coinOnly(g2[0].activity);
console.log(`  coin alone: normal ${n2coin.toFixed(1)}/min  ->  gold ${g2coin.toFixed(1)}/min` +
            (n2coin > 0 ? `  (${g2coin >= n2coin ? '+' : ''}${((g2coin - n2coin) / n2coin * 100).toFixed(0)}%)` : ''));
ok(g2coin >= n2coin, `gold mode never mints LESS coin than normal (${g2coin.toFixed(1)} vs ${n2coin.toFixed(1)})`);

// --- scenario three: the case gold mode exists for ---------------------------
// Nodes worked out, satchel light, garden ripe. Here the xp-only activity genuinely wins on normal
// pricing, and this is where the mode changes what the character does rather than only how the
// board is ordered.
console.log('\n--- nodes exhausted, satchel light, garden ripe ---');
bot.state.me.inv = { cookedfish: 8 };
for (const [id, n] of bot.state.nodes) bot.state.nodes.set(id, { ...n, depleted: true, respawnAt: Date.now() + 600000 });
bot.state.creatures.clear();
const n3 = board(false), g3 = board(true);
console.log('  normal picks:', (n3[0].skill || n3[0].activity), n3[0].score.toFixed(0) + '/min  ·  ' + n3[0].why);
console.log('  gold   picks:', (g3[0].skill || g3[0].activity), g3[0].score.toFixed(0) + '/min  ·  ' + g3[0].why);
const n3coin = coinOnly(n3[0].activity), g3coin = coinOnly(g3[0].activity);
console.log(`  coin alone: normal ${n3coin.toFixed(1)}/min  ->  gold ${g3coin.toFixed(1)}/min`);
ok(g3coin >= n3coin, `and here too it never mints less (${g3coin.toFixed(1)} vs ${n3coin.toFixed(1)})`);
console.log('\n  full board, normal:', n3.slice(0, 4).map((r) => `${r.skill || r.activity} ${r.score.toFixed(0)}`).join(' · '));
console.log('  full board, gold  :', g3.slice(0, 4).map((r) => `${r.skill || r.activity} ${r.score.toFixed(0)}`).join(' · '));

// --- which rock do the legs actually walk to? --------------------------------
// The brain choosing "go mining" is only half of it. pickNode decides WHICH node, and it used to
// decide on experience alone.
console.log('\n--- amber (7 swings, drops 9g amber) vs motherlode (34 swings, drops 2g ore) ---');
bot.state.nodes.clear();
bot.state.nodes.set(1, { id: 1, type: 'amber_deposit', x: 5, z: 0, hitsLeft: 7, depleted: false, respawnAt: 0 });
bot.state.nodes.set(2, { id: 2, type: 'motherlode', x: 5, z: 0, hitsLeft: 34, depleted: false, respawnAt: 0 });
bot.gather.rally = null;
const candidates = () => [...bot.state.nodes.values()];
bot.gather.goldMode = false;
const normalPick = bot.gather.pickNode('mining', candidates());
bot.gather.goldMode = true;
const goldPick = bot.gather.pickNode('mining', candidates());
console.log('  normal mode walks to:', normalPick?.type);
console.log('  gold   mode walks to:', goldPick?.type);
ok(goldPick?.type === 'amber_deposit', 'gold mode walks to the node whose drop is worth more');

// --- and back again ----------------------------------------------------------
console.log('\n--- switching gold mode OFF ---');
const fleet2 = new Fleet({ onLog: () => {} });
fleet2.saveRunState = () => {};
fleet2.bots = new Map([[bot.label, bot]]);
fleet2.setMode('gold');
ok(bot.orch.goldMode === true && bot.gather.goldMode === true, 'ON reaches both the brain and the legs');
const goldBoard = bot.orch.scoreActivities().map((r) => `${r.activity}:${r.score.toFixed(0)}`).join(' ');
fleet2.setMode('normal');
ok(bot.orch.goldMode === false && bot.gather.goldMode === false, 'OFF clears both');
const backBoard = bot.orch.scoreActivities().map((r) => `${r.activity}:${r.score.toFixed(0)}`).join(' ');
fleet2.setMode('gold'); fleet2.setMode('normal');
const twiceBoard = bot.orch.scoreActivities().map((r) => `${r.activity}:${r.score.toFixed(0)}`).join(' ');
ok(backBoard !== goldBoard, 'the board really does change back, not just the flag');
ok(backBoard === twiceBoard, 'and a second round trip lands on exactly the same board — no drift');
ok(bot.gather.pickNode('mining', candidates())?.type === normalPick?.type, 'the legs go back to their normal choice too');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
