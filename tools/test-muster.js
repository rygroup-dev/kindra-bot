#!/usr/bin/env node
// test-muster.js — the fleet side of a raid: who is called, and when the gate opens.
//
// A raid that starts before everyone arrives is one character tanking a boss meant for three, so
// the party holds outside the slam radius until the last of them is in position.
import { ensureRules } from '../lib/preflight.js';
ensureRules();
const { Fleet } = await import('../lib/fleet.js');
const { Bosses } = await import('../lib/bosses.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

function raider(label, { lvl = 17, rations = 8, bossCap = 5000 } = {}) {
  const state = { me: { skills: {}, appearance: { weapon: 'iron_sword', shield: 'wood_shield', character: 'Knight' } },
                  bosses: new Map(), pos: { x: 0, z: 0 } };
  const b = new Bosses({ net: { on() {} }, state, move: {}, crafting: { rationCount: () => rations },
                         realms: { reachable: () => true, current: () => null }, label, log: () => {} });
  b.myCombatLevel = () => lvl;
  return { label, live: true, state, bosses: b, crafting: b.crafting,
           realms: { reachable: () => true }, orch: { capLeft: () => bossCap } };
}

const fleet = new Fleet({ onLog: () => {} });
const logs = [];
fleet.log = (m) => logs.push(m);
const use = (bots) => { fleet.bots = new Map(bots.map((b) => [b.label, b])); fleet.raid = null; };

console.log('\nchoosing:');
const three = [raider('a'), raider('b'), raider('c')];
use(three);
let r = fleet.chooseRaid();
ok(r?.bossId === 'drowned_king', `a party of three calls drowned_king (${r?.bossId})`);
ok(r.members.length === 3, 'all three are named in it');

use([raider('a')]);
ok(fleet.chooseRaid() === null, 'a party of one calls nothing');

use([raider('a', { bossCap: 0 }), raider('b', { bossCap: 0 }), raider('c', { bossCap: 0 })]);
ok(fleet.chooseRaid() === null, 'nothing is called once the boss purse is spent for the day');

use([raider('a', { lvl: 5 }), raider('b', { lvl: 5 }), raider('c', { lvl: 5 })]);
ok(fleet.chooseRaid() === null, 'a Lv5 party is under drowned_king\'s Lv12 gate');

console.log('\nmustering:');
const party = [raider('a'), raider('b'), raider('c')];
use(party);
r = fleet.syncRaid();
ok(!!r && !r.go, 'the raid is called but the gate is shut');
ok(party.every((b) => b.bosses.raid === r), 'every member got the same raid object');

party[0].bosses.mustered = true; party[1].bosses.mustered = true;
fleet.syncRaid();
ok(!r.go, 'two of three in position is not enough');

party[2].bosses.mustered = true;
fleet.syncRaid();
ok(r.go, 'the gate opens once the last one arrives');

console.log('\nstanding down:');
party[1].live = false; party[2].live = false;
fleet.syncRaid();
ok(fleet.raid?.bossId !== r.bossId || fleet.raid === null || fleet.raid.at > r.at,
   'a party that fell below two is stood down (or re-called fresh)');
ok(logs.some((m) => /stood down/.test(m)), 'and it says so');

console.log('\nnon-members:');
const fresh = [raider('a'), raider('b'), raider('c')];
const outsider = raider('z', { rations: 0 });   // no rations: it cannot be part of a safe party
use([...fresh, outsider]);
const r2 = fleet.syncRaid();
ok(!!r2, 'the raid still goes ahead');
ok(!r2.members.includes('z'), 'the character with no rations is left out of the party');
ok(r2.members.length === 3, 'the other three still go');
ok(outsider.bosses.raid === null, 'and it is not handed the raid');

// One character under the level gate must not ground the raid either.
const under = raider('y', { lvl: 5 });
use([raider('a'), raider('b'), raider('c'), under]);
const r3 = fleet.syncRaid();
ok(!!r3 && !r3.members.includes('y'), 'nor does one character below the boss\'s level gate');

console.log('\nafter the kill:');
{
  const crew = [raider('a'), raider('b'), raider('c')];
  use(crew);
  const live = fleet.syncRaid();
  live.done = true;                      // raidRun marks this the moment the boss falls
  const after = fleet.syncRaid();
  ok(after !== live, 'a finished raid is retired, not marched to a second time');
  ok(logs.some((m) => /finished/.test(m)), 'and the log says finished, not stood down');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
