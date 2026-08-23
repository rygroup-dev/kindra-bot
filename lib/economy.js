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
import {
  BUILDINGS, VENDOR, MARKET, ITEMS, GOODS, isPotion, satchelCap, invCount,
  DURA, duraOf, isBroken, wears, repairCost, REPAIR_SPOT,
  WAYPOINTS, FAST_TRAVEL, fastTravelFee,
} from './rules.js';
import { sleep } from './movement.js';

// Below this the vendor is effectively shut: the sale gluts the price and returns nothing.
const VENDOR_MIN_WORTH = 25;

const at = (id) => BUILDINGS.find((b) => b.id === id);
export const BANK = at('bank');       // (-45, -30) Aldous the Banker
export const MARKET_HOUSE = at('market'); // (0, -30) Vlad the Merchant
const SHOP_RANGE = 3.0;

export class Economy {
  constructor({ net, state, move, log = console.log }) {
    this.net = net; this.state = state; this.move = move; this.log = log;
    this.sold = { gold: 0, items: 0 };
    this.vendorClosed = false;   // latched by the server's own refusal, cleared on the day roll

    // LISTEN TO THE SERVER. It says exactly what is wrong, in plain words, and every bug in this
    // module so far has been a case of computing an answer the server had already given us: the
    // vendor cap read "1 gold left", so the arithmetic said open while the server said closed, and
    // 81 items were dumped for 0 gold on every cycle — gluting prices for nothing.
    net.on('toast', (m) => {
      const t = m?.text || '';
      if (/vendor hit its daily/i.test(t)) {
        if (!this.vendorClosed) this.log('[econ] vendor is closed for the day — routing everything to the market');
        this.vendorClosed = true;
      }
      if (/market listings? full|too many listings/i.test(t)) this.marketFull = true;
    });
    net.on('wallet', (m) => {
      // A fresh day resets the caps; the server tells us by moving the counter back down.
      if (m?.haul && (m.haul.vendor ?? 0) < 10) { this.vendorClosed = false; this.marketFull = false; }
    });
    // `sales` is the global recent-trades feed. We were not listening at all, so the bot listed 89
    // stacks on the player market and had no idea whether a single one ever sold — and a listing
    // holds the goods in escrow, so an unsold one is inventory that has simply gone away.
    this.listed = { count: 0, cleared: 0, gold: 0 };
    this._seenSales = new Set();
    net.on('sales', (m) => {
      const me = this.state.me?.name;
      if (!me || !Array.isArray(m?.sales)) return;
      for (const s of m.sales) {
        if (!s || s.seller !== me) continue;
        const key = `${s.at}:${s.item}:${s.qty}:${s.price}`;
        if (this._seenSales.has(key)) continue;
        this._seenSales.add(key);
        this.listed.cleared += 1;
        this.listed.gold += (s.price || 0) * (s.qty || 1);
        this.log(`[econ] market sale cleared: ${s.qty || 1}× ${s.item} @ ${s.price}g to ${s.buyer || 'someone'}`);
      }
      if (this._seenSales.size > 400) this._seenSales = new Set([...this._seenSales].slice(-200));
    });
  }

