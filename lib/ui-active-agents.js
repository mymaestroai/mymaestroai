'use strict';
/**
 * ui-active-agents.js — the "Active" section at the top of the agent list, on the desktop page (app.js) and the phone
 * page (mobile.js). The pages carry byte-identical copies between the markers below; test/ui-active-agents.test.js
 * proves the copies match and tests the rules here.
 *
 *   activeBusyFrom(statusMap, localBusy, visibleNames) -> { <name>: sinceMs }
 *       Who is working right now, among the agents this person sees (visibleNames). statusMap is the hub's status feed
 *       { <name>: { busy, busySince, pendingQuestion, worker?, parent? } }; an entry counts when busy or pendingQuestion.
 *       A temporary worker (entry.worker === true, or no `worker` field and a name starting "tw-") is never its own row:
 *       its parent counts as working instead. localBusy maps names this page streams a reply for to the ISO time it
 *       started. sinceMs is the earliest known start (Date.now() when nothing says), used for the order.
 *   activeJobsFrom(jobs, visibleNames) -> { <owner>: { names: [job names, oldest first], since: earliest startedAt (ms), count } }
 *       The agents' detached background jobs (GET /api/jobs: [{ id, name, owner, status, startedAt, ... }]) that count
 *       (status 'running' or 'cancelling'), grouped by owner, for owners this person sees. Entries without an owner are
 *       skipped; a name is trimmed and a missing or empty one becomes 'job'.
 *   activeJobLabel(info, now) -> one line: the oldest job's name, ' + N more' when count > 1, then ' · ' and the time since
 *       info.since ('<1 min', '4 min', '1 h 5 min', '2 h'). '' for no info. The name is not shortened (CSS truncates).
 *   activeJobTail(info, now) -> the part after the name, ' + N more · 4 min' (or ' · 4 min'): the pages draw it in its own
 *       span that never shrinks, so only the name is cut short when the line is too long. '' for no info.
 *   activeJobTitle(info)  -> the full job names joined with a newline (the tooltip).
 *   activeStep(state, input) -> next state      (pure; the caller keeps the returned state)
 *       state  { rows: [{ name, since, doneAt, jobOnly }] }  (start with activeInitial())
 *       input  { busy: <activeBusyFrom result>, jobs: <activeJobsFrom result>, now, held, enabled, lingerMs = 3000 }
 *       - An agent is working when it is in busy OR in jobs. A row's jobOnly is true when the agent is in jobs but not in
 *         busy (recomputed every step; false for a done row); its since is the earliest start known.
 *       - enabled false: no rows.
 *       - A row whose agent is working again is not done (back-to-back turns keep one row).
 *       - A row whose agent stopped is marked done (doneAt = now) and stays for lingerMs, then leaves.
 *       - A newly working agent joins at the bottom; on the first fill (no rows yet) the rows are ordered by since.
 *       - held true (pointer over the list or a finger down on it): nothing joins or leaves, so the rows below do not
 *         move; the done marks still update. The caller sets held false when the pointer leaves or after 2 s without
 *         movement, and steps again.
 *   activeChanged(a, b)   true when two states would draw differently (names, order, done marks or jobOnly flags).
 *   activeMembersChanged(a, b)   true when the names or their order differ (rows join, leave or move); a done mark alone
 *       is not a membership change, so a page can update that row in place.
 *   activeTitle(state)    "Active 3" (the count of rows, done ones included).
 */
