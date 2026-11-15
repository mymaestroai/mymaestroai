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
  assert.match(modules, /api\('POST', '\/api\/remote-desktop\/open', \{ nodeid: c\.nodeid \}\)/);
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
  await t.deskOpen(0, null);
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
  assert.ok(viewer.split('\n').length < 400);
});

test('remote-desktop.html: toolbar and viewer wiring', () => {
  for (const id of ['fit', 'keyboard', 'cad', 'end', 'reconnect']) assert.match(viewer, new RegExp(`id="${id}"`));
  for (const s of ['>Fit<', '>Keyboard<', '>Ctrl+Alt+Del<', '>End<', '>Reconnect<']) assert.ok(viewer.includes(s), s);
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
  const els = {};
  const mk = (id) => ({ id, style: {}, textContent: '', disabled: false, value: '', offsetHeight: 40, listeners: {}, classList: { toggle() {}, add() {} },
    addEventListener(n, f) { (this.listeners[n] = this.listeners[n] || []).push(f); }, setPointerCapture() {}, focus() {}, blur() {} });
  const el = (id) => els[id] || (els[id] = mk(id));
  el('rd-boot').textContent = JSON.stringify(boot);
  const log = { starts: [], stops: 0, cad: 0, fetches: [], keys: [] };
  const timers = [];
  let now = opts.now || 1000000;
  const sandbox = {
    document: { getElementById: el, addEventListener(n, f) { (el('doc').listeners[n] = el('doc').listeners[n] || []).push(f); }, querySelector: () => ({ setAttribute() {} }), title: '', activeElement: null },
    window: { addEventListener() {} },
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
  vm.runInContext(src, sandbox);
  return { els, log, el, tick: () => timers.forEach(f => f()), setNow: (n) => { now = n; }, sandbox };
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
