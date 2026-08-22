// stealth.js — looking like a person, not like a script.
//
// FIRST, THE GOOD NEWS: this bot runs no browser. No Chromium, no Playwright, no Camoufox. Every
// browser-fingerprint surface anti-bot systems actually check — navigator.webdriver, canvas/WebGL
// hashes, CDP artifacts, font and plugin lists — simply does not exist for us. There is nothing to
// patch and nothing to leak.
//
// What IS observable is everything the server sees on the wire, and that splits three ways:
//
//   1. TELEMETRY SHAPE. The real client sends { t:'ping', ts } every ~10 s and a { t:'perf', … }
//      device report every ~60 s. A session that never sends either is the loudest possible signal:
//      a silent client is a client with no render loop. So we emit both, with per-account device
//      profiles that stay stable for that account's lifetime.
//   2. TIMING SIGNATURE. Humans are noisy. A swing exactly every 782 ms forever is not. Every wait
//      in the bot goes through `human()`, which adds proportional jitter, and sessions take breaks.
//   3. IDENTITY. Ten characters named kindra-01..10, all Rogues with identical appearance, joining
//      within one second of each other, is a fleet with a nametag on. Names, appearances and join
//      timing are all randomised per account.
import { CHARACTERS, SKIN_TONES, HAIR_COLORS, SHIRT_COLORS } from './rules.js';

// --- 1. timing ------------------------------------------------------------

// Jitter a duration by ±pct. Use for every sleep that a human would vary.
export function human(ms, pct = 0.18) {
  const d = ms * pct;
  return Math.max(30, Math.round(ms + (Math.random() * 2 - 1) * d));
}

