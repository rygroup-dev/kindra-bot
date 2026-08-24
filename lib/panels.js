// panels.js — every screen the Telegram control surface can show.
//
// Split out of the bot entry point for one reason: it makes the UI TESTABLE. tools/test-ui.js
// builds the routes against a live-or-idle fleet, renders every panel, and asserts that each
// button's callback_data resolves to a real route — so a renamed handler can never leave a dead
// button in the panel.
import { Fleet, WALLET_FILE, MAX_ONLINE_PER_IP } from './fleet.js';
import { Telegram } from './telegram.js';
import { KGold, walletOverview } from './chain.js';
import { Treasury, GAS_FLOOR, GAS_TOPUP } from './treasury.js';
import { levelForXp, ITEMS, CLASS_PASSIVES, CLASS_KIT } from './rules.js';
import { E, SKILL_ICON, meter, statusDot, short, dur, esc, box, activityLabel } from './ui.js';

const KB = Telegram.kb;

// The passives worth spreading a fleet across, best-first. Rogue pays the fleet's actual bottleneck
// (gold from drops), Knight and Viking keep characters alive — which is what three deaths in an hour
// cost us — and Ninja and Goblin compound on the two things the bot does all day, swinging and
// gathering. Dealt round-robin so a batch of ten covers ten different passives.
const MIXED_CLASSES = ['Rogue', 'Knight', 'Ninja_Male', 'Viking_Female', 'Goblin_Male', 'Ranger',
  'Wizard', 'Barbarian', 'Rogue_Hooded', 'Witch', 'Elf', 'Mage'];

