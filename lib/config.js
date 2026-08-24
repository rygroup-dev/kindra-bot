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

// Referral attribution is OFF by default, and there is no built-in referrer.
//
// Kindra pays a referrer 500 gold + 200 on-chain $KINDRA for every character that joins through
// them and reaches account Lv 5. Farming that with your own characters does not work: the payouts
// are visible to the operator, and a fleet that refers itself from one IP is the easiest possible
// pattern to spot. It cost this project twelve accounts — the eleven that converted and the
// referrer that collected — all banned for a year, within hours of the first payout.
//
// So nothing here names a referrer, nothing is stamped on a new character, and no character is
// pushed towards the Lv-10 referring gate on its own. If you have a genuinely separate account on
// a different connection and want to credit it, name it explicitly:
//
//   KINDRA_REFERRER=<character name>   in .env
//
// Anything else leaves this empty, which sends no `ref` at all.
export const DEFAULT_REFERRER = process.env.KINDRA_REFERRER || '';

export const CFG = {
  world: WORLDS[process.env.KINDRA_WORLD || 'valley'] || WORLDS.valley,
  privateKey: process.env.WALLET_PRIVATE_KEY || '',
  charName: process.env.KINDRA_NAME || '',          // blank => server names the character after the wallet
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  rpc: process.env.RH_RPC || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: 4663,
  dataDir: process.env.KINDRA_DATA || path.resolve(process.cwd(), 'data'),
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
