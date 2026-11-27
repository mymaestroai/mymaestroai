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

test('renderPanel: the next check is its own .ho-next span (nowrap in CSS) and the summary text is unchanged', () => {
  const doc = fakeDoc(); const box = doc.createElement('div'); const storage = memStorage();
  H.renderPanel(box, FULL(), { now: NOW, fmt, storage });
  const sum = find(find(box, 'ho-strip')[0], 'ho-sum')[0];
  assert.equal(textOf(sum), 'Working on: 4 things · next check 12:30');
  const next = find(sum, 'ho-next');
  assert.equal(next.length, 1);
  assert.equal(textOf(next[0]), 'next check 12:30');
  assert.equal(sum.children.length, 2);
  assert.equal(textOf(sum.children[0]), 'Working on: 4 things · ');
  // no next check: no span, the plain text
  const box2 = doc.createElement('div');
  const ended = ho({ id: 'd', state: 'done', endedAt: iso(2 * MIN), reportedAt: iso(MIN) });
  H.renderPanel(box2, { handOffs: [ended], jobs: [], jobCount: 0, workers: [] }, { now: NOW, fmt, storage });
  const sum2 = find(box2, 'ho-sum')[0];
  assert.equal(find(sum2, 'ho-next').length, 0);
  assert.equal(textOf(sum2), 'Working on: nothing now');
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
  // the header click opens the list; nothing is kept in storage (owner, 11-23: always collapsed when a chat opens)
  head.click();
  assert.equal(find(box, 'ho-list')[0].hidden, false);
  assert.equal(storage.d['handoffStrip.expanded'], undefined);
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

let sharedTick = null;   // track's interval callback (track keeps one timer for the whole module)
test('track: fetches /api/agents/<agent>/working-on, shows the panel, goes quiet then hidden after the last item', async () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  const realNow = Date.now, realTimeout = global.setTimeout, realInterval = global.setInterval;
  const timeouts = [];
  const t0 = Date.now();
  global.setTimeout = (fn, ms2) => { timeouts.push({ fn, ms: ms2 }); return timeouts.length; };
  global.setInterval = (fn) => { sharedTick = fn; return 1; };
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

test('r1 track: switching agent empties the container at once; a late answer for the old agent is dropped; a failed fetch leaves it empty', async () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  const realTimeout = global.setTimeout, realInterval = global.setInterval;
  global.setTimeout = () => 1;
  global.setInterval = (fn) => { sharedTick = fn; return 1; };
  const tickFn = () => sharedTick();
  try {
    let agent = 'agent-a';
    const pending = {};
    const fetchFn = (u) => new Promise((resolve) => { pending[u] = resolve; });
    const answerFor = (label) => ({ ok: true, count: 1, handOffs: [], jobs: null, jobCount: 0, workers: [{ id: 'w', label, startedAt: new Date().toISOString() }], nextCheck: null });
    const seen = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));
    H.track({ getAgent: () => agent, getContainer: () => box, fetchFn, storage: memStorage() });
    tickFn();
    pending['/api/agents/agent-a/working-on']({ ok: true, status: 200, json: async () => answerFor('A-row') });
    await seen();
    assert.ok(textOf(box).includes('Working on: 1 thing'), 'agent A shown');
    // switch to B (same element) with B's fetch pending
    agent = 'agent-b'; tickFn();
    assert.equal(box.children.length, 0, 'emptied synchronously');
    assert.equal(box.hidden, true);
    // switch back to A, then to B again: A's earlier request must not paint under B
    pending['/api/agents/agent-b/working-on']({ ok: false, status: 500, json: async () => ({}) });
    await seen();
    assert.equal(box.children.length, 0, "B's 500 leaves it empty");
    assert.equal(box.hidden, true);
    // a late answer of the old agent (A -> B -> A' race): ask A again, switch to B before it answers
    agent = 'agent-a'; tickFn();
    const lateA = pending['/api/agents/agent-a/working-on'];
    agent = 'agent-b'; tickFn();
    lateA({ ok: true, status: 200, json: async () => answerFor('A-late') });
    await seen();
    assert.equal(box.children.length, 0, "A's late answer is not rendered under B");
  } finally { global.setTimeout = realTimeout; global.setInterval = realInterval; }
});

