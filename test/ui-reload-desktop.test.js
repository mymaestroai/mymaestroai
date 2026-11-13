'use strict';
// Reload on the desktop page: the ⋯ menu entry, the top-bar button (only in the installed app), the install paint, the
// stash of every open solo chat (written on pagehide), the questions asked before a reload (call, group text, offline),
// the reload itself (no double press, fresh fetch then reload) and the restore after the reload.
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
const libNames = ['appIsInstalled', 'appReloadUrls', 'appFreshReload', 'appReloadStashSave', 'appReloadStashTake', 'appReloadStashClear', 'createAppReloader',
  'APP_RELOAD_CALL_QUESTION', 'APP_RELOAD_GROUP_QUESTION', 'APP_RELOAD_OFFLINE_QUESTION'];
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

// ── the page's own reload code, sliced from app.js: reloadIsSolo … reloadAppQuestions, paintReloadBusy, reloadApp ──
const helperSrc = (() => {
  const from = src.indexOf('const reloadIsSolo');
  const to = src.indexOf('function paintReloadBusy(');
  assert.ok(from >= 0 && to > from, 'reload helpers present');
  return src.slice(from, to);
})();

function reloadPage({ chats = {}, active, boxes = {}, call = null, starting = false, online, answers = [], stored } = {}) {
  const log = { confirms: [], fetches: [], reloads: 0, toasts: [], timers: [], order: [], listenersAtReload: -1 };
  const storage = fakeStorage();
  if (stored) lib.appReloadStashSave(storage, stored, Date.now() - 1000);
  const els = { 'reload-btn': { setAttribute(k, v) { this[k] = v; } }, 'reload-app-item': { setAttribute(k, v) { this[k] = v; } } };
  const document = {
    getElementById: (id) => els[id] || boxes[id] || null,
    location: { href: 'http://192.0.2.7:3000/' },
    querySelectorAll: (sel) => (sel === 'script[src]' ? [{ getAttribute: () => '/app.js' }] : sel.startsWith('link') ? [{ getAttribute: () => '/style.css' }] : []),
  };
  const voiceCallS = { call, starting };
  const listeners = [];
  const window = {
    __activeChatId: active,
    confirm: (q) => { log.confirms.push(q); const a = answers[log.confirms.length - 1]; return a === undefined ? true : a; },
    addEventListener: (type, fn) => listeners.push([type, fn]),
  };
  const navigator = online === undefined ? {} : { onLine: online };
  const location = { origin: 'http://192.0.2.7:3000', reload: () => { log.reloads++; log.listenersAtReload = listeners.length; log.order.push('reload'); } };
  const fetchStub = (u, o) => { log.fetches.push([u, o]); return Promise.resolve({}); };
  const hubToast = (t) => log.toasts.push(t);
  const setTimeoutStub = (fn, ms) => { log.timers.push([fn, ms]); return log.timers.length; };
  const body = `${helperSrc}\n${extract('paintReloadBusy')}\nlet appReloaderInst = null;\n${extract('reloadApp')}\nreturn { reloadApp, reloadAppStash, armReloadStash, reloadAppQuestions };`;
  // the page's own setTimeout inside the lib is the real one; shadow it so the busy timer and the 4 s cap never run
  const api = new Function('chats', 'document', 'voiceCallS', 'window', 'navigator', 'location', 'fetch', 'hubToast', 'sessionStorage', 'setTimeout', ...libNames, body)(
    chats, document, voiceCallS, window, navigator, location, fetchStub, hubToast, storage, setTimeoutStub, ...libArgs);
  const firePagehide = () => { for (const [t, fn] of listeners) if (t === 'pagehide') fn(); };
  return { ...api, log, els, storage, listeners, firePagehide, boxes };
}
const tick = () => new Promise(r => setImmediate(r));
const takeStash = (p) => lib.appReloadStashTake(p.storage, Date.now());

const soloChats = () => ({
  a: { id: 'a', agent: 'sam', isGroup: false },
  b: { id: 'b', agent: 'robin' },
  g: { id: 'g', agent: 'kim', isGroup: true },
  o: { id: 'o', agent: 'kim', type: 'orchestration' },
});

test('reloadAppStash saves every open solo chat with its box text, the one in front last; group and orchestration chats are left out', () => {
  const boxes = { 'input-a': { value: 'draft for robin' }, 'input-b': { value: 'second' }, 'input-g': { value: 'group text' }, 'input-o': { value: 'orch text' } };
  const p = reloadPage({ chats: soloChats(), active: 'a', boxes });
  p.reloadAppStash();
  assert.deepStrictEqual(takeStash(p), [{ agent: 'robin', text: 'second' }, { agent: 'sam', text: 'draft for robin' }]);
  const q = reloadPage({ chats: soloChats(), active: 'b', boxes });
  q.reloadAppStash();
  assert.deepStrictEqual(takeStash(q), [{ agent: 'sam', text: 'draft for robin' }, { agent: 'robin', text: 'second' }]);
});

