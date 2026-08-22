// net.js — headless port of the game client's own net.js.
//
// The whole game is JSON frames over one WebSocket: { t: '<verb>', ...fields }. There is no REST
// game API, no per-frame signature, no binary packing. See docs/RE-PROTOCOL.md §2.
//
// Differences from the browser original, all deliberate:
//   * a browser reconnect does `location.reload()`; we can't, so we re-run the full join (fresh
//     nonce + signature) and let the caller rebuild its world state from the new `init`.
//   * every frame is passed to a wildcard listener too, so tools/probe.js can log the raw protocol.
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { UA } from './auth.js';

// Proxies are optional: without one, a whole fleet shares the host's IP. Loaded lazily so the
// dependency is only required by people who actually route through one.
async function makeProxyAgent(url) {
  if (/^socks/i.test(url)) {
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    return new SocksProxyAgent(url);
  }
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  return new HttpsProxyAgent(url);
}

export class Net extends EventEmitter {
  constructor({ url, origin, proxy = null }) {
    super();
    this.url = url;
    this.origin = origin;
    this.proxy = proxy;   // http(s):// or socks5:// — one exit IP per account when running a fleet
    this.ws = null;
    this.queue = [];
    this.ready = false;
    this._joined = false;      // set once `init` arrives — only then is auto-reconnect eligible
    this._deliberate = false;  // a rejected join or an intentional leave => do NOT reconnect
    this._retries = 0;
    this._rcTimer = null;
    this.resumeToken = null;   // from the server's `resume` frame; lets a reconnect skip a signature
  }

  // `authFactory` is async and called on EVERY connect attempt: the login nonce expires in ~120 s,
  // so a reconnect minutes later needs a freshly signed bundle, not the original one.
  async connect({ name, appearance, authFactory, extras }) {
    this._args = { name, appearance, authFactory, extras };
    this._deliberate = false;
    await this._open();
  }

  async _open() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    const { name, appearance, authFactory, extras } = this._args;
    const auth = authFactory ? await authFactory() : null;

    const opts = { headers: { origin: this.origin, 'user-agent': UA } };
    if (this.proxy) opts.agent = await makeProxyAgent(this.proxy);
    this.ws = new WebSocket(this.url, opts);

    this.ws.on('open', () => {
      this.ready = true;
      this._retries = 0;
      const join = { t: 'join', name: name || '', appearance };
      if (auth) join.auth = auth;
      if (extras?.password) join.password = extras.password;
      if (extras?.setPassword) join.setPassword = extras.setPassword;
      if (extras?.recovery) join.recovery = extras.recovery;
      if (extras?.spectator) join.spectator = true;
      if (this.resumeToken) join.resume = this.resumeToken;
      if (extras?.turnstile) join.turnstile = extras.turnstile;
      if (extras?.ref) join.ref = extras.ref;
      this.send(join);
      for (const m of this.queue) this.ws.send(JSON.stringify(m));
      this.queue.length = 0;
      this.emit('open');
    });

    this.ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.t === 'init') this._joined = true;
      else if (msg.t === 'reject') this._deliberate = true;   // bad password / name taken — don't loop
      else if (msg.t === 'resume' && msg.token) this.resumeToken = msg.token;
      this.emit('frame', msg);        // wildcard — the protocol logger listens here
      this.emit(msg.t, msg);
    });

    this.ws.on('close', (code, reason) => {
      this.ready = false;
      if (this._deliberate || !this._joined) { this.emit('closed', { code, reason: String(reason || '') }); return; }
      this._retries++;
      this.emit('reconnecting', this._retries);
      const delay = Math.min(8000, 600 * Math.pow(1.7, this._retries - 1));   // same backoff as the client
      clearTimeout(this._rcTimer);
      this._rcTimer = setTimeout(() => { this._joined = false; this._open().catch((e) => this.emit('error', e)); }, delay);
    });

    this.ws.on('error', (err) => this.emit('wserror', err));   // 'close' follows and drives the retry
  }

  disconnect() {
    this._deliberate = true;
    clearTimeout(this._rcTimer);
    if (this.ws) this.ws.close();
  }

  send(obj) {
    if (this.ready && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    else if (obj.t !== 'move') this.queue.push(obj);   // never queue stale movement
  }

  // Await a specific frame type (or one of several). Used for request/response verbs like
  // xferQuote, kgoldQuote, bank, market — the protocol has no correlation ids, so this is
  // first-reply-wins and callers must not have two of the same request in flight.
  once(types, timeoutMs = 10000) {
    const list = Array.isArray(types) ? types : [types];
    return new Promise((resolve, reject) => {
      const done = (m) => { cleanup(); resolve(m); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for ${list.join('|')}`)); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); for (const t of list) this.off(t, done); };
      for (const t of list) this.on(t, done);
    });
  }
}
