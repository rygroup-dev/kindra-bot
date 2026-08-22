#!/usr/bin/env node
// fetch-rules.js — pull the game's own rule table into data/rules/.
//
// Kindra's client is served unbundled, and `shared.js` carries this header:
//
//     "single source of truth for game rules. Imported by the browser client AND the Node server"
//
// So instead of hard-coding a balance table that goes stale on the next patch — or vendoring the
// game's source into this repository, which is not ours to redistribute — the bot fetches it at
// install time and reads the live rules. Re-run this after any game update.
import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = process.env.KINDRA_ORIGIN || 'https://app.playkindra.com';
const OUT = path.resolve(process.cwd(), 'data', 'rules');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Follow the import graph rather than guessing: shared.js pulls in the kart maths, which pulls in
// the track data, and that set changes between patches.
const SEEDS = ['shared.js'];

async function get(name) {
  const res = await fetch(`${ORIGIN}/src/${name}`, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.text();
}

// `--if-missing` makes this a no-op when the rules are already present, so it can sit in
// `prestart` without hitting the game's server on every restart.
if (process.argv.includes('--if-missing') && fs.existsSync(path.join(OUT, 'shared.js'))) {
  console.log('✓ game rules already present');
  process.exit(0);
}

const seen = new Set();
const queue = [...SEEDS];
fs.mkdirSync(OUT, { recursive: true });

let bytes = 0;
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);

  const body = await get(name);
  fs.writeFileSync(path.join(OUT, name), body);
  bytes += body.length;
  process.stdout.write(`  ${name} (${(body.length / 1024).toFixed(0)} kB)\n`);

  for (const m of body.matchAll(/from\s+'\.\/([A-Za-z0-9_.-]+\.js)'/g)) {
    if (!seen.has(m[1])) queue.push(m[1]);
  }
}

fs.writeFileSync(path.join(OUT, 'FETCHED'), new Date().toISOString() + '\n');
console.log(`✓ ${seen.size} rule file(s), ${(bytes / 1024).toFixed(0)} kB total -> data/rules/`);