test('r2 follow(): switching agent then calling follow() empties the container synchronously, no timer tick', async () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  const realTimeout = global.setTimeout, realInterval = global.setInterval;
  global.setTimeout = () => 1;
  global.setInterval = (fn) => { sharedTick = fn; return 1; };
  try {
    let agent = 'agent-a';
    const pending = {};
    const fetchFn = (u) => new Promise((resolve) => { pending[u] = resolve; });
    const seen = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));
    H.track({ getAgent: () => agent, getContainer: () => box, fetchFn, storage: memStorage() });
    H.follow();
    pending['/api/agents/agent-a/working-on']({ ok: true, status: 200, json: async () => ({ ok: true, count: 1, handOffs: [], jobs: null, jobCount: 0, workers: [{ id: 'w', label: 'A-row', startedAt: new Date().toISOString() }], nextCheck: null }) });
    await seen();
    assert.ok(textOf(box).includes('Working on: 1 thing'));
    agent = 'agent-b';
    H.follow();
    assert.equal(box.children.length, 0, 'emptied synchronously by follow()');
    assert.equal(box.hidden, true);
  } finally { global.setTimeout = realTimeout; global.setInterval = realInterval; }
});

test('r2 an answer for A arriving after the live agent became B is not painted, even if no tick ran', async () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  const realTimeout = global.setTimeout, realInterval = global.setInterval;
  global.setTimeout = () => 1;
  global.setInterval = (fn) => { sharedTick = fn; return 1; };
  try {
    let agent = 'agent-a';
    const pending = {};
    const fetchFn = (u) => new Promise((resolve) => { pending[u] = resolve; });
    const seen = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));
    H.track({ getAgent: () => agent, getContainer: () => box, fetchFn, storage: memStorage() });
    H.follow();
    agent = 'agent-b';   // the chat changed; no tick, no follow
    pending['/api/agents/agent-a/working-on']({ ok: true, status: 200, json: async () => ({ ok: true, count: 1, handOffs: [], jobs: null, jobCount: 0, workers: [{ id: 'w', label: 'A-row', startedAt: new Date().toISOString() }], nextCheck: null }) });
    await seen();
    assert.equal(box.children.length, 0, "A's rows are not painted into B's chat");
  } finally { global.setTimeout = realTimeout; global.setInterval = realInterval; }
});

test('r2 a Stop on a row whose agent is no longer current calls neither stopJob nor stopWorker', async () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  const calls = [];
  let live = 'sam';
  H.renderPanel(box, FULL(), {
    now: NOW, fmt, storage: memStorage(), expanded: true, agent: 'sam', liveAgent: () => live,
    stopJob: async (id) => { calls.push(['job', id]); }, stopWorker: async (id) => { calls.push(['worker', id]); },
  });
  live = 'other';
  const rows = find(box, 'wo-row');
  find(rows[1], 'wo-stop')[0].click();
  find(rows[2], 'wo-stop')[0].click();
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, []);
});

// ── Always collapsed when a chat opens (owner, 11-23: "I would rather have it be collapsed and expand on a touch") ──
// Each test loads a fresh copy of the library, the way a page load does; timers are captured and run by hand.
function freshPanel() {
  const p = require.resolve('../lib/ui-hand-off-card');
  delete require.cache[p];
  const M = require(p);
  delete require.cache[p];
  return M;
}
const ROWS = (label) => ({ ok: true, count: 1, handOffs: [], jobs: null, jobCount: 0, workers: [{ id: 'w', label, startedAt: new Date().toISOString() }], nextCheck: null });
const NONE = () => ({ ok: true, count: 0, handOffs: [], jobs: null, jobCount: 0, workers: [], nextCheck: null });
async function withPanel(storage, body) {
  const realTimeout = global.setTimeout, realInterval = global.setInterval;
  const soon = [];
  global.setTimeout = (fn) => { soon.push(fn); return soon.length; };
  global.setInterval = () => 1;
  try {
    const M = freshPanel();
    const doc = fakeDoc(); const box = doc.createElement('div');
    const ctx = { agent: 'agent-a', answers: {} };
    const fetchFn = async (u) => { const a = u.split('/')[3]; const body = ctx.answers[a] || NONE(); return { ok: true, status: 200, json: async () => body }; };
    const seen = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));
    const expanded = () => { const h = find(box, 'ho-strip')[0]; return h ? h.attrs['aria-expanded'] : null; };
    const switchTo = async (a) => { ctx.agent = a; M.follow(); await seen(); };
    const refresh = async () => { M.refreshSoon(); const fns = soon.splice(0); fns.forEach((f) => { try { f(); } catch { /* an age timer */ } }); await seen(); };
    M.track({ getAgent: () => ctx.agent, getContainer: () => box, fetchFn, storage });
    await seen();
    await body({ M, box, ctx, expanded, switchTo, refresh, seen });
  } finally { global.setTimeout = realTimeout; global.setInterval = realInterval; }
}

