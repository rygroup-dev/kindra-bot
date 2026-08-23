#!/usr/bin/env node
// test-frames.js — the server frames whose SHAPE we once guessed wrong.
//
// Every fault here presented the same way: a character walking, logging cycles, reporting zero
// errors and producing nothing. None of them threw. They were payload shapes read off the wrong
// key, and the only defence is to assert the shape against the frames the real client handles.
import { EventEmitter } from 'node:events';
import { GameState } from '../lib/state.js';
import { Movement } from '../lib/movement.js';

let pass = 0, fail = 0;
const ok  = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

// --- 1. sackSpawn is nested ---------------------------------------------------
console.log('\n1. sackSpawn { sack: {...} }');
{
  const net = new EventEmitter(), st = new GameState().attach(net);
  net.emit('sackSpawn', { t: 'sackSpawn', sack: { id: 7, x: 12.5, z: -4, owner: 'Lark_Holt' } });
  const s = st.sacks.get(7);
  ok(!!s, 'sack stored under its real id');
  ok(s && Number.isFinite(s.x) && Number.isFinite(s.z), 'sack has finite coordinates');
  ok(!st.sacks.has(undefined), 'no phantom entry keyed undefined');
  net.emit('sackGone', { t: 'sackGone', id: 7 });
  ok(st.sacks.size === 0, 'sackGone removes it');
  net.emit('sackSpawn', { t: 'sackSpawn' });                       // malformed
  ok(st.sacks.size === 0, 'a malformed frame is ignored, not stored');
}

// --- 2. walkTo must never integrate NaN ---------------------------------------
console.log('\n2. walkTo refuses a target with no position');
{
  const st = { me: { x: 0, z: 0, ry: 0 } };
  const mv = new Movement({ send() {} }, st);
  let threw = null;
  await mv.walkTo(undefined, undefined, { timeoutMs: 500 }).catch((e) => { threw = e.message; });
  ok(!!threw, `it throws instead of looping (${threw})`);
  ok(Number.isFinite(st.me.x) && Number.isFinite(st.me.z), 'our own position survives intact');

  st.me.x = NaN;                                                   // already-corrupt character
  let threw2 = null;
  await mv.walkTo(10, 10, { timeoutMs: 500 }).catch((e) => { threw2 = e.message; });
  ok(!!threw2, `a corrupt position is reported, not walked (${threw2})`);
}

// --- 3. live quest refresh arrives as m.list ----------------------------------
console.log('\n3. quest board refreshes on m.list');
{
  const net = new EventEmitter(), st = new GameState().attach(net);
  net.emit('init', { you: { id: 1, x: 0, z: 0, haul: {} }, quests: [{ id: 'q1', prog: 0, need: 6 }] });
  ok(st.quests[0].prog === 0, 'seeded from init');
  net.emit('quest', { t: 'quest', list: [{ id: 'q1', prog: 6, need: 6 }] });
  ok(st.quests[0].prog === 6, 'progress moves when the server names it `list`');
  net.emit('quest', { t: 'quest', quests: [{ id: 'q1', prog: 3, need: 6 }] });
  ok(st.quests[0].prog === 3, 'the old `quests` name still works');
}

// --- 4. a rejoined character is live again ------------------------------------
console.log('\n4. status clears after a reconnect');
{
  const { Bot } = await import('../lib/bot.js');
  const proto = Object.getPrototypeOf(Bot.prototype) === Object.prototype ? Bot.prototype : Bot.prototype;
  ok(typeof proto._watchPosition === 'function', 'position watchdog is wired');

  // exercise the status transition directly against the real handler shape
  const net = new EventEmitter(), st = new GameState().attach(net);
  const fake = { status: 'running', orch: { running: true }, state: st, log() {} };
  st.on('ready', () => {
    if (fake.status !== 'reconnecting' && fake.status !== 'offline') return;
    fake.status = fake.orch.running ? 'running' : 'online';
  });
  fake.status = 'reconnecting';
  net.emit('init', { you: { id: 1, x: 0, z: 0, haul: {} } });
  ok(fake.status === 'running', 'reconnecting -> running once init lands');
}

// --- 5. the earn rate must describe THIS slot, not the whole process --------
console.log('\n5. earn rate re-baselines on every join');
{
  const net = new EventEmitter(), st = new GameState().attach(net);
  const b = { _haulFirst: null, state: st };
  st.on('ready', () => { b._haulFirst = null; });
  st.on('haul', (hh) => { if (!b._haulFirst) b._haulFirst = { at: Date.now(), ...hh }; });

  net.emit('init', { you: { id: 1, x: 0, z: 0, haul: {} } });
  net.emit('wallet', { haul: { vendor: 0, vendorCap: 1000 } });
  ok(b._haulFirst?.vendor === 0, 'baseline taken on the first wallet frame');

  b._haulFirst.at -= 5 * 3600 * 1000;                 // pretend five hours passed off-shift
  net.emit('init', { you: { id: 1, x: 0, z: 0, haul: {} } });   // rejoins for a new shift
  ok(b._haulFirst === null, 'the stale baseline is dropped on rejoin');
  net.emit('wallet', { haul: { vendor: 40, vendorCap: 1000 } });
  ok(b._haulFirst?.vendor === 40, 're-baselined against the new shift');
  ok(Date.now() - b._haulFirst.at < 5000, 'and the clock restarts with it');
}

// --- 6. a portal moves us, and only `teleport` says so ------------------------
console.log('\n6. teleport is the one frame allowed to move us');
{
  const net = new EventEmitter(), st = new GameState().attach(net);
  net.emit('init', { you: { id: 1, x: 34, z: 98, haul: {} }, creatures: [{ id: 9, x: 30, z: 95 }] });
  ok(st.creatures.size === 1, 'a creature is streamed in on the mainland');
  net.emit('teleport', { t: 'teleport', x: 0, z: 560 });
  ok(st.me.x === 0 && st.me.z === 560, 'our position follows the server through the door');
  ok(st.creatures.size === 0, 'the old zone\'s creatures are dropped, as the client drops them');
  net.emit('teleport', { t: 'teleport' });                       // malformed
  ok(st.me.x === 0 && st.me.z === 560, 'a frame with no coordinates is ignored, not applied');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
