'use strict';
// The phone's Settings: the desktop page's Settings dialog alone (/?settings-only=1) in a full-screen sheet of the phone
// app, reached from the phone menu and from Simple's settings sheet ("All settings"; on the desktop Simple opens the
// dialog itself). Admins only, as the desktop's Settings. The settings-only page starts nothing else; close requests and
// close notices pass between the two only from the right window at the same origin, and carry only their type.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), mob = read('mobile.js'), idx = read('index.html'), mhtml = read('mobile.html');
const slice = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };
function fnSrc(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const SO = slice(app, '// ── settings-only page (begin) ──', '// ── settings-only page (end) ──');
const SH = slice(mob, '// ── settings sheet (begin) ──', '// ── settings sheet (end) ──');

test('settingsOnlyRequested: only ?settings-only=1 asks for it; the page start is unchanged without it', () => {
  const f = new Function(`${fnSrc(SO, 'function settingsOnlyRequested(search)')}; return settingsOnlyRequested;`)();
  assert.strictEqual(f('?settings-only=1'), true);
  assert.strictEqual(f('?desktop=once&settings-only=1'), true);
  for (const s of ['', '?', '?settings-only=0', '?settings-only=true', '?settings=1', null, undefined]) assert.strictEqual(f(s), false, String(s));
  // the flag is read first, and the normal start runs on exactly as before when it is off
  assert.ok(app.indexOf('const SETTINGS_ONLY = settingsOnlyRequested(location.search);') < app.indexOf('(function installSessionGuard() {'));
  assert.match(app, /document\.addEventListener\('DOMContentLoaded', async \(\) => \{\n\s+if \(SETTINGS_ONLY\) \{ settingsOnlyStart\(\); return; \}[^\n]*\n\s+paintInstalledApp\(\);/);
});

test('the settings-only page starts nothing else: no event stream, re-sync, polling or notifications of its own', () => {
  for (const head of ['function resync(force = false) {', 'function startHubEventMonitor() {', 'async function pollAgentStatus() {', 'function catchUpAll() {',
    'async function refreshScheduleBadge() {', 'async function refreshSpendToday() {', 'function activeJobsSync() {', 'async function pollWorkerStatus() {',
    'function refreshWorkerList() {', 'async function toggleDesktopPush() {']) {
    const at = app.indexOf('    ' + (head.startsWith('async') ? '' : '') + head);
    assert.ok(at >= 0, head);
    assert.match(app.slice(at, at + head.length + 140), /\n\s+if \(globalThis\.mmSettingsOnly === true\) return;/, head);
  }
  assert.match(fnSrc(app, 'async function paintDesktopPush() {'), /if \(globalThis\.mmSettingsOnly === true\) \{[^}]*btn\.disabled = true;/);
  assert.match(app, /const SETTINGS_ONLY = settingsOnlyRequested\(location\.search\);\n\s+globalThis\.mmSettingsOnly = SETTINGS_ONLY;/);
  // the start: who is signed in and the dialog, nothing else (no loadMe: no Simple start-up, no resends, no notices)
  const start = fnSrc(SO, 'async function settingsOnlyStart() {');
  assert.ok(!/loadMe\(|loadAgents\(|startHub|startNotify|openTargets|simpleBoot/.test(start), start);
});

function soHarness({ admin = true, parentIsSelf = false } = {}) {
  const posted = [], calls = [];
  const listeners = {};
  const docEl = { classList: { added: [], add(c) { this.added.push(c); } } };
  let overlay = null;
  const parent = { postMessage: (m, o) => posted.push([m, o]) };
  const win = { addEventListener: (t, f) => { listeners[t] = f; } };
  win.parent = parentIsSelf ? win : parent;
  const doc = { documentElement: docEl, body: {}, getElementById: (id) => (id === 'st-overlay' ? overlay : null) };
  const env = {
    window: win, document: doc, location: { origin: 'https://hub.example' },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ isAdmin: admin, user: { id: 'u1' } }) }),
    isHubAdmin: () => admin,
    openSettings: async () => { calls.push('openSettings'); overlay = { id: 'st-overlay' }; },
    stModal: (html) => { calls.push(['stModal', html]); overlay = { id: 'st-overlay' }; },
    dialogGuard: { requestClose: (o, how) => { calls.push(['requestClose', how]); return env.nextClose; } },
    MutationObserver: class { constructor(cb) { env.observe = cb; } observe() {} },
    nextClose: 'closed',
  };
  const f = new Function(...Object.keys(env).filter(k => k !== 'nextClose' && k !== 'observe'), `${SO}; return { settingsOnlyStart, settingsOnlyMessage, settingsOnlyWatch };`);
  const api = f(...Object.keys(env).filter(k => k !== 'nextClose' && k !== 'observe').map(k => env[k]));
  return { api, env, posted, calls, listeners, parent, win, setOverlay: (o) => { overlay = o; } };
}

test('settingsOnlyStart: an admin gets the dialog and the parent hears "ready"; a member gets a plain line, never the dialog', async () => {
  const h = soHarness();
  await h.api.settingsOnlyStart();
  assert.deepStrictEqual(h.env.document.documentElement.classList.added, ['mm-settings-only']);
  assert.ok(h.calls.includes('openSettings'));
  assert.deepStrictEqual(h.posted, [[{ type: 'mm-settings-ready' }, 'https://hub.example']]);
  assert.strictEqual(typeof h.listeners.message, 'function');
  const m = soHarness({ admin: false });
  await m.api.settingsOnlyStart();
  assert.ok(!m.calls.includes('openSettings'));
  assert.match(m.calls.find(c => Array.isArray(c) && c[0] === 'stModal')[1], /Settings are kept by the admins of this Maestro\./);
});

test('settingsOnlyMessage: only a close request from the parent at the same origin acts, and always through dialogGuard', async () => {
  const h = soHarness();
  await h.api.settingsOnlyStart();
  h.posted.length = 0;
  const msg = (over) => h.api.settingsOnlyMessage({ source: h.parent, origin: 'https://hub.example', data: { type: 'mm-settings-close' }, ...over });
  msg({ source: {} }); msg({ origin: 'https://evil.example' }); msg({ data: { type: 'other' } }); msg({ data: null });
  assert.deepStrictEqual(h.calls.filter(c => Array.isArray(c) && c[0] === 'requestClose'), [], 'nothing from elsewhere');
  h.env.nextClose = 'confirm'; msg({});
  assert.deepStrictEqual(h.posted.pop(), [{ type: 'mm-settings-kept' }, 'https://hub.example'], 'Discard changes? is asked: the sheet stays');
  h.env.nextClose = 'busy'; msg({});
  assert.deepStrictEqual(h.posted.pop(), [{ type: 'mm-settings-kept' }, 'https://hub.example'], 'a save running: the sheet stays');
  h.env.nextClose = 'closed'; msg({});
  assert.strictEqual(h.posted.length, 0, 'closed is told by the watch when the dialog is gone');
  assert.deepStrictEqual(h.calls.filter(c => Array.isArray(c) && c[0] === 'requestClose').map(c => c[1]), ['back', 'back', 'back']);
  h.setOverlay(null); msg({});
  assert.deepStrictEqual(h.posted.pop(), [{ type: 'mm-settings-closed' }, 'https://hub.example'], 'no dialog open: closed at once');
});

test('settingsOnlyWatch: "closed" once the dialog is gone, once; a re-render (one overlay swapped for another) is not a close', async () => {
  const h = soHarness();
  await h.api.settingsOnlyStart();
  h.posted.length = 0;
  h.env.observe(); assert.strictEqual(h.posted.length, 0, 'still open');
  h.setOverlay({ id: 'st-overlay' }); h.env.observe(); assert.strictEqual(h.posted.length, 0);
  h.setOverlay(null); h.env.observe(); h.env.observe();
  assert.deepStrictEqual(h.posted, [[{ type: 'mm-settings-closed' }, 'https://hub.example']]);
});

function sheetHarness() {
  const els = {};
  const guard = { opened: [], closed: [], open(el) { this.opened.push(el); }, closed2: null };
  guard.closed = function (el) { (guard._closed ||= []).push(el); };
  const timers = [];
  const listeners = {};
  function mkEl(tag) {
    const e = { tag, children: [], hidden: false, attrs: {}, classes: new Set(), listeners: {}, textContent: '', src: '',
      classList: { add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c), contains: (c) => e.classes.has(c) },
      setAttribute: (k, v) => { e.attrs[k] = v; }, addEventListener: (t, f) => { e.listeners[t] = f; }, remove: () => { e.removed = true; },
      querySelector: (sel) => e.parts[sel] };
    return e;
  }
  const frameWin = { posted: [], postMessage(m, o) { this.posted.push([m, o]); }, location: { pathname: '/' } };
  const doc = {
    createElement: (t) => {
      const el = mkEl(t);
      const frame = mkEl('iframe'); frame.contentWindow = frameWin;
      el.parts = { iframe: frame, '.ssh-msg': mkEl('p'), '.ssh-btns': mkEl('div'), '.ssh-retry': mkEl('button'), '.ssh-close': mkEl('button') };
      Object.defineProperty(el, 'innerHTML', { set(v) { el.html = v; } });
      return el;
    },
    body: { appendChild: (el) => { els.sheet = el; } },
  };
  const env = {
    document: doc, $: (id) => (id === 'menu' ? { classList: { remove() {} } } : null), dialogGuard: guard,
    window: { addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: (t) => { delete listeners[t]; } },
    location: { origin: 'https://hub.example' },
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: (n) => { if (timers[n - 1]) timers[n - 1].f = null; },
  };
  const api = new Function(...Object.keys(env), `${SH}; return { settingsSheetOpen, settingsSheetMessage, settingsSheetRequestClose, settingsSheetFailed, get: () => settingsSheet };`)(...Object.values(env));
  return { api, els, guard, timers, listeners, frameWin };
}

