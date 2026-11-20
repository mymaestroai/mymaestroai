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
  sandbox.window = sandbox; sandbox.__wl = {}; sandbox.addEventListener = (n, f) => { (sandbox.__wl[n] = sandbox.__wl[n] || []).push(f); };
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
  const log = { starts: [], urlnames: [], stops: 0, cad: 0, fetches: [], keys: [] };
  const timers = [];
  const win = {};
  let now = opts.now || 1000000;
  const nav = { replaced: [], reloads: 0, back: 0 };
  const timeouts = [];
  const sandbox = {
    location: { origin: 'https://hub.example.ts.net', replace: (u) => nav.replaced.push(u), reload: () => { nav.reloads++; } },
    history: { length: opts.historyLength === undefined ? 1 : opts.historyLength, back: () => { nav.back++; } },
    document: { getElementById: el, addEventListener(n, f) { (el('doc').listeners[n] = el('doc').listeners[n] || []).push(f); }, querySelector: () => ({ setAttribute() {} }), title: '', referrer: opts.referrer || '', activeElement: null, visibilityState: 'visible' },
    window: { addEventListener(n, f) { (win[n] = win[n] || []).push(f); }, ...(opts.crypto ? { crypto: opts.crypto } : {}) },
    ...(opts.crypto ? { Uint8Array } : {}),
    ...(opts.navigator === undefined ? {} : { navigator: opts.navigator }),
    CreateAgentRemoteDesktop: () => ({}),
    CreateAgentRedirect: () => {
      const d = { m: { SendCtrlAltDelMsg() { log.cad++; }, handleKeyDown(e) { log.keys.push(e.keyCode); }, handleKeyUp() {}, handleKeys() {} }, Start(id) { log.starts.push(id); log.urlnames.push(d.urlname); }, Stop() { log.stops++; } };
      log.desktop = d; return d;
    },
    fetch: (u, o) => { log.fetches.push([u, o]); return opts.fetch ? opts.fetch(u, o) : Promise.resolve({ ok: true }); },
    setInterval: (f) => { timers.push(f); return timers.length; }, clearInterval(h) { if (timers[h - 1]) timers[h - 1] = () => {}; },
    setTimeout: (f, ms) => { timeouts.push({ f, ms, live: true }); return timeouts.length; }, clearTimeout(h) { if (timeouts[h - 1]) timeouts[h - 1].live = false; },
    Date: { now: () => now }, JSON, Math, Number, isNaN, console,
    ...(opts.abort ? { AbortController: opts.abort } : {}),
  };
  vm.createContext(sandbox);
  vm.runInContext(math, sandbox);
  vm.runInContext(src, sandbox);
  const fireWin = (n, e) => (win[n] || []).forEach(f => f({ ...e }));
  const vis = (v) => { sandbox.document.visibilityState = v; (els.doc.listeners.visibilitychange || []).forEach(f => f({})); };
  return { els, log, el, tick: () => timers.forEach(f => f()), setNow: (n) => { now = n; }, sandbox, fireWin, vis, nav, timeouts, win };
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
  assert.equal(r.els['ended-text'].textContent, 'The session has ended.');
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
  assert.equal(r.els['ended-text'].textContent, 'The session has ended.');
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
  sandbox.window = sandbox; sandbox.addEventListener = () => {};
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
    navigator: { platform: 'Linux' }, location: { protocol: 'https:', host: 'h', pathname: '/remote-desktop/s/', replace() {}, reload() {} }, history: { length: 1, back() {} }, WebSocket: Object.assign(function () { this.readyState = 0; this.close = () => {}; this.send = () => {}; }, { OPEN: 1 }), fetch: () => Promise.resolve({ ok: true }) };
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
  const r = runViewer({ nodeid: 'n', name: 'pc', until: 1000000 + 600000, endUrl: '/api/remote-desktop/s/end', leaveUrl: '/api/remote-desktop/s/leave' }, { navigator });
  r.fireWin('pagehide', { persisted: true });
  assert.equal(beacons.length, 0, 'back/forward cache: the hub grace covers it');
  r.vis('hidden');
  assert.equal(beacons.length, 0, 'an app switch never ends the session');
  r.fireWin('pagehide', { persisted: false });
  assert.equal(beacons.length, 1);
  assert.match(beacons[0][0], /^\/api\/remote-desktop\/s\/leave\?viewer=[A-Za-z0-9_-]{22}$/, 'the leave URL with this page\'s viewer id, never the end URL');
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

