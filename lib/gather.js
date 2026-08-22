// gather.js — woodcutting / mining / fishing / foraging.
//
// Cadence is copied from the client: swing every 0.9 / (gatherSpeed(lvl) × toolSpeed) seconds.
// Going faster is pointless — the server runs the same table and would just drop the extra frames.
//
// THE FALLOFF IS THE WHOLE GAME HERE (docs/RE-PROTOCOL.md §5):
//   GATHER_FALLOFF = { freeGathers: 25, perStepCut: 0.05, floorMult: 0.25, decayMs: 4000 }
// The first 25 swings pay full. After that every swing shaves 5% off the yield, down to a 25%
// floor, and you recover one step per 4 s idle. So a bot that never stops is a bot earning quarter
// rate. We track the streak locally and hand the orchestrator a `spent` signal to rotate on.
import { NODE_TYPES, GATHER_FALLOFF, gatherSpeed, levelForXp, toolBonus, KINSHIP_RADIUS, kinshipMultiplier, CAMPFIRE } from './rules.js';
import { sleep } from './movement.js';
import { human } from './stealth.js';

const NODE_RANGE = 2.2;   // server gates at 3.0; we stand well inside so leash skew can't cross it

export class Gatherer {
  constructor({ net, state, move, log = console.log }) {
    this.net = net; this.state = state; this.move = move; this.log = log;
    this.streak = 0;            // swings since the falloff last sat at zero
    this.lastSwingAt = 0;
    this.stats = { swings: 0, byType: {} };
    this.blocked = new Set();   // node types the server refused this session (level gate, region lock)
    this.bagFull = false;       // set by the server's "Satchel full" refusal, cleared on a sale
    this.rally = null;          // fleet centroid, set by Fleet.syncRally() — see kinship note below
    this.deadNodes = new Set(); // individual nodes that produced nothing — skipped, type kept
    this.typeFailures = {};     // type -> how many distinct nodes of it came up empty
    this._abandon = false;
    this._stop = false;

    // Belt and braces for the level filter: if the server ever refuses a type we thought we
    // qualified for, stop feeding it swings immediately instead of grinding the falloff for zero.
    net.on('toast', (m) => {
      const text = m?.text || '';
      const hit = /node needs (\w+) Lv (\d+)/i.exec(text);
      if (hit && this._current) { this.blocked.add(this._current.type); this._abandon = true; }
      // A full satchel makes the server refuse every gather, and a refused gather consumes no hit —
      // so the node never depletes and the loop swings forever. One run burned 195 swings on a
      // single bamboo before the 90 s timer caught it. Stop on the first refusal.
      if (/satchel full/i.test(text)) { this.bagFull = true; this._abandon = true; }
    });
  }

  // Falloff steps decay one per 4 s of not gathering, so an idle stretch heals the streak.
  _decayStreak() {
    if (!this.lastSwingAt) return;
    const steps = Math.floor((Date.now() - this.lastSwingAt) / GATHER_FALLOFF.decayMs);
    if (steps > 0) this.streak = Math.max(0, this.streak - steps);
  }

  // Current yield multiplier — what the next swing is actually worth.
  yieldMult() {
    this._decayStreak();
    const over = Math.max(0, this.streak - GATHER_FALLOFF.freeGathers);
    return Math.max(GATHER_FALLOFF.floorMult, 1 - over * GATHER_FALLOFF.perStepCut);
  }

  // True once we're grinding for materially reduced returns — the orchestrator's rotate signal.
  get spent() { return this.yieldMult() <= 0.6; }

  stop() { this._stop = true; this.move.stop(); }
  resume() { this._stop = false; }

  // A campfire is 120g for +10% XP inside radius 9 for ten minutes, and it stacks with kinship —
  // so it pays best in exactly the spot the fleet already clusters on. It must be placed at least
  // MIN_TOWN_DIST from town, which the cluster usually is.
  async placeCampfireIfWorth() {
    const inv = this.state.me?.inv || {};
    if (!(inv.campfire_kit > 0)) return false;
    if (Date.now() - (this._lastCampfire || 0) < CAMPFIRE.BURN_MS) return false;
    const me = this.state.pos;
    if (Math.hypot(me.x, me.z) < CAMPFIRE.MIN_TOWN_DIST) return false;
    this.net.send({ t: 'placeCampfire' });
    this._lastCampfire = Date.now();
    this.log(`[gather] lit a campfire (+${Math.round((CAMPFIRE.XP_MULT - 1) * 100)}% xp for ${CAMPFIRE.BURN_MS / 60000}m)`);
    return true;
  }

  skillLevel(skill) {
    return levelForXp((this.state.me?.skills || {})[skill] || 0);
  }

  // Node types carry a `req` level. Gathering an over-level node is not an error the server hides —
  // it answers "needs <skill> Lv N" and awards NOTHING, while our falloff streak still climbs. The
  // first live test burned 44 swings to 25% yield on a Lv-10 sakura tree at Lv 1, so requirements
  // are filtered here, up front, not discovered by toast.
  // Do we own the Sturdy Shovel gadget? Without it, `cache` nodes ("Buried Cache — walk over and
  // dig it up (needs a Shovel)") silently swallow every gather frame.
  hasShovel() {
    const owned = this.state.me?.owned || {};
    const lists = [owned.upgrades, owned.gadgets, owned.tools].filter(Array.isArray);
    return lists.some((l) => l.includes('shovel'));
  }

