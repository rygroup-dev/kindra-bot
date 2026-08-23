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
import {
  GATHER, levelForXp, KINSHIP_RADIUS, REFERRAL, accountXpOf, xpForAccountLevel,
  NODE_TYPES, COMBAT, JOBS, BOSSES, creatureStats, bossXp, ACCOUNT_XP_OTHER, GOODS,
} from './rules.js';

// One exchange rate makes every activity comparable. Measured on this bot: roughly 4.2k gold and
// 17k xp an hour, so a point of xp is worth about a quarter of a gold piece.
const XP_GOLD = 0.25;
// Under chase mode these keep their full score: none of them earns account xp, but a character that
// cannot sell, restock or heal stops earning anything at all. 'combat' is exempt because it is the
// thing being chased.
// 'cook' is here for a reason that cost kindra-01 an hour: with no rations the survivability margin
// nearly doubles and the level ceiling drops, so combat finds "nothing safe to fight" and scores
// ZERO — there is nothing for chase mode to boost, and the character quietly gardens instead.
// Cooking is not an xp detour under chase; it is the thing that makes the chase possible.
const CHASE_EXEMPT = new Set(['combat', 'sell', 'shop', 'food', 'cook', 'recover', 'bank']);
const HP_TRAVEL_FLOOR = 0.65;   // measured: both field deaths happened walking at 51-59% hp
// Past a daily gold cap the coins stop but the XP does not, so a capped source keeps this fraction
// of its value rather than dropping to nothing.
const GOLD_CAPPED_FACTOR = 0.45;
const AVG_WALK_SECS = 6;
// Rough seconds per unit of quest progress, used only to spread a quest's reward over the work left.
const MINUTES_PER_UNIT = { gather: 0.12, combat: 0.25, cook: 0.05, craft: 0.05, garden: 3 };

const SLICE_MS = 4 * 60 * 1000;     // re-evaluate every few minutes; long enough to be productive

