// bot.js — one account, fully assembled. The fleet runs N of these.
//
// Each Bot owns its own socket, its own world mirror and its own brain. Nothing is shared between
// accounts except the process, which matters: a crash or a rejected login in one must not take the
// others down with it.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { CFG, WORLDS, ensureDataDir } from './config.js';
import { accountFromKey, buildAuth } from './auth.js';
import { Net } from './net.js';
import { GameState } from './state.js';
import { Movement } from './movement.js';
import { Gatherer } from './gather.js';
import { Combat } from './combat.js';
import { Economy } from './economy.js';
import { Crafting } from './crafting.js';
import { Quests } from './quests.js';
import { Upgrades } from './upgrades.js';
import { Bosses } from './bosses.js';
import { Jobs } from './jobs.js';
import { Garden } from './garden.js';
import { Referral } from './referral.js';
import { Realms } from './realms.js';
import { Orchestrator } from './orchestrator.js';
import { Telemetry, deviceProfile, randomAppearance, humanName } from './stealth.js';

// Deterministic per-account RNG so a character's name, look and reported hardware are stable for
// its whole life. A "player" whose appearance or GPU changes every login is more suspicious than
// one that never varies at all.
function seededRng(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}

export class Bot extends EventEmitter {
  constructor({ label, privateKey, world = CFG.world, name = '', referrer = null, proxy = null, appearance = null, onLog = null }) {
    super();
    this.label = label;
    this.world = typeof world === 'string' ? (WORLDS[world] || CFG.world) : world;
    this.account = accountFromKey(privateKey);
    this.proxy = proxy;
    this.referrer = referrer;   // consumed server-side only on this character's FIRST join

    // Identity is derived from the WALLET, not the label: "kindra-07" as a character name would
    // advertise the fleet. Same seed every start, so the character keeps its name and face.
    const rng = seededRng(this.account.address.toLowerCase());
    this.name = name || humanName(rng);
    this.appearance = appearance || randomAppearance(rng);
    this.device = deviceProfile(this.account.address.toLowerCase());
    this.status = 'idle';
    this.lastError = null;
    this.logLines = [];

    this.log = (msg) => {
      const line = `[${new Date().toISOString().slice(11, 19)}] [${this.label}] ${msg}`;
      this.logLines.push(line);
      if (this.logLines.length > 300) this.logLines.shift();
      if (onLog) onLog(line); else console.log(line);
      this.emit('log', line);
      this._appendLog(line);
    };

    this.net = new Net({ url: this.world.ws, origin: this.world.http, proxy: this.proxy });
    this.state = new GameState().attach(this.net);
    this.move = new Movement(this.net, this.state);
    this.gather = new Gatherer({ net: this.net, state: this.state, move: this.move, log: this.log });
    this.combat = new Combat({ net: this.net, state: this.state, move: this.move, log: this.log });
    this.economy = new Economy({ net: this.net, state: this.state, move: this.move, log: this.log });
    this.crafting = new Crafting({ net: this.net, state: this.state, move: this.move, log: this.log });
    this.quests = new Quests({ net: this.net, state: this.state, move: this.move, log: this.log });
    this.upgrades = new Upgrades({ net: this.net, state: this.state, economy: this.economy, log: this.log });
    this.bosses = new Bosses({ net: this.net, state: this.state, move: this.move, crafting: this.crafting, log: this.log });
    this.jobs = new Jobs({ net: this.net, state: this.state, move: this.move, combat: this.combat, log: this.log });
    this.garden = new Garden({ net: this.net, state: this.state, move: this.move, log: this.log });
    this.referral = new Referral({ net: this.net, state: this.state, log: this.log });
    this.realms = new Realms({ net: this.net, state: this.state, move: this.move, log: this.log });

    // Market intelligence. The gold->$KINDRA book is the only place the two economies actually meet,
    // so its rate is what decides whether farming gold is worth anything in real terms. Polled on a
    // slow timer and logged, because a rate you cannot see is a rate you cannot plan against.
    this.state.on('ready', () => {
      const poll = async () => {
        if (!this.net.ready) return;
        try {
          const { KGold } = await import('./chain.js');
          this.kgold = this.kgold || new KGold({ net: this.net, state: this.state, log: () => {} });
          await this.kgold.refresh();
          const r = this.kgold.marketRate();
          if (r) {
            const sample = this.kgold.book.filter((l) => l.gold).slice(0, 3)
              .map((l) => `${l.gold}g@${l.price}`).join(' ');
            this.log(`[market] gold→$KINDRA: best ${r.best.toFixed(2)} · median ${r.median.toFixed(2)} per 1k gold (${r.listings} listings) [${sample}]`);
          }
          else this.log('[market] the gold→$KINDRA book is empty');
        } catch (e) { this.log(`[market] book poll failed: ${e.message}`); }
      };
      setTimeout(poll, 20000);
      this._marketTimer = setInterval(poll, 15 * 60 * 1000);
    });
    this.quests.garden = this.garden;   // so a crop objective can tell whether a plot is even free
    this.quests.realms = this.realms;   // and whether its nodes are behind a portal we can open
    this.gather.realms = this.realms;
    this.combat.realms = this.realms;
    this.orch = new Orchestrator({
      net: this.net, state: this.state, move: this.move,
      gather: this.gather, combat: this.combat, economy: this.economy,
      crafting: this.crafting, quests: this.quests, upgrades: this.upgrades,
      bosses: this.bosses, jobs: this.jobs, garden: this.garden, realms: this.realms, log: this.log,
    });

    this.net.on('reject', (m) => {
      this.status = 'rejected';
      this.lastError = m.reason || m.text || JSON.stringify(m);
      this.log(`join rejected: ${this.lastError}`);
      this.emit('rejected', m);
    });
    this.net.on('reconnecting', (n) => { this.status = 'reconnecting'; this.log(`reconnecting (attempt ${n})`); });
    this.net.on('closed', () => { this.status = 'offline'; this.log('socket closed'); });
    this.net.on('toast', (m) => { if (/died|got you|full|cap|refus/i.test(m.text || '')) this.log(`toast: ${m.text}`); });
    this.state.on('levelup', (m) => this.emit('levelup', { bot: this.label, ...m }));
    this._watchBagSpace();
    // A bought weapon does nothing until it is held, and a death can leave the slot empty. Re-check
    // once the world state lands.
    this.state.on('ready', () => { this.upgrades.equipOwned().catch(() => {}); });
    this.state.on('death', () => { setTimeout(() => this.upgrades.equipOwned().catch(() => {}), 4000); });

    // A client that never reports ping or perf has no render loop, and that is the single most
    // obvious tell on this protocol. Emit both, on the real client's cadence.
    this.telemetry = new Telemetry({ net: this.net, state: this.state, profile: this.device });
    this.state.on('ready', () => this.telemetry.start());
  }

