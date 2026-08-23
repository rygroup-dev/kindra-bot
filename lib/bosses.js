// bosses.js — the biggest daily gold cap (5,000) and by far the fattest XP in the game.
//
// The Grove Warden alone is 900 hp for 900 xp and needs combat Lv 0 — but it lands 16 AoE damage
// every 4.2 s inside a radius of 11, and a melee character has to stand at 4.6. Tanking that solo
// at 100 hp is arithmetic that ends one way, so this module does two things a careful player does:
//
//   DODGE. `bossAoe { id, x, z, r }` announces the circle. We walk out of it and come back. Whether
//   that frame is a telegraph or the damage itself is not provable from the client source alone, so
//   the dodge is treated as a bonus, never as the safety margin — the hp thresholds below assume it
//   fails.
//
//   SHARE. Loot and the kill are split by damage contribution (BOSS_KINDRA_MIN_SHARE), so joining a
//   fight other players are already tanking pays nearly as well as leading it, at a fraction of the
//   risk. By default we only engage a boss that someone else is already hitting.
import { BOSSES, COMBAT, attackCooldown, levelForXp, bossXp, realmAt, attackDamage, weaponDamage, shieldReduce, affinityMul } from './rules.js';
import { sleep } from './movement.js';
import { human } from './stealth.js';

export class Bosses {
  constructor({ net, state, move, crafting, realms = null, label = '', log = console.log }) {
    this.net = net; this.state = state; this.move = move; this.crafting = crafting; this.log = log;
    // A raid needs both: `realms` because two of the four gold bosses live behind the isles portal,
    // and `label` because each raider stands at its own angle around the lair — a stack of three
    // characters on one spot is one slam that hits all of them.
    this.realms = realms; this.label = label;
    this.raid = null;        // pushed in by the fleet
    this.mustered = false;
    this.stats = { fights: 0, damage: 0, spoils: 0 };
    this.aoe = null;            // the live danger circle, if any
    this.lastHitBy = new Map(); // bossId -> { at, others:Set } — who else is fighting
    this._stop = false;

    net.on('bossAoe', (m) => { this.aoe = { ...m, at: Date.now() }; });
    net.on('bossHit', (m) => {
      const rec = this.lastHitBy.get(m.id) || { at: 0, others: new Set() };
      rec.at = Date.now();
      if (m.by && m.by !== this.state.me?.id) rec.others.add(m.by);
      else this.stats.damage += m.dmg || 0;
      this.lastHitBy.set(m.id, rec);
      const b = this.state.bosses.get(m.id);
      if (b && m.hp != null) this.state.bosses.set(m.id, { ...b, hp: m.hp });
    });
    net.on('bossSpoils', (m) => { this.stats.spoils++; this.log(`[boss] spoils: ${JSON.stringify(m).slice(0, 200)}`); });
    net.on('bossState', (m) => { if (m.id) this.state.bosses.set(m.id, { ...(this.state.bosses.get(m.id) || {}), ...m }); });
  }

  stop() { this._stop = true; this.move.stop(); }

  myCombatLevel() { return levelForXp((this.state.me?.skills || {}).combat || 0); }

  // How many other players hit this boss in the last 15 s.
  helpers(bossId) {
    const rec = this.lastHitBy.get(bossId);
    if (!rec || Date.now() - rec.at > 15000) return 0;
    return rec.others.size;
  }

  // A boss worth joining: alive, we meet its combat requirement, and (by default) someone else is
  // already holding its attention.
  pick({ requireHelpers = true, maxTravel = 400 } = {}) {
    const lvl = this.myCombatLevel();
    const me = this.state.pos;
    let best = null, bestScore = -1;
    for (const b of this.state.bosses.values()) {
      if (!b.alive) continue;
      const def = BOSSES[b.id] || {};
      if ((def.reqCombat ?? 0) > lvl) continue;
      const helpers = this.helpers(b.id);
      if (requireHelpers && helpers === 0) continue;
      const dist = Math.hypot((b.x ?? def.x ?? 0) - me.x, (b.z ?? def.z ?? 0) - me.z);
      if (dist > maxTravel) continue;
      // Prefer the fattest xp we can reach, discounted by the walk.
      const score = bossXp(def.hp || b.maxHp || 0) / (dist / this.move.speed + 30);
      if (score > bestScore) { bestScore = score; best = { ...def, ...b, helpers, dist }; }
    }
    return best;
  }

  // Are we standing inside a live danger circle?
  inDanger() {
    const a = this.aoe;
    if (!a || Date.now() - a.at > 2500) return null;
    const me = this.state.pos;
    const d = Math.hypot(me.x - a.x, me.z - a.z);
    return d <= (a.r || 11) ? { ...a, dist: d } : null;
  }

