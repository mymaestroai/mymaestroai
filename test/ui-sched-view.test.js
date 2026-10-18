'use strict';
// Task scheduler view (app.js, 📅 panel): a bar at the top picks the time range (Active by default: live tasks and
// running jobs only), the sections shown, and opens the new-task form, which is closed unless editing.
// The filter itself runs here in a vm on the page's own source; the layout is pinned as source strings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');
const index = read('index.html');

function pageView(stored) {
  const start = app.indexOf('    const schedEsc = ');
  const end = app.indexOf('    function schedBarHtml(');
  assert.ok(start > 0 && end > start, 'view helpers sit between schedEsc and schedBarHtml');
  const store = new Map(stored === undefined ? [] : [['hub-sched-view', stored]]);
  const ctx = vm.createContext({ localStorage: { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)) } });
  const api = vm.runInContext(`${app.slice(start, end)}\n;({ schedView, schedSaveView, schedKeep, schedHiddenNote })`, ctx);
  return { ...api, store };
}

const H = 3600e3, NOW = Date.parse('2026-10-17T20:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('the default view is Active with every section on; a bad or old stored value falls back to it', () => {
  for (const stored of [undefined, 'not json', '{"scope":"nonsense","hide":"tasks"}', 'null']) {
    const v = pageView(stored).schedView();
    assert.deepStrictEqual({ scope: v.scope, hide: [...v.hide] }, { scope: 'active', hide: [] }, `stored ${stored}`);
  }
  const p = pageView('{"scope":"week","hide":["md","bogus"]}');
  const v = p.schedView();
  assert.deepStrictEqual({ scope: v.scope, hide: [...v.hide] }, { scope: 'week', hide: ['md'] });
  p.schedSaveView({ scope: 'all', hide: [] });
  assert.strictEqual(p.store.get('hub-sched-view'), '{"scope":"all","hide":[]}');
});

test('Active keeps live tasks and running jobs only', () => {
  const { schedKeep } = pageView();
  const keep = (kind, x) => schedKeep(kind, x, 'active', NOW);
  assert.ok(keep('task', { status: 'active' }));
  assert.ok(keep('task', { status: 'paused' }));
  assert.ok(keep('task', { status: 'done', queued: true }), 'a task being delivered right now is live');
  for (const status of ['done', 'cancelled', 'missed', 'failed']) assert.ok(!keep('task', { status, lastRunAt: ago(H) }), status);
  assert.ok(keep('job', { status: 'running' }));
  assert.ok(keep('job', { status: 'cancelling' }));
  for (const status of ['finished', 'failed', 'cancelled', 'timed_out', 'lost']) assert.ok(!keep('job', { status, endedAt: ago(60e3) }), status);
  assert.ok(keep('md', { enabled: true }));
  assert.ok(!keep('md', { enabled: false }));
  assert.ok(!keep('run', { firedAt: ago(60e3) }), 'past runs are history, not active');
});

test('a time range adds what finished inside it, dated by its last activity', () => {
  const { schedKeep } = pageView();
  assert.ok(schedKeep('task', { status: 'cancelled', createdAt: ago(72 * H), updatedAt: ago(2 * H) }, 'day', NOW), 'cancelled today, created days ago');
  assert.ok(schedKeep('task', { status: 'done', createdAt: ago(30 * H), lastRun: { firedAt: ago(5 * H) } }, 'day', NOW));
  assert.ok(!schedKeep('task', { status: 'done', createdAt: ago(80 * H), lastRunAt: ago(50 * H) }, 'day', NOW));
  assert.ok(schedKeep('task', { status: 'done', createdAt: ago(80 * H), lastRunAt: ago(50 * H) }, 'week', NOW));
  assert.ok(schedKeep('job', { status: 'finished', startedAt: ago(26 * H), endedAt: ago(23 * H) }, 'day', NOW), 'ended inside the day');
  assert.ok(!schedKeep('job', { status: 'finished', startedAt: ago(49 * H), endedAt: ago(48 * H) }, 'day', NOW));
  assert.ok(!schedKeep('job', { status: 'failed', startedAt: ago(9 * 24 * H), endedAt: ago(8 * 24 * H) }, 'week', NOW));
  assert.ok(schedKeep('run', { firedAt: ago(H) }, 'day', NOW));
  assert.ok(schedKeep('run', { dueAt: ago(3 * 24 * H) }, 'week', NOW));
  assert.ok(schedKeep('mdrun', { timestamp: ago(H) }, 'day', NOW));
  assert.ok(!schedKeep('md', { enabled: false }, 'week', NOW), 'a disabled TASKS.md task has no date: Everything only');
  assert.ok(!schedKeep('task', { status: 'done' }, 'week', NOW), 'no date at all: not inside any range');
  for (const x of [{ status: 'done' }, { status: 'cancelled', createdAt: ago(400 * 24 * H) }]) assert.ok(schedKeep('task', x, 'all', NOW));
  assert.ok(schedKeep('md', { enabled: false }, 'all', NOW));
});

