'use strict';
// The "Working on" panel (lib/ui-hand-off-card.js: panelModel, renderPanel, track): the answer of GET /api/agents/<name>/working-on.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/ui-hand-off-card');

const NOW = Date.parse('2026-06-01T12:00:00Z');
const MIN = 60 * 1000, HOUR = 60 * MIN;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const fmt = (t) => new Date(t).toISOString().slice(11, 16);   // "12:30", fixed for the tests
const ho = (o) => ({ id: 'h1', target: 'scout', topic: 'Find prices', state: 'running', createdAt: iso(HOUR), folder: '/s/scout/hand-offs/job-1', statusLine: null, changedAt: iso(12 * MIN), ...o });

test('panelModel: count adds open hand-offs, jobs and workers; summary says things', () => {
  const m = H.panelModel({
    handOffs: [ho({ id: 'a' }), ho({ id: 'b', state: 'queued' })],
    jobs: [{ id: 'j1', name: 'Nightly sync', startedAt: iso(HOUR), status: 'running' }],
    jobCount: 1, workers: [{ id: 'w1', label: 'Research', model: 'x', startedAt: iso(30 * MIN) }, { id: 'w2', label: 'Draft', startedAt: iso(20 * MIN) }], nextCheck: null,
  }, { now: NOW, fmt });
  assert.equal(m.show, 'full');
  assert.equal(m.summary, 'Working on: 5 things');
  assert.equal(m.nextCheckText, '');
  const one = H.panelModel({ handOffs: [ho({})], jobs: [], workers: [] }, { now: NOW, fmt });
  assert.equal(one.summary, 'Working on: 1 thing');
});

test('panelModel: ended hand-offs do not count, but keep the panel full while they are kept', () => {
  const ended = ho({ id: 'd', state: 'done', endedAt: iso(2 * MIN), reportedAt: iso(MIN) });
  const m = H.panelModel({ handOffs: [ended], jobs: [], workers: [] }, { now: NOW, fmt });
  assert.equal(m.show, 'full');
  assert.equal(m.count, 0);
  assert.equal(m.rows.length, 1);
  const gone = H.panelModel({ handOffs: [{ ...ended, reportedAt: iso(11 * MIN) }], jobs: [], workers: [] }, { now: NOW, fmt });
  assert.equal(gone.show, 'hidden');
});

test('panelModel: rows come in order hand-offs, jobs, helpers; kind labels and buttons', () => {
  const m = H.panelModel({
    handOffs: [ho({ id: 'a', targetDisplay: 'Scout' })],
    jobs: [{ id: 'j1', name: 'Nightly sync', startedAt: '2026-06-01T11:02:00Z', status: 'running' }],
    jobCount: 1, workers: [{ id: 'w1', label: 'Research', startedAt: '2026-06-01T11:40:00Z' }, { id: 'w2', label: 'Draft', startedAt: '2026-06-01T11:10:00Z' }],
  }, { now: NOW, fmt });
  assert.deepEqual(m.rows.map((r) => r.kind), ['handoff', 'job', 'workers']);
  assert.equal(m.rows[0].kindLabel, 'Handed to Scout');
  assert.equal(m.rows[0].title, 'Find prices', 'the hand-off row names the work (its topic), not "Task for <agent>"');
  assert.deepEqual(m.rows[0].buttons, ['status'], 'Status only, no Stop on a hand-off');
  assert.deepEqual(m.rows[1], { kind: 'job', kindLabel: 'Background job', title: 'Nightly sync', sub: 'Running since 11:02', buttons: ['stop'], jobId: 'j1' });
  assert.equal(m.rows[2].kindLabel, 'Helpers');
  assert.equal(m.rows[2].title, '2 temporary workers');
  assert.equal(m.rows[2].sub, 'Research · Draft · since 11:10', 'earliest start');
  assert.deepEqual(m.rows[2].buttons, ['stop']);
  assert.deepEqual(m.rows[2].workers.map((w) => w.id), ['w1', 'w2']);
  const one = H.panelModel({ handOffs: [], jobs: [], workers: [{ id: 'w1', label: 'Research', startedAt: '2026-06-01T11:40:00Z' }] }, { now: NOW, fmt });
  assert.equal(one.rows[0].title, '1 temporary worker');
});

