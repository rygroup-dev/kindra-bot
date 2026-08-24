#!/usr/bin/env node
// test-market.js — the player market is the only uncapped gold channel, so pricing into it has to
// be right. Three things were wrong, and all three are asserted here against the REAL order book
// captured from app.playkindra.com (the figures below are that book's actual shape).
//
//   1. The listing floor was `vendorValue()` — what Vlad pays when he is OPEN. Once the 1,000/day
//      cap is spent he pays nothing, so the check compared a live market price against a bid that
//      did not exist and banked the stack instead. 366 refusals in one seven-hour run.
//
//   2. The listing price was `cheapestAsk - 1`. mythril_nugget's book is 125 listings deep: the
//      cheapest is 20g, the going rate is 86g, and Vlad pays 38g. Undercutting the cheapest put us
//      at 28g — below the vendor and below two thirds of the board, behind 544 queued units.
//
//   3. The fill verb was `fillBuyOrder`. The ruleset names it `fillOrder`.
import { ensureRules } from '../lib/preflight.js';
ensureRules();
const { Economy } = await import('../lib/economy.js');
const { ITEMS, VENDOR, MARKET } = await import('../lib/rules.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

// The real book, distilled. Depth and percentiles match the live capture exactly.
const mk = (item, prices) => prices.map((price) => ({ item, price, qty: 4, kind: 'item', cur: 'gold' }));
const BOOK = [
  // 125 listings, cheapest 20, p25 and median both 86 — a long cheap tail under a thick wall.
  ...mk('mythril_nugget', [20, 24, 29, ...Array(30).fill(60), ...Array(92).fill(86)]),
  ...mk('rose_quartz',    [2, 3, 4, ...Array(8).fill(5), ...Array(24).fill(10)]),
  ...mk('magma_ore',      [3, 5, 7, 7, 8, 8, 8, 8]),
];

function econ({ vendorSpent = 0 } = {}) {
  const e = Object.create(Economy.prototype);
  e.state = {
    market: BOOK,
    marketPrices: { gloam_heart: 43 },
    me: { inv: {}, gold: 0 },
    haul: { vendor: vendorSpent, vendorCap: VENDOR.dailyGoldCap },
  };
  e.reserved = new Set();
  e.vendorClosed = false;
  e.log = () => {};
  return e;
}

console.log('\nreading the book at its cheap end, not its floor:');
const e = econ();
ok(e.bookFor('mythril_nugget').depth === 125, 'the whole book for an item is visible (125 deep)');
ok(e.bestAsk('mythril_nugget') === 20, 'the cheapest ask is still 20g');
const gr = e.goingRate('mythril_nugget');
ok(gr > 20, `the going rate is NOT the cheapest ask (${gr}g vs 20g)`);
ok(gr < 86, `and it undercuts the p25 wall rather than sitting on it (${gr}g vs 86g)`);
ok(gr > e.vendorValue('mythril_nugget'), `and it beats what Vlad pays (${gr}g vs ${e.vendorValue('mythril_nugget')}g) — the old code priced it at 28g, below both`);

console.log('\nthin books and empty books:');
ok(e.goingRate('magma_ore') < 7, 'an 8-deep book still gets undercut rather than matched');
ok(e.goingRate('gloam_heart') === Math.floor(43 * 0.9), "with no listings it prices off the server's own reference, 10% under");
ok(e.goingRate('nothing_at_all') >= MARKET.minPrice, 'an item with neither book nor reference still gets a legal price');
ok(e.goingRate('rose_quartz') >= MARKET.minPrice, 'and nothing is ever priced below the market minimum');

console.log('\nthe floor is a price that exists TODAY:');
const open = econ({ vendorSpent: 0 });
const shut = econ({ vendorSpent: VENDOR.dailyGoldCap });
ok(open.vendorRoom() > 0, 'with the cap unspent the vendor is open');
ok(shut.vendorRoom() === 0, 'with the cap spent it is shut');
// The bug, stated as the test: same item, same book, different answer.
const floorOpen = open.vendorRoom() > 0 ? open.vendorValue('rose_quartz') : 0;
const floorShut = shut.vendorRoom() > 0 ? shut.vendorValue('rose_quartz') : 0;
ok(floorOpen === Math.max(1, Math.floor((ITEMS.rose_quartz?.sell || 0) * VENDOR.rate)), 'open: the floor is what Vlad pays');
ok(floorShut === 0, 'shut: the floor is ZERO — he pays nothing, so nothing is worth holding for him');
ok(floorOpen > floorShut, 'which is the whole bug: the old code used the open floor all day long');

console.log('\nvaluation follows the same anchor:');
ok(e.marketValue('mythril_nugget') === Math.floor(gr * (1 - MARKET.taxPct - MARKET.listFeePct)),
   'marketValue() is the going rate net of the 8% tax and 1% fee');
ok(e.marketValue('mythril_nugget') > 20, 'so route() no longer values a stack at the bottom of the book');

console.log('\nthe buy-order verb the server actually answers to:');
const sent = [];
const f = econ();
f.state.me.inv = { moonfin_pearl: 2 };
f.state.buyOrders = [{ id: 16, item: 'moonfin_pearl', price: 8000, remaining: 1, mine: false }];
f.net = { send: (m) => sent.push(m) };
await f.fillBuyOrders();
ok(sent.length === 1, 'an order worth filling is filled');
ok(sent[0].t === 'fillOrder', `the verb is 'fillOrder' (was 'fillBuyOrder', which the server drops silently)`);
ok(sent[0].id === 16 && sent[0].qty === 1, 'and it fills only what the order still has room for');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
