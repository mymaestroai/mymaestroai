'use strict';
// Reload app on the phone page: the menu entry, the click wiring and reloadApp (draft first, one run, fresh files,
// service worker asked to update, never unregistered, no push or settings touched).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const js = read('mobile.js');
const html = read('mobile.html');

const block = js.slice(js.indexOf('// ── app reload (begin) ──'), js.indexOf('// ── app reload (end) ──'));
const pageSrc = js.slice(js.indexOf('function paintReloadBusy(b)'), js.indexOf('function toggleMenu(e)'));

// Build the page code with stubs. voiceCall / current are the page's own variables, set through the returned setters.
function make(over = {}) {
  const log = { confirms: [], toasts: [], fetches: [], updates: [], reloads: 0, unregister: 0, sub: 0, storageWrites: [], drafts: [], timers: [], order: [] };
  const els = { 'menu-reload': { disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }, 'msg-input': { value: 'hello sam' } };
  const reg = { update: () => { log.updates.push('/mobile'); return Promise.resolve(); }, unregister: () => { log.unregister++; }, pushManager: { getSubscription: () => { log.sub++; return Promise.resolve(null); } } };
  const nav = over.noSw ? {} : { serviceWorker: { getRegistration: (scope) => { log.scope = scope; return Promise.resolve(reg); } } };
  const win = { confirm: (q) => { log.confirms.push(q); return over.confirm === undefined ? true : over.confirm; } };
  const loc = { origin: 'http://192.0.2.10:3100', href: 'http://192.0.2.10:3100/mobile#chat=sam', reload: () => { log.reloads++; log.order.push('reload'); } };
  const doc = {
    location: loc,
    querySelectorAll: (sel) => sel === 'script[src]' ? [{ getAttribute: () => '/mobile.js' }] : sel.startsWith('link') ? [{ getAttribute: () => '/mobile.css' }] : [],
  };
  const localStorage = { setItem: (k) => log.storageWrites.push(k), removeItem: (k) => log.storageWrites.push(k), clear: () => log.storageWrites.push('clear'), getItem: () => null };
  const fetchStub = (u, o) => { log.fetches.push([u, o]); return Promise.resolve({}); };
  const factory = new Function('S', '$', 'toast', 'window', 'navigator', 'location', 'document', 'fetch', 'localStorage', 'saveDraft', 'setTimeout',
    `${block}\nlet voiceCall = S.voiceCall; let current = S.current;\n${pageSrc}\nreturn { reloadApp, paintReloadBusy, setCall: (v) => { voiceCall = v; }, setCurrent: (v) => { current = v; }, inst: () => appReloaderInst };`);
  const api = factory(
    {}, (id) => els[id] || null, (t) => log.toasts.push(t), win, nav, loc, doc, fetchStub, localStorage,
    (a, t) => { log.drafts.push([a, t]); log.order.push('draft'); },
    (fn, ms) => { log.timers.push(ms); return 0; },
  );
  return { api, log, els };
}
const settle = () => new Promise(r => setImmediate(r));

test('mobile.html: the menu has "↻ Reload app" right after Open full UI, always shown (no chat-only)', () => {
  const i = html.indexOf('<a href="/?desktop=once">Open full UI</a>');
  assert.ok(i > 0);
  const rest = html.slice(i).split('\n');
  assert.strictEqual(rest[1].trim(), '<button id="menu-reload">&#x21BB; Reload app</button>');
  assert.doesNotMatch(rest[1], /chat-only/);
});