test('the phone sheet: opens the settings-only page in a frame, registers with Back, and takes messages only from its own frame', () => {
  const h = sheetHarness();
  h.api.settingsSheetOpen();
  const s = h.api.get();
  assert.strictEqual(s.frame.src, '/?settings-only=1&desktop=once');
  assert.deepStrictEqual(h.guard.opened, [s.el], 'Back reaches it');
  assert.strictEqual(typeof s.el.__dialogClose, 'function');
  assert.strictEqual(typeof h.listeners.message, 'function');
  // not ready: a close (Back, the failure screen) closes at once, nothing in the frame to lose
  h.api.settingsSheetMessage({ source: {}, origin: 'https://hub.example', data: { type: 'mm-settings-ready' } });
  h.api.settingsSheetMessage({ source: h.frameWin, origin: 'https://evil.example', data: { type: 'mm-settings-ready' } });
  assert.strictEqual(s.ready, false, 'not from another window or origin');
  h.api.settingsSheetMessage({ source: h.frameWin, origin: 'https://hub.example', data: { type: 'mm-settings-ready' } });
  assert.strictEqual(s.ready, true);
  assert.ok(s.el.classes.has('ready'));
  // Back once ready: the dialog in the frame is asked, at this origin, with nothing but the type
  s.el.__dialogClose();
  assert.deepStrictEqual(h.frameWin.posted, [[{ type: 'mm-settings-close' }, 'https://hub.example']]);
  assert.ok(!s.el.removed, 'stays until the frame says closed');
  // "Discard changes?" kept it: registered again so the next Back works
  h.api.settingsSheetMessage({ source: h.frameWin, origin: 'https://hub.example', data: { type: 'mm-settings-kept' } });
  assert.deepStrictEqual(h.guard.opened, [s.el, s.el]);
  h.api.settingsSheetMessage({ source: h.frameWin, origin: 'https://hub.example', data: { type: 'mm-settings-closed' } });
  assert.ok(s.el.removed);
  assert.deepStrictEqual(h.guard._closed, [s.el]);
  assert.strictEqual(h.api.get(), null);
  assert.strictEqual(h.listeners.message, undefined, 'the listener goes with it');
});

