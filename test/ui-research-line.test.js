'use strict';
// The deep research progress line: the route GET /api/research/status?agent=, the per-viewer filter of the
// research_progress event, and the line above the message box on the desktop page (app.js) and the phone (mobile.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const access = require('../lib/access');
const { createHubEvents } = require('../lib/hub-events');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js'), app = read('app.js'), mob = read('mobile.js');

// ── route ──
const AGENTS = [{ name: 'boss', owner: null }, { name: 'sam-bot', owner: 'sam' }, { name: 'ann-bot', owner: 'ann' }];
const SAM = { id: 'sam', role: 'member' }, ADMIN = { id: 'a', role: 'admin' };
function handler() {
  const start = server.indexOf("if (pathname === '/api/research/status' && req.method === 'GET') {");
  assert.ok(start > 0, 'the route is in server.js');
  const end = server.indexOf('\n    }\n', start);
  const body = server.slice(start, end + 7);
  return new Function('pathname', 'req', 'res', 'agentFromQuery', 'getAgents', 'jsonResponse', 'require', 'access', 'temporalWorkersLib',
    `return (async () => { ${body} return 'not handled'; })();`);
}
async function call(url, { user, service = false, status }) {
  const out = {}, seen = [];
  const req = { method: 'GET', url, hubUser: user, hubService: service };
  const fakeRequire = (m) => { assert.equal(m, './lib/sdk-chat'); return status === undefined ? {} : { researchStatusFor: (a) => { seen.push(a); return status[a] || []; } }; };
  await handler()(new URL(url, 'http://x').pathname, req, out, (r) => new URL(r.url, 'http://x').searchParams.get('agent'), async () => AGENTS,
    (res, code, data) => { res.code = code; res.data = data; return 'sent'; }, fakeRequire, access, { getVirtual: () => null });
  return { out, seen };
}
const RUN = { id: 'dr-1', level: 'thorough', stage: 'reading', label: 'reading sources in full (3 of 12)', done: 3, total: 12, startedAt: 1000 };

test('route: signed in only (the gate), no admin-only fallback', () => {
  assert.deepEqual(access.classifyRoute('/api/research/status', 'GET'), { kind: 'session' });
});
test('route: the owner sees the runs of their agent, only that agent\'s', async () => {
  const x = await call('/api/research/status?agent=sam-bot', { user: SAM, status: { 'sam-bot': [RUN], 'ann-bot': [{ ...RUN, id: 'dr-2' }] } });
  assert.equal(x.out.code, 200);
  assert.deepEqual(x.out.data, { runs: [RUN] });
  assert.deepEqual(x.seen, ['sam-bot']);
});
test('route: a member cannot see another person\'s or an admin agent (404, nothing looked up); an admin sees any', async () => {
  for (const n of ['ann-bot', 'boss']) {
    const x = await call('/api/research/status?agent=' + n, { user: SAM, status: { [n]: [RUN] } });
    assert.equal(x.out.code, 404, n);
    assert.equal(x.seen.length, 0);
    assert.ok(x.out.data.error);
  }
  const a = await call('/api/research/status?agent=ann-bot', { user: ADMIN, status: { 'ann-bot': [RUN] } });
  assert.deepEqual(a.out.data, { runs: [RUN] });
});
test('route: unknown or missing agent 404; no researchStatusFor yet gives an empty list', async () => {
  assert.equal((await call('/api/research/status?agent=nobody', { user: ADMIN, status: {} })).out.code, 404);
  assert.equal((await call('/api/research/status', { user: ADMIN, status: {} })).out.code, 404);
  const x = await call('/api/research/status?agent=sam-bot', { user: SAM });
  assert.equal(x.out.code, 200);
  assert.deepEqual(x.out.data, { runs: [] });
});
test('route: signed out is answered 401 by the gate before the handler', () => {
  const gate = server.indexOf("if ((!req.hubService && !req.hubUser) || req.hubPendingTotp) {");
  assert.ok(gate > 0 && gate < server.indexOf("pathname === '/api/research/status'"));
  assert.equal(access.classifyRoute('/api/research/status', 'GET').kind, 'session');
});

// ── event filter ──
function fakeRes() {
  const r = { chunks: [], writableLength: 0, handlers: {} };
  r.writeHead = () => {}; r.write = (s) => { r.chunks.push(s); return true; }; r.on = (e, f) => { r.handlers[e] = f; }; r.destroy = () => {};
  return r;
}
test('research_progress reaches only the viewers who may see that agent', () => {
  const hub = createHubEvents();
  const own = (names) => ({ isAdmin: false, visibleAgent: (n) => names.includes(n), filter: (ev) => names.includes(ev.agent) });
  const sam = fakeRes(), ann = fakeRes(), adm = fakeRes();
  hub.subscribe({ headers: {} }, sam, own(['sam-bot']));
  hub.subscribe({ headers: {} }, ann, own(['ann-bot']));
  hub.subscribe({ headers: {} }, adm, { isAdmin: true, visibleAgent: () => true, filter: () => true });
  const n = (r) => r.chunks.filter(c => c.includes('event: research_progress')).length;
  hub.publish('research_progress', { agent: 'sam-bot', id: 'dr-1', level: 'thorough', state: 'running', label: 'x', startedAt: 1 });
  assert.equal(n(sam), 1); assert.equal(n(ann), 0); assert.equal(n(adm), 1);
  assert.match(sam.chunks.join(''), /"id":"dr-1"/);
});
test('the /api/events route filters every agent event by what the viewer may see', () => {
  assert.match(server, /: visible\(ev\.agent\) \}\);/);
});

