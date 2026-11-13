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
 *   activeStep(state, input) -> next state      (pure; the caller keeps the returned state)
 *       state  { rows: [{ name, since, doneAt }] }  (start with activeInitial())
 *       input  { busy: <activeBusyFrom result>, now, held, enabled, lingerMs = 3000 }
 *       - enabled false: no rows.
 *       - A row whose agent is working again is not done (back-to-back turns keep one row).
 *       - A row whose agent stopped is marked done (doneAt = now) and stays for lingerMs, then leaves.
 *       - A newly working agent joins at the bottom; on the first fill (no rows yet) the rows are ordered by since.
 *       - held true (pointer over the list or a finger down on it): nothing joins or leaves, so the rows below do not
 *         move; the done marks still update. The caller sets held false when the pointer leaves or after 2 s without
 *         movement, and steps again.
 *   activeChanged(a, b)   true when two states would draw differently (names, order or done marks).
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
function activeStep(state, input) {
  const { busy = {}, now = Date.now(), held = false, enabled = true, lingerMs = 3000 } = input || {};
  if (!enabled) return { rows: [] };
  const prev = (state && state.rows) || [];
  const rows = [];
  for (const r of prev) {
    if (r.name in busy) { rows.push({ name: r.name, since: Math.min(r.since, busy[r.name]), doneAt: null }); continue; }
    const doneAt = r.doneAt == null ? now : r.doneAt;
    if (!held && now - doneAt >= lingerMs) continue;          // leaves the section
    rows.push({ name: r.name, since: r.since, doneAt });
  }
  if (held) return { rows };                                  // nothing joins while the list is held
  const have = new Set(rows.map(r => r.name));
  const joining = Object.keys(busy).filter(n => !have.has(n)).map(n => ({ name: n, since: busy[n], doneAt: null }));
  joining.sort((a, b) => (a.since - b.since) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { rows: rows.concat(joining) };
}
function activeChanged(a, b) {
  const x = (a && a.rows) || [], y = (b && b.rows) || [];
  if (x.length !== y.length) return true;
  for (let i = 0; i < x.length; i++) if (x[i].name !== y[i].name || (x[i].doneAt == null) !== (y[i].doneAt == null)) return true;
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

module.exports = { activeInitial, activeBusyFrom, activeStep, activeChanged, activeMembersChanged, activeTitle };
