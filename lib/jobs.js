// jobs.js — the Trade Roads. A third capped gold source (2,000/day) that uses none of the others.
//
// The loop: buy cargo at one trade post, haul it to another, sell. Tier 1 is 500g in, 680g out plus
// a distance multiplier, and 120 job xp. Cargo slows you to 0.8× and bandits ambush en route
// (25% on tier 1, rising with the tier), so the two real decisions are which tier to carry and
// whether to take the `wild` variant.
//
// We take neither risk by default: `wild` pays ~25% more and is explicitly the dangerous version,
// and losing a 2,500g Gilded Cargo to a bandit erases twelve safe runs. The tier is capped by what
// we can afford to lose, not by what we can afford to buy.
import { JOBS, jobRouteMult, levelForXp } from './rules.js';
import { sleep } from './movement.js';

const POST_RANGE = JOBS.range || 7;

export class Jobs {
  constructor({ net, state, move, combat, log = console.log }) {
    this.net = net; this.state = state; this.move = move; this.combat = combat; this.log = log;
    this.stats = { runs: 0, profit: 0, lost: 0 };
    this._stop = false;
    net.on('cargo', (m) => { this.cargo = m; });
    net.on('caravan', (m) => { this.caravan = m; });
  }

  stop() { this._stop = true; this.move.stop(); }

  get job() { return this.state.me?.job || {}; }
  get jobLevel() { return this.job.jobLevel || 1; }
  get carrying() { return !!this.job.caravan; }

  unlocked() {
    // The unlock is on the character's overall level, and combat is the closest proxy we hold.
    const lvl = Math.max(levelForXp((this.state.me?.skills || {}).combat || 0), this.state.me?.tl || 1);
    return lvl >= (JOBS.unlockLv || 15);
  }

  // The best tier we qualify for AND can afford to lose. `wild` is never taken automatically.
  bestTier() {
    const gold = this.state.me?.gold || 0;
    const affordableLoss = gold * 0.35;   // one ambush must not end the operation
    const ok = JOBS.tiers.filter((t) => (t.jobLv || 1) <= this.jobLevel && t.cost <= gold && t.cost <= affordableLoss);
    return ok.sort((a, b) => (b.sell - b.cost) - (a.sell - a.cost))[0] || null;
  }

  post(id) { return JOBS.posts.find((p) => p.id === id); }

  nearestPost() {
    const me = this.state.pos;
    return JOBS.posts.slice().sort((a, b) =>
      Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
  }

  // Pick the destination with the best payout per second of hauling. jobRouteMult rewards distance,
  // but not enough to make the longest route automatically right — a 700-unit haul at 0.8× speed is
  // three minutes of walking through ambush country.
  bestRoute(fromId, tier) {
    let best = null, bestScore = -1;
    const from = this.post(fromId);
    for (const to of JOBS.posts) {
      if (to.id === fromId) continue;
      const mult = jobRouteMult(fromId, to.id);
      const payout = tier.sell * mult - tier.cost;
      const dist = Math.hypot(to.x - from.x, to.z - from.z);
      const secs = dist / (this.move.speed * (tier.speed || 0.8));
      const score = payout / (secs + 20);
      if (score > bestScore) { bestScore = score; best = { to, mult, payout, secs }; }
    }
    return best;
  }

  // One complete haul. Returns what it earned, or why it didn't run.
  async runOnce({ maxMs = 8 * 60 * 1000 } = {}) {
    this._stop = false;
    if (!this.unlocked()) return { ran: false, reason: `Trade Roads unlock at Lv ${JOBS.unlockLv}` };

    // Finish an interrupted haul before starting a new one.
    if (this.carrying) {
      this.log('[jobs] already carrying cargo — delivering it first');
      return this.deliver(maxMs);
    }

    const tier = this.bestTier();
    if (!tier) return { ran: false, reason: 'no tier affordable at a safe fraction of our gold' };

    const from = this.nearestPost();
    const route = this.bestRoute(from.id, tier);
    if (!route) return { ran: false, reason: 'no route' };

    const goldBefore = this.state.me.gold;
    this.log(`[jobs] ${tier.name} (${tier.cost}g) ${from.name} → ${route.to.name}, ~${route.payout.toFixed(0)}g in ~${route.secs.toFixed(0)}s`);

    try { await this.move.walkTo(from.x, from.z, { range: POST_RANGE - 2, timeoutMs: 120000 }); }
    catch (e) { return { ran: false, reason: `couldn't reach ${from.name}: ${e.message}` }; }

    // wild: 0 — the safe variant. The dangerous one pays ~25% more and is how cargo gets lost.
    this.net.send({ t: 'caravanBuy', tier: JOBS.tiers.indexOf(tier), wild: 0 });
    await sleep(1200);
    if (!this.carrying) return { ran: false, reason: 'the post refused the purchase' };

    this._dest = route.to;
    const r = await this.deliver(maxMs);
    const gained = this.state.me.gold - goldBefore;
    if (r.delivered) { this.stats.runs++; this.stats.profit += gained; }
    return { ran: true, ...r, gained };
  }

  // Walk the cargo to the destination and sell it. Bandits may interrupt; the cargo survives as long
  // as we do, so a fight on the road is fought, not fled.
  async deliver(maxMs) {
    const dest = this._dest || this.post(this.job.caravan?.to) || this.nearestPost();
    const deadline = Date.now() + maxMs;

    while (!this._stop && Date.now() < deadline) {
      if (!this.carrying) break;   // sold, or lost to an ambush

      // Ambushed: bandits are on us and running with cargo just means dying tired.
      if (this.combat && this.combat.hpFrac < 0.55) {
        await this.combat.eatIfHurt();
        if (this.combat.hpFrac < 0.3) {
          this.log('[jobs] ambush going badly — dropping cargo to survive');
          this.net.send({ t: 'caravanDrop' });
          this.stats.lost++;
          await sleep(800);
          return { delivered: false, reason: 'dropped under ambush' };
        }
      }

      const d = Math.hypot(dest.x - this.state.pos.x, dest.z - this.state.pos.z);
      if (d <= POST_RANGE - 2) {
        this.net.send({ t: 'caravanSell' });
        await sleep(1200);
        this.log(`[jobs] delivered to ${dest.name} — gold ${this.state.me.gold}`);
        return { delivered: true, post: dest.id };
      }

      try { await this.move.walkTo(dest.x, dest.z, { range: POST_RANGE - 2, timeoutMs: 60000, anim: 'run' }); }
      catch (e) { this.log(`[jobs] haul interrupted: ${e.message}`); await sleep(1500); }
    }
    return { delivered: false, reason: 'timed out en route' };
  }

  report() {
    if (!this.unlocked()) return `locked until Lv ${JOBS.unlockLv}`;
    const t = this.bestTier();
    return [
      `job Lv ${this.jobLevel} · runs ${this.stats.runs} · profit +${this.stats.profit}g · lost ${this.stats.lost}`,
      t ? `next: ${t.name} (${t.cost}g in, ${t.sell}g base out)` : 'no tier affordable yet',
      this.carrying ? 'currently hauling cargo' : '',
    ].filter(Boolean).join('\n');
  }
}
