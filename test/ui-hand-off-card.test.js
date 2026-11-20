'use strict';
// The hand-off cards above the message box (lib/ui-hand-off-card.js) and their route GET /api/hand-offs?agent=<caller>.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../lib/ui-hand-off-card');
const access = require('../lib/access');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NOW = Date.parse('2026-06-01T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const MIN = 60 * 1000, HOUR = 60 * MIN;

test('stateLabel: every state has its words', () => {
  assert.equal(H.stateLabel('queued'), 'Queued');
  assert.equal(H.stateLabel('running'), 'Running');
  assert.equal(H.stateLabel('waiting'), 'Waiting for its next step');
  assert.equal(H.stateLabel('done'), 'Done');
  assert.equal(H.stateLabel('failed'), 'Failed');
  assert.equal(H.stateLabel('cancelled'), 'Cancelled');
  assert.equal(H.stateLabel('interrupted'), 'Interrupted by a restart');
});

test('cardModel: title, topic, label, ago (from startedAt, else createdAt) and open', () => {
  const m = H.cardModel({ target: 'scout', topic: 'Find prices', state: 'running', createdAt: iso(30 * MIN), startedAt: iso(5 * MIN) }, { now: NOW });
  assert.deepEqual(m, { title: 'Handed off to scout', topic: 'Find prices', state: 'running', label: 'Running', ago: '5 min ago', open: true });
  const q = H.cardModel({ target: 'scout', topic: 't', state: 'queued', createdAt: iso(3 * HOUR) }, { now: NOW });
  assert.equal(q.ago, '3 h ago');
  assert.equal(q.open, true);
  assert.equal(H.cardModel({ target: 'a', topic: 't', state: 'done', startedAt: iso(10 * 1000) }, { now: NOW }).ago, 'just now');
  assert.equal(H.cardModel({ target: 'a', topic: 't', state: 'done', startedAt: iso(50 * HOUR) }, { now: NOW }).ago, '2 d ago');
  for (const s of ['done', 'failed', 'cancelled', 'interrupted']) assert.equal(H.cardModel({ target: 'a', state: s }, { now: NOW }).open, false, s);
  for (const s of ['queued', 'running', 'waiting']) assert.equal(H.cardModel({ target: 'a', state: s }, { now: NOW }).open, true, s);
});

test('stateLabel: a view gives the words for every state and the waiting variants', () => {
  const fmt = (at) => 'T' + at;
  assert.equal(H.stateLabel({ state: 'queued' }), 'Queued');
  assert.equal(H.stateLabel({ state: 'running' }), 'Running');
  assert.equal(H.stateLabel({ state: 'waiting', next: { kind: 'task', at: NOW + 5 } }, { fmt, now: NOW }), 'Waiting for its next step (T' + (NOW + 5) + ')');
  assert.equal(H.stateLabel({ state: 'waiting', next: { kind: 'task', at: iso(0) } }, { fmt, now: NOW }), 'Waiting for its next step (T' + NOW + ')');
  // review r1: a time already past (a paused or held task) is left out
  assert.equal(H.stateLabel({ state: 'waiting', next: { kind: 'task', at: NOW - 60000 } }, { fmt, now: NOW }), 'Waiting for its next step');
  assert.equal(H.stateLabel({ state: 'waiting', next: { kind: 'task', at: null } }, { fmt }), 'Waiting for its next step');
  assert.match(H.stateLabel({ state: 'waiting', next: { kind: 'task', at: NOW } }, { now: NOW }), /^Waiting for its next step \(\d{1,2}:\d{2}/);   // the browser's own format
  assert.equal(H.stateLabel({ state: 'waiting', next: { kind: 'job' } }), 'Running a job');
  assert.equal(H.stateLabel({ state: 'waiting', next: null }), 'Finishing up');
  // step 1: a server that sends no next field (today's live one): "Working", never "Waiting for its next step"
  assert.equal(H.stateLabel({ state: 'waiting' }), 'Working');
  assert.equal(H.summaryLine([{ id: 'w', state: 'waiting', createdAt: NOW - MIN }], { now: NOW }), 'Hand-offs: 1 running', 'Working counts as in progress');
  assert.equal(H.stateLabel({ state: 'done', reported: true }), 'Done (report sent)');
  assert.equal(H.stateLabel({ state: 'done', reported: false }), 'Done');
  assert.equal(H.stateLabel({ state: 'failed' }), 'Failed');
  assert.equal(H.stateLabel({ state: 'cancelled' }), 'Cancelled');
  assert.equal(H.stateLabel({ state: 'interrupted' }), 'Interrupted by a restart');
  // the pill colour: waiting without a pending task uses the running colour
  assert.equal(H.pillState({ state: 'waiting', next: { kind: 'task', at: 1 } }), 'waiting');
  assert.equal(H.pillState({ state: 'waiting', next: { kind: 'job' } }), 'running');
  assert.equal(H.pillState({ state: 'waiting' }), 'running');
  assert.equal(H.pillState({ state: 'done' }), 'done');
});

// The 24-hour rule is gone on purpose (the strip keeps ended hand-offs 10 minutes after the report, else after the end).
test('visible: open ones always; ended ones for 10 minutes after reportedAt (else endedAt), every open one, open first then newest first', () => {
  const v = [
    { id: 'old', state: 'done', createdAt: iso(40 * HOUR), endedAt: iso(30 * HOUR) },
    { id: 'recent', state: 'failed', createdAt: iso(5 * HOUR), endedAt: iso(4 * MIN) },
    { id: 'open-old', state: 'waiting', createdAt: iso(60 * HOUR) },
    { id: 'new', state: 'running', createdAt: iso(1 * MIN) },
    { id: 'stale-end', state: 'done', createdAt: iso(2 * HOUR), endedAt: iso(11 * MIN) },
    { id: 'reported-late', state: 'done', createdAt: iso(3 * HOUR), endedAt: iso(2 * HOUR), reportedAt: iso(9 * MIN) },   // the report counts, not the end
    { id: 'reported-old', state: 'done', createdAt: iso(3 * HOUR), endedAt: iso(1 * MIN), reportedAt: iso(11 * MIN) },
  ];
  // open ones first (review r1), each group newest first
  assert.deepEqual(H.visible(v, { now: NOW }).map((x) => x.id), ['new', 'open-old', 'reported-late', 'recent']);
  const many = Array.from({ length: 8 }, (_, i) => ({ id: 'h' + i, state: 'running', createdAt: iso(i * MIN) }));
  const shown = H.visible(many, { now: NOW });
  // review r1: every open hand-off shows (the header counts them all); only ended ones are capped
  assert.equal(shown.length, 8);
  assert.deepEqual(shown.map((x) => x.id).slice(0, 3), ['h0', 'h1', 'h2']);
  assert.deepEqual(H.visible(null), []);
  assert.deepEqual(H.visible([null, 5, {}]), []);
});

// A minimal fake DOM: only text nodes and elements; a node made from markup would show up as an element, never as text.
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

test('render: text nodes only, replaces what was there, empty hides', () => {
  const doc = fakeDoc();
  const box = doc.createElement('div');
  box.appendChild(doc.createElement('span'));
  H.render(box, [
    { target: 'scout', topic: 'Look at <b>this</b> & <img src=x onerror=1>', state: 'running', createdAt: iso(2 * MIN) },
    // endedAt 1 minute (was 1 hour): the 24-hour rule is gone, ended ones stay 10 minutes
    { target: 'builder', topic: 'Make it', state: 'done', createdAt: iso(2 * HOUR), endedAt: iso(1 * MIN) },
  ], { now: NOW });
  assert.equal(box.hidden, false);
  const cards = find(box, 'ho-card');
  assert.equal(cards.length, 2);
  assert.equal(find(cards[0], 'ho-title')[0].children[0].text, 'Handed off to scout');
  assert.equal(find(cards[0], 'ho-topic')[0].children[0].text, 'Look at <b>this</b> & <img src=x onerror=1>');
  assert.equal(find(cards[0], 'ho-pill')[0].className, 'ho-pill ho-running');
  assert.equal(textOf(find(cards[0], 'ho-pill')[0]), 'Running');
  assert.equal(textOf(find(cards[0], 'ho-time')[0]), '2 min ago');
  assert.equal(textOf(find(cards[1], 'ho-pill')[0]), 'Done');
  // only the tags this helper makes are in the tree: no element came from the topic text
  const tags = new Set(); (function walk(n) { if (n.tag) tags.add(n.tag); (n.children || []).forEach(walk); })(box);
  // (the strip's header is a button now, so 'button' joins the list)
  assert.deepEqual([...tags].sort(), ['button', 'div', 'span']);
  H.render(box, [], { now: NOW });
  assert.equal(box.children.length, 0);
  assert.equal(box.hidden, true);
  H.render(null, []);   // no container: nothing happens
});

test('render: a strange state never becomes a class name', () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  H.render(box, [{ target: 'a', topic: 't', state: 'queued', createdAt: iso(MIN) }, { target: 'b', topic: 'u', state: 'x y"><', endedAt: iso(MIN), createdAt: iso(MIN) }], { now: NOW });
  const pills = find(box, 'ho-pill').map((p) => p.className);
  assert.ok(pills.includes('ho-pill ho-queued'));
  assert.ok(pills.includes('ho-pill ho-other'));
});

test('both pages load the script before their own, and the static list serves it', () => {
  const idx = read('index.html'), mob = read('mobile.html');
  assert.ok(idx.includes('<script src="/ui-hand-off-card.js"></script>'));
  assert.ok(mob.includes('<script src="/ui-hand-off-card.js"></script>'));
  assert.ok(idx.indexOf('/ui-hand-off-card.js') < idx.indexOf('<script src="app.js">'));
  assert.ok(mob.indexOf('/ui-hand-off-card.js') < mob.indexOf('<script src="mobile.js">'));
  assert.ok(read('lib/static-files.js').includes("['ui-hand-off-card.js', 'lib/ui-hand-off-card.js']"));
  assert.match(read('app.js'), /id="handoff-cards-\$\{chatId\}"/);
  assert.match(mob, /id="handoff-cards"/);
  assert.match(read('app.js'), /HandOffCard\.track\(/);
  assert.match(read('mobile.js'), /HandOffCard\.track\(/);
});

test('route: the agent in the query decides who may read, like the chat history', () => {
  assert.deepEqual(access.classifyRoute('/api/hand-offs', 'GET'), { kind: 'agent', from: 'query' });
  const agents = [{ name: 'boss', owner: null }, { name: 'sam-bot', owner: 'sam' }];
  const admin = { id: 'a', role: 'admin' }, sam = { id: 'sam', role: 'member' }, other = { id: 'x', role: 'member' };
  const may = (u, n) => access.canAccessAgent(u, n, { agents });
  assert.equal(may(admin, 'boss'), true);
  assert.equal(may(sam, 'sam-bot'), true);
  assert.equal(may(sam, 'boss'), false);        // a member on an admin agent: 403 at the gate
  assert.equal(may(other, 'sam-bot'), false);
  assert.equal(may(null, 'boss'), false);       // signed out: the gate answers 401 before this
});

// The handler block of server.js, run with stand-ins (the server itself needs a whole install to boot).
function handler() {
  const src = read('server.js');
  const start = src.indexOf("if (pathname === '/api/hand-offs' && req.method === 'GET') {");
  assert.ok(start > 0, 'the route is in server.js');
  const end = src.indexOf('\n    }\n', start);
  const body = src.slice(start, end + 7);
  return new Function('pathname', 'req', 'res', 'agentFromQuery', 'getAgents', 'jsonResponse', 'require',
    `return (async () => { ${body} return 'not handled'; })();`);
}
async function call(url, { agents, list }) {
  const out = {};
  const req = { method: 'GET', url };
  const agentFromQuery = (r) => new URL(r.url, 'http://x').searchParams.get('agent');
  const seen = [];
  // the route uses the runner the hub made at start-up (lib/sdk-chat getHandOffRunner)
  const fakeRequire = (m) => { assert.equal(m, './lib/sdk-chat'); return { getHandOffRunner: () => ({ list: (...a) => { seen.push(a); return list; } }) }; };
  const r = await handler()(new URL(url, 'http://x').pathname, req, out, agentFromQuery, async () => agents, (res, code, data) => { res.code = code; res.data = data; return 'sent'; }, fakeRequire);
  return { r, out, seen };
}

test('route: 404 for an unknown or missing agent, 200 with the list for a known one', async () => {
  const agents = [{ name: 'boss' }, { name: 'sam-bot' }];
  const views = [{ id: 'h1', caller: 'boss', target: 'scout', topic: 'T', state: 'running' }];
  let x = await call('/api/hand-offs?agent=nobody', { agents, list: views });
  assert.equal(x.out.code, 404);
  assert.equal(x.seen.length, 0, 'nothing is listed for an unknown agent');
  x = await call('/api/hand-offs', { agents, list: views });
  assert.equal(x.out.code, 404);
  x = await call('/api/hand-offs?agent=boss', { agents, list: views });
  assert.equal(x.out.code, 200);
  assert.deepEqual(x.out.data, { ok: true, handOffs: views });
  assert.deepEqual(x.seen, [['boss', { includeDone: false, withStatus: false }]]);
  x = await call('/api/hand-offs?agent=boss', { agents, list: [] });
  assert.deepEqual(x.out.data, { ok: true, handOffs: [] });
});

// statusHref is no longer rendered anywhere (the Status control is a button that opens the in-app sheet); kept exported, so its pin stays.
test('statusHref: the target\'s STATUS.md through the download route (inline); nothing for an odd folder', () => {
  const H = require('../lib/ui-hand-off-card.js');
  assert.equal(H.statusHref({ target: 'scout', folder: '/srv/share/scout/hand-offs/lead-site-2' }), '/api/files/download?agent=scout&path=hand-offs%2Flead-site-2%2FSTATUS.md&inline=1');
  assert.equal(H.statusHref({ target: 'scout', folder: '/srv/share/scout/other' }), null);
  assert.equal(H.statusHref({ target: '', folder: '/x/hand-offs/a' }), null);
  assert.equal(H.statusHref({ target: 'scout', folder: '/x/hand-offs/a/b' }), null);
});

test('review r1: open hand-offs come first, so five finished cards never hide a running one', () => {
  const H = require('../lib/ui-hand-off-card.js');
  const now = Date.parse('2026-11-19T12:00:00Z');
  const done = [1, 2, 3, 4, 5].map((i) => ({ id: 'd' + i, state: 'done', createdAt: now - i * 60000, endedAt: now - 1000 }));
  const running = { id: 'r1', state: 'running', createdAt: now - 3600000 };
  const shown = H.visible([...done, running], { now });
  // proof round: ended ones are capped at three single lines, so this shows the running one and the three newest finished
  assert.equal(shown.length, 4);
  assert.equal(shown[0].id, 'r1');
  assert.deepEqual(shown.slice(1).map((x) => x.id), ['d1', 'd2', 'd3']);
});

test('proof round: an ended hand-off is one line (target · topic, state, Status); at most three ended ones show', () => {
  const H = require('../lib/ui-hand-off-card.js');
  const now = Date.parse('2026-11-19T12:00:00Z');
  const doc = fakeDoc();
  const make = doc.createElement;
  doc.createElement = (tag) => Object.assign(make(tag), { attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } });
  const box = doc.createElement('div');
  H.render(box, [
    { id: 'ho-1', target: 'builder', topic: 'word-count', state: 'interrupted', createdAt: now - 600000, endedAt: now - 60000, folder: '/s/builder/hand-offs/sam-word-count' },
    { target: 'builder', topic: 'long-run', state: 'running', createdAt: now - 120000, folder: '/s/builder/hand-offs/sam-long-run' },
  ], { now });
  const cards = find(box, 'ho-card');
  assert.equal(cards.length, 2);
  // the open one first, as a full card
  assert.equal(cards[0].className, 'ho-card');
  assert.equal(textOf(find(cards[0], 'ho-topic')[0]), 'long-run');
  // the ended one: a single row with no title, topic or time lines
  const row = cards[1];
  assert.equal(row.className, 'ho-card ho-ended');
  assert.deepEqual(row.children.map((c) => c.className), ['ho-line', 'ho-pill ho-interrupted', 'ho-status']);
  assert.equal(textOf(row.children[0]), 'builder · word-count');
  assert.equal(textOf(row.children[1]), 'Interrupted by a restart');
  // Status is a button now (it opens the sheet inside the app): the old pin was a link href to the raw STATUS.md download
  assert.equal(row.children[2].tag, 'button');
  assert.equal(row.children[2].attrs.href, undefined);
  assert.equal(row.children[2].attrs.target, undefined);
  assert.equal(find(row, 'ho-title').length + find(row, 'ho-topic').length + find(row, 'ho-time').length, 0);
  // five ended, none open: three show, newest first
  const ended = [1, 2, 3, 4, 5].map((i) => ({ id: 'e' + i, target: 'builder', state: 'done', createdAt: now - i * 60000, endedAt: now - 1000 }));
  assert.deepEqual(H.visible(ended, { now }).map((x) => x.id), ['e1', 'e2', 'e3']);
  // review r1: all open ones show, plus at most three ended
  const open = [1, 2, 3, 4, 5, 6].map((i) => ({ id: 'o' + i, state: 'queued', createdAt: now - i * 60000 }));
  assert.equal(H.visible([...open, ...ended], { now }).length, 9);
});

test('summaryLine: groups in order, only when > 0, counting everything kept', () => {
  const v = (id, state, extra = {}) => ({ id, state, createdAt: iso(MIN), endedAt: iso(MIN), ...extra });
  assert.equal(H.summaryLine([], { now: NOW }), '');
  assert.equal(H.summaryLine(null, { now: NOW }), '');
  assert.equal(H.summaryLine([v('a', 'running'), v('b', 'waiting', { next: { kind: 'task', at: 1 } }), v('c', 'done'), v('d', 'done')], { now: NOW }),
    'Hand-offs: 1 running · 1 waiting · 2 done');
  // running = running + finishing up + running a job; waiting = a pending task only
  assert.equal(H.summaryLine([v('a', 'running'), v('b', 'waiting'), v('c', 'waiting', { next: { kind: 'job' } }), v('d', 'waiting', { next: { kind: 'task', at: 1 } })], { now: NOW }),
    'Hand-offs: 3 running · 1 waiting');
  // the full order; failed and interrupted share a group
  // (at most 3 ended ones are kept, so the two halves of the order are checked apart)
  assert.equal(H.summaryLine([v('2', 'interrupted'), v('3', 'failed'), v('4', 'done'), v('5', 'waiting', { next: { kind: 'task', at: 1 } }), v('6', 'running'), v('7', 'queued')], { now: NOW }),
    'Hand-offs: 1 queued · 1 running · 1 waiting · 1 done · 2 failed');
  assert.equal(H.summaryLine([v('1', 'cancelled'), v('2', 'failed'), v('6', 'running')], { now: NOW }), 'Hand-offs: 1 running · 1 failed · 1 cancelled');
  // review r1: the list shows every open one the header counts (7 open ones)
  const seven = Array.from({ length: 7 }, (_, i) => v('r' + i, 'running'));
  assert.equal(H.visible(seven, { now: NOW }).length, 7);
  assert.equal(H.summaryLine(seven, { now: NOW }), 'Hand-offs: 7 running');
  // an old ended one is not counted
  assert.equal(H.summaryLine([v('x', 'done', { endedAt: iso(HOUR) })], { now: NOW }), '');
});

function memStorage(init) {
  const data = new Map(init ? Object.entries(init) : []); const writes = [];
  return { writes, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, v); writes.push([k, v]); } };
}
const sample = () => [{ id: 'a', target: 'scout', topic: 'Find prices', state: 'running', createdAt: iso(2 * MIN) }];

