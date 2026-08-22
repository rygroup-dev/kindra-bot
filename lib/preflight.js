// preflight.js — fail with an explanation, not a stack trace.
//
// Every entry point calls this BEFORE dynamically importing anything that pulls in the rules, so a
// missing rule table reads as an instruction instead of ERR_MODULE_NOT_FOUND on a path nobody
// recognises.
import fs from 'node:fs';
import path from 'node:path';

export function ensureRules() {
  const file = path.resolve(process.cwd(), 'data', 'rules', 'shared.js');
  if (fs.existsSync(file)) return true;
  console.error(
    '\n✗ The game rule table is missing.\n' +
    '  Kindra publishes its own balance table; the bot reads it rather than guessing.\n\n' +
    '    npm run rules\n\n' +
    `  (expected at ${file})\n`
  );
  process.exit(1);
}

export function rulesAge() {
  try {
    const stamp = fs.readFileSync(path.resolve(process.cwd(), 'data', 'rules', 'FETCHED'), 'utf8').trim();
    return Date.now() - new Date(stamp).getTime();
  } catch { return null; }
}
