// crafting.js — cooking, crafting and consumables. This is what makes the bot self-sufficient.
//
// Buying meals at 18g for 2 works, but it burns the gold we're here to accumulate. Fishing then
// cooking turns a free raw drop into a 30 hp ration AND pays cooking XP on the way, so the combat
// loop stops leaking gold. Crafting does the same for logs/ore: `plank` and `ingot` are worth more
// than their inputs, feed the Monument contributions, and pay crafting XP.
//
// Protocol: { t:'craft', id, qty }  — qty may be 'all' for a bulk run (server authoritative).
//           { t:'usePotion', id }
import { RECIPES, POTIONS, ITEMS, levelForXp, isPotion } from './rules.js';
import { sleep } from './movement.js';

export class Crafting {
  constructor({ net, state, move, log = console.log }) {
    this.net = net; this.state = state; this.move = move; this.log = log;
    this.stats = { crafted: 0, cooked: 0, potions: 0 };
    this.monumentNeed = null;
    this.monumentProgress = null;
    net.on('init', (m) => { if (m.monument) { this.monumentNeed = m.monument.need || null; this.monumentProgress = m.monument.progress || null; } });
    net.on('monument', (m) => { this.monumentNeed = m?.need || null; this.monumentProgress = m?.progress || null; });
  }

  skillLevel(skill) { return levelForXp((this.state.me?.skills || {})[skill] || 0); }
  inv() { return this.state.me?.inv || {}; }

  // How many times a recipe can run with what's in the satchel right now.
  canMake(recipe) {
    const inv = this.inv();
    let n = Infinity;
    for (const [item, need] of Object.entries(recipe.in)) n = Math.min(n, Math.floor((inv[item] || 0) / need));
    return Number.isFinite(n) ? n : 0;
  }

  // Recipes we have the level and the materials for.
  available(skill = null) {
    return RECIPES.filter((r) => {
      if (skill && r.skill !== skill) return false;
      if ((r.req || 1) > this.skillLevel(r.skill)) return false;
      return this.canMake(r) > 0;
    });
  }

  async craft(recipe, qty = 'all') {
    this.net.send({ t: 'craft', id: recipe.id, qty });
    await sleep(700);
    if (recipe.skill === 'cooking') this.stats.cooked++; else this.stats.crafted++;
    return recipe;
  }

  // Turn every raw fish we own into rations. Highest-XP recipe first so cooking levels while we eat.
  async cookAll() {
    const rs = this.available('cooking').sort((a, b) => (b.xp || 0) - (a.xp || 0));
    if (!rs.length) return 0;
    let made = 0;
    for (const r of rs) {
      const n = this.canMake(r);
      if (!n) continue;
      this.log(`[craft] cooking ${n}× ${r.name} (+${r.xp} xp each)`);
      await this.craft(r, 'all');
      made += n;
    }
    return made;
  }

  // Process bulk raws into goods. Skipped when the output is worth less than its inputs — some
  // low-tier conversions are XP-positive but gold-negative, and only one of those is our job here.
  async processRaws({ requireProfit = true } = {}) {
    const rs = this.available('crafting').sort((a, b) => (b.xp || 0) - (a.xp || 0));
    let made = 0;
    for (const r of rs) {
      const n = this.canMake(r);
      if (!n) continue;
      if (requireProfit && !this.recipeProfitable(r)) continue;
      this.log(`[craft] crafting ${n}× ${r.name} (+${r.xp} xp each)`);
      await this.craft(r, 'all');
      made += n;
    }
    return made;
  }

  recipeProfitable(recipe) {
    const val = (it) => this.state.marketPrices[it] ?? ITEMS[it]?.sell ?? 0;
    const inCost = Object.entries(recipe.in).reduce((a, [it, q]) => a + val(it) * q, 0);
    const outVal = Object.entries(recipe.out).reduce((a, [it, q]) => a + val(it) * q, 0);
    return outVal >= inCost;
  }