test('reloadAppStash with a group, orchestration, unknown or no chat in front still saves the solo chats (in their own order)', () => {
  for (const active of ['g', 'o', 'nope', null, undefined]) {
    const p = reloadPage({ chats: soloChats(), active, boxes: { 'input-a': { value: 'x' } } });
    p.reloadAppStash();
    assert.deepStrictEqual(takeStash(p), [{ agent: 'sam', text: 'x' }, { agent: 'robin', text: '' }], `front ${active}`);
  }
});

test('reloadAppStash with no solo chat open clears an older stash', () => {
  const chats = { g: { id: 'g', agent: 'kim', isGroup: true }, o: { id: 'o', type: 'orchestration', agent: 'kim' } };
  const p = reloadPage({ chats, active: 'g', stored: [{ agent: 'sam', text: 'old' }] });
  assert.ok(p.storage._m.has(lib.APP_RELOAD_STASH_KEY), 'older stash is there');
  p.reloadAppStash();
  assert.strictEqual(p.storage._m.has(lib.APP_RELOAD_STASH_KEY), false, 'key gone');
  const empty = reloadPage({ chats: {}, stored: [{ agent: 'sam', text: 'old' }] });
  empty.reloadAppStash();
  assert.strictEqual(empty.storage._m.size, 0);
});

test('reloadAppStash with a missing message box stashes the agent with empty text', () => {
  const p = reloadPage({ chats: { s: { id: 's', agent: 'robin', isGroup: false } }, active: 's' });
  p.reloadAppStash();
  assert.deepStrictEqual(takeStash(p), [{ agent: 'robin', text: '' }]);
});

test('pressing Reload does not write the stash; the run arms one pagehide listener, then reloads; pagehide writes the text typed after the press', async () => {
  const box = { value: 'first' };
  const p = reloadPage({ chats: { a: { id: 'a', agent: 'sam' } }, active: 'a', boxes: { 'input-a': box } });
  p.reloadApp();
  assert.strictEqual(p.storage._m.size, 0, 'nothing written at the press');
  assert.strictEqual(p.listeners.length, 0, 'nothing armed at the press');
  box.value += ' plus new words';   // typed while the files are fetched
  await tick(); await tick();
  assert.strictEqual(p.log.reloads, 1);
  assert.strictEqual(p.log.listenersAtReload, 1, 'armed before location.reload');
  assert.deepStrictEqual(p.listeners.map(l => l[0]), ['pagehide']);
  assert.strictEqual(p.storage._m.size, 0, 'still nothing before the page unloads');
  p.firePagehide();
  assert.deepStrictEqual(takeStash(p), [{ agent: 'sam', text: 'first plus new words' }]);
});

test('armReloadStash arms only once, even if called twice', () => {
  const p = reloadPage({ chats: { a: { id: 'a', agent: 'sam' } }, active: 'a', boxes: { 'input-a': { value: 'hi' } } });
  p.armReloadStash();
  p.armReloadStash();
  assert.strictEqual(p.listeners.length, 1);
  p.firePagehide();
  assert.deepStrictEqual(takeStash(p), [{ agent: 'sam', text: 'hi' }]);
});

test('a Reload that is called off (no pagehide) leaves no stash', async () => {
  const p = reloadPage({ chats: { a: { id: 'a', agent: 'sam' } }, active: 'a', boxes: { 'input-a': { value: 'keep me' } } });
  p.reloadApp();
  await tick(); await tick();
  assert.strictEqual(p.storage._m.size, 0);
  const c = reloadPage({ chats: { a: { id: 'a', agent: 'sam' } }, active: 'a', call: {}, answers: [false] });
  c.reloadApp();
  await tick(); await tick();
  assert.strictEqual(c.listeners.length, 0, 'a Cancel arms nothing');
  assert.strictEqual(c.storage._m.size, 0);
});

test('reloadAppQuestions: a call or a starting call -> the call question', () => {
  assert.deepStrictEqual(reloadPage({ call: {} }).reloadAppQuestions(), [lib.APP_RELOAD_CALL_QUESTION]);
  assert.deepStrictEqual(reloadPage({ starting: true }).reloadAppQuestions(), [lib.APP_RELOAD_CALL_QUESTION]);
  assert.deepStrictEqual(reloadPage().reloadAppQuestions(), []);
});