test('remote-desktop.html: the viewer id is 22 base64url characters (from crypto when there is one), the same for every Start; urlname is v/<id>/meshrelay.ashx and the beacon carries the same id', () => {
  const crypto = { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = 250 - i * 7; return a; } };
  for (const opts of [{ crypto }, {}]) {
    const { beacons, navigator } = beaconRig();
    const r = runViewer({ session: 's', nodeid: 'n', name: 'pc', until: 1000000 + 600000, endUrl: '/api/remote-desktop/s/end', leaveUrl: '/api/remote-desktop/s/leave' }, { navigator, ...opts });
    r.log.desktop.State = 0; r.log.desktop.onStateChanged(r.log.desktop, 0);
    r.els.reconnect.listeners.click[0]();   // a second Start of the same page
    assert.equal(r.log.urlnames.length, 2);
    const m = r.log.urlnames[0].match(/^v\/([A-Za-z0-9_-]{22})\/meshrelay\.ashx$/);
    assert.ok(m, r.log.urlnames[0]);
    assert.equal(r.log.urlnames[1], r.log.urlnames[0], 'the same id for the page\'s life');
    r.fireWin('pagehide', { persisted: false });
    assert.equal(beacons[0][0], `/api/remote-desktop/s/leave?viewer=${m[1]}`);
    if (opts.crypto) {
      const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      assert.equal(m[1], Array.from({ length: 22 }, (_, i) => A[(250 - i * 7) & 63]).join(''), 'built from crypto.getRandomValues');
    }
  }
});

test('remote-desktop.html: two page loads get different viewer ids', () => {
  const a = runViewer({ nodeid: 'n', name: 'pc', until: 1000000 + 600000, endUrl: '/e' });
  const b = runViewer({ nodeid: 'n', name: 'pc', until: 1000000 + 600000, endUrl: '/e' });
  assert.notEqual(a.log.urlnames[0], b.log.urlnames[0]);
});

test('remote-desktop.html: pagehide falls back to fetch with keepalive when sendBeacon is missing or refuses', () => {
  for (const navigator of [{}, beaconRig({ beaconOk: false }).navigator, undefined]) {
    const r = runViewer({ nodeid: 'n', name: 'pc', until: 1000000 + 600000, endUrl: '/api/remote-desktop/s/end', leaveUrl: '/api/remote-desktop/s/leave' }, { navigator });
    r.fireWin('pagehide', { persisted: false });
    assert.equal(r.log.fetches.length, 1);
    assert.match(r.log.fetches[0][0], /^\/api\/remote-desktop\/s\/leave\?viewer=[A-Za-z0-9_-]{22}$/);
    assert.deepEqual({ ...r.log.fetches[0][1] }, { method: 'POST', credentials: 'include', keepalive: true });
  }
});

