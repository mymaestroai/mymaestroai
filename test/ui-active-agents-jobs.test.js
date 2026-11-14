'use strict';
// Background jobs in the Active section: the pure helpers (lib/ui-active-agents.js), the desktop poll and row dressing
// (app.js) and the phone poll and row markup (mobile.js). The page functions are cut out of the source and run against stubs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/ui-active-agents');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const mob = fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a + ' .. ' + b); return src.slice(i, j); };

const T = Date.parse('2026-01-01T10:00:00.000Z');
const MIN = 60000;

// ── lib ──────────────────────────────────────────────────────────────────────────────────────────

test('activeJobsFrom: only running and cancelling jobs of visible owners count', () => {
  const jobs = [
    { owner: 'sam', name: 'a', status: 'running', startedAt: T },
    { owner: 'sam', name: 'b', status: 'cancelling', startedAt: T + 1 },
    { owner: 'sam', name: 'c', status: 'done', startedAt: T },
    { owner: 'sam', name: 'd', status: 'failed', startedAt: T },
    { owner: 'sam', name: 'e', status: 'cancelled', startedAt: T },
    { owner: 'kim', name: 'hidden', status: 'running', startedAt: T },
  ];
  assert.deepStrictEqual(L.activeJobsFrom(jobs, ['sam', 'robin']), { sam: { names: ['a', 'b'], since: T, count: 2 } });
  assert.deepStrictEqual(L.activeJobsFrom(jobs, []), {});
  assert.deepStrictEqual(L.activeJobsFrom(null, ['sam']), {});
  assert.deepStrictEqual(L.activeJobsFrom(undefined, undefined), {});
});

test('activeJobsFrom: grouped per owner, oldest first, since is the oldest start', () => {
  const jobs = [
    { owner: 'sam', name: 'late', status: 'running', startedAt: new Date(T + 5 * MIN).toISOString() },
    { owner: 'robin', name: 'solo', status: 'running', startedAt: T + 2 * MIN },
    { owner: 'sam', name: 'early', status: 'running', startedAt: new Date(T).toISOString() },
    { owner: 'sam', name: 'mid', status: 'cancelling', startedAt: T + MIN },
  ];
  const out = L.activeJobsFrom(jobs, ['sam', 'robin']);
  assert.deepStrictEqual(out.sam, { names: ['early', 'mid', 'late'], since: T, count: 3 });
  assert.deepStrictEqual(out.robin, { names: ['solo'], since: T + 2 * MIN, count: 1 });
});

test('activeJobsFrom: an empty or missing name becomes "job"; entries without an owner are skipped', () => {
  const jobs = [
    { owner: 'sam', name: '', status: 'running', startedAt: T },
    { owner: 'sam', name: '   ', status: 'running', startedAt: T + 1 },
    { owner: 'sam', status: 'running', startedAt: T + 2 },
    { owner: 'sam', name: null, status: 'running', startedAt: T + 3 },
    { name: 'orphan', status: 'running', startedAt: T },
    { owner: '', name: 'blank owner', status: 'running', startedAt: T },
    null,
    undefined,
  ];
  assert.deepStrictEqual(L.activeJobsFrom(jobs, ['sam', '']), { sam: { names: ['job', 'job', 'job', 'job'], since: T, count: 4 } });
});

test('activeJobLabel: "Background job: " + oldest name, "+ N more", and the elapsed time', () => {
  const one = { names: ['build'], since: T, count: 1 };
  assert.strictEqual(L.activeJobLabel(one, T + 30000), 'Background job: build \u00B7 <1 min');
  assert.strictEqual(L.activeJobLabel(one, T + 4 * MIN + 10000), 'Background job: build \u00B7 4 min');
  assert.strictEqual(L.activeJobLabel(one, T + 65 * MIN), 'Background job: build \u00B7 1 h 5 min');
  assert.strictEqual(L.activeJobLabel(one, T + 120 * MIN), 'Background job: build \u00B7 2 h');
  assert.strictEqual(L.activeJobLabel({ names: ['a', 'b', 'c'], since: T, count: 3 }, T + 4 * MIN), 'Background job: a + 2 more \u00B7 4 min');
  assert.strictEqual(L.activeJobLabel({ names: ['a', 'b'], since: T, count: 2 }, T + 4 * MIN), 'Background job: a + 1 more \u00B7 4 min');
  assert.strictEqual(L.activeJobLabel(one, T - 5000), 'Background job: build \u00B7 <1 min', 'a clock that runs behind never shows a negative time');
  assert.strictEqual(L.activeJobLabel(null, T), '');
  assert.strictEqual(L.activeJobLabel(undefined, T), '');
});

test('activeJobLead: "Background job: " + the oldest name, empty for no info; the label is lead + tail', () => {
  const info = { names: ['build', 'x'], since: T, count: 2 };
  assert.strictEqual(L.activeJobLead(info), 'Background job: build');
  assert.strictEqual(L.activeJobLead(null), '');
  assert.strictEqual(L.activeJobLead(undefined), '');
  assert.strictEqual(L.activeJobLabel(info, T + MIN), L.activeJobLead(info) + L.activeJobTail(info, T + MIN));
  assert.ok(!L.activeJobLabel(info, T).includes('\u23F3'), 'no hourglass');
});

test('activeJobTitle: the names, one per line', () => {
  assert.strictEqual(L.activeJobTitle({ names: ['a', 'b', 'c'], since: T, count: 3 }), 'a\nb\nc');
  assert.strictEqual(L.activeJobTitle({ names: ['a'], since: T, count: 1 }), 'a');
  assert.strictEqual(L.activeJobTitle(null), '');
});

const S = (name, since, extra) => Object.assign({ name, since, doneAt: null }, extra);

test('activeStep: an agent with only a background job is not a row (passed as jobs or in any other way); a busy agent is', () => {
  const jobs = { sam: { names: ['x'], since: T, count: 1 } };
  assert.deepStrictEqual(L.activeStep(L.activeInitial(), { busy: {}, jobs, now: T + 10 }).rows, [], 'jobs input is ignored');
  assert.deepStrictEqual(L.activeStep(L.activeInitial(), { jobs, now: T + 10 }).rows, []);
  assert.deepStrictEqual(L.activeStep(L.activeInitial(), { busy: {}, now: T + 10, work: jobs }).rows, []);
  const both = L.activeStep(L.activeInitial(), { busy: { robin: T + 5 }, jobs, now: T + 10 });
  assert.deepStrictEqual(both.rows, [{ name: 'robin', since: T + 5, doneAt: null }], 'rows are { name, since, doneAt } only; the job agent is absent');
  assert.ok(!('jobOnly' in both.rows[0]));
});

test('activeStep: a busy agent with a running job is one row; when it stops the row is done (the job does not keep it), then leaves after lingerMs', () => {
  const jobs = { sam: { names: ['x'], since: T, count: 1 } };
  const a = L.activeStep(L.activeInitial(), { busy: { sam: T + 20 }, jobs, now: T + 30 });
  assert.deepStrictEqual(a.rows, [{ name: 'sam', since: T + 20, doneAt: null }]);
  const d = L.activeStep(a, { busy: {}, jobs, now: T + 1000 });
  assert.deepStrictEqual(d.rows, [{ name: 'sam', since: T + 20, doneAt: T + 1000 }]);
  assert.strictEqual(L.activeStep(d, { jobs, now: T + 1000 + 2999 }).rows.length, 1, 'still lingering');
  assert.strictEqual(L.activeStep(d, { jobs, now: T + 1000 + 3000 }).rows.length, 0, 'gone after 3000 ms even though the job still runs');
  assert.strictEqual(L.activeStep(d, { now: T + 1000 + 500, lingerMs: 500 }).rows.length, 0, 'custom lingerMs');
  assert.strictEqual(L.activeStep(d, { busy: { sam: T + 1100 }, now: T + 1100 }).rows[0].doneAt, null, 'busy again before the linger ends revives the row');
});

