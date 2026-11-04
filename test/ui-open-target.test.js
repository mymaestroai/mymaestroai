'use strict';
// A notification tapped while the desktop page is open (2026-11): the service worker offers the target to the open
// hub tabs and tells one to go. A page says yes to an offer it can take and acts only on go, so a tab the worker gave
// up on (or gave the target to another tab) never acts. The page listens before its start-up awaits anything; a go
// that comes before the agent list is in waits, kept in this tab's sessionStorage across a reload or the sign-in page.
// Targets run one after another, so an owner-view switch for one can't land on top of the next.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseOpenTarget, createOpenTargets, createTargetStore } = require('../lib/ui-open-target');

const ORIGIN = 'http://localhost:8888';
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── open-target helpers (begin) ──';
const END = '// ── open-target helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}
// An offer as the page receives it: the message and the port the worker listens on.
function offer(url) {
  const port = { sent: [], closed: false, onmessage: null, postMessage(m) { this.sent.push(m); }, close() { this.closed = true; } };
  return { e: { data: { type: 'open-target', url }, ports: [port] }, port, go: () => port.onmessage && port.onmessage({ data: { go: true } }) };
}
function memoryStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; }
const tick = () => new Promise(r => setImmediate(r));

test('the open-target helpers are byte-identical in lib/ui-open-target.js and app.js', () => {
  assert.strictEqual(helperBlock(read('app.js'), '    '), helperBlock(read('lib/ui-open-target.js'), ''), 'app.js copy differs from lib/ui-open-target.js');
});

test('parseOpenTarget: the main page only, this origin only', () => {
  assert.deepStrictEqual(parseOpenTarget({ type: 'open-target', url: '/?agent=forge' }, ORIGIN), { agent: 'forge', backups: false, update: false, security: false });
  assert.deepStrictEqual(parseOpenTarget({ type: 'open-target', url: '/index.html?backups=1' }, ORIGIN), { agent: '', backups: true, update: false, security: false });
  assert.deepStrictEqual(parseOpenTarget({ type: 'open-target', url: '/?update=1' }, ORIGIN), { agent: '', backups: false, update: true, security: false });
  assert.deepStrictEqual(parseOpenTarget({ type: 'open-target', url: `${ORIGIN}/?agent=my%20agent&security=1` }, ORIGIN), { agent: 'my agent', backups: false, update: false, security: true });
  for (const url of ['/users', '/mobile#chat=forge', 'https://example.com/?agent=forge', '//example.com/?agent=forge', '/\\example.com/?agent=x']) {
    assert.strictEqual(parseOpenTarget({ type: 'open-target', url }, ORIGIN), null, url);
  }
  assert.strictEqual(parseOpenTarget({ type: 'other', url: '/?agent=forge' }, ORIGIN), null);
  assert.strictEqual(parseOpenTarget({ type: 'open-target', url: 42 }, ORIGIN), null);
});

test('an offer is answered yes at once but acted on only when the worker says go', async () => {
  const ran = [];
  const t = createOpenTargets({ origin: ORIGIN, run: (x) => { ran.push(x.agent); } });
  t.ready(null);
  const o = offer('/?agent=forge');
  t.onMessage(o.e);
  assert.deepStrictEqual(o.port.sent, [{ ok: true }]);
  await tick();
  assert.deepStrictEqual(ran, [], 'a yes is not a go');
  o.go(); await tick();
  assert.deepStrictEqual(ran, ['forge']);
  assert.ok(o.port.closed, 'the offer is done');
  o.go(); await tick();
  assert.deepStrictEqual(ran, ['forge'], 'a second go does nothing');
});

test('an offer that never gets a go (the worker gave up, or chose another tab) is dropped', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ran = [];
  const ot = createOpenTargets({ origin: ORIGIN, run: (x) => ran.push(x), keepMs: 3000 });
  ot.ready(null);
  const o = offer('/?agent=forge');
  ot.onMessage(o.e);
  t.mock.timers.tick(3001);
  assert.ok(o.port.closed);
  o.go();
  assert.deepStrictEqual(ran, [], 'a go after the offer expired is ignored');
});

test('a foreign, malformed or other-page target is refused; a message without a port is ignored', () => {
  const ran = [];
  const ot = createOpenTargets({ origin: ORIGIN, run: (x) => ran.push(x) });
  ot.ready(null);
  for (const url of ['https://example.com/?agent=forge', '/users', 'http://[bad']) {
    const o = offer(url);
    ot.onMessage(o.e);
    assert.deepStrictEqual(o.port.sent, [{ ok: false }], url);
    assert.strictEqual(o.port.onmessage, null, 'nothing waits for a go');
  }
  ot.onMessage({ data: { type: 'open-target', url: '/?agent=forge' } });   // no port: not from the worker's protocol
  ot.onMessage({ data: { type: 'something-else' }, ports: [] }); ot.onMessage({ data: null }); ot.onMessage(null);
  assert.deepStrictEqual(ran, []);
});