test('panelModel: a hand-off without a display name uses its name; the target is the last fallback', () => {
  assert.equal(H.panelModel({ handOffs: [ho({ targetName: 'scout-1' })] }, { now: NOW }).rows[0].kindLabel, 'Handed to scout-1');
  assert.equal(H.panelModel({ handOffs: [ho({})] }, { now: NOW }).rows[0].kindLabel, 'Handed to scout');
});

test('panelModel: a member gets one jobs row (a count, no names, no buttons)', () => {
  const m = H.panelModel({ handOffs: [], jobs: null, jobCount: 1, workers: [] }, { now: NOW });
  assert.equal(m.summary, 'Working on: 1 thing');
  assert.deepEqual(m.rows, [{ kind: 'jobs', kindLabel: 'Background jobs', title: '1 background job', sub: '', buttons: [] }]);
  const many = H.panelModel({ handOffs: [], jobs: null, jobCount: 3, workers: [] }, { now: NOW });
  assert.equal(many.rows[0].title, '3 background jobs');
  assert.equal(many.summary, 'Working on: 3 things');
  assert.equal(H.panelModel({ handOffs: [], jobs: null, jobCount: 0, workers: [] }, { now: NOW }).rows.length, 0);
});

test('panelModel: the next check shows after the count, in the given format', () => {
  const m = H.panelModel({ handOffs: [ho({})], jobs: [], workers: [], nextCheck: { at: '2026-06-01T12:30:00Z', taskId: 't1' } }, { now: NOW, fmt });
  assert.equal(m.nextCheckText, 'next check 12:30');
  assert.equal(m.summary, 'Working on: 1 thing · next check 12:30');
  assert.match(H.panelModel({ handOffs: [ho({})], nextCheck: { at: NOW + HOUR } }, { now: NOW }).summary, /^Working on: 1 thing · next check \d{1,2}:\d{2}/);   // the browser's own format
});

test('panelModel: the hand-off sub reads state, the quoted status line, and when it changed', () => {
  const sub = (o) => H.panelModel({ handOffs: [ho(o)] }, { now: NOW, fmt }).rows[0].sub;
  assert.equal(sub({ statusLine: 'Reading the third report' }), 'Running · "Reading the third report" · changed 12 min ago');
  assert.equal(sub({ statusLine: null }), 'Running · changed 12 min ago', 'no quote part without a status line');
  assert.equal(sub({ statusLine: '   ' }), 'Running · changed 12 min ago');
  assert.equal(sub({ changedAt: iso(20 * 1000) }), 'Running · changed just now');
  assert.equal(sub({ changedAt: iso(3 * HOUR) }), 'Running · changed 3 h ago');
  assert.equal(sub({ changedAt: undefined }), 'Running');
  assert.equal(sub({ state: 'waiting', next: { kind: 'task', at: NOW + 30 * MIN }, statusLine: 'Next: check mail' }), 'Waiting for its next step (12:30) · "Next: check mail" · changed 12 min ago');
});

test('panelModel: the quiet line shows for 10 minutes after the last item, then hidden; hidden when never had', () => {
  const empty = { handOffs: [], jobs: [], jobCount: 0, workers: [], nextCheck: null };
  assert.equal(H.panelModel(empty, { now: NOW, everHad: NOW - 9 * MIN }).show, 'quiet');
  assert.equal(H.panelModel(empty, { now: NOW, everHad: iso(9 * MIN) }).show, 'quiet');
  assert.equal(H.panelModel(empty, { now: NOW, everHad: NOW - 10 * MIN }).show, 'hidden');
  assert.equal(H.panelModel(empty, { now: NOW }).show, 'hidden');
  assert.equal(H.panelModel(empty, { now: NOW, everHad: null }).show, 'hidden');
  assert.equal(H.panelModel(null, { now: NOW }).show, 'hidden');
  assert.equal(H.QUIET_MS, 10 * MIN);
  // anything running wins over the quiet line
  assert.equal(H.panelModel({ ...empty, workers: [{ id: 'w', label: 'x' }] }, { now: NOW, everHad: NOW - 20 * MIN }).show, 'full');
});

