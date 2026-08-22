// garden.js — 8 plots in town that print foraging XP while the bot is elsewhere.
//
// This is the only activity in the game that earns while you are not doing it. A sunflower is 40g of
// seed for 60 xp on a 12-minute timer; the bot plants all eight, walks away to gather or fight, and
// harvests on its next pass through town. Crops spoil 2 hours after ripening, so the only real
// failure mode is never coming back — the orchestrator's scoring handles that by spiking the
// garden's value once something is ready.
import { GARDEN, SEEDS, cropReady, cropSpoiled } from './rules.js';
import { MARKET_HOUSE } from './economy.js';
import { sleep } from './movement.js';

const PLOT_RANGE = 2.0;

export class Garden {
  constructor({ net, state, move, log = console.log }) {
    this.net = net; this.state = state; this.move = move; this.log = log;
    this.plots = new Map();   // id -> { id, seed, plantedAt, owner }
    this.stats = { planted: 0, harvested: 0 };

    net.on('plot', (m) => {
      for (const p of (Array.isArray(m.plots) ? m.plots : [m])) {
        if (p.id == null) continue;
        if (p.cleared || p.seed === null) this.plots.delete(p.id);
        else this.plots.set(p.id, { ...(this.plots.get(p.id) || {}), ...p });
      }
    });
    net.on('init', (m) => { for (const p of m.garden || []) if (p.id != null) this.plots.set(p.id, p); });
  }

  get myName() { return this.state.me?.name; }
  mine(p) { return p && (!p.owner || p.owner === this.myName); }

  ready() {
    const now = Date.now();
    return [...this.plots.values()].filter((p) => this.mine(p) && cropReady(p, now) && !cropSpoiled(p, now));
  }

  free() {
    const taken = new Set([...this.plots.values()].filter((p) => p.seed).map((p) => p.id));
    return GARDEN.plots.filter((p) => !taken.has(p.id));
  }

  // Best seed we can afford. Sunflower is the sweet spot: 60 xp for 40g on 12 minutes, against
  // carrot's 22 xp for 15g on 5. Pumpkin is 110 xp but ties the plot up for 18.
  bestSeed() {
    const gold = this.state.me?.gold || 0;
    const inv = this.state.me?.inv || {};
    const owned = Object.values(SEEDS).filter((s) => (inv[s.id] || 0) > 0);
    if (owned.length) return owned.sort((a, b) => (b.xp / b.growMs) - (a.xp / a.growMs))[0];
    // Budget for filling the plots we actually have free, not for a single seed.
    const plots = Math.max(1, this.free().length);
    return Object.values(SEEDS)
      .filter((s) => s.cost * plots <= gold * 0.4)
      .sort((a, b) => (b.xp / b.growMs) - (a.xp / a.growMs))[0] || null;
  }

  async harvestReady() {
    let n = 0;
    for (const p of this.ready()) {
      const def = GARDEN.plots.find((x) => x.id === p.id);
      if (!def) continue;
      try {
        await this.move.walkTo(def.x, def.z, { range: PLOT_RANGE, timeoutMs: 45000 });
        this.net.send({ t: 'harvest', plot: p.id });
        await sleep(700);
        n++; this.stats.harvested++;
      } catch (e) { this.log(`[garden] plot ${p.id} unreachable: ${e.message}`); }
    }
    if (n) this.log(`[garden] harvested ${n} plot(s)`);
    return n;
  }

  // Seeds have to be BOUGHT before they can be planted. bestSeed() only picks from the catalogue by
  // price; without this the bot walked to every plot and sent `plant` for a seed it did not own, and
  // the server refused all eight silently — "planted 0" with no error to explain it.
  async buySeeds(seed, count) {
    const have = (this.state.me?.inv || {})[seed.id] || 0;
    const want = Math.max(0, count - have);
    if (!want) return have;
    const afford = Math.min(want, Math.floor((this.state.me?.gold || 0) / seed.cost));
    if (afford <= 0) return have;
    await this.move.walkTo(MARKET_HOUSE.x, MARKET_HOUSE.z, { range: 3.0 });
    this.net.send({ t: 'requestMerchant' });
    await sleep(400);
    for (let i = 0; i < afford; i++) {
      this.net.send({ t: 'buy', id: seed.id, currency: 'gold' });
      await sleep(300);
    }
    await sleep(500);
    const now = (this.state.me?.inv || {})[seed.id] || 0;
    this.log(`[garden] bought ${now - have} × ${seed.name} (${seed.cost}g each)`);
    return now;
  }

  async plantAll() {
    const plots = this.free();
    const seed = this.bestSeed();
    // Never fail silently here. Two separate rounds of this bug looked identical from the log —
    // "planted 0" with no reason — because every early return was quiet.
    if (!plots.length) { this.log('[garden] all plots are occupied'); return 0; }
    if (!seed) {
      const cheapest = Object.values(SEEDS).sort((a, b) => a.cost - b.cost)[0];
      this.log(`[garden] no affordable seed: ${plots.length} plot(s) × ${cheapest.name} ${cheapest.cost}g = ${cheapest.cost * plots.length}g, budget is 40% of ${this.state.me?.gold || 0}g`);
      return 0;
    }
    await this.buySeeds(seed, plots.length);
    if (!((this.state.me?.inv || {})[seed.id] > 0)) {
      this.log(`[garden] no ${seed.name} to plant (need ${seed.cost}g each)`);
      return 0;
    }
    let n = 0;
    for (const def of plots) {
      const inv = this.state.me?.inv || {};
      if (!(inv[seed.id] > 0)) break;
      try {
        await this.move.walkTo(def.x, def.z, { range: PLOT_RANGE, timeoutMs: 45000 });
        this.net.send({ t: 'plant', plot: def.id, seed: seed.id });
        await sleep(700);
        n++; this.stats.planted++;
      } catch (e) { this.log(`[garden] plot ${def.id} unreachable: ${e.message}`); }
    }
    if (n) this.log(`[garden] planted ${n} × ${seed.name} (+${seed.xp} xp each in ${Math.round(seed.growMs / 60000)}m)`);
    return n;
  }

  // One pass: take what's ripe, then fill every empty plot.
  async tend() {
    const harvested = await this.harvestReady();
    const planted = await this.plantAll();
    return { harvested, planted };
  }

  // When the next crop comes up, in ms (Infinity if nothing is growing).
  nextReadyIn() {
    const now = Date.now();
    let soonest = Infinity;
    for (const p of this.plots.values()) {
      if (!this.mine(p) || !p.seed) continue;
      const s = SEEDS[p.seed]; if (!s) continue;
      const left = (p.plantedAt + s.growMs) - now;
      if (left > 0 && left < soonest) soonest = left;
    }
    return soonest;
  }

  report() {
    const now = Date.now();
    const rows = GARDEN.plots.map((d) => {
      const p = this.plots.get(d.id);
      if (!p || !p.seed) return `plot ${d.id}: empty`;
      const s = SEEDS[p.seed];
      if (cropSpoiled(p, now)) return `plot ${d.id}: ${s?.crop || p.seed} SPOILED`;
      if (cropReady(p, now)) return `plot ${d.id}: ${s?.crop || p.seed} READY`;
      const left = Math.max(0, (p.plantedAt + (s?.growMs || 0)) - now);
      return `plot ${d.id}: ${s?.crop || p.seed} ${Math.ceil(left / 60000)}m`;
    });
    return rows.join('\n');
  }
}