// ── active agents helpers (begin) ──
function activeInitial() {
  return { rows: [] };
}
function activeIsWorker(name, entry) {
  return entry && typeof entry.worker === 'boolean' ? entry.worker : /^tw-/.test(name);
}
function activeBusyFrom(statusMap, localBusy, visibleNames) {
  const visible = new Set(visibleNames || []);
  const out = {};
  const mark = (name, iso) => {
    if (!visible.has(name)) return;
    const t = Date.parse(iso);
    const since = Number.isFinite(t) ? t : Date.now();
    out[name] = name in out ? Math.min(out[name], since) : since;
  };
  for (const [name, entry] of Object.entries(statusMap || {})) {
    if (!entry || !(entry.busy || entry.pendingQuestion)) continue;
    if (activeIsWorker(name, entry)) { if (entry.parent) mark(entry.parent, entry.busySince); }
    else mark(name, entry.busySince);
  }
  const local = localBusy instanceof Map ? [...localBusy.entries()] : Object.entries(localBusy || {});
  for (const [name, iso] of local) {
    const entry = (statusMap || {})[name];
    if (activeIsWorker(name, entry)) continue;
    mark(name, iso);
  }
  return out;
}
function activeJobsFrom(jobs, visibleNames) {
  const visible = new Set(visibleNames || []);
  const list = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j || !j.owner || !visible.has(j.owner)) continue;
    if (j.status !== 'running' && j.status !== 'cancelling') continue;
    const t = typeof j.startedAt === 'number' ? j.startedAt : Date.parse(j.startedAt);
    list.push({ owner: j.owner, name: String(j.name == null ? '' : j.name).trim() || 'job', at: Number.isFinite(t) ? t : Date.now() });
  }
  list.sort((a, b) => a.at - b.at);                           // oldest first (the sort is stable)
  const out = {};
  for (const j of list) {
    const o = out[j.owner] || (out[j.owner] = { names: [], since: j.at, count: 0 });
    o.names.push(j.name); o.count++;
  }
  return out;
}
function activeJobTail(info, now) {
  if (!info || !info.count) return '';
  const m = Math.max(0, Math.floor(((now == null ? Date.now() : now) - info.since) / 60000));
  const t = m < 1 ? '<1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${info.count > 1 ? ` + ${info.count - 1} more` : ''} \u00B7 ${t}`;
}
function activeJobLabel(info, now) {
  if (!info || !info.count) return '';
  return `${info.names[0]}${activeJobTail(info, now)}`;
}
function activeJobTitle(info) {
  return info && info.names ? info.names.join('\n') : '';
}
function activeStep(state, input) {
  const { busy = {}, jobs = {}, now = Date.now(), held = false, enabled = true, lingerMs = 3000 } = input || {};
  if (!enabled) return { rows: [] };
  const work = Object.assign({}, busy);                       // working: busy, or has a running job
  for (const n of Object.keys(jobs)) work[n] = n in work ? Math.min(work[n], jobs[n].since) : jobs[n].since;
  const prev = (state && state.rows) || [];
  const rows = [];
  for (const r of prev) {
    if (r.name in work) { rows.push({ name: r.name, since: Math.min(r.since, work[r.name]), doneAt: null, jobOnly: !(r.name in busy) }); continue; }
    const doneAt = r.doneAt == null ? now : r.doneAt;
    if (!held && now - doneAt >= lingerMs) continue;          // leaves the section
    rows.push({ name: r.name, since: r.since, doneAt, jobOnly: false });
  }
  if (held) return { rows };                                  // nothing joins while the list is held
  const have = new Set(rows.map(r => r.name));
  const joining = Object.keys(work).filter(n => !have.has(n)).map(n => ({ name: n, since: work[n], doneAt: null, jobOnly: !(n in busy) }));
  joining.sort((a, b) => (a.since - b.since) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { rows: rows.concat(joining) };
}
function activeChanged(a, b) {
  const x = (a && a.rows) || [], y = (b && b.rows) || [];
  if (x.length !== y.length) return true;
  for (let i = 0; i < x.length; i++) if (x[i].name !== y[i].name || (x[i].doneAt == null) !== (y[i].doneAt == null) || !!x[i].jobOnly !== !!y[i].jobOnly) return true;
  return false;
}
function activeMembersChanged(a, b) {
  const x = (a && a.rows) || [], y = (b && b.rows) || [];
  if (x.length !== y.length) return true;
  for (let i = 0; i < x.length; i++) if (x[i].name !== y[i].name) return true;
  return false;
}
function activeTitle(state) {
  return `Active ${((state && state.rows) || []).length}`;
}
// ── active agents helpers (end) ──

module.exports = { activeInitial, activeBusyFrom, activeJobsFrom, activeJobLabel, activeJobTail, activeJobTitle, activeStep, activeChanged, activeMembersChanged, activeTitle };