// A minimal fake DOM (text nodes and elements only).
function fakeDoc() {
  const doc = {
    createElement(tag) {
      const e = { tag, className: '', children: [], hidden: false, attrs: {}, handlers: {}, ownerDocument: doc, get firstChild() { return this.children[0] || null; },
        appendChild(c) { this.children.push(c); return c; }, removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; },
        setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
        addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
        click() { for (const fn of this.handlers.click || []) fn({ target: this }); },
        classList: {
          add: (c) => { const l = e.className.split(' ').filter(Boolean); if (!l.includes(c)) l.push(c); e.className = l.join(' '); },
          remove: (c) => { e.className = e.className.split(' ').filter((x) => x && x !== c).join(' '); },
          contains: (c) => e.className.split(' ').includes(c),
        } };
      return e;
    },
    createTextNode(text) { return { text: String(text) }; },
  };
  return doc;
}
const textOf = (n) => (n.text !== undefined ? n.text : n.children.map(textOf).join(''));
const find = (n, cls) => (n.className && n.className.split(' ').includes(cls) ? [n] : []).concat(...(n.children || []).map((c) => find(c, cls)));
function memStorage(init) { const d = { ...(init || {}) }; return { getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, d }; }

const FULL = () => ({
  handOffs: [ho({ id: 'a', topic: '<b>x</b>', statusLine: '<img src=x onerror=1>' })],
  jobs: [{ id: 'j1', name: 'Nightly sync', startedAt: iso(HOUR), status: 'running' }],
  jobCount: 1, workers: [{ id: 'w1', label: 'Research', startedAt: iso(30 * MIN) }, { id: 'w2', label: 'Draft', startedAt: iso(20 * MIN) }],
  nextCheck: { at: '2026-06-01T12:30:00Z', taskId: 't1' },
});

test('renderPanel: no ring in the header once nothing runs (only ended hand-offs still listed)', () => {
  const doc = fakeDoc(); const box = doc.createElement('div'); const storage = memStorage();
  const ended = ho({ id: 'd', state: 'done', endedAt: iso(2 * MIN), reportedAt: iso(MIN) });
  H.renderPanel(box, { handOffs: [ended], jobs: [], jobCount: 0, workers: [] }, { now: NOW, fmt, storage });
  const head = find(box, 'ho-strip')[0];
  assert.equal(find(head, 'wo-ring').length, 0);
  assert.equal(textOf(find(head, 'ho-sum')[0]), 'Working on: nothing now');
});

test('renderPanel: collapsed header with the ring, the summary and the chevron; rows are text nodes only', () => {
  const doc = fakeDoc(); const box = doc.createElement('div'); const storage = memStorage();
  H.renderPanel(box, FULL(), { now: NOW, fmt, storage });
  assert.equal(box.hidden, false);
  const head = find(box, 'ho-strip')[0];
  assert.equal(head.tag, 'button');
  assert.equal(head.attrs['aria-expanded'], 'false');
  assert.equal(find(head, 'wo-ring').length, 1);
  assert.equal(textOf(find(head, 'ho-sum')[0]), 'Working on: 4 things · next check 12:30');
  assert.equal(find(head, 'ho-chev').length, 1);
  assert.equal(find(box, 'ho-list')[0].hidden, true);
  const rows = find(box, 'wo-row');
  assert.equal(rows.length, 3);
  assert.equal(textOf(find(rows[0], 'wo-kind')[0]), 'Handed to scout');
  assert.equal(textOf(find(rows[0], 'wo-sub')[0]), 'Running · "<img src=x onerror=1>" · changed 12 min ago');
  assert.equal(textOf(find(rows[1], 'wo-title')[0]), 'Nightly sync');
  assert.equal(textOf(find(rows[2], 'wo-sub')[0]), 'Research · Draft · since 11:30');
  const tags = new Set(); (function walk(n) { if (n.tag) tags.add(n.tag); (n.children || []).forEach(walk); })(box);
  assert.deepEqual([...tags].sort(), ['button', 'div', 'span'], 'no element came from the data');
  // the header click opens the list and keeps the choice per device
  head.click();
  assert.equal(find(box, 'ho-list')[0].hidden, false);
  assert.equal(storage.d['handoffStrip.expanded'], '1');
});

