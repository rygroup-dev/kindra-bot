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
import { TOOLS, GADGETS, SATCHELS, levelForXp, satchelCap } from './rules.js';
import { MARKET_HOUSE } from './economy.js';
import { sleep } from './movement.js';

const FLOAT = 250;   // never spend below this — food and repairs come first

export class Upgrades {
  constructor({ net, state, economy, log = console.log }) {
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

  // Everything worth buying right now, cheapest-payback first.
  plan() {
    const g = this.gold();
    const wants = [];

    // 1. Tools — the biggest multiplier per gold spent, and they gate on skill level so the list
    //    grows naturally as the bot levels.
    for (const skill of ['woodcutting', 'mining', 'foraging', 'fishing']) {
      const t = this.bestToolFor(skill);
      if (t) wants.push({ kind: 'tool', id: t.id, cost: t.cost, why: `${skill} ×${t.speed} speed, +${Math.round(t.yield * 100)}% yield` });
    }

    // 2. Satchel — a bigger bag means fewer market round-trips, and every trip is minutes not spent
    //    gathering. Only worth it once we can afford it without starving the tool budget.
    const curCap = satchelCap(this.state.me?.satchel || 'worn_satchel');
    const nextBag = Object.values(SATCHELS).filter((s) => s.cap > curCap).sort((a, b) => a.cap - b.cap)[0];
    if (nextBag) wants.push({ kind: 'satchel', id: nextBag.id, cost: nextBag.cost, why: `bag ${curCap} → ${nextBag.cap}` });

    // 3. Permanent gadgets — expensive, but they never expire and stack with everything.
    for (const gid of ['naturalists_journal', 'gatherers_satchel', 'shovel']) {
      const gd = GADGETS[gid];
      if (gd && !this.hasGadget(gid)) wants.push({ kind: 'gadget', id: gid, cost: gd.cost, why: gd.desc });
    }

    // Cheapest first: fast paybacks compound into the expensive ones.
    return wants.sort((a, b) => a.cost - b.cost).map((w) => ({ ...w, affordable: g - w.cost >= FLOAT }));
  }

  async buy(item) {
    this.net.send({ t: 'buy', id: item.id, currency: 'gold' });
    await sleep(600);
    this.bought.push(item.id);
    this.log(`[upgrade] bought ${item.id} for ${item.cost}g — ${item.why}`);
    return true;
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

  report() {
    const plan = this.plan();
    if (!plan.length) return 'fully upgraded for this level';
    return plan.slice(0, 6).map((p) => `${p.affordable ? '✅' : '🔒'} ${p.id} ${p.cost}g — ${p.why}`).join('\n');
  }
}
