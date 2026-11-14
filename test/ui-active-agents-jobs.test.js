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

test('activeJobLabel: oldest name, "+ N more", and the elapsed time', () => {
  const one = { names: ['build'], since: T, count: 1 };
  assert.strictEqual(L.activeJobLabel(one, T + 30000), 'build · <1 min');
  assert.strictEqual(L.activeJobLabel(one, T + 4 * MIN + 10000), 'build · 4 min');
  assert.strictEqual(L.activeJobLabel(one, T + 65 * MIN), 'build · 1 h 5 min');
  assert.strictEqual(L.activeJobLabel(one, T + 120 * MIN), 'build · 2 h');
  assert.strictEqual(L.activeJobLabel({ names: ['a', 'b', 'c'], since: T, count: 3 }, T + 4 * MIN), 'a + 2 more · 4 min');
  assert.strictEqual(L.activeJobLabel({ names: ['a', 'b'], since: T, count: 2 }, T + 4 * MIN), 'a + 1 more · 4 min');
  assert.strictEqual(L.activeJobLabel(one, T - 5000), 'build · <1 min', 'a clock that runs behind never shows a negative time');
  assert.strictEqual(L.activeJobLabel(null, T), '');
  assert.strictEqual(L.activeJobLabel(undefined, T), '');
});

test('activeJobTitle: the names, one per line', () => {
  assert.strictEqual(L.activeJobTitle({ names: ['a', 'b', 'c'], since: T, count: 3 }), 'a\nb\nc');
  assert.strictEqual(L.activeJobTitle({ names: ['a'], since: T, count: 1 }), 'a');
  assert.strictEqual(L.activeJobTitle(null), '');
});

const S = (name, since, extra) => Object.assign({ name, since, doneAt: null }, extra);

test('activeStep with jobs: a job-only agent joins with jobOnly true', () => {
  const st = L.activeStep(L.activeInitial(), { busy: {}, jobs: { sam: { names: ['x'], since: T, count: 1 } }, now: T + 10 });
  assert.deepStrictEqual(st.rows, [{ name: 'sam', since: T, doneAt: null, jobOnly: true }]);
  const both = L.activeStep(L.activeInitial(), { busy: { robin: T + 5 }, jobs: { sam: { names: ['x'], since: T, count: 1 } }, now: T + 10 });
  assert.deepStrictEqual(both.rows.map(r => [r.name, r.jobOnly]), [['sam', true], ['robin', false]], 'ordered by since; a really busy agent is not jobOnly');
});

test('activeStep with jobs: when the job-only agent also becomes busy it stays one row, jobOnly false', () => {
  const jobs = { sam: { names: ['x'], since: T, count: 1 } };
  const a = L.activeStep(L.activeInitial(), { jobs, now: T + 10 });
  const b = L.activeStep(a, { busy: { sam: T + 20 }, jobs, now: T + 30 });
  assert.deepStrictEqual(b.rows, [{ name: 'sam', since: T, doneAt: null, jobOnly: false }]);
  const c = L.activeStep(b, { busy: {}, jobs, now: T + 40 });
  assert.deepStrictEqual(c.rows.map(r => [r.name, r.jobOnly]), [['sam', true]], 'busy ends, job still runs: back to jobOnly, same row');
});

test('activeStep with jobs: when the job ends and the agent is not busy the row is done, then leaves after lingerMs', () => {
  const jobs = { sam: { names: ['x'], since: T, count: 1 } };
  const a = L.activeStep(L.activeInitial(), { jobs, now: T + 10 });
  const d = L.activeStep(a, { busy: {}, jobs: {}, now: T + 1000 });
  assert.deepStrictEqual(d.rows, [{ name: 'sam', since: T, doneAt: T + 1000, jobOnly: false }]);
  assert.strictEqual(L.activeStep(d, { now: T + 1000 + 2999 }).rows.length, 1, 'still lingering');
  assert.strictEqual(L.activeStep(d, { now: T + 1000 + 3000 }).rows.length, 0, 'gone after 3000 ms');
  assert.strictEqual(L.activeStep(d, { now: T + 1000 + 500, lingerMs: 500 }).rows.length, 0, 'custom lingerMs');
  assert.strictEqual(L.activeStep(d, { jobs, now: T + 1100 }).rows[0].doneAt, null, 'a new job before the linger ends revives the row');
});