test('collapsed: a chat opens collapsed even when the old strip stored "expanded"; nothing is written to storage', async () => {
  const storage = memStorage({ 'handoffStrip.expanded': '1' });
  await withPanel(storage, async ({ ctx, expanded, switchTo, box }) => {
    ctx.answers['agent-a'] = ROWS('A-row'); ctx.answers['agent-b'] = ROWS('B-row');
    await switchTo('agent-b');
    assert.ok(textOf(box).includes('Working on: 1 thing'));
    assert.equal(expanded(), 'false');
    find(box, 'ho-strip')[0].click();
    assert.equal(expanded(), 'true');
    find(box, 'ho-strip')[0].click();
    assert.equal(expanded(), 'false');
  });
  assert.deepEqual(storage.d, { 'handoffStrip.expanded': '1' }, 'the old key is left as it was and nothing new is stored');
});

test('collapsed: an expansion survives the panel refreshing in the same chat, and goes on a chat switch (both ways)', async () => {
  await withPanel(memStorage(), async ({ ctx, expanded, switchTo, refresh, box }) => {
    ctx.answers['agent-a'] = ROWS('A-row'); ctx.answers['agent-b'] = ROWS('B-row');
    await switchTo('agent-b'); await switchTo('agent-a');
    find(box, 'ho-strip')[0].click();
    assert.equal(expanded(), 'true');
    ctx.answers['agent-a'] = ROWS('A-row-2');
    await refresh();
    assert.ok(textOf(box).includes('A-row-2'), 'the refresh repainted the rows');
    assert.equal(expanded(), 'true', 'still expanded after the refresh');
    await switchTo('agent-b');
    assert.equal(expanded(), 'false', 'another chat opens collapsed');
    await switchTo('agent-a');
    assert.equal(expanded(), 'false', 'and coming back starts collapsed too');
  });
});

test('collapsed: a reload (a fresh page) starts collapsed after an expansion', async () => {
  const storage = memStorage();
  await withPanel(storage, async ({ ctx, switchTo, box, expanded }) => {
    ctx.answers['agent-b'] = ROWS('B-row');
    await switchTo('agent-b');
    find(box, 'ho-strip')[0].click();
    assert.equal(expanded(), 'true');
  });
  await withPanel(storage, async ({ ctx, switchTo, expanded }) => {
    ctx.answers['agent-b'] = ROWS('B-row');
    await switchTo('agent-b');
    assert.equal(expanded(), 'false');
  });
  assert.deepEqual(storage.d, {});
});

test('collapsed: when the panel empties, rows that come back start collapsed', async () => {
  await withPanel(memStorage(), async ({ ctx, switchTo, refresh, box, expanded }) => {
    ctx.answers['agent-b'] = ROWS('B-row');
    await switchTo('agent-b');
    find(box, 'ho-strip')[0].click();
    assert.equal(expanded(), 'true');
    ctx.answers['agent-b'] = NONE();
    await refresh();
    assert.equal(find(box, 'ho-strip').length, 0, 'no rows shown');
    ctx.answers['agent-b'] = ROWS('B-row-2');
    await refresh();
    assert.ok(textOf(box).includes('Working on: 1 thing'));
    assert.equal(expanded(), 'false');
  });
});

