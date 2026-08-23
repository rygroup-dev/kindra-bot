// upgrades.js — spending gold so the bot earns faster.
//
// Gold sitting in the satchel does nothing. Gold spent on a tool is a permanent multiplier on every
// future swing, and the payback is short enough to be obvious:
//
//   stone_axe   70g   speed ×1.15  → pays for itself in well under an hour
//   iron_axe   320g   speed ×1.35 + yield +12%   (needs Lv 8)
//   naturalists_journal 3500g  +15% XP on ALL gathering, forever
//   explorers_rucksack  5000g  cap 100 → 550, which is 5× fewer round trips to the market
//
// The ordering below is deliberate: cheap tools first (fastest payback), then the satchel (fewer
// interruptions compounds with everything else), then the permanent gadgets. A float is always kept
// back so an upgrade never leaves the bot unable to buy food.
import { TOOLS, GADGETS, SATCHELS, WEAPONS, SHIELDS, UNARMED_ACC, classAffinity, gearValue, levelForXp, satchelCap } from './rules.js';
import { MARKET_HOUSE } from './economy.js';
import { sleep } from './movement.js';

const FLOAT = 250;   // never spend below this — food and repairs come first

// What fraction a gadget adds to GOLD income, read from its own fields rather than its prose.
//   `yield`  — find chance, which is straight extra drops, and drops are most of a node's value
//   `skill`  — scoped to one skill, so it only pays while working that one. Half credit: a
//              character splits its time, and even a gold-focused one sells and fights between
//              runs. Deliberately conservative — over-crediting buys a 1,500g thing too early.
//   `xp`     — experience only. Zero coin, forever, whatever the price tag says.
//   `dig`    — the shovel: twelve caches a day at ~16g each is ~196g/day against roughly 14,000
//              gold an hour of gathering. Real, but small enough to rank behind everything.
function gadgetGain(gd) {
  if (gd.yield) return gd.skill ? gd.yield * 0.5 : gd.yield;
  if (gd.dig) return 0.003;
  return 0;   // xp-only
}

export class Upgrades {
  constructor({ net, state, economy, log = console.log }) {
    // Set with the fleet's mode: in gold mode nothing that cannot pay for itself in coin is bought.
    this.goldMode = false;
    this.net = net; this.state = state; this.economy = economy; this.log = log;
    this.bought = [];
  }

  gold() { return this.state.me?.gold || 0; }
  owned() { return this.state.me?.owned || {}; }
  tools() { return this.state.me?.tools || {}; }

  hasGadget(id) {
    const o = this.owned();
    return [o.upgrades, o.gadgets, o.tools].filter(Array.isArray).some((l) => l.includes(id));
  }

  skillLevel(skill) { return levelForXp((this.state.me?.skills || {})[skill] || 0); }

  // The best tool we qualify for in a skill, and whether we already have it (or better).
  bestToolFor(skill) {
    const lvl = this.skillLevel(skill);
    const owned = this.tools()[skill];
    const ownedTier = owned ? (TOOLS[owned]?.tier || 0) : 0;
    const candidates = Object.values(TOOLS)
      .filter((t) => t.skill === skill && t.req <= lvl && t.tier > ownedTier)
      .sort((a, b) => b.tier - a.tier);
    return candidates[0] || null;
  }

  // The best weapon we qualify for, preferring our class's affinity type. Unarmed is +0 damage and
  // accuracy 10; a 50g wooden sword is +3 and accuracy 18, and a 260g iron sword is +7 and 24. At
  // low combat levels that is the difference between doubling our damage and not — the single
  // largest combat upgrade available, and the bot was fighting bare-handed without it.
  bestWeapon() {
    const lvl = this.skillLevel('combat');
    const owned = this.state.me?.appearance?.weapon;
    const ownedDmg = owned ? (WEAPONS[owned]?.dmg || 0) : 0;
    // classAffinity takes the CHARACTER name, not the appearance object.
    const affinity = classAffinity(this.state.me?.appearance?.character);
    return Object.values(WEAPONS)
      .filter((w) => (w.req || 1) <= lvl && (w.dmg || 0) > ownedDmg && this.purchasable(w))
      .sort((a, b) => {
        const aff = (x) => (affinity && x.wtype === affinity ? 1 : 0);
        return (aff(b) - aff(a)) || (b.dmg - a.dmg);
      })[0] || null;
  }

  bestShield() {
    const lvl = this.skillLevel('combat');
    const owned = this.state.me?.appearance?.shield;
    const ownedReduce = owned ? (SHIELDS[owned]?.reduce || 0) : 0;
    return Object.values(SHIELDS || {})
      .filter((x) => (x.req || 1) <= lvl && (x.reduce || 0) > ownedReduce && this.purchasable(x))
      .sort((a, b) => b.reduce - a.reduce)[0] || null;
  }

  // Only things the shop will actually sell for gold. Sealed variants (Lunaris/Solaris) are
  // one-in-sixty-thousand drops and material-gated gear is a crafting result — both carry no price,
  // and buying them logged a purchase of "nullg" that never happened.
  purchasable(def) {
    return def && typeof def.cost === 'number' && def.cost > 0 && !def.mat && !def.seal;
  }

