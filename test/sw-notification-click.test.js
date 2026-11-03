'use strict';
// sw.js notificationclick: a tap focuses the hub tab that is already open and opens the agent there, instead of a new
// /mobile tab (a desktop browser reported a second tab per tap). The phone's worker keeps its behaviour. The worker
// runs in a sandbox with stand-in window clients.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ORIGIN = 'http://localhost:8888';
const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function worker(scope, windows) {
  const handlers = {}; const log = [];
  const client = (url) => {
    const now = () => c.url.replace(ORIGIN, '');
    const c = { url: ORIGIN + url, focus: async () => { log.push(['focus', now()]); return c; }, postMessage: (m) => log.push(['message', now(), m]),
      navigate: async (to) => { log.push(['navigate', url, to.replace(ORIGIN, '')]); c.url = to; return c; } };
    return c;
  };
  const self = {
    location: new URL(ORIGIN + '/sw.js'), registration: { scope: ORIGIN + scope, showNotification: async () => {} },
    clients: { matchAll: async () => windows.map(client), openWindow: async (u) => { log.push(['open', String(u).replace(ORIGIN, '')]); return null; }, claim: async () => {} },
    addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: () => {},
  };
  vm.runInNewContext(src, { self, URL, caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [], delete: async () => true }, fetch: async () => ({}), console, Promise, Response: function () {} });
  return async (url) => {
    let done;
    handlers.notificationclick({ notification: { data: { url }, close: () => {} }, waitUntil: (p) => { done = p; } });
    await done; return JSON.parse(JSON.stringify(log));   // objects made inside the sandbox belong to another realm
  };
}

test('desktop worker: the open hub tab is brought forward and told to open the agent; no second tab', async () => {
  assert.deepStrictEqual(await worker('/', ['/', '/users'])('/mobile#chat=forge'),
    [['focus', '/'], ['message', '/', { type: 'open-target', url: '/?agent=forge' }]]);
  // the hub tab in the background behind another hub page: still the hub tab that gets it
  assert.deepStrictEqual(await worker('/', ['/agent-settings.html', '/index.html'])('/mobile#chat=dash'),
    [['focus', '/index.html'], ['message', '/index.html', { type: 'open-target', url: '/?agent=dash' }]]);
  // only another hub page open: it goes to the agent's chat
  assert.deepStrictEqual(await worker('/', ['/users'])('/mobile#chat=scout'), [['navigate', '/users', '/?agent=scout'], ['focus', '/?agent=scout']]);
  // no hub tab open: the desktop page opens at the agent, not /mobile
  assert.deepStrictEqual(await worker('/', [])('/mobile#chat=forge'), [['open', '/?agent=forge']]);
  assert.deepStrictEqual(await worker('/', [])('/mobile'), [['open', '/']]);
  // a notice for the Users page goes there
  assert.deepStrictEqual(await worker('/', ['/'])('/users'), [['focus', '/'], ['message', '/', { type: 'open-target', url: '/users' }]]);
  // agent names are passed encoded and come back intact
  assert.deepStrictEqual((await worker('/', [])(`/mobile#chat=${encodeURIComponent('my agent')}`))[0], ['open', '/?agent=my%20agent']);
});

test('phone worker (scope /mobile): unchanged, reuses the phone page or opens it', async () => {
  assert.deepStrictEqual(await worker('/mobile', ['/mobile'])('/mobile#chat=forge'), [['navigate', '/mobile', '/mobile#chat=forge'], ['focus', '/mobile#chat=forge']]);
  assert.deepStrictEqual(await worker('/mobile', ['/mobile#chat=forge'])('/mobile#chat=forge'), [['focus', '/mobile#chat=forge']]);
  assert.deepStrictEqual(await worker('/mobile', [])('/mobile#chat=forge'), [['open', '/mobile#chat=forge']]);
});

test('the desktop page listens: open-target with ?agent opens that chat, other same-origin pages are navigated to', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /navigator\.serviceWorker\.addEventListener\('message', \(e\) => \{/);
  assert.match(app, /if \(d\.type !== 'open-target' \|\| typeof d\.url !== 'string'\) return;/);
  assert.match(app, /if \(u\.origin !== location\.origin\) return;/);
  assert.match(app, /if \(want\) \{ const a = AGENTS\.find\(x => x\.name === want\); if \(a\) startSoloChat\(a\.name, a\.model\); return; \}/);
  assert.match(app, /navigator\.serviceWorker\.startMessages\(\);/);
});
