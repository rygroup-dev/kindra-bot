#!/usr/bin/env node
// test-rest.js — resting has to notice it is being hit.
//
// 32 of this fleet's 135 deaths happened during `recovering before next activity` — the single
// largest cause, more than double any monster in the table, and every one at 44-56 hp immediately
// after a fight the character had just WON. The rest loop watched hp go UP and had no branch at all
// for hp going DOWN, so anything still swinging got forty-five uninterrupted seconds.
import { ensureRules } from '../lib/preflight.js';
ensureRules();
const { Combat } = await import('../lib/combat.js');
const { COMBAT } = await import('../lib/rules.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

// A character whose hp follows a script, one reading per 3-second tick.
function resting(hpScript) {
  const c = Object.create(Combat.prototype);
  let i = 0;
  const me = { hp: hpScript[0], id: 1 };
  c.state = { me, pos: { x: 0, z: 0 }, liveCreatures: () => [] };
  c._stop = false;
  c.retreats = 0;
  c.logs = [];
  c.log = (m) => c.logs.push(m);
  c.setStance = () => {};
  c.retreat = async () => { c.retreats++; return true; };
  c.eatIfHurt = async () => { me.hp = hpScript[Math.min(++i, hpScript.length - 1)]; };
  c.hasFood = () => true;
  c.move = { heartbeat: () => {} };
  Object.defineProperty(c, 'hpFrac', { get: () => me.hp / COMBAT.playerHp });
  return c;
}

console.log('\nbeing attacked while resting:');
// The real shape of a death: 47 hp, healing never outpaces the hits, straight down.
const bleeding = resting([47, 41, 33, 24, 12, 1]);
await bleeding.recover({ maxMs: 60000 });
ok(bleeding.retreats >= 2, `it runs when its health falls (retreated ${bleeding.retreats}×)`);
ok(bleeding.logs.some((l) => /taking damage while resting/.test(l)), 'and says so plainly');
ok(bleeding.state.me.hp > 1, 'and breaks off before the script can kill it');

console.log('\nresting in peace:');
const healing = resting([47, 55, 66, 78, 88, 95]);
await healing.recover({ maxMs: 60000 });
ok(healing.retreats === 1, 'an undisturbed rest still retreats exactly once, on the way in');
ok(!healing.logs.some((l) => /taking damage/.test(l)), 'and never cries wolf');
ok(healing.logs.some((l) => /recovered · hp 47 -> 9\d/.test(l)), 'it heals to the target and reports the gain');

console.log('\nnoise is not an attack:');
// Regen is lumpy; a single point of jitter must not abort a healthy rest.
const jittery = resting([47, 52, 51.5, 60, 72, 91]);
await jittery.recover({ maxMs: 60000 });
ok(jittery.retreats === 1, 'half a point of wobble is not treated as damage');
ok(jittery.state.me.hp >= 90, 'and the rest runs to completion');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