test('activeStep: held blocks joining; enabled false gives no rows', () => {
  const busy = { sam: T };
  assert.deepStrictEqual(L.activeStep(L.activeInitial(), { busy, held: true, now: T }).rows, []);
  const a = L.activeStep(L.activeInitial(), { busy, now: T });
  const held = L.activeStep(a, { busy: { sam: T, kim: T + 1 }, held: true, now: T + 5 });
  assert.deepStrictEqual(held.rows.map(r => r.name), ['sam'], 'a newly busy agent does not join while held');
  assert.deepStrictEqual(L.activeStep(a, { busy, enabled: false, now: T }).rows, []);
});

test('activeChanged looks at names, order and done marks only (no jobOnly flag); activeMembersChanged ignores done marks', () => {
  const a = { rows: [S('sam', T)] };
  assert.strictEqual(L.activeChanged(a, { rows: [S('sam', T, { jobOnly: true })] }), false, 'a stray jobOnly field changes nothing');
  assert.strictEqual(L.activeChanged(a, { rows: [S('sam', T, { doneAt: T + 5 })] }), true);
  assert.strictEqual(L.activeChanged(a, { rows: [S('kim', T)] }), true);
  assert.strictEqual(L.activeMembersChanged(a, { rows: [S('sam', T, { doneAt: T + 5 })] }), false);
  assert.ok(!/jobOnly/.test(fs.readFileSync(path.join(ROOT, 'lib/ui-active-agents.js'), 'utf8')), 'no jobOnly anywhere in the lib');
});

test('the jobs helpers exist exactly once in lib, app.js and mobile.js (inside the byte-identical block)', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'lib/ui-active-agents.js'), 'utf8');
  for (const n of ['activeJobsFrom', 'activeJobLead', 'activeJobLabel', 'activeJobTail', 'activeJobTitle']) {
    for (const [name, src] of [['lib', lib], ['app.js', app], ['mobile.js', mob]]) {
      assert.strictEqual(src.split(`function ${n}(`).length - 1, 1, `${n} in ${name}`);
    }
    assert.ok(typeof L[n] === 'function', n + ' exported');
  }
});

// ── a tiny fake DOM ──────────────────────────────────────────────────────────────────────────────

function el(cls) {
  const e = {
    className: cls || '', children: [], parentNode: null, textContent: '', title: '',
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    appendChild(c) { if (c.parentNode) c.remove(); this.children.push(c); c.parentNode = this; return c; },
    remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; } },
    querySelectorAll(sel) {
      const cls = sel.slice(1), out = [];
      const walk = (n) => { for (const c of n.children) { if (c.className.split(' ').includes(cls)) out.push(c); walk(c); } };
      walk(this);
      return out;
    },
    querySelector(sel) {
      const cls = sel.slice(1);
      for (const c of this.children) { if (c.className.split(' ').includes(cls)) return c; const r = c.querySelector(sel); if (r) return r; }
      return null;
    },
    classList: {
      toggle(c, f) { const s = new Set(e.className.split(' ').filter(Boolean)); (f === undefined ? !s.has(c) : f) ? s.add(c) : s.delete(c); e.className = [...s].join(' '); },
      add(c) { e.classList.toggle(c, true); }, remove(c) { e.classList.toggle(c, false); },
      contains(c) { return e.className.split(' ').includes(c); },
    },
  };
  return e;
}
const freshCopy = () => { const copy = el('agent-btn'); const info = el('agent-info'); const dd = el('agent-status live-idle'); copy.appendChild(dd); copy.appendChild(info); return { copy, info, dd }; };

// ── desktop (app.js) ─────────────────────────────────────────────────────────────────────────────

// The job state is declared with the other Active state (before any paint can run); the poll functions follow paintActiveSection.
const DESK_SRC = cut(app, 'const ACTIVE_JOBS_MS', 'function activeTopOn()') + '\n' + cut(app, 'function activeDress(', 'function activeMakeCopy(') + '\n' +
  cut(app, "// Agents' detached background jobs (GET /api/jobs", 'function activeWireHold(');

// Runs the desktop poll block and row dressing against stubs. The page's own load-time activeJobsSync() runs while the tab is 'hidden'.
function desk(o) {
  o = o || {};
  const clock = { now: 1000000 };
  const rec = { paints: 0, chips: 0, fetches: [], timers: [], cleared: [], listeners: {} };
  const resp = { next: o.first || { status: 200, ok: true, jobs: [] } };
  const env = {
    // changed: the poll only runs for a known admin (window.hubMe.isAdmin === true); o.me overrides the signed-in user (null = not known yet)
    window: { hubMe: o.me === undefined ? { isAdmin: true } : o.me },
    paintAgentsWorking: () => { rec.chips++; },
    agentStatus: o.status || {}, localBusy: o.localBusy || new Map(),   // activeDress: a busy agent keeps the busy look
    activeTopOn: () => (o.on === undefined ? true : o.on),
    document: { visibilityState: 'hidden', addEventListener: (ev, fn) => { rec.listeners[ev] = fn; }, createElement: () => el(''), querySelectorAll: () => o.jobEls || [] },
    fetch: async (url, opts) => {
      rec.fetches.push([url, opts]);
      const r = resp.next;
      if (r.defer) return new Promise((res) => { (rec.pending || (rec.pending = [])).push(() => res({ status: 200, ok: true, json: async () => ({ jobs: r.jobs }) })); });
      if (r.throws) throw new Error('offline');
      return { status: r.status, ok: r.ok, json: async () => ({ jobs: r.jobs }) };
    },
    setInterval: (fn, ms) => { rec.timers.push({ fn, ms }); return rec.timers.length; },
    clearInterval: (id) => { rec.cleared.push(id); },
    paintActiveSection: () => { rec.paints++; },
    Date: { now: () => clock.now },
    activeJobsFrom: L.activeJobsFrom, activeJobLead: L.activeJobLead, activeJobLabel: L.activeJobLabel, activeJobTail: L.activeJobTail, activeJobTitle: L.activeJobTitle,
  };
  const names = Object.keys(env);
  const api = new Function(...names, DESK_SRC + `
    return { activeDress, activeDressJob, activeJobsPoll, activeJobsSync, activeJobsWanted, activeJobsRelabel,
      list: () => activeJobList, jobs: () => activeJobs, setJobs: (v) => { activeJobs = v; }, timer: () => activeJobsTimer, stopped: () => activeJobsStopped,
      fresh: () => activeJobsFresh() };`)(...names.map(n => env[n]));
  env.document.visibilityState = o.hidden ? 'hidden' : 'visible';
  return { env, rec, clock, resp, api };
}
const JOB = (id, owner, name, extra) => Object.assign({ id, owner, name, status: 'running', startedAt: T }, extra);

test('desktop poll: fetches /api/jobs with credentials and stops for good after a 403', async () => {
  const d = desk({ first: { status: 403, ok: false } });
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.fetches.length, 1);
  // changed (review r1): the request also carries an abort signal (10 s timeout)
  assert.strictEqual(d.rec.fetches[0][0], '/api/jobs'); assert.strictEqual(d.rec.fetches[0][1].credentials, 'include'); assert.ok(d.rec.fetches[0][1].signal, 'abort signal');
  assert.strictEqual(d.api.stopped(), true);
  await d.api.activeJobsPoll();
  d.api.activeJobsSync();
  assert.strictEqual(d.rec.fetches.length, 1, 'a second call does not fetch');
  assert.strictEqual(d.api.activeJobsWanted(), false);
  const u = desk({ first: { status: 401, ok: false } });
  await u.api.activeJobsPoll();
  assert.strictEqual(u.api.stopped(), true, '401 stops it too');
});