  owns(id) {
    const o = this.owned();
    return [o.weapons, o.shields, o.hats, o.outfits].filter(Array.isArray).some((l) => l.includes(id));
  }

  // Everything worth buying right now, cheapest-payback first.
  plan() {
    const g = this.gold();
    const wants = [];

    // 0. A weapon first. Nothing else in the shop changes combat as much, and combat is the only
    //    skill that moves account level at full weight.
    const w = this.bestWeapon();
    if (w) wants.push({ kind: 'weapon', slot: 'weapon', id: w.id, cost: w.cost, why: `+${w.dmg} dmg, ${w.acc} accuracy (unarmed is 0 / ${UNARMED_ACC})` });
    const sh = this.bestShield();
    if (sh) wants.push({ kind: 'shield', slot: 'shield', id: sh.id, cost: sh.cost, why: `−${Math.round(sh.reduce * 100)}% damage taken` });

    // 1. Tools — the biggest multiplier per gold spent, and they gate on skill level so the list
    //    grows naturally as the bot levels.
    for (const skill of ['woodcutting', 'mining', 'foraging', 'fishing']) {
      const t = this.bestToolFor(skill);
      if (t) wants.push({ kind: 'tool', id: t.id, cost: t.cost, gain: Math.max(0.05, t.speed * (1 + (t.yield || 0)) - 1),
        why: `${skill} ×${t.speed} speed, +${Math.round(t.yield * 100)}% yield` });
    }

    // 2. Satchel — a bigger bag means fewer market round-trips, and every trip is minutes not spent
    //    gathering. Only worth it once we can afford it without starving the tool budget.
    const curCap = satchelCap(this.state.me?.satchel || 'worn_satchel');
    const nextBag = Object.values(SATCHELS).filter((s) => s.cap > curCap).sort((a, b) => a.cap - b.cap)[0];
    // A bigger bag buys back the minutes spent walking to the counter, so its gain scales with how
    // much less often we have to go: doubling the bag halves the trips.
    if (nextBag) wants.push({ kind: 'satchel', id: nextBag.id, cost: nextBag.cost,
      gain: Math.max(0.05, (1 - curCap / nextBag.cap) * 0.25), why: `bag ${curCap} → ${nextBag.cap}` });

    // 3. Permanent gadgets, ALL of them — read from the table rather than a list of three names.
    //    The hardcoded trio offered the two worst buys in the shop and hid the four best: a
    //    naturalists_journal is 3,500g for +15% XP, which at a measured 236 gold/min of gathering
    //    pays back NEVER in coin, and a shovel is 800g for twelve daily caches worth ~196g/day, so
    //    four days. Meanwhile miners_helmet and its three siblings — 1,500g for +12% find chance —
    //    were never once offered, and pay for themselves in under an hour.
    for (const [gid, gd] of Object.entries(GADGETS)) {
      if (!gd || !this.purchasable(gd) || this.hasGadget(gid)) continue;
      wants.push({ kind: 'gadget', id: gid, cost: gd.cost, why: gd.desc, gain: gadgetGain(gd) });
    }

    // Rank by PAYBACK, not by shelf order. `gain` is the fraction it adds to gathering income, so
    // cost/gain is gold spent per unit of income bought — smallest first. A weapon still jumps the
    // queue outside gold mode, because it decides whether a fight is winnable at all and combat is
    // the only full-weight route to account level; in gold mode nothing is special.
    const payback = (x) => (x.gain > 0 ? x.cost / x.gain : Infinity);
    const rank = (x) => (this.goldMode ? 0 : x.kind === 'weapon' ? 0 : x.kind === 'shield' ? 1 : 2);
    return wants
      // In gold mode, refuse what cannot pay for itself in coin at all.
      .filter((w) => !this.goldMode || payback(w) < Infinity)
      .sort((a, b) => (rank(a) - rank(b)) || (payback(a) - payback(b)) || (a.cost - b.cost))
      .map((w) => ({ ...w, affordable: g - w.cost >= FLOAT }));
  }

