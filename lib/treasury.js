// treasury.js — moving value between the fleet's wallets.
//
// A fleet of eleven wallets is eleven places for value to get stranded. Three operations keep it
// tidy, and all three are deliberately explicit — nothing here runs on a timer or by itself:
//
//   PRIMARY — one wallet is the fleet's treasury. Earnings sweep to it; gas flows out of it.
//   FUND    — top up every character that is below the gas floor, from the primary.
//   SWEEP   — pull $KINDRA (and optionally leftover ETH) from the sub-accounts back to the primary.
//
// Gas note: playing needs NO gas at all. Sign-in is a signature and selling gold on the $KINDRA book
// is escrowed server-side, so a character can farm and cash out for its whole life on a zero
// balance. Gas is only needed to BUY on the book or to move tokens — so `fund` is a tool you reach
// for deliberately, not a routine the bot runs.
import { createWalletClient, http, erc20Abi, parseEther, formatEther, formatUnits, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { robinhood, publicClient, walletOverview } from './chain.js';
import { CFG, CHAIN } from './config.js';
import { Fleet } from './fleet.js';

// Enough for a couple of ERC-20 transfers on a cheap L2; deliberately small.
export const GAS_FLOOR = parseEther(process.env.KINDRA_GAS_FLOOR || '0.0004');
export const GAS_TOPUP = parseEther(process.env.KINDRA_GAS_TOPUP || '0.001');

function clientFor(privateKey) {
  const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  const account = privateKeyToAccount(pk);
  return { account, wallet: createWalletClient({ account, chain: robinhood, transport: http(CFG.rpc) }) };
}

export class Treasury {
  constructor({ log = console.log } = {}) {
    this.log = log;
  }

  book() { return Fleet.loadWallets(); }

  // The primary is a flag in wallets.json, so it survives restarts. First entry by default.
  primary() {
    const b = this.book();
    return b.find((w) => w.primary) || b[0] || null;
  }

  setPrimary(label) {
    const b = this.book();
    const target = b.find((w) => w.label === label);
    if (!target) throw new Error(`no account "${label}"`);
    for (const w of b) delete w.primary;
    target.primary = true;
    Fleet.saveWallets(b);
    this.log(`[treasury] primary wallet is now ${label} (${target.address})`);
    return target;
  }

  async balances() {
    const out = [];
    for (const w of this.book()) {
      const o = await walletOverview(w.address);
      out.push({ ...w, ...o, isPrimary: !!w.primary || (out.length === 0 && !this.book().some((x) => x.primary)) });
    }
    return out;
  }

  // --- gas ---------------------------------------------------------------
  async needsGas() {
    const out = [];
    for (const w of this.book()) {
      const bal = await publicClient.getBalance({ address: w.address });
      if (bal < GAS_FLOOR) out.push({ ...w, balance: bal });
    }
    return out;
  }

  // Top up every sub-account below the floor, out of the primary. Returns the transaction hashes.
  async fundGas({ amount = GAS_TOPUP, only = null } = {}) {
    const primary = this.primary();
    if (!primary) throw new Error('no wallets');
    const { account, wallet } = clientFor(primary.privateKey);

    let targets = (await this.needsGas()).filter((w) => w.address.toLowerCase() !== primary.address.toLowerCase());
    if (only) targets = targets.filter((w) => only.includes(w.label));
    if (!targets.length) return { funded: [], reason: 'every wallet is already above the gas floor' };

    const balance = await publicClient.getBalance({ address: account.address });
    const need = amount * BigInt(targets.length);
    if (balance < need + parseEther('0.0002')) {
      throw new Error(`primary holds ${formatEther(balance)} ETH but needs ~${formatEther(need)} to fund ${targets.length} wallet(s)`);
    }

    const sent = [];
    for (const t of targets) {
      const hash = await wallet.sendTransaction({ to: t.address, value: amount });
      sent.push({ label: t.label, address: t.address, hash });
      this.log(`[treasury] funded ${t.label} with ${formatEther(amount)} ETH — ${hash}`);
      await publicClient.waitForTransactionReceipt({ hash, timeout: 90000 }).catch(() => {});
    }
    return { funded: sent };
  }

  // --- sweep -------------------------------------------------------------
  // Pull earnings home. $KINDRA is the point; native ETH is optional because sweeping it leaves the
  // sub-account unable to transact at all, which is usually not what you want.
  async sweep({ token = CHAIN.kindraToken, includeNative = false, only = null } = {}) {
    const primary = this.primary();
    if (!primary) throw new Error('no wallets');
    let subs = this.book().filter((w) => w.address.toLowerCase() !== primary.address.toLowerCase());
    if (only) subs = subs.filter((w) => only.includes(w.label));

    const moved = [];
    const skipped = [];

    for (const w of subs) {
      const { account, wallet } = clientFor(w.privateKey);
      let bal = 0n;
      try {
        bal = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [w.address] });
      } catch (e) { skipped.push({ label: w.label, why: `balance read failed: ${e.shortMessage || e.message}` }); continue; }
      if (bal === 0n) { skipped.push({ label: w.label, why: 'nothing to sweep' }); continue; }

      // A token transfer costs gas, and a sub-account that has never bought anything has none.
      const gas = await publicClient.getBalance({ address: w.address });
      if (gas < GAS_FLOOR) { skipped.push({ label: w.label, why: `no gas (${formatEther(gas)} ETH) — fund it first` }); continue; }

      try {
        const hash = await wallet.writeContract({
          address: token, abi: erc20Abi, functionName: 'transfer', args: [primary.address, bal],
        });
        moved.push({ label: w.label, amount: formatUnits(bal, 18), hash });
        this.log(`[treasury] swept ${formatUnits(bal, 18)} from ${w.label} — ${hash}`);
        await publicClient.waitForTransactionReceipt({ hash, timeout: 90000 }).catch(() => {});
      } catch (e) { skipped.push({ label: w.label, why: e.shortMessage || e.message }); continue; }

      if (includeNative) {
        // Leave a margin for the transfer itself; sending the exact balance always reverts.
        const left = await publicClient.getBalance({ address: w.address });
        const keep = parseEther('0.0002');
        if (left > keep * 2n) {
          try {
            const hash = await wallet.sendTransaction({ to: primary.address, value: left - keep });
            moved.push({ label: w.label, amount: `${formatEther(left - keep)} ETH`, hash });
          } catch (e) { skipped.push({ label: w.label, why: `native sweep: ${e.shortMessage || e.message}` }); }
        }
      }
    }
    return { moved, skipped, to: primary };
  }
}