test('the note under a trimmed section counts what is hidden by status and offers Everything', () => {
  const { schedHiddenNote } = pageView();
  const a = { status: 'active' }, d1 = { status: 'done' }, d2 = { status: 'done' }, c = { status: 'cancelled' }, t = { status: 'timed_out' };
  const note = schedHiddenNote([a, d1, d2, c, t], [a]);
  assert.match(note, /^<p class="sched-more">Not shown: 2 done, 1 cancelled, 1 timed out\. <a href="#" onclick="schedSetScope\('all'\); return false">Show everything<\/a><\/p>$/);
  assert.strictEqual(schedHiddenNote([a, d1], [a, d1]), '', 'nothing hidden, no note');
  assert.match(schedHiddenNote([{ enabled: false }], []), /Not shown: 1 disabled\./);
  assert.match(schedHiddenNote([{ status: '<b>' }], []), /1 &lt;b&gt;/, 'statuses are escaped');
});

test('the bar sits at the top of the panel; the form opens from it and is closed unless editing', () => {
  assert.match(app, /<div id="sched-panel">\$\{flash \? [^\n]*\n\s*<div id="sched-bar" class="sched-bar">\$\{schedBarHtml\(!!edit\)\}<\/div>\n\s*<div class="gs-box" id="sched-form"\$\{edit \? '' : ' hidden'\}>/);
  assert.match(app, /const SCHED_SCOPES = \{ active: 'Active', day: 'Last 24 hours', week: 'Last 7 days', all: 'Everything' \};/);
  assert.match(app, /onclick="schedSetScope\('\$\{k\}'\)"/);
  assert.match(app, /onchange="schedToggleSection\('\$\{k\}', this\.checked\)"/);
  assert.match(app, /filter\(\(\[k\]\) => k !== 'runs' \|\| v\.scope !== 'active'\)/, 'no Run history switch under Active: it is history');
  assert.match(app, /function schedToggleForm\(\) \{\n\s*if \(schedEditId\) return schedAct\('canceledit'\);/);
  assert.match(app, /\$\{formOpen \? 'Hide form' : '＋ New task'\}/);
});

test('every section obeys the view, and the 5 s / 10 s refreshes reuse it', () => {
  assert.match(app, /async function jobsSectionHtml\(\) \{[\s\S]*?if \(v\.hide\.includes\('jobs'\)\) return '';[\s\S]*?const shown = data\.jobs\.filter\(j => schedKeep\('job', j, v\.scope, now\)\);/);
  assert.match(app, /\$\{schedHiddenNote\(data\.jobs, shown\)\}\$\{logBox\}/);
  assert.match(app, /function schedTablesHtml\(data\) \{\n\s*schedLast = data;/);
  assert.match(app, /if \(show\('runs'\) && ranged\) html \+= `<div class="gs-box"><h4>Run history<\/h4>/);
  assert.match(app, /'No active scheduled tasks\.'/);
  assert.match(app, /'No jobs running\.'/);
  assert.match(app, /refreshJobsSection\(\);\s+\/\/ jobs every 5 s\n\s*if \(\+\+schedTick % 2 === 0\) try \{ box\.innerHTML = schedTablesHtml\(await schedApi\(\)\); \} catch \{\}/);
  for (const cls of ['.sched-bar', '.sched-seg button.on', '.sched-sections label', '.sched-more']) assert.ok(index.includes(cls + ' {'), cls);
});

test('a task carries its last change time so a cancellation is dated', () => {
  assert.match(read('lib/scheduled-tasks.js'), /lastRunAt: t\.lastRunAt, updatedAt: t\.updatedAt \|\| undefined,/);
});