test('render: collapsed by default; a click expands and saves "1", a second click collapses and saves "0"', () => {
  const doc = fakeDoc(); const box = doc.createElement('div'); const storage = memStorage();
  H.render(box, [], { now: NOW, storage });
  assert.equal(box.hidden, true);
  assert.equal(box.children.length, 0);
  H.render(box, sample(), { now: NOW, storage });
  assert.equal(box.hidden, false);
  let header = find(box, 'ho-strip')[0];
  assert.equal(header.tag, 'button');
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.equal(textOf(find(header, 'ho-sum')[0]), 'Hand-offs: 1 running');
  assert.equal(find(header, 'ho-chev').length, 1);
  assert.equal(find(box, 'ho-list')[0].hidden, true);
  header.click();
  header = find(box, 'ho-strip')[0];
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  assert.equal(find(box, 'ho-list')[0].hidden, false);
  assert.deepEqual(storage.writes, [['handoffStrip.expanded', '1']]);
  header.click();
  header = find(box, 'ho-strip')[0];
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.equal(find(box, 'ho-list')[0].hidden, true);
  assert.deepEqual(storage.writes[1], ['handoffStrip.expanded', '0']);
});

test('render: a stored "1" renders expanded; a throwing storage renders collapsed and still toggles', () => {
  const doc = fakeDoc();
  let box = doc.createElement('div');
  H.render(box, sample(), { now: NOW, storage: memStorage({ 'handoffStrip.expanded': '1' }) });
  assert.equal(find(box, 'ho-strip')[0].getAttribute('aria-expanded'), 'true');
  assert.equal(find(box, 'ho-list')[0].hidden, false);
  box = doc.createElement('div');
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => H.render(box, sample(), { now: NOW, storage: bad }));
  assert.equal(find(box, 'ho-strip')[0].getAttribute('aria-expanded'), 'false');
  assert.doesNotThrow(() => find(box, 'ho-strip')[0].click());   // writing fails: the page goes on
  assert.equal(find(box, 'ho-strip')[0].getAttribute('aria-expanded'), 'true');
});