  nodeTypesFor(skill) {
    const lvl = this.skillLevel(skill);
    return Object.entries(NODE_TYPES)
      .filter(([k, d]) => {
        if (d.skill !== skill) return false;
        if ((d.req || 0) > lvl) return false;
        if (this.blocked.has(k)) return false;
        // `cache` is dug, not swung. It has hits:1 and never depletes for us, so including it
        // without a shovel parks the bot on one node forever (first integration run did exactly
        // this: picked cache #586 for its 38 xp and stalled the whole session).
        if (d.dig && !this.hasShovel()) return false;
        return true;
      })
      .map(([k]) => k);
  }

  // KINSHIP: every gather is multiplied by 1 + 0.15 × min(nearbyPlayers, 4) within radius 18 —
  // up to 1.6× for working alongside four others. That is a bigger swing than any tool upgrade, and
  // it is free. For a FLEET it is better than free: our own accounts count as each other's
  // neighbours, so clustering five characters on one grove pays every one of them +60%.
  kinshipAt(x, z) {
    let n = 0;
    for (const p of this.state.roster.values()) {
      if (p.id === this.state.me?.id) continue;
      if (p.x == null) continue;
      if (Math.hypot(p.x - x, p.z - z) <= KINSHIP_RADIUS) n++;
    }
    return kinshipMultiplier(n);
  }