test('renderPanel: a hand-off row has Status and no Stop; a job and the helpers have Stop', () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  H.renderPanel(box, FULL(), { now: NOW, fmt, storage: memStorage(), expanded: true, stopJob: () => {}, stopWorker: () => {}, isAdmin: () => true });
  const rows = find(box, 'wo-row');
  assert.equal(find(rows[0], 'ho-status').length, 1);
  assert.equal(find(rows[0], 'wo-stop').length, 0);
  assert.equal(find(rows[1], 'wo-stop').length, 1);
  assert.equal(find(rows[2], 'wo-stop').length, 1);
  assert.equal(textOf(find(rows[1], 'wo-stop')[0]), 'Stop');
  // not an admin: no Stop on the job; the page gave no worker stop: none on the helpers
  H.renderPanel(box, FULL(), { now: NOW, fmt, storage: memStorage(), expanded: true, stopJob: () => {}, isAdmin: () => false });
  const r2 = find(box, 'wo-row');
  assert.equal(find(r2[1], 'wo-stop').length, 0);
  assert.equal(find(r2[2], 'wo-stop').length, 0);
});

test('renderPanel: Stop on a job calls stopJob(id); Stop on helpers calls stopWorker(id, agent) for each; then a fresh look', async () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  const calls = []; let stopped = 0;
  H.renderPanel(box, FULL(), {
    now: NOW, fmt, storage: memStorage(), expanded: true, agent: 'sam', onStopped: () => { stopped++; },
    stopJob: async (id) => { calls.push(['job', id]); }, stopWorker: async (id, agent) => { calls.push(['worker', id, agent]); },
  });
  const rows = find(box, 'wo-row');
  find(rows[1], 'wo-stop')[0].click();
  find(rows[2], 'wo-stop')[0].click();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [['job', 'j1'], ['worker', 'w1', 'sam'], ['worker', 'w2', 'sam']]);
  assert.equal(stopped, 2);
});

test('renderPanel: quiet is one muted line without a button; hidden empties and hides', () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  box.appendChild(doc.createElement('span'));
  const empty = { handOffs: [], jobs: [], jobCount: 0, workers: [], nextCheck: null };
  H.renderPanel(box, empty, { now: NOW, everHad: NOW - 2 * MIN });
  assert.equal(box.hidden, false);
  assert.equal(box.children.length, 1);
  assert.equal(textOf(find(box, 'wo-quiet')[0]), 'Nothing running in the background now.');
  assert.equal(find(box, 'ho-strip').length + find(box, 'wo-stop').length, 0);
  H.renderPanel(box, empty, { now: NOW });
  assert.equal(box.children.length, 0);
  assert.equal(box.hidden, true);
  H.renderPanel(null, empty);   // no container: nothing happens
});

test('track: fetches /api/agents/<agent>/working-on, shows the panel, goes quiet then hidden after the last item', async () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  const realNow = Date.now, realTimeout = global.setTimeout, realInterval = global.setInterval;
  const timeouts = [];
  const t0 = Date.now();
  global.setTimeout = (fn, ms2) => { timeouts.push({ fn, ms: ms2 }); return timeouts.length; };
  global.setInterval = () => 1;
  try {
    const urls = [];
    let answer = { ok: true, agent: 'sam', count: 1, handOffs: [], jobs: null, jobCount: 0, workers: [{ id: 'w1', label: 'Research', startedAt: new Date(t0).toISOString() }], nextCheck: null };
    const fetchFn = async (u) => { urls.push(u); return { ok: true, status: 200, json: async () => answer }; };
    const seen = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));
    H.track({ getAgent: () => 'sam', getContainer: () => box, fetchFn, storage: memStorage() });
    await seen();
    assert.deepEqual(urls, ['/api/agents/sam/working-on']);
    assert.equal(box.hidden, false);
    assert.equal(textOf(find(box, 'ho-sum')[0]), 'Working on: 1 thing');
    // the hub says background work changed for this agent: one more look soon
    H.onBackground('other');   // another agent: nothing
    H.onBackground('sam');
    const soon = timeouts.filter((x) => x.ms === 1200);
    assert.equal(soon.length, 1);
    // the worker ends: the quiet line, planned to go after 10 minutes since it was last seen
    answer = { ...answer, count: 0, workers: [] };
    soon[0].fn();
    await seen();
    assert.equal(urls.length, 2);
    assert.equal(textOf(find(box, 'wo-quiet')[0]), 'Nothing running in the background now.');
    const wait = timeouts.find((x) => x.ms > 500000 && x.ms < 700000);
    assert.ok(wait, 'a look is planned for when the quiet line runs out');
    Date.now = () => t0 + 11 * MIN;
    wait.fn();
    await seen();
    assert.equal(box.hidden, true, 'quiet for 10 minutes, then hidden');
  } finally { global.setTimeout = realTimeout; global.setInterval = realInterval; Date.now = realNow; }
});
