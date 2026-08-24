#!/usr/bin/env node
// test-cashout.js — the gold reserve and the auto cash-out.
//
// The cash-out is the only path from farmed gold to a token that exists outside the game, and for
// most of this project's life it never fired. The float was sized to the character's next planned
// upgrade (1,500–6,000 gold), and the book's minimum lot is 1,000 — so an account had to bank
// ~7,000 gold before its first listing could go up. At the ~11k/day per-character ceiling that is
// entire days of farming sitting in-game as soft currency.
//
// The reserve is now one flat number in CFG, read live, identical for every character in the fleet
// — including one minted after this file was written, which is the property being asserted here.
//
// The second half is knowing whether a lot SOLD. The server announces the book and our own open
// listings; it never says "yours sold". A listing that was in `mine` last frame and is gone from
// this one is the only honest signal, and cancels have to be subtracted or every cancel reads as a
// sale.
import { ensureRules } from '../lib/preflight.js';
ensureRules();
const { KGold } = await import('../lib/chain.js');
const { CFG } = await import('../lib/config.js');
const { KGOLD } = await import('../lib/rules.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

// A fake socket: records what was sent, and lets a test push a server frame back.
function wire({ gold = 0, book = [], mine = [] } = {}) {
  const handlers = new Map();
  const sent = [];
  const lines = [];
  const net = {
    send: (m) => sent.push(m),
    on: (ev, fn) => { (handlers.get(ev) || handlers.set(ev, []).get(ev)).push(fn); },
    emit: (ev, m) => (handlers.get(ev) || []).forEach((fn) => fn(m)),
  };
  const kg = new KGold({ net, state: { me: { gold } }, log: (l) => lines.push(l) });
  kg.book = book; kg.mine = mine;
  return { kg, net, sent, lines };
}

const BOOK = [
  { id: 'a', gold: 5000, price: 40 },    // 8.00 per 1k — the best ask
  { id: 'b', gold: 1000, price: 9 },     // 9.00
  { id: 'c', gold: 2000, price: 20 },    // 10.00
];

console.log('\nthe reserve is one flat number for the whole fleet');
{
  ok(CFG.goldReserve === 1200, `default reserve is 1,200 gold (got ${CFG.goldReserve})`);
  ok(CFG.cashOutLot === 1000, `default lot is 1,000 gold (got ${CFG.cashOutLot})`);
  ok(CFG.cashOutLot >= KGOLD.MIN_GOLD, 'the lot is at least the book minimum, so it is always a legal listing');

  // The old float. Kept as an explicit assertion because it is the bug: 1,000 + 6,000 = 7,000 gold
  // banked before a first listing.
  ok(CFG.goldReserve + KGOLD.MIN_GOLD < 6000,
     `a character can list its first lot at ${CFG.goldReserve + KGOLD.MIN_GOLD} gold, not ~7,000`);

  const fresh = wire({ gold: 0 }).kg;      // stands in for a wallet minted tomorrow
  const old = wire({ gold: 999999 }).kg;
  ok(fresh.workingFloat() === CFG.goldReserve && old.workingFloat() === CFG.goldReserve,
     'a brand-new character and a rich old one keep the same reserve — no per-wallet copy to migrate');
}

console.log('\nit lists at 1,200 + one lot, and not before');
{
  const under = wire({ gold: 2199, book: BOOK });
  under.kg.refresh = async () => BOOK;
  const r1 = await under.kg.cashOutSurplus();
  ok(!r1.listed && /below 1000/.test(r1.reason), `2,199 gold: nothing listed (${r1.reason})`);

  const over = wire({ gold: 2200, book: BOOK });
  over.kg.refresh = async () => BOOK;
  const r2 = await over.kg.cashOutSurplus();
  ok(r2.listed && r2.gold === 1000, `2,200 gold: lists exactly one 1,000g lot (got ${r2.gold})`);
  ok(over.sent.some((m) => m.t === 'kgoldList' && m.gold === 1000), 'the kgoldList frame carries the lot');
}

console.log('\nprice is the going rate, one lot at a time');
{
  const rich = wire({ gold: 500000, book: BOOK });
  rich.kg.refresh = async () => BOOK;
  const r = await rich.kg.cashOutSurplus();
  // Surplus is 498,800 — a single lot that size needs one buyer holding ~4,000 $KINDRA. Small lots
  // at the going rate clear; a whale lot sits in escrow.
  ok(r.gold === 1000, `a rich character still lists 1,000 at a time (got ${r.gold})`);
  ok(Math.abs(r.perK - 8 * 0.98) < 1e-9, `priced at the best ask less the 2% undercut (${r.perK.toFixed(2)} per 1k)`);
  ok(r.price === Math.floor(8 * 0.98), `1,000g lot asks ${r.price} $KINDRA`);
  ok(r.price >= KGOLD.MIN_PRICE, 'never below the book minimum price');
}

console.log('\nthe listing slots and the empty book are respected');
{
  const full = wire({ gold: 50000, book: BOOK, mine: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  full.kg.refresh = async () => BOOK;
  const r = await full.kg.cashOutSurplus();
  ok(!r.listed && /slots full/.test(r.reason), 'three open listings means no fourth');

  const blind = wire({ gold: 50000, book: [] });
  blind.kg.refresh = async () => [];
  const r2 = await blind.kg.cashOutSurplus();
  ok(!r2.listed && /no live book/.test(r2.reason), 'an empty book is not a price — it refuses rather than guessing');
}

console.log('\na lot that disappears from `mine` is a sale');
{
  const w = wire({ gold: 5000 });
  w.net.emit('kgold', { mine: [{ id: 7, gold: 1000, price: 8 }, { id: 8, gold: 1000, price: 8 }] });
  ok(w.lines.length === 0, 'listings appearing is not a sale');

  w.net.emit('kgold', { mine: [{ id: 8, gold: 1000, price: 8 }] });
  ok(w.kg.sales.lots === 1, 'one lot gone from `mine` counts as one sale');
  ok(w.kg.sales.gold === 1000 && w.kg.sales.kindra === 8, 'the sale carries the gold and the $KINDRA it fetched');
  ok(w.lines.some((l) => /\[kgold\] SOLD 1000g for 8 \$KINDRA/.test(l)), 'and it says so in the log, which is what the chat notification reads');
}

console.log('\na cancel is not a sale');
{
  const w = wire({ gold: 5000 });
  w.net.emit('kgold', { mine: [{ id: 7, gold: 1000, price: 8 }] });
  await w.kg.cancel(7);
  w.net.emit('kgold', { mine: [] });
  ok(w.kg.sales.lots === 0, 'pulling our own listing does not count as income');
  ok(!w.lines.some((l) => /SOLD/.test(l)), 'and does not announce one');

  // And the id is consumed, so re-listing and genuinely selling still reports.
  w.net.emit('kgold', { mine: [{ id: 7, gold: 1000, price: 9 }] });
  w.net.emit('kgold', { mine: [] });
  ok(w.kg.sales.lots === 1, 'the cancel exemption is spent once, not forever');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
