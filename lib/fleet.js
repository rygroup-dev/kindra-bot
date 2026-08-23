// fleet.js — many accounts, one process.
//
// Why multi-account is the whole game economically: every gold source is capped PER ACCOUNT
// (combat 2000, boss 5000, vendor 1000, trade 2000, gathering ~600). One character hits a hard
// ceiling of roughly 9.6k gold/day no matter how well it plays. Ten characters have ten ceilings.
// So the fleet is not a convenience feature — it is the only way past the cap.
//
// Wallets live in wallets.json (git-ignored, chmod 600). Each entry is one EVM key = one character
// per world. Joins are staggered: 10 sockets opening on the same second from one IP is the single
// most obvious thing a bot can do, and the server caps a world at 100 players anyway.
import fs from 'node:fs';
import path from 'node:path';
import { CFG, WORLDS, ensureDataDir, DEFAULT_REFERRER } from './config.js';
import { Bot } from './bot.js';
import { sleep } from './movement.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { KINSHIP_RADIUS as KINSHIP_R, REFERRAL } from './rules.js';

const REFERRAL_MIN_LV = REFERRAL.minLv;

const WALLET_FILE = process.env.KINDRA_WALLETS || path.resolve(process.cwd(), 'wallets.json');
const JOIN_STAGGER_MS = 12000;

// THE HARD CEILING ON MULTI-ACCOUNTING. The server answers a fourth simultaneous join from one
// connection with "Too many characters online from your connection (max 3)." Discovered the honest
// way: an 11-account fleet start where accounts 4-11 were all refused.
//
// Two ways past it, and the bot supports both:
//   1. PROXIES — give an account a `proxy` in wallets.json and it exits from another IP, which gets
//      its own allowance of 3.
//   2. SHIFTS — the caps that matter are DAILY and per character, not per hour. Three characters
//      online at a time, rotated through the day, still lets all eleven bank their daily gold.
export const MAX_ONLINE_PER_IP = Number(process.env.KINDRA_MAX_PER_IP || 3);

export class Fleet {
  constructor({ onLog = null } = {}) {
    this.bots = new Map();       // label -> Bot
    this.onLog = onLog;
    this.log = (m) => (onLog ? onLog(`[fleet] ${m}`) : console.log(`[fleet] ${m}`));
  }

  // --- wallet book --------------------------------------------------------
  static loadWallets() {
    if (!fs.existsSync(WALLET_FILE)) return [];
    return JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
  }

