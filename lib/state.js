// state.js — the bot's live mirror of the server world, rebuilt from the protocol frames.
//
// `init` is a COMPLETE world snapshot (773 nodes, every creature, the full market book), so we
// never have to explore: we plan against it directly and keep it fresh from the delta frames.
import { EventEmitter } from 'node:events';

export class GameState extends EventEmitter {
  constructor() {
    super();
    this.me = null;            // you.* from init, kept live by snap/hp/inv/wallet
    this.world = null;
    this.nodes = new Map();    // id -> { id, type, x, z, hitsLeft, maxHits, depleted, respawnAt }
    this.creatures = new Map();// id -> { id, x, z, hp, maxHp, dead, kind, level }
    this.roster = new Map();   // other players
    this.bosses = new Map();
    this.market = [];
    this.marketPrices = {};
    this.buyOrders = [];
    this.quests = [];
    this.sacks = new Map();    // death sacks — ours must be reclaimed
    this.haul = {};            // live daily-cap counters, straight from the server
    this.online = 0;
    this.joinedAt = 0;
  }

  // Wire every frame we care about. Anything not handled still reaches listeners via net 'frame'.
  attach(net) {
    net.on('init', (m) => {
      this.me = { ...m.you };
      this.world = m.world;
      this.haul = m.you.haul || {};
      this.nodes.clear();      for (const n of m.nodes || []) this.nodes.set(n.id, n);
      this.creatures.clear();  for (const c of m.creatures || []) this.creatures.set(c.id, c);
      this.roster.clear();     for (const p of m.roster || []) this.roster.set(p.id, p);
      this.bosses.clear();     for (const b of m.bosses || []) this.bosses.set(b.id, b);
      this.market = m.market || [];
      this.marketPrices = m.marketPrices || {};
      this.buyOrders = m.buyOrders || [];
      this.quests = m.quests || [];
      this.online = m.online || 0;
      this.joinedAt = Date.now();
      this.emit('ready', this);
    });

    // `snap` is the ~20 Hz world tick: other players' positions. It does NOT move us — the server
    // echoes our own position back, and trusting it would fight our local walk simulation.
    net.on('snap', (m) => {
      for (const p of m.p || m.players || []) {
        if (this.me && p.id === this.me.id) continue;
        const cur = this.roster.get(p.id) || { id: p.id };
        this.roster.set(p.id, { ...cur, ...p });
      }
    });

    // Depletion arrives as { id, depleted:true, respawnAt:<future> }; the respawn arrives as
    // { id, depleted:false } with NO respawnAt. A plain {...old,...new} merge keeps the stale future
    // timestamp, so liveNodes() would hide that node for the rest of the session and the usable map
    // drains away as the bot works it. Clear the timer whenever a node reports itself alive.
    net.on('nodeState', (m) => {
      for (const n of (Array.isArray(m.nodes) ? m.nodes : [m])) {
        if (n.id == null) continue;
        const merged = { ...(this.nodes.get(n.id) || {}), ...n };
        if (n.depleted === false && n.respawnAt == null) merged.respawnAt = 0;
        this.nodes.set(n.id, merged);
      }
    });
    net.on('creatureState', (m) => {
      for (const c of (Array.isArray(m.creatures) ? m.creatures : [m])) {
        if (c.id == null) continue;
        this.creatures.set(c.id, { ...(this.creatures.get(c.id) || {}), ...c });
      }
    });
    net.on('creatureEnter', (m) => { if (m.id != null) this.creatures.set(m.id, { ...(this.creatures.get(m.id) || {}), ...m }); });
    net.on('creatureGone', (m) => { if (m.id != null) this.creatures.delete(m.id); });
    net.on('creatureHit', (m) => {
      const c = this.creatures.get(m.id);
      if (c) this.creatures.set(m.id, { ...c, hp: m.hp ?? c.hp, dead: m.hp != null ? m.hp <= 0 : c.dead });
    });

    // `inv` is the combined pickup/XP/damage frame: { inv, hp, skills }. Taking only `inv` from it
    // left skills frozen at their join values and every XP delta invisible (first gather test).
    net.on('inv', (m) => {
      if (!this.me) return;
      if (m.inv) this.me.inv = m.inv;
      if (m.skills) this.me.skills = m.skills;
      if (Number.isFinite(m.hp)) this.me.hp = m.hp;
      this.emit('inv', this.me.inv);
    });
    // The `hp` frame is the OUT-OF-COMBAT REGEN channel, and it is only ever about you — the real
    // client applies it with no id check at all (main.js:2047, "usually out-of-combat regen").
    // Requiring m.id === me.id threw away every regen tick, so our copy of our own health only
    // moved when an `inv` frame happened to carry it. Health looked frozen: combat.recover() stood
    // still for 45 seconds waiting for a number that could not change and then reported success
    // anyway — 250 of 262 "recoveries" healed nothing — and every survivability check, the boss
    // gate at 70% among them, was reading a character as half dead while it stood at full.
    net.on('hp', (m) => {
      if (!this.me || !Number.isFinite(m?.hp)) return;
      if (m.id != null && m.id !== this.me.id) return;
      this.me.hp = m.hp;
    });
    // OUR OWN level-up arrives on the `reward` frame as { up:true, skill, level }. `ding` is the
    // beacon for OTHER players levelling — the server deliberately excludes you from it — so
    // listening to it produced "reached undefined Lv undefined" notifications.
    net.on('reward', (m) => {
      if (m?.up && m.skill) this.emit('levelup', { skill: m.skill, level: m.level });
      if (m?.gold) this.emit('gold', m.gold);
    });
    net.on('ding', (m) => this.emit('otherLevelup', m));   // someone else's milestone; not ours

    // `wallet` carries gold, the on-chain $KINDRA balance (kbal) and — crucially — the live daily
    // cap counters. The orchestrator reads these instead of guessing when a source is exhausted.
    net.on('wallet', (m) => {
      if (!this.me) return;
      if (m.gold != null) this.me.gold = m.gold;
      if (m.kbal != null) this.me.kbal = m.kbal;
      if (m.tools) this.me.tools = m.tools;
      if (m.satchel) this.me.satchel = m.satchel;
      if (m.owned) this.me.owned = m.owned;
      // APPEARANCE carries what is actually HELD. Without this the character equips a weapon, the
      // server confirms it, and our copy still says `weapon: null` — so the bot believed it was
      // unarmed forever and re-bought the same bow every cycle, 50 gold at a time.
      if (m.appearance) this.me.appearance = { ...(this.me.appearance || {}), ...m.appearance };
      if (m.dura) this.me.dura = m.dura;
      if (m.haul) { this.haul = m.haul; this.emit('haul', m.haul); }
      this.emit('wallet', m);
    });

    net.on('market', (m) => { if (Array.isArray(m.listings)) this.market = m.listings; if (m.prices) this.marketPrices = m.prices; });
    // `init` seeds the board as m.quests, but every LIVE refresh names it m.list (client
    // main.js:2070). We only ever read m.quests, so progress froze at the join snapshot: a board
    // read "Give 6 goods to the Monument 0/6" for 208 consecutive cycles while the character was
    // handing goods over, and no quest could ever be claimed. Accept both names.
    net.on('quest', (m) => { const q = m.list ?? m.quests; if (Array.isArray(q)) this.quests = q; });
    // The sack rides NESTED in the frame — `{ t:'sackSpawn', sack:{...} }` (client main.js:2050,
    // `addSack(m.sack)`). Reading m.id/m.x off the envelope stored ONE entry keyed `undefined`
    // whose x and z were undefined too, and the reclaim walk then aimed at NaN. See movement.js:
    // that poisoned our own position permanently. `sackGone` really is flat — the id is on the
    // envelope there — so the two lines are deliberately not symmetric.
    net.on('sackSpawn', (m) => { const s = m?.sack; if (s && s.id != null) this.sacks.set(s.id, s); });
    net.on('sackGone',  (m) => { if (m?.id != null) this.sacks.delete(m.id); });
    // A portal MOVES us, and the server announces it with `teleport` — the one frame that is
    // allowed to overwrite our own position, because the server never echoes it back otherwise
    // (`snap` deliberately skips us). We were not listening at all: after stepping through, our
    // model still said we stood at the door. realms.step() watches for the realm under our feet to
    // change, saw it never change, called the portal refused after four tries and latched the whole
    // realm as blocked — so two of the four gold-paying bosses were unreachable forever. Worse, the
    // server thought we were in the isles while every walk we computed started from the mainland.
    net.on('teleport', (m) => {
      if (!this.me || !Number.isFinite(m?.x) || !Number.isFinite(m?.z)) return;
      this.me.x = m.x; this.me.z = m.z;
      // The server resets its streamed manifest across a zone change and re-sends the new area's
      // creatures on its next tick (client main.js:3912). Keeping the old set would have us walking
      // at monsters that are not in this zone. Nodes come from the full `init` snapshot, not the
      // stream, so they stay.
      this.creatures.clear();
      this.emit('teleport', { x: m.x, z: m.z });
    });
    net.on('ko', (m) => this.emit('death', m));
    net.on('style', (m) => { if (this.me && m.appearance) this.me.appearance = { ...this.me.appearance, ...m.appearance }; });
    net.on('change', (m) => { if (this.me && m.appearance) this.me.appearance = { ...this.me.appearance, ...m.appearance }; });
    net.on('reject', (m) => this.emit('rejected', m));
    return this;
  }

