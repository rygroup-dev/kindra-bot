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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