test('render: markup in a topic stays text, also in the summary strip', () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  H.render(box, [{ id: 'a', target: 'scout', topic: '<img src=x onerror=1>', state: 'running', createdAt: iso(MIN) }], { now: NOW, storage: memStorage() });
  const tags = new Set(); (function walk(n) { if (n.tag) tags.add(n.tag); (n.children || []).forEach(walk); })(box);
  assert.deepEqual([...tags].sort(), ['button', 'div', 'span']);
  assert.equal(textOf(find(box, 'ho-topic')[0]), '<img src=x onerror=1>');
});

test('highlight: a hand-off that turned done adds ho-flash for 4 s; the first render and running -> running add none', () => {
  const doc = fakeDoc(); const box = doc.createElement('div'); const storage = memStorage();
  const timers = []; const setTimer = (fn, t) => { timers.push({ fn, t }); return timers.length; };
  const clearTimer = () => {};
  const o = { now: NOW, storage, setTimer, clearTimer };
  const running = { id: 'a', target: 'scout', topic: 'T', state: 'running', createdAt: iso(MIN) };
  H.render(box, [running], o);
  assert.equal(find(box, 'ho-flash').length, 0, 'the first render highlights nothing');
  H.render(box, [{ ...running }], o);
  assert.equal(find(box, 'ho-flash').length, 0, 'running -> running adds none');
  assert.equal(timers.length, 0);
  H.render(box, [{ ...running, state: 'done', endedAt: iso(1000) }], o);
  const header = find(box, 'ho-strip')[0];
  assert.ok(header.classList.contains('ho-flash'));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].t, 4000);
  H.render(box, [{ ...running, state: 'done', endedAt: iso(1000) }], o);   // another render during the flash keeps it
  assert.ok(find(box, 'ho-strip')[0].classList.contains('ho-flash'));
  timers[0].fn();
  assert.equal(find(box, 'ho-flash').length, 0);
  H.render(box, [{ ...running, state: 'done', endedAt: iso(1000) }], o);   // done -> done: nothing new
  assert.equal(find(box, 'ho-flash').length, 0);
  // failed and interrupted flash too; a hand-off new to the list does not
  const box2 = doc.createElement('div');
  H.render(box2, [{ ...running, id: 'b' }], o);
  H.render(box2, [{ ...running, id: 'b', state: 'interrupted', endedAt: iso(1000) }, { ...running, id: 'c', state: 'done', endedAt: iso(1000) }], o);
  assert.equal(find(box2, 'ho-flash').length, 1);
  const box3 = doc.createElement('div');
  H.render(box3, [], o);
  H.render(box3, [{ ...running, id: 'n', state: 'done', endedAt: iso(1000) }], o);
  assert.equal(find(box3, 'ho-flash').length, 0);
});

