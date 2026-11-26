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
    'async function refreshScheduleBadge() {', 'function activeJobsSync() {', 'async function pollWorkerStatus() {',
    'function refreshWorkerList() {', 'async function toggleDesktopPush() {']) {
    const at = app.indexOf('    ' + (head.startsWith('async') ? '' : '') + head);
    assert.ok(at >= 0, head);
    assert.match(app.slice(at, at + head.length + 140), /\n\s+if \(globalThis\.mmSettingsOnly === true\) return;/, head);
  }
  // review r1/r2: the Spend section's ledger read and its refresh run as on the full page (its caps must show; a failed read comes again)
  assert.ok(!/mmSettingsOnly/.test(fnSrc(app, 'async function refreshSpendToday() {')));
  assert.match(app, /\n    setInterval\(refreshSpendToday, SPEND_REFRESH_MS\);/);
  assert.match(app, /if \(window\.HandOffCard && globalThis\.mmSettingsOnly !== true\) HandOffCard\.track\(/);
  assert.match(app, /if \(isMobile\(\) && globalThis\.mmSettingsOnly !== true\) \{ setTimeout\(openSidebar, 300\); \}/);
  assert.match(app, /if \(SETTINGS_ONLY\) document\.documentElement\.classList\.add\('mm-settings-only'\);/);
  assert.match(fnSrc(app, 'async function paintDesktopPush() {'), /if \(globalThis\.mmSettingsOnly === true\) \{[^}]*btn\.disabled = true;/);
  assert.match(app, /const SETTINGS_ONLY = settingsOnlyRequested\(location\.search\);\n\s+globalThis\.mmSettingsOnly = SETTINGS_ONLY;/);
  // the start: who is signed in and the dialog, nothing else (no loadMe: no Simple start-up, no resends, no notices)
  const start = fnSrc(SO, 'async function settingsOnlyStart() {');
  assert.ok(!/loadMe\(|startHub|startNotify|openTargets|simpleBoot/.test(start), start);   // loadAgents only (review r1): the sections that list agents
});

function soHarness({ admin = true, parentIsSelf = false } = {}) {
  const posted = [], calls = [], layers = [];
  const listeners = {};
  const docEl = { classList: { added: [], add(c) { this.added.push(c); } } };
  let overlay = null;
  const parent = { postMessage: (m, o) => posted.push([m, o]) };
  const win = { addEventListener: (t, f) => { listeners[t] = f; } };
  win.parent = parentIsSelf ? win : parent;
  const docListeners = {};
  let question = null;   // the "Discard changes?" dialog while it is up
  const intervals = [];  // the page's setInterval, ticked by hand: tick() runs every live one once
  const doc = { documentElement: docEl, body: {}, getElementById: (id) => (id === 'st-overlay' ? overlay : null), querySelector: (s) => (s === '.dlg-discard' ? question : null), addEventListener: (t, f, c) => { docListeners[t] = { f, c }; } };
  const env = {
    window: win, document: doc, location: { origin: 'https://hub.example', href: 'https://hub.example/?settings-only=1', replaced: [], replace(u) { this.replaced.push(u); } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ isAdmin: admin, user: { id: 'u1' } }) }),
    isHubAdmin: () => admin,
    openSettings: async () => { calls.push('openSettings'); overlay = { id: 'st-overlay' }; layers.length = 0; layers.push({ el: overlay }); },
    loadAgents: async () => { calls.push('loadAgents'); },
    stModal: (html) => { calls.push(['stModal', html]); overlay = { id: 'st-overlay' }; },
    dialogGuard: { requestClose: (o, how) => { calls.push(['requestClose', how, o]); return env.nextClose; }, layers: () => layers.slice(), isDirty: (el) => !!el.dirty },
    MutationObserver: class { constructor(cb) { env.observe = cb; } observe() {} },
    setInterval: (f) => { intervals.push({ f, on: true }); return intervals.length; }, clearInterval: (n) => { if (intervals[n - 1]) intervals[n - 1].on = false; },
    nextClose: 'closed',
  };
  const f = new Function(...Object.keys(env).filter(k => k !== 'nextClose' && k !== 'observe'), `${SO}; return { settingsOnlyStart, settingsOnlyMessage, settingsOnlyWatch, settingsOnlyLeaveGuard };`);
  const api = f(...Object.keys(env).filter(k => k !== 'nextClose' && k !== 'observe').map(k => env[k]));
  return { api, env, posted, calls, listeners, parent, win, layers, docListeners, setOverlay: (o) => { overlay = o; }, setQuestion: (q) => { question = q; }, tick: () => { for (const i of intervals.slice()) if (i.on) i.f(); }, live: () => intervals.filter((i) => i.on).length };
}

