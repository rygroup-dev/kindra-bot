// economy.js — emptying the satchel without throwing gold away.
//
// The satchel is the real bottleneck: 100 slots on the starter bag and a 50-second chop fills it.
// There are three exits, and picking the wrong one is expensive:
//
//   VENDOR (`sell`/`sellAll`)  — instant, but pays rate 0.45 of market price AND gluts: every sale
//                                shaves 1.5% off that item's price down to a 25% floor, recovering
//                                on a 30-min half-life. Hard-capped at 1000 gold/day.
//   MARKET (`listItem`)        — 8% tax + 1% list fee, max 30 listings, but no glut and full price.
//                                Slower (needs a buyer) and counts against tradeCap 2000/day.
//   BANK   (`bankDeposit`)     — free, infinite, no income. The right home for anything we'd rather
//                                sell later (trophies, mats we need for crafting).
//
// Policy: bank the protected/valuable, vendor the bulk while the vendor cap has room, and list
// high-value stacks on the market instead of gluting them.
import { BUILDINGS, VENDOR, MARKET, ITEMS, GOODS, isPotion, satchelCap, invCount } from './rules.js';
import { sleep } from './movement.js';

const at = (id) => BUILDINGS.find((b) => b.id === id);
export const BANK = at('bank');       // (-45, -30) Aldous the Banker
export const MARKET_HOUSE = at('market'); // (0, -30) Vlad the Merchant
const SHOP_RANGE = 3.0;

export class Economy {
  constructor({ net, state, move, log = console.log }) {
    this.net = net; this.state = state; this.move = move; this.log = log;
    this.sold = { gold: 0, items: 0 };
  }

  capacity() { return satchelCap(this.state.me?.satchel || 'worn_satchel'); }
  used() { return invCount(this.state.me?.inv || {}); }
  get full() { return this.used() >= this.capacity() - 2; }
  get pressure() { return this.used() / Math.max(1, this.capacity()); }

  async goTo(building) {
    await this.move.walkTo(building.x, building.z, { range: SHOP_RANGE });
  }

  // --- valuation ----------------------------------------------------------
  // The vendor pays a fraction of the item's OWN base price, not of the player-market price. Those
  // two diverge wildly: ancient_log has ITEMS.sell 80 (vendor ~36) while players dump it on the
  // market at 2g. Valuing off marketPrices would have listed trophies for a fifteenth of what Vlad
  // pays for them, so each exit is priced on its own terms and we take the better one.
  vendorValue(item) {
    const base = ITEMS[item]?.sell || 0;
    return Math.max(1, Math.floor(base * VENDOR.rate));
  }

  // What a market sale nets after the 8% tax and the 1% listing fee.
  marketValue(item) {
    const px = this.bestAsk(item) ?? this.state.marketPrices[item] ?? 0;
    return Math.floor(px * (1 - MARKET.taxPct - MARKET.listFeePct));
  }

  // Where this item should go. Maps get dug, potions get drunk, everything else goes to whichever
  // counter pays more.
  route(item) {
    const def = ITEMS[item] || {};
    if (def.t === 'map') return 'keep';        // torn_map -> digTreasure is worth far more than 7g
    if (isPotion(item)) return 'keep';
    if (def.t === 'seed') return 'keep';
    // Once the daily vendor cap is spent Vlad pays nothing, so pointing stock at him just gluts the
    // price for tomorrow. Everything sellable goes to the player market instead.
    if (this.vendorRoom() <= 0) return 'market';
    return this.marketValue(item) > this.vendorValue(item) ? 'market' : 'vendor';
  }

  vendorRoom() {
    const h = this.state.haul || {};
    return Math.max(0, (h.vendorCap ?? VENDOR.dailyGoldCap) - (h.vendor ?? 0));
  }

  // Sell one item stack at Vlad's. Requires standing at the market building.
  async sellItem(item, qty) {
    this.net.send({ t: 'sell', item, qty });
    await sleep(350);
  }