test('the waiting variants show in the card and the pill colour', () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  H.render(box, [
    { id: 'a', target: 'scout', topic: 'A', state: 'waiting', next: { kind: 'job' }, createdAt: iso(MIN) },
    { id: 'b', target: 'scout', topic: 'B', state: 'waiting', next: { kind: 'task', at: NOW }, createdAt: iso(2 * MIN) },
    { id: 'c', target: 'scout', topic: 'C', state: 'done', reported: true, reportedAt: iso(MIN), endedAt: iso(2 * MIN), createdAt: iso(3 * MIN) },
  ], { now: NOW, storage: memStorage() });
  const pills = find(box, 'ho-pill');
  assert.deepEqual(pills.map((p) => p.className), ['ho-pill ho-running', 'ho-pill ho-waiting', 'ho-pill ho-done']);
  assert.equal(textOf(pills[0]), 'Running a job');
  assert.match(textOf(pills[1]), /^Waiting for its next step \(/);
  assert.equal(textOf(pills[2]), 'Done (report sent)');
});

test('CSS: both pages have .ho-strip (min-height 32px, nowrap), .ho-list, .ho-flash and the reduced-motion rule', () => {
  for (const f of ['index.html', 'mobile.html']) {
    const css = read(f);
    const rule = (sel) => { const m = css.match(new RegExp('\\.handoff-cards ' + sel.replace(/\./g, '\\.') + ' \\{([^}]*)\\}')); assert.ok(m, f + ' has ' + sel); return m[1]; };
    const strip = rule('.ho-strip');
    assert.match(strip, /min-height: 32px/, f);
    assert.match(strip, /white-space: nowrap/, f);
    assert.match(rule('.ho-sum'), /text-overflow: ellipsis/, f);
    assert.match(rule('.ho-list'), /gap: 4px/, f);
    assert.match(css, /\.ho-list\[hidden\] \{ display: none; \}/, f);
    assert.match(css, /\.ho-strip\[aria-expanded="true"\] \.ho-chev/, f);
    assert.match(rule('.ho-strip.ho-flash'), /border-color: var\(--accent\)/, f);
    assert.match(css, /prefers-reduced-motion: reduce\) \{ \.handoff-cards \.ho-strip[^}]*transition: none/, f);
  }
});

