'use strict';
/**
 * ui-chat-view.js — which part of a chat the person sees. The MAIN view is their own conversation (their messages,
 * interjections and the agent's replies, plus a hub-started reply the agent marked for the owner); the AGENT WORK view
 * is everything (consultations, scheduled tasks, job notices: the hub-started turns), as before. The choice is per
 * device. While the open chat's agent works on a hub-started turn, the main view shows ONE busy card at the bottom.
 * The pages (app.js, mobile.js) carry byte-identical copies between the markers below; every top-level name starts
 * with `chatView` or `CHAT_VIEW_`.
 *
 *   chatViewGet(storage)            'main' | 'all'  (localStorage 'hub-chat-view'; anything else, or no storage: 'main')
 *   chatViewSet(storage, view)      stores 'main' or 'all'; returns the stored value
 *   chatViewHistoryUrl(agent, { view, before, limit })   '/api/history/<agent>?view=main&limit=40[&before=<cursor>]'
 *   chatViewIsHubOrigin(origin)     true for a turn the hub started (anything but the person: kind 'user' or 'comms')
 *   chatViewBusyText(origin, activity)   the busy card's words for a hub-started turn, e.g. "Answering a consultation
 *                                   from Forge"; origin {kind, from, label, jobName} from turn_start, else the status
 *                                   feed's activity text ("consulted by forge", "scheduled task: x", "job finished"...)
 *   chatViewElapsed(sinceMs, nowMs) '12 s' | '4 min' | '1 h 5 min'
 *   chatViewMergeOlder(older, current)   older page + current list, without an entry already in current (same ts,
 *                                   role and content) at the seam
 */
// ── chat view helpers (begin) ──
const CHAT_VIEW_KEY = 'hub-chat-view';
const CHAT_VIEW_PAGE = 40;
function chatViewGet(storage) {
  try { return storage && storage.getItem(CHAT_VIEW_KEY) === 'all' ? 'all' : 'main'; } catch (e) { return 'main'; }
}
function chatViewSet(storage, view) {
  const v = view === 'all' ? 'all' : 'main';
  try { if (storage) storage.setItem(CHAT_VIEW_KEY, v); } catch (e) { /* storage refused: the choice lasts this page */ }
  return v;
}
function chatViewHistoryUrl(agent, opts) {
  const o = opts || {};
  const q = [`view=${o.view === 'all' ? 'all' : 'main'}`, `limit=${Math.max(1, Math.min(200, Number(o.limit) || CHAT_VIEW_PAGE))}`];
  if (o.before != null && o.before !== '') q.push(`before=${encodeURIComponent(String(o.before))}`);
  return `/api/history/${encodeURIComponent(agent)}?${q.join('&')}`;
}
function chatViewIsHubOrigin(origin) {
  const k = origin && typeof origin === 'object' ? origin.kind : '';
  return !!k && typeof k === 'string' && k !== 'user' && k !== 'comms';
}
function chatViewBusyText(origin, activity) {
  const o = origin && typeof origin === 'object' ? origin : null;
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  if (o && o.kind) {
    switch (o.kind) {
      case 'consultation': return `Answering a consultation from ${cap(o.from) || 'another agent'}`;
      case 'schedule': { const l = o.label || o.from; return l ? `Working on a scheduled task: ${l}` : 'Working on a scheduled task'; }
      case 'job_notice': return o.jobName ? `Reading a job result: ${o.jobName}` : 'Reading a job result';
      case 'job_report': return o.jobName ? `Reading a job report: ${o.jobName}` : 'Reading a job report';
      case 'consult_reply': return 'Reading consultation replies';
      case 'alert': return 'Handling a monitor alert';
      case 'task': return o.label === 'context compression' ? 'Resuming after compression' : `Working on a hub task${o.label ? ': ' + o.label : ''}`;
      default: return 'Working on a hub task';
    }
  }
  const a = typeof activity === 'string' ? activity.trim() : '';
  let m = /^consulted by (.+)$/i.exec(a);
  if (m) return `Answering a consultation from ${cap(m[1])}`;
  m = /^scheduled task(?::\s*(.+))?$/i.exec(a);
  if (m) return m[1] ? `Working on a scheduled task: ${m[1]}` : 'Working on a scheduled task';
  if (/^job finished/i.test(a)) return 'Reading a job result';
  if (/^job report/i.test(a)) return 'Reading a job report';
  if (/^alert$/i.test(a)) return 'Handling a monitor alert';
  return 'Working on a hub task';
}
function chatViewElapsed(sinceMs, nowMs) {
  const s = Math.max(0, Math.floor(((Number(nowMs) || 0) - (Number(sinceMs) || 0)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
function chatViewMergeOlder(older, current) {
  const cur = Array.isArray(current) ? current : [];
  const key = (e) => `${e && e.ts}|${e && e.role}|${e && typeof e.content === 'string' ? e.content : ''}`;
  const have = new Set(cur.slice(0, 50).map(key));
  return (Array.isArray(older) ? older : []).filter((e) => e && !have.has(key(e))).concat(cur);
}
// ── chat view helpers (end) ──
if (typeof module !== 'undefined' && module.exports) module.exports = { CHAT_VIEW_KEY, CHAT_VIEW_PAGE, chatViewGet, chatViewSet, chatViewHistoryUrl, chatViewIsHubOrigin, chatViewBusyText, chatViewElapsed, chatViewMergeOlder };
