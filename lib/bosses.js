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
import { BOSSES, COMBAT, attackCooldown, levelForXp, bossXp } from './rules.js';
import { sleep } from './movement.js';
import { human } from './stealth.js';

export class Bosses {
  constructor({ net, state, move, crafting, log = console.log }) {
    this.net = net; this.state = state; this.move = move; this.crafting = crafting; this.log = log;
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
    const deadline = Date.now() + maxMs;
    this.stats.fights++;
    this.log(`[boss] engaging ${def.name || boss.id} (${boss.hp}/${def.hp} hp, ${boss.helpers} others fighting)`);

    while (!this._stop && Date.now() < deadline) {
      const live = this.state.bosses.get(boss.id);
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

  report() {
    const alive = [...this.state.bosses.values()].filter((b) => b.alive);
    return alive.map((b) => {
      const def = BOSSES[b.id] || {};
      const ok = (def.reqCombat ?? 0) <= this.myCombatLevel();
      return `${ok ? '✅' : '🔒'} ${def.icon || ''} ${(def.name || b.id).slice(0, 22).padEnd(22)} ${b.hp}/${def.hp || b.maxHp} · req ${def.reqCombat ?? 0} · ${this.helpers(b.id)} fighting`;
    }).join('\n') || 'no bosses up';
  }
}
