'use strict';
// lib/ui-reload.js: the app's Reload (installed-app check, the page's own files, the fresh reload, the one-shot hand-over
// of the open chat's text, the busy and voice-call guard) and its byte-identical copies in app.js and mobile.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/ui-reload.js');

const ROOT = path.join(__dirname, '..');
const BEGIN = '// ── app reload (begin) ──', END = '// ── app reload (end) ──';
function block(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}
const lib = block(fs.readFileSync(path.join(ROOT, 'lib/ui-reload.js'), 'utf8'), '');
for (const [file, indent] of [['app.js', '    '], ['mobile.js', '']]) {
  test(`the app-reload block in ${file} is byte-identical to lib/ui-reload.js`, () => {
    assert.strictEqual(block(fs.readFileSync(path.join(ROOT, file), 'utf8'), indent), lib, `${file} copy differs`);
  });
}

const mm = (on) => ({ matchMedia: (q) => ({ matches: on.some(m => q === `(display-mode: ${m})`) }), navigator: {} });
test('appIsInstalled: standalone, minimal-ui, window-controls-overlay and iOS standalone; a browser tab is not', () => {
  assert.strictEqual(R.appIsInstalled(mm([])), false);
  assert.strictEqual(R.appIsInstalled(mm(['browser'])), false);
  for (const m of ['standalone', 'minimal-ui', 'window-controls-overlay']) assert.strictEqual(R.appIsInstalled(mm([m])), true, m);
  assert.strictEqual(R.appIsInstalled({ navigator: { standalone: true } }), true);
  assert.strictEqual(R.appIsInstalled(null), false);
  assert.strictEqual(R.appIsInstalled({ matchMedia: () => { throw new Error('x'); }, navigator: {} }), false);
});

test('appReloadUrls: the page and its own scripts and style sheets, same origin, no hash, no duplicates, no /vendor/', () => {
  const O = 'http://192.0.2.10:3000';
  const els = {
    'script[src]': ['/ui-voice-orb.js', 'app.js', 'https://cdn.example.com/x.js', '/ui-voice-orb.js', '/vendor/mermaid.min.js'],
    'link[rel="stylesheet"][href]': ['/ui-call-display.css', 'https://fonts.example.com/css2?f=Inter'],
  };
  const doc = { location: { href: O + '/#agent', }, querySelectorAll: (s) => (els[s] || []).map(v => ({ getAttribute: () => v })) };
  assert.deepStrictEqual(R.appReloadUrls(doc, O), [O + '/', O + '/ui-voice-orb.js', O + '/app.js', O + '/ui-call-display.css']);
  const phone = { location: { href: O + '/mobile#chat/sam' }, querySelectorAll: (s) => (s === 'script[src]' ? [{ getAttribute: () => 'mobile.js' }] : []) };
  assert.deepStrictEqual(R.appReloadUrls(phone, O), [O + '/mobile', O + '/mobile.js']);
});

test('appFreshFetch: every url fetched with cache reload and read to the end, the service worker asked to update; it never reloads', async () => {
  const log = [];
  const how = await R.appFreshFetch({
    urls: ['http://192.0.2.10/a.js', 'http://192.0.2.10/b.css'],
    fetch: (u, o) => { log.push(['fetch', u, o.cache]); return Promise.resolve({ ok: true, arrayBuffer: () => { log.push(['body', u]); return Promise.resolve(new ArrayBuffer(1)); } }); },
    swUpdate: () => { log.push(['sw']); return Promise.resolve(); },
    setTimer: () => 0,
  });
  assert.strictEqual(how, 'done');
  assert.deepStrictEqual(log.filter(x => x[0] === 'fetch'), [['fetch', 'http://192.0.2.10/a.js', 'reload'], ['fetch', 'http://192.0.2.10/b.css', 'reload']]);
  assert.strictEqual(log.filter(x => x[0] === 'body').length, 2, 'both bodies read');
  assert.ok(log.some(x => x[0] === 'sw'));
});

test('appFreshFetch: a body still arriving holds it until it ends; offline never rejects; a hanging fetch settles at the timeout', async () => {
  let endBody = null, settled = false;
  const p = R.appFreshFetch({ urls: ['u'], fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => new Promise(r => { endBody = r; }) }), setTimer: () => 0 });
  p.then(() => { settled = true; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.strictEqual(settled, false, 'headers alone are not enough');
  endBody(new ArrayBuffer(1));
  assert.strictEqual(await p, 'done');
  assert.strictEqual(await R.appFreshFetch({ urls: ['u1', 'u2'], fetch: (u) => { if (u === 'u1') throw new Error('offline'); return Promise.reject(new Error('offline')); }, swUpdate: () => { throw new Error('no sw'); }, setTimer: () => 0 }), 'done');
  let fire = null;
  const q = R.appFreshFetch({ urls: ['u'], fetch: () => new Promise(() => {}), timeoutMs: 4000, setTimer: (f, ms) => { assert.strictEqual(ms, 4000); fire = f; } });
  fire();
  assert.strictEqual(await q, 'timeout');
});

