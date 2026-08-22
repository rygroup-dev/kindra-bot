// referral.js — the fleet's highest-value untapped mechanic.
//
//   REFERRAL = { rewardGold: 500, rewardKindra: 200, welcomeGold: 250,
//                minLv: 10, convertLv: 5, dailyCap: 10 }
//
// Every character that joins through a referrer and reaches account Lv 5 pays that referrer 500
// gold AND **200 real on-chain $KINDRA**, and hands the newcomer 250 gold to start with. Ten
// referrals is 5,000 gold and 2,000 $KINDRA — more token than farming produces in a long while.
//
// A fleet creates new characters as a matter of course, so the only thing missing was passing
// `ref` on the join. The server attributes it once, on first touch, and never to yourself; the
// referrer must be account Lv 10 and the newcomer must reach Lv 5 for it to convert.
//
// Claiming pays out to the LINKED WALLET — the destination is server-side, never something the
// client chooses.
import { REFERRAL, accountXpOf, xpForAccountLevel, accountLevel } from './rules.js';
import { sleep } from './movement.js';

export class Referral {
  constructor({ net, state, log = console.log }) {
    this.net = net; this.state = state; this.log = log;
    this.status = null;   // { pending, converted, claimable, … } as the server reports it
    net.on('refKindra', (m) => { this.status = m; });
    net.on('refs', (m) => { this.refs = m; });
  }

  // Account level, which is what the referral gate actually reads — not a skill level.
  accountLevel() { return this.state.me?.tl || 1; }
  eligibleAsReferrer() { return this.accountLevel() >= REFERRAL.minLv; }

  async refresh() {
    this.net.send({ t: 'refKindra' });
    await sleep(900);
    return this.status;
  }

  // Claim converted referral rewards into the linked wallet.
  async claim() {
    await this.refresh();
    this.net.send({ t: 'refKindraClaim' });
    await sleep(1200);
    await this.refresh();
    this.log(`[referral] claim sent — ${JSON.stringify(this.status || {}).slice(0, 200)}`);
    return this.status;
  }

  // Progress toward the Lv-10 referring gate. Worth surfacing because the route there is not
  // obvious: ACCOUNT_XP_WEIGHT scores combat at 1.0 and every other skill at 0.25, so a character
  // that only gathers takes roughly four times as long to qualify as one that fights.
  progress() {
    const skills = this.state.me?.skills || {};
    const have = accountXpOf(skills);
    const need = xpForAccountLevel(REFERRAL.minLv);
    return { have, need, level: accountLevel(have), pct: Math.min(100, (have / need) * 100) };
  }

  report() {
    const s = this.status || {};
    const lvl = this.accountLevel();
    const p = this.progress();
    return [
      `progress to referring: ${p.have.toLocaleString()} / ${p.need.toLocaleString()} (${p.pct.toFixed(1)}%)`,
      `combat xp counts 1.0x toward this; every other skill only 0.25x`,
      `account Lv ${lvl}${lvl < REFERRAL.minLv ? ` — referring unlocks at Lv ${REFERRAL.minLv}` : ' — eligible'}`,
      `pending ${s.pending ?? '?'} · converted ${s.converted ?? '?'} · claimable ${s.claimable ?? s.kindra ?? '?'} $KINDRA`,
      `each conversion pays ${REFERRAL.rewardGold}g + ${REFERRAL.rewardKindra} $KINDRA (newcomer gets ${REFERRAL.welcomeGold}g)`,
      `converts once the new character reaches account Lv ${REFERRAL.convertLv}; cap ${REFERRAL.dailyCap}/day`,
    ].join('\n');
  }
}