test('desktop poll: a 403 clears the running timer and the job list', async () => {
  const d = desk({ first: { status: 200, ok: true, jobs: [JOB('1', 'sam', 'a')] } });
  d.api.activeJobsSync();
  await Promise.resolve(); await new Promise(r => setImmediate(r));
  assert.strictEqual(d.rec.timers.length, 1);
  assert.strictEqual(d.rec.timers[0].ms, 15000);
  assert.strictEqual(d.api.list().length, 1);
  d.resp.next = { status: 403, ok: false };
  await d.api.activeJobsPoll();
  assert.deepStrictEqual(d.rec.cleared, [1]);
  assert.deepStrictEqual(d.api.list(), []);
  assert.strictEqual(d.rec.paints, 2);
});

test('desktop poll: polls even with the Active switch off (job lines are on the normal rows); does nothing when the tab is hidden', async () => {
  const off = desk({ on: false });
  assert.strictEqual(off.api.activeJobsWanted(), true, 'the switch no longer matters');
  off.api.activeJobsSync();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(off.rec.fetches.length, 1);
  assert.strictEqual(off.rec.timers.length, 1);
  const hid = desk({ hidden: true });
  await hid.api.activeJobsPoll();
  hid.api.activeJobsSync();
  assert.strictEqual(hid.rec.fetches.length, 0);
  assert.strictEqual(hid.rec.timers.length, 0);
  assert.strictEqual(hid.rec.paints, 0);
});

test('desktop poll: visibilitychange starts and stops the timer', async () => {
  const d = desk({ hidden: true });
  assert.strictEqual(typeof d.rec.listeners.visibilitychange, 'function', 'wired to visibilitychange');
  d.env.document.visibilityState = 'visible';
  d.rec.listeners.visibilitychange();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(d.rec.fetches.length, 1, 'polls at once when shown');
  assert.strictEqual(d.rec.timers.length, 1);
  d.env.document.visibilityState = 'hidden';
  d.rec.listeners.visibilitychange();
  assert.deepStrictEqual(d.rec.cleared, [1]);
  assert.strictEqual(d.api.timer(), null);
});

test('desktop poll: a changed job list paints once, an unchanged one does not', async () => {
  const d = desk({ first: { status: 200, ok: true, jobs: [JOB('1', 'sam', 'a')] } });
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.paints, 1);
  assert.strictEqual(d.api.list().length, 1);
  await d.api.activeJobsPoll();
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.paints, 1, 'same list: no repaint');
  d.resp.next = { status: 200, ok: true, jobs: [JOB('1', 'sam', 'a'), JOB('2', 'robin', 'b')] };
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.paints, 2);
  d.resp.next = { status: 200, ok: true, jobs: [JOB('1', 'sam', 'a', { status: 'cancelling' }), JOB('2', 'robin', 'b')] };
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.paints, 3, 'a status change counts');
});

test('desktop poll: an unchanged list still refreshes the elapsed time of the drawn job lines in place, without a repaint', async () => {
  const mkLine = () => { const l = el('agent-job-line'); const nm = el('ajl-name'), tl = el('ajl-tail'); l.appendChild(nm); l.appendChild(tl); return { l, nm, tl }; };
  const sam = mkLine(), robin = mkLine();
  const btn = (name, line) => { const b = el('agent-btn'); b.dataset = { agent: name }; b.closest = () => b; b.appendChild(line); return b; };
  const lines = [sam.l, robin.l];
  sam.l.closest = () => btn('sam', sam.l); robin.l.closest = () => btn('robin', robin.l);
  const d = desk({ first: { status: 200, ok: true, jobs: [JOB('1', 'sam', 'a', { startedAt: 1000000 - 50000 })] }, jobEls: lines });
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.paints, 1);
  d.clock.now += 30000;
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.paints, 1, 'same list: no repaint');
  assert.strictEqual(d.api.jobs().sam, undefined, 'activeJobs is set by paintActiveSection (stubbed here); the relabel only touches lines whose agent has a job');
  d.api.setJobs({ sam: { names: ['a'], since: 1000000 - 50000, count: 1 } });
  await d.api.activeJobsPoll();
  assert.strictEqual(sam.tl.textContent, ' · 1 min', 'the tail of a drawn line moves');
  assert.strictEqual(robin.tl.textContent, '', 'a line whose agent has no job is left alone');
  assert.strictEqual(d.rec.paints, 1);
});

test('desktop poll: after 60 s of failures the jobs are treated as none', async () => {
  const d = desk({ first: { status: 200, ok: true, jobs: [JOB('1', 'sam', 'a')] } });
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.paints, 1);
  d.resp.next = { throws: true };
  d.clock.now += 30000;
  await d.api.activeJobsPoll();
  assert.strictEqual(d.api.list().length, 1, '30 s of failure: the last good list stays');
  assert.strictEqual(d.rec.paints, 1);
  d.resp.next = { status: 500, ok: false };
  d.clock.now += 20000;
  await d.api.activeJobsPoll();
  assert.strictEqual(d.api.list().length, 1, '50 s: still kept');
  d.clock.now += 11000;
  await d.api.activeJobsPoll();
  assert.deepStrictEqual(d.api.list(), [], '61 s: none');
  assert.strictEqual(d.rec.paints, 2);
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.paints, 2, 'staying empty does not repaint again');
  assert.strictEqual(d.api.stopped(), false, 'a 500 never stops the poll');
});

test('desktop activeDressJob writes "Background job: <name>" (no hourglass) and the tail, keeps one line last, and removes it when there is no job', () => {
  const d = desk();
  const { copy, info } = freshCopy();
  const busyLine = el('agent-busy-line'); info.appendChild(busyLine);
  const JI = { names: ['build <b>', 'lint'], since: d.clock.now - 4 * MIN - 1000, count: 2 };
  d.api.activeDressJob(copy, JI);
  const line = info.querySelector('.agent-job-line');
  assert.ok(line, 'line added');
  // changed (Maestro 23:40): the name and the tail are separate spans, so only the name can be cut short
  const part = (c) => line.children.find(x => x.className === c);
  assert.strictEqual(part('ajl-name').textContent, 'Background job: build <b>');
  assert.strictEqual(part('ajl-tail').textContent, ' + 1 more · 4 min');
  assert.strictEqual(line.children.length, 2);
  assert.strictEqual(line.title, 'build <b>\nlint');
  assert.strictEqual(info.lastElementChild, line, 'after the busy line');
  d.clock.now += 2 * MIN;
  d.api.activeDressJob(copy, JI);
  assert.strictEqual(info.children.filter(c => c.className === 'agent-job-line').length, 1, 'rewritten in place, not duplicated');
  assert.strictEqual(part('ajl-tail').textContent, ' + 1 more · 6 min', 'the tail is rewritten in place');
  assert.strictEqual(line.children.length, 2, 'no extra spans');
  info.appendChild(el('agent-busy-line'));   // something appended after it: the job line moves back to the end
  d.api.activeDressJob(copy, JI);
  assert.strictEqual(info.lastElementChild, line);
  const dup = el('agent-job-line'); info.appendChild(dup);   // a stray second line (a copy cloned from a row that had one) is dropped
  d.api.activeDressJob(copy, JI);
  assert.strictEqual(info.querySelectorAll('.agent-job-line').length, 1, 'exactly one job line');
  assert.strictEqual(info.lastElementChild.className, 'agent-job-line', 'and it is last in .agent-info');
  d.api.activeDressJob(copy, null);
  assert.strictEqual(info.querySelector('.agent-job-line'), null, 'no info (a done Active copy, or no job): the line is removed');
  d.api.activeDressJob(copy, JI);
  assert.ok(info.querySelector('.agent-job-line'));
  d.api.activeDressJob(copy, undefined);
  assert.strictEqual(info.querySelector('.agent-job-line'), null, 'no job: the line is removed');
  d.api.activeDressJob(copy, undefined);   // and removing nothing is fine
});

