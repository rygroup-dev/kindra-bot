// combat.js — killing things without dying.
//
// Protocol: { t:'target', id } marks a creature hostile server-side (so it closes on us instead of
// drifting), then { t:'attack', id } every COMBAT.cooldown ms. Bosses use { t:'attackBoss', id }.
// The server gates the hit at exactly COMBAT.range, so we close well inside it.
//
// Dying is expensive: DEATH drops a sack that holds our loot for 30 minutes and must be walked back
// to and reclaimed. So target selection is a survivability calculation, not "nearest thing alive".
import { COMBAT, DEATH, creatureStats, attackDamage, attackCooldown, levelForXp, weaponDamage, affinityMul, shieldReduce } from './rules.js';
import { sleep } from './movement.js';
import { human } from './stealth.js';

const CLOSE_RANGE = 2.6;      // server gates at 3.2 — stand inside so leash skew can't cross it
const EAT_AT = 0.45;          // eat below 45% hp; foodHeal is 30 of 100

export class Combat {
  constructor({ net, state, move, log = console.log }) {
    this.net = net; this.state = state; this.move = move; this.log = log;
    this.stats = { kills: 0, deaths: 0, xp: 0 };
    this._stop = false;
    this._lastEat = 0;

    net.on('ko', (m) => { if (m.id === this.state.me?.id) { this.stats.deaths++; this.log('[combat] we died'); } });
  }

  stop() { this._stop = true; this.move.stop(); }

  get hpFrac() { return (this.state.me?.hp ?? 100) / COMBAT.playerHp; }

  myCombatLevel() { return levelForXp((this.state.me?.skills || {}).combat || 0); }

  // Our damage per swing against anything, and how long a given creature takes to kill.
  dpsAgainst(level) {
    const app = this.state.me?.appearance || {};
    const wd = weaponDamage(app.weapon) || 0;
    // A weapon matching the character's calling hits 12% harder. Ignoring it under-rates our own
    // damage and makes the survivability check refuse fights we would comfortably win.
    const aff = affinityMul(app.character, app.weapon);
    const { dmg } = attackDamage(this.myCombatLevel(), wd, aff, 1);   // critRoll 1 => never crit, so this is the floor
    const cd = attackCooldown(this.state.me?.appearance) / 1000;
    const { hp } = creatureStats(level);
    return { dmg, cd, hitsToKill: Math.ceil(hp / Math.max(1, dmg)), secsToKill: Math.ceil(hp / Math.max(1, dmg)) * cd };
  }

  // Damage we expect to eat while killing it — the creature swings every creatureAtkCd ms.
  // `packSize` matters: creatures aggro within COMBAT.aggroLeash, so a lone-target estimate is
  // fiction in a spawn cluster. The first live test picked a Lv-9 prowler at combat Lv 1, cleared
  // the solo maths, pulled its neighbours and died — so the pack is priced in here.
  expectedDamageTaken(level, packSize = 1) {
    const { secsToKill } = this.dpsAgainst(level);
    const { dmg } = creatureStats(level);
    const reduce = shieldReduce(this.state.me?.appearance?.shield) || 0;
    return (secsToKill / (COMBAT.creatureAtkCd / 1000)) * dmg * packSize * (1 - reduce);
  }

  // How many other live creatures sit close enough to join in.
  packAround(target, radius = COMBAT.aggroLeash * 0.5) {
    let n = 0;
    for (const c of this.state.creatures.values()) {
      if (c.dead || (c.hp != null && c.hp <= 0)) continue;
      if (Math.hypot(c.x - target.x, c.z - target.z) <= radius) n++;
    }
    return Math.max(1, n);
  }

  // Do we have anything to heal with? `eat` answers "No cooked fish" when we don't, and an
  // eatIfHurt that silently no-ops turns a survivable fight into a death.
  hasFood() {
    const inv = this.state.me?.inv || {};
    return (inv.cookedfish || 0) + (inv.cooked_perch || 0) + (inv.acorn_loaf || 0) + (inv.meal || 0) > 0;
  }