test('activeStep with jobs: held blocks joining; enabled false gives no rows', () => {
  const jobs = { sam: { names: ['x'], since: T, count: 1 } };
  assert.deepStrictEqual(L.activeStep(L.activeInitial(), { jobs, held: true, now: T }).rows, []);
  const a = L.activeStep(L.activeInitial(), { jobs, now: T });
  const held = L.activeStep(a, { jobs: { sam: jobs.sam, kim: { names: ['y'], since: T + 1, count: 1 } }, held: true, now: T + 5 });
  assert.deepStrictEqual(held.rows.map(r => r.name), ['sam'], 'a new job-only agent does not join while held');
  assert.deepStrictEqual(L.activeStep(a, { jobs, enabled: false, now: T }).rows, []);
});

test('activeChanged is true on a jobOnly flip alone; activeMembersChanged is not', () => {
  const a = { rows: [S('sam', T, { jobOnly: true })] };
  const b = { rows: [S('sam', T, { jobOnly: false })] };
  assert.strictEqual(L.activeChanged(a, b), true);
  assert.strictEqual(L.activeChanged(b, a), true);
  assert.strictEqual(L.activeChanged(a, { rows: [S('sam', T, { jobOnly: true })] }), false);
  assert.strictEqual(L.activeChanged({ rows: [S('sam', T)] }, { rows: [S('sam', T, { jobOnly: false })] }), false, 'missing and false are the same');
  assert.strictEqual(L.activeMembersChanged(a, b), false);
});