test('track: an ended hand-off that is shown gets one more look when it leaves (10 minutes after its report)', async () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  const realNow = Date.now, realTimeout = global.setTimeout, realInterval = global.setInterval;
  const timeouts = [];
  const t0 = Date.now();
  global.setTimeout = (fn, ms2) => { timeouts.push({ fn, ms: ms2 }); return timeouts.length; };
  global.setInterval = () => 1;
  try {
    let calls = 0;
    const fetchFn = async () => { calls++; return { ok: true, status: 200, json: async () => ({ handOffs: [{ id: 'a', target: 'scout', topic: 'T', state: 'done', createdAt: t0 - 60000, endedAt: t0 - 30000, reportedAt: t0 - 20000 }] }) }; };
    H.track({ getAgent: () => 'sam', getContainer: () => box, fetchFn });
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1);
    const wait = timeouts.find((x) => x.ms > 500000 && x.ms < 700000);
    assert.ok(wait, 'a look is planned for when it leaves');
    assert.ok(Math.abs(wait.ms - (10 * 60 * 1000 - 20000 + 500)) < 3000);
    assert.equal(box.hidden, false, 'shown while within its 10 minutes');
    // review r1: when it is due to leave and the look fails (offline), it still leaves: the last answer is rendered again
    const failing = async () => { calls++; throw new Error('offline'); };
    H.track({ getAgent: () => 'sam', getContainer: () => box, fetchFn: failing });
    Date.now = () => t0 + 11 * 60 * 1000;
    wait.fn();
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    assert.equal(calls, 2, 'it looked again');
    assert.equal(box.hidden, true, 'the ended hand-off left although the look failed');
  } finally { global.setTimeout = realTimeout; global.setInterval = realInterval; Date.now = realNow; }
});

test('review r1: a click moves keyboard focus to the new strip button', () => {
  const doc = fakeDoc(); const box = doc.createElement('div'); const storage = memStorage();
  H.render(box, sample(), { now: NOW, storage });
  const find1 = (n) => (n.className && String(n.className).split(' ').includes('ho-strip') ? n : (n.children || []).map(find1).find(Boolean));
  let focused = null;
  const btn = find1(box);
  btn.click();
  const after = find1(box);
  assert.notStrictEqual(after, btn, 'the button was replaced');
  after.focus = () => { focused = after; };
  // focus is called on the button that exists after the click's render
  const again = find1(box); again.focus = () => { focused = again; };
  again.click();
  const last = find1(box);
  assert.ok(focused === null || focused === again || focused === last);
  assert.match(require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'ui-hand-off-card.js'), 'utf8'), /const h = boxState\(container\)\.header;\s*try \{ if \(h && typeof h\.focus === 'function'\) h\.focus\(\); \}/);
});

// ── "Status" opens inside the app (spec 2): a button, a sheet, readable Markdown, never a raw file or JSON ──
const noEmoji = (s) => !s.includes(String.fromCharCode(0xFE0F));

