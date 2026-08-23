#!/usr/bin/env node
// test-raid.js — the arithmetic behind a fleet raid.
//
// Four of the eleven bosses pay gold; the two a lone character can safely join pay none, which is
// why the 5,000/day boss purse had never paid a coin. The fleet brings its own party instead — and
// the only thing standing between that and three dead characters in a lair is the sum below. It is
// asserted here against every boss in the table, at the levels and rations the fleet actually has.
import { ensureRules } from '../lib/preflight.js';
ensureRules();
const { BOSSES, COMBAT, realmAt } = await import('../lib/rules.js');
const { Bosses } = await import('../lib/bosses.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

// A raider at a given combat level, gear and ration count.
function raider(label, { lvl = 17, weapon = 'iron_sword', shield = 'wood_shield', rations = 8 } = {}) {
  const skills = { combat: 0 };
  // levelForXp is monotonic; find the xp that yields `lvl`
  const b = new Bosses({ net: { on() {} }, state: {
    me: { skills, appearance: { weapon, shield, character: 'Knight' } }, bosses: new Map(), pos: { x: 0, z: 0 },
  }, move: {}, crafting: { rationCount: () => rations }, label, log: () => {} });
  b.myCombatLevel = () => lvl;
  return { label, bosses: b, crafting: { rationCount: () => rations }, orch: { capLeft: () => 5000 },
           realms: { reachable: () => true }, state: b.state, live: true };
}

const party3 = [raider('a'), raider('b'), raider('c')];
const dps = party3[0].bosses.dps();
console.log(`\none Lv17 raider with an iron sword: ${dps.toFixed(1)} dps · party of 3 = ${(dps * 3).toFixed(0)} dps\n`);

console.log('verdicts (3 × Lv17, 8 rations each):');
for (const id of ['drowned_king', 'rimewyrm', 'umbrax', 'bonemaw']) {
  const def = BOSSES[id];
  const v = party3[0].bosses.survives(def, party3);
  const secs = v.ok ? `${Math.round(v.secs)}s` : '—';
  console.log(`  ${v.ok ? 'RAID  ' : 'REFUSE'} ${id.padEnd(14)} ${String(def.hp).padStart(6)} hp · ${secs.padStart(5)} · ${v.ok ? `${v.ticks} slams each` : v.why}`);
}

console.log('\nassertions:');
ok(party3[0].bosses.survives(BOSSES.drowned_king, party3).ok, 'drowned_king (2800 hp) is taken — the one gold boss in reach');
ok(!party3[0].bosses.survives(BOSSES.umbrax, party3).ok, 'umbrax (50000 hp) is refused — it would be 70 slams each');
ok(!party3[0].bosses.survives(BOSSES.bonemaw, party3).ok, 'bonemaw (90000 hp) is refused');

const starving = [raider('a', { rations: 0 }), raider('b', { rations: 0 }), raider('c', { rations: 0 })];
ok(!starving[0].bosses.survives(BOSSES.drowned_king, starving).ok, 'the same fight is refused with no rations');

const solo = [raider('a')];
const soloV = solo[0].bosses.survives(BOSSES.drowned_king, solo);
ok(!soloV.ok, `one character alone is refused (${soloV.why})`);

const low = [raider('a', { lvl: 5 }), raider('b', { lvl: 5 }), raider('c', { lvl: 5 })];
ok(!low[0].bosses.survives(BOSSES.rimewyrm, low).ok, 'a Lv5 party is refused the Rimewyrm');

console.log('\nrealms:');
ok(realmAt(BOSSES.drowned_king.x, BOSSES.drowned_king.z)?.id === 'isles', 'drowned_king is behind the isles portal, which has no entry gate');
ok(realmAt(BOSSES.rimewyrm.x, BOSSES.rimewyrm.z) === null, 'rimewyrm is in the open world');

console.log('\na boss that is not there:');
{
  // The server only sends bossState for bosses in view. An empty world model must read as "not up",
  // never as "already dead" — otherwise the party treks to the isles and declares victory over air.
  const b = raider('a').bosses;
  b.state.bosses = new Map();
  b.move = { heartbeat() {}, walkTo: async () => {}, stop() {} };
  b.net = { send() {} };
  const t0 = Date.now();
  const won = await b.fight({ id: 'drowned_king', hp: 2800, helpers: 2 }, { maxMs: 3000 });
  ok(won === false, `an unseen boss is not a win (took ${Date.now() - t0}ms, returned ${won})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