test('a go while the page loads waits for ready(), survives a reload in this tab, and runs after the page address target', async () => {
  const storage = memoryStorage(); let clock = 1000;
  const store = createTargetStore(storage, () => clock);
  const ran = [];
  const first = createOpenTargets({ origin: ORIGIN, run: (x) => ran.push(x.agent || 'backups'), store });
  const a = offer('/?agent=forge'); first.onMessage(a.e); a.go();
  assert.deepStrictEqual(ran, [], 'not before the agent list is in');
  assert.strictEqual(JSON.parse(storage.m.get('hub-open-targets')).targets[0].t.agent, 'forge', 'kept in this tab');
  // the page reloads (or the sign-in page comes in between) before it was ready: a new page in the same tab
  clock += 60 * 1000;
  const second = createOpenTargets({ origin: ORIGIN, run: (x) => ran.push(x.agent || 'backups'), store });
  await second.ready({ agent: '', backups: true, update: false, security: false });
  assert.deepStrictEqual(ran, ['backups', 'forge'], 'the address first, then the tap it kept');
  assert.ok(!storage.m.has('hub-open-targets'), 'run once');
  // too old (the sign-in took longer than the store keeps it): dropped
  const b = offer('/?agent=dash'); const third = createOpenTargets({ origin: ORIGIN, run: (x) => ran.push(x.agent), store });
  third.onMessage(b.e); b.go();
  clock += 11 * 60 * 1000;
  await createOpenTargets({ origin: ORIGIN, run: (x) => ran.push(x.agent), store }).ready(null);
  assert.deepStrictEqual(ran, ['backups', 'forge']);
});

test('targets run one after another: a slow one (an owner-view switch) finishes before the next starts', async () => {
  const order = []; let release;
  const ot = createOpenTargets({ origin: ORIGIN, run: async (x) => {
    order.push(`start ${x.agent}`);
    if (x.agent === 'a') await new Promise(r => { release = r; });
    order.push(`end ${x.agent}`);
  } });
  ot.ready(null);
  const a = offer('/?agent=a'); ot.onMessage(a.e); a.go();
  const b = offer('/?agent=b'); ot.onMessage(b.e); b.go();
  await tick(); await tick();
  assert.deepStrictEqual(order, ['start a'], 'b waits for a');
  release(); await tick(); await tick(); await tick();
  assert.deepStrictEqual(order, ['start a', 'end a', 'start b', 'end b']);
  // a target that throws doesn't stop the next
  const bad = createOpenTargets({ origin: ORIGIN, run: (x) => { if (x.agent === 'x') throw new Error('boom'); order.push(x.agent); } });
  bad.ready(null);
  const x1 = offer('/?agent=x'); bad.onMessage(x1.e); x1.go();
  const y1 = offer('/?agent=y'); bad.onMessage(y1.e); y1.go();
  await tick(); await tick(); await tick();
  assert.strictEqual(order[order.length - 1], 'y');
});

