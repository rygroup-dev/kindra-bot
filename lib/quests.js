// quests.js — every "free" reward the valley hands out for work we're doing anyway.
//
// This is the highest-margin module in the bot. Quest gold does NOT come out of the gathering or
// combat daily caps — it is paid on top. A daily set is 4 quests worth ~20-95g and 75-210 xp each,
// and the objectives ("Chop 15 Logs", "Cook 6 Meals", "Slay 8 …") are things the orchestrator is
// already doing. So the correct strategy is not "go do quests", it is "let the quests steer which
// activity we run next", which is what `preferredActivity()` feeds the orchestrator.
//
// Also collected here: the one-time tutorial payout, the free daily wheel spin, the slayer bounty
// board, falling stars, and treasure digs.
import {
  QUEST_POOL, NOVICE_QUESTS, TUTORIAL, WHEEL, STAR, TREASURE, SLAYER, BUILDINGS, SEEDS,
  NODE_TYPES, CREATURE_KINDS, RECIPES, levelForXp,
} from './rules.js';

// Region-locked kill quests. The label names the place; the quest id is what we actually match on.
const QUEST_REGION = {
  frost_slay: 'frost', mist_slay: 'mist', amber_slay: 'amber', murk_slay: 'murk',
  isles_slay: 'isles', ember_slay: 'ember', void_slay: 'voidrift', void_hunt: 'voidrift',
  // `slay` and `slay_big` are any creature anywhere.
};

// What the Community Garden produces. Quests for these are tagged as gathering but are only
// obtainable by planting and harvesting.
const CROP_ITEMS = new Set(Object.values(SEEDS).map((s) => s.crop));
import { sleep } from './movement.js';

const WHEEL_HOUSE = BUILDINGS.find((b) => b.id === 'wheel');
const STALL_LIMIT = 3;   // focused cycles with zero progress before the objective is set aside
const SLAYER_BOARD = SLAYER.BOARD;

export class Quests {
  constructor({ net, state, move, log = console.log }) {
    this.net = net; this.state = state; this.move = move; this.log = log;
    this.stats = { claimed: 0, gold: 0, spins: 0, stars: 0, digs: 0 };
    this.slayer = null;
    this.treasure = null;
    this._starActive = null;

    net.on('quest', (m) => { if (Array.isArray(m.quests)) this.state.quests = m.quests; });
    net.on('slayer', (m) => { this.slayer = m; });
    net.on('slayerDone', (m) => this.log(`[quest] slayer task done: ${JSON.stringify(m).slice(0, 160)}`));
    net.on('treasure', (m) => { this.treasure = m; });
    net.on('starState', (m) => { this._starActive = m?.active ? m : null; });
    net.on('wheelResult', (m) => this.log(`[quest] wheel: ${m.label || JSON.stringify(m).slice(0, 120)}`));
    // Every single gather emits `reward`; only surface the ones carrying real news.
    net.on('reward', (m) => { if (m.gold || m.up || m.rich) this.log(`[quest] ${m.skill || ''} +${m.gold || 0}g${m.rich ? ' RICH' : ''}${m.up ? ' LEVELUP' : ''}`); });
    net.on('loginReward', (m) => this.log(`[quest] login reward: ${JSON.stringify(m).slice(0, 160)}`));
  }

  // --- daily quest set ----------------------------------------------------
  get quests() { return this.state.quests || []; }
  get open() { return this.quests.filter((q) => !q.claimed); }
  get ready() { return this.quests.filter((q) => !q.claimed && (q.prog ?? 0) >= q.need); }

  // Claim anything already finished. Free gold — always do this before deciding what to grind.
  async claimReady() {
    let n = 0;
    for (const q of this.ready) {
      this.net.send({ t: 'claimQuest', id: q.id });
      this.stats.claimed++; this.stats.gold += q.gold || 0;
      this.log(`[quest] claimed "${q.label}" +${q.gold}g +${q.xp}xp`);
      n++;
      await sleep(500);
    }
    return n;
  }

  // The quest a given activity advances, so we can weigh activities by the bonus they unlock.
  // Quest definitions live in QUEST_POOL / NOVICE_QUESTS; the live set only carries id + progress.
  defOf(id) { return QUEST_POOL.find((q) => q.id === id) || NOVICE_QUESTS.find((q) => q.id === id) || null; }