  // The gatherer latches `bagFull` on the server's refusal; anything that frees space clears it.
  // Without this the bot sells, then still refuses to gather.
  _watchBagSpace() {
    this.state.on('inv', () => {
      if (this.gather.bagFull && this.economy.used() < this.economy.capacity() - 2) {
        this.gather.bagFull = false;
      }
    });
  }

  _appendLog(line) {
    try {
      const dir = ensureDataDir();
      fs.appendFileSync(path.join(dir, `${this.label}.log`), line + '\n');
    } catch { /* logging must never break the bot */ }
  }

  get address() { return this.account.address; }

  async connect() {
    this.status = 'connecting';
    const ready = new Promise((resolve, reject) => {
      const ok = () => { this.state.off('rejected', bad); resolve(); };
      const bad = (m) => { this.state.off('ready', ok); reject(new Error(m.reason || 'join rejected')); };
      this.state.once('ready', ok);
      this.state.once('rejected', bad);
      setTimeout(() => reject(new Error('join timed out')), 45000);
    });

    await this.net.connect({
      name: this.name,
      appearance: this.appearance,
      // Re-signed on every attempt: the login nonce dies in ~120 s, so a reconnect an hour later
      // must not reuse the bundle we built at startup.
      authFactory: () => buildAuth(this.account, this.world.http),
      // Only meaningful on the very first join of a brand-new character; the server ignores it
      // afterwards, so sending it every time is harmless and survives a lost wallets.json edit.
      extras: this.referrer ? { ref: this.referrer } : undefined,
    });
    await ready;
    this.status = 'online';
    this.log(`joined as ${this.state.me.name} (id ${this.state.me.id}) on ${this.world.name} — gold ${this.state.me.gold}`);
    return this;
  }

  // Idempotent. Calling start() on a character that is already playing used to re-enter connect(),
  // where net._open() sees a live socket and returns without ever resolving the join — so a healthy
  // character timed out and was marked FAILED, and the fleet's online count went wrong with it.
  get live() {
    return this.net.ready && !!this.state.me && ['online', 'running'].includes(this.status);
  }