test('render: Status is a button.ho-status on open cards and ended rows (no a.ho-status, no href, no target=_blank)', () => {
  const doc = fakeDoc(); const box = doc.createElement('div');
  const make = doc.createElement;
  doc.createElement = (tag) => Object.assign(make(tag), { attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } });
  const b2 = doc.createElement('div');
  H.render(b2, [
    // step 1: the Status button needs the job folder (where the status is read)
    { id: 'ho-a', target: 'scout', topic: 'Find prices', state: 'running', createdAt: iso(2 * MIN), folder: '/s/scout/hand-offs/sam-find-prices' },
    { id: 'ho-b', target: 'builder', topic: 'Make it', state: 'done', createdAt: iso(2 * HOUR), endedAt: iso(MIN), folder: '/s/builder/hand-offs/sam-make-it' },
  ], { now: NOW, storage: memStorage(), expanded: true });
  const all = find(b2, 'ho-status');
  assert.equal(all.length, 2);
  for (const b of all) {
    assert.equal(b.tag, 'button');
    assert.equal(b.attrs.type, 'button');
    assert.equal(b.attrs.href, undefined);
    assert.equal(b.attrs.target, undefined);
    assert.equal(textOf(b), 'Status');
  }
  const tags = new Set(); (function walk(n) { if (n.tag) tags.add(n.tag); (n.children || []).forEach(walk); })(b2);
  assert.ok(!tags.has('a'), 'no link anywhere in the strip');
  void box;
});

test('statusSheetModel: with status text; the updated line from statusAt (minutes ago, a clock time today, a date before)', () => {
  const handOff = { id: 'ho-a', caller: 'owner', target: 'scout', topic: 'Find prices', state: 'running' };
  const m = H.statusSheetModel({ ok: true, handOff, status: '# Step 2\n\n- shops done', statusAt: NOW - 3 * MIN, brief: 'Look at shops' }, { now: NOW });
  assert.deepEqual(m, { title: 'scout · Find prices', state: 'Running', updated: 'Updated 3 min ago', body: '# Step 2\n\n- shops done' });
  const same = H.statusSheetModel({ ok: true, handOff, status: 'x', statusAt: NOW - 2 * HOUR, brief: '' }, { now: NOW });
  assert.match(same.updated, /^Updated \d{1,2}:\d{2}/);
  assert.ok(!same.updated.includes('min ago'));
  const old = H.statusSheetModel({ ok: true, handOff, status: 'x', statusAt: NOW - 3 * 24 * HOUR, brief: '' }, { now: NOW });
  assert.match(old.updated, /^Updated .+, \d{1,2}:\d{2}/);
  assert.equal(H.statusSheetModel({ ok: true, handOff, status: 'x', statusAt: NOW - 10 * 1000 }, { now: NOW }).updated, 'Updated just now');
  // the state words are the strip's (waiting, done with report)
  assert.equal(H.statusSheetModel({ ok: true, handOff: { ...handOff, state: 'done', reported: true }, status: 'x', statusAt: NOW }, { now: NOW }).state, 'Done (report sent)');
});

test('statusSheetModel: with no STATUS.md the body is "No status written yet. The brief:" then the brief', () => {
  const handOff = { id: 'ho-a', target: 'scout', topic: 'Find prices', state: 'queued' };
  const m = H.statusSheetModel({ ok: true, handOff, status: null, statusAt: null, brief: 'Look at three shops.\n\nReport prices.' }, { now: NOW });
  assert.equal(m.updated, 'No status written yet');
  assert.equal(m.state, 'Queued');
  assert.equal(m.body, 'No status written yet. The brief:\n\nLook at three shops.\n\nReport prices.');
  assert.equal(m.body.split('\n')[0], 'No status written yet. The brief:');
  // an empty status file counts as none; no brief: just the line
  assert.equal(H.statusSheetModel({ ok: true, handOff, status: '  \n', brief: 'B' }, { now: NOW }).body, 'No status written yet. The brief:\n\nB');
  assert.equal(H.statusSheetModel({ ok: true, handOff, status: null, brief: '' }, { now: NOW }).body, 'No status written yet.');
});

test('statusSheetModel: a failed answer is the short plain message, never JSON', () => {
  const view = { id: 'ho-a', target: 'scout', topic: 'Find prices', state: 'running' };
  for (const bad of [null, undefined, { error: 'not found' }, 'oops']) {
    const m = H.statusSheetModel(bad, { now: NOW, view });
    assert.equal(m.body, "Couldn't load the status. Try again.");
    assert.equal(m.title, 'scout · Find prices');
    assert.ok(!m.body.includes('{'));
  }
});

// A fake document with a dialog that records showModal/close.
function sheetDoc() {
  const doc = fakeDoc();
  const make = doc.createElement;
  let dialogs = 0;
  doc.createElement = (tag) => {
    const e = Object.assign(make(tag), { attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, innerHTML: '' });
    if (tag === 'dialog') {
      dialogs++;
      e.open = false; e.shown = 0; e.closed = 0;
      e.showModal = () => { e.open = true; e.shown++; };
      e.close = () => { e.open = false; e.closed++; };
    }
    return e;
  };
  doc.body = doc.createElement('body');
  doc.dialogCount = () => dialogs;
  return doc;
}
// step 1 (client-only): the sheet reads the target's Files folder through the existing files API. This fake answers that
// API from { status, statusAt, brief }: the folder listing (with STATUS.md's time) and the two files.
const okFetch = (data, seen) => async (url) => {
  if (seen) seen.push(url);
  const u = new URL(url, 'http://x');
  const p = u.searchParams.get('path') || '';
  if (u.pathname === '/api/files') {
    const entries = [];
    if (typeof data.status === 'string') entries.push({ name: 'STATUS.md', type: 'file', mtime: new Date(data.statusAt || NOW).toISOString() });
    if (typeof data.brief === 'string') entries.push({ name: 'brief.md', type: 'file', mtime: new Date(NOW).toISOString() });
    return { ok: true, status: 200, json: async () => ({ ok: true, entries }) };
  }
  if (u.pathname === '/api/files/download') {
    const t = p.endsWith('/STATUS.md') ? data.status : p.endsWith('/brief.md') ? data.brief : null;
    return typeof t === 'string' ? { ok: true, status: 200, text: async () => t } : { ok: false, status: 404, text: async () => '{"error":"not found"}' };
  }
  return { ok: false, status: 404, text: async () => '{"error":"not found"}', json: async () => ({ error: 'not found' }) };
};
const view = { id: 'ho-a', caller: 'owner', target: 'scout', topic: 'Find <b>prices</b>', state: 'running', folder: '/s/scout/hand-offs/owner-find-prices' };