test('desktop activeDress: an Active copy is busy-looking or done, never "job only" (no active-joby class, no hollow dot)', () => {
  const d = desk();
  const { copy, info, dd } = freshCopy();
  info.appendChild(el('agent-busy-line'));
  d.api.activeDress(copy, { name: 'sam', doneAt: null, jobOnly: true }, null);
  assert.ok(!copy.classList.contains('active-joby'), 'even a stray jobOnly flag does nothing');
  assert.notStrictEqual(dd.className, 'agent-status live-joby');
  assert.ok(info.querySelector('.agent-busy-line'), 'the status line stays');
  assert.ok(copy.classList.contains('is-busy'));
  d.api.activeDress(copy, { name: 'sam', doneAt: 9 }, null);
  assert.ok(copy.classList.contains('active-done') && !copy.classList.contains('is-busy'));
  assert.strictEqual(dd.className, 'agent-status live-idle');
  assert.ok(!/jobOnly|active-joby|live-joby/.test(cut(app, 'function activeDress(', 'function activeDressJob(')), 'the branch is gone from the source');
});

test('desktop paintActiveSection: jobs come from the polled list whatever the switch says; the step gets busy only', () => {
  const p = cut(app, 'function paintActiveSection(', "// Agents' detached background jobs (GET /api/jobs");
  assert.ok(app.indexOf('const ACTIVE_JOBS_MS') < app.indexOf('function paintActiveSection('), 'the job state exists before any paint');
  assert.ok(p.includes('activeJobs = activeJobsFrom(activeJobsFresh() ? activeJobList : [], visible);'), 'a list older than 60 s is not shown; no switch in it');
  assert.ok(/activeStep\(activeState, \{ busy, now: Date\.now\(\)/.test(p) && !/jobs:/.test(p), 'the step gets no jobs');
  assert.ok(p.indexOf('activeDressJob(document.getElementById') > 0 && p.indexOf('activeDressJob(document.getElementById') < p.indexOf('activeState.rows.length === 0'), 'normal rows get their job line before the early return');
  assert.ok(app.includes('activeDressJob(copy, row.doneAt == null ? activeJobs[row.name] : null);'));
  const save = cut(app, 'function saveActiveTop(', 'function activeDress(');
  assert.ok(save.includes('activeJobsSync();') && save.indexOf('activeJobsSync();') < save.indexOf('paintActiveSection(true)'), 'the switch still calls the sync');
});

// paintActiveSection run for real against a tiny fake list: job lines on normal rows
const PAINT_SRC = cut(app, 'function activeDressJob(', 'function activeMakeCopy(') + '\n' + cut(app, 'function paintActiveSection(', "// Agents' detached background jobs (GET /api/jobs");
function deskPaint(o) {
  const clock = { now: 1000000 };
  const rows = {};
  for (const n of ['sam', 'robin']) { const b = el('agent-btn'); b.dataset = { agent: n }; const inf = el('agent-info'); b.appendChild(inf); rows[n] = { b, inf }; }
  const box = { innerHTML: 'x', hidden: false, offsetHeight: 0, querySelector: () => ({ replaceChildren() {}, children: [] }) };
  const env = {
    document: { getElementById: (id) => (id === 'agent-active-group' ? box : id.startsWith('agent-btn-') && rows[id.slice(10)] ? rows[id.slice(10)].b : null), createElement: () => el('') },
    AGENTS: [{ name: 'sam' }, { name: 'robin' }], agentStatus: o.status || {}, localBusy: new Map(), localStorage: { getItem: () => null },
    activeTopOn: () => o.on !== false, window: { matchMedia: null }, setInterval: () => 1, clearInterval() {},
    Date: { now: () => clock.now },
    activeBusyFrom: L.activeBusyFrom, activeJobsFrom: L.activeJobsFrom, activeStep: L.activeStep, activeMembersChanged: L.activeMembersChanged,
    activeJobLead: L.activeJobLead, activeJobTail: L.activeJobTail, activeJobTitle: L.activeJobTitle, activeMakeCopy: () => null,
  };
  const names = Object.keys(env);
  const api = new Function(...names, 'let activeState = { rows: [] }; let activeHeld = false; let activeTicker = null; let activeJobList = []; let activeJobs = {}; let activeJobsOkAt = Date.now();\n' +
    'function activeJobsFresh() { return Date.now() - activeJobsOkAt <= 60000; }\n' + PAINT_SRC + `
    return { paintActiveSection, setList: (l) => { activeJobList = l; activeJobsOkAt = Date.now(); }, state: () => activeState };`)(...names.map(n => env[n]));
  return { api, rows, box, clock };
}

test('desktop: an idle agent with a job gets "Background job: <name>" + tail on its normal row, even with the Active switch off; the line goes when the job ends', () => {
  for (const on of [true, false]) {
    const d = deskPaint({ on });
    d.api.setList([JOB('1', 'sam', 'build', { startedAt: d.clock.now - 4 * MIN - 500 })]);
    d.api.paintActiveSection();
    const lines = d.rows.sam.inf.querySelectorAll('.agent-job-line');
    assert.strictEqual(lines.length, 1, 'switch ' + on);
    assert.strictEqual(lines[0].children[0].textContent, 'Background job: build');
    assert.strictEqual(lines[0].children[1].textContent, ' · 4 min');
    assert.strictEqual(d.rows.robin.inf.querySelectorAll('.agent-job-line').length, 0, 'an agent without a job has none');
    assert.deepStrictEqual(d.api.state().rows, [], 'an agent with only a job is not in Active');
    d.api.paintActiveSection();
    assert.strictEqual(d.rows.sam.inf.querySelectorAll('.agent-job-line').length, 1, 'repainting does not duplicate');
    d.api.setList([]);
    d.api.paintActiveSection();
    assert.strictEqual(d.rows.sam.inf.querySelectorAll('.agent-job-line').length, 0, 'the job ended: no line');
  }
});

test('desktop: a busy agent with a job is in Active and its normal row carries the job line below the status line', () => {
  const d = deskPaint({ status: { sam: { busy: true, busySince: '2026-01-01T10:00:00Z' } } });
  d.rows.sam.inf.appendChild(el('agent-busy-line'));
  d.api.setList([JOB('1', 'sam', 'build', { startedAt: d.clock.now })]);
  d.api.paintActiveSection();
  assert.deepStrictEqual(d.api.state().rows.map(r => r.name), ['sam']);
  assert.strictEqual(d.rows.sam.inf.lastElementChild.className, 'agent-job-line');
});

test('desktop: no joby / job-busy / jobOnly / busySplitJobs strings remain in app.js, index.html, the lib or mobile', () => {
  const files = ['app.js', 'index.html', 'mobile.js', 'mobile.html', 'lib/ui-active-agents.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const w of ['joby', 'job-busy', 'jobOnly', 'busySplitJobs']) assert.ok(!src.includes(w), `${w} in ${f}`);
  }
});

// ── phone (mobile.js) ────────────────────────────────────────────────────────────────────────────

const PHONE_POLL = cut(mob, 'const ACTIVE_JOBS_MS', 'function renderAgents()');
const ROW_SRC = cut(mob, 'function agentRowHtml(', '// The Active section at the top');
const ESC_SRC = cut(mob, 'function esc(s) {', 'function toast(');

function phone(o) {
  o = o || {};
  const clock = { now: 1000000 };
  const rec = { renders: 0, apis: [], timers: [], cleared: [], listeners: {} };
  const resp = { next: o.first || { status: 200, ok: true, jobs: [] } };
  const listEl = { querySelectorAll: () => o.rows || [] };
  const env = {
    isAdmin: () => o.admin !== false,   // changed: the page's isAdmin() (false for a member once /api/me answered)
    activeTopOn: () => (o.on === undefined ? true : o.on),
    document: { visibilityState: 'hidden', addEventListener: (ev, fn) => { rec.listeners[ev] = fn; } },
    api: async (url) => {
      rec.apis.push(url);
      const r = resp.next;
      if (r.throws) throw new Error('offline');
      return { status: r.status, ok: r.ok, json: async () => ({ jobs: r.jobs }) };
    },
    screen: o.screen || 'agents', agents: o.agents || [{ name: 'sam' }, { name: 'robin' }],
    renderAgents: () => { rec.renders++; }, $: (id) => (id === 'agents-list' ? listEl : null),
    setInterval: (fn, ms) => { rec.timers.push({ fn, ms }); return rec.timers.length; },
    clearInterval: (id) => { rec.cleared.push(id); },
    Date: { now: () => clock.now },
    activeJobsFrom: L.activeJobsFrom, activeJobLead: L.activeJobLead, activeJobLabel: L.activeJobLabel, activeJobTail: L.activeJobTail, activeJobTitle: L.activeJobTitle,
  };
  const names = Object.keys(env);
  const apiObj = new Function(...names, PHONE_POLL + `
    return { activeJobsPoll, activeJobsSync, activeJobsWanted, activeJobsNow, activeJobsRelabel,
      list: () => activeJobList, setJobs: (v) => { activeJobs = v; }, timer: () => activeJobsTimer, tick: () => activeJobsTick,
      setTick: (v) => { activeJobsTick = v; }, stopped: () => activeJobsStopped };`)(...names.map(n => env[n]));
  env.document.visibilityState = o.hidden ? 'hidden' : 'visible';
  return { env, rec, clock, resp, api: apiObj };
}

test('phone poll: uses api("/api/jobs") and stops for good after a 403 (or 401)', async () => {
  const d = phone({ first: { status: 403, ok: false } });
  await d.api.activeJobsPoll();
  assert.deepStrictEqual(d.rec.apis, ['/api/jobs']);
  assert.strictEqual(d.api.stopped(), true);
  await d.api.activeJobsPoll();
  d.api.activeJobsSync();
  assert.strictEqual(d.rec.apis.length, 1, 'a second call does not fetch');
  const u = phone({ first: { status: 401, ok: false } });
  await u.api.activeJobsPoll();
  assert.strictEqual(u.api.stopped(), true);
});

test('phone: activeJobsNow returns the jobs with the Active switch off, and the poll runs with it off', async () => {
  const off = phone({ on: false, first: { status: 200, ok: true, jobs: [JOB('1', 'sam', 'a')] } });
  assert.strictEqual(off.api.activeJobsWanted(), true, 'the switch no longer matters');
  await off.api.activeJobsPoll();
  assert.strictEqual(off.rec.apis.length, 1);
  assert.deepStrictEqual(Object.keys(off.api.activeJobsNow()), ['sam'], 'jobs are returned with the switch off');
  off.api.activeJobsSync();
  assert.strictEqual(off.rec.timers.length, 1, 'and the timer starts');
});

test('phone poll: does nothing when the page is hidden; sync starts a 15 s timer when wanted', async () => {
  const hid = phone({ hidden: true });
  await hid.api.activeJobsPoll(); hid.api.activeJobsSync();
  assert.strictEqual(hid.rec.apis.length + hid.rec.timers.length, 0);
  const on = phone();
  on.api.activeJobsSync();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(on.rec.apis.length, 1, 'polls at once');
  assert.strictEqual(on.rec.timers.length, 1);
  assert.strictEqual(on.rec.timers[0].ms, 15000);
  on.api.activeJobsSync();
  assert.strictEqual(on.rec.timers.length, 1, 'a second sync does not start a second timer');
  on.env.document.visibilityState = 'hidden';
  on.rec.listeners.visibilitychange();
  assert.deepStrictEqual(on.rec.cleared, [1]);
  assert.strictEqual(on.api.timer(), null);
});

test('phone poll: a changed job list redraws the agents screen once, an unchanged one does not, other screens are not drawn', async () => {
  const d = phone({ first: { status: 200, ok: true, jobs: [JOB('1', 'sam', 'a')] } });
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.renders, 1);
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.renders, 1, 'unchanged');
  d.resp.next = { status: 200, ok: true, jobs: [] };
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.renders, 2);
  assert.deepStrictEqual(d.api.activeJobsNow(), {});
  const other = phone({ screen: 'chat', first: { status: 200, ok: true, jobs: [JOB('1', 'sam', 'a')] } });
  await other.api.activeJobsPoll();
  assert.strictEqual(other.rec.renders, 0, 'not on the agents screen');
  assert.strictEqual(other.api.list().length, 1, 'but the list is kept for the next draw');
});