  async start() {
    if (this.live) {
      if (this.status !== 'running') this.status = 'running';
      if (!this.orch.running) {
        this.orch.start().catch((e) => { this.status = 'crashed'; this.lastError = e.message; this.log(`orchestrator crashed: ${e.message}`); });
      }
      return this;
    }
    await this.connect();
    this.status = 'running';
    this._slotSince = Date.now();
    this.orch.start().catch((e) => { this.status = 'crashed'; this.lastError = e.message; this.log(`orchestrator crashed: ${e.message}`); });
    return this;
  }

  stop() {
    this.orch.stop();
    this.bosses.stop();
    this.jobs.stop();
    this.status = 'stopped';
  }

  disconnect() {
    this.stop();
    if (this._marketTimer) clearInterval(this._marketTimer);
    this.telemetry.stop();
    this.net.disconnect();
    this.status = 'offline';
  }

  // How much value this character still has left today. Shift rotation reads it so a character is
  // never swapped out mid-quest: quest gold ignores every daily cap, so one whose caps are spent is
  // still worth keeping online until its board is clear — and one with nothing left should give up
  // its slot immediately rather than idling in it for the rest of the rotation.
  workLeft() {
    if (!this.state.me) return { score: 0, why: 'not in game' };
    const h = this.state.haul || {};
    // Only caps this character can actually reach RIGHT NOW. An unreachable cap never falls, so
    // counting one pins the score above the exhaustion threshold forever and the rotation stops
    // dead — which is exactly what happened: three characters held the slots while eighteen never
    // got a turn. The boss cap needs other players holding the boss; the trade cap needs the Trade
    // Roads, which unlock at Lv 15.
    const reachable = ['combat', 'vendor'];
    if (this.jobs?.unlocked()) reachable.push('trade');
    const capsLeft = reachable
      .filter((k) => h[`${k}Cap`] != null)
      .reduce((a, k) => a + Math.max(0, h[`${k}Cap`] - (h[k] || 0)), 0);

    const quests = this.state.quests || [];
    const claimable = quests.filter((q) => !q.claimed && (q.prog ?? 0) >= q.need).length;
    const inProgress = quests.filter((q) => !q.claimed && (q.prog ?? 0) < q.need);
    // A quest sitting at 0/15 is not "in progress" in any useful sense — the character may never
    // touch that activity again, and holding a slot for it starves the rest of the fleet. Only
    // count real progress, and weight it by how close it is to paying out.
    // The weighting is deliberate. A slot is worth roughly 4,000 gold an hour to whichever account
    // holds it, so a 20-gold quest does not justify keeping one — UNLESS it is nearly done, where
    // a few more minutes converts progress that would otherwise be thrown away.
    const questValue = inProgress.reduce((a, q) => {
      const frac = (q.prog ?? 0) / Math.max(1, q.need);
      if (frac < 0.34) return a;                        // barely started — the slot is worth more
      if (frac >= 0.66) return a + (q.gold || 20) * 5;  // nearly done — finish it before rotating
      return a + (q.gold || 20) * frac;                 // halfway — counts, rarely decisive alone
    }, 0) + claimable * 200;

    const chasing = this.orch.chasing ? 500 : 0;   // never rotate out a character mid-chase
    const score = capsLeft * 0.05 + questValue + chasing;
    return {
      score,
      capsLeft,
      claimable,
      questsOpen: inProgress.length,
      why: claimable ? `${claimable} quest(s) ready to claim`
        : inProgress.length ? `${inProgress.length} quest(s) in progress`
        : capsLeft > 0 ? `${capsLeft}g of daily caps left`
        : 'nothing left today',
    };
  }

  get exhausted() { return this.workLeft().score < 30; }

  // A slot can only be held so long. Whatever the score says, the fleet has to keep moving or the
  // accounts behind it earn nothing at all — so a character that has held its slot for two full
  // rotations gives it up regardless.
  heldTooLong(maxMs) {
    return this._slotSince ? (Date.now() - this._slotSince) > maxMs : false;
  }

  report() {
    if (!this.state.me) return `${this.label}: ${this.status}${this.lastError ? ` (${this.lastError})` : ''}`;
    return this.orch.report();
  }

  summaryLine() {
    const me = this.state.me;
    if (!me) return `${this.label.padEnd(10)} ${this.status}`;
    const b = this.orch.baseline, now = this.orch.snapshot();
    const dg = b ? now.gold - b.gold : 0;
    return `${this.label.padEnd(10)} ${String(this.orch.current).padEnd(16)} ${String(me.gold).padStart(7)}g ${dg >= 0 ? '+' : ''}${dg} · hp ${me.hp} · bag ${this.economy.used()}/${this.economy.capacity()}`;
  }
}
