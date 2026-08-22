// rules.js — the game's own balance table.
//
// Kindra ships `shared.js` to every client, and its header says it is the "single source of truth
// for game rules … imported by the browser client AND the Node server". Rather than hard-code a
// copy that rots on the next patch — or redistribute the game's source in this repository — the bot
// downloads it into data/rules/ (git-ignored) and reads the live rules from there.
//
// The path has to be a static literal: `export * from` cannot take an expression. lib/preflight.js
// checks the file exists first and explains how to fetch it, because the raw failure here is an
// ERR_MODULE_NOT_FOUND that tells the user nothing.
//
// Refresh after a game update:  npm run rules
export * from '../data/rules/shared.js';
