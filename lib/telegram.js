// telegram.js — a dependency-free Bot API client (long polling).
//
// No telegraf, no node-telegram-bot-api. The surface we need is four endpoints, and every
// dependency in a bot that holds private keys is a dependency worth not having.
const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

export class Telegram {
  constructor({ token, chatId = '', onLog = console.log }) {
    this.token = token;
    this.chatId = chatId;
    this.offset = 0;
    this.handlers = new Map();   // '/cmd' -> async (args, msg) => string | {text, keyboard}
    this.callbacks = new Map();  // 'cb:name' -> async (args, q) => string | {text, keyboard}
    this.running = false;
    this.log = onLog;
  }

  on(cmd, fn) { this.handlers.set(cmd, fn); return this; }
  onCallback(name, fn) { this.callbacks.set(name, fn); return this; }

  // Rows of [label, callbackData] pairs -> Telegram's inline_keyboard shape.
  static kb(rows) {
    return { inline_keyboard: rows.map((row) => row.map(([text, data]) => (
      /^https?:/.test(data) ? { text, url: data } : { text, callback_data: data.slice(0, 64) }
    ))) };
  }

  async call(method, body) {
    const res = await fetch(API(this.token, method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({ ok: false }));
    if (!j.ok && j.description) this.log(`[tg] ${method} failed: ${j.description}`);
    return j;
  }

  // Telegram caps a message at 4096 chars; long reports get split rather than silently truncated.
  async send(text, chatId = this.chatId, opts = {}) {
    if (!chatId) return;
    if (text && typeof text === 'object' && text.text) { opts = { ...opts, reply_markup: text.keyboard }; text = text.text; }
    const chunks = [];
    let t = String(text);
    while (t.length > 3900) {
      let cut = t.lastIndexOf('\n', 3900);
      if (cut < 2000) cut = 3900;
      chunks.push(t.slice(0, cut)); t = t.slice(cut);
    }
    chunks.push(t);
    for (const c of chunks) {
      await this.call('sendMessage', { chat_id: chatId, text: c, parse_mode: 'Markdown', disable_web_page_preview: true, ...opts });
    }
  }

  // Registers the ☰ command menu Telegram shows next to the text box. Without this the user has
  // to know and type /start before anything appears, which is exactly the wrong first impression.
  async setCommands(list) {
    const r = await this.call('setMyCommands', {
      commands: list.map(([command, description]) => ({ command, description: description.slice(0, 256) })),
    });
    // Also make the menu button open that list rather than the default "no commands" state.
    await this.call('setChatMenuButton', { menu_button: { type: 'commands' } });
    this.log(r.ok ? `[tg] command menu registered (${list.length})` : `[tg] setMyCommands failed: ${r.description}`);
    return r.ok;
  }

  async start() {
    this.running = true;
    const me = await this.call('getMe', {});
    if (me.ok) this.log(`[tg] connected as @${me.result.username}`);
    else { this.log('[tg] getMe failed — check TELEGRAM_BOT_TOKEN'); return; }

    while (this.running) {
      try {
        const res = await this.call('getUpdates', { offset: this.offset, timeout: 30 });
        for (const u of res.result || []) {
          this.offset = u.update_id + 1;
          if (u.callback_query) {
            this.dispatchCallback(u.callback_query).catch((e) => this.log(`[tg] callback: ${e.message}`));
            continue;
          }
          const msg = u.message || u.edited_message;
          if (!msg?.text) continue;
          // First chat to talk to the bot owns it, mirroring the Kintara installer's flow.
          if (!this.chatId) { this.chatId = String(msg.chat.id); this.log(`[tg] bound to chat ${this.chatId}`); }
          if (String(msg.chat.id) !== String(this.chatId)) continue;
          // Fire and forget. A handler like /sell walks the character to the market and takes tens
          // of seconds; awaiting it here froze polling — and therefore every other button — for the
          // whole trip. Errors are reported inside dispatch().
          this.dispatch(msg).catch((e) => this.log(`[tg] dispatch: ${e.message}`));
        }
      } catch (e) {
        this.log(`[tg] poll error: ${e.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async dispatch(msg) {
    const text = msg.text.trim();
    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.split('@')[0].toLowerCase();
    const fn = this.handlers.get(cmd);
    if (!fn) { if (cmd.startsWith('/')) await this.send(`Unknown command \`${cmd}\` — try /help`); return; }
    try {
      const out = await fn(args, msg);
      if (out) await this.send(out);
    } catch (e) {
      await this.send(`⚠️ \`${cmd}\` failed: ${e.message}`);
      this.log(`[tg] ${cmd} error: ${e.stack || e.message}`);
    }
  }

  // Button presses. The message is edited in place rather than spamming a new one each tap, which
  // is what makes a Telegram panel feel like an app instead of a chat log.
  async dispatchCallback(q) {
    const chatId = String(q.message?.chat?.id || '');
    if (this.chatId && chatId !== String(this.chatId)) { await this.call('answerCallbackQuery', { callback_query_id: q.id }); return; }
    const [name, ...args] = String(q.data || '').split(':');
    const fn = this.callbacks.get(name);
    if (!fn) { await this.call('answerCallbackQuery', { callback_query_id: q.id, text: 'That button expired.' }); return; }
    // Clear Telegram's loading spinner straight away. Slow actions (selling, funding gas) otherwise
    // leave the button spinning for half a minute and look broken.
    const slow = ['sell', 'run', 'runall', 'cashout', 'fundgas', 'sweep', 'tend', 'cook', 'food', 'spin', 'buyup', 'claimref', 'shifts'].includes(name);
    if (slow) this.call('answerCallbackQuery', { callback_query_id: q.id, text: 'Working…' }).catch(() => {});
    let notice = '';
    try {
      const out = await fn(args, q);
      if (out) {
        const text = typeof out === 'string' ? out : out.text;
        const keyboard = typeof out === 'string' ? undefined : out.keyboard;
        notice = typeof out === 'object' && out.toast ? out.toast : '';
        await this.edit(text, q.message.chat.id, q.message.message_id, keyboard);
      }
    } catch (e) {
      notice = `⚠️ ${e.message}`.slice(0, 190);
      this.log(`[tg] callback ${name} error: ${e.stack || e.message}`);
    }
    if (!slow) await this.call('answerCallbackQuery', { callback_query_id: q.id, text: notice || undefined });
    else if (notice) await this.send(notice);   // the spinner is already cleared; report as a message
  }

  async edit(text, chatId, messageId, keyboard) {
    const body = { chat_id: chatId, message_id: messageId, text: String(text).slice(0, 4000), parse_mode: 'Markdown', disable_web_page_preview: true };
    if (keyboard) body.reply_markup = keyboard;
    const r = await this.call('editMessageText', body);
    // "message is not modified" is not an error worth surfacing — it just means nothing changed.
    if (!r.ok && !/not modified/i.test(r.description || '')) this.log(`[tg] edit failed: ${r.description}`);
    return r;
  }

  stop() { this.running = false; }
}