  // Sell everything the policy marks as bulk. Stops early when the daily vendor cap is spent —
  // past that point the sale still gluts the price but pays nothing.
  async vendorDump({ keep = new Set() } = {}) {
    await this.goTo(MARKET_HOUSE);
    const before = this.state.me.gold;
    const inv = { ...(this.state.me.inv || {}) };
    let soldItems = 0;

    for (const [item, qty] of Object.entries(inv)) {
      if (!qty || keep.has(item)) continue;
      if (this.route(item) !== 'vendor') continue;
      if (this.vendorRoom() <= 0) { this.log('[econ] vendor daily cap spent — stopping'); break; }
      await this.sellItem(item, qty);
      soldItems += qty;
    }
    await sleep(600);
    const gained = this.state.me.gold - before;
    this.sold.gold += gained; this.sold.items += soldItems;
    this.log(`[econ] vendor: ${soldItems} items -> +${gained}g (cap left ${this.vendorRoom()})`);
    return { items: soldItems, gold: gained };
  }


  // --- market -------------------------------------------------------------
  // List a stack at the going rate. Undercutting by a hair is what actually clears.
  async list(item, qty, price) {
    const px = Math.max(MARKET.minPrice, Math.min(MARKET.maxPrice, Math.floor(price)));
    this.net.send({ t: 'listItem', item, qty: Math.min(qty, MARKET.maxQty), price: px });
    await sleep(400);
    return px;
  }

  // Cheapest live ask for an item, so we can price just under it.
  bestAsk(item) {
    let best = Infinity;
    for (const l of this.state.market) {
      if (l.item !== item || l.cur !== 'gold' || l.kind !== 'item') continue;
      if (l.price < best) best = l.price;
    }
    return Number.isFinite(best) ? best : null;
  }

  async listValuables({ maxListings = 5 } = {}) {
    const inv = { ...(this.state.me.inv || {}) };
    if (!Object.entries(inv).some(([it, q]) => q && this.route(it) === 'market')) return 0;
    await this.goTo(MARKET_HOUSE);
    let listed = 0;
    for (const [item, qty] of Object.entries(inv)) {
      if (listed >= maxListings) break;
      if (!qty || this.route(item) !== 'market') continue;
      const ask = this.bestAsk(item);
      const price = ask ? Math.max(MARKET.minPrice, ask - 1) : (this.state.marketPrices[item] || ITEMS[item]?.sell || 1);
      await this.list(item, qty, price);
      this.log(`[econ] listed ${qty}× ${item} @ ${price}g (vendor would pay ${this.vendorValue(item)})`);
      listed++;
    }
    return listed;
  }

  // --- supplies -----------------------------------------------------------
  // Food is what makes combat pay. Without it the fight ceiling sits ~2 levels above ours and the
  // combat gold cap is unreachable; GOODS.meal is 18g for 2 cookedfish (30 hp each).
  foodCount() {
    const inv = this.state.me?.inv || {};
    return (inv.cookedfish || 0) + (inv.cooked_perch || 0) + (inv.acorn_loaf || 0);
  }

  async buyFood(meals = 5) {
    if (this.state.me.gold < GOODS.meal.cost * meals) meals = Math.floor(this.state.me.gold / GOODS.meal.cost);
    if (meals <= 0) return 0;
    await this.goTo(MARKET_HOUSE);
    this.net.send({ t: 'requestMerchant' });
    await sleep(400);
    for (let i = 0; i < meals; i++) {
      this.net.send({ t: 'buy', id: 'meal', currency: 'gold' });
      await sleep(300);
    }
    await sleep(600);
    this.log(`[econ] bought ${meals} meals — food now ${this.foodCount()}`);
    return meals;
  }

  // --- bank ---------------------------------------------------------------
  async bankAll() {
    await this.goTo(BANK);
    this.net.send({ t: 'bankOpen' });
    await sleep(500);
    this.net.send({ t: 'bankDepositAll' });
    await sleep(800);
    this.log(`[econ] banked everything — satchel ${this.used()}/${this.capacity()}`);
  }

  async bankItem(item, qty) {
    await this.goTo(BANK);
    this.net.send({ t: 'bankOpen' });
    await sleep(400);
    this.net.send({ t: 'bankDeposit', item, qty });
    await sleep(400);
  }

  // The satchel-full response the orchestrator calls: sell what pays, bank the rest.
  // Guarantees space afterwards. Sell what pays, list what the market wants, and bank whatever is
  // left — the bank is free and unlimited, so there is never a reason to stay full.
  async makeRoom() {
    const res = await this.vendorDump();
    await this.listValuables({ maxListings: 8 });
    if (this.full) {
      this.log(`[econ] still ${this.used()}/${this.capacity()} — banking the remainder`);
      await this.bankAll();
    }
    return res;
  }
}
