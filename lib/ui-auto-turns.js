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
// Build Team, Set up teams and Optimize team: the person pressed it, so the turn's replies show open under its card (never folded away).
function autoOwnOrigin(origin) {
  const k = origin && typeof origin === 'object' ? origin.kind : '';
  return k === 'build_team' || k === 'team_setup' || k === 'optimize_team';
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
    // on screen a hand-off reads "task" (the owner's wording); the hub's own label starts "Hand-off from X: " or "Hand-off done: "
    else if (o.kind === 'hand_off') label = o.label ? o.label.replace(/^Hand-off\b/, 'Task') : `Task from ${from || 'another agent'}`;
    else if (o.kind === 'hand_off_report') label = o.label ? o.label.replace(/^Hand-off\b/, 'Task') : 'Task finished';
    else if (o.kind === 'alert') label = 'Monitor alert';
    else if (o.kind === 'research_report') label = o.what === 'stopped' ? 'Research stopped' : o.what === 'thorough' ? 'Research made thorough' : 'Research finished';
    else label = 'Hub turn';
    // A research report says what it is once: the row reads "Research finished", the time, then the question in quotes (never the label again),
    // and no "from …" line follows the reply.
    if (o.kind === 'research_report') {
      const q = typeof o.label === 'string' ? o.label.replace(/\s+/g, ' ').trim() : '';
      return { kind, from, label, noFrom: true, note: q ? '“' + q + '”' : '' };
    }
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
// The run line's word for a hub-started prompt: consultation | task | schedule | job | update (from its origin kind, else its marker text).
function autoWorkOf(entry) {
  const info = autoInfoOf(entry);
  if (!info) return 'update';
  if (info.kind === 'consultation') return 'consultation';
  if (info.kind === 'schedule') return 'schedule';
  const ok = entry.origin && typeof entry.origin === 'object' ? entry.origin.kind : '';
  const text = typeof entry.content === 'string' ? entry.content.trimStart() : '';
  if (ok === 'hand_off' || ok === 'hand_off_report') return 'task';
  if (ok === 'job_notice' || ok === 'job_report' || (!ok && (text.startsWith('[Job finished]') || text.startsWith('[Job ended]')))) return 'job';
  return 'update';
}
function autoSummaryOf(cards) {
  const n = (cards || []).length;
  const workOf = (c) => c.work || (c.kind === 'consultation' ? 'consultation' : c.kind === 'schedule' ? 'schedule' : 'update');
  const words = [['consultation', 'consultation', 'consultations'], ['task', 'task', 'tasks'], ['schedule', 'scheduled task', 'scheduled tasks'], ['job', 'job finished', 'jobs finished'], ['update', 'update', 'updates']];
  const parts = [];
  for (const [w, one, many] of words) {
    const c = cards.filter((x) => workOf(x) === w).length;
    if (c) parts.push(`${c} ${c === 1 ? one : many}`);
  }
  return `${n} automatic ${n === 1 ? 'turn' : 'turns'}: ${parts.join(', ')}`;
}
function autoCardLine(history, indexes, kindsInfoLabel) {
  const isAsst = (i) => history[i].role === 'assistant';
  const asst = indexes.filter(isAsst);
  const own = indexes.some((i) => autoOwnOrigin(history[i].origin));
  const pick = own ? undefined : [...asst].reverse().find((i) => !history[i].for_owner);   // a reply shown open below the card is not repeated in it
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
    let last = info, lastWork = autoWorkOf(e), firstTs = e.ts, hasAsst = false;
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
      if (!xi || autoOwnOrigin(e.origin) || autoOwnOrigin(x.origin)) break;
      last = xi; lastWork = autoWorkOf(x); indexes.push(j);
    }
    const own = indexes.some((k) => autoOwnOrigin(history[k].origin));
    const open = indexes.filter((k) => history[k].role === 'assistant' && (history[k].for_owner === true || own));
    items.push({ type: 'card', kind: last.kind, from: last.from, label: last.label, work: lastWork, ts: firstTs, indexes, open, firstLine: last.noFrom ? last.note || '' : autoCardLine(history, indexes, last.label), ...(last.noFrom ? { noFrom: true, note: last.note || '' } : {}) });
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

if (typeof module !== 'undefined' && module.exports) module.exports = { AUTO_STACK_MIN, autoKindOfOrigin, autoOwnOrigin, autoInfoOf, autoFirstLine, autoGroupHistory, autoCardKind, autoSummaryOf };
