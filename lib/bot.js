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
import { Shrine } from './shrine.js';
import { accountXpOf, xpForAccountLevel, REFERRAL } from './rules.js';
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

// One rotation's worth of slot time. workLeft() values a character by what it can collect in one
// more shift, so this is the horizon that judgement is made over — it mirrors Fleet.startShifts'
// default and only ever needs to be in the same ballpark, not exact.
const SHIFT_MS = 45 * 60 * 1000;

export class Bot extends EventEmitter {
  constructor({ label, privateKey, world = CFG.world, name = '', character = null, referrer = null, proxy = null, appearance = null, onLog = null }) {
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
    // The class is NOT cosmetic: each of the twelve carries a permanent passive (Rogue +15% gold
    // from drops, Knight -12% damage taken, Ninja +10% attack speed). Rolling it at random — which
    // is what this did for the first 21 wallets — throws that away. A class chosen at mint time
    // wins, because the login-screen pick is the only free one: changing the hero body afterwards
    // goes through the Hall of Mirrors at 2,500 gold + 100 per account level.
    this.appearance = appearance || randomAppearance(rng);
    if (character) this.appearance.character = character;
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

    this.combat = new Combat({ net: this.net, state: this.state, move: this.move, log: this.log });
    this.economy = new Economy({ net: this.net, state: this.state, move: this.move, log: this.log });
    // Gatherer needs Economy: it prices a node by what its drop sells for, not by what it teaches.
    this.gather = new Gatherer({ net: this.net, state: this.state, move: this.move, economy: this.economy, log: this.log });
    // Gathering walks as far as combat does and takes the same aggro; give it the same way out.
    this.gather.onHurt = () => this.combat.recover();
    this.crafting = new Crafting({ net: this.net, state: this.state, move: this.move, log: this.log });
    this.quests = new Quests({ net: this.net, state: this.state, move: this.move, log: this.log });
    this.upgrades = new Upgrades({ net: this.net, state: this.state, economy: this.economy, log: this.log });
    // Realms must exist before Bosses: two of the four gold-paying bosses live behind the isles
    // portal, so a raid needs the door before it needs the fight.
    this.realms = new Realms({ net: this.net, state: this.state, move: this.move, log: this.log });
    this.bosses = new Bosses({ net: this.net, state: this.state, move: this.move, crafting: this.crafting, realms: this.realms, label, log: this.log });
    this.jobs = new Jobs({ net: this.net, state: this.state, move: this.move, combat: this.combat, log: this.log });
    this.garden = new Garden({ net: this.net, state: this.state, move: this.move, log: this.log });
    this.referral = new Referral({ net: this.net, state: this.state, log: this.log });
    this.shrine = new Shrine({ net: this.net, state: this.state, move: this.move, log: this.log });

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
      bosses: this.bosses, jobs: this.jobs, garden: this.garden, realms: this.realms,
      shrine: this.shrine, log: this.log,
    });

    this.net.on('reject', (m) => {
      this.status = 'rejected';
      this.lastError = m.reason || m.text || JSON.stringify(m);
      this.log(`join rejected: ${this.lastError}`);
      this.emit('rejected', m);
    });
    this.net.on('reconnecting', (n) => { this.status = 'reconnecting'; this.log(`reconnecting (attempt ${n})`); });
    // net re-sends `join` on its own when the socket comes back, and `init` re-seeds state — so the
    // character is playing again seconds later. Nothing moved the STATUS off 'reconnecting' though,
    // and `live` reads the status. The fleet therefore saw three healthy characters as offline:
    // rotation skipped them (it only rotates out what is `live`), their slots were never released,
    // and the replacement was rejected with "max 3" every 45 minutes for four hours.
    this.state.on('ready', () => {
      if (this.status !== 'reconnecting' && this.status !== 'offline') return;
      this.status = this.orch.running ? 'running' : 'online';
      this.log(`rejoined as ${this.state.me?.name} — back in the rotation`);
    });
    this.net.on('closed', () => { this.status = 'offline'; this.log('socket closed'); });
    this.net.on('toast', (m) => { if (/died|got you|full|cap|refus/i.test(m.text || '')) this.log(`toast: ${m.text}`); });
    this.state.on('levelup', (m) => this.emit('levelup', { bot: this.label, ...m }));
    this._watchBagSpace();
    this._watchPosition();
    this._watchGold();
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
  // "Is every account's gold actually growing?" was unanswerable: gold appeared in the log exactly
  // once per character, on the join line. Everything else — vendor income, purchases — was a
  // fragment you had to add up by hand, and the purchase fragments lied. So mark the balance on
  // arrival and print a plain delta on the half hour, with what the upgrades actually cost.
  // Gold per millisecond this character is ACTUALLY minting from a capped source, measured since
  // its haul counters were first seen this session. Before there is a span to divide by we assume
  // the cap is reachable — a fresh character should not be rotated out for lack of evidence.
  earnRate(source) {
    const first = this._haulFirst;
    const h = this.state.haul || {};
    if (!first || h[source] == null) return Infinity;
    const span = Date.now() - first.at;
    if (span < 10 * 60 * 1000) return Infinity;        // too short a sample to judge anything on
    return Math.max(0, (h[source] || 0) - (first[source] || 0)) / span;
  }

  _watchGold() {
    const mark = () => { this._goldMark = { gold: this.state.me?.gold ?? 0, spent: this.upgrades.spent || 0 }; };
    this.state.on('ready', mark);
    // First sight of the haul counters this session — the baseline earnRate() measures against.
    // Re-baseline on EVERY join, not once per process. A character that sat off-shift for five
    // hours would otherwise divide one shift's earnings by five hours of wall clock, read as
    // earning almost nothing, and be judged exhausted the moment it came back — never getting a
    // slot again. The rate has to describe the slot it is in now.
    this.state.on('ready', () => { this._haulFirst = null; });
    // Whatever we were walking towards, we are somewhere else now — abandon it rather than
    // integrating the rest of the path from a position on the other side of a portal.
    this.state.on('teleport', ({ x, z }) => { this.move.stop(); this.log(`[realm] the server moved us to (${x}, ${z})`); });
    this.state.on('haul', (hh) => { if (!this._haulFirst) this._haulFirst = { at: Date.now(), ...hh }; });
    this._goldTimer = setInterval(() => {
      const g = this.state.me?.gold;
      if (!Number.isFinite(g)) return;
      if (!this._goldMark) return mark();
      const d = g - this._goldMark.gold;
      const spent = (this.upgrades.spent || 0) - this._goldMark.spent;
      // A pinned character never rejoins, so its join line — the only place account level was
      // written down — freezes at the moment it was pinned. Three hours in it still read "12% to
      // Lv 10" while the character had roughly doubled that, which makes a working chase look like
      // a broken one. Put the progress on the half-hourly line for anyone actually chasing.
      const chase = this.orch.chaseAccountLevel ? (() => {
        const pr = this.orch.chaseProgress();
        return ` · account Lv ${this.state.me?.tl ?? '?'} (${pr.pct.toFixed(1)}% to Lv ${REFERRAL.minLv})`;
      })() : '';
      this.log(`[gold] ${g}g · ${d >= 0 ? '+' : ''}${d} in the last 30 min${spent ? ` (${spent}g of it went on upgrades)` : ''}${chase}`);
      mark();
    }, 30 * 60 * 1000);
  }

  // Nothing should be able to write a non-finite coordinate any more (movement.js refuses the step
  // and the malformed sack frame that caused it is parsed correctly now). But if one ever does, the
  // character is bricked in a way that looks perfectly healthy — walking, logging cycles, earning
  // nothing, zero errors — so keep a way back. A rejoin re-seeds `me` from `init`.
  _watchPosition() {
    this._posTimer = setInterval(() => {
      const me = this.state.me;
      if (!me || (Number.isFinite(me.x) && Number.isFinite(me.z))) return;
      this.log('[net] our position went non-finite — bouncing the socket to re-anchor');
      this.net.bounce();
    }, 60000);
  }

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
    // Account level belongs on this line. It gates referrals (500 gold + 200 $KINDRA a head, and
    // the fleet's own referrer must reach Lv 10), it gates two realm portals, and it was the one
    // number nothing ever wrote down — answering "is the primary Lv 10 yet?" meant reconstructing
    // it from level-up lines and hoping the log went back far enough.
    const tl = this.state.me.tl || 1;
    const pct = (100 * accountXpOf(this.state.me.skills || {}) / xpForAccountLevel(REFERRAL.minLv)).toFixed(0);
    this.log(`joined as ${this.state.me.name} (id ${this.state.me.id}) on ${this.world.name} — gold ${this.state.me.gold} · account Lv ${tl}${tl < REFERRAL.minLv ? ` (${pct}% to Lv ${REFERRAL.minLv}, referrals locked)` : ' — can refer'}`);
    return this;
  }

  // Idempotent. Calling start() on a character that is already playing used to re-enter connect(),
  // where net._open() sees a live socket and returns without ever resolving the join — so a healthy
  // character timed out and was marked FAILED, and the fleet's online count went wrong with it.
  get live() {
    return this.net.ready && !!this.state.me && ['online', 'running'].includes(this.status);
  }

  async start() {
    // `live` only becomes true once the join RESOLVES, so two callers arriving during the join —
    // minting auto-enrols now, and "Start all" is still a button — would both fall through to
    // connect() and race a second socket onto the same character. Hand the second caller the join
    // already in flight instead.
    if (this._starting) return this._starting;
    if (this.live) {
      if (this.status !== 'running') this.status = 'running';
      if (!this.orch.running) {
        this.orch.start().catch((e) => { this.status = 'crashed'; this.lastError = e.message; this.log(`orchestrator crashed: ${e.message}`); });
      }
      return this;
    }
    this._starting = (async () => {
      await this.connect();
      this.status = 'running';
      this._slotSince = Date.now();
      this.orch.start().catch((e) => { this.status = 'crashed'; this.lastError = e.message; this.log(`orchestrator crashed: ${e.message}`); });
      return this;
    })();
    try { return await this._starting; }
    finally { this._starting = null; }
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
    if (this._posTimer) clearInterval(this._posTimer);
    if (this._goldTimer) clearInterval(this._goldTimer);
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
    // ...and only what one more SHIFT could actually collect of them. Counting the whole remaining
    // cap was the bug: the combat cap fills at a measured 65 gold/hour (2,000 needs 31 hours), so
    // every character permanently carried ~1,600 of "work left", scored above the exhaustion
    // threshold forever, and the rotation only ever moved on the 90-minute ceiling. Three accounts
    // held the slots all day while twenty-one waited. Value the slot at what it will EARN in the
    // time it is held, measured from this character's own haul counters — self-correcting, so a
    // source that does start paying counts again on its own.
    const reachable = ['combat', 'vendor'];
    if (this.jobs?.unlocked()) reachable.push('trade');
    const capsLeft = reachable
      .filter((k) => h[`${k}Cap`] != null)
      .reduce((a, k) => {
        const left = Math.max(0, h[`${k}Cap`] - (h[k] || 0));
        return a + Math.min(left, this.earnRate(k) * SHIFT_MS);
      }, 0);

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
        : capsLeft > 0 ? `~${Math.round(capsLeft)}g still collectable this shift`
        : 'caps it can still reach are spent',
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
