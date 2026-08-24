// config.js — one place for every knob. Values come from .env, with sane defaults.
import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader (no dotenv dependency — one less thing to audit).
function loadEnv() {
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

// The two live worlds. `http` is the origin the WS host also serves /auth/nonce and /health from.
export const WORLDS = {
  valley: { id: 'valley', name: 'Kindra Valley EU', ws: 'wss://app.playkindra.com', http: 'https://app.playkindra.com' },
  us:     { id: 'us',     name: 'Kindra Valley US', ws: 'wss://us.playkindra.com',  http: 'https://us.playkindra.com'  },
};

// This bot does not do referrals, and there is no setting that turns them on.
//
// Kindra pays a referrer 500 gold + 200 on-chain $KINDRA once a character they referred reaches
// account Lv 5. It is the best-looking income a fleet has and it is a trap: the payouts are visible
// to the operator, and a cluster of accounts crediting one of their own from a single connection is
// the most legible abuse pattern in the game. This project tried it and lost twelve accounts in one
// night — the eleven that converted and the character that collected, every one banned for a year.
//
// So no `ref` is sent on any join, new character or old. If you want that reward, refer real people
// from real accounts.

export const CFG = {
  world: WORLDS[process.env.KINDRA_WORLD || 'valley'] || WORLDS.valley,
  privateKey: process.env.WALLET_PRIVATE_KEY || '',
  charName: process.env.KINDRA_NAME || '',          // blank => server names the character after the wallet
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  rpc: process.env.RH_RPC || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: 4663,
  dataDir: process.env.KINDRA_DATA || path.resolve(process.cwd(), 'data'),

  // THE GOLD RESERVE. Every character keeps this much in-game gold and lists everything above it
  // for real $KINDRA. It is one constant, read live by every bot object, so a character minted
  // tomorrow uses the same number as one minted last week — there is no per-wallet copy to migrate.
  //
  // It used to be a sliding float (1,500-6,000, sized to the next planned upgrade). That meant a
  // character had to bank ~7,000 gold before its first 1,000-gold lot could go up, which at the
  // ~11k/day ceiling is most of a day of farming sitting in-game as soft currency. 1,200 keeps a
  // meal budget and a little walking money and turns everything else into token.
  goldReserve: Math.max(0, parseInt(process.env.KINDRA_GOLD_RESERVE || '1200', 10) || 0),

  // Lot size for the auto cash-out. The book's minimum lot is 1,000 gold, so this is also the
  // smallest legal listing; raise it if gold starts piling up faster than three slots can clear.
  cashOutLot: Math.max(0, parseInt(process.env.KINDRA_CASHOUT_LOT || '1000', 10) || 0),
};

// On-chain addresses, lifted from the client's shared.js (see docs/RE-PROTOCOL.md §6).
export const CHAIN = {
  kindraToken: '0xE44951407D2ed8E73dce4b7002908732BC0d0bC3',
  usdg:        '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  treasury:    '0x31b67637E59bDc1C691dFcE71DB9B5f00362bd52',
  pool:        '0x596A9A9a9B9bD56b47b93949c3f6A823C5629200',
  permit2:     '0x000000000022d473030f116ddee9f6b43ac78ba3',
  explorer:    'https://robinhoodchain.blockscout.com',
};

export function ensureDataDir() {
  fs.mkdirSync(CFG.dataDir, { recursive: true });
  return CFG.dataDir;
}