  async buy(item) {
    // Belt and braces: even if the server's confirmation is missed, buying the same item twice in
    // one session is always a mistake.
    if (this.bought.includes(item.id)) { this.log(`[upgrade] already bought ${item.id} this session — skipping`); return false; }
    // Owned already (a previous session, or a purchase whose confirmation we missed)? Then this is
    // an EQUIP, not a buy. Sending `buy` anyway is refused silently by the server and used to be
    // logged as a successful purchase at full price — see the gold check below.
    if (item.slot && this.owns(item.id)) {
      this.net.send({ t: 'equip', slot: item.slot, id: item.id });
      await sleep(500);
      this.bought.push(item.id);
      this.log(`[upgrade] equipped ${item.id} (already owned — nothing spent)`);
      return true;
    }
    const goldBefore = this.gold();
    this.net.send({ t: 'buy', id: item.id, currency: 'gold' });
    await sleep(700);
    // Buying puts it in the wardrobe; it does nothing until it is actually held. Weapons and
    // shields need the equip frame, and a bought-but-unequipped sword is 0 extra damage.
    if (item.slot) {
      this.net.send({ t: 'equip', slot: item.slot, id: item.id });
      await sleep(500);
    }
    // Confirm against the wardrobe rather than assuming: a refused purchase is silent, and an
    // optimistic log made an unpurchasable item look like a successful buy.
    const got = item.slot ? (this.owns(item.id) || this.state.me?.appearance?.[item.slot] === item.id) : true;
    if (!got) { this.log(`[upgrade] ${item.id} was refused (cost ${item.cost}g)`); return false; }
    this.bought.push(item.id);
    // Report what the purchase ACTUALLY cost, not what the price list says. Confirming through
    // owns() alone made a refused re-buy look like a successful one at full price: kindra-17's log
    // claimed 7,905g of purchases on 1,189g of income. Gold is the only witness that cannot lie.
    const spent = Math.max(0, goldBefore - this.gold());
    this.spent = (this.spent || 0) + spent;
    const price = spent ? `${spent}g` : `nothing (the server refused the charge)`;
    this.log(`[upgrade] bought ${item.id} for ${price} — ${item.why}${item.slot ? ' (equipped)' : ''}`);
    return true;
  }

  // Anything already owned but not held — after a death, a respec, or a purchase that raced a
  // reconnect.
  async equipOwned() {
    const app = this.state.me?.appearance || {};
    const done = [];
    for (const [slot, table] of [['weapon', WEAPONS], ['shield', SHIELDS || {}]]) {
      const held = app[slot];
      const heldScore = held ? (table[held]?.dmg ?? table[held]?.reduce ?? 0) : 0;
      const best = Object.values(table)
        .filter((x) => this.owns(x.id) && (x.req || 1) <= this.skillLevel('combat'))
        .sort((a, b) => (b.dmg ?? b.reduce ?? 0) - (a.dmg ?? a.reduce ?? 0))[0];
      if (best && (best.dmg ?? best.reduce ?? 0) > heldScore) {
        this.net.send({ t: 'equip', slot, id: best.id });
        await sleep(400);
        done.push(best.id);
        this.log(`[upgrade] equipped ${best.id}`);
      }
    }
    return done;
  }

  // Buy whatever we can afford, in order, stopping at the float. Called by the orchestrator
  // whenever we're already standing at the market with gold in hand.
  async buyAffordable({ max = 3 } = {}) {
    const plan = this.plan().filter((p) => p.affordable);
    if (!plan.length) return [];
    await this.economy.goTo(MARKET_HOUSE);
    const done = [];
    for (const item of plan.slice(0, max)) {
      if (this.gold() - item.cost < FLOAT) break;
      await this.buy(item);
      done.push(item.id);
    }
    return done;
  }

  // Gear we own but will never hold again. Buying a better sword does not remove the old one — it
  // sits in the wardrobe forever, and every tier bought leaves another behind. Equippables list on
  // the player market for gold, so a superseded weapon is a few hundred gold doing nothing.
  supersededGear() {
    const app = this.state.me?.appearance || {};
    const o = this.owned();
    const out = [];
    for (const [slot, table, list] of [
      ['weapon', WEAPONS, o.weapons],
      ['shield', SHIELDS || {}, o.shields],
    ]) {
      if (!Array.isArray(list)) continue;
      const held = app[slot];
      const heldScore = held ? (table[held]?.dmg ?? table[held]?.reduce ?? 0) : 0;
      for (const id of list) {
        if (id === held) continue;
        const def = table[id];
        if (!def) continue;
        const score = def.dmg ?? def.reduce ?? 0;
        // Keep anything better than what we hold — we may simply not meet its level yet.
        if (score >= heldScore) continue;
        out.push({ id, slot, value: gearValue(id), score });
      }
    }
    return out;
  }

  // List them just under the cheapest live ask so they actually clear, or at a fraction of shop
  // price when nobody else is selling one.
  async sellSuperseded({ maxListings = 3, economy = null } = {}) {
    const junk = this.supersededGear();
    if (!junk.length) return [];
    const listed = [];
    for (const g of junk.slice(0, maxListings)) {
      const ask = economy?.bestAsk?.(g.id) ?? null;
      const price = Math.max(1, Math.floor(ask ? ask - 1 : g.value * 0.6));
      this.net.send({ t: 'listItem', item: g.id, qty: 1, price });
      await sleep(500);
      listed.push({ id: g.id, price });
      this.log(`[upgrade] listed superseded ${g.id} @ ${price}g (shop value ${g.value})`);
    }
    return listed;
  }

  report() {
    const plan = this.plan();
    const junk = this.supersededGear();
    const lines = plan.length
      ? plan.slice(0, 6).map((p) => `${p.affordable ? '✅' : '🔒'} ${String(p.cost).padStart(5)}g ${p.id.slice(0, 18).padEnd(18)} ${p.why}`)
      : ['fully upgraded for this level'];
    if (junk.length) lines.push('', `♻️ ${junk.length} superseded item(s) to sell: ${junk.map((j) => j.id).join(', ').slice(0, 80)}`);
    return lines.join('\n');
  }
}