test('phone poll: after 60 s of failures the jobs are treated as none; activeJobsNow filters to known agents', async () => {
  const d = phone({ first: { status: 200, ok: true, jobs: [JOB('1', 'sam', 'a'), JOB('2', 'kim', 'x')] } });
  await d.api.activeJobsPoll();
  assert.deepStrictEqual(Object.keys(d.api.activeJobsNow()), ['sam'], 'kim is not in agents');
  d.resp.next = { throws: true };
  d.clock.now += 59000;
  await d.api.activeJobsPoll();
  assert.strictEqual(d.api.list().length, 2);
  assert.strictEqual(d.rec.renders, 1);
  d.clock.now += 2000;
  await d.api.activeJobsPoll();
  assert.deepStrictEqual(d.api.list(), []);
  assert.strictEqual(d.rec.renders, 2);
  assert.strictEqual(d.api.stopped(), false);
});

test('phone activeJobsRelabel rewrites the drawn labels in place and stops its timer off the agents screen', () => {
  // changed (Maestro 23:40): the label is two spans, name and tail
  const nm = { textContent: '' }, tl = { textContent: '' };
  const j = { textContent: '', title: '', querySelector: (s) => (s === '.ajl-name' ? nm : s === '.ajl-tail' ? tl : null) };
  const row = { dataset: { agent: 'sam' }, querySelector: (s) => (s === '.agent-job' ? j : null) };
  const d = phone({ rows: [row, { dataset: { agent: 'robin' }, querySelector: () => null }] });
  d.api.setJobs({ sam: { names: ['x', 'y'], since: d.clock.now - 7 * MIN, count: 2 } });
  d.api.setTick(9);
  d.api.activeJobsRelabel();
  assert.strictEqual(nm.textContent, 'Background job: x');
  assert.ok(!cut(mob, 'function activeJobsRelabel()', 'document.addEventListener(\'visibilitychange\', activeJobsSync);').includes('.active-sec'), 'every drawn row is relabelled, not only the Active section');
  assert.strictEqual(tl.textContent, ' + 1 more · 7 min');
  assert.strictEqual(j.title, 'x\ny');
  assert.deepStrictEqual(d.rec.cleared, [], 'still running');
  d.api.setJobs({});
  d.api.activeJobsRelabel();
  assert.deepStrictEqual(d.rec.cleared, [9], 'no jobs left: the timer stops');
  assert.strictEqual(d.api.tick(), null);
  const away = phone({ screen: 'chat' });
  away.api.setJobs({ sam: { names: ['x'], since: 1, count: 1 } });
  away.api.setTick(4);
  away.api.activeJobsRelabel();
  assert.deepStrictEqual(away.rec.cleared, [4]);
});

// agentRowHtml with the page's own esc
function phoneRow(over) {
  const env = Object.assign({
    unread: {}, live: {}, isBusy: () => false, statusKnown: true, busyText: () => 'busy', shortModel: (m) => 'm:' + m,
    activeJobLead: L.activeJobLead, activeJobLabel: L.activeJobLabel, activeJobTail: L.activeJobTail, activeJobTitle: L.activeJobTitle,
  }, over || {});
  const names = Object.keys(env);
  return new Function(...names, ESC_SRC + '\n' + ROW_SRC + '\nreturn agentRowHtml;')(...names.map(n => env[n]));
}
const jobInfo = (names, ago) => ({ names, since: Date.now() - (ago == null ? 4 * MIN + 500 : ago), count: names.length });

