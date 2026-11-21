'use strict';
/**
 * ui-auto-turns.js — turns the hub starts by itself (consultations from other agents, scheduled tasks, job notices,
 * queued replies, resumes after compression) are folded in the chat into closed cards instead of looking like the
 * owner's own messages. The pages carry byte-identical copies between the markers below (app.js, mobile.js); the
 * code there is plain browser JS (declarations only) and every top-level name starts with `auto` or `AUTO_`.
 *
 *   autoKindOfOrigin(origin)   'consultation' | 'schedule' | 'notice' | null (owner, comms, no origin)
 *   autoInfoOf(entry)          null for an owner message; else { kind, from, label } for an automatic user entry
 *   autoFirstLine(text, max)   the first readable line, markdown markers stripped, cut with '…'
 *   autoGroupHistory(h, from)  items: { type:'entry', index } | { type:'card', ... } | { type:'stack', cards, summary }
 *   autoCardKind(kind)         CSS class suffix: 'consult' | 'schedule' | 'notice'
 *   autoSummaryOf(cards)       "4 automatic turns: 3 consultations, 1 scheduled task"
 */
// ── auto-turn helpers (begin) ──
const AUTO_STACK_MIN = 3;   // this many closed cards in a row fold into one stack
function autoKindOfOrigin(origin) {
  const k = origin && typeof origin === 'object' ? origin.kind : '';
  if (!k || typeof k !== 'string') return null;
  if (k === 'consultation') return 'consultation';
  if (k === 'schedule') return 'schedule';
  if (k === 'user' || k === 'comms') return null;
  return 'notice';
}
function autoQuoted(s) {
  const m = /"([^"\n]*)"/.exec(s || '');
  return m ? m[1] : null;
}
function autoInfoOf(entry) {
  if (!entry || entry.role !== 'user' || entry.ask === true || entry.interjection) return null;
  const o = entry.origin;
  if (o && typeof o === 'object' && o.kind) {
    const kind = autoKindOfOrigin(o);
    if (!kind) return null;
    const from = o.from || o.jobName || null;
    let label;
    if (kind === 'consultation') label = `Consultation from ${from || 'another agent'}`;
    else if (kind === 'schedule') label = `Scheduled task${o.from ? ': ' + o.from : ''}`;
    else if (o.kind === 'job_notice') label = `Job finished${from ? ': ' + from : ''}`;
    else if (o.kind === 'job_report') label = `Job report${o.jobName ? ': ' + o.jobName : ''}`;
    else if (o.kind === 'task') label = o.label === 'context compression' ? 'Resumed after compression' : `Hub task${o.label ? ': ' + o.label : ''}`;
    else if (o.kind === 'consult_reply') label = 'Consultation replies delivered';
    else if (o.kind === 'alert') label = 'Monitor alert';
    else label = 'Hub turn';
    return { kind, from, label };
  }
  const text = typeof entry.content === 'string' ? entry.content.trimStart() : '';
  let m = /^\[Consultation from agent "([^"\n]*)"/.exec(text);
  if (m) return { kind: 'consultation', from: m[1], label: `Consultation from ${m[1] || 'another agent'}` };
  if (entry.tiger_team === true) return { kind: 'consultation', from: null, label: 'Consultation from another agent' };
  if (text.startsWith('[Scheduled task — started by the hub scheduler')) {
    const close = text.indexOf(']');
    const from = close >= 0 ? (/^\s*"([^"\n]*)"/.exec(text.slice(close + 1)) || [])[1] ?? null : null;
    return { kind: 'schedule', from, label: `Scheduled task${from ? ': ' + from : ''}` };
  }
  if (text.startsWith('[Job finished]') || text.startsWith('[Job ended]')) {
    const finished = text.startsWith('[Job finished]');
    const jm = /\bJob\s+"([^"\n]*)"/.exec(text);
    const name = jm ? jm[1] : null;
    return { kind: 'notice', from: name, label: `${finished ? 'Job finished' : 'Job ended'}${name ? ': ' + name : ''}` };
  }
  if (text.startsWith('[Resumed after compression, from the hub]')) return { kind: 'notice', from: null, label: 'Resumed after compression' };
  if (text.startsWith('[Delivery turn started by the hub')) return { kind: 'notice', from: null, label: 'Consultation replies delivered' };
  m = /^\[Queued consultation reply from agent "([^"\n]*)"/.exec(text);
  if (m) return { kind: 'notice', from: m[1], label: 'Consultation replies delivered' };
  return null;
}
function autoFirstLine(text, max = 140) {
  if (typeof text !== 'string') return '';
  for (const raw of text.split(/\r?\n/)) {
    let s = raw.trim().replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+)+/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (!s || /^[-*_=\s]*$/.test(s)) continue;
    return s.length > max ? s.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : s;
  }
  return '';
}
function autoCardKind(kind) {
  return kind === 'consultation' ? 'consult' : kind === 'schedule' ? 'schedule' : 'notice';
}
function autoSummaryOf(cards) {
  const n = (cards || []).length;
  const count = (k) => cards.filter((c) => c.kind === k).length;
  const parts = [];
  const c = count('consultation'), s = count('schedule'), h = n - c - s;
  if (c) parts.push(`${c} ${c === 1 ? 'consultation' : 'consultations'}`);
  if (s) parts.push(`${s} ${s === 1 ? 'scheduled task' : 'scheduled tasks'}`);
  if (h) parts.push(`${h} ${h === 1 ? 'hub notice' : 'hub notices'}`);
  return `${n} automatic ${n === 1 ? 'turn' : 'turns'}: ${parts.join(', ')}`;
}
function autoCardLine(history, indexes, kindsInfoLabel) {
  const isAsst = (i) => history[i].role === 'assistant';
  const asst = indexes.filter(isAsst);
  const pick = [...asst].reverse().find((i) => !history[i].for_owner);   // a reply shown open below the card is not repeated in it
  if (pick !== undefined) return autoFirstLine(history[pick].content);
  for (const i of [...indexes].reverse()) {
    if (isAsst(i)) continue;
    let c = typeof history[i].content === 'string' ? history[i].content : '';
    const task = c.indexOf('\nTask:\n');
    c = task >= 0 ? c.slice(task + 7) : c.trimStart().replace(/^\[[^\]]*\]:?/, '');
    const line = autoFirstLine(c);
    if (line) return line;
  }
  return kindsInfoLabel || '';
}
function autoGroupHistory(history, from = 0, { stackMin = AUTO_STACK_MIN } = {}) {
  const items = [];
  const n = Array.isArray(history) ? history.length : 0;
  let i = Math.max(0, from | 0);
  while (i < n) {
    const e = history[i];
    if (!e || e.inProgress) { i++; continue; }
    const info = autoInfoOf(e);
    if (!info) { items.push({ type: 'entry', index: i }); i++; continue; }
    let last = info, firstTs = e.ts, hasAsst = false;
    const indexes = [i];
    let j = i + 1;
    for (; j < n; j++) {
      const x = history[j];
      if (!x) break;
      if (x.inProgress) continue;
      if (x.ask === true || x.interjection) break;
      if (x.role === 'assistant') { hasAsst = true; indexes.push(j); continue; }
      if (x.role !== 'user' || hasAsst) break;
      const xi = autoInfoOf(x);
      if (!xi) break;
      last = xi; indexes.push(j);
    }
    const open = indexes.filter((k) => history[k].role === 'assistant' && history[k].for_owner === true);
    items.push({ type: 'card', kind: last.kind, from: last.from, label: last.label, ts: firstTs, indexes, open, firstLine: autoCardLine(history, indexes, last.label) });
    i = j;
  }
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= stackMin && run.length > 0) out.push({ type: 'stack', cards: run, summary: autoSummaryOf(run) });
    else out.push(...run);
    run = [];
  };
  for (const it of items) {
    if (it.type === 'card' && it.open.length === 0) run.push(it);
    else { flush(); out.push(it); }
  }
  flush();
  return out;
}
// ── auto-turn helpers (end) ──

if (typeof module !== 'undefined' && module.exports) module.exports = { AUTO_STACK_MIN, autoKindOfOrigin, autoInfoOf, autoFirstLine, autoGroupHistory, autoCardKind, autoSummaryOf };
