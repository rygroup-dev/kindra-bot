#!/usr/bin/env node
// run.js — start the fleet headlessly, no Telegram. `node tools/run.js [minutes]`
import { ensureRules } from '../lib/preflight.js';
ensureRules();   // see tools/telegram-bot.js: the rule table must be checked before it is imported
const { Fleet } = await import('../lib/fleet.js');

const MINUTES = Number(process.argv[2] || 0);
const fleet = new Fleet();
fleet.load();
await fleet.startAll();

const tick = setInterval(() => console.log('\n' + fleet.summary().replace(/```/g, '')), 60000);

if (MINUTES > 0) {
  setTimeout(() => {
    clearInterval(tick);
    console.log('\n=== FINAL ===\n' + fleet.summary().replace(/```/g, ''));
    for (const b of fleet.bots.values()) console.log('\n' + b.report());
    fleet.disconnectAll();
    process.exit(0);
  }, MINUTES * 60000);
}
process.on('SIGINT', () => { fleet.disconnectAll(); process.exit(0); });