test('settingsOnlyStart: an admin gets the dialog and the parent hears "ready"; a member gets a plain line, never the dialog', async () => {
  const h = soHarness();
  await h.api.settingsOnlyStart();
  assert.deepStrictEqual(h.env.document.documentElement.classList.added, ['mm-settings-only']);
  assert.ok(h.calls.includes('openSettings'));
  assert.ok(h.calls.indexOf('loadAgents') >= 0 && h.calls.indexOf('loadAgents') < h.calls.indexOf('openSettings'), 'review r1: the agents first (sandbox, subscriptions)');
  assert.ok(h.docListeners.click && h.docListeners.click.c === true, 'the leave guard, in the capture phase');
  assert.deepStrictEqual(h.posted, [[{ type: 'mm-settings-ready' }, 'https://hub.example']]);
  assert.strictEqual(typeof h.listeners.message, 'function');
  const m = soHarness({ admin: false });
  await m.api.settingsOnlyStart();
  assert.ok(!m.calls.includes('openSettings'));
  assert.ok(!m.calls.includes('loadAgents'));
  assert.match(m.calls.find(c => Array.isArray(c) && c[0] === 'stModal')[1], /Settings are kept by the admins of this Maestro\./);
});

test('settingsOnlyMessage: only a close request from the parent at the same origin acts, and always through dialogGuard', async () => {
  const h = soHarness();
  await h.api.settingsOnlyStart();
  h.posted.length = 0;
  const msg = (over) => h.api.settingsOnlyMessage({ source: h.parent, origin: 'https://hub.example', data: { type: 'mm-settings-close' }, ...over });
  msg({ source: {} }); msg({ origin: 'https://evil.example' }); msg({ data: { type: 'other' } }); msg({ data: null });
  assert.deepStrictEqual(h.calls.filter(c => Array.isArray(c) && c[0] === 'requestClose'), [], 'nothing from elsewhere');
  // U2: "Discard changes?" posts "asking" (not the final outcome); the answer decides: Keep editing = kept, Discard = the watch's closed
  h.env.nextClose = 'confirm'; h.setQuestion({ cls: 'dlg-discard' }); msg({});
  assert.deepStrictEqual(h.posted.splice(0), [[{ type: 'mm-settings-asking' }, 'https://hub.example']], 'the question is up: asking, never kept yet');
  h.tick(); assert.strictEqual(h.posted.length, 0, 'still up: nothing more is said');
  msg({}); assert.deepStrictEqual(h.posted.splice(0), [[{ type: 'mm-settings-asking' }, 'https://hub.example']]);
  assert.strictEqual(h.live(), 1, 'one watcher however many times it is asked');
  h.setQuestion(null); h.tick();   // Keep editing: the question is gone and Settings is still there
  assert.deepStrictEqual(h.posted.splice(0), [[{ type: 'mm-settings-kept' }, 'https://hub.example']], 'answered Keep editing: kept');
  assert.strictEqual(h.live(), 0);
  h.setQuestion({ cls: 'dlg-discard' }); msg({}); h.posted.length = 0;
  h.setOverlay(null); h.setQuestion(null); h.tick();   // Discard: Settings is gone too
  assert.strictEqual(h.posted.length, 0, 'answered Discard: no kept (the watch reports closed)');
  h.setOverlay({ id: 'st-overlay' });
  h.env.nextClose = 'busy'; msg({});
  assert.deepStrictEqual(h.posted.pop(), [{ type: 'mm-settings-kept' }, 'https://hub.example'], 'a save running: the sheet stays');
  h.env.nextClose = 'closed'; h.setOverlay(null); msg({});
  assert.strictEqual(h.posted.length, 0, 'closed is told by the watch when the dialog is gone');
  h.setOverlay({ id: 'st-overlay' });
  assert.deepStrictEqual(h.calls.filter(c => Array.isArray(c) && c[0] === 'requestClose').map(c => c[1]), ['back', 'back', 'back', 'back', 'back']);
  // review r1: a box opened over Settings is closed first (its own question), and the sheet stays
  const inner = { id: 'inner-box' };
  h.layers.push({ el: inner });
  h.env.nextClose = 'closed'; msg({});
  assert.strictEqual(h.calls[h.calls.length - 1][2], inner, 'the innermost layer');
  assert.deepStrictEqual(h.posted.pop(), [{ type: 'mm-settings-kept' }, 'https://hub.example'], 'Settings is still open: kept');
  h.layers.length = 0; h.setOverlay(null); msg({});
  assert.deepStrictEqual(h.posted.pop(), [{ type: 'mm-settings-closed' }, 'https://hub.example'], 'no dialog open: closed at once');
});

