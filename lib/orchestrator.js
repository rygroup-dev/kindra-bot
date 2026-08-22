// orchestrator.js — the brain. Decides what to do next, forever.
//
// Everything in this bot exists because of three facts from the RE (docs/RE-PROTOCOL.md §5):
//
//   1. Gold is capped PER SOURCE, per day: gathering ~600, combat 2000, boss 5000, vendor 1000,
//      trade 2000. Grinding one source past its cap earns literally nothing. The server reports
//      live counters in the `wallet` frame, so we never guess — we read `state.haul`.
//   2. Gathering decays: 25 free swings, then -5%/swing to a 25% floor, recovering 1 step / 4 s.
//      A bot that chops without pause is a bot working at quarter rate.
//   3. Quest gold is paid ON TOP of every cap, and quest objectives are things we already do.
//
// So the loop is: claim what's finished, handle anything urgent, then pick the activity with the
// best real yield right now — which is a function of caps left, falloff state, and open quests.
import { sleep } from './movement.js';
import { human, microBreak, shouldTakeLongBreak, longBreakMs } from './stealth.js';
import { GATHER, levelForXp, KINSHIP_RADIUS, REFERRAL, accountXpOf, xpForAccountLevel } from './rules.js';

const SLICE_MS = 4 * 60 * 1000;     // re-evaluate every few minutes; long enough to be productive

export class Orchestrator {
  constructor({ net, state, move, gather, combat, economy, crafting, quests, upgrades, bosses, jobs, garden, log = console.log }) {
    Object.assign(this, { net, state, move, gather, combat, economy, crafting, quests, upgrades, bosses, jobs, garden, log });
    this.running = false;
    this.current = 'idle';
    this.cycle = 0;
    this.startedAt = 0;
    this.baseline = null;
    this.history = [];
  }

  // --- account-level chase -------------------------------------------------
  // Referrals unlock at account Lv 10, and each conversion is worth 500 gold + 200 on-chain
  // $KINDRA. ACCOUNT_XP_WEIGHT scores combat at 1.0 and every other skill at 0.25, so a character
  // that gathers its way there takes roughly four times as long. When this is on, combat outranks
  // everything that isn't urgent — and it switches itself off the moment the gate is passed, so it
  // never has to be remembered or undone.
  get chasing() {
    if (!this.chaseAccountLevel) return false;
    const tl = this.state.me?.tl || 0;
    if (tl >= REFERRAL.minLv) {
      if (this._wasChasing) {
        this._wasChasing = false;
        this.chaseAccountLevel = false;
        this.log(`[orch] account Lv ${tl} reached — referrals unlocked, back to normal rotation`);
        this.emit?.('chaseDone', tl);
      }
      return false;
    }
    this._wasChasing = true;
    return true;
  }

  chaseProgress() {
    const have = accountXpOf(this.state.me?.skills || {});
    const need = xpForAccountLevel(REFERRAL.minLv);
    return { have, need, pct: Math.min(100, (have / need) * 100), level: this.state.me?.tl || 0 };
  }

  // --- scoring ------------------------------------------------------------
  capLeft(source) {
    const h = this.state.haul || {};
    const cap = h[`${source}Cap`], cur = h[source];
    if (cap == null) return Infinity;
    return Math.max(0, cap - (cur || 0));
  }

  // Gathering has its own daily gold cap in the rules table (600) separate from the vendor cap.
  gatherGoldLeft() {
    const h = this.state.haul || {};
    if (h.gather != null && h.gatherCap != null) return Math.max(0, h.gatherCap - h.gather);
    return GATHER.dailyGoldCap;   // not reported separately — assume available, XP is uncapped anyway
  }

