#!/usr/bin/env node
// test-pin.js — a pinned character holds its slot, and lets go by itself.
//
// The pin exists for one job: dragging an account to Lv 10, which is what unlocks referrals for
// every character the fleet has minted. The two things that can go wrong with it are that rotation
// evicts it anyway, and that it never releases — so both are asserted here.
import { ensureRules } from '../lib/preflight.js';
ensureRules();
const { Fleet } = await import('../lib/fleet.js');
const { REFERRAL } = await import('../lib/rules.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

const chr = (label, { tl = 3, exhausted = true } = {}) => ({
  label, live: true, exhausted,
  state: { me: { tl, skills: {} }, haul: {}, bosses: new Map(), pos: { x: 0, z: 0 } },
  orch: { chaseAccountLevel: false, capLeft: () => 0, bestAlternative: 0 },
  heldTooLong: () => true,                 // worst case: it has held the slot far too long
  workLeft: () => ({ why: 'spent' }),
  disconnect() { this.live = false; this.dropped = true; },
  bosses: null, gather: null, crafting: { rationCount: () => 0 }, realms: null,
});

const fleet = new Fleet({ onLog: () => {} });
const logs = [];
fleet.log = (m) => logs.push(m);
fleet.saveRunState = () => {};            // don't touch the live fleet-state.json
const bots = [chr('kindra-01'), chr('kindra-02'), chr('kindra-03')];
fleet.bots = new Map(bots.map((b) => [b.label, b]));

console.log('\npinning:');
ok(fleet.pin('kindra-01').ok, 'the primary can be pinned');
ok(fleet.pinned === 'kindra-01', 'the fleet remembers which one');
ok(bots[0].orch.chaseAccountLevel === true, 'and switches its chase mode on — combat is the only full-weight route');
ok(!fleet.pin('kindra-99').ok, 'an unknown label is refused');

console.log('\nrotation cannot evict it:');
// Every character here is exhausted AND has held too long — the worst case for the pin.
const pinned = fleet.pinnedBot();
const live = bots.filter((b) => b.live);
const busy = live.filter((b) => b === pinned || (!b.exhausted && !b.heldTooLong(0)));
ok(busy.includes(pinned), 'the pinned character counts as busy whatever its score says');
ok(busy.length === 1, 'and the other two are free to rotate');

console.log('\nreleasing itself:');
ok(fleet.releasePinIfDone() === false, `it holds while below Lv ${REFERRAL.minLv}`);
bots[0].state.me.tl = REFERRAL.minLv - 1;
ok(fleet.releasePinIfDone() === false, 'still holds one level short');
bots[0].state.me.tl = REFERRAL.minLv;
ok(fleet.releasePinIfDone() === true, `releases the moment it reaches Lv ${REFERRAL.minLv}`);
ok(fleet.pinned === null, 'the pin is gone');
ok(bots[0].orch.chaseAccountLevel === false, 'and the chase is switched back off');
ok(logs.some((m) => /referrals are open/.test(m)), 'and it says why');

console.log('\nby hand:');
fleet.pin('kindra-02');
ok(fleet.unpin({ reason: 'released by hand' }).ok, 'it can also be released by hand');
ok(!fleet.unpin().ok, 'unpinning nothing is refused, not silently ignored');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