  // Step just outside the circle by the shortest path, then come back to the boss.
  async dodge(danger, boss) {
    const me = this.state.pos;
    const dx = me.x - danger.x, dz = me.z - danger.z;
    const len = Math.hypot(dx, dz) || 1;
    const out = (danger.r || 11) + 2.5;
    const tx = danger.x + (dx / len) * out;
    const tz = danger.z + (dz / len) * out;
    try { await this.move.walkTo(tx, tz, { range: 1.0, timeoutMs: 6000, anim: 'run' }); }
    catch { /* couldn't clear it — the hp guard below is the real safety net */ }
  }

  // Fight one boss until it dies, we run out of health, or the timer expires.
  async fight(boss, { maxMs = 5 * 60 * 1000 } = {}) {
    const def = BOSSES[boss.id] || {};
    const range = Math.max(2.5, (def.attackRange || COMBAT.range) - 1.0);
    const cd = attackCooldown(this.state.me?.appearance);
    const started = Date.now();
    const deadline = started + maxMs;
    this.stats.fights++;
    this.log(`[boss] engaging ${def.name || boss.id} (${boss.hp}/${def.hp} hp, ${boss.helpers} others fighting)`);

    let sawAlive = false;
    while (!this._stop && Date.now() < deadline) {
      const live = this.state.bosses.get(boss.id);
      // "Not in our world model" is not "dead". The server only sends bossState for bosses we can
      // see, so a lair we have travelled to but not yet had a frame for used to read as an instant
      // win — the raid would march to the isles, declare victory over nothing and march home.
      if (!live && !sawAlive) {
        if (Date.now() - started > 20000) { this.log(`[boss] ${boss.id} never appeared — it is not up`); return false; }
        this.move.heartbeat('idle');
        await sleep(1500);
        continue;
      }
      if (live && live.alive !== false && !(live.hp != null && live.hp <= 0)) sawAlive = true;
      if (!live || !live.alive || (live.hp != null && live.hp <= 0)) { this.log(`[boss] ${boss.id} down`); return true; }

      const hpFrac = (this.state.me?.hp ?? 100) / COMBAT.playerHp;
      // Bail EARLY. A boss AoE is 16 a tick; anything under 45% is one unlucky pair of ticks from a
      // corpse run, and the sack would be sitting in the middle of the lair.
      if (hpFrac < 0.45) {
        const healed = await this.crafting.emergencyHeal();
        if (!healed) {
          this.net.send({ t: 'eat' });
          await sleep(COMBAT.consumeMs);
          if ((this.state.me?.hp ?? 0) / COMBAT.playerHp < 0.45) {
            this.log(`[boss] disengaging at ${Math.round(hpFrac * 100)}% hp`);
            return false;
          }
        }
      }

      const danger = this.inDanger();
      if (danger) { await this.dodge(danger, boss); continue; }

      const bx = live.x ?? def.x, bz = live.z ?? def.z;
      if (Math.hypot(bx - this.state.pos.x, bz - this.state.pos.z) > range) {
        try { await this.move.walkTo(bx, bz, { range, timeoutMs: 25000 }); }
        catch { return false; }
        continue;
      }

      this.net.send({ t: 'attackBoss', id: boss.id });
      await sleep(human(cd, 0.12));
      this.move.heartbeat('attack');
    }
    return false;
  }

  // One boss run, if there's a sensible one to join.
  async run({ requireHelpers = true, maxMs = 6 * 60 * 1000 } = {}) {
    this._stop = false;
    const boss = this.pick({ requireHelpers });
    if (!boss) return { fought: false, reason: requireHelpers ? 'no boss with other players on it' : 'no reachable boss' };
    try {
      await this.move.walkTo(boss.x, boss.z, { range: (BOSSES[boss.id]?.attackRange || 5) - 1, timeoutMs: 120000 });
    } catch (e) {
      return { fought: false, reason: `couldn't reach ${boss.id}: ${e.message}` };
    }
    await this.crafting.buffFor('combat');
    const won = await this.fight(boss, { maxMs });
    return { fought: true, boss: boss.id, won };
  }

  // --- fleet raids ---------------------------------------------------------
  // Four of the eleven bosses in reach pay gold; the two the fleet actually fights (warden,
  // gloamroot) pay gems and a mat and NOTHING else, which is why the 5,000/day boss purse sat at
  // zero all day. The gold ones have no other players on them, and `requireHelpers` — a sound rule
  // for a lone character against 2,800 hp — skipped every one. So the fleet brings its own helpers.

  // This character's sustained damage per second, from its real level, weapon and calling.
  dps() {
    const app = this.state.me?.appearance || {};
    const { dmg } = attackDamage(this.myCombatLevel(), weaponDamage(app.weapon) || 0, affinityMul(app.character, app.weapon), 1);
    return dmg / (attackCooldown(app) / 1000);
  }

  // What one AoE tick actually costs this character once its shield is counted.
  aoeBite(def) { return (def.aoeDamage || 16) * (1 - (shieldReduce(this.state.me?.appearance?.shield) || 0)); }