  static saveWallets(list) {
    fs.writeFileSync(WALLET_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
    try { fs.chmodSync(WALLET_FILE, 0o600); } catch { /* non-posix */ }
    return WALLET_FILE;
  }

  // Mint N fresh characters. Wallet sign-up needs no Turnstile and no gas — a signature is free —
  // so a new account costs nothing but the 12 s stagger.
  //
  // `referrer` is stamped on each new entry and sent as `join.ref` the first time that character
  // connects. A conversion pays the referrer 500 gold + 200 on-chain $KINDRA and the newcomer 250
  // gold, so a fleet that mints characters without it is leaving the largest single source of token
  // on the table. The server attributes once, on first touch, and never to yourself.
  static createWallets(n, { world = 'valley', startIndex = null, referrer = null, character = null } = {}) {
    const existing = Fleet.loadWallets();
    const base = startIndex ?? existing.length;
    const made = [];
    for (let i = 0; i < n; i++) {
      const pk = generatePrivateKey();
      const acct = privateKeyToAccount(pk);
      const label = `kindra-${String(base + i + 1).padStart(2, '0')}`;
      // `character` may be one class for the whole batch, or a list to deal round-robin across it.
      // Minting ten identical heroes wastes ten passives and makes the fleet look like a fleet.
      const cls = Array.isArray(character) ? (character[i % character.length] || null) : (character || null);
      made.push({ label, privateKey: pk, address: acct.address, world, name: '', character: cls, referrer: referrer || null, createdAt: new Date().toISOString() });
    }
    Fleet.saveWallets([...existing, ...made]);
    return made;
  }

  // The character best placed to be a referrer: highest account level, and past the Lv-10 gate.
  // Falls back to this build's DEFAULT_REFERRER, because a fresh install has nobody at Lv 10 yet
  // and an unattributed join pays the reward to no one at all.
  bestReferrer() {
    let best = null;
    for (const b of this.bots.values()) {
      const me = b.state?.me;
      if (!me?.name) continue;
      if ((me.tl || 1) < REFERRAL_MIN_LV) continue;
      if (!best || (me.tl || 1) > best.tl) best = { name: me.name, tl: me.tl || 1, label: b.label };
    }
    if (best) return best;
    return DEFAULT_REFERRER ? { name: DEFAULT_REFERRER, tl: null, label: 'default', isDefault: true } : null;
  }

  // Remember each character's in-game name once it joins: the referral code IS the name, and it is
  // generated from the wallet, so persisting it keeps the code stable across restarts.
  rememberNames() {
    const book = Fleet.loadWallets();
    let changed = false;
    for (const w of book) {
      const b = this.bots.get(w.label);
      const name = b?.state?.me?.name;
      if (name && w.name !== name) { w.name = name; changed = true; }
    }
    if (changed) Fleet.saveWallets(book);
    return changed;
  }

  // Seed the book from the single-account .env so an existing setup upgrades cleanly.
  static ensureBook() {
    let list = Fleet.loadWallets();
    if (!list.length && CFG.privateKey) {
      const acct = privateKeyToAccount(CFG.privateKey.startsWith('0x') ? CFG.privateKey : '0x' + CFG.privateKey);
      list = [{ label: 'kindra-01', privateKey: CFG.privateKey, address: acct.address, world: CFG.world.id, name: CFG.charName || '', createdAt: new Date().toISOString() }];
      Fleet.saveWallets(list);
    }
    return list;
  }

  // --- lifecycle ----------------------------------------------------------
  add(entry) {
    if (this.bots.has(entry.label)) return this.bots.get(entry.label);
    const bot = new Bot({
      label: entry.label,
      privateKey: entry.privateKey,
      world: WORLDS[entry.world] || CFG.world,
      name: entry.name || '',
      character: entry.character || null,
      referrer: entry.referrer || null,
      proxy: entry.proxy || null,
      onLog: this.onLog,
    });
    this.bots.set(entry.label, bot);
    return bot;
  }

  load() {
    const book = Fleet.ensureBook();
    for (const e of book) this.add(e);
    // The primary is the fleet's referrer-to-be: referral rewards pay into its linked wallet, so it
    // is the only character worth pushing to the account-level gate. The others keep earning.
    const primary = book.find((w) => w.primary) || book[0];
    if (primary) {
      const b = this.bots.get(primary.label);
      if (b) { b.orch.chaseAccountLevel = true; b.isPrimary = true; }
    }
    this.log(`loaded ${this.bots.size} account(s) from ${WALLET_FILE}`);
    return [...this.bots.values()];
  }

  // Accounts sharing one exit IP compete for the same allowance of 3. Group by proxy so a fleet
  // with proxies uses its full capacity instead of stopping at the direct connection's limit.
  ipGroups() {
    const groups = new Map();
    for (const b of this.bots.values()) {
      const key = b.proxy || 'direct';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    return groups;
  }

  onlineIn(group) { return group.filter((b) => b.live).length; }

  // Start everything, staggered, honouring the per-IP ceiling. One account failing never stops the
  // rest, and accounts we deliberately hold back are marked `queued`, not `failed` — there is
  // nothing wrong with them.
  async startAll({ only = null } = {}) {
    // Two overlapping sweeps each check onlineIn(group) before either has finished joining anyone,
    // so both see a free slot and both fill it — that is how a fleet ends up over the 3-per-IP limit
    // and gets the whole connection refused. Serialise: a second sweep waits for the first, by which
    // point the bots it wanted are live and skipped rather than restarted.
    // Check-then-assign is not atomic across an await: three callers all read a null `_sweeping`
    // before any of them set it. Chain onto the tail instead — the assignment is synchronous, so
    // each caller queues behind whatever is already pending.
    const run = (this._sweeping || Promise.resolve()).catch(() => {}).then(() => this._startAll({ only }));
    this._sweeping = run;
    try { return await run; }
    finally { if (this._sweeping === run) this._sweeping = null; }
  }

  async _startAll({ only = null } = {}) {
    ensureDataDir();
    const started = [], queued = [], failed = [];

    for (const [ip, group] of this.ipGroups()) {
      // Least-played first. Filling from the top of the book is what starved the tail of the fleet.
      const targets = this.byFairness(group.filter((b) => !only || only.includes(b.label)));
      for (const bot of targets) {
        // Already playing: leave it alone. Restarting a live character is how a healthy one ends up
        // marked FAILED, and it also burns one of the three per-IP slots against itself.
        if (bot.live) {
          if (bot.status !== 'running') await bot.start();
          started.push(bot.label);
          continue;
        }
        if (this.onlineIn(group) >= MAX_ONLINE_PER_IP) {
          bot.status = 'queued';
          bot.lastError = `waiting for a slot (max ${MAX_ONLINE_PER_IP} online per IP)`;
          queued.push(bot.label);
          continue;
        }
        try {
          await bot.start();
          started.push(bot.label);
          this.log(`${bot.label} running (${bot.address})`);
        } catch (e) {
          bot.status = 'failed'; bot.lastError = e.message;
          failed.push(bot.label);
          this.log(`${bot.label} FAILED: ${e.message}`);
        }
        this.syncRally();
        await sleep(JOIN_STAGGER_MS);
      }
      if (queued.length) this.log(`${ip}: ${this.onlineIn(group)} online, ${queued.length} queued behind the per-IP limit`);
    }
    this.startRally();
    this.saveRunState();
    return { started, queued, failed, summary: this.summary() };
  }

  // SHIFT ROTATION. Swap the online set every `everyMs` so an oversized fleet still banks every
  // character's daily caps: they reset per day, not per hour, so time-slicing loses nothing.
  startShifts({ everyMs = 45 * 60 * 1000 } = {}) {
    if (this._shiftTimer) clearInterval(this._shiftTimer);
    this._shiftCursor = 0;
    const rotate = async () => {
      for (const [, group] of this.ipGroups()) {
        if (group.length <= MAX_ONLINE_PER_IP) continue;   // everyone fits; nothing to rotate
        // Hold a character that still has work worth doing. Quest gold ignores every daily cap, so
        // one whose caps are spent is still earning while its board is unfinished — swapping it out
        // mid-quest throws that progress away, and the replacement starts from nothing.
        const live = group.filter((b) => b.live);
        // Held for two full rotations => it goes, finished or not. Without this ceiling one
        // character with a perpetually-open quest board can hold a slot indefinitely.
        const maxHold = (this._shiftEveryMs || everyMs) * 2;
        const busy = live.filter((b) => !b.exhausted && !b.heldTooLong(maxHold));
        const slots = MAX_ONLINE_PER_IP - busy.length;
        if (slots <= 0) {
          this.log(`shift held — ${busy.map((b) => `${b.label} (${b.workLeft().why})`).join(', ')}`);
          this._nextShiftAt = Date.now() + (this._shiftEveryMs || everyMs);
          continue;
        }

        // Fill the free slots with whoever has been waiting longest.
        const shift = [...busy];
        for (const cand of this.byFairness(group)) {
          if (shift.length >= MAX_ONLINE_PER_IP) break;
          if (!shift.includes(cand)) shift.push(cand);
        }
        this._shiftCursor = (this._shiftCursor + slots) % group.length;
        // Only drop characters that are NOT in the incoming shift — disconnecting one just to
        // reconnect it wastes a join and loses its session.
        for (const b of group) {
          if (b.live && !shift.includes(b)) {
            this.log(`rotating out ${b.label} — ${b.workLeft().why}`);
            b.disconnect();
          }
        }
        this.log(`shift change -> ${shift.map((b) => b.label).join(', ')}`);
        for (const b of shift) {
          if (b.live) continue;   // already in play from the previous shift
          try { await b.start(); } catch (e) { b.status = 'failed'; b.lastError = e.message; }
          await sleep(JOIN_STAGGER_MS);
        }
      }
      this._nextShiftAt = Date.now() + (this._shiftEveryMs || everyMs);
    };
    this._shiftTimer = setInterval(rotate, everyMs);
    this._shiftEveryMs = everyMs;
    this._nextShiftAt = Date.now() + everyMs;
    this.shiftsOn = true;
    this.saveRunState();
    this.log(`shift rotation on — swapping every ${Math.round(everyMs / 60000)} min`);
    // Rotate straight away. Waiting 45 minutes for the first swap makes the toggle look broken:
    // nothing in the panel changes and the user is left guessing whether the tap registered.
    this._rotateNow = rotate;
    rotate().then(() => { this._nextShiftAt = Date.now() + everyMs; }).catch((e) => this.log(`shift error: ${e.message}`));
    return this;
  }

  // --- run-state persistence ----------------------------------------------
  stateFile() { return path.join(ensureDataDir(), 'fleet-state.json'); }

  saveRunState() {
    try {
      const prev = this.loadRunState() || {};
      const played = { ...(prev.played || {}) };
      // An account off-shift has no live state to read, so its balance would be invisible until its
      // next turn. Carry the last known one forward: this is what makes "did every account gain
      // today?" answerable across a 24-account fleet sharing three slots.
      const gold = { ...(prev.gold || {}) };
      const now = Date.now();
      for (const b of this.bots.values()) {
        if (Number.isFinite(b.state?.me?.gold)) gold[b.label] = b.state.me.gold;
        if (!b.live) continue;
        const since = b._lastAccounted || b._slotSince || now;
        played[b.label] = (played[b.label] || 0) + Math.max(0, now - since);
        b._lastAccounted = now;
      }
      fs.writeFileSync(this.stateFile(), JSON.stringify({
        running: [...this.bots.values()].filter((b) => b.live).map((b) => b.label),
        shiftsOn: !!this.shiftsOn,
        cursor: this._shiftCursor || 0,
        played,                       // ms of slot time each account has had
        gold,                         // last known balance per account, live or not
        savedAt: new Date().toISOString(),
      }, null, 2));
    } catch { /* persistence is a convenience, never a hard dependency */ }
  }

  // Milliseconds of slot time an account has had, across every restart.
  playedMs(label) { return (this.loadRunState()?.played || {})[label] || 0; }

  // Fairest next pick: whoever has played least. Without this a restart always refilled from the
  // top of the book, so the first three accounts collected 22 sessions each while six never played
  // at all — the rotation restarted instead of continuing.
  byFairness(list) {
    const played = this.loadRunState()?.played || {};
    return [...list].sort((a, b) => (played[a.label] || 0) - (played[b.label] || 0));
  }

  loadRunState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')); } catch { return null; }
  }

  // Bring the fleet back to whatever it was doing before the process stopped.
  async resume() {
    const st = this.loadRunState();
    if (!st || (!st.running?.length && !st.shiftsOn)) return null;
    this._shiftCursor = st.cursor || 0;   // continue the rotation, don't restart it
    this.log(`resuming: ${st.running?.length || 0} character(s)${st.shiftsOn ? ' + shift rotation' : ''}`);
    const r = await this.startAll();
    if (st.shiftsOn && !this.shiftsOn) this.startShifts();
    return r;
  }

  stopShifts() { if (this._shiftTimer) clearInterval(this._shiftTimer); this._shiftTimer = null; this.shiftsOn = false; this._nextShiftAt = 0; this.saveRunState(); }
  nextShiftIn() { return this._nextShiftAt ? Math.max(0, this._nextShiftAt - Date.now()) : 0; }

  async startOne(label) {
    const bot = this.bots.get(label);
    if (!bot) throw new Error(`no such account: ${label}`);
    await bot.start();
    return bot;
  }

  stopAll() { this.stopRally(); for (const b of this.bots.values()) b.stop(); this.saveRunState(); }
  disconnectAll() { for (const b of this.bots.values()) b.disconnect(); }

  get(label) { return this.bots.get(label); }
  get size() { return this.bots.size; }

  // KINSHIP RALLY. kinshipMultiplier pays +15% per player within radius 18, up to 1.6x — and our
  // own characters qualify. Left alone, three bots each chase their own best node and scatter far
  // enough apart to be worth 1.00x to each other. A shared rally point, recomputed from whoever is
  // actually online, turns the fleet into its own crowd.
  // A FIXED cluster, and a shared skill. Two earlier attempts failed for the same reason: both
  // aimed at something that moves. A centroid of scattered bots is empty ground that shifts every
  // time anyone steps (measured 1.30/1.00/1.00), and an anchor character walks 20-40 units between
  // nodes, so followers arrive where it no longer is (measured 1.10 → 1.00 over three minutes).
  //
  // A node cluster does not move. We pick the densest patch of one skill's nodes — the valley's
  // best is 9 trees inside an 18-unit radius, enough to keep 3-5 characters swinging through a 9 s
  // respawn — point the whole fleet at it, and the kinship bonus follows from them simply being
  // there. The skill has to be shared too, or two bots on different skills never meet.
  chooseFocus() {
    const live = [...this.bots.values()].filter((b) => b.state?.me && ['online', 'running'].includes(b.status));
    if (live.length < 2) return null;
    const scout = live[0];

    let best = null;
    for (const skill of ['woodcutting', 'foraging', 'mining', 'fishing']) {
      // Only types EVERY online character can actually harvest — a cluster half the fleet is
      // under-levelled for is not a cluster.
      const types = live
        .map((b) => new Set(b.gather.nodeTypesFor(skill)))
        .reduce((acc, set) => acc.filter((t) => set.has(t)), [...new Set(live.flatMap((b) => b.gather.nodeTypesFor(skill)))]);
      if (!types.length) continue;

      const nodes = scout.state.liveNodes(types);
      if (nodes.length < live.length) continue;
      // Count at the WORKING radius, not the full kinship radius. The fleet packs into half the
      // circle so every member is inside every other member's range, so a patch that is only dense
      // at 18u would leave them spread out and waiting on respawns.
      const work = KINSHIP_R / 2;
      for (const c of nodes) {
        const near = nodes.filter((o) => Math.hypot(o.x - c.x, o.z - c.z) <= work).length;
        if (!best || near > best.count) best = { skill, x: c.x, z: c.z, count: near };
      }
    }
    if (!best || best.count < live.length) return null;
    return { ...best, members: live.length };
  }

  // Push the focus into every bot. Recomputed rarely on purpose: a focus that keeps changing is a
  // fleet that keeps walking instead of gathering.
  syncRally({ force = false } = {}) {
    this.rememberNames();
    const live = [...this.bots.values()].filter((b) => b.state?.me && ['online', 'running'].includes(b.status)).length;
    if (force || !this.focus || this.focus.members !== live) {
      const f = this.chooseFocus();
      if (f && (!this.focus || f.skill !== this.focus.skill || Math.hypot(f.x - this.focus.x, f.z - this.focus.z) > KINSHIP_R)) {
        this.focus = f;
        this.log(`focus: ${f.skill} cluster at (${f.x.toFixed(0)}, ${f.z.toFixed(0)}) — ${f.count} nodes, ${f.members} characters`);
      } else if (f) { this.focus = { ...this.focus, members: f.members }; }
      else this.focus = null;
    }
    for (const b of this.bots.values()) {
      if (!b.gather) continue;
      b.gather.rally = this.focus ? { x: this.focus.x, z: this.focus.z, members: this.focus.members, skill: this.focus.skill } : null;
      if (b.orch) b.orch.fleetFocus = this.focus;
    }
    return this.focus;
  }

  rallyPoint() { return this.focus || null; }

  startRally({ everyMs = 30000 } = {}) {
    if (this._rallyTimer) clearInterval(this._rallyTimer);
    this._rallyTimer = setInterval(() => this.syncRally(), everyMs);
    this.syncRally();
    return this;
  }
  stopRally() { if (this._rallyTimer) clearInterval(this._rallyTimer); this._rallyTimer = null; }

  // --- reporting ----------------------------------------------------------
  summary() {
    const rows = [...this.bots.values()].map((b) => b.summaryLine());
    const totals = this.totals();
    const queued = [...this.bots.values()].filter((b) => b.status === 'queued').length;
    return [
      `🤖 Fleet — ${this.online}/${this.size} online${queued ? ` · ${queued} queued (max ${MAX_ONLINE_PER_IP}/IP)` : ''}`,
      '```',
      ...rows,
      '```',
      `💰 total ${totals.gold}g (+${totals.gained} this session)`,
      `⚔️ kills ${totals.kills} · ☠️ deaths ${totals.deaths} · 📜 quests ${totals.quests}`,
    ].join('\n');
  }

  get online() { return [...this.bots.values()].filter((b) => b.live).length; }

  totals() {
    let gold = 0, gained = 0, kills = 0, deaths = 0, quests = 0, kbal = 0;
    for (const b of this.bots.values()) {
      const me = b.state.me; if (!me) continue;
      gold += me.gold || 0;
      kbal += me.kbal || 0;
      if (b.orch.baseline) gained += (me.gold || 0) - b.orch.baseline.gold;
      kills += b.combat.stats.kills;
      deaths += b.combat.stats.deaths;
      quests += b.quests.stats.claimed;
    }
    return { gold, gained, kills, deaths, quests, kbal };
  }
}

export { WALLET_FILE };
