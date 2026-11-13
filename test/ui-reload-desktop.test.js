'use strict';
// Reload on the desktop page: the ⋯ menu entry, the top-bar button (only in the installed app), the install paint, the
// stash of the open solo chat, the reload itself (voice-call question, no double press, fresh fetch then reload) and the
// restore after the reload.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const lib = require('../lib/ui-reload.js');

function extract(name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  let p = src.indexOf('(', at); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const libNames = ['appIsInstalled', 'appReloadUrls', 'appFreshReload', 'appReloadStashSave', 'appReloadStashTake', 'createAppReloader', 'APP_RELOAD_CALL_QUESTION'];
const libArgs = libNames.map(n => lib[n]);

function lineOf(id) {
  const m = html.split('\n').findIndex(l => l.includes(`id="${id}"`));
  assert.ok(m >= 0, `${id} in index.html`);
  return m;
}
function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test('the ⋯ menu entry sits right after About with the exact text, title and onclick', () => {
  const lines = html.split('\n');
  const at = lineOf('about-btn');
  const l = lines[at + 1];
  assert.match(l, /<button id="reload-app-item" class="more-item" role="menuitem" title="Reload the app" onclick="closeMoreMenu\(\); reloadApp\(\)">↻ Reload<\/button>/);
});

test('the top-bar button sits between Help and the ⋯ menu with title and aria-label', () => {
  const lines = html.split('\n');
  const at = lineOf('help-btn');
  assert.match(lines[at + 1], /<button id="reload-btn" class="header-btn reload-btn" title="Reload the app" aria-label="Reload the app" onclick="reloadApp\(\)">↻<\/button>/);
  assert.ok(lines[at + 2].includes('id="more-wrap"'));
});

test('the CSS hides the top-bar button by default, shows it under html.app-installed and greys it while busy', () => {
  const hide = html.match(/^\s*([^\n{]*\.header-btn\.reload-btn)\s*\{\s*display:\s*none;\s*\}/m);
  assert.ok(hide, 'hidden by default');
  assert.ok(!/html\.app-installed/.test(hide[1]));
  assert.match(html, /html\.app-installed [^{\n]*\.header-btn\.reload-btn\s*\{\s*display:\s*inline-flex;/);
  assert.match(html, /\.reload-btn\[aria-busy="true"\], #reload-app-item\[aria-busy="true"\]\s*\{\s*opacity:\s*0\.5;\s*pointer-events:\s*none;/);
  // the narrow-screen rule `.main-header-top .header-btn { display: inline-flex }` must not win over the hide
  assert.match(hide[1], /\.header-controls \.header-btn\.reload-btn/);
});

function paintPage(matches, standaloneNav) {
  const classes = new Set();
  const win = { navigator: { standalone: standaloneNav }, matchMedia: (q) => ({ matches: !!matches[q] }) };
  const document = { documentElement: { classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } } };
  const paintInstalledApp = new Function('document', 'window', ...libNames, `${extract('paintInstalledApp')}; return paintInstalledApp;`)(document, win, ...libArgs);
  return { classes, paintInstalledApp, matches };
}

test('paintInstalledApp toggles html.app-installed from the display modes', () => {
  const p = paintPage({}, false);
  p.paintInstalledApp();
  assert.ok(!p.classes.has('app-installed'));
  p.matches['(display-mode: minimal-ui)'] = true;
  p.paintInstalledApp();
  assert.ok(p.classes.has('app-installed'));
  delete p.matches['(display-mode: minimal-ui)'];
  p.paintInstalledApp();
  assert.ok(!p.classes.has('app-installed'));
  p.matches['(display-mode: standalone)'] = true;
  p.paintInstalledApp();
  assert.ok(p.classes.has('app-installed'));
});

test('the page paints once at load and again when any of the three display-mode queries changes', () => {
  const at = src.indexOf("document.addEventListener('DOMContentLoaded'");
  const head = src.slice(at, at + 900);
  assert.ok(head.indexOf('paintInstalledApp();') >= 0 && head.indexOf('paintInstalledApp();') < head.indexOf('await loadMe()'), 'painted early');
  for (const q of ['standalone', 'minimal-ui', 'window-controls-overlay']) assert.ok(head.includes(`(display-mode: ${q})`), q);
  assert.ok(/addEventListener\('change', paintInstalledApp\)/.test(head));
});

function stashPage(chats, active, boxes) {
  const storage = fakeStorage();
  const document = { getElementById: (id) => boxes[id] || null };
  const window = { __activeChatId: active };
  const reloadAppStash = new Function('chats', 'document', 'window', 'sessionStorage', ...libNames, `${extract('reloadAppStash')}; return reloadAppStash;`)(chats, document, window, storage, ...libArgs);
  return { storage, reloadAppStash };
}

test('reloadAppStash stashes the open solo chat: its agent and the text in the box', () => {
  const p = stashPage({ 'chat-1': { id: 'chat-1', agent: 'sam', isGroup: false } }, 'chat-1', { 'input-chat-1': { value: 'draft for robin' } });
  p.reloadAppStash();
  const got = lib.appReloadStashTake(p.storage, Date.now());
  assert.deepStrictEqual(got, { agent: 'sam', text: 'draft for robin' });
});

test('reloadAppStash stashes nothing for a group chat, an orchestrator chat, an unknown chat or no chat', () => {
  const chats = {
    g: { id: 'g', agents: [{ name: 'sam' }], isGroup: true, agent: 'sam' },
    g2: { id: 'g2', agents: [{ name: 'sam' }] },
    'orch-1': { type: 'orchestration', coordinator: 'sam', agent: 'sam' },
    s: { id: 's', agent: 'sam', isGroup: false },
  };
  for (const active of ['g', 'g2', 'orch-1', 'nope', null, undefined]) {
    const p = stashPage(chats, active, { 'input-g': { value: 'x' } });
    p.reloadAppStash();
    assert.strictEqual(p.storage._m.size, 0, `nothing for ${active}`);
  }
});

test('reloadAppStash with a missing message box stashes the agent with empty text', () => {
  const p = stashPage({ s: { id: 's', agent: 'robin', isGroup: false } }, 's', {});
  p.reloadAppStash();
  assert.deepStrictEqual(lib.appReloadStashTake(p.storage, Date.now()), { agent: 'robin', text: '' });
});

function reloadPage({ call = null, starting = false, answer = true } = {}) {
  const log = { confirms: [], fetches: [], reloads: 0, toasts: [], stashed: 0, timers: [] };
  const els = { 'reload-btn': { setAttribute(k, v) { this[k] = v; } }, 'reload-app-item': { setAttribute(k, v) { this[k] = v; } } };
  const document = {
    getElementById: (id) => els[id] || null,
    location: { href: 'http://192.0.2.7:3000/' },
    querySelectorAll: (sel) => (sel === 'script[src]' ? [{ getAttribute: () => '/app.js' }] : sel.startsWith('link') ? [{ getAttribute: () => '/style.css' }] : []),
  };
  const voiceCallS = { call, starting };
  const window = { confirm: (q) => { log.confirms.push(q); return answer; } };
  const location = { origin: 'http://192.0.2.7:3000', reload: () => { log.reloads++; } };
  const fetchStub = (u, o) => { log.fetches.push([u, o]); return Promise.resolve({}); };
  const hubToast = (t) => log.toasts.push(t);
  const reloadAppStash = () => { log.stashed++; };
  const setTimeoutStub = (fn, ms) => { log.timers.push([fn, ms]); return log.timers.length; };
  const body = `${extract('paintReloadBusy')}\nlet appReloaderInst = null;\n${extract('reloadApp')}\nreturn reloadApp;`;
  // the page's own setTimeout inside the lib is the real one; shadow it so the busy timer and the 4 s cap never run
  const reloadApp = new Function('document', 'voiceCallS', 'window', 'location', 'fetch', 'hubToast', 'reloadAppStash', 'setTimeout', ...libNames, body)(
    document, voiceCallS, window, location, fetchStub, hubToast, reloadAppStash, setTimeoutStub, ...libArgs);
  return { reloadApp, log, els };
}
const tick = () => new Promise(r => setImmediate(r));

test('reloadApp asks the voice-call question during a call and does nothing on Cancel', async () => {
  const p = reloadPage({ call: {}, answer: false });
  p.reloadApp();
  await tick();
  assert.deepStrictEqual(p.log.confirms, [lib.APP_RELOAD_CALL_QUESTION]);
  assert.strictEqual(p.log.stashed, 0);
  assert.strictEqual(p.log.fetches.length, 0);
  assert.strictEqual(p.log.toasts.length, 0);
  const q = reloadPage({ starting: true, answer: false });
  q.reloadApp();
  assert.strictEqual(q.log.confirms.length, 1, 'a call that is starting counts');
});

test('reloadApp without a call does not ask; two presses give one run', async () => {
  const p = reloadPage();
  p.reloadApp();
  p.reloadApp();
  await tick();
  assert.strictEqual(p.log.confirms.length, 0);
  assert.strictEqual(p.log.stashed, 1);
  assert.deepStrictEqual(p.log.toasts, ['Reloading…']);
  assert.strictEqual(p.log.fetches.length, 3, 'the page and its two own files, once');
});

test('reloadApp busy paint disables the button and the menu entry', async () => {
  const p = reloadPage();
  p.reloadApp();
  for (const id of ['reload-btn', 'reload-app-item']) {
    assert.strictEqual(p.els[id].disabled, true);
    assert.strictEqual(p.els[id]['aria-busy'], 'true');
  }
});

test('the run fetches the page\'s own urls with cache reload, then calls location.reload', async () => {
  const p = reloadPage();
  p.reloadApp();
  await tick(); await tick();
  assert.deepStrictEqual(p.log.fetches.map(f => f[0]), ['http://192.0.2.7:3000/', 'http://192.0.2.7:3000/app.js', 'http://192.0.2.7:3000/style.css']);
  for (const f of p.log.fetches) assert.strictEqual(f[1].cache, 'reload');
  assert.strictEqual(p.log.reloads, 1);
});

test('reloadApp has no service-worker update on the desktop', () => {
  assert.ok(!/swUpdate/.test(extract('reloadApp')));
});

function restoreSource() {
  const at = src.indexOf('openTargets.ready(own);');
  const from = src.indexOf('const reloadBack', at);
  assert.ok(from > at && from - at < 400, 'the restore follows openTargets.ready(own)');
  return src.slice(from, src.indexOf('setupTabs();', from));
}
function restorePage({ stash, agents = [{ name: 'sam', model: 'm1' }, { name: 'robin', model: 'm2' }], boxValue = '' }) {
  const storage = fakeStorage();
  if (stash) lib.appReloadStashSave(storage, stash.entry, stash.at ?? Date.now());
  const box = { value: boxValue };
  const calls = { solo: [], grow: 0 };
  const startSoloChat = (n, m) => { calls.solo.push([n, m]); return 'chat-9'; };
  const document = { getElementById: (id) => (id === 'input-chat-9' ? box : null) };
  const autoGrowTextarea = () => { calls.grow++; };
  new Function('AGENTS', 'sessionStorage', 'startSoloChat', 'document', 'autoGrowTextarea', ...libNames, restoreSource())(agents, storage, startSoloChat, document, autoGrowTextarea, ...libArgs);
  return { calls, box, storage };
}

test('the restore opens the stashed agent\'s chat once and fills an empty box', () => {
  const p = restorePage({ stash: { entry: { agent: 'robin', text: 'hello again' } } });
  assert.deepStrictEqual(p.calls.solo, [['robin', 'm2']]);
  assert.strictEqual(p.box.value, 'hello again');
  assert.strictEqual(p.calls.grow, 1);
  assert.strictEqual(p.storage._m.size, 0, 'taken once');
});

test('the restore does nothing without a stash, for an unknown agent or an old stash', () => {
  assert.deepStrictEqual(restorePage({}).calls.solo, []);
  assert.deepStrictEqual(restorePage({ stash: { entry: { agent: 'ghost', text: 'x' } } }).calls.solo, []);
  assert.deepStrictEqual(restorePage({ stash: { entry: { agent: 'sam', text: 'x' }, at: Date.now() - 10 * 60000 } }).calls.solo, []);
});

test('the restore leaves typed text alone and sets nothing for an empty stash text', () => {
  const typed = restorePage({ stash: { entry: { agent: 'sam', text: 'old' } }, boxValue: 'typed already' });
  assert.deepStrictEqual(typed.calls.solo, [['sam', 'm1']]);
  assert.strictEqual(typed.box.value, 'typed already');
  assert.strictEqual(typed.calls.grow, 0);
  const empty = restorePage({ stash: { entry: { agent: 'sam', text: '' } } });
  assert.strictEqual(empty.box.value, '');
  assert.strictEqual(empty.calls.grow, 0);
});
