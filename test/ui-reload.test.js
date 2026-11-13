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

test('appFreshReload: every url fetched with cache reload and read to the end, the service worker asked to update, then one reload', async () => {
  const log = [];
  const how = await R.appFreshReload({
    urls: ['http://192.0.2.10/a.js', 'http://192.0.2.10/b.css'],
    fetch: (u, o) => { log.push(['fetch', u, o.cache]); return Promise.resolve({ ok: true, arrayBuffer: () => { log.push(['body', u]); return Promise.resolve(new ArrayBuffer(1)); } }); },
    swUpdate: () => { log.push(['sw']); return Promise.resolve(); },
    reload: () => log.push(['reload']),
    setTimer: () => 0,
  });
  assert.strictEqual(how, 'done');
  assert.deepStrictEqual(log.filter(x => x[0] === 'fetch'), [['fetch', 'http://192.0.2.10/a.js', 'reload'], ['fetch', 'http://192.0.2.10/b.css', 'reload']]);
  assert.strictEqual(log.filter(x => x[0] === 'body').length, 2, 'both bodies read');
  assert.ok(log.some(x => x[0] === 'sw'));
  assert.deepStrictEqual(log[log.length - 1], ['reload'], 'reload last');
  assert.strictEqual(log.filter(x => x[0] === 'reload').length, 1);
});

test('appFreshReload: a body still arriving holds the reload until it ends or the timeout', async () => {
  let endBody = null, fire = null, n = 0;
  const p = R.appFreshReload({ urls: ['u'], fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => new Promise(r => { endBody = r; }) }), reload: () => n++, setTimer: (f) => { fire = f; } });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.strictEqual(n, 0, 'headers alone do not reload');
  endBody(new ArrayBuffer(1));
  assert.strictEqual(await p, 'done');
  assert.strictEqual(n, 1);
  assert.ok(typeof fire === 'function');
});

test('appFreshReload: offline (fetch rejects or throws) still reloads; a hanging fetch reloads at the timeout', async () => {
  let n = 0;
  await R.appFreshReload({ urls: ['u1', 'u2'], fetch: (u) => { if (u === 'u1') throw new Error('offline'); return Promise.reject(new Error('offline')); }, swUpdate: () => { throw new Error('no sw'); }, reload: () => n++, setTimer: () => 0 });
  assert.strictEqual(n, 1);
  let fire = null, m = 0;
  const p = R.appFreshReload({ urls: ['u'], fetch: () => new Promise(() => {}), reload: () => m++, timeoutMs: 4000, setTimer: (f, ms) => { assert.strictEqual(ms, 4000); fire = f; } });
  await Promise.resolve();
  assert.strictEqual(m, 0, 'waits for the fetch');
  fire();
  assert.strictEqual(await p, 'timeout');
  assert.strictEqual(m, 1);
});

function store() { const d = {}; return { d, getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, removeItem: (k) => { delete d[k]; } }; }
test('stash: every open chat saved, taken once after; empty clears; too old, unreadable or without agents gives null', () => {
  const s = store();
  assert.strictEqual(R.appReloadStashSave(s, [{ agent: 'robin', text: '' }, { agent: 'sam', text: 'half a thought' }], 1000), true);
  assert.deepStrictEqual(R.appReloadStashTake(s, 5000), [{ agent: 'robin', text: '' }, { agent: 'sam', text: 'half a thought' }]);
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

test('reloader: run once; a second press while busy does nothing; busy clears after busyMs if the page stays', async () => {
  const log = []; let timer = null;
  const r = R.createAppReloader({ run: () => log.push('run'), onBusy: (b) => log.push('busy:' + b), setTimer: (f, ms) => { assert.strictEqual(ms, 8000); timer = f; } });
  assert.strictEqual(r.reload(), true);
  assert.strictEqual(r.reload(), false, 'no double press');
  await Promise.resolve(); await Promise.resolve();
  assert.deepStrictEqual(log, ['busy:true', 'run']);
  assert.strictEqual(r.busy(), true);
  timer();
  assert.strictEqual(r.busy(), false);
  assert.deepStrictEqual(log.slice(-1), ['busy:false']);
  assert.strictEqual(r.reload(), true, 'can be pressed again');
});

test('reloader: each question is asked first; a Cancel does nothing, all OK reloads; no question, no asking', async () => {
  const asked = []; const answers = [true, false]; let runs = 0;
  const r = R.createAppReloader({ questions: () => [R.APP_RELOAD_CALL_QUESTION, R.APP_RELOAD_GROUP_QUESTION], confirm: (q) => { asked.push(q); return answers.shift(); }, run: () => runs++, setTimer: () => 0 });
  assert.strictEqual(r.reload(), false);
  assert.deepStrictEqual(asked, ['Reloading ends the call. Reload?', 'Text typed in a group chat will be lost. Reload?']);
  assert.strictEqual(r.busy(), false);
  await Promise.resolve();
  assert.strictEqual(runs, 0);
  answers.push(true, true);
  assert.strictEqual(r.reload(), true);
  await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(runs, 1);
  const q = []; let n = 0;
  const r2 = R.createAppReloader({ questions: () => [], confirm: (x) => { q.push(x); return false; }, run: () => n++, setTimer: () => 0 });
  r2.reload(); await Promise.resolve(); await Promise.resolve();
  assert.deepStrictEqual(q, []); assert.strictEqual(n, 1);
  assert.ok(/offline/.test(R.APP_RELOAD_OFFLINE_QUESTION));
});

test('reloader: failing questions() or run() do not throw out of the button handler', async () => {
  const r = R.createAppReloader({ questions: () => { throw new Error('x'); }, run: () => { throw new Error('y'); }, setTimer: () => 0 });
  assert.strictEqual(r.reload(), true);
  await Promise.resolve(); await Promise.resolve();
});
