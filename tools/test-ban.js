#!/usr/bin/env node
// test-ban.js — a banned account never takes a slot again.
//
// This is not a hypothetical. Twelve of this fleet's characters were banned for a year in one
// night: the eleven that converted a self-referral and the referrer that collected. Before the
// quarantine they kept their place in the queue, so every circuit spent one of the three per-IP
// slots opening a socket that could only ever be refused — the fleet ran a quarter empty and the
// log said nothing except "join rejected" once per rotation.
//
// What has to hold: a ban is recognised from the server's own words, it is written down so a
// restart does not undo it, it is filtered out of the ONE function that hands out slots, and it
// expires by itself so a temporary ban is not a permanent deletion.
import { ensureRules } from '../lib/preflight.js';
ensureRules();
const { Fleet } = await import('../lib/fleet.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

const chr = (label, banned = null) => ({
  label, live: false, banned, proxy: null, status: 'idle',
  on() {}, emit() {},
});

const fleet = new Fleet({ onLog: () => {} });
fleet.log = () => {};
fleet.saveRunState = () => {};
const HOUR = 3600_000;

console.log('\nreading the server\'s refusal:');
// The real frame, verbatim from the night it happened.
const real = 'This account is banned — try again in 8753h.';
const hrs = /banned/i.test(real) ? Number(/(\d+)\s*h/i.exec(real)?.[1] || 0) : null;
ok(hrs === 8753, 'the ban length is parsed out of the message the server actually sent');
ok(Math.round(hrs / 24) === 365, 'and 8753h is reported as a year, not as "8753"');
ok(/banned/i.test('max 3 characters online per IP') === false, '"max 3 online" is NOT read as a ban');

console.log('\nquarantine:');
fleet.bots = new Map([
  chr('kindra-01', { until: Date.now() + 8753 * HOUR, hours: 8753, reason: real }),
  chr('kindra-02'),
  chr('kindra-03'),
].map((b) => [b.label, b]));

ok(fleet.playable(fleet.bots.get('kindra-02')), 'a healthy account is playable');
ok(!fleet.playable(fleet.bots.get('kindra-01')), 'a banned one is not');
ok(fleet.banned().length === 1, 'the fleet can say how many it has lost');
ok(fleet.banned()[0].label === 'kindra-01', 'and which');

const group = fleet.ipGroups().get('direct');
ok(group.length === 2, 'the banned account is gone from the per-IP group — the one place slots come from');
ok(!group.some((b) => b.label === 'kindra-01'), 'so neither _startAll nor the shift rotation can reach it');

console.log('\nit is not a permanent deletion:');
const temp = chr('kindra-04', { until: Date.now() - 1000, hours: 1, reason: 'banned 1h' });
fleet.bots.set('kindra-04', temp);
ok(fleet.playable(temp), 'a ban whose clock has run out lets the account back in');
ok(temp.banned === null, 'and the mark is cleared rather than re-checked forever');
ok(fleet.ipGroups().get('direct').some((b) => b.label === 'kindra-04'), 'it is back in the rotation');

console.log('\nsurviving a restart:');
// add() is what rebuilds a bot from the wallet book. The ban has to come back with it, or the
// first restart cheerfully queues twelve dead accounts again.
const seen = [];
const f2 = new Fleet({ onLog: () => {} });
f2.log = () => {};
f2.recordBan = (label, b) => seen.push([label, b.until]);
const entry = { label: 'x', privateKey: '0x' + '11'.repeat(32), world: 'valley', bannedUntil: Date.now() + 500 * HOUR, bannedReason: real };
const b = f2.add(entry);
ok(b.banned !== null, 'a ban stored in the wallet book is restored on load');
ok(b.status === 'banned', 'and the character reports itself as banned, not as idle');
ok(!f2.playable(b), 'so it stays out of the rotation across the restart');

const fresh = f2.add({ label: 'y', privateKey: '0x' + '22'.repeat(32), world: 'valley' });
ok(fresh.banned === null, 'an ordinary entry is untouched');
ok(f2.playable(fresh), 'and plays normally');

console.log('\nno referral is ever attributed automatically:');
const { DEFAULT_REFERRER } = await import('../lib/config.js');
ok(DEFAULT_REFERRER === '', 'there is no built-in referrer — the ban came from crediting one');
ok(f2.bestReferrer() === null, 'and the fleet never nominates one of its own characters');
const made = [];
const origSave = Fleet.saveWallets;
Fleet.saveWallets = (l) => { made.push(...l.slice(-1)); return ''; };
Fleet.loadWallets = () => [];
Fleet.createWallets(1, { world: 'valley' });
Fleet.saveWallets = origSave;
ok(made[0]?.referrer === null, 'a freshly minted character carries no referrer at all');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
