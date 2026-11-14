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
  for (const n of ['activeJobsFrom', 'activeJobLabel', 'activeJobTitle']) {
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
  const rec = { paints: 0, fetches: [], timers: [], cleared: [], listeners: {} };
  const resp = { next: o.first || { status: 200, ok: true, jobs: [] } };
  const env = {
    activeTopOn: () => (o.on === undefined ? true : o.on),
    document: { visibilityState: 'hidden', addEventListener: (ev, fn) => { rec.listeners[ev] = fn; }, createElement: () => el('') },
    fetch: async (url, opts) => {
      rec.fetches.push([url, opts]);
      const r = resp.next;
      if (r.throws) throw new Error('offline');
      return { status: r.status, ok: r.ok, json: async () => ({ jobs: r.jobs }) };
    },
    setInterval: (fn, ms) => { rec.timers.push({ fn, ms }); return rec.timers.length; },
    clearInterval: (id) => { rec.cleared.push(id); },
    paintActiveSection: () => { rec.paints++; },
    Date: { now: () => clock.now },
    activeJobsFrom: L.activeJobsFrom, activeJobLabel: L.activeJobLabel, activeJobTitle: L.activeJobTitle,
  };
  const names = Object.keys(env);
  const api = new Function(...names, DESK_SRC + `
    return { activeDress, activeDressJob, activeJobsPoll, activeJobsSync, activeJobsWanted,
      list: () => activeJobList, jobs: () => activeJobs, setJobs: (v) => { activeJobs = v; }, timer: () => activeJobsTimer, stopped: () => activeJobsStopped };`)(...names.map(n => env[n]));
  env.document.visibilityState = o.hidden ? 'hidden' : 'visible';
  return { env, rec, clock, resp, api };
}
const JOB = (id, owner, name, extra) => Object.assign({ id, owner, name, status: 'running', startedAt: T }, extra);

test('desktop poll: fetches /api/jobs with credentials and stops for good after a 403', async () => {
  const d = desk({ first: { status: 403, ok: false } });
  await d.api.activeJobsPoll();
  assert.strictEqual(d.rec.fetches.length, 1);
  assert.deepStrictEqual(d.rec.fetches[0], ['/api/jobs', { credentials: 'include' }]);
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
  assert.strictEqual(line.textContent, '⏳ build <b> + 1 more · 4 min');
  assert.strictEqual(line.title, 'build <b>\nlint');
  assert.strictEqual(info.lastElementChild, line, 'after the busy line');
  d.clock.now += 2 * MIN;
  d.api.activeDressJob(copy, { name: 'sam', doneAt: null });
  assert.strictEqual(info.children.filter(c => c.className === 'agent-job-line').length, 1, 'rewritten in place, not duplicated');
  assert.ok(line.textContent.endsWith('6 min'), line.textContent);
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
  assert.ok(p.includes('activeJobs = activeJobsFrom(activeJobList, visible);'));
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
    activeJobsFrom: L.activeJobsFrom, activeJobLabel: L.activeJobLabel, activeJobTitle: L.activeJobTitle,
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
  const j = { textContent: '', title: '' };
  const row = { dataset: { agent: 'sam' }, querySelector: (s) => (s === '.agent-job' ? j : null) };
  const d = phone({ rows: [row, { dataset: { agent: 'robin' }, querySelector: () => null }] });
  d.api.setJobs({ sam: { names: ['x', 'y'], since: d.clock.now - 7 * MIN, count: 2 } });
  d.api.setTick(9);
  d.api.activeJobsRelabel();
  assert.strictEqual(j.textContent, '⏳ x + 1 more · 7 min');
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
    activeJobLabel: L.activeJobLabel, activeJobTitle: L.activeJobTitle,
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
  assert.ok(h.includes('⏳ build + 2 more · 4 min</div>'), h);
  assert.ok(!h.includes('is-busy') && !h.includes('active-done'));
  assert.ok(!h.includes('agent-model'), 'a job-only row has no status or blurb line');
});

test('phone agentRowHtml: job names are escaped in the text and in the title', () => {
  const row = phoneRow();
  const h = row({ name: 'sam', model: 'x' }, { active: true, jobOnly: true, job: jobInfo([`<b>&"'`, 'second']) });
  assert.ok(h.includes('&lt;b&gt;&amp;&quot;&#39; + 1 more'), h);
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