  // Items the focused quest needs; the orchestrator refreshes this each cycle.
  reserve(items) { this.reserved = new Set(items || []); }

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
    // RESERVED FOR A QUEST. Selling the raws a focused objective needs is self-defeating: the
    // Monument quest wants crafted goods, goods are made from logs and ore, and the market trip was
    // dumping exactly those — so the objective sat at 0/6 for 248 consecutive cycles while the bot
    // worked hard in a circle.
    if (this.reserved?.has(item)) return 'keep';
    // Once the daily vendor cap is spent Vlad pays nothing, so pointing stock at him just gluts the
    // price for tomorrow. Everything sellable goes to the player market instead — except things the
    // market values below the vendor, which are worth holding until the cap resets.
    if (this.vendorRoom() <= 0) return this.marketValue(item) > 0 ? 'market' : 'keep';
    return this.marketValue(item) > this.vendorValue(item) ? 'market' : 'vendor';
  }

  // Room worth walking for. A handful of gold left is the same as none: the sale still gluts the
  // price for tomorrow and pays nothing today.
  vendorRoom() {
    if (this.vendorClosed) return 0;
    const h = this.state.haul || {};
    const left = Math.max(0, (h.vendorCap ?? VENDOR.dailyGoldCap) - (h.vendor ?? 0));
    return left < VENDOR_MIN_WORTH ? 0 : left;
  }

  // Sell one item stack at Vlad's. Requires standing at the market building.
  async sellItem(item, qty) {
    this.net.send({ t: 'sell', item, qty });
    await sleep(350);
  }

  // Sell everything the policy marks as bulk. Stops early when the daily vendor cap is spent —
  // past that point the sale still gluts the price but pays nothing.
  async vendorDump({ keep = new Set() } = {}) {
    // Check the cap BEFORE the walk. The room check used to live inside the loop, so a character
    // whose vendor cap was spent walked all the way to the counter and broke on the first item:
    // 226 of 441 vendor trips sold nothing at all. The market leg does its own walk.
    if (this.vendorRoom() <= 0) {
      this.log('[econ] vendor cap already spent — going straight to the market');
      return { items: 0, gold: 0 };
    }
    await this.goTo(MARKET_HOUSE);
    const before = this.state.me.gold;
    const inv = { ...(this.state.me.inv || {}) };
    let soldItems = 0;

    for (const [item, qty] of Object.entries(inv)) {
      if (!qty || keep.has(item)) continue;
      if (this.route(item) !== 'vendor') continue;
      if (this.vendorRoom() <= 0) { this.log('[econ] vendor daily cap spent — stopping'); break; }
      await this.sellItem(item, qty);
      if (this.vendorClosed) { this.log('[econ] vendor closed mid-sale — the rest goes to the market'); break; }
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
      // Never undercut below what the vendor would pay. Following the cheapest ask blindly listed a
      // gem worth 18g at the vendor for 1g on the market — clearing quickly is worthless if the
      // price is worse than the alternative that was always available.
      const ask = this.bestAsk(item);
      const floor = this.vendorValue(item);
      const wanted = ask ? ask - 1 : (this.state.marketPrices[item] || ITEMS[item]?.sell || 1);
      if (wanted < floor) {
        this.log(`[econ] keeping ${qty}× ${item}: market wants ${wanted}g, the vendor pays ${floor}g`);
        continue;
      }
      const price = Math.max(MARKET.minPrice, wanted);
      await this.list(item, qty, price);
      this.listed.count += 1;
      this.log(`[econ] listed ${qty}× ${item} @ ${price}g (vendor would pay ${this.vendorValue(item)})`);
      listed++;
    }
    return listed;
  }

  // --- buy orders ---------------------------------------------------------
  // Other players post standing buy orders with the gold already escrowed, so filling one is an
  // INSTANT sale at a price they set — frequently far above both the vendor and the cheapest ask.
  // The live book has carried orders like moonfin_pearl at 8,000g. Checking them before dumping a
  // stack at the vendor is the single most profitable habit in the market.
  bestBuyOrder(item) {
    let best = null;
    for (const o of this.state.buyOrders || []) {
      if (o.item !== item || o.mine) continue;
      if (!(o.remaining > 0)) continue;
      if (!best || o.price > best.price) best = o;
    }
    return best;
  }

  // Fill every standing order that beats what we'd otherwise get for the stack.
  async fillBuyOrders({ minEdge = 1.15 } = {}) {
    const inv = { ...(this.state.me?.inv || {}) };
    const filled = [];
    for (const [item, qty] of Object.entries(inv)) {
      if (!qty || this.route(item) === 'keep') continue;
      const order = this.bestBuyOrder(item);
      if (!order) continue;
      const alternative = Math.max(this.vendorValue(item), this.marketValue(item), 1);
      if (order.price < alternative * minEdge) continue;   // not worth the frame
      const take = Math.min(qty, order.remaining);
      this.net.send({ t: 'fillBuyOrder', id: order.id, qty: take });
      await sleep(500);
      filled.push({ item, qty: take, price: order.price, alternative });
      this.log(`[econ] filled a buy order: ${take}× ${item} @ ${order.price}g (else ~${alternative}g)`);
    }
    return filled;
  }

  // --- repair -------------------------------------------------------------
  // Durability decays with use and broken gear stops contributing its damage entirely, which is a
  // silent, compounding loss — the character keeps swinging and just hits softer.
  gearNeedingRepair() {
    const me = this.state.me || {};
    const dura = me.dura || {};
    const worn = [me.appearance?.weapon, me.appearance?.shield, me.appearance?.outfit, me.appearance?.hat].filter(Boolean);
    return worn.filter((id) => wears(id) && duraOf(dura, id) < DURA.max * 0.35)
      .map((id) => ({ id, dura: duraOf(dura, id), broken: isBroken(dura, id), cost: repairCost(dura, id) }));
  }

  async repairGear() {
    const need = this.gearNeedingRepair();
    if (!need.length) return [];
    const affordable = need.filter((g) => g.cost <= (this.state.me?.gold || 0));
    if (!affordable.length) return [];
    await this.move.walkTo(REPAIR_SPOT.x, REPAIR_SPOT.z, { range: 3.0 });
    const done = [];
    for (const g of affordable) {
      this.net.send({ t: 'repair', id: g.id, mode: 'gold' });
      await sleep(600);
      done.push(g.id);
      this.log(`[econ] repaired ${g.id} for ~${g.cost}g${g.broken ? ' (it was broken)' : ''}`);
    }
    return done;
  }

  // --- fast travel --------------------------------------------------------
  // The valley is 200 units across and the outer realms are far past that. A walk of a few hundred
  // units is minutes of doing nothing; a hop costs 25g plus 0.6 a unit. Worth it only when the fee
  // is small against what the trip is for, so the caller passes what it expects to earn.
  nearestWaypoint(x, z) {
    let best = null, bestD = Infinity;
    for (const w of WAYPOINTS) {
      const d = Math.hypot(w.x - x, w.z - z);
      if (d < bestD) { bestD = d; best = { ...w, dist: d }; }
    }
    return best;
  }

  async fastTravelTo(x, z, { worthGold = 0 } = {}) {
    const me = this.state.pos;
    const hub = this.nearestWaypoint(x, z);
    if (!hub) return false;
    const walking = Math.hypot(x - me.x, z - me.z);
    if (walking < 120) return false;                       // not far enough to bother
    if (hub.dist > FAST_TRAVEL.hubRadius * 2) return false; // the hub does not land us near enough
    const fee = fastTravelFee(me.x, me.z, hub.x, hub.z, 0);
    if (fee > (this.state.me?.gold || 0)) return false;
    if (worthGold && fee > worthGold * 0.25) return false;  // never spend a quarter of the payoff on the trip
    this.net.send({ t: 'fastTravel', id: hub.id });
    await sleep(1500);
    this.log(`[econ] fast-travelled to ${hub.name} for ${fee}g (saved ~${Math.round(walking / 7)}s of walking)`);
    return true;
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
  // Guarantees the satchel is emptier afterwards, or reports that it cannot be. Reserving a focused
  // quest's materials from sale made this a no-op when everything sellable was reserved — the bag
  // stayed full, the sell score stayed high, and the loop picked selling six cycles running while
  // moving nothing.
  async makeRoom() {
    const before = this.used();
    // Standing buy orders first: they pay a price someone else set, frequently well above both the
    // vendor and the cheapest ask, and the gold is already escrowed so the sale is instant.
    await this.fillBuyOrders();
    const res = await this.vendorDump();
    // The vendor is capped at 1,000 a day. The PLAYER market is not capped at all — it allows 30
    // listings a head and takes 8% — so once the vendor is shut it is the only channel left that
    // still mints gold, and holding ourselves to 8 listings there was leaving the day's remaining
    // income on the floor. Open up when the counter closes.
    await this.listValuables({ maxListings: this.vendorRoom() > 0 ? 8 : Math.max(8, MARKET.maxPerPlayer - 6) });
    // Anything still here is either reserved or unsellable right now. The bank is free and
    // unlimited, so parking it beats standing at the counter again next cycle.
    if (this.used() >= before - 2) {
      this.log(`[econ] nothing cleared at the market (${this.used()}/${this.capacity()}) — banking what is not reserved`);
      await this.bankUnreserved();
    }
    this.lastSaleMoved = before - this.used();
    return res;
  }

  // Deposit everything the focused quest is NOT holding onto.
  async bankUnreserved() {
    const inv = { ...(this.state.me?.inv || {}) };
    const drop = Object.entries(inv).filter(([it, q]) => q && !this.reserved?.has(it) && !isPotion(it));
    if (!drop.length) { this.log('[econ] everything in the satchel is reserved for the objective'); return 0; }
    await this.goTo(BANK);
    this.net.send({ t: 'bankOpen' });
    await sleep(500);
    for (const [item, qty] of drop) { this.net.send({ t: 'bankDeposit', item, qty }); await sleep(250); }
    await sleep(600);
    this.log(`[econ] banked ${drop.length} stack(s) — satchel ${this.used()}/${this.capacity()}`);
    return drop.length;
  }
}
