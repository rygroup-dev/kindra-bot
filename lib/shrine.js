// The Shrine of the Valley — the one sink that pays us back.
//
// Everything else in the economy wants gold. The shrine wants MATERIALS, and it is the only system
// that turns the fleet's worst structural problem into an asset: a satchel full of raw stock the
// vendor is capped on and the market has no bid for. `devotionOf()` prices that dead weight, and a
// blessing prices out at 150-450 devotion for two hours.
//
// Gatherer's Grace is the standout — 10% chance of double yield for two hours, paid for in the very
// materials that were rotting in the bag. Stone Vigil is the other one that earns its keep: the
// three deaths on 2026-08-22 all came down to damage taken, and −8% is a permanent discount on that
// for as long as we keep it up.
import { SHRINE, ITEMS, devotionOf } from './rules.js';
import { sleep } from './movement.js';

const DONATE_MS = 400;        // the gilded chip next door is on a 1.2 s cooldown; be politely slower

export class Shrine {
  constructor({ net, state, move, log = console.log }) {
    this.net = net; this.state = state; this.move = move; this.log = log;
    this.devotion = 0;              // server-reported where it can be; a local tally otherwise
    this.donatedToday = 0;          // against SHRINE.dailyCap
    this.blessedUntil = {};         // id -> ms, from our own purchases and any server frame
    this.closed = false;            // latched from the server's own refusal
    this.stats = { donated: 0, devotion: 0, blessings: 0 };

    // Same discipline as the vendor: the server states the reason, so read it instead of computing
    // a second opinion that can disagree.
    net.on('toast', (m) => {
      const t = m?.text || '';
      if (/shrine.*(cap|enough for today|daily)/i.test(t)) {
        if (!this.closed) this.log('[shrine] daily devotion cap reached — done offering until the day rolls');
        this.closed = true;
      }
      if (/not enough devotion|cannot afford/i.test(t)) this.devotion = 0;
    });
    net.on('wallet', (m) => {
      if (typeof m?.devotion === 'number') this.devotion = m.devotion;
      if (m?.blessings) for (const [id, until] of Object.entries(m.blessings)) this.blessedUntil[id] = until;
      if (m?.haul && (m.haul.vendor ?? 0) < 10) { this.closed = false; this.donatedToday = 0; }
    });
  }

  active(id) { return (this.blessedUntil[id] || 0) > Date.now(); }
  get anyActive() { return Object.keys(SHRINE.blessings).some((id) => this.active(id)); }

  // What the shrine will actually pay for. Quest-reserved stock and anything the market bids well on
  // stays out: this is for materials with nowhere else to go, not for our good inventory.
  offerable({ reserved = new Set(), keep = new Set() } = {}) {
    const inv = this.state.me?.inv || {};
    const out = [];
    for (const [id, qty] of Object.entries(inv)) {
      if (!qty || reserved.has(id) || keep.has(id)) continue;
      const per = devotionOf(id);
      if (per <= 0) continue;
      if (id === 'gem') continue;              // 25 devotion each, but gems buy far better elsewhere
      const it = ITEMS[id] || {};
      if (it.t === 'trophy') continue;         // trophies are the scarcity target — never feed them in
      // Cooked food is `made`, not `potion`, so devotionOf() happily prices it — and the first live
      // run fed 10 cooked fish to the shrine for 30 devotion. That is the character's healing, and a
      // bot with no rations dies. Same rule crafting.rationCount() uses.
      if (/^cooked/.test(id) || id === 'acorn_loaf') continue;
      out.push({ id, qty, per, total: per * qty });
    }
    // Cheapest stock first: a 1-devotion raw is worth less to us anywhere else than a 20-devotion craft.
    return out.sort((a, b) => a.per - b.per);
  }

  // Which blessing is worth buying for what this character is about to do. One at a time — they do
  // not stack, and 'all' is only better once we can afford the whole 450.
  wants({ activity = 'gather', dying = false } = {}) {
    const B = SHRINE.blessings;
    if (dying && !this.active('def')) return { id: 'def', ...B.def };
    if (this.devotion >= B.all.cost && !this.anyActive) return { id: 'all', ...B.all };
    if (activity === 'gather' && !this.active('gather')) return { id: 'gather', ...B.gather };
    if (activity === 'combat' && !this.active('dmg')) return { id: 'dmg', ...B.dmg };
    if (!this.active('xp')) return { id: 'xp', ...B.xp };
    return null;
  }

  async goTo() {
    await this.move.walkTo(SHRINE.POS.x, SHRINE.POS.z, { range: SHRINE.RANGE - 1 });
  }

  // Feed junk in until we can afford `target` devotion, or the bag runs out of things nobody wants.
  async donate({ target = 0, reserved = new Set(), keep = new Set() } = {}) {
    if (this.closed) return 0;
    const stock = this.offerable({ reserved, keep });
    if (!stock.length) return 0;

    const room = Math.max(0, SHRINE.dailyCap - this.donatedToday);
    if (room <= 0) { this.closed = true; return 0; }

    await this.goTo();
    let gained = 0;
    for (const s of stock) {
      if (this.closed) break;
      if (target && this.devotion + gained >= target) break;
      if (gained >= room) break;
      this.net.send({ t: 'shrineDonate', item: s.id, qty: s.qty });
      gained += s.total;
      this.stats.donated += s.qty;
      this.log(`[shrine] offered ${s.qty}× ${s.id} (+${s.total} devotion)`);
      await sleep(DONATE_MS);
    }
    this.devotion += gained;
    this.donatedToday += gained;
    this.stats.devotion += gained;
    return gained;
  }

  // The whole trip: turn dead stock into devotion, then spend it on the buff this character needs.
  async serve({ activity = 'gather', dying = false, reserved = new Set(), keep = new Set() } = {}) {
    const want = this.wants({ activity, dying });
    if (!want) return null;
    if (this.devotion < want.cost) {
      await this.donate({ target: want.cost, reserved, keep });
      if (this.devotion < want.cost) return null;    // not enough junk yet — try again next cycle
    }
    await this.goTo();
    this.net.send({ t: 'shrineBless', id: want.id });
    await sleep(600);
    this.devotion -= want.cost;
    this.blessedUntil[want.id] = Date.now() + (want.ms || 2 * 3600000);
    this.stats.blessings++;
    this.log(`[shrine] ${want.icon} ${want.name} — ${want.desc}, ${(want.ms / 3600000).toFixed(0)}h (−${want.cost} devotion)`);
    return want;
  }

  report() {
    const live = Object.entries(this.blessedUntil)
      .filter(([, until]) => until > Date.now())
      .map(([id, until]) => `${SHRINE.blessings[id]?.icon || '•'} ${SHRINE.blessings[id]?.name || id} ${Math.round((until - Date.now()) / 60000)}m`);
    return {
      devotion: this.devotion,
      donatedToday: this.donatedToday,
      cap: SHRINE.dailyCap,
      closed: this.closed,
      active: live,
      ...this.stats,
    };
  }
}
