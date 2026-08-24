#!/usr/bin/env node
// test-muster.js — the fleet side of a raid: who is called, and when the gate opens.
//
// A raid that starts before everyone arrives is one character tanking a boss meant for three, so
// the party holds outside the slam radius until the last of them is in position.
import { ensureRules } from '../lib/preflight.js';
ensureRules();
const { Fleet } = await import('../lib/fleet.js');
const { Bosses } = await import('../lib/bosses.js');
const { BOSSES } = await import('../lib/rules.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

function raider(label, { lvl = 17, rations = 8, bossCap = 5000 } = {}) {
  const state = { me: { skills: {}, appearance: { weapon: 'iron_sword', shield: 'wood_shield', character: 'Knight' } },
                  bosses: new Map(), pos: { x: 0, z: 0 } };
  const b = new Bosses({ net: { on() {} }, state, move: {}, crafting: { rationCount: () => rations },
                         realms: { reachable: () => true, current: () => null }, label, log: () => {} });
  b.myCombatLevel = () => lvl;
  return { label, live: true, state, bosses: b, crafting: b.crafting,
           realms: { reachable: () => true, current: () => null, entrance: () => null },
           orch: { capLeft: () => bossCap, bestAlternative: 0 } };
}

const fleet = new Fleet({ onLog: () => {} });
const logs = [];
fleet.log = (m) => logs.push(m);
const use = (bots) => { fleet.bots = new Map(bots.map((b) => [b.label, b])); fleet.raid = null; };

console.log('\nchoosing:');
const three = [raider('a'), raider('b'), raider('c')];
use(three);
let r = fleet.chooseRaid();
// Frostmaw, not the Drowned King — and that is the ladder working, not a regression. At combat
// Lv 17 the goal is the Lv-20 gate that opens the Rimewyrm (240g a kill, five-minute respawn).
// Measured against that goal:
//     frostmaw      travel  36s + fight 12s =  48s -> 1,800 xp        = 37.4 xp/sec
//     drowned_king  travel 226s + fight 19s = 245s -> 2,800 xp + 60g  = 11.4 xp/sec
// The Drowned King pays gold and the Frostmaw pays none, but it lives at (-30, 790) behind the
// isles portal and the Frostmaw is 126 units from town. Three times the climb rate wins.
ok(r?.bossId === 'frostmaw', `a party of three takes the fastest rung to the next gate (${r?.bossId})`);
ok(r.members.length === 3, 'all three are named in it');
ok(r.unlock > 0, 'and it is priced on the gate it opens, not on the coins it does not pay');

use([raider('a')]);
ok(fleet.chooseRaid() === null, 'a party of one calls nothing');

use([raider('a', { bossCap: 0 }), raider('b', { bossCap: 0 }), raider('c', { bossCap: 0 })]);
ok(fleet.chooseRaid() === null, 'nothing is called once the boss purse is spent for the day');

// A Lv5 party used to be told to go away: every PAYING boss gates at combat 10 or above, so the
// scan found nothing and twenty accounts sat between Lv 1 and 8 with no route out. The Grove Warden
// gates at combat 0, is 900 hp, and respawns every 2.5 minutes — four kills is combat Lv 12, which
// is the first paying boss. It is the bottom rung and it was invisible.
use([raider('a', { lvl: 5 }), raider('b', { lvl: 5 }), raider('c', { lvl: 5 })]);
const low = fleet.chooseRaid();
ok(low?.bossId === 'warden', `a Lv5 party is sent to the Grove Warden, the only rung it can stand on (${low?.bossId})`);
ok(low.pay === 0 && low.unlock > 0, 'which pays no gold at all — its whole value is the gate it opens');

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
// Exclusion is a property of the FIGHT, not of the character: with four swinging, the Frostmaw's
// 1,800 hp falls in nine seconds and even someone carrying no food eats too few slams to be in
// danger, so crewFor rightly keeps them. Assert the mechanism on a fight long enough to need it —
// the Drowned King is 2,800 hp and the ration-less raider does not survive it.
ok(r2.members.length >= 3, 'and the party is not thinned for no reason');
const longFight = fresh[0].bosses.crewFor(BOSSES.drowned_king, [...fresh, outsider]);
ok(longFight && !longFight.crew.includes(outsider), 'on a fight long enough to matter, the character with no rations is left out');
ok(longFight.crew.length === 3, 'and the other three still go');
// The invariant that actually matters: whoever is not in the party is not holding a raid object.
// (On this short fight the ration-less raider IS in the party, so asserting on that character by
// name would be asserting the boss choice again, not the wiring.)
const members = new Set(r2.members);
const bystanders = [...fleet.bots.values()].filter((b) => !members.has(b.label));
ok(bystanders.every((b) => b.bosses.raid === null), 'nobody outside the party is handed the raid');

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

console.log('\nis it worth leaving the valley for?');
{
  const crew = [raider('a'), raider('b'), raider('c')];
  use(crew);
  const cheap = fleet.chooseRaid();
  ok(!!cheap, `a raid is priced at ${Math.round(cheap.perMin)}g/min including the round trip`);

  // Now give the crew something better to do. Nobody should be pulled off it.
  for (const b of crew) b.orch.bestAlternative = 5000;
  fleet.raid = null;
  ok(fleet.chooseRaid() === null, 'no raid is called when the crew already earns more standing still');
  ok(/already earning/.test(fleet.raidWhy || ''), `and it says why: ${fleet.raidWhy}`);

  for (const b of crew) b.orch.bestAlternative = 0;
  fleet.raid = null;
  ok(fleet.chooseRaid() !== null, 'and it is called again once the alternative dries up');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