test('remote-desktop.html: pagehide without boot.leaveUrl derives it from endUrl (/end -> /leave); the End button still posts endUrl', async () => {
  const { beacons, navigator } = beaconRig();
  const r = runViewer({ nodeid: 'n', name: 'pc', until: 1000000 + 600000, endUrl: '/api/remote-desktop/s/end' }, { navigator });
  r.fireWin('pagehide', { persisted: false });
  assert.equal(beacons.length, 1);
  assert.match(beacons[0][0], /^\/api\/remote-desktop\/s\/leave\?viewer=[A-Za-z0-9_-]{22}$/);
  const f = beaconRig({ beaconOk: false });
  const r2 = runViewer({ nodeid: 'n', name: 'pc', until: 1000000 + 600000, endUrl: '/api/remote-desktop/s/end', leaveUrl: '/api/remote-desktop/s/leave' }, { navigator: f.navigator });
  r2.els.end.listeners.click[0](); await settle();
  assert.equal(r2.log.fetches.length, 1);
  assert.equal(r2.log.fetches[0][0], '/api/remote-desktop/s/end', 'End posts the end URL');
  assert.equal(f.beacons.length, 0);
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

// ── Back control, the ended panel, bfcache ──
const LIVE = { session: 's', nodeid: 'n', name: 'Office PC', until: 1000000 + 600000, endUrl: '/api/remote-desktop/s/end', leaveUrl: '/api/remote-desktop/s/leave' };
const REMOTE = '/modules#remote-computers';

test('remote-desktop.html: #back is the first item of #bar, holds #name, has its labels, and stop() never hides it', () => {
  assert.match(viewer, /<div id="bar">\s*<button id="back" type="button" aria-label="Back to Remote computers" title="End the session and go back to Remote computers">←[^<]*<b id="name"><\/b><\/button>/);
  const hide = viewer.match(/\['reconnect'[^\]]*\]\.forEach\(function \(id\) \{ \$\(id\)\.style\.display = 'none'; \}\)/)[0];
  assert.ok(!hide.includes("'back'"), 'the Back button is not in the hidden list');
  const r = runViewer(LIVE);
  assert.equal(r.els.name.textContent, 'Office PC');
  r.els.end.listeners.click[0]();
  return settle().then(() => { assert.notEqual(r.els.back.style.display, 'none'); assert.equal(r.els.ended.style.display, 'block'); });
});

test('remote-desktop.html: the ended panel has the reason, two Back buttons and the countdown with Stay; 44 px buttons; accent on the primary', () => {
  for (const s of ['id="ended-text"', 'id="ended-remote"', '>Back to Remote computers<', 'id="ended-chat"', '>Back to chat<', 'id="ended-count"', 'id="ended-stay"', '>Stay here<']) assert.ok(viewer.includes(s), s);
  assert.match(viewer, /#ended button \{ min-height: 44px/);
  assert.match(viewer, /#ended button\.primary \{ border-color: var\(--rd-accent\); background: var\(--rd-accent\)/);
  assert.match(viewer, /--rd-accent: #3D7BFF/);
  assert.match(viewer, /var REMOTE_URL = '\/modules#remote-computers', CHAT_URL = '\/';/);
});

test('rdNav.backPlan: same-origin /modules referrer with history -> history; anything else -> replace', () => {
  const sb = { }; vm.createContext(sb);
  vm.runInContext(viewer.match(/<script>\n(var rdView[\s\S]*?)<\/script>/)[1], sb);
  const O = 'https://hub.example.ts.net';
  const plan = (ref, o, len, url) => vm.runInContext(`rdNav.backPlan(${JSON.stringify(ref)}, ${JSON.stringify(o)}, ${len}, ${JSON.stringify(url)})`, sb);
  assert.equal(plan(O + '/modules', O, 3, REMOTE), 'history');
  assert.equal(plan(O + '/modules#remote-computers', O, 2, REMOTE), 'history');
  assert.equal(plan(O + '/modules?x=1', O, 2, REMOTE), 'history');
  assert.equal(plan('https://other.example.net/modules', O, 3, REMOTE), 'replace', 'another origin');
  assert.equal(plan(O + '/', O, 3, REMOTE), 'replace', 'the chat page');
  assert.equal(plan(O + '/modules-x', O, 3, REMOTE), 'replace', 'a longer path');
  assert.equal(plan('', O, 3, REMOTE), 'replace', 'no referrer');
  assert.equal(plan(O + '/modules', O, 1, REMOTE), 'replace', 'nothing to go back to');
  assert.equal(plan(O + '/modules', O, 3, '/'), 'replace', 'only Remote computers uses history');
});

test('remote-desktop.html: Back while live POSTs endUrl (credentials include), disables itself, then replaces with Remote computers', async () => {
  const r = runViewer(LIVE);
  r.els.back.listeners.click[0]();
  assert.equal(r.els.back.disabled, true);
  assert.equal(r.log.fetches[0][0], '/api/remote-desktop/s/end');
  assert.equal(r.log.fetches[0][1].method, 'POST');
  assert.equal(r.log.fetches[0][1].credentials, 'include');
  assert.deepEqual(r.nav.replaced, [], 'not before the answer');
  await settle();
  assert.deepEqual(r.nav.replaced, [REMOTE]);
  assert.equal(r.nav.back, 0);
});

test('remote-desktop.html: Back still goes when the POST fails, and when it hangs past 3 s (aborted)', async () => {
  const r = runViewer(LIVE, { fetch: () => Promise.reject(new Error('offline')) });
  r.els.back.listeners.click[0](); await settle();
  assert.deepEqual(r.nav.replaced, [REMOTE], 'a failed POST');
  let aborted = 0;
  function AC() { this.signal = { s: 1 }; this.abort = () => { aborted++; }; }
  const h = runViewer(LIVE, { fetch: () => new Promise(() => {}), abort: AC });
  h.els.back.listeners.click[0]();
  assert.ok(h.log.fetches[0][1].signal, 'the request carries an abort signal');
  await settle();
  assert.deepEqual(h.nav.replaced, [], 'still waiting');
  const t = h.timeouts.find(x => x.ms === 3000);
  assert.ok(t, 'a 3 second timeout');
  t.f();
  assert.equal(aborted, 1);
  assert.deepEqual(h.nav.replaced, [REMOTE], 'after 3 s it goes');
  const n = runViewer(LIVE, { fetch: () => new Promise(() => {}) });   // no AbortController at all
  n.els.back.listeners.click[0]();
  n.timeouts.find(x => x.ms === 3000).f();
  assert.deepEqual(n.nav.replaced, [REMOTE]);
});

test('remote-desktop.html: Back when not live goes at once, with no POST; from the Modules page it uses history with an 800 ms fallback', async () => {
  const r = runViewer(LIVE);
  r.els.end.listeners.click[0](); await settle();
  const posts = r.log.fetches.length;
  r.els.back.listeners.click[0]();
  assert.equal(r.log.fetches.length, posts, 'no second POST');
  assert.deepEqual(r.nav.replaced, [REMOTE]);
  const h = runViewer(LIVE, { referrer: 'https://hub.example.ts.net/modules', historyLength: 3 });
  h.els.back.listeners.click[0](); await settle();
  assert.equal(h.nav.back, 1);
  assert.deepEqual(h.nav.replaced, [], 'history first');
  const t = h.timeouts.find(x => x.ms === 800);
  assert.ok(t && t.live);
  h.fireWin('pagehide', { persisted: false });
  assert.equal(t.live, false, 'the fallback is cleared on pagehide');
});

test('remote-desktop.html: after stop() the panel counts down from 5 once, Stay cancels, 0 goes to Remote computers; the two buttons navigate', async () => {
  const r = runViewer(LIVE);
  r.els.end.listeners.click[0](); await settle();
  assert.equal(r.els['ended-count'].textContent, 'Returning to Remote computers in 5 s');
  r.tick(); r.tick();
  assert.equal(r.els['ended-count'].textContent, 'Returning to Remote computers in 3 s');
  r.setNow(1000000 + 700000); r.tick();   // the time also runs out: stop() runs again, the countdown is not started twice
  assert.equal(r.els['ended-count'].textContent, 'Returning to Remote computers in 2 s');
  r.tick();
  assert.equal(r.els['ended-count'].textContent, 'Returning to Remote computers in 1 s');
  assert.deepEqual(r.nav.replaced, []);
  r.tick();
  assert.deepEqual(r.nav.replaced, [REMOTE], 'at 0 it goes once');
  r.tick();
  assert.equal(r.nav.replaced.length, 1);
  // Stay
  const s = runViewer(LIVE);
  s.els.end.listeners.click[0](); await settle();
  s.tick();
  s.els['ended-stay'].listeners.click[0]();
  assert.equal(s.els['ended-count'].style.display, 'none');
  assert.equal(s.els['ended-stay'].style.display, 'none');
  for (let i = 0; i < 10; i++) s.tick();
  assert.deepEqual(s.nav.replaced, [], 'Stay stops the countdown');
  assert.notEqual(s.els['ended-remote'].style.display, 'none');
  assert.notEqual(s.els['ended-chat'].style.display, 'none');
  s.els['ended-remote'].listeners.click[0]();
  assert.deepEqual(s.nav.replaced, [REMOTE]);
  s.els['ended-chat'].listeners.click[0]();
  assert.deepEqual(s.nav.replaced, [REMOTE, '/']);
  // time runs out: the same panel
  const t = runViewer({ ...LIVE, until: 1005000 });
  t.setNow(1005000); t.tick();
  assert.equal(t.els['ended-count'].textContent, 'Returning to Remote computers in 5 s');
});

test('remote-desktop.html: pageshow with persisted reloads after the leave beacon or when the session is no longer live; not otherwise', async () => {
  const { navigator } = beaconRig();
  const r = runViewer(LIVE, { navigator });
  r.fireWin('pageshow', { persisted: true });
  assert.equal(r.nav.reloads, 0, 'no leave sent, still live');
  r.fireWin('pagehide', { persisted: true });
  r.fireWin('pageshow', { persisted: true });
  assert.equal(r.nav.reloads, 0, 'a persisted pagehide sends nothing');
  r.fireWin('pagehide', { persisted: false });
  r.fireWin('pageshow', { persisted: false });
  assert.equal(r.nav.reloads, 0, 'not from the cache');
  r.fireWin('pageshow', { persisted: true });
  assert.equal(r.nav.reloads, 1, 'leave was sent');
  const e = runViewer(LIVE);
  e.els.end.listeners.click[0](); await settle();
  e.fireWin('pageshow', { persisted: true });
  assert.equal(e.nav.reloads, 1, 'the session is gone');
  // Left with Back while live (the page ended the session itself), then kept in the cache by a persisted pagehide:
  // Forward must load the page again, never reconnect to the ended session.
  const b = runViewer(LIVE);
  b.els.back.listeners.click[0](); await settle();
  b.fireWin('pagehide', { persisted: true });
  const starts = b.log.starts.length;
  b.fireWin('pageshow', { persisted: true });
  assert.equal(b.nav.reloads, 1, 'left by Back: reload');
  assert.equal(b.log.starts.length, starts, 'no reconnect');
});

test('modules.html: a pageshow listener with persisted calls loadDesktopBox (and loadApprovals, the Agent approvals box)', async () => {
  assert.match(modules, /window\.addEventListener\('pageshow', \(e\) => \{ if \(e && e\.persisted === true\) \{ loadDesktopBox\(\); loadApprovals\(\); \} \}\);/);
  const src = modules.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {}; const calls = [];
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', className: '', classList: { add() {}, contains: () => true }, disabled: false });
  const sandbox = { document: { getElementById: el, addEventListener() {}, hidden: false }, location: { origin: 'https://hub.example.ts.net', search: '', hash: '', pathname: '/modules', assign() {} },
    fetch: async (url, opt) => { calls.push(url); return { ok: true, json: async () => ({ allowed: true, computers: [] }) }; },
    URLSearchParams, URL, history: { replaceState() {} }, localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, setInterval, clearInterval, console, Date, JSON, Math, String, Number, isNaN, Error };
  sandbox.window = sandbox; sandbox.__wl = {}; sandbox.addEventListener = (n, f) => { (sandbox.__wl[n] = sandbox.__wl[n] || []).push(f); };
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;this.__t = { setCurrent(m){ current = m; selected = null; } };', sandbox);
  sandbox.__t.setCurrent({ id: 'remote-computers', enabled: true, settings: {}, finishedAt: 1, steps: [], agents: [], leads: [], manifest: {}, summary: 's', state: 'ready' });
  const before = calls.filter(c => c === '/api/remote-desktop').length;
  assert.ok((sandbox.__wl.pageshow || []).length >= 1, 'listener registered');
  sandbox.__wl.pageshow.forEach(f => f({ persisted: false }));
  await settle();
  assert.equal(calls.filter(c => c === '/api/remote-desktop').length, before, 'a plain load does nothing');
  sandbox.__wl.pageshow.forEach(f => f({ persisted: true }));
  await settle();
  assert.equal(calls.filter(c => c === '/api/remote-desktop').length, before + 1, 'persisted reloads the computers');
  assert.ok(calls.includes('/api/modules/remote-computers/approval-policy'), 'persisted reloads the approvals too');
});

// Review r1 (Sentinel): when Back's End fails, hangs or is refused, the page says Leave before going, because a history step may keep it in
// the back/forward cache where pagehide sends nothing; a confirmed End sends no Leave. While Back is ending the session, no Reconnect.
test('remote-desktop.html: Back sends Leave when End fails, is refused or hangs; not when End succeeds; no Reconnect while leaving', async () => {
  const ok = beaconRig();
  const a = runViewer(LIVE, { navigator: ok.navigator });
  a.els.back.listeners.click[0](); await settle();
  assert.equal(ok.beacons.length, 0, 'End confirmed: no Leave');
  for (const [label, fetchImpl] of [['network error', () => Promise.reject(new Error('offline'))], ['refused 500', () => Promise.resolve({ ok: false, status: 500 })]]) {
    const rig = beaconRig();
    const r = runViewer(LIVE, { navigator: rig.navigator, fetch: fetchImpl });
    r.els.back.listeners.click[0](); await settle();
    assert.equal(rig.beacons.length, 1, label);
    assert.match(rig.beacons[0][0], /^\/api\/remote-desktop\/s\/leave\?viewer=/, label);
    assert.deepEqual(r.nav.replaced, [REMOTE], label);
  }
  const hang = beaconRig();
  const h = runViewer(LIVE, { navigator: hang.navigator, fetch: () => new Promise(() => {}) });
  h.els.back.listeners.click[0]();
  h.log.desktop.onStateChanged(h.log.desktop, 0);
  assert.notEqual(h.els.reconnect.style.display, '', 'no Reconnect while Back is ending the session');
  h.timeouts.find(x => x.ms === 3000).f();
  assert.equal(hang.beacons.length, 1, 'hung End: Leave');
});