test('the jobs helpers exist exactly once in lib, app.js and mobile.js (inside the byte-identical block)', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'lib/ui-active-agents.js'), 'utf8');
  for (const n of ['activeJobsFrom', 'activeJobLabel', 'activeJobTail', 'activeJobTitle']) {
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
    document: { visibilityState: 'hidden', addEventListener: (ev, fn) => { rec.listeners[ev] = fn; }, createElement: () => el('') },
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
    activeJobsFrom: L.activeJobsFrom, activeJobLabel: L.activeJobLabel, activeJobTail: L.activeJobTail, activeJobTitle: L.activeJobTitle,
  };
  const names = Object.keys(env);
  const api = new Function(...names, DESK_SRC + `
    return { activeDress, activeDressJob, activeJobsPoll, activeJobsSync, activeJobsWanted,
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

test('desktop poll: does nothing when the switch is off or the tab is hidden', async () => {
  const off = desk({ on: false });
  await off.api.activeJobsPoll();
  off.api.activeJobsSync();
  assert.strictEqual(off.rec.fetches.length, 0);
  assert.strictEqual(off.rec.timers.length, 0);
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

test('desktop activeDressJob writes the "⏳ " label and title, keeps one line last, and removes it when there is no job', () => {
  const d = desk();
  const { copy, info } = freshCopy();
  const busyLine = el('agent-busy-line'); info.appendChild(busyLine);
  d.api.setJobs({ sam: { names: ['build <b>', 'lint'], since: d.clock.now - 4 * MIN - 1000, count: 2 } });
  d.api.activeDressJob(copy, { name: 'sam', doneAt: null });
  const line = info.querySelector('.agent-job-line');
  assert.ok(line, 'line added');
  // changed (Maestro 23:40): the name and the tail are separate spans, so only the name can be cut short
  const part = (c) => line.children.find(x => x.className === c);
  assert.strictEqual(part('ajl-name').textContent, '⏳ build <b>');
  assert.strictEqual(part('ajl-tail').textContent, ' + 1 more · 4 min');
  assert.strictEqual(line.children.length, 2);
  assert.strictEqual(line.title, 'build <b>\nlint');
  assert.strictEqual(info.lastElementChild, line, 'after the busy line');
  d.clock.now += 2 * MIN;
  d.api.activeDressJob(copy, { name: 'sam', doneAt: null });
  assert.strictEqual(info.children.filter(c => c.className === 'agent-job-line').length, 1, 'rewritten in place, not duplicated');
  assert.strictEqual(part('ajl-tail').textContent, ' + 1 more · 6 min', 'the tail is rewritten in place');
  assert.strictEqual(line.children.length, 2, 'no extra spans');
  info.appendChild(el('agent-busy-line'));   // something appended after it: the job line moves back to the end
  d.api.activeDressJob(copy, { name: 'sam', doneAt: null });
  assert.strictEqual(info.lastElementChild, line);
  d.api.activeDressJob(copy, { name: 'sam', doneAt: 5 });
  assert.strictEqual(info.querySelector('.agent-job-line'), null, 'a done row has no job line');
  d.api.activeDressJob(copy, { name: 'sam', doneAt: null });
  assert.ok(info.querySelector('.agent-job-line'));
  d.api.setJobs({});
  d.api.activeDressJob(copy, { name: 'sam', doneAt: null });
  assert.strictEqual(info.querySelector('.agent-job-line'), null, 'no job: the line is removed');
  d.api.activeDressJob(copy, { name: 'sam', doneAt: null });   // and removing nothing is fine
});

test('desktop activeDress: a jobOnly row gets class active-joby and a hollow dot, others do not', () => {
  const d = desk();
  const { copy, info, dd } = freshCopy();
  info.appendChild(el('agent-busy-line'));
  d.api.activeDress(copy, { name: 'sam', doneAt: null, jobOnly: true }, null);
  assert.ok(copy.classList.contains('active-joby'));
  assert.strictEqual(dd.className, 'agent-status live-joby');
  assert.strictEqual(info.querySelector('.agent-busy-line'), null, 'no status line on a job-only row');
  assert.ok(!copy.classList.contains('is-busy'));
  d.api.activeDress(copy, { name: 'sam', doneAt: null, jobOnly: false }, null);
  assert.ok(!copy.classList.contains('active-joby'), 'busy again: the class goes');
  assert.ok(copy.classList.contains('is-busy'));
  d.api.activeDress(copy, { name: 'sam', doneAt: 9, jobOnly: true }, null);
  assert.ok(!copy.classList.contains('active-joby'), 'a done row is not job-only');
  assert.ok(copy.classList.contains('active-done'));
});

test('desktop paintActiveSection passes jobs from the polled list to activeStep', () => {
  const p = cut(app, 'function paintActiveSection(', "// Agents' detached background jobs (GET /api/jobs");
  assert.ok(app.indexOf('const ACTIVE_JOBS_MS') < app.indexOf('function paintActiveSection('), 'the job state exists before any paint');
  assert.ok(p.includes('activeJobs = activeTopOn() ? activeJobsFrom(activeJobsFresh() ? activeJobList : [], visible) : {};'), 'changed: a list older than 60 s is not shown, none with the switch off');
  assert.ok(/activeStep\(activeState, \{ busy, jobs: activeJobs, now: Date\.now\(\)/.test(p));
  assert.ok(app.includes('activeDressJob(copy, row);'));
  const save = cut(app, 'function saveActiveTop(', 'function activeDress(');
  assert.ok(save.includes('activeJobsSync();') && save.indexOf('activeJobsSync();') < save.indexOf('paintActiveSection(true)'), 'the switch starts or stops the poll');
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
    activeJobsFrom: L.activeJobsFrom, activeJobLabel: L.activeJobLabel, activeJobTail: L.activeJobTail, activeJobTitle: L.activeJobTitle,
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

test('phone poll: does nothing when the switch is off or the page is hidden; sync starts a 15 s timer when wanted', async () => {
  const off = phone({ on: false });
  await off.api.activeJobsPoll(); off.api.activeJobsSync();
  assert.strictEqual(off.rec.apis.length + off.rec.timers.length, 0);
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
  assert.strictEqual(nm.textContent, '⏳ x');
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
    activeJobLabel: L.activeJobLabel, activeJobTail: L.activeJobTail, activeJobTitle: L.activeJobTitle,
  }, over || {});
  const names = Object.keys(env);
  return new Function(...names, ESC_SRC + '\n' + ROW_SRC + '\nreturn agentRowHtml;')(...names.map(n => env[n]));
}
const jobInfo = (names, ago) => ({ names, since: Date.now() - (ago == null ? 4 * MIN + 500 : ago), count: names.length });

test('phone agentRowHtml: a jobOnly row has active-joby, the joby dot, and the agent-job div with label and title', () => {
  const row = phoneRow();
  const h = row({ name: 'sam', display: 'Sam', model: 'x' }, { active: true, jobOnly: true, job: jobInfo(['build', 'lint', 'test']) });
  assert.ok(h.includes('class="agent-row active-joby"'), h);
  assert.ok(h.includes('class="dot joby"'), h);
  assert.ok(h.includes('<div class="agent-job" title="build\nlint\ntest">'), h);
  assert.ok(h.includes('<span class="ajl-name">⏳ build</span><span class="ajl-tail"> + 2 more · 4 min</span></div>'), h);   // changed (Maestro 23:40): name and tail spans
  assert.ok(!h.includes('is-busy') && !h.includes('active-done'));
  assert.ok(!h.includes('agent-model'), 'a job-only row has no status or blurb line');
});

test('phone agentRowHtml: job names are escaped in the text and in the title', () => {
  const row = phoneRow();
  const h = row({ name: 'sam', model: 'x' }, { active: true, jobOnly: true, job: jobInfo([`<b>&"'`, 'second']) });
  assert.ok(h.includes('⏳ &lt;b&gt;&amp;&quot;&#39;</span><span class="ajl-tail"> + 1 more'), h);   // changed: name and tail spans
  assert.ok(h.includes('title="&lt;b&gt;&amp;&quot;&#39;\nsecond"'), h);
  assert.ok(!h.includes('<b>'), 'no raw markup from a job name');
  assert.strictEqual((h.match(/"/g) || []).length % 2, 0, 'attribute quotes stay balanced');
});

test('phone agentRowHtml: a really busy row with a job keeps its status line and shows the job line after it', () => {
  const row = phoneRow({ isBusy: (n) => n === 'sam' });
  const h = row({ name: 'sam', model: 'x' }, { active: true, jobOnly: false, job: jobInfo(['build']) });
  assert.ok(h.includes('class="agent-row is-busy"') && h.includes('class="dot busy"'), h);
  assert.ok(!h.includes('active-joby'));
  assert.ok(h.indexOf('class="agent-model working"') < h.indexOf('class="agent-job"'), 'job line after the status line');
});

test('phone agentRowHtml: a busy agent keeps the busy look even when its row says jobOnly (owner report 05:52)', () => {
  const row = phoneRow({ isBusy: (n) => n === 'maestro', busyText: () => '⏳ replying · 3m' });
  const h = row({ name: 'maestro', model: 'x' }, { active: true, jobOnly: true, job: jobInfo(['live server'], 10 * 60 * MIN) });
  assert.ok(h.includes('class="agent-row is-busy"') && h.includes('class="dot busy"'), 'yellow dot: ' + h);
  assert.ok(!h.includes('active-joby') && !h.includes('dot joby'), 'never the hollow job-only dot for a busy agent');
  assert.ok(h.includes('<div class="agent-model working">⏳ replying · 3m</div>'), 'the yellow status line');
  assert.ok(h.indexOf('class="agent-model working"') < h.indexOf('class="agent-job"'), 'the job line after the status');
  const idle = phoneRow()({ name: 'kim', model: 'x' }, { active: true, jobOnly: true, job: jobInfo(['backup']) });
  assert.ok(idle.includes('class="dot joby"') && idle.includes('active-joby'), 'idle with a job: the job-only look stays');
});

test('desktop activeDress: a busy agent keeps the busy look even when its row says jobOnly', () => {
  for (const o of [{ status: { maestro: { busy: true } } }, { localBusy: new Map([['maestro', '2026-11-14T10:00:00Z']]) }]) {
    const d = desk(o);
    const { copy, info, dd } = freshCopy();
    const orig = el(''); const ol = el('agent-busy-line'); ol.textContent = '⏳ replying'; orig.appendChild(ol);
    const od = el('agent-status live-busy'); orig.appendChild(od);
    info.appendChild(el('agent-busy-line'));
    d.api.activeDress(copy, { name: 'maestro', doneAt: null, jobOnly: true }, orig);
    assert.ok(!copy.classList.contains('active-joby'), 'no job-only class for a busy agent');
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
  assert.ok(/if \(!\(ev && ev\.agent && activeTurnEnd\(openTurns, ev\.agent, ev\.turnId\)\)\) setLive\(ev\.agent, \{ busy: false \}\);/.test(ms), ms.slice(0, 300));
  assert.ok(ms.includes('pollStatusSoon();'));
  assert.ok(cut(mob, 'function onTurnStart(', 'function ').includes('activeTurnStart(openTurns, ev.agent, ev.turnId);'));
  assert.ok(cut(mob, 'function applySnapshot(', 'let wkGoneState').includes('if (!patch.busy) delete openTurns[name];'));
  const ds = cut(app, 'function onHubTurnEnd(', 'function ');
  assert.ok(/if \(!\(ev && ev\.agent && activeTurnEnd\(openTurns, ev\.agent, ev\.turnId\)\)\) setAgentLive\(ev\.agent, \{ busy: false \}\);/.test(ds));
  assert.ok(ds.includes('scheduleWorkerStatusPoll();'));
  assert.ok(cut(app, 'async function onHubTurnStart(', 'function ').includes('activeTurnStart(openTurns, ev.agent, ev.turnId);'));
  assert.ok(cut(app, 'function applyStatusSnapshot(', 'let workerGoneState').includes('if (!s.busy) delete openTurns[name];'));
});

test('phone agentRowHtml: without opts (or without a job) there is no job markup; done rows drop the job', () => {
  const row = phoneRow();
  for (const h of [row({ name: 'sam', model: 'x' }), row({ name: 'sam', model: 'x' }, undefined), row({ name: 'sam', model: 'x' }, {}), row({ name: 'sam', model: 'x' }, { active: true, jobOnly: false })]) {
    assert.ok(!h.includes('agent-job') && !h.includes('active-joby') && !h.includes('joby'), h);
  }
  const done = row({ name: 'sam', model: 'x' }, { done: true, jobOnly: true, job: jobInfo(['build']) });
  assert.ok(done.includes('active-done') && !done.includes('agent-job') && !done.includes('active-joby'), done);
});

test('phone renderAgents passes jobs to the step and the job to the Active rows; init and the switch start the poll', () => {
  const r = cut(mob, 'function renderAgents() {', 'function updateDots()');
  assert.ok(r.includes('activeJobs = activeJobsNow();'));
  assert.ok(/jobs: activeJobs, now: Date\.now\(\)/.test(r));
  assert.ok(r.includes('jobOnly: !!row.jobOnly, job: activeJobs[a.name]'));
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

// The phone's renderAgents run for real against stubs: the working-only filter with a job-only agent.
const PH_FILTER = cut(mob, '// Busy agents plus those the Active section shows', 'function updateDots()');
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
    activeBusyFrom: L.activeBusyFrom, activeJobsFrom: L.activeJobsFrom, activeJobLabel: L.activeJobLabel, activeJobTail: L.activeJobTail, activeJobTitle: L.activeJobTitle,
    activeInitial: L.activeInitial, activeStep: L.activeStep, activeMembersChanged: L.activeMembersChanged, activeTitle: L.activeTitle,
  };
  const names = Object.keys(env);
  const api = new Function(...names, 'let workingFilter = false;\n' + ESC_SRC + '\n' + PH_FILTER + `
    return { renderAgents, setFilter: (v) => { workingFilter = v; }, setList: (l) => { activeJobList = l; activeJobsOkAt = Date.now(); } };`)(...names.map(n => env[n]));
  return { api, chip, listEl };
}
const groupRows = (html) => html.slice(html.indexOf('data-group="worker"')).match(/data-agent="([^"]+)"/g) || [];

test('phone working filter: an agent with only a running job is listed in its group and the empty message is not shown', () => {
  const p = phoneFilter({});
  p.api.setList([JOB('1', 'sam', 'build')]);
  p.api.setFilter(true);
  p.api.renderAgents();
  assert.ok(!p.listEl.innerHTML.includes('No agent is working right now'), p.listEl.innerHTML);
  assert.ok(p.listEl.innerHTML.includes('Workers (1)'), 'the group count agrees with the Active section');
  assert.ok(!p.listEl.innerHTML.includes('Leads'), 'agents without work stay hidden');
  assert.ok(groupRows(p.listEl.innerHTML).includes('data-agent="sam"'));
  assert.ok(!p.listEl.innerHTML.includes('data-agent="robin"'));
  assert.ok(p.chip.cls.has('on') && p.chip.cls.has('filtering') && p.chip.textContent.includes('sam'));
});

test('phone working filter: no jobs keeps the old behaviour (only busy agents; the empty message when none)', () => {
  const none = phoneFilter({});
  none.api.setFilter(true);
  none.api.renderAgents();
  assert.ok(none.listEl.innerHTML.includes('Leads') && none.listEl.innerHTML.includes('data-agent="robin"'), 'nobody working: the filter resets itself and the whole list shows (as before)');
  const busy = phoneFilter({ live: { robin: { busy: true } } });
  busy.api.setFilter(true);
  busy.api.renderAgents();
  assert.ok(busy.listEl.innerHTML.includes('Workers (1)') && groupRows(busy.listEl.innerHTML).includes('data-agent="robin"') && !busy.listEl.innerHTML.includes('data-agent="sam"'));
});

// The desktop filter: busySplitJobs / paintAgentsWorking / toggleBusyFilter and the CSS that hides the other rows.
const DK_FILTER = cut(app, 'function busyIsWorker(', 'function fmtElapsedShort(') + '\n' + cut(app, '// busySplit plus the agents the Active section shows', '// Hub-wide worker freshness');
function deskFilter(o) {
  const mk = () => { const s = new Set(); return { cls: s, textContent: '', classList: { toggle: (c, f) => (f ? s.add(c) : s.delete(c)) } }; };
  const els = { 'agents-working': mk(), 'agent-list': mk() };
  const env = { document: { getElementById: (id) => els[id] || null }, agentStatus: o.status || {}, localBusy: new Map(), activePaintSoon() {} };
  const names = Object.keys(env);
  const api = new Function(...names, 'let busyFilterOn = false; let activeJobs = {};\n' + DK_FILTER + `
    return { toggleBusyFilter, paintAgentsWorking, setJobs: (j) => { activeJobs = j; }, on: () => busyFilterOn };`)(...names.map(n => env[n]));
  return { api, els };
}

test('desktop working filter: an agent with only a running job counts as working (chip, toggle, filter class)', () => {
  const d = deskFilter({});
  d.api.setJobs(L.activeJobsFrom([JOB('1', 'sam', 'build')], ['sam']));
  d.api.toggleBusyFilter();
  assert.strictEqual(d.api.on(), true, 'the filter can be switched on with only a job running');
  assert.ok(d.els['agent-list'].cls.has('busy-filter'));
  assert.ok(d.els['agents-working'].cls.has('on') && d.els['agents-working'].textContent.startsWith('1 agent working'), d.els['agents-working'].textContent);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('#agent-list.busy-filter .agent-btn:not(.is-busy):not(.job-busy) { display: none; }'));
  assert.ok(html.includes('#agent-list.busy-filter .agent-group:not(:has(.agent-btn.is-busy, .agent-btn.job-busy)) { display: none; }'));
  const p = cut(app, 'function paintActiveSection(', "// Agents' detached background jobs (GET /api/jobs");
  assert.ok(p.includes("classList.toggle('job-busy', n in activeJobs)"), 'rows of agents with a job are marked as working');
  assert.ok(cut(app, 'async function activeJobsPoll()', 'document.addEventListener(\'visibilitychange\', activeJobsSync);').includes('paintActiveSection();\n      paintAgentsWorking();'), 'a new list refreshes the chip');
  d.api.setJobs({});
  d.api.paintAgentsWorking();
  assert.strictEqual(d.api.on(), false, 'the job ended: the filter switches itself off');
});

test('desktop working filter: without jobs nothing changes (nothing busy: toggle is a no-op; busy agents count as before)', () => {
  const none = deskFilter({});
  none.api.toggleBusyFilter();
  assert.strictEqual(none.api.on(), false);
  const busy = deskFilter({ status: { robin: { busy: true } } });
  busy.api.toggleBusyFilter();
  assert.strictEqual(busy.api.on(), true);
  assert.ok(busy.els['agents-working'].textContent.startsWith('1 agent working'));
});