test('app.js listens before its start-up awaits anything, keeps taps in sessionStorage, drains them after the agent list', () => {
  const app = read('app.js');
  const listen = app.indexOf("navigator.serviceWorker.addEventListener('message', (e) => openTargets.onMessage(e));");
  const start = app.indexOf("document.addEventListener('DOMContentLoaded', async () => {");
  assert.ok(listen > 0 && start > listen, 'the listener is registered while the script runs, not in the start-up handler');
  assert.ok(app.indexOf('navigator.serviceWorker.startMessages();', listen) < start, 'messages start flowing right away');
  assert.match(app, /createOpenTargets\(\{ origin: location\.origin, run: \(t\) => runPageTarget\(t\), store: createTargetStore\(sessionStorage\) \}\)/);
  const startup = app.slice(start, app.indexOf('\n    });\n', start));
  const agents = startup.indexOf('await Promise.all([loadAgents()]);');
  const drain = startup.indexOf('openTargets.ready(own);');
  assert.ok(agents > 0 && drain > agents, 'the page address and the waiting taps run after the agent list is in');
  assert.match(startup, /for \(const k of \['update', 'backups', 'security'\]\) u\.searchParams\.delete\(k\);/, 'one-shot actions leave the address');
  assert.ok(!/location\.href = u\.pathname/.test(app), 'a message can never send the hub tab to another page');
  const run = app.slice(app.indexOf('async function runPageTarget(t) {'), app.indexOf('async function showOwnerViewOf(name) {'));
  assert.match(run, /if \(t\.backups\) openSettingsAt\('st-backups-section'\);/);
  assert.match(run, /if \(t\.update\) paintUpdateCard\(\)\.then\(\(\) => showUpdateCard\(\)\)/);
  assert.match(run, /if \(!a\) a = await showOwnerViewOf\(t\.agent\);/);
  const users = read('users.html');
  assert.match(users, /window\.addEventListener\('focus', refreshRequestsSoon\);\n  document\.addEventListener\('visibilitychange', refreshRequestsSoon\);/, 'a Users tab brought forward (or focused in another window) shows the requests waiting now');
  const load = users.slice(users.indexOf('async function loadRequests() {'));
  assert.match(load, /if \(at !== tr\) tb\.insertBefore\(tr, at\);/, 'rows already shown are kept, not redrawn: what is typed in them survives');
  assert.ok(!/tb\.innerHTML = pending\.map/.test(load), 'the waiting rows are never rebuilt wholesale');
  assert.match(users, /const load = \+\+requestsLoads;[^]*if \(load !== requestsLoads\) return;/, 'only the newest refresh draws');
});

test('every go is kept until its target has run: a second tap during a reload, or a reload mid-run, loses nothing', async () => {
  const storage = memoryStorage(); const store = createTargetStore(storage, () => 1000);
  const ran = [];
  // tap A while the page loads; the page reloads; tap B before the new page is ready: both run, A first
  const p1 = createOpenTargets({ origin: ORIGIN, run: (x) => ran.push(x.agent), store });
  const a = offer('/?agent=a'); p1.onMessage(a.e); a.go();
  const p2 = createOpenTargets({ origin: ORIGIN, run: (x) => ran.push(x.agent), store });
  const b = offer('/?agent=b'); p2.onMessage(b.e); b.go();
  await p2.ready(null);
  assert.deepStrictEqual(ran, ['a', 'b']);
  assert.ok(!storage.m.has('hub-open-targets'), 'gone once run');
  // a target is still running (an owner-view fetch) when the page reloads: the ones behind it are still kept
  let hang; const p3 = createOpenTargets({ origin: ORIGIN, run: (x) => (x.agent === 'slow' ? new Promise(r => { hang = r; }) : ran.push(x.agent)), store });
  const c = offer('/?agent=c'); p3.onMessage(c.e); c.go();
  p3.ready({ agent: 'slow', backups: false, update: false, security: false });
  await tick();
  assert.deepStrictEqual(JSON.parse(storage.m.get('hub-open-targets')).targets.map(e => e.t.agent), ['c'], 'c is kept while slow runs');
  const p4 = createOpenTargets({ origin: ORIGIN, run: (x) => ran.push(x.agent), store });   // the reload
  await p4.ready(null);
  assert.deepStrictEqual(ran, ['a', 'b', 'c']);
  hang();
});

test('an offer lasts ten seconds by default: a slow focus on the worker side still gets its go through', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ran = [];
  const ot = createOpenTargets({ origin: ORIGIN, run: (x) => ran.push(x.agent) });
  ot.ready(null);
  const o = offer('/?agent=forge'); ot.onMessage(o.e);
  t.mock.timers.tick(9000);
  o.go();
  return new Promise(r => setImmediate(r)).then(() => assert.deepStrictEqual(ran, ['forge']));
});

test('an older copy of the page (kept for Back) removes only its own entry: a newer page\'s taps stay stored', async () => {
  const storage = memoryStorage(); const store = createTargetStore(storage, () => 1000);
  const ran = [];
  let release; const old = createOpenTargets({ origin: ORIGIN, run: (x) => (x.agent === 'a' ? new Promise(r => { release = r; }) : ran.push(x.agent)), store });
  const a = offer('/?agent=a'); old.onMessage(a.e); a.go();
  old.ready(null); await tick();                       // the old page runs a, which is still running
  const fresh = createOpenTargets({ origin: ORIGIN, run: (x) => ran.push(x.agent), store });   // a newer page in the tab
  const b = offer('/?agent=b'); fresh.onMessage(b.e); b.go();
  release(); await tick(); await tick(); await tick();  // the old page's a settles and drops a, only a
  assert.deepStrictEqual(JSON.parse(storage.m.get('hub-open-targets')).targets.map(e => e.t.agent), ['b'], 'b is still kept');
});