  // Every candidate activity, scored. Higher is better; 0 means "pointless right now".
  scoreActivities() {
    const q = this.quests.preferredActivity();
    const foodLow = this.crafting.rationCount() < 4;
    const invPressure = this.economy.pressure;
    const yieldMult = this.gather.yieldMult();

    const scores = [];

    // --- gathering: XP is never capped, so this is always worth something, but the falloff
    // multiplier is applied honestly so a spent streak loses to a fresh alternative.
    for (const skill of ['woodcutting', 'mining', 'foraging', 'fishing']) {
      const types = this.gather.nodeTypesFor(skill);
      if (!types.length) continue;
      const nodes = this.state.liveNodes(types);
      if (!nodes.length) continue;
      let s = 55;
      // Fishing feeds cooking feeds combat rations — worth more than its raw XP when we're hungry.
      if (skill === 'fishing' && foodLow) s += 45;
      if (q?.activity === 'gather' && q.skill === skill) s += 60;      // an open quest wants this
      // Kinship only pays if the fleet works the SAME skill in the SAME place. Two characters on
      // different skills never meet, so the shared focus is weighted heavily enough to win ties.
      if (this.fleetFocus && this.fleetFocus.skill === skill) s += 45 * (this.fleetFocus.members - 1);
      // The falloff multiplies the WHOLE score, quest bonus included. Applying it only to the base
      // let a quest-boosted skill stay top-ranked at 25% yield forever, and the loop span cycles
      // choosing it and instantly bailing out.
      s *= yieldMult;
      if (invPressure > 0.9) s *= 0.3;                                  // no room to put anything
      if (this.chasing) s *= 0.35;   // gathering counts 0.25x toward account level; combat counts 1.0
      scores.push({ activity: 'gather', skill, score: s });
    }

    // --- combat: hard-capped at 2000 gold/day and needs food to be safe.
    {
      const left = this.capLeft('combat');
      let s = left > 0 ? 70 : 20;                 // past the cap it's still combat XP, just no gold
      if (!this.combat.hasFood()) s *= 0.35;      // foodless fighting is how we lost the first test
      if (this.combat.hpFrac < 0.5) s *= 0.4;
      if (q?.activity === 'combat') s += 60;
      if (invPressure > 0.9) s *= 0.5;
      // The chase never overrides survival: no food or low health still de-rates it above, and a
      // full satchel still has to be cleared first.
      if (this.chasing) s += 120;
      scores.push({ activity: 'combat', score: s });
    }

    // --- cooking: cheap XP and it manufactures the rations combat needs.
    {
      const can = this.crafting.available('cooking').length;
      let s = can ? 40 : 0;
      if (foodLow && can) s += 70;
      if (q?.activity === 'cook') s += 60;
      scores.push({ activity: 'cook', score: s });
    }

    // --- crafting: converts dead-weight raws into value and clears satchel space.
    {
      const can = this.crafting.available('crafting').length;
      let s = can ? 38 : 0;
      if (invPressure > 0.7 && can) s += 40;
      if (q?.activity === 'craft') s += 60;
      scores.push({ activity: 'craft', score: s });
    }

    // --- bosses: the biggest daily cap (5,000) and the fattest XP, but only worth it when other
    // players are already holding the boss's attention — loot is split by damage contribution, so
    // joining costs a fraction of the risk of leading.
    {
      let s = 0;
      if (this.bosses) {
        const target = this.bosses.pick({ requireHelpers: true });
        if (target) {
          s = this.capLeft('boss') > 0 ? 95 : 45;      // past the cap it is still huge XP
          if (!this.combat.hasFood()) s *= 0.3;        // AoE is 16 a tick; no food is no fight
          if (this.combat.hpFrac < 0.7) s *= 0.4;
          if (invPressure > 0.9) s *= 0.5;
        }
      }
      scores.push({ activity: 'boss', score: s });
    }

    // --- trade roads: a separate 2,000/day pot that competes with nothing else. Unlocks at Lv 15,
    // needs working capital, and an interrupted haul must be finished before anything else.
    {
      let s = 0;
      if (this.jobs?.unlocked()) {
        if (this.jobs.carrying) s = 140;                      // finish the haul; the cargo is already paid for
        else if (this.capLeft('trade') > 0 && this.jobs.bestTier()) {
          s = 60;
          if (invPressure > 0.8) s *= 0.5;                    // no room for ambush loot either
          if (this.combat.hpFrac < 0.6) s *= 0.5;
        }
      }
      scores.push({ activity: 'job', score: s });
    }

    // --- garden: the only thing that earns while we're elsewhere. Cheap to tend, so the trigger is
    // simply "something is ripe" or "plots are sitting empty". Crops spoil 2 h after ripening, which
    // is the one way to actually lose here.
    {
      let s = 0;
      if (this.garden) {
        const ripe = this.garden.ready().length;
        const empty = this.garden.free().length;
        if (ripe) s = 80 + ripe * 6;                       // ripe crops are already paid for
        else if (empty && this.garden.bestSeed()) s = 34;  // idle plots are idle capital
      }
      scores.push({ activity: 'garden', score: s });
    }

    // --- selling: only when there's something to sell and somewhere for the gold to go.
    {
      let s = 0;
      if (invPressure > 0.75) s = 85;
      if (invPressure > 0.95) s = 130;            // hard blocked — nothing else can proceed
      if (this.capLeft('vendor') <= 0 && this.capLeft('trade') <= 0) s *= 0.4;
      scores.push({ activity: 'sell', score: s });
    }

    return scores.sort((a, b) => b.score - a.score);
  }

