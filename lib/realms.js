// realms.js — the seven places you cannot walk to.
//
// Kindra is "one seamless world" of eleven open regions PLUS seven portal realms reached through a
// door. The bot did not know the difference: coral_outcrop nodes sit at (-28, 678) inside the
// Sunken Isles and wartree at (-226, -815) inside the Warscar, and every attempt to work them was a
// walk across hundreds of units toward somewhere unreachable, which timed out and looked like a
// blocked path.
//
// Each portal carries its own entry condition, and they are not all levels:
//   isles     — open to anyone
//   voidrift  — reqLevel 5
//   hollow    — reqCombat 20
//   warscar   — reqCombat 45 AND 50,000 $KINDRA held on-chain
//   founders  — holders only
//   kartway   — the racing realm
//   floor     — the Trading Floor (hidden entrance)
import { PORTALS, realmAt, levelForXp } from './rules.js';
import { sleep } from './movement.js';

const ENTRY_RANGE = 3.0;

export class Realms {
  constructor({ net, state, move, log = console.log }) {
    this.net = net; this.state = state; this.move = move; this.log = log;
    this.blocked = new Set();   // realms the server refused this session
  }

  // Which realm a point belongs to, or null for the open world.
  at(x, z) { return realmAt(x, z)?.id || null; }

  // Where we are now.
  current() { return this.at(this.state.pos.x, this.state.pos.z); }

  // The inbound portal for a realm, if one exists.
  entrance(realmId) {
    return PORTALS.find((p) => p.to && this.at(p.to.x, p.to.z) === realmId && !/_out$/.test(p.id)) || null;
  }

  exit(realmId) {
    return PORTALS.find((p) => this.at(p.x, p.z) === realmId && /_out$/.test(p.id)) || null;
  }

  // Can this character pass? The server is authoritative, but checking first avoids a pointless
  // trek to a door that will not open.
  canEnter(realmId) {
    if (!realmId) return { ok: true };
    if (this.blocked.has(realmId)) return { ok: false, why: 'the server refused this realm' };
    const p = this.entrance(realmId);
    if (!p) return { ok: false, why: 'no known portal' };

    const me = this.state.me || {};
    const combat = levelForXp((me.skills || {}).combat || 0);
    if (p.reqCombat && combat < p.reqCombat) return { ok: false, why: `combat Lv ${p.reqCombat}` };
    if (p.reqLevel && (me.tl || 1) < p.reqLevel) return { ok: false, why: `account Lv ${p.reqLevel}` };
    if (p.holdersMin && (me.kbal || 0) < p.holdersMin) return { ok: false, why: `${p.holdersMin.toLocaleString()} $KINDRA held` };
    if (p.holders && !(me.kbal > 0)) return { ok: false, why: 'holders only' };
    return { ok: true, portal: p };
  }

  // Reachable means: same realm as us, or a realm we can walk to a door for and step through.
  reachable(x, z) {
    const target = this.at(x, z);
    if (target === this.current()) return true;
    if (!target) return this.canLeave();          // heading back to the open world
    return this.canEnter(target).ok;
  }

  canLeave() {
    const here = this.current();
    return !here || !!this.exit(here);
  }

  // Step through to `realmId` (or back to the open world with null). Returns true once we are there.
  async travelTo(realmId) {
    if (this.current() === realmId) return true;

    // Leave wherever we are first — realms do not connect to each other directly.
    const here = this.current();
    if (here && here !== realmId) {
      const out = this.exit(here);
      if (!out) { this.log(`[realm] no way out of ${here}`); return false; }
      if (!(await this.step(out))) return false;
    }
    if (!realmId) return true;

    const check = this.canEnter(realmId);
    if (!check.ok) { this.log(`[realm] ${realmId} needs ${check.why}`); return false; }
    return this.step(check.portal);
  }

  async step(portal) {
    try {
      await this.move.walkTo(portal.x, portal.z, { range: ENTRY_RANGE, timeoutMs: 180000 });
    } catch (e) {
      this.log(`[realm] couldn't reach the ${portal.name} portal: ${e.message}`);
      return false;
    }
    const before = this.current();
    for (let i = 0; i < 4; i++) {
      this.net.send({ t: 'usePortal', id: portal.id });
      await sleep(1200);
      if (this.current() !== before) {
        this.log(`[realm] stepped through to ${portal.name}`);
        return true;
      }
    }
    // Four refusals is the server saying no, whatever our own check thought.
    const dest = this.at(portal.to.x, portal.to.z);
    if (dest) this.blocked.add(dest);
    this.log(`[realm] the ${portal.name} portal did not open`);
    return false;
  }

  report() {
    const here = this.current() || 'the valley';
    const rows = [...new Set(PORTALS.map((p) => this.at(p.to?.x, p.to?.z)).filter(Boolean))].map((r) => {
      const c = this.canEnter(r);
      return `${c.ok ? '✅' : '🔒'} ${r.padEnd(10)} ${c.ok ? 'open' : `needs ${c.why}`}`;
    });
    return [`you are in: ${here}`, ...rows].join('\n');
  }
}