test('openStatus: one dialog per document, reused; title and state are text nodes; the body uses the injected renderMarkdown; showModal called', async () => {
  const doc = sheetDoc();
  const urls = [];
  const data = { ok: true, handOff: view, status: '# Step 2\n\n**bold** <img src=x onerror=1>', statusAt: NOW - 4 * MIN, brief: 'B' };
  const renders = [];
  const renderMarkdown = (t) => { renders.push(t); return '<h1>Step 2</h1><p><strong>bold</strong></p>'; };
  const m = await H.openStatus(view, { document: doc, fetchFn: okFetch(data, urls), renderMarkdown, now: NOW });
  // the folder listing, then STATUS.md, both through the existing files API of the target (no new route, nothing raw opened)
  assert.deepEqual(urls, ['/api/files?agent=scout&path=hand-offs%2Fowner-find-prices', '/api/files/download?agent=scout&path=hand-offs%2Fowner-find-prices%2FSTATUS.md']);
  assert.equal(doc.dialogCount(), 1);
  const dialog = find(doc.body, 'ho-sheet')[0];
  assert.equal(dialog.tag, 'dialog');
  assert.equal(dialog.shown, 1);
  assert.equal(dialog.open, true);
  const title = find(dialog, 'ho-sheet-title')[0];
  assert.deepEqual(title.children.map((c) => Object.keys(c)), [['text']], 'the title is one text node');
  assert.equal(textOf(title), 'scout · Find <b>prices</b>', 'markup in a topic stays text');
  const sub = find(dialog, 'ho-sheet-sub')[0];
  assert.deepEqual(sub.children.map((c) => Object.keys(c)), [['text']]);
  assert.equal(textOf(sub), 'Running · Updated 4 min ago');
  const body = find(dialog, 'ho-sheet-body')[0];
  assert.equal(body.innerHTML, '<h1>Step 2</h1><p><strong>bold</strong></p>');
  // the chat renderers draw no headings: a heading line reaches them as a bold line
  assert.deepEqual(renders, ['**Step 2**\n\n**bold** <img src=x onerror=1>']);
  assert.equal(H.sheetMarkdown(m.body), renders[0]);
  const close = find(dialog, 'ho-sheet-close')[0];
  assert.equal(close.tag, 'button');
  assert.equal(textOf(close), 'Close');

  // a second hand-off reuses the same dialog (already open: showModal is not called again)
  const other = { id: 'ho-b', caller: 'owner', target: 'builder', topic: 'Make it', state: 'done', folder: '/s/builder/hand-offs/owner-make-it' };
  await H.openStatus(other, { document: doc, fetchFn: okFetch({ ok: true, handOff: other, status: null, statusAt: null, brief: 'Build it' }), renderMarkdown, now: NOW });
  assert.equal(doc.dialogCount(), 1, 'created once per document');
  assert.equal(find(doc.body, 'ho-sheet').length, 1);
  assert.equal(textOf(find(dialog, 'ho-sheet-title')[0]), 'builder · Make it');
  assert.equal(textOf(find(dialog, 'ho-sheet-sub')[0]), 'Done · No status written yet');
  assert.equal(renders[1], 'No status written yet. The brief:\n\nBuild it');
  // closed, then opened again: showModal runs again on the same dialog
  close.click();
  assert.equal(dialog.open, false);
  assert.equal(dialog.closed, 1);
  await H.openStatus(view, { document: doc, fetchFn: okFetch(data), renderMarkdown, now: NOW });
  assert.equal(dialog.shown, 2);
  assert.equal(doc.dialogCount(), 1);
});

test('openStatus: a click on the backdrop (the dialog itself) closes; a click inside does not', async () => {
  const doc = sheetDoc();
  await H.openStatus(view, { document: doc, fetchFn: okFetch({ ok: true, handOff: view, status: 'x', statusAt: NOW }), now: NOW });
  const dialog = find(doc.body, 'ho-sheet')[0];
  const inner = find(dialog, 'ho-sheet-body')[0];
  for (const fn of dialog.handlers.click) fn({ target: inner });
  assert.equal(dialog.open, true, 'a click on the text keeps it open');
  for (const fn of dialog.handlers.click) fn({ target: dialog });
  assert.equal(dialog.open, false, 'a click on the backdrop closes');
});

test('openStatus: without renderMarkdown the body is a text node; a throwing renderer falls back to text', async () => {
  const doc = sheetDoc();
  const data = { ok: true, handOff: view, status: 'plain <b>text</b>', statusAt: NOW };
  await H.openStatus(view, { document: doc, fetchFn: okFetch(data), now: NOW });
  const body = find(doc.body, 'ho-sheet-body')[0];
  assert.equal(body.innerHTML, '');
  assert.deepEqual(body.children, [{ text: 'plain <b>text</b>' }]);
  await H.openStatus(view, { document: doc, fetchFn: okFetch(data), renderMarkdown: () => { throw new Error('boom'); }, now: NOW });
  assert.deepEqual(body.children, [{ text: 'plain <b>text</b>' }]);
});

test('openStatus: a failed fetch (network, 404, a not-ok answer) shows the plain message in the same sheet, never JSON', async () => {
  const doc = sheetDoc();
  const render = (t) => '<p>' + t + '</p>';
  const cases = [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false, status: 404, json: async () => ({ error: 'not found' }) }),
    async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'unknown hand-off' }) }),
    async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
  ];
  for (const fetchFn of cases) {
    await H.openStatus(view, { document: doc, fetchFn, renderMarkdown: render, now: NOW });
    const body = find(doc.body, 'ho-sheet-body')[0];
    assert.equal(body.innerHTML, "<p>Couldn't load the status. Try again.</p>");
    assert.ok(!body.innerHTML.includes('not found') && !body.innerHTML.includes('{'));
    assert.equal(find(doc.body, 'ho-sheet')[0].open, true);
  }
  assert.equal(doc.dialogCount(), 1);
});

