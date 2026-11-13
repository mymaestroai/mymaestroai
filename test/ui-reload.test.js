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

test('appReloadUrls: the page and its own scripts and style sheets, same origin, no hash, no duplicates', () => {
  const O = 'http://192.0.2.10:3000';
  const els = {
    'script[src]': ['/ui-voice-orb.js', 'app.js', 'https://cdn.example.com/x.js', '/ui-voice-orb.js'],
    'link[rel="stylesheet"][href]': ['/ui-call-display.css', 'https://fonts.example.com/css2?f=Inter'],
  };
  const doc = { location: { href: O + '/#agent', }, querySelectorAll: (s) => (els[s] || []).map(v => ({ getAttribute: () => v })) };
  assert.deepStrictEqual(R.appReloadUrls(doc, O), [O + '/', O + '/ui-voice-orb.js', O + '/app.js', O + '/ui-call-display.css']);
  const phone = { location: { href: O + '/mobile#chat/sam' }, querySelectorAll: (s) => (s === 'script[src]' ? [{ getAttribute: () => 'mobile.js' }] : []) };
  assert.deepStrictEqual(R.appReloadUrls(phone, O), [O + '/mobile', O + '/mobile.js']);
});

test('appFreshReload: every url fetched with cache reload, the service worker asked to update, then one reload', async () => {
  const log = [];
  const how = await R.appFreshReload({
    urls: ['http://192.0.2.10/a.js', 'http://192.0.2.10/b.css'],
    fetch: (u, o) => { log.push(['fetch', u, o.cache]); return Promise.resolve({ ok: true }); },
    swUpdate: () => { log.push(['sw']); return Promise.resolve(); },
    reload: () => log.push(['reload']),
    setTimer: () => 0,
  });
  assert.strictEqual(how, 'done');
  assert.deepStrictEqual(log, [['fetch', 'http://192.0.2.10/a.js', 'reload'], ['fetch', 'http://192.0.2.10/b.css', 'reload'], ['sw'], ['reload']]);
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
test('stash: saved before, taken once after; too old, unreadable or without an agent gives null', () => {
  const s = store();
  assert.strictEqual(R.appReloadStashSave(s, { agent: 'sam', text: 'half a thought' }, 1000), true);
  assert.deepStrictEqual(R.appReloadStashTake(s, 5000), { agent: 'sam', text: 'half a thought' });
  assert.strictEqual(R.appReloadStashTake(s, 5000), null, 'one shot');
  R.appReloadStashSave(s, { agent: 'sam', text: 'x' }, 1000);
  assert.strictEqual(R.appReloadStashTake(s, 1000 + 60001), null, 'too old');
  assert.strictEqual(s.getItem(R.APP_RELOAD_STASH_KEY), null, 'dropped');
  s.setItem(R.APP_RELOAD_STASH_KEY, '{not json'); assert.strictEqual(R.appReloadStashTake(s, 1), null);
  s.setItem(R.APP_RELOAD_STASH_KEY, JSON.stringify({ agent: '', text: 'x', at: 1 })); assert.strictEqual(R.appReloadStashTake(s, 1), null);
  R.appReloadStashSave(s, { agent: 'sam', text: 'x' }, 2000);
  assert.strictEqual(R.appReloadStashTake(s, 1000), null, 'from the future');
  const broken = { setItem() { throw new Error('quota'); }, getItem() { throw new Error('denied'); }, removeItem() {} };
  assert.strictEqual(R.appReloadStashSave(broken, { agent: 'sam' }, 1), false);
  assert.strictEqual(R.appReloadStashTake(broken, 1), null);
});

test('reloader: before then run; a second press while busy does nothing; busy clears after busyMs if the page stays', async () => {
  const log = []; let timer = null;
  const r = R.createAppReloader({ before: () => log.push('before'), run: () => log.push('run'), onBusy: (b) => log.push('busy:' + b), setTimer: (f, ms) => { assert.strictEqual(ms, 8000); timer = f; } });
  assert.strictEqual(r.reload(), true);
  assert.strictEqual(r.reload(), false, 'no double press');
  await Promise.resolve(); await Promise.resolve();
  assert.deepStrictEqual(log, ['busy:true', 'before', 'run']);
  assert.strictEqual(r.busy(), true);
  timer();
  assert.strictEqual(r.busy(), false);
  assert.deepStrictEqual(log.slice(-1), ['busy:false']);
  assert.strictEqual(r.reload(), true, 'can be pressed again');
});

test('reloader: during a voice call it asks first; Cancel does nothing, OK reloads; no call, no question', async () => {
  const asked = []; let ok = false, runs = 0;
  const r = R.createAppReloader({ inCall: () => true, confirm: (q) => { asked.push(q); return ok; }, run: () => runs++, setTimer: () => 0 });
  assert.strictEqual(r.reload(), false);
  assert.deepStrictEqual(asked, ['Reloading ends the call. Reload?']);
  assert.strictEqual(r.busy(), false);
  await Promise.resolve();
  assert.strictEqual(runs, 0);
  ok = true;
  assert.strictEqual(r.reload(), true);
  await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(runs, 1);
  const q = []; let n = 0;
  const r2 = R.createAppReloader({ inCall: () => false, confirm: (x) => { q.push(x); return false; }, run: () => n++, setTimer: () => 0 });
  r2.reload(); await Promise.resolve(); await Promise.resolve();
  assert.deepStrictEqual(q, []); assert.strictEqual(n, 1);
});

test('reloader: a failing before() or run() does not throw out of the button handler', async () => {
  const r = R.createAppReloader({ before: () => { throw new Error('x'); }, run: () => { throw new Error('y'); }, setTimer: () => 0 });
  assert.strictEqual(r.reload(), true);
  await Promise.resolve(); await Promise.resolve();
});