  // --- the loop -----------------------------------------------------------
  async runOnce() {
    this.cycle++;

    // 1. Free money first: anything finished gets claimed before we decide anything else.
    await this.quests.claimReady();

    // 2. Urgent business.
    if (this.state.sacks.size) { this.current = 'reclaim'; await this.combat.reclaimSacks(); }
    if (this.combat.hpFrac < 0.35) await this.crafting.emergencyHeal();

    // 3. Cheap opportunities that expire: a nearby star is 2 gems for a short walk, and a treasure
    //    map in the bag is worth more dug up than the 11g Vlad pays for it.
    const star = this.quests.starWorthChasing();
    if (star) {
      // A star walk can take 40 s with nothing else to say; log the intent so a long quiet stretch
      // in the log is never mistaken for a stall.
      this.current = 'star';
      this.log(`[orch] chasing a falling star ${star.dist.toFixed(0)}u away`);
      await this.quests.chaseStar();
    }
    if ((this.state.me?.inv || {}).torn_map) {
      this.current = 'treasure';
      this.log('[orch] reading a treasure map');
      await this.quests.runTreasure();
    }

    // 4. Pick the best real activity and run a slice of it.
    const ranked = this.scoreActivities();
    const pick = ranked[0];
    if (!pick || pick.score <= 0) { this.current = 'idle'; await sleep(5000); return; }

    this.current = pick.skill ? `${pick.activity}:${pick.skill}` : pick.activity;
    this.log(`[orch] cycle ${this.cycle} -> ${this.current} (score ${pick.score.toFixed(0)}; ${ranked.slice(1, 4).map((r) => `${r.skill || r.activity} ${r.score.toFixed(0)}`).join(', ')})`);

    const started = Date.now();
    try {
      switch (pick.activity) {
        case 'gather': {
          await this.crafting.buffFor('gather');
          // Travelling to the fleet's cluster has to be its OWN decision, made once. Per-node
          // scoring can never choose it: a 160-unit walk costs ~23 s and the kinship bonus is only
          // ~30%, so the tree two steps away wins every single comparison and the fleet never
          // converges (measured: rally held still at (-62,-66) while all three sat at 1.00x).
          // Commit to the journey up front, then work inside the cluster where the bonus applies.
          const focus = this.fleetFocus;
          if (focus && focus.skill === pick.skill) {
            const d = Math.hypot(focus.x - this.state.pos.x, focus.z - this.state.pos.z);
            if (d > KINSHIP_RADIUS) {
              this.log(`[orch] joining the fleet cluster ${d.toFixed(0)}u away (kinship ×${(1 + 0.15 * Math.min(focus.members - 1, 4)).toFixed(2)})`);
              // A 300-unit walk is three quarters of a minute of doing nothing. A waypoint hop costs
              // 25g plus 0.6 a unit, which a full gathering slice repays many times over.
              try { await this.economy.fastTravelTo(focus.x, focus.z, { worthGold: 400 }); } catch { /* walk instead */ }
              try { await this.move.walkTo(focus.x, focus.z, { range: 3.5, timeoutMs: 90000 }); }
              catch (e) { this.log(`[orch] couldn't reach the cluster: ${e.message}`); }
            }
          }
          // `spent` is usually already true at entry (the streak carries between cycles), so an
          // unguarded stopWhen returns instantly and the loop spins. Require real work first: the
          // falloff heals one step per 4 s, so a slice that actually swings is also a slice that
          // recovers.
          const startSwings = this.gather.stats.swings;
          await this.gather.run(pick.skill, {
            maxMs: SLICE_MS,
            stopWhen: (g) => this.economy.full || (g.stats.swings - startSwings >= 20 && g.spent),
          });
          break;
        }
        case 'combat': {
          await this.crafting.buffFor('combat');
          await this.combat.run({
            maxMs: SLICE_MS,
            stopWhen: () => this.economy.full || (!this.combat.hasFood() && this.combat.hpFrac < 0.5),
          });
          break;
        }
        case 'boss': {
          const r = await this.bosses.run({ requireHelpers: true, maxMs: SLICE_MS });
          if (!r.fought) this.log(`[orch] boss skipped: ${r.reason}`);
          break;
        }
        case 'job': {
          const r = await this.jobs.runOnce({ maxMs: SLICE_MS * 2 });
          if (!r.ran) this.log(`[orch] trade road skipped: ${r.reason}`);
          break;
        }
        case 'garden': {
          const r = await this.garden.tend();
          this.log(`[orch] garden: harvested ${r.harvested}, planted ${r.planted}`);
          break;
        }
        case 'cook':  await this.crafting.cookAll(); break;
        case 'craft': await this.crafting.processRaws(); break;
        case 'sell': {
          await this.economy.makeRoom();
          // Restock rations while we're standing at the market, if cooking can't cover it.
          if (this.crafting.rationCount() < 4 && this.state.me.gold > 200) await this.economy.buyFood(5);
          // Worn gear stops contributing its damage entirely once it breaks, and the character
          // keeps swinging regardless — a silent, compounding loss. The repair spot is Vlad, who we
          // are already standing next to.
          await this.economy.repairGear();
          // And spend the takings. Gold in the satchel earns nothing; a tool is a permanent
          // multiplier on every future swing, and we are already standing at the counter.
          if (this.upgrades) {
            await this.upgrades.buyAffordable();
            // Every tier bought leaves the previous one in the wardrobe forever. Move it on.
            await this.upgrades.sellSuperseded({ economy: this.economy });
          }
          break;
        }
      }
    } catch (err) {
      this.log(`[orch] ${this.current} failed: ${err.message}`);
      await sleep(2000);
    }

    const took = Date.now() - started;
    this.history.push({ cycle: this.cycle, activity: this.current, ms: took });
    if (this.history.length > 50) this.history.shift();

    // Backstop: whatever the scores say, a cycle that returns instantly must not be retried
    // instantly. Without this, one activity that always refuses to start burns a core.
    if (took < 1500) await sleep(human(4000));

    // Humans pause. A character that transitions between activities with zero dead time, forever,
    // has a machine's duty cycle; these breaks cost a few percent of throughput and buy the rest.
    const pause = microBreak();
    if (pause) {
      this.current = 'idle';
      this.log(`[orch] short break ${(pause / 1000).toFixed(0)}s`);
      this.move.heartbeat('idle');
      await sleep(pause);
    }
    if (shouldTakeLongBreak(Date.now() - this.startedAt)) {
      const ms = longBreakMs();
      this.current = 'away';
      this.log(`[orch] logging off for ${(ms / 60000).toFixed(0)}m`);
      await sleep(ms);
      this.startedAt = Date.now();   // reset the session clock so breaks stay occasional
    }
  }