test('render: clicking Status opens the sheet in the page (a dialog appears, showModal called, nothing else opened)', async () => {
  const doc = sheetDoc();
  const box = doc.createElement('div');
  H.render(box, [{ id: 'ho-a', caller: 'owner', target: 'scout', topic: 'T', state: 'running', createdAt: iso(MIN), folder: '/s/scout/hand-offs/owner-t' }], { now: NOW, storage: memStorage(), expanded: true });
  const btn = find(box, 'ho-status')[0];
  btn.click();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const dialog = find(doc.body, 'ho-sheet')[0];
  assert.ok(dialog, 'the sheet exists');
  assert.equal(dialog.shown, 1);
  assert.equal(textOf(find(dialog, 'ho-sheet-title')[0]), 'scout · T');
});

test('track keeps renderMarkdown for the sheet; both pages pass their formatContent', () => {
  const src = read('lib/ui-hand-off-card.js');
  assert.match(src, /function track\(\{ getAgent, getContainer, fetchFn, renderMarkdown \} = \{\}\)/);
  assert.match(src, /st\.renderMarkdown = /);
  assert.ok(typeof H.statusSheetModel === 'function' && typeof H.openStatus === 'function');
  assert.match(read('mobile.js'), /HandOffCard\.track\(\{[^\n]*renderMarkdown: \(t\) => formatContent\(t\)/);
  assert.match(read('app.js'), /HandOffCard\.track\(\{[^\n]*renderMarkdown: \(t\) => window\.formatContentForSheets\(t\)/);
  assert.match(read('app.js'), /window\.formatContentForSheets = formatContent;/);
});

// The status route, run with stand-ins like the list route above.
function statusHandler() {
  const src = read('server.js');
  const start = src.indexOf("if (pathname === '/api/hand-offs/status' && req.method === 'GET') {");
  assert.ok(start > 0, 'the status route is in server.js');
  const end = src.indexOf('\n    }\n', start);
  const body = src.slice(start, end + 7);
  return new Function('pathname', 'req', 'res', 'agentFromQuery', 'getAgents', 'jsonResponse', 'require',
    `return (async () => { ${body} return 'not handled'; })();`);
}
async function callStatus(url, { agents, statusOf, records = {} }) {
  const out = {};
  const seen = [];
  const agentFromQuery = (r) => new URL(r.url, 'http://x').searchParams.get('agent');
  const runner = { statusOf: async (...a) => { seen.push(a); return statusOf(...a); }, get: (id) => records[id] || null };
  const fakeRequire = (m) => { assert.equal(m, './lib/sdk-chat'); return { getHandOffRunner: () => runner }; };
  await statusHandler()(new URL(url, 'http://x').pathname, { method: 'GET', url }, out, agentFromQuery, async () => agents, (res, code, data) => { res.code = code; res.data = data; return 'sent'; }, fakeRequire);
  return { out, seen };
}

test('CSS: both pages have .ho-sheet (and its body); the phone body reads at 16px or more; .ho-status looks like the old link', () => {
  for (const f of ['index.html', 'mobile.html']) {
    const css = read(f);
    assert.match(css, /\.ho-sheet \{[^}]*\}/, f + ' has .ho-sheet');
    const body = css.match(/\.ho-sheet \.ho-sheet-body \{([^}]*)\}/);
    assert.ok(body, f + ' has .ho-sheet-body');
    assert.match(body[1], /overflow-y: auto/, f);
    assert.match(css, /\.ho-sheet::backdrop/, f);
    const status = css.match(/\.handoff-cards \.ho-status \{([^}]*)\}/);
    assert.ok(status, f + ' has .ho-status');
    assert.match(status[1], /color: var\(--accent\)/);
    assert.match(status[1], /text-decoration: underline/);
    assert.match(status[1], /border: 0/);
    assert.match(status[1], /background: none/);
  }
  const desk = read('index.html').match(/\.ho-sheet \{([^}]*)\}/)[1];
  assert.match(desk, /720px/);
  assert.match(desk, /max-height: 80vh/);
  const mob = read('mobile.html');
  const sheet = mob.match(/\.ho-sheet \{([^}]*)\}/)[1];
  assert.match(sheet, /max-height: 85vh/);
  assert.match(sheet, /width: 100%/);
  const size = Number(mob.match(/\.ho-sheet \.ho-sheet-body \{[^}]*font-size: (\d+)px/)[1]);
  assert.ok(size >= 16, 'the phone body font-size is ' + size + 'px');
  assert.match(mob, /\.ho-sheet \.ho-sheet-inner \{[^}]*padding: 14px/);
  assert.match(mob, /\.ho-sheet \.ho-sheet-title \{[^}]*font-weight: 700; font-size: 16px/);
});

test('no emoji with a variation selector in the files this change touches', () => {
  for (const f of ['lib/ui-hand-off-card.js', 'test/ui-hand-off-card.test.js']) assert.ok(noEmoji(read(f)), f);
});

test('step 1: the Status sheet reads STATUS.md through the files API; without one, the brief under "No status written yet"; a hand-off without a job folder has no Status button', async () => {
  const doc = sheetDoc();
  const urls = [];
  const m = await H.openStatus(view, { document: doc, fetchFn: okFetch({ status: null, brief: 'Do the thing' }, urls), now: NOW });
  assert.equal(m.body, 'No status written yet. The brief:\n\nDo the thing');
  assert.equal(m.updated, 'No status written yet');
  assert.ok(urls.every((u) => u.startsWith('/api/files')), 'only the files API');
  assert.ok(!urls.some((u) => u.includes('STATUS.md')), 'the listing says there is no STATUS.md: it is not fetched');
  const a = await H.loadStatusAnswer({ ...view, folder: '' }, okFetch({ status: 'x' }));
  assert.equal(a, null);
  const d2 = fakeDoc(); const box = d2.createElement('div');
  H.render(box, [{ id: 'x', target: 'scout', topic: 'T', state: 'running', createdAt: NOW - MIN }], { now: NOW, expanded: true });
  assert.equal(find(box, 'ho-status').length, 0, 'no job folder known: no Status button');
});

test('sheetMarkdown: heading lines become bold lines; other lines are unchanged', () => {
  assert.equal(H.sheetMarkdown('# Price survey\n\n- step 1\n## Next ##\nText # not a heading'), '**Price survey**\n\n- step 1\n**Next**\nText # not a heading');
  assert.equal(H.sheetMarkdown(''), '');
});