test('review r1/r2: a link or button that opens another page asks first when anything is unsaved; Discard then opens that page', async () => {
  const h = soHarness();
  await h.api.settingsOnlyStart();
  const guard = h.docListeners.click.f;
  const ev = (t, closestDiscardGo = false) => ({ target: { closest: (sel) => (sel === '.dlg-discard-go' ? (closestDiscardGo ? {} : null) : t) }, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  const link = (href, extra = {}) => ({ tagName: 'A', target: '', getAttribute: () => href, hasAttribute: (k) => !!(extra.attrs && k in extra.attrs), ...extra });
  const button = (onclick) => ({ tagName: 'BUTTON', getAttribute: (k) => (k === 'onclick' ? onclick : null) });
  const before = h.calls.length;
  let e = ev(link('/modules')); guard(e);
  assert.strictEqual(e.prevented, true);
  assert.deepStrictEqual(h.env.location.replaced, ['https://hub.example/modules'], 'nothing to lose: the page opens in the sheet in place of this one (Back closes the sheet)');
  e = ev(button("location.href='/modules'")); guard(e);
  assert.deepStrictEqual(h.env.location.replaced, ['https://hub.example/modules', 'https://hub.example/modules']);
  // review r5: a same-origin path that starts with // stays on this origin (the whole checked URL is used)
  e = ev(link('https://hub.example//evil.example/x')); guard(e);
  assert.strictEqual(h.env.location.replaced[2], 'https://hub.example//evil.example/x');
  assert.ok(h.env.location.replaced[2].startsWith('https://hub.example/'));
  h.env.location.replaced.length = 0;
  h.layers[0].el.dirty = true;
  h.env.nextClose = 'confirm';
  for (const t of [link('/modules'), button("location.href='/modules'")]) {
    e = ev(t); guard(e);
    assert.strictEqual(e.prevented, true); assert.strictEqual(e.stopped, true);
    assert.deepStrictEqual(h.calls[h.calls.length - 1].slice(0, 2), ['requestClose', 'close']);
  }
  // review r3: a download (a backup), a hub route, another origin by any spelling: not a page change, never asked about
  for (const t of [link('#x'), link('/modules', { target: '_blank' }), link(''), button('saveSettings()'), button("doThing(); location.href='/x'"),
    link('/backup.tar', { attrs: { download: '' } }), link('/api/backups/download?id=1')]) { e = ev(t); guard(e); assert.strictEqual(e.prevented, false, JSON.stringify(t.getAttribute('onclick') || t.getAttribute('href'))); }
  // review r4: another origin never replaces Settings: a button is stopped (its own onclick never runs), a link opens in a new window
  h.env.window.opened = [];
  h.env.window.open = (u, t, f) => { h.env.window.opened.push([u, t, f]); };
  for (const t of [button("location.href='//evil.example/x'"), button("location.href='/\\\\evil.example'"), button("location.href='https://evil.example/'"), link('https://other.example/page')]) {
    e = ev(t); guard(e);
    assert.strictEqual(e.prevented, true, JSON.stringify(t.getAttribute('onclick') || t.getAttribute('href')));
    assert.strictEqual(e.stopped, true);
  }
  assert.deepStrictEqual(h.env.window.opened, [['https://other.example/page', '_blank', 'noopener']]);
  assert.deepStrictEqual(h.env.location.replaced, [], 'the frame stays on Settings');
  assert.deepStrictEqual(h.env.location.replaced, [], 'asked, not gone');
  e = ev(null); guard(e); assert.strictEqual(e.prevented, false, 'not a link');
  assert.strictEqual(h.calls.length - before, 2);
  // Discard: the dialog goes and the watch opens the page instead of closing the sheet
  h.posted.length = 0;
  e = ev(link('/modules')); guard(e);                       // asks again, the destination kept
  guard(ev({ tagName: 'BUTTON', getAttribute: () => null }, true));   // the Discard button's own click keeps it
  h.setOverlay(null); h.env.observe();
  assert.deepStrictEqual(h.env.location.replaced, ['https://hub.example/modules']);
  assert.deepStrictEqual(h.posted, [], 'no "closed": the sheet shows that page');
  assert.match(SO, /closest\('a\[href\], \[onclick\^="location\.href="\]'\)/);
});

test('review r2: Keep editing, any other click or Back forgets the page a link asked for', async () => {
  const h = soHarness();
  await h.api.settingsOnlyStart();
  const guard = h.docListeners.click.f;
  const ev = (t) => ({ target: { closest: (sel) => (sel === '.dlg-discard-go' ? null : t) }, preventDefault() {}, stopImmediatePropagation() {} });
  h.layers[0].el.dirty = true; h.env.nextClose = 'confirm';
  guard(ev({ tagName: 'A', target: '', getAttribute: () => '/modules', hasAttribute: () => false }));
  guard(ev(null));   // Keep editing (or anything else)
  h.posted.length = 0;
  h.setOverlay(null); h.env.observe();
  assert.deepStrictEqual(h.env.location.replaced, []);
  assert.deepStrictEqual(h.posted, [[{ type: 'mm-settings-closed' }, 'https://hub.example']]);
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
  const frameWin = { posted: [], postMessage(m, o) { this.posted.push([m, o]); }, location: { pathname: '/', search: '?settings-only=1' } };
  const doc = {
    createElement: (t) => {
      const el = mkEl(t);
      const frame = mkEl('iframe'); frame.contentWindow = frameWin;
      el.parts = { iframe: frame, '.ssh-msg': mkEl('p'), '.ssh-btns': mkEl('div'), '.ssh-retry': mkEl('button'), '.ssh-close': mkEl('button'), '.ssh-bar': mkEl('div'), '.ssh-done': mkEl('button'), '.ssh-stuck': mkEl('div'), '.ssh-wait-more': mkEl('button'), '.ssh-force': mkEl('button') };
      Object.defineProperty(el, 'innerHTML', { set(v) { el.html = v; } });
      return el;
    },
    body: { appendChild: (el) => { els.sheet = el; } },
  };
  const env = {
    document: doc, $: (id) => (id === 'menu' ? { classList: { remove() {} } } : null), dialogGuard: guard,
    window: { addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: (t) => { delete listeners[t]; } },
    location: { origin: 'https://hub.example' }, URLSearchParams,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: (n) => { if (timers[n - 1]) timers[n - 1].f = null; },
  };
  const api = new Function(...Object.keys(env), `${SH}; return { settingsSheetOpen, settingsSheetMessage, settingsSheetRequestClose, settingsSheetFailed, settingsSheetFrameLoaded, settingsSheetNoAnswer, get: () => settingsSheet };`)(...Object.values(env));
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

test('review r1: the frame left Settings (sign-in page, a linked page): a Close bar, Back closes the sheet; a close nobody answers gives up', () => {
  const h = sheetHarness();
  h.api.settingsSheetOpen();
  const s = h.api.get();
  h.api.settingsSheetMessage({ source: h.frameWin, origin: 'https://hub.example', data: { type: 'mm-settings-ready' } });
  h.api.settingsSheetFrameLoaded();   // still the Settings page
  assert.strictEqual(s.ready, true); assert.strictEqual(s.el.parts['.ssh-bar'].hidden, true);
  // Back once ready, and the frame never answers (review r2): after 8 s the sheet asks, it never closes on its own
  s.el.__dialogClose();
  const t = h.timers[h.timers.length - 1];
  assert.strictEqual(t.ms, 8000);
  const opened = h.guard.opened.length;
  t.f();
  assert.ok(!s.el.removed, 'a frame that may hold changes is never dropped silently');
  assert.match(s.el.parts['.ssh-msg'].textContent, /Settings isn't answering\. Changes not saved there are lost if you close it now\./);
  assert.strictEqual(s.el.parts['.ssh-stuck'].hidden, false);
  assert.strictEqual(h.guard.opened.length, opened + 1, 'Back works again');
  s.el.parts['.ssh-wait-more'].listeners.click();
  assert.strictEqual(s.el.parts['.ssh-stuck'].hidden, true);
  assert.ok(s.el.classes.has('ready'), 'the frame shows again');
  s.el.parts['.ssh-force'].listeners.click();
  assert.ok(s.el.removed, 'Close anyway closes');
  // an error page in the frame (offline): Try again
  const h4 = sheetHarness();
  h4.api.settingsSheetOpen();
  const s4 = h4.api.get();
  Object.defineProperty(h4.frameWin, 'location', { get() { throw new Error('cross-origin'); } });
  h4.api.settingsSheetFrameLoaded();
  assert.strictEqual(s4.el.parts['.ssh-btns'].hidden, false);
  assert.match(s4.el.parts['.ssh-msg'].textContent, /Settings didn't open/);
  // the frame went to another page
  const h2 = sheetHarness();
  h2.api.settingsSheetOpen();
  const s2 = h2.api.get();
  h2.api.settingsSheetMessage({ source: h2.frameWin, origin: 'https://hub.example', data: { type: 'mm-settings-ready' } });
  h2.frameWin.location = { pathname: '/modules', search: '' };
  h2.api.settingsSheetFrameLoaded();
  assert.strictEqual(s2.ready, false); assert.strictEqual(s2.away, true);
  assert.strictEqual(s2.el.parts['.ssh-bar'].hidden, false, 'a Close bar (no Back on some phones)');
  s2.el.__dialogClose();
  assert.ok(s2.el.removed, 'Back closes at once: nothing of Settings is left');
  assert.deepStrictEqual(h2.frameWin.posted, []);
  // signed in again and back on Settings: the bar goes
  const h3 = sheetHarness();
  h3.api.settingsSheetOpen();
  const s3 = h3.api.get();
  h3.frameWin.location = { pathname: '/login', search: '?next=%2F' };
  h3.api.settingsSheetFrameLoaded();
  assert.strictEqual(s3.el.parts['.ssh-bar'].hidden, false);
  h3.api.settingsSheetMessage({ source: h3.frameWin, origin: 'https://hub.example', data: { type: 'mm-settings-ready' } });
  assert.strictEqual(s3.el.parts['.ssh-bar'].hidden, true);
  assert.strictEqual(s3.ready, true);
  // a kept answer stops the give-up timer
  s3.el.__dialogClose();
  h3.api.settingsSheetMessage({ source: h3.frameWin, origin: 'https://hub.example', data: { type: 'mm-settings-kept' } });
  const t3 = h3.timers[h3.timers.length - 1];
  assert.strictEqual(t3.f, null, 'cleared');
  assert.ok(!s3.el.removed);
});

test('review r3: a save still running asks nothing, so the page is forgotten; a late "kept" clears the no-answer screen', async () => {
  const h = soHarness();
  await h.api.settingsOnlyStart();
  const guard = h.docListeners.click.f;
  h.layers[0].el.dirty = true; h.env.nextClose = 'busy';
  guard({ target: { closest: (sel) => (sel === '.dlg-discard-go' ? null : { tagName: 'A', target: '', getAttribute: () => '/modules', hasAttribute: () => false }) }, preventDefault() {}, stopImmediatePropagation() {} });
  h.posted.length = 0;
  h.setOverlay(null); h.env.observe();   // the save ends and the dialog goes another way
  assert.deepStrictEqual(h.env.location.replaced, [], 'not opened without a question');
  assert.deepStrictEqual(h.posted, [[{ type: 'mm-settings-closed' }, 'https://hub.example']]);
  const sh = sheetHarness();
  sh.api.settingsSheetOpen();
  const st = sh.api.get();
  sh.api.settingsSheetMessage({ source: sh.frameWin, origin: 'https://hub.example', data: { type: 'mm-settings-ready' } });
  st.el.__dialogClose();
  sh.api.settingsSheetNoAnswer();
  assert.strictEqual(st.el.parts['.ssh-stuck'].hidden, false);
  sh.api.settingsSheetMessage({ source: sh.frameWin, origin: 'https://hub.example', data: { type: 'mm-settings-kept' } });
  assert.strictEqual(st.el.parts['.ssh-stuck'].hidden, true, 'the frame shows again (its question is up)');
  assert.ok(st.el.classes.has('ready'));
});

test('review r2: a settings-only page never moves to the phone layout, and the session guard replaces the frame\'s entry', () => {
  const pl = read('lib/ui-phone-layout.js');
  assert.match(pl, /const DESKTOP_ONLY_PARAMS = \[[^\]]*'settings-only'\];/);
  const f = new Function(`${fnSrc(pl, 'function desktopOnlyLink(search) {')}; return desktopOnlyLink;`.replace('DESKTOP_ONLY_PARAMS', "['memory', 'selfcheck', 'connectors', 'backups', 'health', 'websearch', 'settings-only']"))();
  assert.strictEqual(f('?settings-only=1'), true);
  assert.match(app, /if \(SETTINGS_ONLY\) location\.replace\('\/login\?next=' \+ encodeURIComponent\(location\.pathname \+ location\.search\)\);\n\s+else location\.href = '\/login\?next='/);
});