test('collapsed: there is no expand-on-navigate path; a ring or line tap that opens a chat leaves its panel collapsed', async () => {
  assert.equal(typeof freshPanel().open, 'undefined', 'HandOffCard.open is gone');
  await withPanel(memStorage(), async ({ M, ctx, switchTo, box, expanded }) => {
    ctx.answers['agent-a'] = ROWS('A-row'); ctx.answers['agent-b'] = ROWS('B-row');
    await switchTo('agent-a');
    // a ring tap or a blue sub-line tap only opens the chat (follow); nothing asks for expansion
    await switchTo('agent-b');
    assert.equal(expanded(), 'false', "the ring/sub-line tap opened B's chat collapsed");
    find(box, 'ho-strip')[0].click();
    assert.equal(expanded(), 'true', 'pressing the summary line expands');
    await switchTo('agent-a');
    assert.equal(expanded(), 'false', 'another chat is collapsed');
    await switchTo('agent-b');
    assert.equal(expanded(), 'false', 'and coming back starts collapsed again');
  });
});

test('collapsed: neither page, nor the Simple list, asks the panel to open when a ring, blue line or chip opens a chat', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const app = read('app.js'), mobile = read('mobile.js'), lib = read('lib/ui-hand-off-card.js');
  const body = (src, head) => { const i = src.indexOf(head); assert.ok(i >= 0, head); return src.slice(i, i + 400); };
  assert.ok(!/HandOffCard\.open\b/.test(app) && !/HandOffCard\.open\b/.test(mobile), 'no page calls HandOffCard.open');
  assert.ok(!/openFor|openAt|OPEN_FOR_MS/.test(lib), 'the library keeps no expand-on-open state');
  assert.ok(body(app, 'function bgOpenChat(name)').includes('startSoloChat('), 'desktop: the tap still opens the chat');
  assert.ok(body(mobile, 'function bgOpenChat(name)').includes("navigate('chat', name)"), 'phone: the tap still opens the chat');
  assert.ok(app.includes('.teams-row .teams-dot.bg-work, .teams-row .teams-bg-line'), 'desktop: a Teams row ring and blue line are handled');
  assert.ok(mobile.includes("e.target.closest('.dot.bg-work, .agent-bg-line')) { bgOpenChat(r.dataset.agent)"), 'phone: the list ring and blue line');
  assert.ok(mobile.includes("if (typeof opts.onPick === 'function') opts.onPick(); if (a.name !== current || screen !== 'chat') navigate('chat', a.name);"), 'Simple: the row still opens the chat');
});

test('panelModel: the next check names the day when it is not today', () => {
  const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime();
  const clock = (t) => { const d = new Date(t); const h = d.getHours() % 12 || 12; return h + ':' + String(d.getMinutes()).padStart(2, '0') + (d.getHours() < 12 ? ' AM' : ' PM'); };
  const text = (nowMs, nextMs) => H.panelModel({ handOffs: [ho({})], nextCheck: { at: nextMs } }, { now: nowMs, fmt: clock }).nextCheckText;
  const now = at(2026, 10, 26, 15, 0);   // Thu Nov 26 2026, 3:00 PM local
  assert.equal(text(now, at(2026, 10, 26, 19, 18)), 'next check 7:18 PM', 'today');
  assert.equal(text(now, at(2026, 10, 26, 23, 59)), 'next check 11:59 PM', 'a check at 11:59 PM today is still today');
  assert.equal(text(now, at(2026, 10, 27, 19, 18)), 'next check tomorrow 7:18 PM', 'tomorrow');
  assert.equal(text(now, at(2026, 10, 27, 0, 0)), 'next check tomorrow 12:00 AM', 'just after midnight is tomorrow');
  assert.equal(text(at(2026, 10, 26, 23, 59), at(2026, 10, 27, 0, 1)), 'next check tomorrow 12:01 AM', 'two minutes away across midnight');
  assert.equal(text(at(2026, 10, 27, 0, 5), at(2026, 10, 27, 7, 0)), 'next check 7:00 AM', 'just after midnight, same day');
  assert.equal(text(now, at(2026, 10, 28, 19, 18)), 'next check Sat 7:18 PM', 'two days out: short weekday');
  assert.equal(text(now, at(2026, 11, 2, 8, 30)), 'next check Wed 8:30 AM', 'six days out is still a weekday');
  assert.equal(text(now, at(2026, 11, 3, 19, 18)), 'next check Dec 3, 7:18 PM', 'a week out: short date');
  assert.equal(text(now, now), 'check due now', 'at now');
  assert.equal(text(now, now - 60000), 'check due now', 'before now');
  assert.equal(H.panelModel({ handOffs: [ho({})], nextCheck: { at: now - 1000 } }, { now, fmt: clock }).summary, 'Working on: 1 thing · check due now');
});