  // Map a live quest onto the activity that progresses it.
  // A full plan for one objective: what to do, WHERE, and whether we can do it at all.
  //
  // The quest board is 38 objectives and most are specific in ways the label only hints at.
  // "Mine 10 Magma Ore (Emberwild)" is not "do some mining" — magma_ore comes from exactly one node
  // type, ember_rock, which needs mining Lv 22. "Slay 8 Voidrift horrors" means creatures of the
  // voidrift region, which start at Lv 34. Working these by skill alone advances them only by
  // accident, and attempting one that is out of reach wastes the focus slot until the stall
  // detector notices.
  planFor(q) {
    const def = this.defOf(q.id) || q;
    const base = this.activityFor(q);
    if (!base) return null;

    if (base.activity === 'gather' && def.item) {
      const lvl = levelForXp((this.state.me?.skills || {})[def.skill] || 0);
      const all = Object.entries(NODE_TYPES).filter(([, d]) => d.item === def.item);
      const reachable = all.filter(([, d]) => (d.req || 0) <= lvl && !d.dig);
      const cheapest = all.map(([, d]) => d.req || 0).sort((a, b) => a - b)[0] ?? 0;
      // Level is not the only gate. The nodes for coral live inside the Sunken Isles, and those for
      // wartree inside the Warscar — both behind portals with their own conditions. An objective we
      // meet the skill level for but cannot physically reach is not feasible.
      const types = reachable.map(([k]) => k);
      const realmGate = this.realmGateFor(types);
      return {
        ...base,
        nodeTypes: types,
        realm: realmGate?.realm || null,
        feasible: types.length > 0 && !realmGate?.blocked,
        blockedBy: !types.length ? `${def.skill} Lv ${cheapest}` : (realmGate?.blocked ? realmGate.why : null),
      };
    }

    // The Community Garden is shared. When every plot is taken by other players' crops the
    // objective is genuinely unworkable right now, and reporting it as feasible left it holding the
    // focus label while scoring zero — the panel said we were finishing something we were not.
    if (base.activity === 'garden') {
      const g = this.garden;
      const workable = !g || g.ready().length > 0 || (g.free().length > 0 && !!g.bestSeed());
      return { ...base, feasible: workable, blockedBy: workable ? null : 'a free garden plot' };
    }

    if (base.activity === 'combat') {
      const region = QUEST_REGION[q.id] ?? null;
      const lvl = levelForXp((this.state.me?.skills || {}).combat || 0);
      const kinds = region
        ? Object.entries(CREATURE_KINDS).filter(([, c]) => c.region === region).map(([k]) => k)
        : null;
      // The lowest-level creature in the region tells us whether the fight is even survivable.
      const floor = region
        ? Math.min(...Object.values(CREATURE_KINDS).filter((c) => c.region === region).map((c) => (c.lvl || [99])[0]))
        : 1;
      return {
        ...base,
        region,
        kinds,
        feasible: floor <= lvl + 4,
        blockedBy: floor <= lvl + 4 ? null : `combat Lv ${Math.max(1, floor - 4)} (${region} starts at Lv ${floor})`,
      };
    }

    // Cook and craft need INPUTS. "Craft 8 Goods" scores nothing while the satchel is empty, and
    // because it scores nothing it never gets worked, and because it never gets worked the satchel
    // stays empty — the objective sits at 0/8 forever looking like a stalled quest when what it
    // actually needs is a gathering trip first.
    if (base.activity === 'craft' || base.activity === 'cook') {
      const skill = base.activity === 'cook' ? 'cooking' : 'crafting';
      const lvl = levelForXp((this.state.me?.skills || {})[skill] || 0);
      const usable = RECIPES.filter((r) => r.skill === skill && (r.req || 1) <= lvl);
      const inputs = [...new Set(usable.flatMap((r) => Object.keys(r.in)))];
      const inv = this.state.me?.inv || {};
      const haveInputs = inputs.some((it) => (inv[it] || 0) > 0);
      // Which raw skill produces those inputs, so the orchestrator knows what to go and get.
      const feeders = [...new Set(inputs
        .map((it) => Object.values(NODE_TYPES).find((d) => d.item === it)?.skill)
        .filter(Boolean))];
      return { ...base, feasible: usable.length > 0, blockedBy: usable.length ? null : `${skill} recipes`, inputs, haveInputs, feeders };
    }

    return { ...base, feasible: true, blockedBy: null };
  }

  // Where the live nodes of these types actually are, and whether we can get in.
  realmGateFor(types) {
    if (!this.realms || !types.length) return null;
    const want = new Set(types);
    const realms = new Set();
    for (const n of this.state.nodes.values()) {
      if (!want.has(n.type)) continue;
      realms.add(this.realms.at(n.x, n.z));
    }
    if (realms.has(null) || !realms.size) return null;      // some are in the open world
    for (const r of realms) {
      const c = this.realms.canEnter(r);
      if (c.ok) return { realm: r, blocked: false };
    }
    const first = [...realms][0];
    return { realm: first, blocked: true, why: `${first}: ${this.realms.canEnter(first).why}` };
  }