  // --- queries the activity modules lean on ---------------------------------

  get pos() { return this.me ? { x: this.me.x, z: this.me.z } : { x: 0, z: 0 }; }

  invCount(item) { return (this.me?.inv || {})[item] || 0; }
  invTotal() { return Object.values(this.me?.inv || {}).reduce((a, b) => a + b, 0); }

  // A node is harvestable when it isn't depleted and its respawn timer has passed.
  liveNodes(types) {
    const want = types ? new Set(Array.isArray(types) ? types : [types]) : null;
    const now = Date.now();
    const out = [];
    for (const n of this.nodes.values()) {
      if (want && !want.has(n.type)) continue;
      if (n.depleted) continue;
      if (n.respawnAt && n.respawnAt > now) continue;
      out.push(n);
    }
    return out;
  }

  nearest(list, from = this.pos) {
    let best = null, bestD = Infinity;
    for (const it of list) {
      const d = Math.hypot(it.x - from.x, it.z - from.z);
      if (d < bestD) { bestD = d; best = it; }
    }
    return best ? { ...best, dist: bestD } : null;
  }

  // Alive creatures inside a level band, so the combat module never picks a fight it loses.
  liveCreatures({ maxLevel = 99, minLevel = 0, kinds = null } = {}) {
    const want = kinds ? new Set(kinds) : null;
    const out = [];
    for (const c of this.creatures.values()) {
      if (c.dead || (c.hp != null && c.hp <= 0)) continue;
      if (c.level > maxLevel || c.level < minLevel) continue;
      if (want && !want.has(c.kind)) continue;
      out.push(c);
    }
    return out;
  }

  // True once a daily gold source is spent — the orchestrator's switch signal.
  capped(source) {
    const h = this.haul || {};
    const cur = h[source], cap = h[`${source}Cap`];
    return cap != null && cur != null && cur >= cap;
  }
  capReport() {
    const h = this.haul || {};
    return ['combat', 'boss', 'vendor', 'trade', 'bounty', 'kart']
      .filter((k) => h[`${k}Cap`] != null)
      .map((k) => `${k} ${h[k]}/${h[`${k}Cap`]}`)
      .join(' · ');
  }
}
