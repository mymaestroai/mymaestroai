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

test('visible: open ones and those ended within 24 h, at most 5, open first then newest first', () => {
  const v = [
    { id: 'old', state: 'done', createdAt: iso(40 * HOUR), endedAt: iso(30 * HOUR) },
    { id: 'recent', state: 'failed', createdAt: iso(5 * HOUR), endedAt: iso(4 * HOUR) },
    { id: 'open-old', state: 'waiting', createdAt: iso(60 * HOUR) },
    { id: 'new', state: 'running', createdAt: iso(1 * MIN) },
  ];
  // open ones first (review r1), each group newest first
  assert.deepEqual(H.visible(v, { now: NOW }).map((x) => x.id), ['new', 'open-old', 'recent']);
  const many = Array.from({ length: 8 }, (_, i) => ({ id: 'h' + i, state: 'running', createdAt: iso(i * MIN) }));
  const shown = H.visible(many, { now: NOW });
  assert.equal(shown.length, 5);
  assert.deepEqual(shown.map((x) => x.id), ['h0', 'h1', 'h2', 'h3', 'h4']);
  assert.deepEqual(H.visible(null), []);
  assert.deepEqual(H.visible([null, 5, {}]), []);
});

// A minimal fake DOM: only text nodes and elements; a node made from markup would show up as an element, never as text.
function fakeDoc() {
  const doc = {
    createElement(tag) {
      const e = { tag, className: '', children: [], hidden: false, ownerDocument: doc, get firstChild() { return this.children[0] || null; },
        appendChild(c) { this.children.push(c); return c; }, removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; } };
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
    { target: 'builder', topic: 'Make it', state: 'done', createdAt: iso(2 * HOUR), endedAt: iso(1 * HOUR) },
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
  assert.deepEqual([...tags].sort(), ['div', 'span']);
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
  assert.equal(shown.length, 5);
  assert.equal(shown[0].id, 'r1');
});