test('reloadAppQuestions: text in an open group or orchestration chat -> the group question; blank text or a solo chat does not', () => {
  const g = reloadPage({ chats: soloChats(), boxes: { 'input-g': { value: 'hello team' } } });
  assert.deepStrictEqual(g.reloadAppQuestions(), [lib.APP_RELOAD_GROUP_QUESTION]);
  const o = reloadPage({ chats: soloChats(), boxes: { 'input-o': { value: 'plan' } } });
  assert.deepStrictEqual(o.reloadAppQuestions(), [lib.APP_RELOAD_GROUP_QUESTION]);
  const blank = reloadPage({ chats: soloChats(), boxes: { 'input-g': { value: '  \n ' }, 'input-o': { value: '' } } });
  assert.deepStrictEqual(blank.reloadAppQuestions(), []);
  const solo = reloadPage({ chats: soloChats(), boxes: { 'input-a': { value: 'typed in a solo chat' } } });
  assert.deepStrictEqual(solo.reloadAppQuestions(), []);
});

test('reloadAppQuestions: navigator.onLine === false -> the offline question; online or unknown does not', () => {
  assert.deepStrictEqual(reloadPage({ online: false }).reloadAppQuestions(), [lib.APP_RELOAD_OFFLINE_QUESTION]);
  assert.deepStrictEqual(reloadPage({ online: true }).reloadAppQuestions(), []);
  assert.deepStrictEqual(reloadPage({}).reloadAppQuestions(), []);
});

test('reloadApp asks call, group, offline in that order with window.confirm', async () => {
  const p = reloadPage({ call: {}, chats: soloChats(), boxes: { 'input-g': { value: 'x' } }, online: false });
  p.reloadApp();
  await tick(); await tick();
  assert.deepStrictEqual(p.log.confirms, [lib.APP_RELOAD_CALL_QUESTION, lib.APP_RELOAD_GROUP_QUESTION, lib.APP_RELOAD_OFFLINE_QUESTION]);
  assert.strictEqual(p.log.reloads, 1);
});

test('reloadApp does nothing on any Cancel (and stops asking after it)', async () => {
  const setup = { call: {}, chats: soloChats(), boxes: { 'input-g': { value: 'x' } }, online: false };
  for (let i = 0; i < 3; i++) {
    const answers = [true, true, true]; answers[i] = false;
    const p = reloadPage({ ...setup, answers });
    assert.strictEqual(p.reloadApp(), false);
    await tick(); await tick();
    assert.strictEqual(p.log.confirms.length, i + 1, `stops at Cancel ${i}`);
    assert.strictEqual(p.log.fetches.length, 0);
    assert.strictEqual(p.log.reloads, 0);
    assert.strictEqual(p.log.toasts.length, 0);
    assert.strictEqual(p.listeners.length, 0);
    assert.strictEqual(p.els['reload-btn'].disabled, undefined, 'not painted busy');
  }
});

test('reloadApp without a question does not ask; two presses give one run', async () => {
  const p = reloadPage();
  p.reloadApp();
  p.reloadApp();
  await tick(); await tick();
  assert.strictEqual(p.log.confirms.length, 0);
  assert.strictEqual(p.log.reloads, 1);
  assert.strictEqual(p.listeners.length, 1);
  assert.deepStrictEqual(p.log.toasts, ['Reloading…']);
  assert.strictEqual(p.log.fetches.length, 3, 'the page and its two own files, once');
});

