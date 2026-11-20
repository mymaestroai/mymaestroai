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
 *   chatViewBusyText(origin, activity, nameOf)   what the agent is doing, e.g. "Answering a consultation from Forge",
 *                                   "Working on a hand-off from CNC"; origin {kind, from, label, jobName} from turn_start
 *                                   or GET /api/agents/<name>/turn, else the status feed's activity text ("consulted by
 *                                   forge", "hand-off", "job finished"...); nameOf(name) -> display name (optional)
 *   chatViewWaiting(agent, statuses, nowMs, nameOf)   'waiting on 1 helper (RULES coder, 9 min)', 'waiting on Forge
 *                                   (3 min)', '': its helpers (workers whose parent is the agent) and agents it consulted
 *   chatViewStep(item)              a running tool step in words: 'running a command: npm test', 'starting helpers'
 *   chatViewStepsNew / chatViewStepsOn(st, turnId, item) / chatViewStepsEndTurn(st, turnId) / chatViewStepsSnapshot(st,
 *                                   turnId, activity) / chatViewStepsNewest(st): an agent's running tool calls by turn and
 *                                   call id (parallel calls, overlapping turns, a late snapshot); the newest is the step
 *   chatViewNow(words, waiting, step)   'Working on a hand-off from CNC · waiting on 1 helper (RULES coder, 9 min)'
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
function chatViewBusyText(origin, activity, nameOf) {
  const o = origin && typeof origin === 'object' ? origin : null;
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const who = (n) => {   // the agent's display name when the page knows it, else the name with a capital
    if (!n) return n;
    try { const d = typeof nameOf === 'function' ? nameOf(String(n)) : ''; if (d && typeof d === 'string') return d; } catch (e) { /* the plain name */ }
    return cap(String(n));
  };
  if (o && o.kind) {
    switch (o.kind) {
      case 'user': case 'comms': return 'Replying to your message';
      case 'consultation': return `Answering a consultation from ${who(o.from) || 'another agent'}`;
      case 'schedule': { const l = o.label || o.from; return l ? `Working on a scheduled task: ${l}` : 'Working on a scheduled task'; }
      case 'job_notice': return o.jobName ? `Reading a job result: ${o.jobName}` : 'Reading a job result';
      case 'hand_off': {
        // The target's turn is labelled "Hand-off from <caller>: <topic>"; the caller's report turn "Hand-off <state>: <topic>".
        const l = typeof o.label === 'string' ? o.label : '';
        if (/^Hand-off from /.test(l) || (!l && o.from)) return o.from ? `Working on a hand-off from ${who(o.from)}` : 'Working on a hand-off';
        if (/^Hand-off \S+:/.test(l)) return o.from ? `Reading a hand-off report from ${who(o.from)}` : 'Reading a hand-off report';
        return 'Working on a hand-off';
      }
      case 'hand_off_report': return o.from ? `Reading a hand-off report from ${who(o.from)}` : 'Reading a hand-off report';
      case 'job_report': return o.jobName ? `Reading a job report: ${o.jobName}` : 'Reading a job report';
      case 'consult_reply': return 'Reading consultation replies';
      case 'alert': return 'Handling a monitor alert';
      case 'task': return o.label === 'context compression' ? 'Resuming after compression' : `Working on a hub task${o.label ? ': ' + o.label : ''}`;
      default: return 'Working on a hub task';
    }
  }
  const a = typeof activity === 'string' ? activity.trim() : '';
  let m = /^consulted by (.+)$/i.exec(a);
  if (m) return `Answering a consultation from ${who(m[1])}`;
  m = /^scheduled task(?::\s*(.+))?$/i.exec(a);
  if (m) return m[1] ? `Working on a scheduled task: ${m[1]}` : 'Working on a scheduled task';
  if (/^job finished/i.test(a)) return 'Reading a job result';
  if (/^job report/i.test(a)) return 'Reading a job report';
  if (/^hand-off finished/i.test(a)) return 'Reading a hand-off report';
  if (/^hand-off$/i.test(a)) return 'Working on a hand-off';
  if (/^replying to you$/i.test(a)) return 'Replying to your message';
  if (/^alert$/i.test(a)) return 'Handling a monitor alert';
  return 'Working on a hub task';
}
// What a working agent waits on: its own helpers (temporary workers whose parent is it) and agents it consulted, from the
// status feed { <name>: { busy, busySince, worker, parent, label, consultedBy } }. '' when it waits on nobody.
function chatViewWaiting(agent, statuses, nowMs, nameOf) {
  const all = statuses && typeof statuses === 'object' ? statuses : {};
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const who = (n) => { try { const d = typeof nameOf === 'function' ? nameOf(String(n)) : ''; if (d && typeof d === 'string') return d; } catch (e) { /* plain */ } return cap(String(n)); };
  const since = (s) => Date.parse(s && s.busySince) || 0;
  const age = (s) => (since(s) ? chatViewElapsed(since(s), nowMs) : '');
  const helpers = [], asked = [];
  for (const [name, s] of Object.entries(all)) {
    if (!s || !s.busy || name === agent) continue;
    if (s.worker && s.parent === agent) helpers.push(s);
    else if (!s.worker && s.consultedBy === agent) asked.push(Object.assign({ name }, s));
  }
  helpers.sort((a, b) => since(a) - since(b)); asked.sort((a, b) => since(a) - since(b));
  const parts = [];
  if (helpers.length === 1) { const h = helpers[0], t = age(h); parts.push(`waiting on 1 helper (${h.label || 'unnamed'}${t ? ', ' + t : ''})`); }
  else if (helpers.length > 1) {
    const names = helpers.slice(0, 2).map(h => h.label || 'unnamed').join(', ') + (helpers.length > 2 ? ', ...' : '');
    const t = age(helpers[0]);
    parts.push(`waiting on ${helpers.length} helpers (${names}${t ? '; the first for ' + t : ''})`);
  }
  if (asked.length === 1) { const t = age(asked[0]); parts.push(`waiting on ${who(asked[0].name)}${t ? ' (' + t + ')' : ''}`); }
  else if (asked.length > 1) parts.push(`waiting on ${asked.length} agents (${asked.slice(0, 2).map(a => who(a.name)).join(', ')}${asked.length > 2 ? ', ...' : ''})`);
  return parts.join(', ');
}
// A running tool step in plain words, from a turn_activity item { kind: 'tool', tool, summary, status }. '' for anything else.
function chatViewStep(item) {
  if (!item || item.kind !== 'tool' || item.status !== 'running') return '';
  const raw = String(item.tool || '');
  const name = raw.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  const words = {
    spawn_workers: 'starting helpers', consult_agent: 'asking another agent', run_job: 'starting a background job',
    hand_off: 'handing off work', ask_user: 'waiting for your answer', Bash: 'running a command', Read: 'reading a file',
    Write: 'writing a file', Edit: 'editing a file', Grep: 'searching files', Glob: 'searching files',
    WebSearch: 'searching the web', WebFetch: 'reading a web page', schedule_task: 'scheduling a task',
  }[name] || `using ${name || 'a tool'}`;
  const sum = typeof item.summary === 'string' ? item.summary.replace(/\s+/g, ' ').trim() : '';
  return sum && !/^(spawn_workers|ask_user)$/.test(name) ? `${words}: ${sum.length > 60 ? sum.slice(0, 59) + '...' : sum}` : words;
}
// The running tool calls of one agent, so parallel calls and overlapping turns keep the right step:
// { calls: [{ key, turnId, item }] (oldest first), done: [keys] (recently finished; a late snapshot never brings one back) }.
function chatViewStepsNew() { return { calls: [], done: [] }; }
function chatViewStepKey(turnId, item) { return `${turnId || ''}|${item && item.callId != null ? item.callId : ''}`; }
function chatViewStepsOn(st, turnId, item) {
  if (!st || !item || item.kind !== 'tool') return false;
  const key = chatViewStepKey(turnId, item);
  if (item.status === 'running') {
    if (item.callId != null && st.done.includes(key)) return false;
    st.calls = st.calls.filter(c => c.key !== key || item.callId == null);
    st.calls.push({ key, turnId: turnId || '', item });
    return true;
  }
  if (item.status !== 'done') return false;
  if (item.callId != null) { st.done.push(key); if (st.done.length > 50) st.done.splice(0, st.done.length - 50); }
  let i = -1;
  for (let k = st.calls.length - 1; k >= 0 && i < 0; k--) if (st.calls[k].key === key) i = k;
  if (i < 0 && item.callId == null) for (let k = st.calls.length - 1; k >= 0 && i < 0; k--) if (st.calls[k].turnId === (turnId || '')) i = k;
  if (i < 0) return false;
  st.calls.splice(i, 1);
  return true;
}
function chatViewStepsEndTurn(st, turnId) {
  if (!st) return false;
  const before = st.calls.length;
  st.calls = turnId ? st.calls.filter(c => c.turnId !== turnId) : [];
  return st.calls.length !== before;
}
// A fetched turn (GET /api/agents/<name>/turn: { turnId, activity }): its still-running calls join the list unless already
// known or seen finishing; its finished calls count as done.
function chatViewStepsSnapshot(st, turnId, activity) {
  if (!st || !Array.isArray(activity)) return false;
  let changed = false;
  for (const it of activity) {
    if (it && it.kind === 'tool' && it.status === 'done' && it.callId != null) {
      const key = chatViewStepKey(turnId, it);
      if (!st.done.includes(key)) st.done.push(key);
      const n = st.calls.length; st.calls = st.calls.filter(c => c.key !== key); if (st.calls.length !== n) changed = true;
    }
  }
  if (st.done.length > 50) st.done.splice(0, st.done.length - 50);
  activity.forEach((it, i) => {
    if (!it || it.kind !== 'tool' || it.status !== 'running') return;
    const closed = activity.slice(i + 1).some(d => d && d.kind === 'tool' && d.status === 'done' && (it.callId == null ? d.callId == null : d.callId === it.callId));
    const key = chatViewStepKey(turnId, it);
    if (closed || (it.callId != null && st.done.includes(key)) || st.calls.some(c => c.key === key)) return;
    st.calls.push({ key, turnId: turnId || '', item: it });
    changed = true;
  });
  return changed;
}
function chatViewStepsNewest(st) { return st && st.calls.length ? st.calls[st.calls.length - 1].item : null; }
// The full line: what the turn is, then what it waits on or (when it waits on nobody) its current step.
function chatViewNow(words, waiting, step) {
  return [words, waiting || step].filter(Boolean).join(' \u00b7 ');
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
if (typeof module !== 'undefined' && module.exports) module.exports = { chatViewStepsNew, chatViewStepKey, chatViewStepsOn, chatViewStepsEndTurn, chatViewStepsSnapshot, chatViewStepsNewest, chatViewWaiting, chatViewStep, chatViewNow, CHAT_VIEW_KEY, CHAT_VIEW_PAGE, chatViewGet, chatViewSet, chatViewHistoryUrl, chatViewIsHubOrigin, chatViewBusyText, chatViewElapsed, chatViewMergeOlder };
