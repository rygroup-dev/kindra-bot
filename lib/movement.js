// movement.js — walk simulation that satisfies the server's anti-cheat leash.
//
// The server keeps its OWN copy of our position and rejects range-gated actions when the client
// runs ahead of it (docs/RE-PROTOCOL.md §4). So we never teleport: we integrate position at walk
// speed and stream `move` frames the same way the real client does.
//
//   MOVE = { baseSpeed: 7, headroom: 1.15, slack: 1.2 }
//
// We walk at baseSpeed exactly. The headroom is the server's tolerance, not a budget to spend —
// burning it leaves nothing for latency jitter, which is what the leash is there to absorb.
import { MOVE } from './rules.js';
import { human } from './stealth.js';

const TICK_MS = 100;                    // the client streams at ~10 Hz; matching it keeps us unremarkable
const ARRIVE_EPS = 0.05;

export class Movement {
  constructor(net, state) {
    this.net = net;
    this.state = state;
    this.speed = MOVE.baseSpeed;
    this._stop = false;
  }

  // A tiny idle heartbeat. Standing perfectly still lets the server's leash anchor drift behind
  // us under lag, which is exactly what broke range-gated reclaims for real players (client
  // comment, 2026-08-01). ~700 ms of "I'm still here" keeps the anchor converged.
  heartbeat(anim = 'idle') {
    const me = this.state.me;
    if (!me) return;
    this.net.send({ t: 'move', x: +me.x.toFixed(2), z: +me.z.toFixed(2), ry: +(me.ry || 0).toFixed(3), anim });
  }

  stop() { this._stop = true; }

  // Walk to (x, z), stopping once within `range`. Straight-line: the valley is open ground and the
  // server is authoritative on collision anyway — if we get stuck, arrival simply times out and the
  // caller picks another target rather than burning the session against a rock.
  async walkTo(x, z, { range = 1.2, timeoutMs = 60000, anim = 'run' } = {}) {
    this._stop = false;
    const me = this.state.me;
    if (!me) throw new Error('walkTo before init');
    const started = Date.now();
    let lastStuckCheck = Date.now();
    let lastDist = Math.hypot(x - me.x, z - me.z);

    while (!this._stop) {
      const dx = x - me.x, dz = z - me.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= range) break;
      if (Date.now() - started > timeoutMs) throw new Error(`walkTo timed out ${dist.toFixed(1)}u short`);

      // No progress for 5 s => something solid is in the way; let the caller re-plan.
      if (Date.now() - lastStuckCheck > 5000) {
        if (lastDist - dist < 0.5) throw new Error('walkTo stuck (blocked)');
        lastStuckCheck = Date.now(); lastDist = dist;
      }

      const step = Math.min(this.speed * (TICK_MS / 1000), dist);
      me.x += (dx / dist) * step;
      me.z += (dz / dist) * step;
      me.ry = Math.atan2(dx, dz);

      this.net.send({ t: 'move', x: +me.x.toFixed(2), z: +me.z.toFixed(2), ry: +me.ry.toFixed(3), anim });
      await sleep(human(TICK_MS, 0.10));
    }
    // Settle on the spot so the server's anchor lands where we think we are before we act.
    this.heartbeat('idle');
    await sleep(150);
    return { x: me.x, z: me.z };
  }

  walkToward(target, opts) { return this.walkTo(target.x, target.z, opts); }

  distanceTo(target) {
    const me = this.state.me;
    return me ? Math.hypot(target.x - me.x, target.z - me.z) : Infinity;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