  // Pick by XP-per-second, not by distance. A rich node 40 units away routinely beats the twig
  // underfoot, and nearest-first would never touch the good ones. Kinship is folded in, so a
  // slightly worse node inside a crowd beats a better one alone.
  pickNode(skill, candidates) {
    const interval = this.swingIntervalMs(skill) / 1000;
    const me = this.state.pos;
    let best = null, bestScore = -1;
    for (const n of candidates) {
      if (this.deadNodes.has(n.id)) continue;
      // Nodes inside a portal realm cannot be walked to. coral_outcrop sits at (-28, 678) in the
      // Sunken Isles and wartree at (-226, -815) in the Warscar; picking one meant a doomed
      // several-hundred-unit trek that timed out looking like a blocked path.
      if (this.realms && !this.realms.reachable(n.x, n.z)) continue;
      const def = NODE_TYPES[n.type]; if (!def) continue;
      const hits = n.hitsLeft ?? def.hits ?? 1;
      // Kinship counts players ALREADY near the node, which is circular for a scattered fleet:
      // nobody is near anybody, so nothing pulls them together. The rally breaks the tie by naming
      // an anchor character; everyone else treats nodes inside the anchor's kinship radius as if
      // the crowd were already there. A gentle nudge was measurably not enough (1.30/1.00/1.00
      // after three minutes), so within radius the bonus is applied in full.
      let mult = this.kinshipAt(n.x, n.z);
      if (this.rally) {
        const d = Math.hypot(n.x - this.rally.x, n.z - this.rally.z);
        // HALF the radius, deliberately. Nodes anywhere inside 18u of the centre are "in the
        // cluster", but two characters at opposite edges are 36u apart and worth nothing to each
        // other — which is why the first convergence measured 1.15x instead of 1.30x. Working
        // inside half the radius puts every member inside every other member's circle.
        if (d <= KINSHIP_RADIUS / 2) mult = Math.max(mult, kinshipMultiplier(this.rally.members - 1));
        else mult *= 0.5;   // decisive: outside the cluster is worth half, so the fleet converges
      }
      const totalXp = (def.baseXp || 0) * hits * mult;
      const travel = Math.hypot(n.x - me.x, n.z - me.z) / this.move.speed;
      const score = totalXp / (travel + hits * interval + 0.5);
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  // Where the crowd is. The orchestrator uses this to keep a fleet clustered instead of scattering
  // it across the valley, which is the difference between 1.0× and 1.6× on every single swing.
  bestKinshipSpot(skill) {
    const types = this.nodeTypesFor(skill);
    const nodes = this.state.liveNodes(types);
    let best = null, bestMult = 1;
    for (const n of nodes) {
      const m = this.kinshipAt(n.x, n.z);
      if (m > bestMult) { bestMult = m; best = n; }
    }
    return best ? { ...best, mult: bestMult } : null;
  }

  swingIntervalMs(skill) {
    const me = this.state.me;
    const lvl = levelForXp((me?.skills || {})[skill] || 0);
    const tspeed = toolBonus(me?.tools || {}, skill).speed;
    return (0.9 / (gatherSpeed(lvl) * tspeed)) * 1000;
  }

  // Work one node until it's depleted (or we're told to stop). Returns swings landed.
  async workNode(node, skill) {
    if (this.bagFull) return 0;
    let swings = 0;
    const interval = this.swingIntervalMs(skill);
    // Progress watchdog. A node whose hitsLeft never moves and whose loot never lands is one the
    // server is ignoring — a dig node, a region lock, a rule we haven't reverse-engineered yet.
    // Without this the loop swings at it until the session ends, looking healthy the whole time.
    let lastBag = this.state.invTotal();
    let lastHits = node.hitsLeft ?? null;
    let barren = 0;
    const deadline = Date.now() + 90000;

    while (!this._stop) {
      if (this._abandon) break;   // server refused this node type — drop it, the run loop re-picks
      if (Date.now() > deadline) { this.log(`[gather] abandoning #${node.id} (${node.type}): 90s with no depletion`); this.deadNodes.add(node.id); break; }
      const live = this.state.nodes.get(node.id);
      if (!live || live.depleted || (live.respawnAt && live.respawnAt > Date.now())) break;
      if (this.move.distanceTo(live) > NODE_RANGE + 0.6) break;   // drifted (knockback, aggro) — re-approach

      // Neither the node's hit counter nor our satchel moved for 6 swings => it is not yielding.
      if (swings > 0) {
        const hitsNow = live.hitsLeft ?? null;
        const bagNow = this.state.invTotal();
        // Compare against the PREVIOUS swing, not against entry: measuring from entry meant one
        // early pickup marked the node productive forever, which is exactly how 195 barren swings
        // got past this check.
        const moved = (hitsNow !== lastHits) || (bagNow !== lastBag);
        barren = moved ? 0 : barren + 1;
        lastHits = hitsNow;
        lastBag = bagNow;
        if (barren >= 6) {
          // Blame the NODE first. One barren node can be a race with another player, a partially
          // depleted state or a region rule that applies to that spot alone — condemning the whole
          // type on that evidence throws away a good source for the rest of the session. Only after
          // three separate nodes of a type come up empty is the type itself the likely problem.
          this.deadNodes.add(node.id);
          const n = (this.typeFailures[node.type] = (this.typeFailures[node.type] || 0) + 1);
          if (n >= 3) {
            this.blocked.add(node.type);
            this.log(`[gather] ${node.type}: 3 nodes yielded nothing — blocking the type`);
          } else {
            this.log(`[gather] #${node.id} (${node.type}) yields nothing — skipping it (${n}/3)`);
          }
          break;
        }
      }

      this.net.send({ t: 'gather', id: node.id });
      swings++; this.stats.swings++;
      this.stats.byType[node.type] = (this.stats.byType[node.type] || 0) + 1;
      this._decayStreak();
      this.streak++; this.lastSwingAt = Date.now();

      await sleep(human(interval));   // a swing landing on the exact same millisecond forever is the tell
      this.move.heartbeat('gather');   // keep the leash anchor converged while we stand and swing
    }
    return swings;
  }

  // Gather `skill` until `stopWhen()` says otherwise. Walks node to node, nearest first.
  // `only` pins the node types, which is how a quest for a specific item gets worked deliberately
  // rather than by luck: magma_ore comes from ember_rock and nowhere else, so mining any old rock
  // advances "Mine 10 Magma Ore" not at all.
  async run(skill, { stopWhen = () => false, maxMs = 15 * 60 * 1000, only = null } = {}) {
    this._stop = false;
    const types = only && only.length
      ? only.filter((t) => !this.blocked.has(t))
      : this.nodeTypesFor(skill);
    const started = Date.now();
    let worked = 0;

    while (!this._stop && Date.now() - started < maxMs) {
      if (stopWhen(this)) break;
      if (this.bagFull) { this.log('[gather] satchel full — nothing more fits'); break; }

      const candidates = this.state.liveNodes(types);
      if (!candidates.length) {
        // Never spin here in silence. An empty candidate list for minutes means the node map or the
        // level filter is wrong, and that has to show up in the log instead of looking like work.
        if (Date.now() - (this._lastEmptyLog || 0) > 20000) {
          this._lastEmptyLog = Date.now();
          this.log(`[gather] no live ${skill} nodes (types: ${types.join(',') || 'NONE'}; map holds ${this.state.nodes.size})`);
        }
        await sleep(2000); continue;
      }   // everything on respawn — wait it out

      const target = this.pickNode(skill, candidates);
      if (!target) { await sleep(2000); continue; }
      this._current = target;
      await this.placeCampfireIfWorth();

      try {
        this.log(`[gather] -> ${target.type} #${target.id} @${target.x.toFixed(0)},${target.z.toFixed(0)} (${this.move.distanceTo(target).toFixed(0)}u)`);
        await this.move.walkToward(target, { range: NODE_RANGE, timeoutMs: 45000 });
      } catch (err) {
        this.log(`[gather] skip node ${target.id}: ${err.message}`);
        this.state.nodes.delete(target.id);   // unreachable — drop it for this session
        continue;
      }

      this._abandon = false;
      const swings = await this.workNode(target, skill);
      this.log(`[gather] ${target.type} #${target.id}: ${swings} swings · yield ${(this.yieldMult() * 100).toFixed(0)}% · bag ${this.state.invTotal()}`);
      if (swings && !this._abandon) worked++;
    }
    return { nodesWorked: worked, ...this.stats, yieldMult: this.yieldMult() };
  }
}