test('the phone sheet: a frame that never answers shows a plain message with Try again and Close, never a blank screen', () => {
  const h = sheetHarness();
  h.api.settingsSheetOpen();
  const s = h.api.get();
  const t = h.timers[h.timers.length - 1];
  assert.strictEqual(t.ms, 20000);
  t.f();
  assert.match(s.el.parts['.ssh-msg'].textContent, /Settings didn't open\. Check the connection and try again\./);
  assert.strictEqual(s.el.parts['.ssh-btns'].hidden, false);
  s.el.parts['.ssh-retry'].listeners.click();
  assert.strictEqual(s.el.parts['.ssh-btns'].hidden, true, 'retry starts over');
  assert.match(s.el.parts['.ssh-msg'].textContent, /Opening Settings/);
  s.el.parts['.ssh-close'].listeners.click();
  assert.ok(s.el.removed);
});

test('entry points: the phone menu and Simple\'s sheets offer Settings to admins only, as the desktop gear', () => {
  assert.match(mhtml, /<button id="menu-profile">&#x1F464; Profile<\/button>\n\s+<button id="menu-settings">&#x2699; Settings<\/button>/);
  assert.match(mob, /\$\('menu-settings'\)\?\.addEventListener\('click', settingsSheetOpen\);/);
  assert.match(mob, /if \(\$\('menu-settings'\)\) \$\('menu-settings'\)\.hidden = !hubMe\.isAdmin;/);
  const simplePhone = fnSrc(mob, 'function simpleSettingsOpen() {');
  assert.match(simplePhone, /\(hubMe && hubMe\.isAdmin === false \? '' : '<button type="button" class="ss-row" id="ss-all"><b>All settings<\/b>/);
  assert.match(simplePhone, /\$\('ss-all'\)\?\.addEventListener\('click', \(\) => \{ d\.close\(\); settingsSheetOpen\(\); \}\);/);
  const simpleDesk = fnSrc(app, 'function openSimpleSettings() {');
  assert.match(simpleDesk, /\(me\.isAdmin === false \? '' : '<div class="sm-set"><button type="button" class="sm-plain" data-act="settings"><div><b>All settings<\/b>/);
  assert.match(simpleDesk, /if \(a\.dataset\.act === 'settings'\) \{ simpleCloseSettings\(\); openSettings\(\); \}/);
});

test('layout: the settings-only page hides the rest and fits a phone; the sheet fills the screen inside the safe area', () => {
  assert.match(idx, /html\.mm-settings-only #sidebar, html\.mm-settings-only body > \.main, html\.mm-settings-only #image-modal \{ display: none !important; \}/);
  assert.match(idx, /html\.mm-settings-only \.st-modal > \.st-actions \{ position: sticky; bottom: 0;/);
  assert.match(idx, /html\.mm-settings-only \.st-row > input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\), html\.mm-settings-only \.st-row > select \{ flex: 1 1 200px !important; width: auto !important; max-width: 100% !important; \}/);
  assert.match(mhtml, /#settings-sheet \{ position: fixed; inset: 0; z-index: 40;[^}]*padding: var\(--sat\) 0 var\(--sab\); \}/);
  assert.match(mhtml, /#settings-sheet\.ready \.ssh-wait \{ display: none; \}/);
});