  // Only fight what we survive with margin. Without food there is no second chance mid-fight, so
  // the margin nearly doubles.
  canSafelyFight(level, packSize = 1) {
    const margin = this.hasFood() ? 1.8 : 3.0;
    // Measure against the health we'd START with, not the health we have while still regenerating.
    return this.expectedDamageTaken(level, packSize) * margin < COMBAT.playerHp * Math.min(this.hpFrac, 1);
  }

  // Best XP-per-second target we can actually survive.
  // `kinds` restricts the hunt to one region's creatures, which is what a quest like "Slay 8
  // Murkfen monsters" actually asks for — killing valley critters advances it by zero.
  pickTarget({ maxLevel = 99, kinds = null } = {}) {
    const me = this.state.pos;
    // Never punch far above our weight even if the arithmetic says we'd scrape through.
    const ceiling = Math.min(maxLevel, this.myCombatLevel() + (this.hasFood() ? 4 : 2));
    let best = null, bestScore = -1;
    for (const c of this.state.liveCreatures({ maxLevel: ceiling, kinds })) {
      if (this.realms && !this.realms.reachable(c.x, c.z)) continue;   // behind a portal
      if (!this.canSafelyFight(c.level, this.packAround(c))) continue;
      const { secsToKill } = this.dpsAgainst(c.level);
      const { xp } = creatureStats(c.level);
      const travel = Math.hypot(c.x - me.x, c.z - me.z) / this.move.speed;
      const score = xp / (travel + secsToKill + 1);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  async eatIfHurt() {
    if (this.hpFrac > EAT_AT) return false;
    if (!this.hasFood()) return false;
    if (Date.now() - this._lastEat < COMBAT.consumeMs) return false;
    this._lastEat = Date.now();
    this.net.send({ t: 'eat' });
    await sleep(COMBAT.consumeMs);
    return true;
  }

  // Fight one creature to the death (its, ideally). Returns true on a kill.
  async fight(creature) {
    const cd = attackCooldown(this.state.me?.appearance);
    this.net.send({ t: 'target', id: creature.id });
    const deadline = Date.now() + 90000;

    while (!this._stop && Date.now() < deadline) {
      const live = this.state.creatures.get(creature.id);
      if (!live || live.dead || (live.hp != null && live.hp <= 0)) { this.stats.kills++; return true; }

      // Losing the exchange — disengage before we hand the valley a loot sack.
      if (this.hpFrac < 0.3) {
        const ate = await this.eatIfHurt();
        if (!ate && this.hpFrac < 0.22) { this.log('[combat] disengaging, hp too low'); return false; }
      } else {
        await this.eatIfHurt();
      }

      const d = this.move.distanceTo(live);
      if (d > CLOSE_RANGE) {
        try { await this.move.walkToward(live, { range: CLOSE_RANGE, timeoutMs: 20000, anim: 'run' }); }
        catch { return false; }   // it fled or we're blocked — re-pick
        continue;
      }

      this.net.send({ t: 'attack', id: creature.id });
      await sleep(human(cd, 0.12));   // server-side cooldown is the floor; humans overshoot it unevenly
      this.move.heartbeat('attack');
    }
    return false;
  }

  // Grind until told to stop. `stopWhen` is how the orchestrator pulls us off a spent gold cap.
  async run({ stopWhen = () => false, maxLevel = 99, maxMs = 15 * 60 * 1000, kinds = null } = {}) {
    this._stop = false;
    const started = Date.now();

    while (!this._stop && Date.now() - started < maxMs) {
      if (stopWhen(this)) break;

      // Out of combat we regen 2 hp/s after a 6 s delay — cheaper than food, so top up before
      // picking a fight rather than eating through the fight. But standing still to regenerate in
      // the middle of a spawn cluster is how a character dies at 29% hp with nothing attacking it
      // yet: aggro reaches 24 units. Back away from the nearest creature first.
      if (this.hpFrac < 0.6) {
        await this.eatIfHurt();
        await this.retreat();
        this.move.heartbeat('idle');
        await sleep(3000);
        continue;
      }

      const target = this.pickTarget({ maxLevel, kinds });
      if (!target) {
        // Silence here was indistinguishable from a hang. Say so, at most every 20 s.
        if (Date.now() - (this._lastNoTarget || 0) > 20000) {
          this._lastNoTarget = Date.now();
          this.log(`[combat] nothing safe to fight${kinds ? ` among ${kinds.length} target kind(s)` : ''} (lvl ${this.myCombatLevel()}, food ${this.hasFood() ? 'yes' : 'no'}, hp ${(this.hpFrac * 100).toFixed(0)}%)`);
        }
        await sleep(3000); continue;
      }

      this.log(`[combat] -> ${target.kind} Lv${target.level} #${target.id} (${this.move.distanceTo(target).toFixed(0)}u, pack ${this.packAround(target)})`);
      try { await this.move.walkToward(target, { range: CLOSE_RANGE, timeoutMs: 30000 }); }
      catch (e) { this.state.creatures.delete(target.id); continue; }

      const won = await this.fight(target);
      this.log(`[combat] ${target.kind} Lv${target.level}: ${won ? 'killed' : 'broke off'} · hp ${this.state.me?.hp}/100 · kills ${this.stats.kills}`);
    }
    return { ...this.stats };
  }

  // Step out of aggro range of whatever is closest, so regeneration actually happens. Cheap, and
  // it costs a few seconds against a corpse run that costs thirty minutes of loot.
  // Retreating from the single nearest creature walks straight out of one aggro radius into the
  // next one's — kindra-13 died at 55% hp doing exactly that with a pack around it. Back away from
  // the *centroid* of everything in range instead, and check afterwards that we are actually clear.
  async retreat({ tries = 3 } = {}) {
    for (let i = 0; i < tries; i++) {
      const me = this.state.pos;
      const near = this.state.liveCreatures({})
        .map((c) => ({ c, d: Math.hypot(c.x - me.x, c.z - me.z) }))
        .filter((x) => x.d < COMBAT.aggroLeash);
      if (!near.length) return i > 0;
      // Weight by closeness so the thing breathing on us decides the direction more than a straggler.
      let dx = 0, dz = 0;
      for (const { c, d } of near) {
        const w = 1 / Math.max(1, d);
        dx += (me.x - c.x) * w; dz += (me.z - c.z) * w;
      }
      const len = Math.hypot(dx, dz) || 1;
      const step = COMBAT.aggroLeash + 6;
      try {
        await this.move.walkTo(me.x + (dx / len) * step, me.z + (dz / len) * step,
          { range: 2.0, timeoutMs: 12000, anim: 'run' });
      } catch { return false; }
    }
    return true;
  }

  // Both deaths on 2026-08-22 happened *between* activities, not in a fight: the character finished
  // a kill at 51-59% hp, the orchestrator switched it to mining, and aggro (leash 24u) finished it
  // on the walk. `fight()` guards hp and `run()` guards hp, but neither owns the character once the
  // orchestrator moves on — so the gate has to live before the next activity, not inside combat.
  // Step out of the spawn cluster, eat if that is cheaper than waiting, then let the 2 hp/s
  // out-of-combat regen do the rest before anyone walks anywhere.
  async recover({ floor = 0.65, target = 0.9, maxMs = 45000 } = {}) {
    if (this.hpFrac >= floor) return false;
    const from = this.state.me?.hp ?? 0;
    this.log(`[combat] recovering before next activity · hp ${from}/100`);
    await this.retreat();
    const deadline = Date.now() + maxMs;
    while (!this._stop && Date.now() < deadline && this.hpFrac < target) {
      await this.eatIfHurt();
      this.move.heartbeat('idle');
      await sleep(3000);
    }
    this.log(`[combat] recovered · hp ${from} -> ${this.state.me?.hp ?? '?'}/100`);
    return true;
  }

  // Our death sack holds everything we were carrying and expires in 30 minutes. Walk back and take it.
  async reclaimSacks() {
    for (const sack of this.state.sacks.values()) {
      if (sack.owner && sack.owner !== this.state.me?.name) continue;
      try {
        await this.move.walkTo(sack.x, sack.z, { range: DEATH.reclaimRange - 1.2 });
        // The server can reject a reclaim on leash skew, so retry the way the real client does.
        for (let i = 0; i < 6 && this.state.sacks.has(sack.id); i++) {
          this.net.send({ t: 'reclaim', id: sack.id });
          await sleep(800);
        }
        this.log(`[combat] reclaimed sack ${sack.id}`);
      } catch (e) { this.log(`[combat] sack ${sack.id} unreachable: ${e.message}`); }
    }
  }
}
