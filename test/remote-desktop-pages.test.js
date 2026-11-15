'use strict';
// The Computers box (modules.html) and the viewer page (remote-desktop.html): text checks plus a small vm run of the viewer script.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const modules = read('modules.html');
const viewer = read('remote-desktop.html');

test('modules.html: Computers box only for remote-computers, only when enabled', () => {
  assert.match(modules, /m\.id === 'remote-computers' && m\.enabled \? '<div class="desk-box" id="desk-box"><h3[^>]*>Computers<\/h3>/);
  assert.match(modules, /if \(!m \|\| m\.id !== 'remote-computers' \|\| !m\.enabled\) return;/);
  assert.match(modules, /if \(!selected\) loadDesktopBox\(\);/);
});

test('modules.html: uses the contract API paths and navigates this tab to the returned url', () => {
  assert.match(modules, /api\('GET', '\/api\/remote-desktop'\)/);
  assert.match(modules, /api\('POST', '\/api\/remote-desktop\/open', \{ nodeid \}\)/);
  assert.match(modules, /data-nodeid="\$\{esc\(c\.nodeid\)\}" onclick="deskOpen\(this\)"/);
  assert.match(modules, /location\.assign\(r\.url\)/);
  assert.match(modules, /setMsg\('err', e\.message\)/);
});

test('modules.html: the three states and a Refresh link, values escaped', () => {
  assert.match(modules, />Open desktop<\/button>/);
  assert.match(modules, /In use by \$\{esc\(/);
  assert.match(modules, /until \$\{esc\(deskTime\(b\.until\)\)\}/);
  assert.match(modules, /Only the owner can open a computer's desktop\./);
  assert.match(modules, /You can't open a computer's desktop here\./);
  assert.match(modules, />Refresh<\/a>/);
  assert.match(modules, /<span class="desk-name">\$\{esc\(c\.name\)\}<\/span>/);
  assert.match(modules, /\$\{c\.online \? 'Online' : 'Offline'\}/);
});

test('modules.html: the box runs correctly in a vm (states, escaping, navigation)', async () => {
  const src = modules.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', className: '', classList: { add() {}, contains: () => true }, disabled: false });
  const calls = [];
  let nav = null;
  const comps = [
    { nodeid: 'n1', name: '<b>pc-1</b>', online: true, busy: null },
    { nodeid: 'n2', name: 'pc-2', online: true, busy: { who: 'sam', until: Date.UTC(2026, 0, 1, 12, 5), mine: false } },
    { nodeid: 'n3', name: 'pc-3', online: false, busy: null },
    { nodeid: 'n4', name: 'pc-4', online: true, busy: { who: 'owner', until: Date.now() + 1000, mine: true, url: '/remote-desktop/x/' } },
  ];
  let allowed = true;
  const sandbox = {
    document: { getElementById: el, addEventListener() {}, hidden: false },
    location: { origin: 'https://hub.example.ts.net', search: '', hash: '', pathname: '/modules', assign: (u) => { nav = u; } },
    fetch: async (url, opt) => { calls.push([opt.method, url, opt.body]); const j = url === '/api/remote-desktop' ? { allowed, computers: comps } : { url: '/remote-desktop/s1/' }; return { ok: true, json: async () => j }; },
    URLSearchParams, URL, history: { replaceState() {} }, localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, setInterval, clearInterval, console, Date, JSON, Math, String, Number, isNaN, Error,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;this.__t = { setCurrent(m){ current = m; selected = null; }, loadDesktopBox, deskOpen, overviewHtml };', sandbox);
  const t = sandbox.__t;
  const m = { id: 'remote-computers', enabled: true, settings: {}, finishedAt: 1, steps: [], agents: [], leads: [], manifest: {}, summary: 's', state: 'ready' };
  t.setCurrent(m);
  assert.ok(t.overviewHtml().includes('id="desk-list"'));
  t.setCurrent({ ...m, id: 'other' });
  assert.ok(!t.overviewHtml().includes('desk-list'));
  t.setCurrent({ ...m, enabled: false });
  assert.ok(!t.overviewHtml().includes('desk-list'));
  const before = calls.length;
  await t.loadDesktopBox();
  assert.equal(calls.length, before, 'no request for other modules');
  t.setCurrent(m);
  await t.loadDesktopBox();
  const html = els['desk-list'].innerHTML;
  assert.deepEqual(calls[calls.length - 1].slice(0, 2), ['GET', '/api/remote-desktop']);
  assert.ok(!html.includes('<b>pc-1</b>') && html.includes('&lt;b&gt;pc-1&lt;/b&gt;'));
  assert.equal((html.match(/Open desktop<\/button>/g) || []).length, 2, 'free online + mine');
  assert.match(html, /In use by sam until \d\d:\d\d/);
  assert.match(html, /Offline/);
  allowed = false;
  await t.loadDesktopBox();
  assert.ok(!els['desk-list'].innerHTML.includes('Open desktop'));
  assert.match(els['desk-list'].innerHTML, /You can't open a computer's desktop here\./);
  t.setCurrent({ ...m, settings: { desktop_who: 'owner' } });
  await t.loadDesktopBox();
  assert.match(els['desk-list'].innerHTML, /Only the owner can open/);
  allowed = true;
  t.setCurrent(m);
  await t.loadDesktopBox();
  const nid = els['desk-list'].innerHTML.match(/data-nodeid="([^"]*)"/)[1];
  await t.deskOpen({ getAttribute: (k) => (k === 'data-nodeid' ? nid : null), disabled: false });
  assert.deepEqual(calls.filter(c => c[0] === 'POST')[0], ['POST', '/api/remote-desktop/open', JSON.stringify({ nodeid: 'n1' })]);
  assert.equal(nav, '/remote-desktop/s1/');
});

test('remote-desktop.html: boot marker once, urlargs then the three relative scripts in order, nothing external', () => {
  assert.equal(viewer.split('<script type="application/json" id="rd-boot">{}</script>').length, 2);
  const u = viewer.indexOf('var urlargs = {};');
  const a = viewer.indexOf('<script src="scripts/common-0.0.1.js"></script><script src="scripts/agent-redir-ws-0.1.1.js"></script><script src="scripts/agent-desktop-0.0.2.js"></script>');
  assert.ok(u > 0 && a > u);
  assert.ok(viewer.indexOf('rd-boot') < u);
  assert.ok(!/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(viewer.replace(/<!DOCTYPE[^>]*>/, '')), 'no external URL');
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(viewer), 'no inline event attributes');
  assert.match(viewer, /name="viewport"[^>]*user-scalable=no/);
  assert.ok(viewer.split('\n').length < 500);
});

test('remote-desktop.html: toolbar and viewer wiring', () => {
  for (const id of ['zout', 'zin', 'fit', 'keyboard', 'cad', 'end', 'reconnect']) assert.match(viewer, new RegExp(`id="${id}"`));
  for (const s of ['aria-label="Zoom out"', 'aria-label="Zoom in"', '>Fit<', '>Keyboard<', '>Ctrl+Alt+Del<', '>End<', '>Reconnect<']) assert.ok(viewer.includes(s), s);
  assert.match(viewer, /CreateAgentRedirect\(\{ send: function \(\) \{\} \}, CreateAgentRemoteDesktop\('Desk'\), '', '', '', '\/'\)/);
  assert.match(viewer, /desktop\.Start\(boot\.nodeid\)/);
  assert.match(viewer, /SendCtrlAltDelMsg\(\)/);
  assert.match(viewer, /fetch\(boot\.endUrl, \{ method: 'POST', credentials: 'include' \}\)/);
  assert.match(viewer, /SendStringUnicode/);
  assert.match(viewer, /touch-action: none/);
  assert.match(viewer, /pointerdown/);
});

function runViewer(boot, opts = {}) {
  const src = viewer.match(/<script>\n\(function[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g, '');
  const math = viewer.match(/<script>\n(var rdView[\s\S]*?)<\/script>/)[1];
  const els = {};
  const mk = (id) => ({ id, style: {}, textContent: '', disabled: false, value: '', offsetHeight: 40, listeners: {}, classList: { toggle() {}, add() {} },
    addEventListener(n, f) { (this.listeners[n] = this.listeners[n] || []).push(f); }, setPointerCapture() {}, focus() {}, blur() {} });
  const el = (id) => els[id] || (els[id] = mk(id));
  el('rd-boot').textContent = JSON.stringify(boot);
  const log = { starts: [], stops: 0, cad: 0, fetches: [], keys: [] };
  const timers = [];
  const win = {};
  let now = opts.now || 1000000;
  const sandbox = {
    document: { getElementById: el, addEventListener(n, f) { (el('doc').listeners[n] = el('doc').listeners[n] || []).push(f); }, querySelector: () => ({ setAttribute() {} }), title: '', activeElement: null, visibilityState: 'visible' },
    window: { addEventListener(n, f) { (win[n] = win[n] || []).push(f); } },
    ...(opts.navigator === undefined ? {} : { navigator: opts.navigator }),
    CreateAgentRemoteDesktop: () => ({}),
    CreateAgentRedirect: () => {
      const d = { m: { SendCtrlAltDelMsg() { log.cad++; }, handleKeyDown(e) { log.keys.push(e.keyCode); }, handleKeyUp() {}, handleKeys() {} }, Start(id) { log.starts.push(id); }, Stop() { log.stops++; } };
      log.desktop = d; return d;
    },
    fetch: (u, o) => { log.fetches.push([u, o]); return Promise.resolve({ ok: true }); },
    setInterval: (f) => { timers.push(f); return timers.length; }, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    Date: { now: () => now }, JSON, Math, Number, isNaN, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(math, sandbox);
  vm.runInContext(src, sandbox);
  const fireWin = (n, e) => (win[n] || []).forEach(f => f({ ...e }));
  const vis = (v) => { sandbox.document.visibilityState = v; (els.doc.listeners.visibilitychange || []).forEach(f => f({})); };
  return { els, log, el, tick: () => timers.forEach(f => f()), setNow: (n) => { now = n; }, sandbox, fireWin, vis };
}

test('remote-desktop.html runs: starts, countdown, Ctrl+Alt+Del, End posts to endUrl then stops', async () => {
  const r = runViewer({ session: 's', nodeid: 'node//x', name: 'pc-1', until: 1000000 + 25 * 60000 - 1, endUrl: '/api/remote-desktop/s/end' });
  assert.deepEqual(r.log.starts, ['node//x']);
  assert.equal(r.els.name.textContent, 'pc-1');
  assert.equal(r.els.left.textContent, '25 min left');
  r.setNow(1000000 + 25 * 60000 - 30000); r.tick();
  assert.equal(r.els.left.textContent, '30 s left');
  r.els.cad.listeners.click[0]();
  assert.equal(r.log.cad, 1);
  r.els.end.listeners.click[0]();
  await new Promise(res => setImmediate(res));
  assert.equal(r.log.fetches[0][0], '/api/remote-desktop/s/end');
  assert.equal(r.log.fetches[0][1].method, 'POST');
  assert.equal(r.log.fetches[0][1].credentials, 'include');
  assert.equal(r.els.ended.textContent, 'The session has ended.');
  assert.equal(r.els.ended.style.display, 'block');
  assert.ok(r.log.stops >= 1);
});

test('remote-desktop.html runs: stops at until, state line, Reconnect only while live', () => {
  const r = runViewer({ nodeid: 'n', name: 'pc', until: 1005000, endUrl: '/e' });
  r.log.desktop.onStateChanged(r.log.desktop, 3);
  assert.equal(r.els.state.textContent, 'Connected');
  r.log.desktop.onStateChanged(r.log.desktop, 0);
  assert.equal(r.els.state.textContent, 'Disconnected');
  assert.equal(r.els.reconnect.style.display, '');
  r.els.reconnect.listeners.click[0]();
  assert.equal(r.log.starts.length, 2);
  r.setNow(1005000); r.tick();
  assert.equal(r.els.ended.textContent, 'The session has ended.');
  assert.ok(r.log.stops >= 1);
  const n = r.log.starts.length;
  r.log.desktop.onStateChanged(r.log.desktop, 0);
  assert.equal(r.els.reconnect.style.display, 'none');
  r.els.reconnect.listeners.click[0]();
  assert.equal(r.log.starts.length, n, 'nothing reconnects after the end');
});

test('modules.html: a stale list response changes nothing, and the click posts the visible row\'s nodeid', async () => {
  const src = modules.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', className: '', classList: { add() {}, contains: () => true }, disabled: false });
  const posts = [];
  const pending = [];
  const sandbox = {
    document: { getElementById: el, addEventListener() {}, hidden: false },
    location: { origin: 'https://hub.example.ts.net', search: '', hash: '', pathname: '/modules', assign() {} },
    fetch: (url, opt) => {
      if (opt.method === 'POST') { posts.push(JSON.parse(opt.body).nodeid); return Promise.resolve({ ok: true, json: async () => ({ url: '/remote-desktop/s/' }) }); }
      return new Promise((res) => pending.push((computers) => res({ ok: true, json: async () => ({ allowed: true, computers }) })));
    },
    URLSearchParams, URL, history: { replaceState() {} }, localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, setInterval, clearInterval, console, Date, JSON, Math, String, Number, isNaN, Error,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;this.__t = { setCurrent(m){ current = m; selected = null; }, setSelected(v){ selected = v; }, loadDesktopBox, deskOpen };', sandbox);
  const t = sandbox.__t;
  const m = { id: 'remote-computers', enabled: true, settings: {}, finishedAt: 1, steps: [], agents: [], leads: [], manifest: {}, summary: 's', state: 'ready' };
  t.setCurrent(m);
  const row = (id, name) => ({ nodeid: id, name, online: true, busy: null });
  const base = pending.length;   // requests the page itself made while loading
  const older = t.loadDesktopBox();   // request 1 (slow)
  const newer = t.loadDesktopBox();   // request 2 (fast)
  pending[base + 1]([row('B1', 'second')]);
  await newer;
  pending[base]([row('A1', 'first'), row('A2', 'other')]);   // the older response arrives last
  await older;
  const html = els['desk-list'].innerHTML;
  assert.ok(html.includes('second') && !html.includes('first'), 'old response did not repaint');
  const button = { getAttribute: (k) => (k === 'data-nodeid' ? html.match(/data-nodeid="([^"]*)"/)[1] : null), disabled: false };
  await t.deskOpen(button);
  assert.deepEqual(posts, ['B1']);
  // A response that lands after the panel moved on paints nothing.
  els['desk-list'].innerHTML = 'kept';
  const late = t.loadDesktopBox();
  t.setSelected('some-step');
  pending[base + 2]([row('C1', 'third')]);
  await late;
  assert.equal(els['desk-list'].innerHTML, 'kept');
  // Hostile nodeids are escaped in the attribute.
  t.setSelected(null);
  const hostile = t.loadDesktopBox();
  pending[base + 3]([row('x"><img src=1>', 'h')]);
  await hostile;
  assert.ok(!els['desk-list'].innerHTML.includes('<img'));
});

test('remote-desktop.html with the REAL MeshCentral viewer scripts: a key press reaches the key message, no ReferenceError, safe after stop', async (t) => {
  const dir = '/opt/mymaestro-remote/runtime/node_modules/meshcentral/public/scripts/';
  const files = ['common-0.0.1.js', 'agent-redir-ws-0.1.1.js', 'agent-desktop-0.0.2.js'].map(n => dir + n);
  if (!files.every(f => fs.existsSync(f))) return t.skip('MeshCentral viewer scripts are not installed here');
  const src = viewer.match(/<script>\n\(function[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g, '');
  const pre = viewer.match(/<script>(var urlargs = \{\};[\s\S]*?)<\/script>/)[1];
  const math = viewer.match(/<script>\n(var rdView[\s\S]*?)<\/script>/)[1];
  const els = {};
  const mk = (id) => ({ id, style: {}, textContent: '', disabled: false, value: '', offsetHeight: 40, listeners: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(n, f) { (this.listeners[n] = this.listeners[n] || []).push(f); }, setPointerCapture() {}, focus() {}, blur() {},
    getContext: () => new Proxy({}, { get: () => () => {} }), width: 640, height: 480 });
  const el = (id) => els[id] || (els[id] = mk(id));
  el('rd-boot').textContent = JSON.stringify({ nodeid: 'n', name: 'pc', until: Date.now() + 600000, endUrl: '/e' });
  const sandbox = { console, Date, JSON, Math, Number, isNaN, String, Uint8Array, Array, Object, Error, parseInt, setInterval, clearInterval, setTimeout, clearTimeout,
    navigator: { platform: 'Linux' }, location: { protocol: 'https:', host: 'h', pathname: '/remote-desktop/s/' }, WebSocket: Object.assign(function () { this.readyState = 0; this.close = () => {}; this.send = () => {}; }, { OPEN: 1 }), fetch: () => Promise.resolve({ ok: true }) };
  sandbox.window = sandbox; sandbox.addEventListener = () => {};
  sandbox.document = { getElementById: el, addEventListener(n, f) { (el('doc').listeners[n] = el('doc').listeners[n] || []).push(f); }, querySelector: () => ({ setAttribute() {} }), title: '', activeElement: null };
  vm.createContext(sandbox);
  vm.runInContext(pre, sandbox);
  for (const f of files) vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: f });
  vm.runInContext(math, sandbox);
  vm.runInContext(src, sandbox);
  const keydown = () => el('doc').listeners.keydown[0]({ keyCode: 65, code: 'KeyA', key: 'a', ctrlKey: true, target: null, preventDefault() {}, stopPropagation() {} });
  const first = vm.runInContext('desktop', sandbox);
  assert.ok(first && first.m && typeof first.Start === 'function', 'global desktop is the current viewer');
  assert.doesNotThrow(keydown, 'key before connect');
  const sent = [];
  first.send = (x) => sent.push(x);
  first.State = 3; first.m.State = 3;
  assert.doesNotThrow(keydown);
  assert.ok(sent.length >= 1 && sent[0].charCodeAt(1) === first.m.InputType.KEY, 'a key message was sent');
  // Reconnect makes a new viewer; the global follows it.
  first.State = 0; first.onStateChanged(first, 0);
  els.reconnect.listeners.click[0]();
  const second = vm.runInContext('desktop', sandbox);
  assert.notEqual(second, first);
  // After the end, a late key does nothing and does not throw.
  els.end.listeners.click[0]();
  await new Promise(res => setImmediate(res));
  assert.equal(els.ended.style.display, 'block', 'the session stopped');
  assert.doesNotThrow(() => { for (const n of ['keydown', 'keyup', 'keypress']) el('doc').listeners[n][0]({ keyCode: 65, code: 'KeyA', key: 'a', target: null, preventDefault() {}, stopPropagation() {} }); });
  assert.doesNotThrow(() => vm.runInContext('desktop.State', sandbox));
  const x = sandbox.window.desktop;
  assert.equal(x.State, 0);
});

// ── leaving without End, and coming back ──
const settle = () => new Promise(res => setImmediate(res));
const beaconRig = (over = {}) => { const beacons = []; const navigator = { sendBeacon: (u, b) => { beacons.push([u, b]); return over.beaconOk !== false; } }; return { beacons, navigator }; };

test('remote-desktop.html: pagehide that is not a cache entry sends End once with sendBeacon; nothing for persisted, an ended or an expired session', async () => {
  const { beacons, navigator } = beaconRig();
  const r = runViewer({ nodeid: 'n', name: 'pc', until: 1000000 + 600000, endUrl: '/api/remote-desktop/s/end' }, { navigator });
  r.fireWin('pagehide', { persisted: true });
  assert.equal(beacons.length, 0, 'back/forward cache: the hub grace covers it');
  r.vis('hidden');
  assert.equal(beacons.length, 0, 'an app switch never ends the session');
  r.fireWin('pagehide', { persisted: false });
  assert.deepEqual(beacons.map(b => b[0]), ['/api/remote-desktop/s/end']);
  assert.equal(r.log.fetches.length, 0, 'no fetch when the beacon was queued');
  // already ended (the End button): nothing more
  const e = beaconRig();
  const r2 = runViewer({ nodeid: 'n', name: 'pc', until: 1000000 + 600000, endUrl: '/e' }, { navigator: e.navigator });
  r2.els.end.listeners.click[0](); await settle();
  r2.fireWin('pagehide', { persisted: false });
  assert.equal(e.beacons.length, 0);
  // expired
  const x = beaconRig();
  const r3 = runViewer({ nodeid: 'n', name: 'pc', until: 1000000 + 5000, endUrl: '/e' }, { navigator: x.navigator });
  r3.setNow(1005000);
  r3.fireWin('pagehide', {});
  assert.equal(x.beacons.length, 0);
});

test('remote-desktop.html: pagehide falls back to fetch with keepalive when sendBeacon is missing or refuses', () => {
  for (const navigator of [{}, beaconRig({ beaconOk: false }).navigator, undefined]) {
    const r = runViewer({ nodeid: 'n', name: 'pc', until: 1000000 + 600000, endUrl: '/api/remote-desktop/s/end' }, { navigator });
    r.fireWin('pagehide', { persisted: false });
    assert.equal(r.log.fetches.length, 1);
    assert.equal(r.log.fetches[0][0], '/api/remote-desktop/s/end');
    assert.deepEqual({ ...r.log.fetches[0][1] }, { method: 'POST', credentials: 'include', keepalive: true });
  }
});

test('remote-desktop.html: back on the page with the viewer disconnected starts again while live; never after End or the end time; never while connected', async () => {
  const r = runViewer({ nodeid: 'n', name: 'pc', until: 1000000 + 600000, endUrl: '/e' });
  assert.equal(r.log.starts.length, 1);
  const first = r.log.desktop;
  r.vis('hidden'); r.vis('visible');
  assert.equal(r.log.starts.length, 1, 'still connecting (state not 0): nothing restarts');
  first.State = 3; r.vis('hidden'); r.vis('visible');
  assert.equal(r.log.starts.length, 1, 'connected: nothing restarts');
  first.State = 0; first.onStateChanged(first, 0);
  assert.equal(r.els.reconnect.style.display, '');
  r.vis('hidden'); r.vis('visible');
  assert.equal(r.log.starts.length, 2, 'disconnected and back: started again');
  assert.notEqual(r.log.desktop, first);
  assert.equal(r.els.reconnect.style.display, 'none');
  // restored from the back/forward cache
  r.log.desktop.State = 0;
  r.fireWin('pageshow', { persisted: true });
  assert.equal(r.log.starts.length, 3, 'pageshow persisted: started again');
  r.log.desktop.State = 0;
  r.fireWin('pageshow', { persisted: false });
  assert.equal(r.log.starts.length, 3, 'a plain load does not restart');
  // a session that has ended: the viewer fails at once; two automatic tries per 10 s, then only the Reconnect button
  r.log.desktop.State = 0; r.vis('visible');
  assert.equal(r.log.starts.length, 3, 'third automatic restart inside 10 s is refused');
  r.setNow(1000000 + 11000); r.log.desktop.State = 0; r.vis('visible');
  assert.equal(r.log.starts.length, 4, 'after 10 s it may try again');
  // after the end time and after End: nothing
  const e = runViewer({ nodeid: 'n', name: 'pc', until: 1000000 + 600000, endUrl: '/e' });
  e.log.desktop.State = 0;
  e.els.end.listeners.click[0](); await settle();
  e.vis('visible'); e.fireWin('pageshow', { persisted: true });
  assert.equal(e.log.starts.length, 1, 'after End nothing restarts');
  const t = runViewer({ nodeid: 'n', name: 'pc', until: 1000000 + 5000, endUrl: '/e' });
  t.log.desktop.State = 0; t.setNow(1005000);
  t.vis('visible');
  assert.equal(t.log.starts.length, 1, 'after the end time nothing restarts');
});