// Occasionally a person just... stops. Looks at chat, alt-tabs, gets a drink. Returns a pause in ms
// (usually 0). Called between orchestrator activity slices.
export function microBreak({ chance = 0.15, minMs = 8000, maxMs = 45000 } = {}) {
  if (Math.random() > chance) return 0;
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

// A long break, the kind that separates play sessions. Without these a character is online 24/7,
// which no human is.
export function shouldTakeLongBreak(sessionMs, { afterMs = 100 * 60 * 1000, chance = 0.5 } = {}) {
  return sessionMs > afterMs && Math.random() < chance;
}
export function longBreakMs() { return Math.round((8 + Math.random() * 22) * 60 * 1000); }

// --- 2. identity ----------------------------------------------------------

const FIRST = ['Ash', 'Bram', 'Cor', 'Dain', 'Elm', 'Fen', 'Garr', 'Hal', 'Iver', 'Jory', 'Kel', 'Lark',
  'Mose', 'Nell', 'Orin', 'Pike', 'Quill', 'Rook', 'Sable', 'Tam', 'Vane', 'Wren', 'Yarrow', 'Zeph',
  'Bryn', 'Coal', 'Drift', 'Ember', 'Flint', 'Grove', 'Hollow', 'Juno', 'Kite', 'Loam', 'Marsh'];
const SECOND = ['wood', 'stone', 'brook', 'field', 'ridge', 'vale', 'moor', 'thorn', 'reed', 'fell',
  'hollow', 'mere', 'crag', 'birch', 'shade', 'frost', 'ash', 'gale', 'holt', 'wick'];

// Plausible player names: "Brynthorn", "Rookmere", "Fen_Vale", "Larkridge21". Never sequential,
// never the account label. validateUsername allows 3-16 of [A-Za-z0-9_-].
export function humanName(rng = Math.random) {
  const a = FIRST[Math.floor(rng() * FIRST.length)];
  const b = SECOND[Math.floor(rng() * SECOND.length)];
  const style = Math.floor(rng() * 10);
  let n;
  if (style < 5) n = a + b;
  else if (style < 7) n = `${a}_${b.charAt(0).toUpperCase()}${b.slice(1)}`;
  else if (style < 9) n = a + b + Math.floor(rng() * 90 + 10);
  else n = a + Math.floor(rng() * 900 + 100);
  return n.slice(0, 16);
}

// A distinct look per account. Identical avatars across a fleet is a giveaway that costs nothing
// to avoid.
export function randomAppearance(rng = Math.random) {
  const chars = Array.isArray(CHARACTERS) ? CHARACTERS : Object.values(CHARACTERS || {});
  const pick = (arr, fallback) => (Array.isArray(arr) && arr.length ? Math.floor(rng() * arr.length) : fallback);
  const ch = chars.length ? chars[Math.floor(rng() * chars.length)] : 'Rogue';
  return {
    skin: pick(SKIN_TONES, 1),
    hair: pick(HAIR_COLORS, 1),
    shirt: pick(SHIRT_COLORS, 1),
    character: typeof ch === 'string' ? ch : (ch?.id || ch?.key || 'Rogue'),
    hat: null, pet: null, weapon: null, shield: null, outfit: null, mount: null,
  };
}

// --- 3. device profile + telemetry ---------------------------------------

// Deterministic per-account so a character's reported hardware never changes between sessions —
// a "player" whose GPU changes every login is worse than one that never reports at all.
const GPUS = [
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'Apple M2',
  'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
];

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function deviceProfile(seedStr) {
  const h = hashString(seedStr);
  const rnd = (n) => (h >> n) & 0xff;
  const mobile = rnd(0) < 48;   // ~19% of players on a phone, which matches a browser game's mix
  return {
    gpu: GPUS[rnd(8) % GPUS.length],
    cores: mobile ? [4, 6, 8][rnd(16) % 3] : [4, 8, 12, 16][rnd(16) % 4],
    mem: mobile ? [4, 6][rnd(24) % 2] : [8, 16, 32][rnd(24) % 3],
    dpr: mobile ? [2, 2.5, 3][rnd(4) % 3] : [1, 1.25, 1.5][rnd(4) % 3],
    mob: mobile ? 1 : 0,
    sw: 0,
    fx: rnd(12) < 200 ? 1 : 0,
    sh: rnd(20) < 160 ? 1 : 0,
    basePing: 25 + (rnd(28) % 90),
  };
}

// Emits the ping + perf frames a rendering client would. Start it right after `init`.
export class Telemetry {
  constructor({ net, state, profile }) {
    this.net = net; this.state = state; this.profile = profile;
    this.timers = [];
    this.ping = profile.basePing;
  }

  start() {
    this.stop();
    // ping every ~10 s, like the real client's idle cadence
    const pingTick = () => {
      this.net.send({ t: 'ping', ts: Math.round(performance.now()) });
      this.timers.push(setTimeout(pingTick, human(10000, 0.12)));
    };
    this.timers.push(setTimeout(pingTick, human(4000, 0.4)));

    // perf report every ~60 s, with a frame histogram that drifts the way a real machine's does
    const perfTick = () => {
      this.net.send(this.buildPerf());
      this.timers.push(setTimeout(perfTick, human(60000, 0.15)));
    };
    this.timers.push(setTimeout(perfTick, human(62000, 0.2)));
    return this;
  }

  // b[] is a 5-bucket frame-time histogram totalling ~the frames rendered in the window. A decent
  // machine sits mostly in the fast buckets with a thin tail.
  buildPerf() {
    const p = this.profile;
    const total = Math.round(3000 + Math.random() * 700);   // ~60fps for a minute, jittered
    const good = Math.round(total * (0.72 + Math.random() * 0.2));
    const ok = Math.round((total - good) * (0.5 + Math.random() * 0.3));
    const meh = Math.round((total - good - ok) * 0.6);
    const bad = Math.round((total - good - ok - meh) * 0.7);
    const awful = Math.max(0, total - good - ok - meh - bad);
    this.ping = Math.max(8, Math.round(p.basePing + (Math.random() * 2 - 1) * 12));
    const me = this.state.me || { x: 0, z: 0 };
    return {
      t: 'perf',
      b: [good, ok, meh, bad, awful],
      w: Math.round(60 + Math.random() * 180),
      ping: this.ping,
      mob: p.mob, dpr: p.dpr, cores: p.cores, mem: p.mem,
      gpu: p.gpu.slice(0, 72), sw: p.sw,
      zone: Math.hypot(me.x || 0, me.z || 0) < 70 ? 'town' : 'valley',
      fx: p.fx, sh: p.sh,
    };
  }

  stop() { for (const t of this.timers) clearTimeout(t); this.timers = []; }
}