  // Can a party of this size and shape take this boss and walk away? The dodge is deliberately NOT
  // counted — it is a bonus, exactly as the module header says. Rations are, at 70%: eating costs
  // consumeMs of standing still and the last meal is rarely swallowed in time.
  //
  // The health budget is 55, not 100. fight() disengages below 45% and stays disengaged if the heal
  // fails, so the bottom 45 hp is not a resource the raid can spend — counting it green-lit a
  // ration-less party for a fight that would break off two thirds of the way in and walk home with
  // nothing to show for the trek.
  survives(def, party) {
    const groupDps = party.reduce((a, b) => a + b.bosses.dps(), 0);
    if (groupDps <= 0) return { ok: false, why: 'nobody can hurt it' };
    const secs = def.hp / groupDps;
    const ticks = Math.floor((secs * 1000) / (def.aoeEvery || 4200));
    let worst = null;
    for (const b of party) {
      const takes = ticks * b.bosses.aoeBite(def);
      const heals = (b.crafting?.rationCount?.() ?? 0) * COMBAT.foodHeal;
      const budget = COMBAT.playerHp * 0.55 + heals * 0.7;
      const margin = budget - takes;
      if (!worst || margin < worst.margin) worst = { b, margin, takes, budget };
    }
    if (worst.margin <= 0) {
      return { ok: false, worst: worst.b,
               why: `${worst.b.label} would eat ${Math.round(worst.takes)} damage against a ${Math.round(worst.budget)} budget` };
    }
    return { ok: true, secs, ticks, groupDps };
  }

  // The largest crew that can take this boss, trimmed one at a time. Dropping the weakest raider
  // slows the kill, which lands MORE slams on everyone left, so this has to re-check after every
  // cut rather than filter once. Without it a single character out of rations vetoed the whole
  // fleet's raid.
  crewFor(def, party) {
    let crew = [...party];
    while (crew.length >= 2) {
      const v = this.survives(def, crew);
      if (v.ok) return { crew, ...v };
      if (!v.worst) return null;
      crew = crew.filter((b) => b !== v.worst);
    }
    return null;
  }

  // Walk to the muster point — just outside the slam radius — and hold there until the fleet says
  // go. Arriving alone and swinging is how one character tanks a boss meant for three.
  async muster(raid, def) {
    const bx = def.x, bz = def.z;
    const hold = (def.aoeRange || 12) + 4;
    const ang = (Math.max(0, raid.members.indexOf(this.label)) + 1) * 2.4;   // spread out; a stack is one slam
    try {
      await this.move.walkTo(bx + Math.cos(ang) * hold, bz + Math.sin(ang) * hold, { range: 2.5, timeoutMs: 180000 });
    } catch (e) { return `couldn't reach the lair: ${e.message}`; }
    this.mustered = true;
    const deadline = Date.now() + 120000;
    while (!this._stop && !raid.go && Date.now() < deadline) {
      this.move.heartbeat('idle');
      await sleep(2000);
    }
    return raid.go ? null : 'the rest of the fleet never arrived';
  }

  // One raid: cross into the boss's realm if it has one, muster, fight, come home.
  async raidRun(raid) {
    this._stop = false;
    this.mustered = false;
    const def = BOSSES[raid.bossId];
    if (!def) return { fought: false, reason: 'unknown boss' };
    const realm = realmAt(def.x, def.z)?.id || null;
    const cameFrom = this.realms ? this.realms.current() : null;
    try {
      if (this.realms && realm !== cameFrom && !(await this.realms.travelTo(realm))) {
        return { fought: false, reason: `couldn't reach the ${realm} realm` };
      }
      const late = await this.muster(raid, def);
      if (late) return { fought: false, reason: late };
      await this.crafting.buffFor('combat');
      const live = this.state.bosses.get(raid.bossId) || { id: raid.bossId, hp: def.hp, helpers: raid.members.length - 1 };
      const won = await this.fight({ ...live, id: raid.bossId, helpers: raid.members.length - 1 }, { maxMs: 8 * 60 * 1000 });
      // Retire it immediately. The fleet only re-checks every 30 s, and in that window the raid
      // still outscores everything — so the party would set off for the isles a second time to
      // fight a corpse, then walk all the way home again.
      raid.done = true;
      return { fought: true, boss: raid.bossId, won };
    } finally {
      this.mustered = false;
      // Always come back. Staying in the realm leaves every open-world node unreachable, and the
      // orchestrator would then score every activity at zero and spin.
      if (this.realms && realm !== cameFrom) {
        try { await this.realms.travelTo(cameFrom); } catch { /* next cycle re-plans from wherever we stand */ }
      }
    }
  }

  report() {
    const alive = [...this.state.bosses.values()].filter((b) => b.alive);
    return alive.map((b) => {
      const def = BOSSES[b.id] || {};
      const ok = (def.reqCombat ?? 0) <= this.myCombatLevel();
      return `${ok ? '✅' : '🔒'} ${def.icon || ''} ${(def.name || b.id).slice(0, 22).padEnd(22)} ${b.hp}/${def.hp || b.maxHp} · req ${def.reqCombat ?? 0} · ${this.helpers(b.id)} fighting`;
    }).join('\n') || 'no bosses up';
  }
}