export function buildRoutes({ fleet, tg, world }) {
  const treasury = new Treasury({ log: (m) => tg.log?.(m) });
// --- helpers --------------------------------------------------------------

function bot(label) {
  const b = label ? fleet.get(label) : [...fleet.bots.values()][0];
  if (!b) throw new Error(label ? `no account "${label}"` : 'no accounts yet — use New account');
  return b;
}
function kgoldOf(b) { return b.kgold || (b.kgold = new KGold({ net: b.net, state: b.state, log: b.log })); }
// Returns ONE row: an array of [label, callbackData] pairs. Pass it to KB() as a single element —
// spreading it makes KB read each pair as a row and destructure the label string per character.
const navRow = (extra = []) => [...extra, [`${E.back} Home`, 'home'], [`${E.refresh} Refresh`, 'home']];

// --- HOME -----------------------------------------------------------------

function homePanel() {
  const t = fleet.totals();
  const n = fleet.size;
  if (!n) {
    return {
      text: `${E.brand} *Kindra Bot*\n_a RY GROUP project_\n\nNo characters yet. Sign-up on Kindra needs no gas and no captcha — a wallet signature is enough.\n\nTap below to mint your first one.`,
      keyboard: KB([[[`${E.acct} Mint 1 account`, 'new:1'], [`${E.acct} Mint 5`, 'new:5']], [[`${E.gear} Help`, 'help']]]),
    };
  }
  // Banned characters are left out of the roster here too — they hold no gold, will never come
  // back online, and eleven dead rows in a fifty-row box is most of a screen saying nothing.
  const alive = [...fleet.bots.values()].filter((b) => fleet.playable(b));
  const rows = alive.map((b) => {
    const me = b.state.me;
    const name = esc(me?.name || b.name).padEnd(14).slice(0, 14);
    // An off-shift account still shows its balance — the last one we saw, marked with a tilde so
    // it is never mistaken for a live reading.
    const saved = fleet.goldOf(b.label);
    const gold = me ? short(me.gold).padStart(6)
      : saved != null ? `~${short(saved)}`.padStart(6)
      : '     —';
    return `${statusDot(b.status)} ${name} ${gold}${E.gold}`;
  });
  const online = fleet.online;
  const queued = alive.filter((b) => b.status === 'queued').length;
  const proxied = alive.filter((b) => b.proxy).length;
  const lost = n - alive.length;
  return {
    text: [
      `${E.brand} *Kindra Valley* — ${esc(world.name)}`,
      `${E.fleet} *${online}/${alive.length}* character${alive.length === 1 ? '' : 's'} in the valley${fleet.shiftsOn ? ` · ${E.clock} shifts on` : ''}${lost ? `  ·  🚫 ${lost} banned` : ''}`,
      fleet.pinned ? `📌 *${esc(fleet.pinned)}* is pinned until account Lv 10 — ${MAX_ONLINE_PER_IP - 1} slots rotating` : null,
      fleet.mode === 'gold' ? `${E.gold} *GOLD MODE* — xp is worth almost nothing; every character reaches for coins first` : null,
      '',
      box(rows),
      `${E.gold} *${short(t.gold)}* gold held  ·  ${t.gained >= 0 ? '+' : ''}${short(t.gained)} this session`,
      `${E.combat} ${t.kills} kills · ${E.quest} ${t.quests} quests claimed`,
      queued ? `\n${E.clock} *${queued} queued.* The server allows only *${MAX_ONLINE_PER_IP} characters online per IP*. Turn on shifts to rotate them through the day, or give accounts a \`proxy\` in \`wallets.json\` — each exit IP gets its own allowance of ${MAX_ONLINE_PER_IP}.${proxied ? ` (${proxied} already proxied.)` : ''}` : '',
    ].filter((l) => l !== null).join('\n'),
    keyboard: KB([
      [[`${E.fleet} Characters`, 'fleet'], [`${E.quest} Quests`, 'quests:']],
      [[`${E.token} Wallets`, 'wallets'], [`${E.gold} Sell gold`, 'kgold:']],
      [[`▶️ Start all`, 'runall'], [`⏹ Stop all`, 'stopall']],
      [[fleet.shiftsOn ? `${E.clock} Shifts: ON` : `${E.clock} Shifts: off`, 'shifts'],
       [fleet.mode === 'gold' ? `${E.gold} Mode: GOLD` : `${E.gold} Mode: normal`, 'mode']],
      [[`${E.acct} New account`, 'newmenu']],
      [[`${E.refresh} Refresh`, 'home']],
    ]),
  };
}

// --- FLEET / ACCOUNT ------------------------------------------------------

function fleetPanel() {
  if (!fleet.size) return homePanel();
  // Banned characters are not listed. They cannot be started, cannot earn and cannot be fixed for
  // about a year, so a button for each was eleven taps that all led to the same dead end — and with
  // fifty characters the list is long enough already. The count still gets a line: a fleet that
  // silently shrank from 50 to 39 is worse than one that says so.
  const banned = fleet.banned();
  const rows = [...fleet.bots.values()].filter((b) => fleet.playable(b)).map((b) => [
    `${statusDot(b.status)} ${esc(b.state.me?.name || b.label)}`, `acct:${b.label}`,
  ]);
  const pairs = [];
  for (let i = 0; i < rows.length; i += 2) pairs.push(rows.slice(i, i + 2));
  return {
    text: [
      `${E.fleet} *Characters* — tap one to open it`,
      '',
      `_Each wallet is one character. Every gold source is capped per character, so more characters is the only way past the ceiling._`,
      // A banned account still has a button, still has a name, and still looks like part of the
      // fleet — so the only way to notice the fleet had shrunk was to read the log.
      banned.length ? `\n_🚫 ${banned.length} banned and hidden — ${rows.length} playable._` : '',
    ].filter(Boolean).join('\n'),
    keyboard: KB([...pairs, navRow()]),
  };
}

function acctPanel(label) {
  const b = bot(label);
  const me = b.state.me;
  if (!me) {
    return {
      text: `${E.acct} *${esc(b.label)}*\nstatus: ${b.status}${b.lastError ? `\n${E.dead} ${esc(b.lastError)}` : ''}\n\n\`${b.address}\``,
      keyboard: KB([[[`▶️ Start`, `run:${b.label}`]], navRow([[`${E.fleet} Characters`, 'fleet']])]),
    };
  }
  const o = b.orch, base = o.baseline || o.snapshot(), now = o.snapshot();
  const mins = Math.max(1, (now.at - base.at) / 60000);
  const dGold = now.gold - base.gold, dXp = now.totalXp - base.totalXp;
  const skills = Object.entries(me.skills || {})
    .map(([k, v]) => `${SKILL_ICON[k] || '·'}${String(levelForXp(v)).padStart(2)}`).join(' ');

  return {
    text: [
      `${statusDot(b.status)} *${esc(me.name)}*  ·  _${esc(b.label)}_`,
      `${activityLabel(o.current)}`,
      '',
      `${E.gold} *${short(me.gold)}* gold   ${dGold >= 0 ? '+' : ''}${short(dGold)}  (${short(dGold / mins * 60)}/h)`,
      `${E.up} +${short(dXp)} xp  (${short(dXp / mins * 60)}/h)`,
      `${skills}`,
      '',
      `${E.hp} ${me.hp ?? '?'}/100   ${E.bag} ${b.economy.used()}/${b.economy.capacity()}   ${E.food} ${b.crafting.rationCount()}`,
      // Say it outright. The panel showed 11/100 hp and 0 rations side by side and left you to
      // work out that those two numbers together mean the character cannot fight, cannot heal,
      // and is quietly doing something else instead — which is what a stalled chase looks like.
      (me.hp ?? 100) < 40 && b.crafting.rationCount() === 0
        ? `${E.dead} *stalled* — hurt with no rations: nothing is safe to fight until it eats`
        : null,
      `🤝 kinship ${b.gather.kinshipAt(b.state.pos.x, b.state.pos.z).toFixed(2)}×   ${E.wood} yield ${(b.gather.yieldMult() * 100).toFixed(0)}%`,
      `${E.pin} (${me.x?.toFixed(0)}, ${me.z?.toFixed(0)}) · up ${dur(now.at - base.at)} · cycle ${o.cycle}`,
      `🤝 account Lv ${me.tl ?? '?'}`,
      fleet.pinned === b.label ? `📌 *pinned* — holds a slot and chases combat until Lv 10; the other 2 slots rotate` : null,
      `${E.combat} ${b.combat.stats.kills} kills / ${b.combat.stats.deaths} deaths`,
    ].filter((l) => l !== null).join('\n'),
    keyboard: KB([
      [[b.status === 'running' ? '⏹ Stop' : '▶️ Start', `${b.status === 'running' ? 'stop' : 'run'}:${b.label}`],
       [`${E.cap} Caps`, `caps:${b.label}`]],
      [[fleet.pinned === b.label ? '📌 Unpin' : '📌 Pin until Lv 10', `pin:${b.label}`]],
      [[`${E.bag} Satchel`, `bag:${b.label}`], [`${E.quest} Quests`, `quests:${b.label}`]],
      [[`${E.sell} Sell now`, `sell:${b.label}`], [`${E.cook} Cook all`, `cook:${b.label}`]],
      [[`${E.food} Buy food`, `food:${b.label}`], [`${E.wheel} Free spin`, `spin:${b.label}`]],
      [[`${E.boss} Bosses`, `boss:${b.label}`], [`${E.road} Trade Roads`, `jobs:${b.label}`]],
      [[`🌀 Realms`, `realms:${b.label}`]],
      [[`${E.garden} Garden`, `garden:${b.label}`], [`${E.shop} Upgrades`, `upgrades:${b.label}`]],
      [[`${E.token} Wallet`, `wallet:${b.label}`], [`${E.log} Log`, `log:${b.label}`]],
      navRow([[`${E.fleet} Characters`, 'fleet']]),
    ]),
  };
}

function capsPanel(label) {
  const b = bot(label);
  const h = b.state.haul || {};
  const keys = ['combat', 'boss', 'vendor', 'trade', 'bounty', 'kart'].filter((k) => h[`${k}Cap`] != null);
  const rows = keys.map((k) => {
    const cur = h[k] || 0, cap = h[`${k}Cap`];
    return `${k.padEnd(7)} ${meter(cur, cap)} ${String(cur).padStart(5)}/${cap}`;
  });
  const spent = keys.filter((k) => (h[k] || 0) >= h[`${k}Cap`]);
  return {
    text: [
      `${E.cap} *Daily caps* — ${esc(b.state.me?.name || b.label)}`,
      box(rows.length ? rows : ['no caps reported yet']),
      spent.length ? `${E.dead} spent today: *${spent.join(', ')}*` : `${E.on} nothing maxed out yet`,
      '',
      `_Gold is capped per source per day and resets on the server's day roll. XP is never capped — that is why the brain keeps working a source after its gold runs dry, but prefers one that still pays._`,
    ].join('\n'),
    keyboard: KB([navRow([[`${E.acct} ${esc(b.label)}`, `acct:${b.label}`]])]),
  };
}

function bagPanel(label) {
  const b = bot(label);
  const inv = b.state.me?.inv || {};
  const rows = Object.entries(inv).sort((a, c) => c[1] - a[1]).slice(0, 22).map(([k, v]) => {
    const d = ITEMS[k] || {};
    return `${String(v).padStart(4)} × ${(d.name || k).slice(0, 20).padEnd(20)} ${b.economy.route(k)}`;
  });
  return {
    text: [
      `${E.bag} *Satchel* — ${esc(b.state.me?.name || b.label)}  (${b.economy.used()}/${b.economy.capacity()})`,
      box(rows.length ? ['qty  item                 → exit', ...rows] : ['empty']),
      `${E.gold} ${short(b.state.me?.gold)} gold · ${E.food} ${b.crafting.rationCount()} rations`,
      `_"exit" is where the brain will send each stack: the vendor pays 45% of an item's base price and gluts as you sell; the market takes 9% but keeps full price._`,
    ].join('\n'),
    keyboard: KB([
      [[`${E.sell} Sell now`, `sell:${b.label}`], [`${E.cook} Cook all`, `cook:${b.label}`]],
      navRow([[`${E.acct} ${esc(b.label)}`, `acct:${b.label}`]]),
    ]),
  };
}

function questsPanel(label) {
  const b = bot(label);
  const qs = b.state.quests || [];
  const rows = (b.quests.boardReport() || '').split('\n').filter(Boolean);
  const pref = b.quests.preferredActivity();
  return {
    text: [
      `${E.quest} *Quest board* — ${esc(b.state.me?.name || b.label)}`,
      box(rows.length ? rows : ['no quests loaded yet']),
      `claimed this session: *${b.quests.stats.claimed}* (+${b.quests.stats.gold}${E.gold})`,
      pref ? `next best: *${pref.activity}${pref.skill ? ` ${pref.skill}` : ''}* — the brain is already weighting toward it` : '',
      '',
      `_Quest gold is paid on top of every daily cap, and the objectives are things the bot does anyway — so open quests steer which activity runs next._`,
    ].filter(Boolean).join('\n'),
    keyboard: KB([
      [[`🎁 Claim ready`, `claim:${b.label}`], [`${E.wheel} Free spin`, `spin:${b.label}`]],
      navRow([[`${E.acct} ${esc(b.label)}`, `acct:${b.label}`]]),
    ]),
  };
}

async function walletsPanel(label) {
  const primary = treasury.primary();
  const rows = [];
  let totalKindra = 0, needGas = 0;
  const targets = label ? [{ label }] : treasury.book();

  for (const w of targets) {
    const entry = treasury.book().find((x) => x.label === w.label) || w;
    const o = await walletOverview(entry.address);
    const isPrimary = primary && entry.label === primary.label;
    totalKindra += Number(o.kindra) || 0;
    const gasLow = Number(o.native) < Number(GAS_FLOOR) / 1e18;
    if (gasLow) needGas++;
    rows.push(`${isPrimary ? '⭐' : '  '} ${entry.label.padEnd(10)} ${String(Number(o.kindra).toFixed(2)).padStart(10)} ◈  ${gasLow ? '⛽low' : Number(o.native).toFixed(4) + ' ETH'}`);
  }

  return {
    text: [
      `${E.token} *Wallets* — Robinhood Chain 4663`,
      box(['   account       $KINDRA      gas', ...rows]),
      `⭐ primary: \`${esc(primary?.label || '—')}\``,
      primary ? `\`${primary.address}\`` : '',
      `total $KINDRA held: *${totalKindra.toFixed(2)}*${needGas ? ` · ${needGas} wallet(s) below the gas floor` : ''}`,
      '',
      `_Playing needs no gas at all — sign-in is a signature and selling gold is escrowed server-side. Gas is only needed to BUY on the book or to move tokens, so fund deliberately rather than by habit._`,
    ].filter(Boolean).join('\n'),
    keyboard: KB([
      [[`⭐ Set primary`, 'pickprimary'], [`${E.refresh} Refresh`, 'wallets']],
      [[`⛽ Fund gas`, 'fundgas'], [`🧹 Sweep to primary`, 'sweep']],
      [[`🔑 Export private keys`, 'exportkeys']],
      [[`${E.gold} Sell gold for $KINDRA`, 'kgold:']],
      navRow(),
    ]),
  };
}

function pickPrimaryPanel() {
  const b = treasury.book();
  const primary = treasury.primary();
  const rows = [];
  for (let i = 0; i < b.length; i += 2) {
    rows.push(b.slice(i, i + 2).map((w) => [
      `${primary && w.label === primary.label ? '⭐ ' : ''}${w.label}`, `setprimary:${w.label}`,
    ]));
  }
  return {
    text: [
      `⭐ *Choose the primary wallet*`,
      '',
      `The primary is the fleet's treasury: sweeps land here and gas is paid out of it. Pick the one you actually control and back up.`,
      '',
      `current: \`${esc(primary?.label || '—')}\``,
    ].join('\n'),
    keyboard: KB([...rows, navRow([[`${E.token} Wallets`, 'wallets']])]),
  };
}

async function kgoldPanel(label) {
  const b = bot(label);
  const kg = kgoldOf(b);
  await kg.refresh();
  const rate = kg.marketRate();
  const rows = kg.book.slice(0, 8).map((l) => `${String(short(l.gold || 0)).padStart(7)}${E.gold} → ${String(l.price).padStart(7)} $KINDRA`);
  return {
    text: [
      `${E.gold}⇄${E.token} *Gold for real $KINDRA*`,
      rate ? `best *${rate.best.toFixed(2)}* · median ${rate.median.toFixed(2)} $KINDRA per 1k gold  (${rate.listings} live)` : '_the book is empty right now_',
      box(rows.length ? rows : ['no listings']),
      `${esc(b.state.me?.name || b.label)} holds *${short(b.state.me?.gold)}* gold · ${kg.mine.length}/3 listing slots used`,
      '',
      `_Listing costs nothing: the escrow is server-side and the buyer's wallet pays yours directly. The 5% fee comes out of the buyer's side._`,
    ].join('\n'),
    keyboard: KB([
      [[`${E.sell} List surplus (keep 5k)`, `cashout:${b.label}:5000`]],
      [[`keep 1k`, `cashout:${b.label}:1000`], [`keep 20k`, `cashout:${b.label}:20000`]],
      navRow([[`${E.token} Wallets`, 'wallets']]),
    ]),
  };
}

function upgradesPanel(label) {
  const b = bot(label);
  const plan = b.upgrades.plan();
  const rows = plan.slice(0, 8).map((p) =>
    `${p.affordable ? '✅' : '🔒'} ${String(p.cost).padStart(5)}g  ${p.id.slice(0, 20).padEnd(20)} ${p.why}`);
  return {
    text: [
      `${E.shop} *Upgrades* — ${esc(b.state.me?.name || b.label)}`,
      `${E.gold} ${short(b.state.me?.gold)} gold in hand`,
      box(rows.length ? rows : ['fully upgraded for this level']),
      `bought this session: ${b.upgrades.bought.length ? esc(b.upgrades.bought.join(', ')) : '—'}`,
      '',
      `_Gold in the satchel earns nothing. A tool is a permanent multiplier on every future swing, so the brain buys the cheapest payback first whenever it is already at the market._`,
    ].join('\n'),
    keyboard: KB([
      [[`${E.shop} Buy affordable`, `buyup:${b.label}`]],
      navRow([[`${E.acct} ${esc(b.label)}`, `acct:${b.label}`]]),
    ]),
  };
}

function bossPanel(label) {
  const b = bot(label);
  const rows = b.bosses.report().split('\n');
  const target = b.bosses.pick({ requireHelpers: true });
  const raid = b.bosses.raid?.done ? null : b.bosses.raid;
  return {
    text: [
      `${E.boss} *Bosses* — ${esc(b.state.me?.name || b.label)}  (combat Lv ${b.bosses.myCombatLevel()})`,
      box(rows),
      raid ? `${E.boss} *RAID CALLED* — ${esc(raid.bossId)} with ${raid.members.length} of ours · ~${Math.round(raid.pay)}g each · ${raid.go ? 'fighting' : `mustering (${raid.members.filter((l) => bot(l)?.bosses?.mustered).length}/${raid.members.length} in position)`}`
           : target ? `${E.on} joining *${esc(target.name || target.id)}* — ${target.helpers} others already on it`
           : `${E.clock} nothing worth joining: the brain only engages a boss someone else is tanking`,
      `fights ${b.bosses.stats.fights} · damage ${short(b.bosses.stats.damage)} · spoils ${b.bosses.stats.spoils}`,
      '',
      `_Only four bosses pay gold at all — the rest give gems and a mat. Those four have no other players on them, so the fleet brings its own party: the raid is called when enough characters are online to survive it._`,
    ].join('\n'),
    keyboard: KB([navRow([[`${E.acct} ${esc(b.label)}`, `acct:${b.label}`]])]),
  };
}

function jobsPanel(label) {
  const b = bot(label);
  return {
    text: [
      `${E.road} *Trade Roads* — ${esc(b.state.me?.name || b.label)}`,
      box(b.jobs.report().split('\n')),
      `daily trade cap: ${(b.state.haul || {}).trade || 0}/${(b.state.haul || {}).tradeCap ?? '?'}`,
      '',
      `_Cargo halves your speed and bandits ambush en route, so the bot only ever buys the safe variant and never a tier it cannot afford to lose._`,
    ].join('\n'),
    keyboard: KB([navRow([[`${E.acct} ${esc(b.label)}`, `acct:${b.label}`]])]),
  };
}

function gardenPanel(label) {
  const b = bot(label);
  const next = b.garden.nextReadyIn();
  return {
    text: [
      `${E.garden} *Garden* — ${esc(b.state.me?.name || b.label)}`,
      box(b.garden.report().split('\n')),
      `ripe now: *${b.garden.ready().length}* · empty: ${b.garden.free().length}/8${Number.isFinite(next) ? ` · next in ${dur(next)}` : ''}`,
      `planted ${b.garden.stats.planted} · harvested ${b.garden.stats.harvested}`,
      '',
      `_The only thing here that earns while the character is somewhere else. Crops spoil two hours after ripening._`,
    ].join('\n'),
    keyboard: KB([
      [[`${E.garden} Tend now`, `tend:${b.label}`]],
      navRow([[`${E.acct} ${esc(b.label)}`, `acct:${b.label}`]]),
    ]),
  };
}

function realmsPanel(label) {
  const b = bot(label);
  return {
    text: [
      `🌀 *Realms* — ${esc(b.state.me?.name || b.label)}`,
      box((b.realms?.report() || 'unavailable').split('\n')),
      '',
      `_Eleven regions are walkable; seven realms are doors. Nodes and creatures inside a realm you cannot enter are skipped rather than walked toward — coral lives in the Sunken Isles, wartree in the Warscar._`,
    ].join('\n'),
    keyboard: KB([navRow([[`${E.acct} ${esc(b.label)}`, `acct:${b.label}`]])]),
  };
}

function logPanel(label) {
  const b = bot(label);
  const lines = b.logLines.slice(-18).map((l) => l.replace(/^\[\d\d:\d\d:\d\d\] \[[^\]]+\] /, ''));
  return {
    text: `${E.log} *Log* — ${esc(b.state.me?.name || b.label)}\n${box(lines.length ? lines : ['nothing yet'])}`,
    keyboard: KB([[[`${E.refresh} Refresh`, `log:${b.label}`]], navRow([[`${E.acct} ${esc(b.label)}`, `acct:${b.label}`]])]),
  };
}

