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
    this.status = null;   // { on, pend, paid, matured, held, minClaim, holdDays, per, canClaim, why }
    // Log it when it MOVES. Whether the fleet's 23 minted characters are actually registered
    // against our referrer is the entire question behind pinning one account to Lv 10 — the rule
    // says "you must be account Lv 10+ to refer at all", and if that is checked when the character
    // signs up rather than when the reward converts, every one of those referrals was refused at
    // birth and reaching Lv 10 now credits nothing. The server knows; nothing was asking it.
    net.on('refKindra', (m) => {
      const before = JSON.stringify(this.status || {});
      this.status = m;
      if (JSON.stringify(m || {}) !== before) {
        // Print the frame itself, not our guess at its shape. Four bugs today were a payload read
        // off the wrong key, and every one of them printed a confident '?' or 0 instead of saying
        // it did not recognise what it had been handed.
        this.log(`[ref] ${JSON.stringify(m).slice(0, 240)}${this.eligibleAsReferrer() ? '' : ` — we are account Lv ${this.accountLevel()}, referring needs ${REFERRAL.minLv}`}`);
      }
    });
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
      // The server's own field names, read from the frame rather than assumed: pend/paid/matured/
      // held, not pending/converted/claimable. Reading the wrong keys printed a confident '?' for a
      // day and hid the one number that mattered — pend was 0 the whole time.
      `pending ${s.pend ?? '?'} · matured ${s.matured ?? '?'} · held ${s.held ?? '?'} · paid ${s.paid ?? '?'} $KINDRA`,
      `each conversion pays ${REFERRAL.rewardGold}g + ${s.per ?? REFERRAL.rewardKindra} $KINDRA (newcomer gets ${REFERRAL.welcomeGold}g)`,
      `converts once the new character reaches account Lv ${REFERRAL.convertLv}; cap ${REFERRAL.dailyCap}/day`,
      s.minClaim ? `claiming needs ${s.minClaim} $KINDRA (${Math.ceil(s.minClaim / (s.per || 200))} conversions) and a ${s.holdDays ?? '?'}-day hold` : null,
      s.canClaim === false && s.why ? `cannot claim yet: ${s.why}` : null,
    ].filter((l) => l !== null).join('\n');
  }
}
