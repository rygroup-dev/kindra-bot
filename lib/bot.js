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
    this.orch = new Orchestrator({
      net: this.net, state: this.state, move: this.move,
      gather: this.gather, combat: this.combat, economy: this.economy,
      crafting: this.crafting, quests: this.quests, upgrades: this.upgrades,
      bosses: this.bosses, jobs: this.jobs, garden: this.garden, log: this.log,
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

  async start() {
    if (this.status !== 'online') await this.connect();
    this.status = 'running';
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
    this.telemetry.stop();
    this.net.disconnect();
    this.status = 'offline';
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