  activityFor(q) {
    const def = this.defOf(q.id) || q;
    switch (def.kind) {
      case 'gather':
        // Garden crops are tagged `kind: 'gather'` but they do not come from foraging nodes — a
        // sunflower is planted, waited on and harvested. Mapping them to foraging sent the bot to
        // chop bushes for an item that can never drop, and because the quest never progressed it
        // stayed the "closest to done" forever and blocked every other objective.
        if (CROP_ITEMS.has(def.item)) return { activity: 'garden', crop: def.item };
        return { activity: 'gather', skill: def.skill, item: def.item };
      case 'cook':    return { activity: 'cook',   skill: 'cooking' };
      case 'craft':   return { activity: 'craft',  skill: 'crafting' };
      case 'combat':  return { activity: 'combat' };
      case 'contribute': return { activity: 'craft', contribute: true };   // craft goods, then give them
      default:        return null;
    }
  }

  // ONE quest at a time, finished before the next is started.
  //
  // Spreading effort across four objectives leaves four half-done quests and no payouts — progress
  // that a shift change or a day roll simply erases. Committing to the nearest-to-done one converts
  // it into gold and clears the board fastest, which is also what keeps a character from holding a
  // fleet slot on a board that never empties.
  // A focused quest that makes no progress has to yield. Some objectives are simply blocked by the
  // world right now — the Community Garden is shared, so "Harvest 4 Sunflowers" is unworkable while
  // other players occupy all eight plots — and without this the board's least-achievable quest wins
  // focus forever precisely because it never advances.
  noteProgress() {
    for (const q of this.open) {
      const prev = this._seen?.[q.id];
      if (!this._seen) this._seen = {};
      if (prev == null || (q.prog ?? 0) > prev) {
        this._seen[q.id] = q.prog ?? 0;
        if (this._stalls) delete this._stalls[q.id];
      }
    }
  }

  markStalled(id) {
    this._stalls = this._stalls || {};
    this._stalls[id] = (this._stalls[id] || 0) + 1;
    if (this._stalls[id] === STALL_LIMIT) this.log(`[quest] "${id}" isn't progressing — moving to the next objective`);
  }

  stalled(id) { return (this._stalls?.[id] || 0) >= STALL_LIMIT; }

  focusQuest() {
    this.noteProgress();
    let best = null, bestScore = -1;
    for (const q of this.open) {
      const def = this.defOf(q.id) || q;
      const plan = this.planFor(q);
      if (!plan) continue;                             // nothing we know how to work on
      if (!plan.feasible) continue;                    // out of reach — needs ${plan.blockedBy}
      if (this.stalled(q.id)) continue;                // blocked by the world; try it again later
      const need = q.need || def.need || 1;
      const prog = q.prog || 0;
      const remaining = Math.max(1, need - prog);
      const frac = prog / need;
      const value = (q.gold || def.gold || 0) + (q.xp || def.xp || 0) * 0.25;
      // Closeness dominates: a quest at 80% beats a richer one at 0% because finishing pays and
      // half-finishing does not.
      const score = frac * 1000 + value / remaining;
      if (score > bestScore) { bestScore = score; best = { ...plan, quest: q, frac, remaining, score }; }
    }
    return best;
  }

  // What the orchestrator weights toward. Same thing, kept under the old name so the scoring code
  // reads naturally.
  preferredActivity() { return this.focusQuest(); }

  // Human-readable: what are we finishing right now?
  focusLabel() {
    const f = this.focusQuest();
    if (!f) return null;
    const q = f.quest;
    return `${q.label} ${q.prog || 0}/${q.need}`;
  }

  // Every objective with its plan — what it needs, and why it cannot be done if it cannot.
  boardReport() {
    return (this.quests || []).map((q) => {
      const plan = this.planFor(q);
      const mark = q.claimed ? '✅' : (q.prog >= q.need ? '🎁' : plan && !plan.feasible ? '🔒' : this.stalled(q.id) ? '⏸' : '·');
      const note = q.claimed ? 'claimed'
        : !plan ? 'unsupported'
        : !plan.feasible ? `needs ${plan.blockedBy}`
        : this.stalled(q.id) ? 'not progressing'
        : plan.nodeTypes ? plan.nodeTypes.join('/')
        : plan.region ? `${plan.region} creatures`
        : plan.activity;
      return `${mark} ${String(q.label).slice(0, 24).padEnd(24)} ${String(q.prog || 0).padStart(3)}/${q.need}  ${note}`;
    }).join('\n');
  }

