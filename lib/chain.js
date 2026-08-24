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
    this.cancelled = new Set();          // ids we pulled ourselves — those vanish without selling
    this.sales = { lots: 0, gold: 0, kindra: 0 };
    net.on('kgold', (m) => {
      if (Array.isArray(m.listings)) this.book = m.listings;
      // A LOT THAT SOLD IS A LOT THAT DISAPPEARED. The server announces the book and our own open
      // listings; it never says "yours sold". So the only honest signal is a listing that was in
      // `mine` on the last frame and is gone from this one — minus the ones we cancelled. Without
      // this the cash-out was write-only: we could see gold leave and never learn what it fetched.
      if (Array.isArray(m.mine)) {
        const now = new Map(m.mine.filter((l) => l?.id != null).map((l) => [l.id, l]));
        for (const old of this.mine) {
          if (old?.id == null || now.has(old.id)) continue;
          if (this.cancelled.delete(old.id)) continue;
          this.sales.lots += 1;
          this.sales.gold += old.gold || 0;
          this.sales.kindra += old.price || 0;
          const per = old.gold ? ((old.price / old.gold) * 1000).toFixed(2) : '?';
          this.log(`[kgold] SOLD ${old.gold || old.item || 'a lot'}${old.gold ? 'g' : ''} for ${old.price} $KINDRA (${per} per 1k) — paid to the wallet`);
        }
        this.mine = m.mine;
      }
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
    this.cancelled.add(id);              // so the next `mine` frame does not read this as a sale
    this.net.send({ t: 'kgoldCancel', id });
    await sleep(600);
    return true;
  }

  // Auto cash-out: keep the reserve in-game, list everything above it at the going rate.
  //
  // The float used to be sized to the character's next planned upgrade (1,500-6,000). That is a
  // defensible idea and it had one fatal property: an account needed ~7,000 gold before its first
  // 1,000-gold lot could go up, so on most characters the cash-out never fired at all and the farm
  // -> token loop existed only on paper. The reserve is now a flat CFG.goldReserve (1,200 by
  // default) for every character in the fleet, new or old.
  //
  // The trade-off is real and worth knowing: a 1,200 reserve will not save up for an expensive
  // upgrade on its own. Upgrades are bought out of the working balance between cash-outs, and
  // anything costing more than about a lot and a half now needs KINDRA_GOLD_RESERVE raised, or a
  // manual /cashout keep=<n>.
  workingFloat() {
    return CFG.goldReserve;
  }

  async cashOutSurplus({ keepGold = null, undercutPct = 0.02, lotSize = null } = {}) {
    if (keepGold == null) keepGold = this.workingFloat();
    const gold = this.state.me?.gold || 0;
    const surplus = gold - keepGold;
    if (surplus < KGOLD.MIN_GOLD) return { listed: false, reason: `surplus ${surplus} below ${KGOLD.MIN_GOLD} minimum` };
    if (this.mine.length >= KGOLD.MAX_LISTINGS) return { listed: false, reason: 'listing slots full' };

    await this.refresh();
    const rate = this.marketRate();
    if (!rate) return { listed: false, reason: 'no live book to price against' };

    // One lot at a time, CFG.cashOutLot big (1,000 — the book's own minimum). Dumping the whole
    // surplus in a single listing sounds more efficient and is not: a big lot needs one buyer with
    // that much $KINDRA to hand, and while it waits the gold is escrowed and unusable. Small lots
    // at the going rate clear.
    const want = Math.max(KGOLD.MIN_GOLD, lotSize ?? CFG.cashOutLot);
    const lot = Math.min(surplus, want, KGOLD.MAX_GOLD);
    const perK = rate.best * (1 - undercutPct);          // just under the best ask so it actually clears
    const price = Math.max(KGOLD.MIN_PRICE, Math.floor((lot / 1000) * perK));
    await this.listGold(lot, price);
    return { listed: true, gold: lot, price, perK };
  }
}