test('appNavigationWasReload: the navigation entry, the older API (also when the newer one throws), and false when the browser cannot tell', () => {
  assert.strictEqual(R.appNavigationWasReload({ getEntriesByType: () => [{ type: 'reload' }] }), true);
  assert.strictEqual(R.appNavigationWasReload({ getEntriesByType: () => [{ type: 'navigate' }] }), false);
  assert.strictEqual(R.appNavigationWasReload({ getEntriesByType: () => [{ type: 'back_forward' }] }), false);
  assert.strictEqual(R.appNavigationWasReload({ getEntriesByType: () => [], navigation: { type: 1 } }), true);
  assert.strictEqual(R.appNavigationWasReload({ navigation: { type: 0 } }), false);
  assert.strictEqual(R.appNavigationWasReload({ getEntriesByType: () => { throw new Error('x'); }, navigation: { type: 1 } }), true);
  assert.strictEqual(R.appNavigationWasReload(null), false);
  assert.strictEqual(R.appNavigationWasReload({}), false);
  assert.strictEqual(R.appNavigationWasReload({ getEntriesByType: () => { throw new Error('x'); } }), false);
});

function store() { const d = {}; return { d, getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, removeItem: (k) => { delete d[k]; } }; }
test('stash: every open chat saved in order with the front one marked, taken once after; empty clears; too old, unreadable or without agents gives null', () => {
  const s = store();
  assert.strictEqual(R.appReloadStashSave(s, [{ agent: 'robin', text: '' }, { agent: 'sam', text: 'half a thought', front: true }, { agent: 'kim', text: 'x' }], 1000), true);
  assert.deepStrictEqual(R.appReloadStashTake(s, 5000), [{ agent: 'robin', text: '', front: false }, { agent: 'sam', text: 'half a thought', front: true }, { agent: 'kim', text: 'x', front: false }]);
  assert.strictEqual(R.appReloadStashTake(s, 5000), null, 'one shot');
  R.appReloadStashSave(s, [{ agent: 'sam', text: 'old' }], 1000);
  assert.strictEqual(R.appReloadStashSave(s, [], 2000), true);
  assert.strictEqual(s.getItem(R.APP_RELOAD_STASH_KEY), null, 'no chats open: an older hand-over is cleared');
  R.appReloadStashSave(s, [{ agent: 'sam', text: 'x' }], 1000);
  assert.strictEqual(R.appReloadStashTake(s, 1000 + 60001), null, 'too old');
  assert.strictEqual(s.getItem(R.APP_RELOAD_STASH_KEY), null, 'dropped');
  s.setItem(R.APP_RELOAD_STASH_KEY, '{not json'); assert.strictEqual(R.appReloadStashTake(s, 1), null);
  s.setItem(R.APP_RELOAD_STASH_KEY, JSON.stringify({ chats: [{ agent: '', text: 'x' }], at: 1 })); assert.strictEqual(R.appReloadStashTake(s, 1), null);
  s.setItem(R.APP_RELOAD_STASH_KEY, JSON.stringify({ agent: 'sam', text: 'x', at: 1 })); assert.strictEqual(R.appReloadStashTake(s, 1), null, 'not a list');
  R.appReloadStashSave(s, [{ agent: 'sam', text: 'x' }], 2000);
  assert.strictEqual(R.appReloadStashTake(s, 1000), null, 'from the future');
  R.appReloadStashSave(s, [{ agent: 'sam' }], 1); R.appReloadStashClear(s); assert.strictEqual(s.getItem(R.APP_RELOAD_STASH_KEY), null);
  const broken = { setItem() { throw new Error('quota'); }, getItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.strictEqual(R.appReloadStashSave(broken, [{ agent: 'sam' }], 1), false);
  assert.strictEqual(R.appReloadStashTake(broken, 1), null);
  R.appReloadStashClear(broken);
});

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
test('reloader: prepare, then go once; a second press while busy does nothing; the attempt ends busyMs after go if the page stays', async () => {
  const log = []; let timer = null, endPrep = null;
  const r = R.createAppReloader({ prepare: () => { log.push('prepare'); return new Promise(res => { endPrep = res; }); }, go: () => log.push('go'), onBusy: (b) => log.push('busy:' + b), setTimer: (f, ms) => { assert.strictEqual(ms, 8000); timer = f; } });
  assert.strictEqual(r.reload(), true);
  assert.strictEqual(r.reload(), false, 'no double press');
  await tick();
  assert.deepStrictEqual(log, ['busy:true', 'prepare'], 'go waits for prepare');
  assert.strictEqual(timer, null, 'no timer before go');
  endPrep('done'); await tick();
  assert.deepStrictEqual(log, ['busy:true', 'prepare', 'go']);
  assert.strictEqual(r.busy(), true);
  timer();
  assert.strictEqual(r.busy(), false);
  assert.deepStrictEqual(log.slice(-1), ['busy:false']);
  assert.strictEqual(r.reload(), true, 'can be pressed again');
});

test('reloader: each question is asked first; a Cancel does nothing, all OK goes on; no question, no asking', async () => {
  const asked = []; const answers = [true, false]; let goes = 0;
  const r = R.createAppReloader({ questions: () => [R.APP_RELOAD_CALL_QUESTION, R.APP_RELOAD_GROUP_QUESTION], confirm: (q) => { asked.push(q); return answers.shift(); }, go: () => goes++, setTimer: () => 0 });
  assert.strictEqual(r.reload(), false);
  assert.deepStrictEqual(asked, ['Reloading ends the call. Reload?', 'Text typed in a group chat will be lost. Reload?']);
  assert.strictEqual(r.busy(), false);
  await tick();
  assert.strictEqual(goes, 0);
  answers.push(true, true);
  assert.strictEqual(r.reload(), true);
  await tick();
  assert.strictEqual(goes, 1);
  assert.strictEqual(asked.length, 4, 'questions already answered are not asked again');
  const q = []; let n = 0;
  const r2 = R.createAppReloader({ questions: () => [], confirm: (x) => { q.push(x); return false; }, go: () => n++, setTimer: () => 0 });
  r2.reload(); await tick();
  assert.deepStrictEqual(q, []); assert.strictEqual(n, 1);
  assert.ok(/offline/.test(R.APP_RELOAD_OFFLINE_QUESTION));
});

test('reloader: a question that arises while the files load (a call started, group text typed) is asked before go; Cancel ends the attempt', async () => {
  let state = []; const asked = []; let answer = false, goes = 0, endPrep = null; const busy = [];
  const r = R.createAppReloader({ questions: () => state, confirm: (q) => { asked.push(q); return answer; }, prepare: () => new Promise(res => { endPrep = res; }), go: () => goes++, onBusy: (b) => busy.push(b), setTimer: () => 0 });
  assert.strictEqual(r.reload(), true);
  await tick();
  state = [R.APP_RELOAD_GROUP_QUESTION];   // typed into a group chat during the wait
  endPrep('done'); await tick();
  assert.deepStrictEqual(asked, ['Text typed in a group chat will be lost. Reload?']);
  assert.strictEqual(goes, 0, 'Cancel: no reload');
  assert.strictEqual(r.busy(), false);
  assert.deepStrictEqual(busy, [true, false]);
  answer = true; state = [R.APP_RELOAD_CALL_QUESTION];
  assert.strictEqual(r.reload(), true);   // asked at the press this time
  await tick();
  endPrep('done'); await tick();
  assert.deepStrictEqual(asked, ['Text typed in a group chat will be lost. Reload?', 'Reloading ends the call. Reload?'], 'not asked twice');
  assert.strictEqual(goes, 1);
});

test('reloader: a late end timer from an earlier attempt does not end a newer one', async () => {
  const timers = []; let goes = 0;
  const r = R.createAppReloader({ go: () => goes++, setTimer: (f) => timers.push(f) });
  r.reload(); await tick();
  timers[0]();   // attempt 1 ends (the page stayed)
  r.reload(); await tick();
  assert.strictEqual(r.busy(), true);
  timers[0]();   // fired again: belongs to attempt 1
  assert.strictEqual(r.busy(), true, 'attempt 2 still busy');
  timers[1]();
  assert.strictEqual(r.busy(), false);
  assert.strictEqual(goes, 2);
});

test('reloader: failing questions(), prepare() or go() do not throw out of the button handler', async () => {
  const r = R.createAppReloader({ questions: () => { throw new Error('x'); }, prepare: () => { throw new Error('p'); }, go: () => { throw new Error('y'); }, setTimer: () => 0 });
  assert.strictEqual(r.reload(), true);
  await tick();
});

test('reloader: a confirm that throws counts as Cancel, at the press and after the wait, and never leaves the button stuck', async () => {
  let goes = 0;
  const r = R.createAppReloader({ questions: () => ['q'], confirm: () => { throw new Error('dialogs blocked'); }, go: () => goes++, setTimer: () => 0 });
  assert.strictEqual(r.reload(), false);
  assert.strictEqual(r.busy(), false);
  let qs = [], endPrep = null; const busy = [];
  const r2 = R.createAppReloader({ questions: () => qs, confirm: () => { throw new Error('dialogs blocked'); }, prepare: () => new Promise(res => { endPrep = res; }), go: () => goes++, onBusy: (b) => busy.push(b), setTimer: () => 0 });
  assert.strictEqual(r2.reload(), true);
  await tick();
  qs = ['late'];
  endPrep('done'); await tick();
  assert.strictEqual(goes, 0);
  assert.strictEqual(r2.busy(), false, 'not stuck');
  assert.deepStrictEqual(busy, [true, false]);
});