  async start() {
    this.running = true;
    this.startedAt = Date.now();
    this.baseline = this.snapshot();
    this.log(`[orch] started — ${this.state.capReport()}`);

    // One-time setup on a fresh character: take the tutorial payout and the free daily spin.
    try {
      if (!this.state.me?.tutorialDone) await this.quests.finishTutorial();
    } catch (e) { this.log(`[orch] tutorial: ${e.message}`); }

    while (this.running) {
      try { await this.runOnce(); }
      catch (err) { this.log(`[orch] cycle error: ${err.message}`); await sleep(5000); }
    }
  }

  stop() {
    this.running = false;
    this.gather.stop(); this.combat.stop(); this.move.stop();
    if (this.bosses) this.bosses.stop();
    if (this.jobs) this.jobs.stop();
    this.current = 'stopped';
  }

  snapshot() {
    const me = this.state.me || {};
    return {
      at: Date.now(),
      gold: me.gold || 0,
      kbal: me.kbal || 0,
      skills: { ...(me.skills || {}) },
      totalXp: Object.values(me.skills || {}).reduce((a, b) => a + b, 0),
    };
  }

  // What the Telegram /status command renders.
  report() {
    const me = this.state.me || {};
    const now = this.snapshot();
    const base = this.baseline || now;
    const mins = Math.max(1, (now.at - base.at) / 60000);
    const dGold = now.gold - base.gold;
    const dXp = now.totalXp - base.totalXp;
    const levels = Object.entries(me.skills || {}).map(([k, v]) => `${k.slice(0, 4)} ${levelForXp(v)}`).join(' · ');
    return [
      `🎮 ${me.name || '?'} — ${this.current}`,
      `⏱ up ${(mins / 60).toFixed(1)}h · cycle ${this.cycle}`,
      `💰 ${now.gold}g (${dGold >= 0 ? '+' : ''}${dGold}, ${(dGold / mins * 60).toFixed(0)}/h)`,
      this.upgrades?.bought.length ? `🛒 reinvested in ${this.upgrades.bought.join(', ')}` : '',
      this.chasing ? `🎯 chasing account Lv ${REFERRAL.minLv} for referrals — ${this.chaseProgress().pct.toFixed(1)}%` : '',
      `◈ on-chain $KINDRA: ${now.kbal ?? 0}`,
      `⭐ xp +${dXp} (${(dXp / mins * 60).toFixed(0)}/h)`,
      `📊 ${levels}`,
      `🎒 ${this.economy.used()}/${this.economy.capacity()} · 🍖 ${this.crafting.rationCount()} · ❤️ ${me.hp ?? '?'}`,
      `🧢 caps: ${this.state.capReport()}`,
      `⚔️ kills ${this.combat.stats.kills} · deaths ${this.combat.stats.deaths}`,
      `📜 quests claimed ${this.quests.stats.claimed} (+${this.quests.stats.gold}g)`,
      `🪓 gather yield ${(this.gather.yieldMult() * 100).toFixed(0)}% · 🤝 kinship ${this.gather.kinshipAt(this.state.pos.x, this.state.pos.z).toFixed(2)}×`,
    ].filter(Boolean).join('\n');
  }
}
