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
import { KINSHIP_RADIUS as KINSHIP_R, REFERRAL, BOSSES, bossXp, realmAt } from './rules.js';

const XP_GOLD = 0.25;   // the same exchange rate the orchestrator prices xp at

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
    this.pinned = null;          // label held out of rotation until it reaches account Lv 10
    this.mode = 'normal';        // 'gold' — see setMode
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
    // A character minted or loaded while the fleet is in gold mode has to arrive in it too, or the
    // newest accounts quietly run on different rules from the rest of the fleet.
    if (this.mode === 'gold') { for (const m of [bot.orch, bot.gather, bot.upgrades]) if (m) m.goldMode = true; }
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

  // --- pinning --------------------------------------------------------------
  // One character can be nailed to a slot: it always plays and rotation never touches it, so the
  // other two slots share the queue. This exists for exactly one job — dragging an account to
  // account Lv 10, which is what unlocks referrals (500 gold + 200 KINDRA a head, and every
  // character the fleet has minted names our referrer). Account xp weights combat at 1.0 and every
  // other skill at 0.25, so a character that gathers its way there takes roughly four times as
  // long; the pin comes with the orchestrator's chase mode for the same reason.
  //
  // It releases ITSELF at Lv 10. A pin that has to be remembered is a pin that gets left on.
  pin(label) {
    const b = this.bots.get(label);
    if (!b) return { ok: false, why: `no such character: ${label}` };
    this.pinned = label;
    if (b.orch) b.orch.chaseAccountLevel = true;
    this.saveRunState();
    this.log(`pinned ${label} — it holds a slot until account Lv ${REFERRAL.minLv}; the other ${MAX_ONLINE_PER_IP - 1} rotate`);
    return { ok: true };
  }

  unpin({ reason = 'released' } = {}) {
    const label = this.pinned;
    if (!label) return { ok: false, why: 'nothing is pinned' };
    const b = this.bots.get(label);
    if (b?.orch) b.orch.chaseAccountLevel = false;
    this.pinned = null;
    this.saveRunState();
    this.log(`unpinned ${label} — ${reason}; back to normal rotation across all ${MAX_ONLINE_PER_IP} slots`);
    return { ok: true, label };
  }

  pinnedBot() { return this.pinned ? this.bots.get(this.pinned) || null : null; }

  // --- fleet mode -----------------------------------------------------------
  // 'gold' prices experience at almost nothing so only coins decide what to do next. The shift
  // rotation is untouched by this — same wallets, same order, same slots; only what a character
  // reaches for while it holds one changes.
  setMode(mode) {
    const m = mode === 'gold' ? 'gold' : 'normal';
    this.mode = m;
    for (const b of this.bots.values()) {
      if (b.orch) b.orch.goldMode = (m === 'gold');
      // The gatherer chooses WHICH node to walk to, so the mode has to reach it as well — otherwise
      // the brain picks "go mining" for the money and the legs still walk to the highest-xp rock.
      if (b.gather) b.gather.goldMode = (m === 'gold');
      // And the shopping list: in gold mode it refuses anything that cannot pay for itself in coin.
      if (b.upgrades) b.upgrades.goldMode = (m === 'gold');
    }
    this.saveRunState();
    this.log(m === 'gold'
      ? 'mode: GOLD — xp is worth almost nothing; selling, the trade roads, quests and the gold-paying bosses win on their own arithmetic'
      : 'mode: normal — xp counts again at its usual rate');
    return m;
  }

  // Has the pinned character finished the job? Checked on every rotation tick.
  releasePinIfDone() {
    const b = this.pinnedBot();
    if (!b) return false;
    const tl = b.state?.me?.tl;
    if (!Number.isFinite(tl) || tl < REFERRAL.minLv) return false;
    this.unpin({ reason: `it reached account Lv ${tl} — referrals are open` });
    return true;
  }

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
      const eligible = group.filter((b) => !only || only.includes(b.label));
      const pinned = this.pinnedBot();
      const targets = this.byFairness(eligible);
      // The pin goes first regardless of how much it has played — fairness is what it is exempt from.
      if (pinned && targets.includes(pinned)) targets.splice(targets.indexOf(pinned), 1), targets.unshift(pinned);
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
  // `everyMs` is the CEILING on how long one character may hold a slot; `checkEveryMs` is how often
  // we look. They used to be the same number, so a character that finished its collectable caps
  // five minutes into a shift sat on the slot for the other forty. The check is cheap and does
  // nothing at all unless somebody is actually done — see the `shift held` branch.
  startShifts({ everyMs = 45 * 60 * 1000, checkEveryMs = 10 * 60 * 1000 } = {}) {
    if (this._shiftTimer) clearInterval(this._shiftTimer);
    this._shiftCursor = 0;
    const rotate = async () => {
      this.releasePinIfDone();
      const pinned = this.pinnedBot();
      for (const [, group] of this.ipGroups()) {
        if (group.length <= MAX_ONLINE_PER_IP) continue;   // everyone fits; nothing to rotate
        // Hold a character that still has work worth doing. Quest gold ignores every daily cap, so
        // one whose caps are spent is still earning while its board is unfinished — swapping it out
        // mid-quest throws that progress away, and the replacement starts from nothing.
        const live = group.filter((b) => b.live);
        // The hard ceiling: held this long and it goes, finished or not. Without it one character
        // with a perpetually-open quest board holds a slot indefinitely. This used to be doubled,
        // from back when everyMs meant "rotation interval" and the ceiling was two of them — the
        // parameter now IS the ceiling, so doubling it made the startup line ("no slot held past
        // 45 min") a lie about a 90-minute ceiling.
        const maxHold = this._shiftEveryMs || everyMs;
        // The pinned character counts as busy whatever its score says, and is never eligible to be
        // rotated out — that is the whole point of pinning it.
        const busy = live.filter((b) => b === pinned || (!b.exhausted && !b.heldTooLong(maxHold)));
        const slots = MAX_ONLINE_PER_IP - busy.length;
        if (slots <= 0) {
          this.log(`shift held — ${busy.map((b) => `${b.label} (${b.workLeft().why})`).join(', ')}`);
          this._nextShiftAt = Date.now() + (this._checkEveryMs || checkEveryMs);
          continue;
        }

        // Fill the free slots with whoever has been waiting longest.
        const shift = [...busy];
        // A pinned character that is not live yet jumps the queue: it must be in play before the
        // rotating slots are filled, or a full house will keep it out of its own pin.
        if (pinned && group.includes(pinned) && !shift.includes(pinned)) shift.unshift(pinned);
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
      this._nextShiftAt = Date.now() + (this._checkEveryMs || checkEveryMs);
    };
    this._shiftTimer = setInterval(rotate, checkEveryMs);
    this._shiftEveryMs = everyMs;
    this._checkEveryMs = checkEveryMs;
    this._nextShiftAt = Date.now() + checkEveryMs;
    this.shiftsOn = true;
    this.saveRunState();
    this.log(`shift rotation on — checking every ${Math.round(checkEveryMs / 60000)} min, no slot held past ${Math.round(everyMs / 60000)} min`);
    // Rotate straight away. Waiting 45 minutes for the first swap makes the toggle look broken:
    // nothing in the panel changes and the user is left guessing whether the tap registered.
    this._rotateNow = rotate;
    rotate().then(() => { this._nextShiftAt = Date.now() + checkEveryMs; }).catch((e) => this.log(`shift error: ${e.message}`));
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
        pinned: this.pinned || null,  // the character holding a slot until it reaches Lv 10
        mode: this.mode || 'normal',  // 'gold' re-ranks every activity on coins alone
        savedAt: new Date().toISOString(),
      }, null, 2));
      this._runStateCache = null;   // we just changed the file; never serve the pre-write copy
    } catch { /* persistence is a convenience, never a hard dependency */ }
  }

  // Milliseconds of slot time an account has had, across every restart.
  playedMs(label) { return (this.loadRunState()?.played || {})[label] || 0; }

  // WHOSE TURN IT IS. Straight round robin in wallet order: 1, 2, 3 ... 24, then back to 1. The
  // cursor advances by however many slots a rotation actually filled and is persisted, so a restart
  // continues the circuit instead of starting it over.
  //
  // This replaced "whoever has played least", which sounded fairer and was not. That rule depended
  // on a playtime figure that every process restart reset the clock for, so an account that played
  // all night recorded 3.9 minutes while one starved since the previous morning kept the larger
  // number it happened to bank before the restarts — and least-played-first then handed the slots
  // straight back to the accounts already holding them. Six accounts went twenty-three hours
  // without a single join. Position in a list cannot drift like that.
  byFairness(list) {
    const order = [...list].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    if (!order.length) return order;
    const at = ((this._shiftCursor || 0) % order.length + order.length) % order.length;
    return [...order.slice(at), ...order.slice(0, at)];
  }

  // Cached for a second. goldOf() is called once per account per panel render, and a 24-account
  // roster was re-reading and re-parsing the same file 24 times to draw one screen.
  loadRunState() {
    if (this._runStateCache && Date.now() - this._runStateCache.at < 1000) return this._runStateCache.v;
    let v = null;
    try { v = JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')); } catch { v = null; }
    this._runStateCache = { at: Date.now(), v };
    return v;
  }

  // Bring the fleet back to whatever it was doing before the process stopped.
  async resume() {
    const st = this.loadRunState();
    if (!st || (!st.running?.length && !st.shiftsOn)) return null;
    this._shiftCursor = st.cursor || 0;   // continue the rotation, don't restart it
    // Restore the pin BEFORE starting anything, so the pinned character takes its slot rather than
    // racing the queue for one. A deploy in the middle of a level chase must not quietly end it.
    if (st.mode === 'gold') this.setMode('gold');
    if (st.pinned && this.bots.has(st.pinned)) {
      this.pinned = st.pinned;
      const b = this.bots.get(st.pinned);
      if (b?.orch) b.orch.chaseAccountLevel = true;
      this.log(`resuming the pin on ${st.pinned} — still chasing account Lv ${REFERRAL.minLv}`);
    }
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
    this.releasePinIfDone();   // cheap, and shifts may be off entirely — the pin must still release
    // Bank the playtime every tick. It used to accumulate ONLY when saveRunState happened to be
    // called — on a start, a shift toggle, a pin — and every process restart reset the clock those
    // sums are measured from. So a character that played all night had its hours repeatedly thrown
    // away and recorded 3.9 minutes, while one starved since yesterday morning kept the larger
    // figure it happened to bank before the restarts. byFairness picks the LEAST played first, so
    // the rule inverted: the accounts already playing looked idle and kept the slots, and the
    // starved ones looked busy and stayed out. Six accounts had not joined in twenty-three hours.
    this.saveRunState();
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

  // --- fleet raids ----------------------------------------------------------
  // The boss purse is 5,000 gold a day per account and it has never paid out once, because the two
  // bosses a lone character can safely join pay no gold at all and the four that do have nobody
  // else on them. Three characters online at the same time ARE the other players.

  // Everyone actually in the world right now. Not grouped by IP: characters behind different exit
  // IPs are still in the same valley, so they raid together — and so do a friend's characters, who
  // simply show up as extra `helpers` on the same boss.
  raidParty() {
    return [...this.bots.values()].filter((b) => b.live && b.state?.me && b.bosses);
  }

  // Seconds to walk there, through the door if the lair is in a realm. Rough on purpose: it only
  // has to be right enough to tell a trek across the map from a stroll down the valley.
  travelSecsTo(b, def) {
    const speed = 7;
    const at = (x, z) => Math.hypot(x - b.state.pos.x, z - b.state.pos.z) / speed;
    const realm = realmAt(def.x, def.z)?.id || null;
    const here = b.realms?.current?.() ?? null;
    if (realm === here) return at(def.x, def.z);
    const portal = b.realms?.entrance?.(realm);
    if (!portal?.to) return at(def.x, def.z);
    return at(portal.x, portal.z) + 15 + Math.hypot(def.x - portal.to.x, def.z - portal.to.z) / speed;
  }

  // The richest boss this party can take right now, or null with the reason it cannot.
  chooseRaid() {
    const party = this.raidParty();
    // Why NOT, recorded as we go. A raid that never fires is indistinguishable from a raid feature
    // that does not work, and the answer is usually a fixable one — the trio online is three levels
    // short, or nobody is carrying rations.
    this.raidWhy = null;
    const blocked = (w) => { if (!this.raidWhy) this.raidWhy = w; };
    if (party.length < 2) { this.raidWhy = 'fewer than two characters in the world'; return null; }
    let best = null;
    // Easiest gate first. The scan order decides which blocker gets reported, and "drowned_king
    // needs Lv 12, 0 of 3 qualify" is something the fleet can act on; "bonemaw needs Lv 60" is not.
    const golden = Object.entries(BOSSES)
      .filter(([, def]) => def.reward?.goldRoll)      // gems and mats only — the purse stays shut
      .sort((a, b) => (a[1].reqCombat ?? 0) - (b[1].reqCombat ?? 0));
    for (const [id, def] of golden) {
      const roll = def.reward.goldRoll;
      // Level and the door are per-character, so they FILTER the candidates rather than veto the
      // boss: one character three levels short should sit this one out, not ground the raid.
      const eligible = party.filter((b) => (def.reqCombat ?? 0) <= b.bosses.myCombatLevel()
                                        && (!b.realms || b.realms.reachable(def.x, def.z)));
      if (eligible.length < 2) { blocked(`${id} needs combat Lv ${def.reqCombat ?? 0}; only ${eligible.length} of ${party.length} qualify`); continue; }
      // Somebody has to have purse room, or the fight pays only xp.
      if (!eligible.some((b) => b.orch.capLeft('boss') > 0)) { blocked(`${id}: the boss purse is spent`); continue; }
      const live = party.map((b) => b.state.bosses.get(id)).find(Boolean);
      if (live && live.alive === false) { blocked(`${id} is down; it respawns in ${Math.round((def.respawnMs || 0) / 60000)} min`); continue; }
      const safe = eligible[0].bosses.crewFor(def, eligible);
      if (!safe) { blocked(`${id}: ${eligible[0].bosses.survives(def, eligible).why}`); continue; }
      const pay = (roll[0] + roll[1]) / 2;
      // Price it the way every other activity is priced: gold per minute, travel included, BOTH
      // ways. A raid scored as an absolute override sent a character with 1,299 gold/min of goods
      // waiting at the vendor off on a two-minute trek for sixty gold. On these numbers the fleet
      // declines drowned_king (~20/min once the isles round trip is counted) and takes the Rimewyrm
      // (~200/min, and it is in the open world) — which is the right answer, arrived at honestly.
      const travel = Math.max(...safe.crew.map((b) => this.travelSecsTo(b, def))) * 2;
      const share = bossXp(def.hp || 0) / safe.crew.length;
      const perMin = (pay + share * XP_GOLD) * 60 / Math.max(1, safe.secs + travel);
      // Worth leaving the valley for? Compare against what the crew would otherwise be doing. Every
      // member has to be better off raiding, or the ones who are not simply lose money by coming.
      const alternative = Math.max(...safe.crew.map((b) => b.orch?.bestAlternative ?? 0));
      if (perMin < alternative) { blocked(`${id} pays ${Math.round(perMin)}g/min; the crew is already earning ${Math.round(alternative)}g/min`); continue; }
      if (!best || perMin > best.perMin) {
        best = { bossId: id, x: def.x, z: def.z, members: safe.crew.map((b) => b.label),
                 perMin, pay, secs: safe.secs, travel, go: false, at: Date.now() };
      }
    }
    return best;
  }

  // Call a raid, hold it while it runs, and open the gate once everyone is in position.
  syncRaid() {
    const current = this.raid;
    if (current) {
      const party = current.members.map((l) => this.bots.get(l)).filter(Boolean);
      const stillLive = party.filter((b) => b.live);
      // Let it run. Only tear it down if the party fell apart or it has plainly overrun.
      if (!current.done && stillLive.length >= 2 && Date.now() - current.at < 15 * 60 * 1000) {
        if (!current.go && stillLive.every((b) => b.bosses.mustered)) {
          current.go = true;
          this.log(`raid: all ${stillLive.length} in position on ${current.bossId} — go`);
        }
        return current;
      }
      this.log(`raid on ${current.bossId} ${current.done ? 'finished' : 'stood down'}`);
      this.raid = null;
      for (const b of this.bots.values()) if (b.bosses) b.bosses.raid = null;
    }

    const next = this.chooseRaid();
    if (!next) {
      // Say it once per reason, not once per sync — this runs every 30 seconds.
      if (this.raidWhy && this.raidWhy !== this._lastRaidWhy) {
        this._lastRaidWhy = this.raidWhy;
        this.log(`no raid: ${this.raidWhy}`);
      }
      return null;
    }
    this._lastRaidWhy = null;
    this.raid = next;
    for (const b of this.bots.values()) {
      if (b.bosses) b.bosses.raid = next.members.includes(b.label) ? next : null;
    }
    this.log(`raid called: ${next.members.length} on ${next.bossId} — ~${Math.round(next.pay)}g each, ${Math.round(next.secs)}s fighting + ${Math.round(next.travel)}s travel = ${Math.round(next.perMin)}g/min`);
    return next;
  }

  startRally({ everyMs = 30000 } = {}) {
    if (this._rallyTimer) clearInterval(this._rallyTimer);
    this._rallyTimer = setInterval(() => { this.syncRally(); this.syncRaid(); }, everyMs);
    this.syncRally();
    this.syncRaid();
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

  // Last known balance for an account, whether or not it is in play right now.
  goldOf(label) {
    const b = this.bots.get(label);
    if (Number.isFinite(b?.state?.me?.gold)) return b.state.me.gold;
    const saved = (this.loadRunState()?.gold || {})[label];
    return Number.isFinite(saved) ? saved : null;
  }

  totals() {
    let gold = 0, gained = 0, kills = 0, deaths = 0, quests = 0, kbal = 0;
    for (const b of this.bots.values()) {
      // Gold counts even for an account off-shift. With 24 accounts sharing three slots the total
      // otherwise showed only the three in play, so the fleet looked twenty thousand gold poorer
      // than it was and could never answer "did every account gain today?".
      gold += this.goldOf(b.label) || 0;
      const me = b.state.me; if (!me) continue;
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