// ── page logic ──
function load(src, extra) {
  const a = src.indexOf('// Deep research progress line');
  const b = src.indexOf('setInterval(() => { if (researchRuns.size) researchLinePaint(); }, 60000);');
  assert.ok(a > 0 && b > a, 'the progress line block is there');
  const mk = (tag) => ({ tag, children: [], className: '', textContent: '', hidden: true, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); } });
  const boxes = {};
  const box = (id) => (boxes[id] ||= (() => { const o = mk('div'); let t = ''; Object.defineProperty(o, 'textContent', { get: () => t, set: (v) => { t = v; o.children.length = 0; } }); return o; })());
  const ctx = vm.createContext({ document: { createElement: mk, getElementById: (id) => (id in boxes ? boxes[id] : null) }, Date, Number, String, Map, Array, Math, console, ...extra });
  ctx.box = box; ctx.boxes = boxes;
  vm.runInContext(src.slice(a, b) + '\nthis.text = researchLineText; this.apply = researchLineApply; this.runs = researchRuns; this.fill = researchLineFill; this.loadRuns = researchLineLoad;', ctx);
  return ctx;
}
const lines = (b) => b.children.map(c => c.textContent);
const T0 = 1_000_000_000_000;
for (const [name, src] of [['desktop', app], ['phone', mob]]) {
  test(`${name}: the line text from a status entry (level capitalised, label, elapsed wording)`, () => {
    const c = load(src, {});
    assert.equal(c.text({ level: 'thorough', label: 'reading sources in full (3 of 12)', startedAt: T0 }, T0 + 14 * 60000 + 5000), 'Deep research (Thorough): reading sources in full (3 of 12) · 14 min');
    assert.equal(c.text({ level: 'quick', label: 'searching', startedAt: T0 }, T0 + 20000), 'Deep research (Quick): searching · just started');
    assert.equal(c.text({ level: 'thorough', stage: 'planning', startedAt: T0 }, T0 + 60000), 'Deep research (Thorough): planning · 1 min');
  });
  test(`${name}: appears on an event, ignores other agents, one line per run (at most 3), gone on delivered or failed`, () => {
    const c = load(src, name === 'desktop'
      ? { chats: { c1: { agent: 'sam-bot' } } }
      : { screen: 'chat', current: 'sam-bot' });
    const b = c.box(name === 'desktop' ? 'research-lines-c1' : 'research-lines');
    // apply() calls the page's own researchLinePaint(): run that function from the page source on this box
    const a = src.indexOf('function researchLinePaint()');
    assert.ok(a > 0);
    vm.runInContext(src.slice(a, src.indexOf('\n', a + 30) > 0 && name === 'phone' ? src.indexOf('\n', a) : src.indexOf('\n}\n', a) + 3), c);
    const ev = (o) => ({ type: 'research_progress', agent: 'sam-bot', id: 'dr-1', level: 'thorough', label: 'reading sources in full (3 of 12)', state: 'running', startedAt: Date.now() - 14 * 60000, ...o });
    c.apply(ev({}));
    assert.equal(b.hidden, false);
    assert.deepEqual(lines(b), ['Deep research (Thorough): reading sources in full (3 of 12) · 14 min']);
    c.apply(ev({ agent: 'other-bot', id: 'dr-9' }));
    assert.equal(lines(b).length, 1, 'another agent\'s run is not shown');
    c.apply(ev({ label: 'reading sources in full (4 of 12)' }));
    assert.match(lines(b)[0], /\(4 of 12\)/);
    assert.equal(lines(b).length, 1, 'same run: updated, not added');
    for (const i of [2, 3, 4]) c.apply(ev({ id: 'dr-' + i, level: 'quick', label: 'run ' + i, startedAt: Date.now() - i * 1000 }));
    assert.equal(lines(b).length, 3, 'at most three lines');
    c.apply(ev({ state: 'delivering' }));
    assert.equal(lines(b).length, 3);
    for (const i of [2, 3, 4]) c.apply(ev({ id: 'dr-' + i, state: 'failed' }));
    c.apply(ev({ state: 'delivered' }));
    assert.equal(lines(b).length, 0);
    assert.equal(b.hidden, true);
  });
}
test('wiring: both pages read research_progress, load the status route on open, and place the line under the Tasks cards', () => {
  assert.match(app, /addEventListener\('research_progress'/);
  assert.match(mob, /on\('research_progress', researchLineApply\)/);
  assert.match(app, /\/api\/research\/status\?agent=/);
  assert.match(mob, /\/api\/research\/status\?agent=/);
  assert.match(app, /switchToChat[\s\S]{0,3000}researchLineLoad\(opened\.agent\)/);
  assert.match(mob, /localStorage\.setItem\('hub-mobile-last', name\);\r?\n\s*voiceStatusRefresh\(\);[^\n]*\r?\n\s*researchLinePaint\(\); researchLineLoad\(name\);/);
  assert.match(app, /id="handoff-cards-\$\{chatId\}" hidden><\/div>\n\s*<div class="handoff-cards research-lines" id="research-lines-\$\{chatId\}"/);
  assert.match(read('mobile.html'), /id="handoff-cards" class="handoff-cards" hidden><\/div>\n\s*<div id="research-lines" class="handoff-cards research-lines" hidden>/);
  for (const f of ['index.html', 'mobile.html']) assert.match(read(f), /\.research-lines \.research-line \{[^}]*white-space: normal/);
});

// ── the status answer and the events race: merged, never replaced ──
for (const [name, src] of [['desktop', app], ['phone', mob]]) {
  function race() {
    let clock = 1000;
    let release;
    let answer = { runs: [] };
    const reply = () => ({ ok: true, json: async () => answer });
    const gate = () => new Promise((r) => { release = () => r(reply()); });
    const extra = name === 'desktop'
      ? { chats: {}, fetch: () => gate() }
      : { screen: 'list', current: null, api: () => gate() };
    const c = load(src, { ...extra, Date: { now: () => clock } });
    return { c, tick: (ms = 10) => { clock += ms; }, answerWith: (runs) => { answer = { runs }; }, release: () => release() };
  }
  const run = (o) => ({ id: 'dr-1', level: 'thorough', stage: 'read', label: 'x', done: 1, total: 3, startedAt: 1, ...o });
  const ev = (o) => ({ agent: 'sam-bot', state: 'running', ...run({}), ...o });
  const labelOf = (c, id = 'dr-1') => { const m = c.runs.get('sam-bot'); const e = m && m.get(id); return e ? e.label : undefined; };

  test(`${name}: a status answer does not overwrite a newer event that arrived while it was fetched`, async () => {
    const r = race();
    const p = r.c.loadRuns('sam-bot');
    r.tick();
    r.c.apply(ev({ label: 'newer', seq: 7 }));
    r.answerWith([run({ label: 'older', seq: 4 })]);
    r.release(); await p;
    assert.equal(labelOf(r.c), 'newer');
  });
  test(`${name}: a status answer that is newer than what the page had does replace it`, async () => {
    const r = race();
    r.c.apply(ev({ label: 'before', seq: 2 }));
    r.tick();
    const p = r.c.loadRuns('sam-bot');
    r.answerWith([run({ label: 'fresh', seq: 9 })]);
    r.release(); await p;
    assert.equal(labelOf(r.c), 'fresh');
  });
  test(`${name}: a run that got its delivered/failed event during the fetch is not brought back`, async () => {
    for (const state of ['delivered', 'failed']) {
      const r = race();
      r.c.apply(ev({ seq: 1 }));
      const p = r.c.loadRuns('sam-bot');
      r.tick();
      r.c.apply(ev({ state, seq: 5 }));
      r.answerWith([run({ seq: 3 })]);   // the answer was made while the run still ran
      r.release(); await p;
      assert.equal(r.c.runs.has('sam-bot'), false, state);
      r.c.apply(ev({ label: 'late event', seq: 4 }));
      assert.equal(r.c.runs.has('sam-bot'), false, 'a late non-terminal event does not bring it back either');
    }
  });
  test(`${name}: the answer is merged into the current runs: one an event added meanwhile stays, one that ended unnoticed goes`, async () => {
    const r = race();
    r.c.apply(ev({ id: 'dr-old', seq: 1 }));     // seen before the fetch; the answer no longer lists it
    r.tick();
    const p = r.c.loadRuns('sam-bot');
    r.tick();
    r.c.apply(ev({ id: 'dr-new', seq: 2, startedAt: 5 }));   // an event that came while fetching, not in the answer
    r.answerWith([run({ id: 'dr-kept', seq: 1, startedAt: 3 })]);
    r.release(); await p;
    const ids = [...r.c.runs.get('sam-bot').keys()].sort();
    assert.deepEqual(ids, ['dr-kept', 'dr-new']);
  });
  test(`${name}: an older event never overwrites a newer one for the same run`, () => {
    const r = race();
    r.c.apply(ev({ label: 'seq 6', seq: 6 }));
    r.c.apply(ev({ label: 'seq 5', seq: 5 }));
    assert.equal(labelOf(r.c), 'seq 6');
    r.c.apply(ev({ label: 'seq 7', seq: 7 }));
    assert.equal(labelOf(r.c), 'seq 7');
  });
}