  questProgressReport() {
    if (!this.quests.length) return 'no quests';
    return this.quests.map((q) => `${q.claimed ? '✅' : (q.prog >= q.need ? '🎁' : '·')} ${q.label} ${q.prog || 0}/${q.need}`).join('\n');
  }

  // --- tutorial -----------------------------------------------------------
  // One-time 100g + a 40 xp first-gather bonus. Only ever fires on a fresh character.
  async finishTutorial() {
    if (this.state.me?.tutorialDone) return false;
    this.net.send({ t: 'tutorialDone', skip: false });
    await sleep(600);
    this.log(`[quest] tutorial completed (+${TUTORIAL.reward}g)`);
    return true;
  }

  // --- daily wheel --------------------------------------------------------
  // One free spin a day; paid spins cost 200g against a 100g consolation floor, so we only ever
  // take the free one.
  async freeSpin() {
    await this.move.walkTo(WHEEL_HOUSE.x, WHEEL_HOUSE.z, { range: 3.0 });
    this.net.send({ t: 'wheelOpen' });
    await sleep(600);
    this.net.send({ t: 'spinWheel' });
    this.stats.spins++;
    await sleep(1500);
    return true;
  }

  // --- slayer bounties ----------------------------------------------------
  // A board task is a stack of kills we'd be doing anyway, paid as a bundle. DAILY_CAP 4 tasks.
  async takeSlayerTask() {
    await this.move.walkTo(SLAYER_BOARD.x, SLAYER_BOARD.z, { range: SLAYER.RANGE - 2 });
    this.net.send({ t: 'slayerBoard' });
    await sleep(900);
    if (this.slayer) this.log(`[quest] slayer task: ${JSON.stringify(this.slayer).slice(0, 200)}`);
    return this.slayer;
  }

  // --- falling stars ------------------------------------------------------
  // A star drops every ~95-165 s and pays 2 gems + 50 xp for a walk. It expires in 70 s, so it is
  // only worth breaking off for when it lands close.
  starWorthChasing(maxDist = 60) {
    const s = this._starActive;
    if (!s || s.x == null) return null;
    const d = Math.hypot(s.x - this.state.pos.x, s.z - this.state.pos.z);
    if (d > maxDist) return null;
    if (d / this.move.speed > (STAR.ttlMs / 1000) * 0.7) return null;   // can't make it in time
    return { ...s, dist: d };
  }

  async chaseStar() {
    const s = this.starWorthChasing();
    if (!s) return false;
    try {
      await this.move.walkTo(s.x, s.z, { range: STAR.claimRange - 1.4, timeoutMs: 40000 });
      for (let i = 0; i < 6 && this._starActive; i++) { this.net.send({ t: 'claimStar' }); await sleep(800); }
      this.stats.stars++;
      this.log('[quest] claimed a falling star (+2 gems)');
      return true;
    } catch (e) { this.log(`[quest] star missed: ${e.message}`); return false; }
  }

  // --- treasure maps ------------------------------------------------------
  // torn_map drops at 0.6% per gather / 1.2% per kill. Reading it marks an X within digRadius 8.
  async runTreasure() {
    if (!(this.state.me?.inv || {}).torn_map) return false;
    this.net.send({ t: 'readMap' });
    await sleep(900);
    const t = this.treasure;
    if (!t || t.x == null) return false;
    try {
      await this.move.walkTo(t.x, t.z, { range: 2.0, timeoutMs: 90000 });
      for (let i = 0; i < 5; i++) { this.net.send({ t: 'digTreasure' }); await sleep(900); }
      this.stats.digs++;
      this.log('[quest] dug up a treasure');
      return true;
    } catch (e) { this.log(`[quest] treasure unreachable: ${e.message}`); this.net.send({ t: 'abandonTreasure' }); return false; }
  }

  // --- story quests -------------------------------------------------------
  // Keepers hand out one-off story rewards. Talking is free; the server answers with the beat.
  async talkToKeepers(npcs = ['market', 'bank', 'blacksmith', 'wearables', 'pets', 'wheel', 'casino']) {
    for (const npc of npcs) {
      const b = BUILDINGS.find((x) => x.shop === npc);
      if (!b) continue;
      try {
        await this.move.walkTo(b.x, b.z, { range: 3.0, timeoutMs: 45000 });
        this.net.send({ t: 'storyTalk', npc });
        await sleep(700);
      } catch { /* blocked — try the next keeper */ }
    }
  }
}
