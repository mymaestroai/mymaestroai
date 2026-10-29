'use strict';
/**
 * ui-msg-time.js — the small date and time under each message in the chat: when the person sent it, and when the
 * agent's reply was finished, with how long it took ("Oct 29, 6:42 AM · 1m 08s"). The device's own time zone and
 * language; the year shows only for another year. The pages carry byte-identical copies between the markers below
 * (app.js, mobile.js); test/ui-msg-time.test.js proves the copies match and tests the behaviour here.
 *
 *   msgTimeLabel(t, now, locale, zone) "Oct 29, 6:41 AM" for t (ms, or an ISO string); '' when t is unreadable. zone:
 *                                     the device's own now (msgTimeZone), so a device that changes zone follows it
 *   msgTookLabel(ms)                  "8s", "1m 08s", "1h 02m"; '' when ms is not a duration
 *   msgTimeLine(end, start, …)        "Oct 29, 6:42 AM · 1m 08s"; the time alone without a readable start
 *   msgTimeLines(history, now, …)     the line under each entry of a chat's saved history (GET /api/history/<agent>),
 *                                     '' where none. A person's message and a question line: their time. A reply: the
 *                                     time it was finished and, on its last piece, how long it took since the message
 *                                     that began the turn. A reply that asked a question is saved in pieces (see
 *                                     lib/ui-turn-reply.js): each later piece has `base` = the length saved before it.
 *                                     A reply that does not follow the turn's message gets its time only.
 */
// ── message-time helpers (begin) ──
const msgTimeFormats = new Map();   // one formatter per language, zone and year style: one per message was slow
function msgTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}
function msgTimeLabel(t, now = Date.now(), locale = [], zone = msgTimeZone()) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const fmt = (key, make) => { let f = msgTimeFormats.get(key); if (!f) { f = make(); msgTimeFormats.set(key, f); } return f; };
  try {
    const yf = fmt(`year|${zone}`, () => new Intl.DateTimeFormat('en-US', { year: 'numeric', ...(zone ? { timeZone: zone } : {}) }));
    const year = yf.format(d) !== yf.format(new Date(now));   // judged in the same zone the time is shown in
    return fmt(`${locale}|${zone}|${year}`, () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(year ? { year: 'numeric' } : {}), ...(zone ? { timeZone: zone } : {}) })).format(d);
  } catch { return d.toLocaleString(); }   // an unknown language or zone
}
function msgTookLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
function msgTimeLine(end, start, now = Date.now(), locale = [], zone = msgTimeZone()) {
  const when = msgTimeLabel(end, now, locale, zone);
  const e = typeof end === 'number' ? end : Date.parse(end);
  const s = typeof start === 'number' ? start : Date.parse(start);
  const took = when && Number.isFinite(s) ? msgTookLabel(e - s) : '';
  return took ? `${when} · ${took}` : when;
}
function msgTimeLines(history, now = Date.now(), locale = [], zone = msgTimeZone()) {
  const lines = [];
  let start = NaN, last = -1, joined = 0;   // the turn's message time; its reply's newest piece, and the length so far
  for (let i = 0; i < history.length; i++) {
    const m = history[i] || {};
    const t = m.inProgress ? NaN : Date.parse(m.ts);   // the running turn's reply so far: not finished, no line
    lines.push(Number.isFinite(t) ? msgTimeLabel(t, now, locale, zone) : '');
    if (m.role === 'user' && !m.ask) { start = t; last = -1; continue; }   // the next turn
    if (m.role !== 'assistant' || m.ask || typeof m.content !== 'string') continue;
    if (last >= 0 && m.base > 0 && m.base === joined) {
      lines[last] = msgTimeLabel(Date.parse(history[last].ts), now, locale, zone);   // an earlier piece: its time only
    } else if (last >= 0 || m.base > 0) {
      start = NaN; last = -1;   // not this turn's reply
      continue;
    } else joined = 0;
    last = i; joined += m.content.length;
    if (Number.isFinite(t)) lines[i] = msgTimeLine(t, start, now, locale, zone);
  }
  return lines;
}
// ── message-time helpers (end) ──

module.exports = { msgTimeLabel, msgTookLabel, msgTimeLine, msgTimeLines };
