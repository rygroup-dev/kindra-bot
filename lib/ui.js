// ui.js — how the Telegram panel looks.
//
// The whole bot is driven from a phone, so the panel has to read at a glance: a consistent emoji
// vocabulary (one symbol per concept, never reused for two things), aligned monospace tables where
// numbers need comparing, and prose where they don't. Buttons over typed commands — a mistyped
// account name at 2am should be impossible, not merely handled.
export const E = {
  brand: '🌿', fleet: '🍃', acct: '🌰',
  wood: '🪓', mine: '⛏️', fish: '🎣', forage: '🌱', cook: '🍳', craft: '🔨', combat: '⚔️',
  bag: '🎒', gold: '🪙', token: '🪺', gem: '💎', food: '🍖', hp: '❤️',
  quest: '📜', wheel: '🎡', star: '🌟', map: '🗺️', boss: '🐲',
  sell: '🧺', bank: '🏦', shop: '🛒', road: '🐴', garden: '🌻',
  on: '🟢', off: '⚪', busy: '🟡', dead: '🔴',
  up: '📈', cap: '🫙', clock: '⏳', pin: '🧭', log: '📓', gear: '⚙️', back: '↩️', refresh: '🔄',
};

export const SKILL_ICON = {
  woodcutting: E.wood, mining: E.mine, fishing: E.fish, foraging: E.forage,
  cooking: E.cook, crafting: E.craft, combat: E.combat,
};

// A 10-cell meter. Used for daily caps, where "how much is left" matters more than the raw number.
export function meter(cur, cap, width = 10) {
  if (!cap) return '─'.repeat(width);
  const pct = Math.max(0, Math.min(1, cur / cap));
  const on = Math.round(pct * width);
  return '▰'.repeat(on) + '▱'.repeat(width - on);
}

export function statusDot(status) {
  if (status === 'running') return E.on;
  if (status === 'online') return E.busy;
  if (['failed', 'crashed', 'rejected'].includes(status)) return E.dead;
  return E.off;
}

// 12345 -> "12.3k". Gold counts get long and the panel is narrow.
export function short(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
  if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(v));
}

export function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

// Escape the characters Telegram's legacy Markdown chokes on. Player names are user-controlled and
// a stray underscore silently swallows half the message.
export function esc(s) {
  return String(s ?? '').replace(/([_*`\[\]])/g, '\\$1');
}

export function box(lines) {
  return '```\n' + lines.join('\n') + '\n```';
}

// A friendly one-line description of what the brain is doing, instead of the raw internal key.
export function activityLabel(current) {
  if (!current) return `${E.off} idle`;
  const [act, skill] = String(current).split(':');
  const map = {
    gather: skill ? `${SKILL_ICON[skill] || E.forage} gathering ${skill}` : `${E.forage} gathering`,
    combat: `${E.combat} fighting`,
    boss: `${E.boss} raiding a boss`,
    job: `${E.road} hauling cargo on the Trade Roads`,
    garden: `${E.garden} tending the garden`,
    cook: `${E.cook} cooking`,
    craft: `${E.craft} crafting`,
    sell: `${E.sell} at the market`,
    shop: `${E.shop} shopping for gear`,
    reclaim: `${E.bag} recovering a loot sack`,
    star: `${E.star} chasing a falling star`,
    treasure: `${E.map} digging treasure`,
    idle: `${E.clock} taking a break`,
    away: `${E.off} logged off for a while`,
    stopped: `${E.off} stopped`,
  };
  return map[act] || current;
}