export class Orchestrator {
  constructor({ net, state, move, gather, combat, economy, crafting, quests, upgrades, bosses, jobs, garden, realms, shrine, log = console.log }) {
    Object.assign(this, { net, state, move, gather, combat, economy, crafting, quests, upgrades, bosses, jobs, garden, realms, shrine, log });
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

  // Every candidate activity, valued in ONE unit: estimated GOLD PER MINUTE.
  //
  // This replaced a pile of additive bonuses — `s += 60 + 140 * frac`, `s *= 0.35`,
  // `s = Math.max(s, 120)` — whose numbers were not comparable across activities and quietly fought
  // each other. Garden scored 120 and won cycle after cycle while returning "planted 0", because
  // nothing in the arithmetic knew it was blocked.
  //
  // Two rules make this behave:
  //   1. An activity that CANNOT proceed right now is worth 0. Not "worth less" — zero, by
  //      construction, so it can never be chosen and never spins the loop.
  //   2. Everything else is priced in gold/minute, with XP converted at XP_GOLD so a level-up and
  //      a coin can be compared at all. Daily caps are read from the server: past a cap the gold
  //      term is zero and only the XP term remains, which is exactly the real situation.
  scoreActivities() {
    // GOLD MODE prices experience at almost nothing, so only coins decide. It is not a pile of
    // special cases: every branch below already values xp at xpGold and gold at face value, so
    // moving one number re-ranks the whole board honestly. Gardening and crafting, which pay in xp
    // and little else, fall away; selling, the trade roads, quests — whose gold ignores every daily
    // cap — and the gold-paying bosses rise to the top on their own arithmetic.
    // A character explicitly pinned to chase account level keeps normal pricing: the pin is a
    // per-character instruction and beats the fleet-wide default, or switching the fleet to gold
    // would silently call off the chase the user asked for.
    const xpGold = (this.goldMode && !this.chasing) ? 0.02 : XP_GOLD;
    const q = this.quests.focusQuest();
    const inv = this.economy.pressure;
    const out = [];
    // A parked activity scores zero by construction: it kept returning instantly, which means it is
    // refusing for a reason nothing here can see. Parks expire — see the note at the bottom of the
    // cycle — because the reason usually does too.
    const add = (activity, value, why, extra = {}) => {
      if (this.parked?.[activity] > Date.now()) return out.push({ activity, score: 0, why: 'parked — produced nothing' });
      // Chase mode used to discount exactly one activity, gathering, and boost exactly one, combat.
      // Everything else kept its full score — so a character pinned specifically to chase account
      // level spent 571 consecutive cycles in the garden at 354/min while combat sat below it, and
      // garden xp moves account level at a quarter weight. Discount every xp source that is not
      // combat, by the weight the game itself uses. LOGISTICS keep full value: selling, shopping and
      // eating do not earn account xp but they are what keeps the character able to earn any.
      const v = (this.chasing && !CHASE_EXEMPT.has(activity)) ? value * ACCOUNT_XP_OTHER : value;
      return out.push({ activity, score: Math.max(0, v), why, ...extra });
    };

    // What finishing the focused quest is worth per minute, attributed to the activity that
    // advances it. A quest pays on COMPLETION, so its value is its reward spread over the work left.
    const questBonus = (activity, skill = null) => {
      if (!q || q.activity !== activity) return 0;
      if (skill && q.skill && q.skill !== skill) return 0;
      const gold = (q.quest.gold || 0) + (q.quest.xp || 0) * xpGold;
      const minutesLeft = Math.max(0.5, q.remaining * MINUTES_PER_UNIT[activity] ?? 0.5);
      return gold / minutesLeft;
    };

    // --- gathering ---------------------------------------------------------
    for (const skill of ['woodcutting', 'mining', 'foraging', 'fishing']) {
      const pinned = (q?.activity === 'gather' && q.skill === skill) ? q.nodeTypes : null;
      const types = pinned?.length ? pinned : this.gather.nodeTypesFor(skill);
      const nodes = types.length ? this.state.liveNodes(types) : [];
      if (!nodes.length) { add('gather', 0, `no live ${skill} nodes`, { skill }); continue; }
      if (inv > 0.95) { add('gather', 0, 'satchel full', { skill }); continue; }

      // A node is worth its gold, WHAT IT DROPS, and its XP, over the time to walk to it and work
      // it. The drop was missing, and it is usually the largest term of the three: an amber_deposit
      // mints 6 gold and yields 7 raw_amber that sell for 9 each, while a motherlode mints 9 gold
      // and yields ore worth 2 — so on the old sum the motherlode looked BETTER while paying a
      // fraction as much, and took 34 swings to the amber's 7. Nothing about "farm gold" works
      // until the thing being farmed is counted.
      const def = NODE_TYPES[nodes[0].type] || {};
      const hits = def.hits || 1;
      const drop = def.drop || def.item;
      const dropValue = drop
        ? hits * Math.max(this.economy.vendorValue(drop) || 0, this.economy.marketValue(drop) || 0)
        : 0;
      const perNode = (def.gold || 0) + dropValue + (def.baseXp || 0) * hits * xpGold;
      const secs = hits * (this.gather.swingIntervalMs(skill) / 1000) + AVG_WALK_SECS;
      const mult = this.gather.yieldMult() * this.gather.kinshipAt(this.state.pos.x, this.state.pos.z);
      const gatherGoldLeft = this.gatherGoldLeft() > 0 ? 1 : GOLD_CAPPED_FACTOR;
      let v = (perNode * mult * gatherGoldLeft) * (60 / secs);
      // (the chase discount is applied uniformly in add(), by the game's own account-xp weight)
      // A craft or cook objective with an empty satchel cannot advance at all; the way to move it
      // is to go and get its inputs. The scoring rewrite dropped this and the Monument quest sat at
      // 0/6 indefinitely as a result.
      let feeder = 0;
      if (q && (q.activity === 'craft' || q.activity === 'cook') && !q.haveInputs && q.feeders?.includes(skill)) {
        feeder = questBonus(q.activity) * 0.8;
      }
      add('gather', v + questBonus('gather', skill) + feeder, `${nodes.length} node(s)`, { skill });
    }

    // --- combat ------------------------------------------------------------
    {
      const kinds = q?.activity === 'combat' ? q.kinds : null;
      const target = this.combat.pickTarget({ kinds });
      if (!target) add('combat', 0, 'nothing safe to fight');
      else if (inv > 0.95) add('combat', 0, 'satchel full');
      else {
        const { secsToKill } = this.combat.dpsAgainst(target.level);
        const st = creatureStats(target.level);
        const capOpen = this.capLeft('combat') > 0;
        const gold = capOpen ? COMBAT.gold : 0;
        const secs = secsToKill + AVG_WALK_SECS;
        let v = (gold + st.xp * xpGold) * (60 / secs);
        if (!this.combat.hasFood()) v *= 0.5;      // riskier, and a death costs a corpse run
        if (this.chasing) v *= 3;                  // combat is the only full-weight route to account level
        add('combat', v + questBonus('combat'), `${target.kind} Lv${target.level}`);
      }
    }

    // --- cooking / crafting ------------------------------------------------
    for (const [activity, skill] of [['cook', 'cooking'], ['craft', 'crafting']]) {
      // Score exactly what processRaws() will actually make. It skips recipes whose output is worth
      // less than their inputs, so scoring on canMake() alone let a brand-new character pick
      // "craft 306/min (11x Saw Plank)" twenty cycles in a row and craft nothing at all: the scorer
      // and the executor disagreed about what was craftable, and only the scorer wrote to the log.
      const recipes = this.crafting.available(skill)
        .filter((r) => this.crafting.canMake(r) && this.crafting.recipeProfitable(r));
      if (!recipes.length) { add(activity, 0, 'nothing worth making'); continue; }
      const best = recipes.sort((a, b) => (b.xp || 0) - (a.xp || 0))[0];
      const n = this.crafting.canMake(best);
      const value = (best.xp || 0) * xpGold * n;
      let v = value * (60 / Math.max(1, n * 0.7 + 2));
      // Rations are what make combat survivable; when we're out, cooking is worth more than its XP.
      if (activity === 'cook' && this.crafting.rationCount() < 4) v *= 2.5;
      add(activity, v + questBonus(activity), `${n}× ${best.name}`);
    }

    // --- garden ------------------------------------------------------------
    {
      const ripe = this.garden?.ready().length || 0;
      const free = this.garden?.free().length || 0;
      const seed = this.garden?.bestSeed();
      if (!this.garden) add('garden', 0, 'unavailable');
      else if (!ripe && !free) add('garden', 0, 'all plots occupied');       // the Community Garden is shared
      else if (!ripe && !seed) add('garden', 0, 'no affordable seed');
      else {
        // A harvest needs somewhere to PUT the crop. This is rule one of this scorer — an activity
        // that cannot proceed is worth zero, not less — and the garden was the one place it was not
        // applied. kindra-01 sat at 100/100 and chose the garden 571 cycles running, collecting
        // 1,619 "Satchel full" refusals, because 3 ripe plots scored 354/min against a sell worth
        // 144. Planting still works with a full bag: it spends seeds rather than earning crops.
        const noRoom = this.economy.used() >= this.economy.capacity() - 2;
        const harvestValue = noRoom ? 0 : ripe * (seed?.xp || 60) * xpGold;
        const plantValue = free && seed ? free * seed.xp * xpGold * 0.4 : 0;
        const v = (harvestValue + plantValue) * (60 / (AVG_WALK_SECS + 8));
        const why = noRoom && ripe && !plantValue ? 'satchel full — nowhere to put the crop'
          : ripe && !noRoom ? `${ripe} ripe` : `${free} plot(s) free`;
        add('garden', v + questBonus('garden'), why);
      }
    }

    // --- bosses ------------------------------------------------------------
    {
      // A called raid outranks everything. It is the only route to the boss purse — 5,000/day, the
      // largest cap in the game and the one that has never paid a coin — it expires when the party
      // breaks up, and the whole party has to arrive together or the first one there tanks it alone.
      const raid = this.bosses?.raid?.done ? null : this.bosses?.raid;
      if (raid) {
        add('boss', raid.perMin ?? 0, `raid on ${raid.bossId} with ${raid.members.length - 1} others`);
      } else {
        const boss = this.bosses?.pick({ requireHelpers: true });
        if (!boss) add('boss', 0, 'no boss with others on it');
        else if (!this.combat.hasFood()) add('boss', 0, 'no rations for AoE');
        else if (this.combat.hpFrac < 0.7) add('boss', 0, 'health too low');
        else {
          const share = bossXp(BOSSES[boss.id]?.hp || 0) * 0.25;   // we contribute a slice, not all of it
          // What THIS boss pays, not a flat 400 for any of them. Seven of the eleven carry no
          // goldRoll at all — the Grove Warden and Gloamroot, the two a lone character can safely
          // join, pay a gem and a mat and nothing else — so a flat number sent characters across
          // the map for a purse that was never there, and in gold mode would do it enthusiastically.
          const roll = BOSSES[boss.id]?.reward?.goldRoll;
          const gold = this.capLeft('boss') > 0 && roll ? (roll[0] + roll[1]) / 2 : 0;
          add('boss', (gold + share * xpGold) * (60 / 180), `${boss.id}, ${boss.helpers} others`);
        }
      }
    }

    // --- trade roads -------------------------------------------------------
    {
      if (!this.jobs?.unlocked()) add('job', 0, `unlocks at Lv ${JOBS.unlockLv}`);
      else if (this.jobs.carrying) add('job', 999, 'cargo already paid for');   // finish it, always
      else if (this.capLeft('trade') <= 0) add('job', 0, 'trade cap spent');
      else {
        const tier = this.jobs.bestTier();
        if (!tier) add('job', 0, 'no tier affordable');
        else add('job', ((tier.sell - tier.cost) + tier.xp * xpGold) * (60 / 180), tier.name);
      }
    }

    // --- selling -----------------------------------------------------------
    {
      if (inv < 0.55) add('sell', 0, 'satchel has room');
      else {
        // What the satchel is actually worth, over the round trip to spend it.
        let worth = 0;
        for (const [item, qty] of Object.entries(this.state.me?.inv || {})) {
          const route = this.economy.route(item);
          if (route === 'keep') continue;
          worth += qty * Math.max(this.economy.vendorValue(item), this.economy.marketValue(item));
        }
        const urgency = inv > 0.95 ? 4 : 1;        // full satchel blocks everything else
        // A trip that cleared nothing means the goods are reserved or unsellable; repeating it
        // immediately just walks to the market again for the same result.
        if (this.economy.lastSaleMoved === 0 && Date.now() - (this._lastSell || 0) < 5 * 60 * 1000) {
          add('sell', 0, 'last trip cleared nothing');
        } else {
          add('sell', worth * urgency * (60 / 90), `${Math.round(worth)}g of goods`);
        }
      }
    }

    // --- shopping ----------------------------------------------------------
    {
      const w = this.upgrades?.bestWeapon();
      const held = this.state.me?.appearance?.weapon;
      if (!w || w.cost + 250 > (this.state.me?.gold || 0)) add('shop', 0, 'nothing affordable');
      else {
        // A weapon is not income, it is a multiplier on all future combat — priced as the damage
        // it adds over an hour of fighting.
        const gain = (w.dmg || 0) / Math.max(1, this.combat.dpsAgainst(5).dmg);
        add('shop', (held ? 200 : 900) * gain, held ? `upgrade to ${w.id}` : `unarmed — buy ${w.id}`);
      }
    }

    return out.sort((a, b) => b.score - a.score);
  }

  // --- the loop -----------------------------------------------------------
  async runOnce() {
    this.cycle++;

    // 1. Free money first: anything finished gets claimed before we decide anything else.
    await this.quests.claimReady();

    // 2. Urgent business.
    if (this.state.sacks.size) { this.current = 'reclaim'; await this.combat.reclaimSacks(); }
    if (this.combat.hpFrac < 0.35) await this.crafting.emergencyHeal();
    // 0.35 only catches a character already dying. Deaths measured in the field happened at 51-59%
    // on the walk to the *next* activity, so top up to a travel-safe margin before we pick one.
    // Out of rations, with money in the purse. Restocking was only ever a side effect of a SELL
    // trip -- `if (rationCount < 4 && gold > 200) buyFood(5)` inside the sell branch -- so a
    // character whose satchel never filled enough to justify selling simply never ate again. And
    // without food nothing is safe to fight, so combat scores zero, so the chase it was pinned for
    // stops dead: kindra-01 sat at 11/100 hp with 969 gold and 0 rations, gathering, for half an
    // hour at 76.7%. Hunger is not an errand to fit around selling.
    if (this.crafting.rationCount() === 0 && (this.state.me?.gold || 0) > GOODS.meal.cost * 2) {
      this.current = 'food';
      const got = await this.economy.buyFood(5);
      this.log(got ? `[orch] out of rations — bought ${got}` : '[orch] out of rations and could not restock');
    }
    if (this.combat.hpFrac < HP_TRAVEL_FLOOR) { this.current = 'recover'; await this.combat.recover({ floor: HP_TRAVEL_FLOOR }); }

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
    const q = this.quests.focusQuest();
    // Protect whatever the focused objective consumes before anything decides to sell it.
    this.economy.reserve(q?.inputs || (q?.item ? [q.item] : []));
    const ranked = this.scoreActivities();
    // What this character could earn if it ignored the raid. The fleet reads it to decide whether a
    // raid is worth calling at all: a boss worth 20 gold a minute should never pull someone off a
    // vendor run worth 1,299, and only the character knows what its own alternatives pay.
    this.bestAlternative = ranked.find((r) => r.activity !== 'boss')?.score ?? 0;
    const pick = ranked[0];
    if (!pick || pick.score <= 0) {
      // Everything is blocked or spent. Resting is the correct move — and saying so beats a silent
      // five-second spin that looks identical to a hang.
      this.current = 'idle';
      const blocked = ranked.slice(0, 3).map((r) => `${r.skill || r.activity}: ${r.why}`).join(' · ');
      if (Date.now() - (this._lastIdleLog || 0) > 60000) {
        this._lastIdleLog = Date.now();
        this.log(`[orch] nothing worth doing — ${blocked}`);
      }
      this.move.heartbeat('idle');
      await sleep(human(8000));
      return;
    }

    this.current = pick.skill ? `${pick.activity}:${pick.skill}` : pick.activity;
    const focusPick = this.quests.focusQuest();
    const focusBefore = focusPick
      ? { id: focusPick.quest.id, prog: focusPick.quest.prog ?? 0, activity: focusPick.activity }
      : null;
    const focus = this.quests.focusLabel();
    // Log the REASON, not just the number. A score on its own cannot be audited; "sell 412 (2100g
    // of goods)" can be argued with, and that is what caught the garden scoring 120 while it was
    // blocked.
    const runners = ranked.slice(1, 4).filter((r) => r.score > 0)
      .map((r) => `${r.skill || r.activity} ${r.score.toFixed(0)}`).join(', ');
    this.log(`[orch] cycle ${this.cycle} -> ${this.current} ${pick.score.toFixed(0)}/min (${pick.why})${focus ? ` [finishing: ${focus}]` : ''}${runners ? ` · next: ${runners}` : ''}`);

    const started = Date.now();
    try {
      switch (pick.activity) {
        case 'gather': {
          await this.crafting.buffFor('gather');
          // Step through a portal when the objective lives on the other side. The Sunken Isles and
          // the Warscar are not walkable — they are doors.
          if (this.realms && q?.activity === 'gather' && q.realm && this.realms.current() !== q.realm) {
            this.log(`[orch] the objective is in ${q.realm} — taking the portal`);
            await this.realms.travelTo(q.realm);
          }
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
            // Pin the node types when a quest names a specific item.
            only: (q?.activity === 'gather' && q.skill === pick.skill) ? q.nodeTypes : null,
            stopWhen: (g) => this.economy.full || (g.stats.swings - startSwings >= 20 && g.spent),
          });
          break;
        }
        case 'combat': {
          await this.crafting.buffFor('combat');
          await this.combat.run({
            maxMs: SLICE_MS,
            // A region quest wants that region's creatures, not whatever is nearest.
            kinds: q?.activity === 'combat' ? q.kinds : null,
            stopWhen: () => this.economy.full || (!this.combat.hasFood() && this.combat.hpFrac < 0.5),
          });
          break;
        }
        case 'boss': {
          const raid = this.bosses.raid?.done ? null : this.bosses.raid;
          const r = raid ? await this.bosses.raidRun(raid)
                         : await this.bosses.run({ requireHelpers: true, maxMs: SLICE_MS });
          if (!r.fought) this.log(`[orch] ${raid ? 'raid' : 'boss'} skipped: ${r.reason}`);
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
        case 'shop': {
          const bought = await this.upgrades.buyAffordable({ max: 2 });
          await this.upgrades.sellSuperseded({ economy: this.economy });
          this.log(`[orch] shopping trip: ${bought.length ? bought.join(', ') : 'nothing affordable'}`);
          break;
        }
        case 'cook':  await this.crafting.cookAll(); break;
        case 'craft': {
          await this.crafting.processRaws();
          // "Give N goods to the Monument" only advances at the Monument itself.
          if (q?.contribute) await this.crafting.contributeToMonument({ want: q.quest?.need || 6 });
          break;
        }
        case 'sell': {
          this._lastSell = Date.now();
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
          // Turn surplus gold into the actual token. Gold that only ever sits in a character is
          // gold that never leaves the game — and listing costs no gas, because the buyer's wallet
          // pays ours directly.
          await this.cashOutSurplus();

          // The shrine sits in the same plaza, and it is the only buyer for the stock nobody else
          // wants: the vendor is capped, the market has no bid on raw materials, and the satchel
          // fills anyway. devotionOf() prices that dead weight into blessings — Gatherer's Grace
          // (10% double yield, 2 h) and Stone Vigil (-8% damage taken, which is what actually killed
          // three characters) both cost less than what we routinely bank and forget.
          if (this.shrine) {
            const dying = this.combat.stats?.deaths > 0 || this.combat.hpFrac < 0.5;
            await this.shrine.serve({
              // What has this character actually been doing lately? The blessing should match the
              // next two hours of work, not the market trip we are standing in right now.
              activity: this.history.slice(-8).filter((h) => h.activity === 'combat').length >= 3 ? 'combat' : 'gather',
              dying,
              reserved: this.economy.reserved || new Set(),
            });
          }
          break;
        }
      }
    } catch (err) {
      this.log(`[orch] ${this.current} failed: ${err.message}`);
      await sleep(2000);
    }

    // Did the objective we committed to actually move? Only judge it when the cycle ACTUALLY worked
    // on it. The first version blamed the quest for any cycle that failed to advance it — including
    // cycles spent selling or crafting something else entirely — so a perfectly workable objective
    // like "Craft 8 Goods" was declared stalled after three trips to the market and the whole board
    // emptied itself of things to do.
    if (focusBefore && focusBefore.activity === pick.activity) {
      const now = (this.state.quests || []).find((x) => x.id === focusBefore.id);
      if (now && (now.prog ?? 0) <= (focusBefore.prog ?? 0) && !now.claimed) this.quests.markStalled(focusBefore.id);
    }

    const took = Date.now() - started;
    this.history.push({ cycle: this.cycle, activity: this.current, ms: took });
    if (this.history.length > 50) this.history.shift();

    // Backstop: whatever the scores say, a cycle that returns instantly must not be retried
    // instantly. Without this, one activity that always refuses to start burns a core.
    if (took < 1500) {
      this._noop = this._noop || {};
      const n = (this._noop[this.current] = (this._noop[this.current] || 0) + 1);
      if (n >= 3) {
        this.parked = this.parked || {};
        this.parked[this.current] = Date.now() + 10 * 60 * 1000;
        this._noop[this.current] = 0;
        this.log(`[orch] parking ${this.current} for 10 min — ${n} cycles produced nothing`);
      }
      await sleep(human(4000));
    } else if (this._noop) {
      this._noop[this.current] = 0;
    }

    // Humans pause. A character that transitions between activities with zero dead time, forever,
    // has a machine's duty cycle; these breaks cost a few percent of throughput and buy the rest.
    const pause = microBreak();
    if (pause) {
      // kindra-16 disengaged a Lv19 thornhog at 12% hp, the break scheduler picked that exact moment
      // to stand still for 38 s inside the spawn cluster, and it was dead two seconds later. A break
      // is a luxury; getting out of aggro range first is not.
      if (this.combat.hpFrac < HP_TRAVEL_FLOOR) await this.combat.recover({ floor: HP_TRAVEL_FLOOR });
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

  // List surplus gold on the on-chain book. Rate-limited: the book holds at most 3 listings per
  // character and a lot sits until someone buys it, so hammering this achieves nothing.
  async cashOutSurplus() {
    if (Date.now() - (this._lastCashOut || 0) < 20 * 60 * 1000) return null;
    try {
      const { KGold } = await import('./chain.js');
      this.kgold = this.kgold || new KGold({ net: this.net, state: this.state, log: this.log });
      const r = await this.kgold.cashOutSurplus({ upgrades: this.upgrades });
      this._lastCashOut = Date.now();
      if (r.listed) this.log(`[kgold] listed ${r.gold}g for ${r.price} $KINDRA (${r.perK.toFixed(1)} per 1k) — pays straight to the wallet`);
      // Zero listings across a 2 h run was indistinguishable from a broken cash-out path, because a
      // refusal said nothing at all. Say why, at most every 20 min — the throttle above already
      // rate-limits this call, so it cannot spam.
      else if (r.reason) this.log(`[kgold] not listing yet — ${r.reason}`);
      return r;
    } catch (e) { this.log(`[kgold] cash-out skipped: ${e.message}`); return null; }
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