const HELP = [
  `${E.brand} *Kindra Bot* — a RY GROUP project`,
  `_playkindra.com · Robinhood Chain 4663_`,
  '',
  `Everything here is also a button — tap ${E.back} Home and drive it from the panel.`,
  '',
  `*Fleet* · /status /accounts /run /stop /new \`n\` /shifts`,
  `*Character* · /caps /quests /skills /bag /where /log`,
  `*Activities* · /boss /jobs /garden /upgrades`,
  `*Actions* · /sell /cook /food \`n\` /spin /claim /tend /buyup`,
  `*On-chain* · /wallet /kgold /cashout \`keep\``,
  '',
  `_Add an account name to target one, e.g._ \`/bag kindra-02\`_. With no name, the first account is used._`,
].join('\n');

// --- routing --------------------------------------------------------------
// One table drives both the typed commands and the buttons, so they cannot disagree.

const ROUTES = {
  home: async () => homePanel(),
  help: async () => ({ text: HELP, keyboard: KB([[[`${E.back} Home`, 'home']]]) }),
  fleet: async () => fleetPanel(),
  acct: async (a) => acctPanel(a[0]),
  caps: async (a) => capsPanel(a[0]),
  bag: async (a) => bagPanel(a[0]),
  quests: async (a) => questsPanel(a[0]),
  wallets: async (a) => walletsPanel(a[0]),
  wallet: async (a) => walletsPanel(a[0]),
  pickprimary: async () => pickPrimaryPanel(),
  setprimary: async (a) => {
    const w = treasury.setPrimary(a[0]);
    return { ...(await walletsPanel()), toast: `primary is now ${w.label}` };
  },
  // Exporting the fleet's keys is the one irreversible thing this panel can do, so it takes two
  // taps and says plainly what it costs.
  exportkeys: async () => ({
    text: [
      `🔑 *Export private keys*`,
      '',
      `This sends *every* wallet in the fleet — private keys included — as a JSON file to this chat, and deletes the message again after 5 minutes.`,
      '',
      `Worth knowing before you tap:`,
      `· The file passes through Telegram's servers. Auto-delete removes it from the chat; it does not un-send it.`,
      `· Anyone with this chat open in those 5 minutes can save it.`,
      `· Save it somewhere offline, then let it expire.`,
      '',
      `\`wallets.json\` on the server is the same file, and copying it over SSH never touches a third party.`,
    ].join('\n'),
    keyboard: KB([
      [[`🔑 Yes, export for 5 minutes`, 'exportkeys2']],
      [[`${E.back} Cancel`, 'wallets']],
    ]),
  }),

  exportkeys2: async () => {
    const book = Fleet.loadWallets();
    if (!book.length) return { ...(await walletsPanel()), toast: 'no wallets to export' };
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      world: world.id,
      note: 'Kindra Bot fleet keys. Treat as cash. This message self-deletes 5 minutes after sending.',
      wallets: book.map((w) => ({ label: w.label, address: w.address, privateKey: w.privateKey, primary: !!w.primary, name: w.name || '' })),
    }, null, 2);

    const id = await tg.sendDocument(
      `kindra-wallets-${new Date().toISOString().slice(0, 10)}.json`,
      payload,
      `🔑 *${book.length} wallet(s)* — this message deletes itself in 5 minutes.\nSave it offline now.`,
    );
    if (!id) return { ...(await walletsPanel()), toast: 'export failed — check the bot log' };

    const EXPIRE_MS = 5 * 60 * 1000;
    setTimeout(async () => {
      const gone = await tg.deleteMessage(id);
      await tg.send(gone ? `🔑 The wallet export has been deleted from this chat.`
                         : `⚠️ Couldn't auto-delete the wallet export — delete it yourself.`).catch(() => {});
    }, EXPIRE_MS);

    return { ...(await walletsPanel()), toast: `sent — deletes in 5 minutes` };
  },

  fundgas: async () => {
    const low = await treasury.needsGas();
    if (!low.length) return { ...(await walletsPanel()), toast: 'every wallet is already funded' };
    await tg.send(`⛽ Funding *${low.length}* wallet(s) with ${Number(GAS_TOPUP) / 1e18} ETH each from the primary…`);
    const r = await treasury.fundGas();
    return {
      ...(await walletsPanel()),
      toast: r.funded?.length ? `funded ${r.funded.length}` : (r.reason || 'nothing to fund'),
    };
  },
  sweep: async () => {
    await tg.send(`🧹 Sweeping $KINDRA from every sub-account to the primary…`);
    const r = await treasury.sweep();
    const lines = [
      `🧹 *Sweep to \`${esc(r.to.label)}\`*`,
      r.moved.length ? r.moved.map((m) => `✅ ${esc(m.label)} → ${m.amount}`).join('\n') : '_nothing moved_',
      r.skipped.length ? `\nskipped:\n${r.skipped.map((sk) => `· ${esc(sk.label)}: ${esc(sk.why)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    await tg.send(lines);
    return { ...(await walletsPanel()), toast: `moved ${r.moved.length}, skipped ${r.skipped.length}` };
  },
  kgold: async (a) => kgoldPanel(a[0]),
  log: async (a) => logPanel(a[0]),
  upgrades: async (a) => upgradesPanel(a[0]),
  boss: async (a) => bossPanel(a[0]),
  jobs: async (a) => jobsPanel(a[0]),
  garden: async (a) => gardenPanel(a[0]),
  realms: async (a) => realmsPanel(a[0]),
  tend: async (a) => {
    const b = bot(a[0]);
    const r = await b.garden.tend();
    return { ...gardenPanel(b.label), toast: `harvested ${r.harvested}, planted ${r.planted}` };
  },
  buyup: async (a) => {
    const b = bot(a[0]);
    const done = await b.upgrades.buyAffordable();
    return { ...upgradesPanel(b.label), toast: done.length ? `bought ${done.join(', ')}` : 'nothing affordable yet' };
  },

  newmenu: async () => ({
    text: `${E.acct} *Mint characters*\n\nEach one is a fresh EVM wallet and a fresh character. Sign-up needs no gas and no captcha.\n\nHow many?\n\nKeys are written to \`wallets.json\` with 600 permissions — back that file up, it is the only copy.`,
    keyboard: KB([[['+1', 'newclass:1'], ['+3', 'newclass:3'], ['+5', 'newclass:5'], ['+10', 'newclass:10']], [[`${E.back} Home`, 'home']]]),
  }),

  // The class carries a PERMANENT passive and the login-screen pick is the only free one — changing
  // the hero body later goes through the Hall of Mirrors at 2,500 gold + 100 per account level. The
  // first 21 wallets were rolled at random before anyone noticed, so this screen exists to stop that
  // happening again: every passive is on the button, in plain words, before a key is generated.
  newclass: async (a) => {
    const n = Math.max(1, Math.min(20, parseInt(a[0] || '1', 10)));
    const mix = MIXED_CLASSES.slice(0, Math.max(1, Math.min(MIXED_CLASSES.length, n)));
    return {
      text: [
        `${E.acct} *Class for ${n} character${n === 1 ? '' : 's'}*`,
        '',
        'Every class swings the same weapon ladder — the difference is a permanent passive.',
        '',
        `🎯 *Balanced mix* deals them round-robin across ${mix.length}:`,
        mix.map((id) => `   ${CLASS_PASSIVES[id].icon} ${esc(id.replace(/_/g, ' '))} — ${esc(CLASS_PASSIVES[id].desc)}`).join('\n'),
        '',
        '_Ten identical heroes waste ten passives and read as one fleet, so a mix is the default._',
      ].join('\n'),
      keyboard: KB([
        [[`🎯 Balanced mix (recommended)`, `new:${n}:mix`]],
        [[`👤 All one class…`, `newpick:${n}`], ['🎲 Random each', `new:${n}:random`]],
        [[`${E.back} Back`, 'newmenu']],
      ]),
    };
  },

  // The full menu, for when someone wants every hero on the same passive on purpose.
  newpick: async (a) => {
    const n = Math.max(1, Math.min(20, parseInt(a[0] || '1', 10)));
    const rows = Object.entries(CLASS_PASSIVES).map(([id, p]) => [[
      `${p.icon} ${id.replace(/_/g, ' ')} — ${p.name}`, `new:${n}:${id}`,
    ]]);
    return {
      text: [
        `${E.acct} *One class for all ${n}*`,
        '',
        ...Object.entries(CLASS_PASSIVES).map(([id, p]) =>
          `${p.icon} *${esc(id.replace(/_/g, ' '))}* — ${esc(p.desc)}${CLASS_KIT[id]?.weapon ? ` _(${esc(CLASS_KIT[id].weapon)})_` : ''}`),
        '',
        '_Changing it later costs 2,500 gold + 100 per account level._',
      ].join('\n'),
      keyboard: KB([...rows, [[`${E.back} Back`, `newclass:${n}`]]]),
    };
  },

  new: async (a) => {
    const n = Math.max(1, Math.min(20, parseInt(a[0] || '1', 10)));
    // 'mix' deals the curated list round-robin, a class id puts every hero on it, 'random' leaves
    // the per-wallet roll alone.
    const spec = a[1];
    const cls = spec === 'mix' ? MIXED_CLASSES
      : (spec && spec !== 'random' && CLASS_PASSIVES[spec]) ? spec
      : null;
    // Minted with no referrer — the join frame carries no `ref`. See Fleet.createWallets.
    const made = Fleet.createWallets(n, { world: world.id, character: cls });
    for (const e of made) fleet.add(e);
    // A minted character that sits idle earns nothing, and pressing "Start all" afterwards was easy
    // to forget. Enrol the new ones straight into the orchestrator: startAll fills the free per-IP
    // slots least-played first — which brand-new characters always are — and marks the rest
    // `queued`, so nothing is lost when all three slots are busy. Shift rotation picks those up.
    const run = await fleet.startAll({ only: made.map((m) => m.label) });
    return {
      text: [
        `${E.on} Minted *${n}* character${n === 1 ? '' : 's'}.`,
        Array.isArray(cls)
          ? `🎯 Balanced mix — ${made.map((m) => `${CLASS_PASSIVES[m.character]?.icon || '•'}`).join('')}`
          : cls
            ? `${CLASS_PASSIVES[cls].icon} all *${esc(cls.replace(/_/g, ' '))}* — ${esc(CLASS_PASSIVES[cls].desc)}`
            : '_Class rolled at random per character._',
        '',
        made.map((m) => `\`${m.label}\`  ${m.address}`).join('\n'),
        '',
        run.started.length
          ? `▶️ ${run.started.length} started: ${run.started.map((l) => `\`${l}\``).join(' ')}`
          : null,
        run.queued.length
          ? `⏳ ${run.queued.length} queued behind the ${MAX_ONLINE_PER_IP}-per-IP limit — shift rotation brings them in.`
          : null,
        run.failed.length ? `${E.off} ${run.failed.length} could not join: ${run.failed.join(', ')}` : null,
        '',
        `Keys saved to \`${WALLET_FILE}\`.`,
      ].filter(Boolean).join('\n'),
      keyboard: KB([[[`${E.acct} Fleet`, 'fleet']], [[`${E.back} Home`, 'home']]]),
      toast: `Minted ${n} · ${run.started.length} started${run.queued.length ? `, ${run.queued.length} queued` : ''}`,
    };
  },

  run: async (a) => { const b = bot(a[0]); await b.start(); return { ...acctPanel(b.label), toast: 'started' }; },
  stop: async (a) => { const b = bot(a[0]); b.stop(); return { ...acctPanel(b.label), toast: 'stopped' }; },
  runall: async () => {
    await tg.send(`${E.clock} Starting up to ${MAX_ONLINE_PER_IP} character(s) per IP, staggered by 12s so they don't all land on the same second…`);
    const r = await fleet.startAll();
    const bits = [`${E.on} started *${r.started.length}*`];
    if (r.queued.length) bits.push(`${E.clock} queued *${r.queued.length}* (per-IP limit)`);
    if (r.failed.length) bits.push(`${E.dead} failed *${r.failed.length}*: ${esc(r.failed.join(', '))}`);
    await tg.send(bits.join(' · '));
    return homePanel();
  },

  shifts: async () => {
    if (fleet.shiftsOn) { fleet.stopShifts(); return { ...homePanel(), toast: 'shift rotation off' }; }
    fleet.startShifts();
    return { ...homePanel(), toast: 'rotating on — a slot is handed over as soon as its caps are collected' };
  },
  stopall: async () => { fleet.stopAll(); return { ...homePanel(), toast: 'all stopped' }; },
  mode: async () => {
    const m = fleet.setMode(fleet.mode === 'gold' ? 'normal' : 'gold');
    return { ...homePanel(), toast: m === 'gold' ? 'gold mode — chasing coins, not xp' : 'normal mode — xp counts again' };
  },
  pin: async (a) => {
    const label = a[0];
    if (fleet.pinned === label) { const r = fleet.unpin({ reason: 'released by hand' }); return { ...acctPanel(label), toast: r.ok ? `${label} unpinned` : r.why }; }
    const r = fleet.pin(label);
    return { ...acctPanel(label), toast: r.ok ? `${label} pinned until account Lv 10` : r.why };
  },

  sell: async (a) => {
    const b = bot(a[0]);
    const before = b.state.me.gold;
    const r = await b.economy.makeRoom();
    return { ...bagPanel(b.label), toast: `sold ${r.items} items, +${b.state.me.gold - before}g` };
  },
  cook: async (a) => {
    const b = bot(a[0]);
    const n = await b.crafting.cookAll();
    return { ...bagPanel(b.label), toast: `cooked ${n} — ${b.crafting.rationCount()} rations` };
  },
  food: async (a) => {
    const b = bot(a[0]);
    const n = await b.economy.buyFood(parseInt(a[1] || '5', 10));
    return { ...bagPanel(b.label), toast: `bought ${n} meals` };
  },
  spin: async (a) => { const b = bot(a[0]); await b.quests.freeSpin(); return { ...questsPanel(b.label), toast: 'spun the wheel' }; },
  claim: async (a) => { const b = bot(a[0]); const n = await b.quests.claimReady(); return { ...questsPanel(b.label), toast: n ? `claimed ${n}` : 'nothing ready' }; },

  cashout: async (a) => {
    const b = bot(a[0]);
    const keep = parseInt(a[1] || '5000', 10);
    const r = await kgoldOf(b).cashOutSurplus({ keepGold: keep });
    const p = await kgoldPanel(b.label);
    return { ...p, toast: r.listed ? `listed ${short(r.gold)}g for ${r.price} $KINDRA` : r.reason };
  },

  skills: async (a) => {
    const b = bot(a[0]);
    const rows = Object.entries(b.state.me?.skills || {}).map(([k, v]) =>
      `${SKILL_ICON[k] || '·'} ${k.padEnd(12)} Lv ${String(levelForXp(v)).padStart(2)}  ${short(v)} xp`);
    return { text: `${E.up} *Skills* — ${esc(b.state.me?.name || b.label)}\n${box(rows)}`, keyboard: KB([navRow([[`${E.acct} ${esc(b.label)}`, `acct:${b.label}`]])]) };
  },
  where: async (a) => {
    const b = bot(a[0]); const me = b.state.me;
    // A character that has not joined has no coordinates; formatting them anyway printed
    // "(undefined, undefined)".
    const at = me && Number.isFinite(me.x) ? `@ (${me.x.toFixed(1)}, ${me.z.toFixed(1)})` : '— not in the valley yet';
    return {
      text: `${E.pin} *${esc(me?.name || b.label)}* ${at}\n${activityLabel(b.orch.current)} on ${esc(b.world.name)}`,
      keyboard: KB([navRow([[`${E.acct} ${esc(b.label)}`, `acct:${b.label}`]])]),
    };
  },
  accounts: async () => fleetPanel(),
  status: async (a) => (a[0] ? acctPanel(a[0]) : homePanel()),
};


  return { ROUTES, HELP, homePanel };
}