test('wire(): the menu entry click is wired with ?. , closes the menu and calls reloadApp', () => {
  const line = js.split('\n').find(l => l.includes("$('menu-reload')"));
  assert.ok(line, 'wired');
  assert.match(line, /\$\('menu-reload'\)\?\.addEventListener\('click'/);
  assert.match(line, /\$\('menu'\)\.classList\.remove\('open'\)/);
  assert.match(line, /reloadApp\(\)/);
  assert.ok(js.indexOf("$('menu-reload')") > js.indexOf("$('menu-about').addEventListener"), 'next to the other menu entries');
});

test('page code stays outside the shared marker block and does not redeclare its names', () => {
  assert.ok(block.length > 100);
  assert.ok(!block.includes('function reloadApp'));
  for (const n of ['appIsInstalled', 'appReloadUrls', 'appFreshReload', 'appReloadStashSave', 'appReloadStashTake', 'createAppReloader']) {
    assert.strictEqual(js.split(`function ${n}(`).length - 1, 1, n);
  }
});

test('reloadApp asks the voice-call question when a call is up and does nothing on Cancel', async () => {
  const { api, log } = make({ confirm: false });
  api.setCall({ id: 1 }); api.setCurrent('sam');
  assert.strictEqual(api.reloadApp(), false);
  await settle();
  assert.deepStrictEqual(log.confirms, ['Reloading ends the call. Reload?']);
  assert.strictEqual(log.fetches.length, 0);
  assert.strictEqual(log.reloads, 0);
  assert.strictEqual(log.drafts.length, 0);
  assert.deepStrictEqual(log.toasts, []);
});

test('reloadApp with no call does not ask; with OK on the question it goes on', async () => {
  const a = make();
  a.api.reloadApp(); await settle();
  assert.deepStrictEqual(a.log.confirms, []);
  assert.strictEqual(a.log.reloads, 1);
  const b = make({ confirm: true });
  b.api.setCall({ id: 1 });
  b.api.reloadApp(); await settle();
  assert.strictEqual(b.log.confirms.length, 1);
  assert.strictEqual(b.log.reloads, 1);
});

test('the draft is saved inside the reload callback right before location.reload, not at the press; text typed after the press is in it', async () => {
  const a = make();
  a.api.setCurrent('sam');
  a.api.reloadApp();
  assert.deepStrictEqual(a.log.drafts, [], 'a press does not save the draft yet');
  a.els['msg-input'].value = 'hello sam plus new words';   // typed while the files are fetched
  await settle();
  assert.deepStrictEqual(a.log.drafts, [['sam', 'hello sam plus new words']]);
  assert.deepStrictEqual(a.log.order, ['draft', 'reload'], 'saved right before the reload');
  const b = make();
  b.api.reloadApp(); await settle();
  assert.deepStrictEqual(b.log.drafts, [], 'no draft write without an open chat');
  assert.strictEqual(b.log.reloads, 1);
  const c = make({ confirm: false });
  c.api.setCurrent('sam'); c.api.setCall({ id: 1 });
  c.api.reloadApp(); await settle();
  assert.deepStrictEqual(c.log.drafts, [], 'a Cancel saves nothing');
});

test('the page asks only the call question: no offline or group question on the phone', () => {
  assert.match(pageSrc, /questions: \(\) => \(voiceCall \? \[APP_RELOAD_CALL_QUESTION\] : \[\]\)/);
  assert.doesNotMatch(pageSrc, /APP_RELOAD_OFFLINE_QUESTION|APP_RELOAD_GROUP_QUESTION|inCall|before:/);
});

test('two presses give one run; the button is painted busy with the toast "Reloading…"', async () => {
  const { api, log, els } = make();
  assert.strictEqual(api.reloadApp(), true);
  assert.strictEqual(api.reloadApp(), false);
  await settle();
  assert.strictEqual(log.reloads, 1);
  assert.strictEqual(els['menu-reload'].disabled, true);
  assert.strictEqual(els['menu-reload'].attrs['aria-busy'], 'true');
  assert.deepStrictEqual(log.toasts, ['Reloading…']);
});

test('run: the page\'s own urls with cache "reload", registration.update() for scope /mobile, then location.reload()', async () => {
  const { api, log } = make();
  api.reloadApp(); await settle();
  const urls = log.fetches.map(f => f[0]);
  assert.deepStrictEqual(urls, ['http://192.0.2.10:3100/mobile', 'http://192.0.2.10:3100/mobile.js', 'http://192.0.2.10:3100/mobile.css']);
  for (const f of log.fetches) assert.strictEqual(f[1].cache, 'reload');
  assert.strictEqual(log.scope, '/mobile');
  assert.deepStrictEqual(log.updates, ['/mobile']);
  assert.strictEqual(log.reloads, 1);
});

test('run still reloads on a browser without a service worker', async () => {
  const { api, log } = make({ noSw: true });
  api.reloadApp(); await settle();
  assert.strictEqual(log.reloads, 1);
  assert.deepStrictEqual(log.updates, []);
});

test('it never unregisters the service worker and never touches push or localStorage', async () => {
  const { api, log } = make();
  api.setCurrent('sam');
  api.reloadApp(); await settle();
  assert.strictEqual(log.unregister, 0);
  assert.strictEqual(log.sub, 0);
  assert.deepStrictEqual(log.storageWrites, []);
  assert.doesNotMatch(pageSrc, /unregister|getSubscription|unsubscribe|localStorage|removeItem|\.clear\(/);
});