  // --- monument -----------------------------------------------------------
  // The Monument takes crafted goods and pays a quest for them. It is the only sink for `contribute`
  // and the "Give N goods to the Monument" objective cannot advance any other way.
  async contributeToMonument({ want = 6 } = {}) {
    const inv = this.inv();
    // What it accepts is whatever its current tier needs; crafted goods are the general answer.
    // Offer only what the tier still LACKS. The frame carries the tier's total requirement and its
    // progress separately, and the Great Hall wanted {plank:40, ingot:20, gem:2} with {ingot:20,
    // plank:6} already given — so ingot was full and every ingot offered came straight back
    // refused, which read as "the Monument refused what we offered".
    const need = this.monumentNeed || {};
    const done = this.monumentProgress || {};
    const remaining = Object.keys(need).filter((k) => (need[k] || 0) - (done[k] || 0) > 0);
    const wanted = remaining.length ? remaining : ['plank', 'ingot'];
    const candidates = wanted.filter((k) => (inv[k] || 0) > 0);
    if (!candidates.length) {
      // Make some first — planks and ingots are the cheapest goods and we usually hold the raws.
      const made = await this.processRaws({ requireProfit: false });
      if (!made) { this.log('[craft] nothing to give the Monument and no raws to make goods from'); return 0; }
    }

    // No walk: MONUMENT carries only the tier table, and the client sends `contribute` straight from
    // the Craft tab rather than from a world interaction — so it is not range-gated. Guessing a
    // location and walking there would have been a minute of nothing.
    let given = 0;
    for (const item of wanted) {
      let have = (this.inv()[item] || 0);
      while (have > 0 && given < want) {
        this.net.send({ t: 'contribute', item });
        await sleep(450);
        const now = (this.inv()[item] || 0);
        if (now >= have) break;            // refused — this tier doesn't want it
        given += have - now;
        have = now;
      }
      if (given >= want) break;
    }
    if (given) this.log(`[craft] gave ${given} good(s) to the Monument`);
    else {
      const short = wanted.map((k) => `${k} ${(need[k] || 0) - (done[k] || 0)} short`).join(', ');
      this.log(`[craft] nothing the Monument still needs (${short || 'tier complete'}) — we hold ${wanted.map((k) => `${k}×${this.inv()[k] || 0}`).join(' ')}`);
    }
    return given;
  }

  // --- consumables --------------------------------------------------------
  have(id) { return (this.inv()[id] || 0) > 0; }

  async use(id) {
    if (!this.have(id) || !isPotion(id)) return false;
    this.net.send({ t: 'usePotion', id });
    this.stats.potions++;
    await sleep(400);
    return true;
  }

  // Fire the right buff for the activity we're about to run. Potions are timed (xp_elixir 90 s,
  // might_brew 45 s, swift_tonic 30 s), so they're only worth drinking immediately before the work.
  async buffFor(activity) {
    const used = [];
    if (this.have('xp_elixir') && (activity === 'gather' || activity === 'combat')) {
      if (await this.use('xp_elixir')) used.push('xp_elixir');
    } else if (this.have('glow_brew') && (activity === 'gather' || activity === 'combat')) {
      if (await this.use('glow_brew')) used.push('glow_brew');
    }
    if (activity === 'combat') {
      for (const p of ['magma_tonic', 'might_brew']) {
        if (this.have(p)) { if (await this.use(p)) { used.push(p); break; } }
      }
    }
    if (activity === 'travel' && this.have('swift_tonic')) {
      if (await this.use('swift_tonic')) used.push('swift_tonic');
    }
    if (used.length) this.log(`[craft] buffed: ${used.join(', ')}`);
    return used;
  }

  // Emergency heal — a health potion is 60 hp against food's 30, so it's the panic button, not lunch.
  async emergencyHeal() {
    for (const p of ['health_potion', 'veggie_stew']) if (await this.use(p)) return true;
    return false;
  }

  rationCount() {
    const inv = this.inv();
    return Object.keys(inv).filter((k) => /^cooked/.test(k) || k === 'acorn_loaf').reduce((a, k) => a + inv[k], 0);
  }
}
