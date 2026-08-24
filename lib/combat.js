// combat.js — killing things without dying.
//
// Protocol: { t:'target', id } marks a creature hostile server-side (so it closes on us instead of
// drifting), then { t:'attack', id } every COMBAT.cooldown ms. Bosses use { t:'attackBoss', id }.
// The server gates the hit at exactly COMBAT.range, so we close well inside it.
//
// Dying is expensive: DEATH drops a sack that holds our loot for 30 minutes and must be walked back
// to and reclaimed. So target selection is a survivability calculation, not "nearest thing alive".
import { COMBAT, DEATH, creatureStats, attackDamage, attackCooldown, levelForXp, weaponDamage, affinityMul, shieldReduce, ATTACK_STYLES } from './rules.js';
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
    // How many swings this SHOULD take, with room for misses and a bad streak. Past that, the
    // creature is not really there: our copy of the world outlives a creature whose `creatureGone`
    // frame we missed, and pickTarget then hands back the same ghost every cycle. kindra-01 spent
    // most of half an hour on one stalker — ninety seconds of swinging, "broke off" at 100/100 hp,
    // re-target the identical id, again, eleven kills in thirty minutes while pinned to fight.
    const budget = Math.max(20, this.dpsAgainst(creature.level).hitsToKill * 4 + 10);
    let swings = 0;

    while (!this._stop && Date.now() < deadline) {
      const live = this.state.creatures.get(creature.id);
      if (!live || live.dead || (live.hp != null && live.hp <= 0)) { this.stats.kills++; return true; }
      if (swings >= budget) {
        // Drop it from our model as well as giving up, or the next cycle picks it straight back.
        this.state.creatures.delete(creature.id);
        this.log(`[combat] ${creature.kind} #${creature.id} took ${swings} swings and never dropped — dropping it`);
        return false;
      }

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
      swings++;
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

      this.tuneStance(target);
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
  // Combat stance — free, instant, and the single biggest survivability lever in the game. Nothing
  // in the bot was setting it, so every character fought in whatever the server defaults to.
  // `defensive` takes 15% less damage, which is larger than the shrine's Stone Vigil (-8%) and costs
  // nothing at all; `aggressive` gives +10% damage and is the right stance whenever we are not the
  // one in danger. The server echoes the change back as a toast, so this stays honest about failure.
  setStance(id) {
    if (!ATTACK_STYLES[id] || this._stance === id) return false;
    this._stance = id;
    this.net.send({ t: 'setStyle', style: id });
    this.log(`[combat] stance -> ${ATTACK_STYLES[id].name} (${ATTACK_STYLES[id].blurb})`);
    return true;
  }

  // Pick it from the situation rather than a setting: hurt, or outmatched, means we want the 15%.
  tuneStance(target = null) {
    const risky = this.hpFrac < 0.75
      || (target && this.expectedDamageTaken(target.level, this.packAround(target)) > COMBAT.playerHp * 0.4);
    return this.setStance(risky ? 'defensive' : 'aggressive');
  }

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
    this.setStance('defensive');   // whatever comes next, we are in no shape to trade blows for it
    await this.retreat();
    const deadline = Date.now() + maxMs;
    let stuckSince = Date.now(), lastHp = this.state.me?.hp ?? 0;
    let peak = lastHp, bleeds = 0;   // hp only ever rising is an assumption, not a fact — see below
    while (!this._stop && Date.now() < deadline && this.hpFrac < target) {
      await this.eatIfHurt();
      this.move.heartbeat('idle');
      await sleep(3000);
      const hp = this.state.me?.hp ?? 0;
      // Resting was never checked for safety. The loop only ever watched hp go UP: if something was
      // still swinging at us it stood in place for the full 45 seconds and healed into the damage.
      // That is 32 of this fleet's 135 deaths — the single largest cause, more than double any
      // monster in the list, and every one of them at 44-56 hp right after a fight we had just WON.
      // retreat() runs once before the loop, but a straggler that arrives afterwards, or one that
      // was never in `liveCreatures` to begin with, had forty-five uninterrupted seconds.
      if (hp < peak - 1) {
        peak = hp;
        bleeds++;
        this.log(`[combat] taking damage while resting · hp ${Math.round(hp)}/100 — breaking off`);
        await this.retreat({ tries: 4 });
        // Once is a straggler we can walk away from. Twice means whatever it is follows, and
        // standing anywhere near it is how the sack gets dropped.
        if (bleeds >= 2) break;
        stuckSince = Date.now();
        continue;
      }
      if (hp > peak) peak = hp;
      if (hp > lastHp + 0.5) { lastHp = hp; stuckSince = Date.now(); }
      // Nothing is coming. Standing here is not recovery, it is just standing — with no rations and
      // no regen arriving, the full 45 s is 45 s of nothing at 0 errors.
      else if (Date.now() - stuckSince > 12000 && !this.hasFood()) break;
    }
    const to = this.state.me?.hp ?? 0;
    const gained = to - from;
    this.log(gained > 0.5
      ? `[combat] recovered · hp ${Math.round(from)} -> ${Math.round(to)}/100`
      : `[combat] no recovery · hp ${Math.round(to)}/100, ${this.hasFood() ? 'rations did not land' : 'no rations'}`);
    return gained > 0.5;
  }

  // Our death sack holds everything we were carrying and expires in 30 minutes. Walk back and take it.
  //
  // MEASURED, and it is not good: 135 deaths, 25 sacks recovered, 134 walks that ended
  // `walkTo timed out NaNu short` — a NaN distance, which means the run began with finite numbers
  // and one end of it went bad partway. 102 of those deaths produced no sack line at all. The
  // Telegram notice promising the sack "will be recovered automatically" was therefore wrong three
  // times in four.
  //
  // The entry guards in walkTo would have thrown "target with no position" if the SACK were the
  // malformed end, and that message appears nowhere in 135 deaths — so it is our own position that
  // goes non-finite mid-walk, and `me` is captured by reference before the loop. Rather than guess
  // which frame does it, this now re-reads the sack and our own position on every attempt and says
  // exactly which numbers were bad, so the next failure names its own cause instead of printing NaN.
  async reclaimSacks() {
    // No sack frame does not mean no sack. Walk back to where we fell and let the server's
    // hands-free pickup (DEATH.autoRange, 6.0) do the rest — that is the only route when the
    // announcement never arrives, which is 34 deaths out of 45.
    const spot = this.state.deathSpot;
    if (!this.state.sacks.size && spot && Date.now() - spot.at < DEATH.sackTtlMs) {
      try {
        this.log(`[combat] corpse run to (${Math.round(spot.x)}, ${Math.round(spot.z)}) — nothing announced, going on last known position`);
        await this.move.walkTo(spot.x, spot.z, { range: DEATH.autoRange - 2 });
        // Standing there is usually enough; ask anyway for whatever the server has for us.
        for (const sack of this.state.sacks.values()) this.net.send({ t: 'reclaim', id: sack.id });
        await sleep(1200);
        this.log(`[combat] corpse run done · satchel ${this.state.invTotal()}`);
      } catch (e) {
        this.log(`[combat] corpse run failed: ${e.message}`);
      }
      // One attempt per death, whatever the outcome — a sack we cannot reach is not worth a second
      // trek, and the 30-minute clock is running against every other thing we could be doing.
      this.state.deathSpot = null;
    }
    for (const sack of this.state.sacks.values()) {
      if (sack.owner && sack.owner !== this.state.me?.name) continue;
      const at = { x: sack.x, z: sack.z };
      if (!Number.isFinite(at.x) || !Number.isFinite(at.z)) {
        this.log(`[combat] sack ${sack.id} has no position (${JSON.stringify(sack).slice(0, 120)}) — cannot walk to it`);
        continue;
      }
      try {
        await this.move.walkTo(at.x, at.z, { range: DEATH.reclaimRange - 1.2 });
        // The server can reject a reclaim on leash skew, so retry the way the real client does.
        for (let i = 0; i < 6 && this.state.sacks.has(sack.id); i++) {
          this.net.send({ t: 'reclaim', id: sack.id });
          await sleep(800);
        }
        this.log(`[combat] reclaimed sack ${sack.id}`);
      } catch (e) {
        const me = this.state.pos || {};
        this.log(`[combat] sack ${sack.id} unreachable: ${e.message} · sack was (${at.x}, ${at.z}), we were at (${me.x}, ${me.z})`);
      }
    }
  }
}