test('phone agentRowHtml: an idle agent with a job (a normal group row) carries the agent-job div "Background job: ..." with title, after the blurb line, idle dot, not busy', () => {
  const row = phoneRow();
  const h = row({ name: 'sam', display: 'Sam', model: 'x', blurb: 'helper' }, { job: jobInfo(['build', 'lint', 'test']) });
  assert.ok(h.includes('class="agent-row"'), h);
  assert.ok(h.includes('class="dot idle"'), h);
  assert.ok(h.includes('<div class="agent-job" title="build\nlint\ntest">'), h);
  assert.ok(h.includes('<span class="ajl-name">Background job: build</span><span class="ajl-tail"> + 2 more · 4 min</span></div>'), h);
  assert.ok(!h.includes('is-busy') && !h.includes('active-done') && !h.includes('⏳'));
  assert.ok(h.indexOf('class="agent-model"') > 0 && h.indexOf('class="agent-model"') < h.indexOf('class="agent-job"'), 'the job line follows the blurb');
});

test('phone agentRowHtml: job names are escaped in the text and in the title', () => {
  const row = phoneRow();
  const h = row({ name: 'sam', model: 'x' }, { job: jobInfo([`<b>&"'`, 'second']) });
  assert.ok(h.includes('Background job: &lt;b&gt;&amp;&quot;&#39;</span><span class="ajl-tail"> + 1 more'), h);
  assert.ok(h.includes('title="&lt;b&gt;&amp;&quot;&#39;\nsecond"'), h);
  assert.ok(!h.includes('<b>'), 'no raw markup from a job name');
  assert.strictEqual((h.match(/"/g) || []).length % 2, 0, 'attribute quotes stay balanced');
});

test('phone agentRowHtml: a really busy row with a job keeps its status line and shows the job line after it', () => {
  const row = phoneRow({ isBusy: (n) => n === 'sam' });
  const h = row({ name: 'sam', model: 'x' }, { active: true, job: jobInfo(['build']) });
  assert.ok(h.includes('class="agent-row is-busy"') && h.includes('class="dot busy"'), h);
  assert.ok(h.indexOf('class="agent-model working"') < h.indexOf('class="agent-job"'), 'job line after the status line');
});

test('phone agentRowHtml: a busy agent with a job keeps the busy look and the status line; an idle one with a job is a plain idle row (no hollow dot)', () => {
  const row = phoneRow({ isBusy: (n) => n === 'maestro', busyText: () => '⏳ replying · 3m' });
  const h = row({ name: 'maestro', model: 'x' }, { active: true, job: jobInfo(['live server'], 10 * 60 * MIN) });
  assert.ok(h.includes('class="agent-row is-busy"') && h.includes('class="dot busy"'), 'yellow dot: ' + h);
  assert.ok(h.includes('<div class="agent-model working">⏳ replying · 3m</div>'), 'the yellow status line');
  assert.ok(h.indexOf('class="agent-model working"') < h.indexOf('class="agent-job"'), 'the job line after the status');
  const idle = phoneRow()({ name: 'kim', model: 'x' }, { job: jobInfo(['backup']) });
  assert.ok(!idle.includes('joby') && !idle.includes('is-busy'), idle);
});

test('desktop activeDress: a busy agent keeps the busy look (yellow dot, status line copied from its row)', () => {
  for (const o of [{ status: { maestro: { busy: true } } }, { localBusy: new Map([['maestro', '2026-11-14T10:00:00Z']]) }]) {
    const d = desk(o);
    const { copy, info, dd } = freshCopy();
    const orig = el(''); const ol = el('agent-busy-line'); ol.textContent = '⏳ replying'; orig.appendChild(ol);
    const od = el('agent-status live-busy'); orig.appendChild(od);
    info.appendChild(el('agent-busy-line'));
    d.api.activeDress(copy, { name: 'maestro', doneAt: null }, orig);
    assert.ok(copy.classList.contains('is-busy'));
    assert.strictEqual(dd.className, 'agent-status live-busy', 'the yellow dot');
  }
});

test('turn bookkeeping: a turn_end leaves the agent busy while another of its turns is open', () => {
  const open = {};
  assert.strictEqual(L.activeTurnStart(open, 'maestro', 't1'), true);
  assert.strictEqual(L.activeTurnStart(open, 'maestro', 't2'), true, 'the next turn started before the first ended');
  assert.strictEqual(L.activeTurnEnd(open, 'maestro', 't1'), true, 't2 still open: busy');
  assert.strictEqual(L.activeTurnEnd(open, 'maestro', 't2'), false, 'nothing open: idle');
  assert.deepStrictEqual(open, {});
  assert.strictEqual(L.activeTurnEnd(open, 'maestro', 'never-seen'), false, 'an unknown turn on an idle agent: idle');
  L.activeTurnStart(open, 'sam', 'a'); L.activeTurnStart(open, 'sam', 'a');
  assert.deepStrictEqual(open.sam, ['a'], 'a replayed turn_start is not counted twice');
  for (let i = 0; i < 30; i++) L.activeTurnStart(open, 'kim', 'k' + i);
  assert.strictEqual(open.kim.length, 20, 'lost ends cannot pile up');
  assert.strictEqual(L.activeTurnStart(null, 'x', 'y'), false); assert.strictEqual(L.activeTurnEnd(open, '', 'y'), false);
});

test('both pages: turn_end clears busy only through activeTurnEnd, asks the hub again, and an idle snapshot clears open turns', () => {
  const ms = cut(mob, 'function onTurnEnd(', 'function ');
  assert.ok(ms.includes('if (!activeTurnEnd(openTurns, ev.agent, ev.turnId)) setLive(ev.agent, { busy: false });'), ms.slice(0, 300));
  assert.ok(ms.includes('if (ev.agent) pollStatusSoon();'));
  assert.ok(cut(mob, 'function onTurnStart(', 'function ').includes('activeTurnStart(openTurns, ev.agent, ev.turnId);'));
  assert.ok(cut(mob, 'function applySnapshot(', 'let wkGoneState').includes('if (!patch.busy) delete openTurns[name];'));
  const ds = cut(app, 'function onHubTurnEnd(', 'function ');
  assert.ok(ds.includes('if (!activeTurnEnd(openTurns, ev.agent, ev.turnId)) setAgentLive(ev.agent, { busy: false });'));
  assert.ok(ds.includes('if (ev.agent) scheduleWorkerStatusPoll();'));
  assert.ok(cut(app, 'async function onHubTurnStart(', 'function ').includes('activeTurnStart(openTurns, ev.agent, ev.turnId);'));
  assert.ok(cut(app, 'function applyStatusSnapshot(', 'let workerGoneState').includes('for (const n of Object.keys(openTurns)) if (map[n] ? !map[n].busy : !(namedOnly && busyIsWorker(n, agentStatus[n]))) delete openTurns[n];'));
});

test('phone agentRowHtml: without opts (or without a job) there is no job markup; done rows drop the job', () => {
  const row = phoneRow();
  for (const h of [row({ name: 'sam', model: 'x' }), row({ name: 'sam', model: 'x' }, undefined), row({ name: 'sam', model: 'x' }, {}), row({ name: 'sam', model: 'x' }, { active: true })]) {
    assert.ok(!h.includes('agent-job') && !h.includes('joby'), h);
  }
  const done = row({ name: 'sam', model: 'x' }, { done: true, job: jobInfo(['build']) });
  assert.ok(done.includes('active-done') && !done.includes('agent-job'), done);
});

test('phone renderAgents: the step gets busy only, the job goes to the Active rows and to the normal group rows; init and the switch start the poll', () => {
  const r = cut(mob, 'function renderAgents() {', 'function updateDots()');
  assert.ok(r.includes('activeJobs = activeJobsNow();'));
  assert.ok(/activeStep\(activeState, \{ busy: activeBusyNow\(\), now: Date\.now\(\)/.test(r) && !/jobs: activeJobs/.test(r), 'the step gets no jobs');
  assert.ok(r.includes('active: true, job: activeJobs[a.name]'));
  assert.ok(r.includes('html += agentRowHtml(a, { job: activeJobs[a.name] });'), 'normal group rows carry the job line');
  assert.ok(cut(mob, 'function toggleActiveTop() {', 'function activeBusyNow()').includes('activeJobsSync();'), 'the switch starts or stops the poll');
  assert.ok(/await loadAgents\(\);\s*activeJobsSync\(\);/.test(mob), 'started in init after loadAgents');
});

// ── review r1 follow-ups: answers out of order, stalled requests, expired lists ──
test('desktop poll: a late answer from an older request is dropped (the newest request decides)', async () => {
  const d = desk({ first: { defer: true, jobs: [JOB('1', 'sam', 'old')] } });
  const older = d.api.activeJobsPoll();                      // request 1, pending
  d.resp.next = { status: 200, ok: true, jobs: [] };
  await d.api.activeJobsPoll();                              // request 2 answers first: no jobs
  assert.deepStrictEqual(d.api.list(), []);
  d.rec.pending.shift()();                                   // request 1 answers late with the job still running
  await older;
  assert.deepStrictEqual(d.api.list(), [], 'the older answer does not bring the job back');
});
test('desktop poll: each request carries an abort signal; a list older than 60 s is not shown even without a failure', async () => {
  const d = desk({ first: { status: 200, ok: true, jobs: [JOB('1', 'sam', 'a')] } });
  await d.api.activeJobsPoll();
  assert.ok(d.rec.fetches[0][1].signal, 'abort signal (10 s timeout)');
  assert.strictEqual(d.api.fresh(), true);
  d.clock.now += 61000;                                       // e.g. the tab was hidden, or a request is stalled
  assert.strictEqual(d.api.fresh(), false, 'paintActiveSection then draws no jobs');
  const paints = d.rec.paints;
  await d.api.activeJobsPoll();                              // the same answer comes back
  assert.strictEqual(d.rec.paints, paints + 1, 'a good answer after expiry is drawn even when it is the same');
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.paints, paints + 1, 'and not again while nothing changes');
  assert.ok(app.includes('activeJobsFrom(activeJobsFresh() ? activeJobList : [], visible)') && mob.includes('activeJobsFrom(activeJobsFresh() ? activeJobList : [], agents.map(a => a.name))'), 'both pages draw only a fresh list');
  assert.ok(mob.includes("api('/api/jobs', ac ? { signal: ac.signal } : {})"), 'the phone request carries the signal too');
});
test('desktop poll: freshness is judged when the answer arrives (a request started at 55 s and answered at 62 s repaints)', async () => {
  const d = desk({ first: { status: 200, ok: true, jobs: [JOB('1', 'sam', 'a')] } });
  await d.api.activeJobsPoll();
  d.clock.now += 55000;
  d.resp.next = { defer: true, jobs: [JOB('1', 'sam', 'a')] };    // the same list, slow to answer
  const p = d.api.activeJobsPoll();
  d.clock.now += 7000;                                               // expired while the request was out
  assert.strictEqual(d.api.fresh(), false);
  const paints = d.rec.paints;
  d.rec.pending.shift()();
  await p;
  assert.strictEqual(d.rec.paints, paints + 1, 'the rows come back with the answer');
  assert.strictEqual(d.api.fresh(), true);
});
test('both pages drop a superseded answer after the body read as well', () => {
  for (const [page, open, close] of [[app, 'async function activeJobsPoll() {', "document.addEventListener('visibilitychange', activeJobsSync);"], [mob, 'async function activeJobsPoll() {', 'function activeJobsNow() {']]) {
    const src = cut(page, open, close);
    assert.ok(/const res = await [^\n]+\n\s*if \(seq !== activeJobsSeq\) return;/.test(src), 'checked after the request');
    assert.ok(/const d = await res\.json\(\); if \(seq !== activeJobsSeq\) return;/.test(src), 'checked after the body read');
    assert.ok(/\} catch \{\s*if \(seq !== activeJobsSeq\) return;/.test(src), 'and on failure');
    assert.ok(/finally \{\s*if \(to\) clearTimeout\(to\);/.test(src), 'the timeout is cleared on every path');
  }
});

// ── admin-only polling and the working-only filter ───────────────────────────────────────────────

test('desktop poll: a member never fetches /api/jobs (not at load, not on visibilitychange, not on the switch)', async () => {
  const m = desk({ me: { isAdmin: false } });
  assert.strictEqual(m.api.activeJobsWanted(), false);
  await m.api.activeJobsPoll(); m.api.activeJobsSync();
  m.rec.listeners.visibilitychange();
  m.env.document.visibilityState = 'hidden'; m.env.document.visibilityState = 'visible';
  m.rec.listeners.visibilitychange();
  m.api.activeJobsSync();   // what saveActiveTop does for the switch
  await new Promise(r => setImmediate(r));
  assert.strictEqual(m.rec.fetches.length, 0);
  assert.strictEqual(m.rec.timers.length, 0);
  assert.strictEqual(m.api.stopped(), false, 'nothing was asked, so nothing was refused');
});

test('desktop poll: no request until the signed-in user is known; an admin that becomes known starts it', async () => {
  const d = desk({ me: null });
  d.api.activeJobsSync(); await d.api.activeJobsPoll();
  d.rec.listeners.visibilitychange();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(d.rec.fetches.length, 0, 'unknown user: no fetch');
  assert.strictEqual(d.api.activeJobsWanted(), false);
  d.env.window.hubMe = { isAdmin: true };   // loadMe() sets this and runs activeJobsSync()
  d.api.activeJobsSync();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(d.rec.fetches.length, 1, 'a known admin polls at once');
  assert.strictEqual(d.rec.timers.length, 1);
  const lm = cut(app, 'async function loadMe()', 'paintSetupNotice();');
  assert.ok(lm.indexOf('window.hubMe = await r.json()') > 0 && lm.indexOf('window.hubMe = await r.json()') < lm.indexOf('activeJobsSync()'), 'loadMe re-runs the sync once hubMe is set');
});

test('phone poll: a member never fetches /api/jobs (not at load, not on visibilitychange, not on the switch)', async () => {
  const m = phone({ admin: false });
  assert.strictEqual(m.api.activeJobsWanted(), false);
  await m.api.activeJobsPoll(); m.api.activeJobsSync();
  m.env.document.visibilityState = 'visible';
  m.rec.listeners.visibilitychange();
  m.api.activeJobsSync();   // what toggleActiveTop does
  await new Promise(r => setImmediate(r));
  assert.strictEqual(m.rec.apis.length, 0);
  assert.strictEqual(m.rec.timers.length, 0);
  assert.ok(/await loadMe\(\);[\s\S]{0,400}?await loadAgents\(\);\s*activeJobsSync\(\);/.test(mob), 'hubMe is loaded before the poll starts');
});

// The phone's renderAgents run for real against stubs: the working-only filter and the job lines on group rows.
const PH_FILTER = cut(mob, '// Busy agents only (what the working chip', 'function updateDots()');
function phoneFilter(o) {
  const chip = { cls: new Set(), textContent: '', classList: { add: (c) => chip.cls.add(c), remove: (...cs) => cs.forEach(c => chip.cls.delete(c)), toggle: (c, f) => (f ? chip.cls.add(c) : chip.cls.delete(c)) } };
  const listEl = { innerHTML: '', addEventListener() {}, firstChild: null, querySelector: () => null };
  const env = {
    $: (id) => (id === 'working-chip' ? chip : id === 'agents-list' ? listEl : null),
    agents: [{ name: 'sam', category: 'worker' }, { name: 'robin', category: 'worker' }, { name: 'kim', category: 'lead' }],
    GROUPS: [{ key: 'lead', title: 'Leads' }, { key: 'worker', title: 'Workers' }], collapsed: {},
    live: o.live || {}, streams: new Map(), unread: {}, statusKnown: true, isBusy: (n) => !!(o.live && o.live[n] && o.live[n].busy),
    busyText: () => 'busy', shortModel: (m) => m, displayName: (n) => n,
    localStorage: { getItem: () => null }, matchMedia: () => ({ matches: true }), screen: 'agents',
    document: { visibilityState: 'visible', addEventListener() {} }, isAdmin: () => true, api: async () => ({}), setInterval: () => 0, clearInterval() {},
    activeBusyFrom: L.activeBusyFrom, activeJobsFrom: L.activeJobsFrom, activeJobLead: L.activeJobLead, activeJobLabel: L.activeJobLabel, activeJobTail: L.activeJobTail, activeJobTitle: L.activeJobTitle,
    activeInitial: L.activeInitial, activeStep: L.activeStep, activeMembersChanged: L.activeMembersChanged, activeTitle: L.activeTitle,
  };
  const names = Object.keys(env);
  const api = new Function(...names, 'let workingFilter = false;\n' + ESC_SRC + '\n' + PH_FILTER + `
    return { renderAgents, workingNames, setFilter: (v) => { workingFilter = v; }, filterOn: () => workingFilter, setList: (l) => { activeJobList = l; activeJobsOkAt = Date.now(); } };`)(...names.map(n => env[n]));
  return { api, chip, listEl };
}
const groupRows = (html) => html.slice(html.indexOf('data-group="worker"')).match(/data-agent="([^"]+)"/g) || [];

test('phone: a normal group row of an idle agent with a job carries the agent-job div "Background job: ..."; no Active section, no busy look', () => {
  const p = phoneFilter({});
  p.api.setList([JOB('1', 'sam', 'build', { startedAt: Date.now() - 4 * MIN - 500 })]);
  p.api.renderAgents();
  const html = p.listEl.innerHTML;
  const samRow = html.split('<button').find(b => b.includes('data-agent="sam"'));
  assert.ok(samRow.includes('<div class="agent-job"') && samRow.includes('Background job: build'), samRow);
  assert.ok(!html.includes('active-sec'), 'an agent with only a job is not in Active');
  assert.ok(!html.includes('is-busy'), 'and not busy');
  assert.strictEqual((html.match(/<div class="agent-job"/g) || []).length, 1, 'only sam has a job line');
});

test('phone working filter and chip list busy agents only: an agent with only a job is not listed; the working names are the busy ones', () => {
  const p = phoneFilter({});
  p.api.setList([JOB('1', 'sam', 'build')]);
  assert.deepStrictEqual(p.api.workingNames(), [], 'a job alone is not working');
  p.api.setFilter(true);
  p.api.renderAgents();
  assert.strictEqual(p.api.filterOn(), false, 'nothing is busy: the filter switches itself off (as before)');
  assert.ok(!p.chip.cls.has('on') && p.chip.textContent === '', 'the chip stays off for a job-only agent');
  const busy = phoneFilter({ live: { robin: { busy: true } } });
  busy.api.setList([JOB('1', 'sam', 'build')]);
  assert.deepStrictEqual(busy.api.workingNames(), ['robin'], 'only the busy agent');
  busy.api.setFilter(true);
  busy.api.renderAgents();
  assert.ok(busy.listEl.innerHTML.includes('Workers (1)') && groupRows(busy.listEl.innerHTML).includes('data-agent="robin"'));
  assert.ok(!busy.listEl.innerHTML.includes('data-agent="sam"'), 'sam (job only) is filtered out');
  assert.ok(busy.chip.textContent.includes('robin') && !busy.chip.textContent.includes('sam'));
  const src = cut(mob, 'function workingNames()', 'function renderWorkingChip()');
  assert.ok(!/activeJobs/.test(src), 'workingNames does not look at jobs');
  assert.ok(cut(mob, 'function renderAgents() {', 'function updateDots()').includes('if (workingFilter) g.items = g.items.filter(a => isBusy(a.name));'));
});

test('phone: with the filter on and nothing busy the list falls back to the whole list (the filter resets), and "No agent is working right now." stays for an empty filtered result', () => {
  assert.ok(cut(mob, 'function renderAgents() {', 'function updateDots()').includes("No agent is working right now."));
  const none = phoneFilter({});
  none.api.setFilter(true);
  none.api.renderAgents();
  assert.ok(none.listEl.innerHTML.includes('Leads') && none.listEl.innerHTML.includes('data-agent="robin"'));
});

// The desktop filter: paintAgentsWorking / toggleBusyFilter and the CSS that hides the other rows.
const DK_FILTER = cut(app, 'function busyIsWorker(', 'function fmtElapsedShort(') + '\n' + cut(app, 'function paintAgentsWorking()', '// Hub-wide worker freshness');
function deskFilter(o) {
  const mk = () => { const s = new Set(); return { cls: s, textContent: '', classList: { toggle: (c, f) => (f ? s.add(c) : s.delete(c)) } }; };
  const els = { 'agents-working': mk(), 'agent-list': mk() };
  const env = { document: { getElementById: (id) => els[id] || null }, agentStatus: o.status || {}, localBusy: new Map(), activePaintSoon() {} };
  const names = Object.keys(env);
  const api = new Function(...names, 'let busyFilterOn = false; let activeJobs = {};\n' + DK_FILTER + `
    return { toggleBusyFilter, paintAgentsWorking, setJobs: (j) => { activeJobs = j; }, on: () => busyFilterOn };`)(...names.map(n => env[n]));
  return { api, els };
}

test('desktop working chip and filter count busy agents only: an agent with only a running job is not counted; the CSS has no job-busy exception', () => {
  const d = deskFilter({});
  d.api.setJobs(L.activeJobsFrom([JOB('1', 'sam', 'build')], ['sam']));
  d.api.paintAgentsWorking();
  assert.ok(!d.els['agents-working'].cls.has('on'), 'the chip stays off for a job-only agent');
  d.api.toggleBusyFilter();
  assert.strictEqual(d.api.on(), false, 'the filter cannot be switched on with only a job running');
  assert.ok(!d.els['agent-list'].cls.has('busy-filter'));
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('#agent-list.busy-filter .agent-btn:not(.is-busy) { display: none; }'));
  assert.ok(html.includes('#agent-list.busy-filter .agent-group:not(:has(.agent-btn.is-busy)) { display: none; }'));
  assert.ok(/\.agent-btn \.agent-job-line \{/.test(html), 'the job line rule applies to every .agent-btn, not only Active copies');
  assert.ok(!/active-copy[^{]*agent-job-line/.test(html));
  const w = cut(app, 'function paintAgentsWorking()', '// Hub-wide worker freshness');
  assert.ok(w.includes('busySplit(agentStatus, [...localBusy.keys()])') && !/activeJobs/.test(w), 'the chip and the toggle look at busy agents only');
  const busy = deskFilter({ status: { robin: { busy: true } } });
  busy.api.setJobs(L.activeJobsFrom([JOB('1', 'sam', 'build')], ['sam']));
  busy.api.paintAgentsWorking();
  assert.ok(busy.els['agents-working'].textContent.startsWith('1 agent working'), 'robin only: ' + busy.els['agents-working'].textContent);
});

test('desktop working filter: nothing busy: toggle is a no-op; busy agents count', () => {
  const none = deskFilter({});
  none.api.toggleBusyFilter();
  assert.strictEqual(none.api.on(), false);
  const busy = deskFilter({ status: { robin: { busy: true } } });
  busy.api.toggleBusyFilter();
  assert.strictEqual(busy.api.on(), true);
  assert.ok(busy.els['agents-working'].textContent.startsWith('1 agent working'));
});