test('reloadApp busy paint disables the button and the menu entry with aria-busy and toasts Reloading…', async () => {
  const p = reloadPage();
  p.reloadApp();
  for (const id of ['reload-btn', 'reload-app-item']) {
    assert.strictEqual(p.els[id].disabled, true);
    assert.strictEqual(p.els[id]['aria-busy'], 'true');
  }
  assert.deepStrictEqual(p.log.toasts, ['Reloading…']);
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

// ── the restore: the DOMContentLoaded block between "After a Reload" and openTargets.ready(own); ──
function restoreSource() {
  const at = src.indexOf('// After a Reload');
  assert.ok(at >= 0, 'the restore block is present');
  const end = src.indexOf('openTargets.ready(own);', at);
  assert.ok(end > at, 'the restore ends where openTargets.ready(own) begins');
  return src.slice(at, end);
}
function restorePage({ stash, agents = [{ name: 'sam', model: 'm1' }, { name: 'robin', model: 'm2' }], boxes = {}, ownAgent, href = 'http://192.0.2.7:3000/?agent=sam&x=1' } = {}) {
  const storage = fakeStorage();
  if (stash) lib.appReloadStashSave(storage, stash.entries, stash.at ?? Date.now());
  const calls = { solo: [], grow: 0, replaced: [] };
  const startSoloChat = (n, m) => { calls.solo.push([n, m]); return 'chat-' + n; };
  const document = { getElementById: (id) => boxes[id] || null };
  const autoGrowTextarea = () => { calls.grow++; };
  const own = ownAgent ? { agent: ownAgent, other: 1 } : {};
  const location = { href };
  const history = { state: { s: 1 }, replaceState: (...a) => calls.replaced.push(a) };
  new Function('AGENTS', 'sessionStorage', 'startSoloChat', 'document', 'autoGrowTextarea', 'appReloadStashTake', 'own', 'location', 'history', restoreSource())(
    agents, storage, startSoloChat, document, autoGrowTextarea, lib.appReloadStashTake, own, location, history);
  return { calls, boxes, storage, own };
}

test('the restore opens every stashed agent known in AGENTS in order (front last) and fills only empty boxes', () => {
  const boxes = { 'input-chat-robin': { value: '' }, 'input-chat-sam': { value: '' } };
  const p = restorePage({ stash: { entries: [{ agent: 'robin', text: 'hello again' }, { agent: 'sam', text: 'front text' }] }, boxes });
  assert.deepStrictEqual(p.calls.solo, [['robin', 'm2'], ['sam', 'm1']]);
  assert.strictEqual(boxes['input-chat-robin'].value, 'hello again');
  assert.strictEqual(boxes['input-chat-sam'].value, 'front text');
  assert.strictEqual(p.calls.grow, 2);
  assert.strictEqual(p.storage._m.size, 0, 'taken once');
  const typed = restorePage({ stash: { entries: [{ agent: 'sam', text: 'old' }, { agent: 'robin', text: '' }] }, boxes: { 'input-chat-sam': { value: 'typed already' }, 'input-chat-robin': { value: '' } } });
  assert.deepStrictEqual(typed.calls.solo, [['sam', 'm1'], ['robin', 'm2']]);
  assert.strictEqual(typed.boxes['input-chat-sam'].value, 'typed already');
  assert.strictEqual(typed.boxes['input-chat-robin'].value, '');
  assert.strictEqual(typed.calls.grow, 0, 'nothing filled, nothing grown');
});

test('the restore skips unknown agents, does nothing without a stash or with an old one', () => {
  assert.deepStrictEqual(restorePage().calls.solo, []);
  const mixed = restorePage({ stash: { entries: [{ agent: 'ghost', text: 'x' }, { agent: 'sam', text: 'y' }] }, boxes: { 'input-chat-sam': { value: '' } } });
  assert.deepStrictEqual(mixed.calls.solo, [['sam', 'm1']]);
  assert.deepStrictEqual(restorePage({ stash: { entries: [{ agent: 'ghost', text: 'x' }] } }).calls.solo, []);
  assert.deepStrictEqual(restorePage({ stash: { entries: [{ agent: 'sam', text: 'x' }], at: Date.now() - 10 * 60000 } }).calls.solo, []);
});

test('after a restore, own.agent is cleared and "agent" is removed from the address; without a restore it stays', () => {
  const p = restorePage({ ownAgent: 'sam', stash: { entries: [{ agent: 'robin', text: '' }, { agent: 'sam', text: '' }] }, boxes: { 'input-chat-robin': { value: '' }, 'input-chat-sam': { value: '' } } });
  assert.strictEqual(p.own.agent, undefined);
  assert.strictEqual(p.own.other, 1, 'other fields stay');
  assert.strictEqual(p.calls.replaced.length, 1);
  assert.deepStrictEqual(p.calls.replaced[0], [{ s: 1 }, '', '/?x=1']);
  for (const stash of [undefined, { entries: [{ agent: 'ghost', text: 'x' }] }]) {
    const q = restorePage({ ownAgent: 'sam', stash });
    assert.strictEqual(q.own.agent, 'sam', 'own.agent stays without a restore');
    assert.deepStrictEqual(q.calls.replaced, []);
  }
});

test('the restore runs before openTargets.ready(own) in the page source', () => {
  const take = src.indexOf('appReloadStashTake(sessionStorage');
  const ready = src.indexOf('openTargets.ready(own);');
  assert.ok(take > 0 && ready > take, 'the stash is taken before openTargets.ready(own)');
  assert.strictEqual(src.indexOf('// After a Reload') < ready, true);
  assert.strictEqual(src.split('openTargets.ready(own);').length - 1, 1, 'one call');
});
