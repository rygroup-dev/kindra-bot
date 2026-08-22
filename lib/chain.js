// chain.js — the on-chain half: reading balances and working the $KINDRA order book.
//
// THE CASH-OUT (docs/RE-PROTOCOL.md §6). Three currencies share the name "kindra" and mixing them
// up is expensive:
//     gold   — in-game soft currency
//     kindra — the in-game ◈ gem balance
//     kgold  — the REAL ERC-20 $KINDRA on Robinhood Chain 4663
//
// SELLING costs us nothing on-chain. `kgoldList { gold, price }` escrows our in-game gold; the
// buyer's wallet sends $KINDRA straight to ours. No gas, no transaction, no approval from us. That
// makes the farm -> list -> real token loop free to operate, which is exactly what SLCW never had.
//
// BUYING is the expensive direction and needs gas + two ERC-20 transfers, fee-first (5% to the
// treasury, then 95% to the seller), then `kgoldBuy` with both hashes. Implemented for
// completeness; the bot never calls it on its own.
import { createPublicClient, createWalletClient, http, defineChain, erc20Abi, formatUnits, parseUnits } from 'viem';
import { CFG, CHAIN } from './config.js';
import { KGOLD } from './rules.js';
import { sleep } from './movement.js';

export const robinhood = defineChain({
  id: CFG.chainId,                       // 4663 == 0x1237
  name: 'Robinhood Chain',
  // ETH, not a chain-branded token — taken verbatim from the client's own ROBINHOOD_CHAIN block.
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [CFG.rpc] } },
  blockExplorers: { default: { name: 'Blockscout', url: CHAIN.explorer } },
});

export const publicClient = createPublicClient({ chain: robinhood, transport: http(CFG.rpc) });

export async function tokenBalance(address, token = CHAIN.kindraToken) {
  const [raw, decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
  ]);
  return { raw, decimals, symbol, formatted: formatUnits(raw, decimals) };
}

export async function walletOverview(address) {
  const out = { address, native: '0', kindra: '0', usdg: '0', errors: [] };
  try { out.native = formatUnits(await publicClient.getBalance({ address }), 18); }
  catch (e) { out.errors.push(`native: ${e.shortMessage || e.message}`); }
  try { out.kindra = (await tokenBalance(address, CHAIN.kindraToken)).formatted; }
  catch (e) { out.errors.push(`kindra: ${e.shortMessage || e.message}`); }
  try { out.usdg = (await tokenBalance(address, CHAIN.usdg)).formatted; }
  catch (e) { out.errors.push(`usdg: ${e.shortMessage || e.message}`); }
  return out;
}

// --- the in-game side of the book ----------------------------------------

export class KGold {
  constructor({ net, state, log = console.log }) {
    this.net = net; this.state = state; this.log = log;
    this.book = [];
    this.mine = [];
    net.on('kgold', (m) => {
      if (Array.isArray(m.listings)) this.book = m.listings;
      if (Array.isArray(m.mine)) this.mine = m.mine;
    });
    net.on('kgoldDone', (m) => this.log(`[kgold] settled: ${JSON.stringify(m).slice(0, 200)}`));
  }

  async refresh() {
    this.net.send({ t: 'kgoldBook' });
    await sleep(900);
    return this.book;
  }

  // What the book is currently paying, in $KINDRA per 1000 in-game gold. This is the number that
  // decides whether farming gold is worth anything in real terms.
  marketRate() {
    const asks = this.book
      .filter((l) => l.gold && l.price)
      .map((l) => (l.price / l.gold) * 1000)
      .sort((a, b) => a - b);
    if (!asks.length) return null;
    return { best: asks[0], median: asks[Math.floor(asks.length / 2)], listings: asks.length };
  }

  // List in-game gold for $KINDRA. Free — the escrow is server-side and the buyer pays our wallet.
  // KGOLD limits: 1,000–500,000 gold per lot, max 3 open listings, 5% fee taken from the buyer.
  async listGold(gold, price) {
    if (gold < KGOLD.MIN_GOLD) throw new Error(`minimum lot is ${KGOLD.MIN_GOLD} gold`);
    if (gold > KGOLD.MAX_GOLD) throw new Error(`maximum lot is ${KGOLD.MAX_GOLD} gold`);
    if (price < KGOLD.MIN_PRICE || price > KGOLD.MAX_PRICE) throw new Error('price out of range');
    if (this.mine.length >= KGOLD.MAX_LISTINGS) throw new Error(`already at ${KGOLD.MAX_LISTINGS} listings`);
    if ((this.state.me?.gold || 0) < gold) throw new Error('not enough gold in the satchel');
    this.net.send({ t: 'kgoldList', gold, price });
    await sleep(800);
    this.log(`[kgold] listed ${gold}g for ${price} $KINDRA (${((price / gold) * 1000).toFixed(2)} per 1k)`);
    return true;
  }

  async listItem(item, price, qty = null) {
    this.net.send(qty ? { t: 'kgoldList', item, qty, price } : { t: 'kgoldList', item, price });
    await sleep(800);
    return true;
  }

  async cancel(id) {
    this.net.send({ t: 'kgoldCancel', id });
    await sleep(600);
    return true;
  }

  // Auto cash-out: keep a working float in-game, list the surplus at (or just under) the going rate.
  // The float has to be small enough that cash-out actually happens. A flat 5,000 meant an account
  // needed 6,000 gold before it could list its first 1,000-gold lot — roughly two days at the daily
  // cap, during which nothing became token at all. Keep what the character actually needs: its next
  // planned upgrade plus a meal budget, floored at something sensible.
  workingFloat({ upgrades = null } = {}) {
    const next = upgrades?.plan?.().find((p) => !p.affordable)?.cost || 0;
    return Math.max(1500, Math.min(6000, next + 500));
  }

  async cashOutSurplus({ keepGold = null, undercutPct = 0.02, upgrades = null } = {}) {
    if (keepGold == null) keepGold = this.workingFloat({ upgrades });
    const gold = this.state.me?.gold || 0;
    const surplus = gold - keepGold;
    if (surplus < KGOLD.MIN_GOLD) return { listed: false, reason: `surplus ${surplus} below ${KGOLD.MIN_GOLD} minimum` };
    if (this.mine.length >= KGOLD.MAX_LISTINGS) return { listed: false, reason: 'listing slots full' };

    await this.refresh();
    const rate = this.marketRate();
    if (!rate) return { listed: false, reason: 'no live book to price against' };

    const lot = Math.min(surplus, KGOLD.MAX_GOLD);
    const perK = rate.best * (1 - undercutPct);          // just under the best ask so it actually clears
    const price = Math.max(KGOLD.MIN_PRICE, Math.floor((lot / 1000) * perK));
    await this.listGold(lot, price);
    return { listed: true, gold: lot, price, perK };
  }
}
