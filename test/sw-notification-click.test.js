'use strict';
// sw.js notificationclick: a tap focuses the hub tab that is already open and opens what the notification is about
// there, instead of a new /mobile tab (a desktop browser reported a second tab per tap). The page confirms on the
// message's port that it took the target; what no tab takes opens in a new tab. The phone's worker keeps its
// behaviour. The worker runs in a sandbox with stand-in window clients.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ORIGIN = 'http://localhost:8888';
const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

// windows: '/path' (a current page: answers ok), or { url, answer: 'ok' | 'no' | 'silent', focus: 'reject' }.
// 'silent' is an older page with no listener (or one too busy to answer in time).
function worker(scope, windows) {
  const handlers = {}; const log = [];
  const client = (w) => {
    const o = typeof w === 'string' ? { url: w } : w;
    const now = () => c.url.replace(ORIGIN, '');
    const c = {
      url: ORIGIN + o.url,
      focus: async () => { if (o.focus === 'reject') { log.push(['focus failed', now()]); throw new Error('closed'); } log.push(['focus', now()]); return c; },
      postMessage: (m, ports) => {
        log.push(['message', now(), { type: m.type, url: m.url }]);
        assert.ok(typeof m.until === 'number' && m.until > Date.now() && m.until <= Date.now() + 600, 'until is a deadline inside the wait');
        const answer = o.answer || 'ok';
        if (answer !== 'silent') setTimeout(() => ports[0].postMessage({ ok: answer === 'ok' }), 5);
      },
      navigate: async (to) => { log.push(['navigate', now(), to.replace(ORIGIN, '')]); c.url = to; return c; },
    };
    return c;
  };
  const self = {
    location: new URL(ORIGIN + '/sw.js'), registration: { scope: ORIGIN + scope, showNotification: async () => {} },
    clients: { matchAll: async () => windows.map(client), openWindow: async (u) => { log.push(['open', String(u).replace(ORIGIN, '')]); return null; }, claim: async () => {} },
    addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: () => {},
  };
  vm.runInNewContext(src, { self, URL, MessageChannel, setTimeout, clearTimeout, caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [], delete: async () => true }, fetch: async () => ({}), console, Promise, Response: function () {} });
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
  // no hub tab open: the desktop page opens at the agent, not /mobile; another hub page is left as it is
  assert.deepStrictEqual(await worker('/', ['/users'])('/mobile#chat=scout'), [['open', '/?agent=scout']]);
  assert.deepStrictEqual(await worker('/', [])('/mobile#chat=forge'), [['open', '/?agent=forge']]);
  assert.deepStrictEqual(await worker('/', [])('/mobile'), [['open', '/']]);
  // agent names are passed encoded and come back intact; a malformed one is passed on, not a failed tap
  assert.deepStrictEqual((await worker('/', [])(`/mobile#chat=${encodeURIComponent('my agent')}`))[0], ['open', '/?agent=my%20agent']);
  assert.deepStrictEqual((await worker('/', [])('/mobile#chat=50%'))[0], ['open', '/?agent=50%25']);
});

test('desktop worker: backup and update notices keep their action', async () => {
  assert.deepStrictEqual(await worker('/', ['/'])('/?backups=1'), [['focus', '/'], ['message', '/', { type: 'open-target', url: '/?backups=1' }]]);
  assert.deepStrictEqual(await worker('/', [])('/?backups=1'), [['open', '/?backups=1']]);
  assert.deepStrictEqual(await worker('/', ['/'])('/mobile?update=1'), [['focus', '/'], ['message', '/', { type: 'open-target', url: '/?update=1' }]]);
  assert.deepStrictEqual(await worker('/', [])('/mobile?update=1'), [['open', '/?update=1']]);
});

test('desktop worker: a Users notice goes to the Users page and leaves the hub tab alone', async () => {
  assert.deepStrictEqual(await worker('/', ['/', '/users?tab=requests'])('/users'), [['focus', '/users?tab=requests']]);
  assert.deepStrictEqual(await worker('/', ['/'])('/users'), [['open', '/users']]);
});

test('desktop worker: a phone page in the same browser is never used', async () => {
  // the phone tab shows exactly that chat: still the hub tab that gets it
  assert.deepStrictEqual(await worker('/', ['/mobile#chat=forge', '/'])('/mobile#chat=forge'),
    [['focus', '/'], ['message', '/', { type: 'open-target', url: '/?agent=forge' }]]);
  // only a phone tab open: a new desktop tab, the phone page isn't navigated (that worker owns it)
  assert.deepStrictEqual(await worker('/', ['/mobile#chat=forge'])('/mobile#chat=dash'), [['open', '/?agent=dash']]);
});

test('desktop worker: what no tab takes opens in a new tab', async () => {
  // an older page with no listener: brought forward, then the target opens in a new tab after the short wait
  const t0 = Date.now();
  assert.deepStrictEqual(await worker('/', [{ url: '/', answer: 'silent' }])('/mobile#chat=forge'),
    [['focus', '/'], ['message', '/', { type: 'open-target', url: '/?agent=forge' }], ['open', '/?agent=forge']]);
  const waited = Date.now() - t0;
  assert.ok(waited >= 550 && waited < 1000, `waited ${waited} ms: inside Firefox's second for opening a tab`);
  // a page that refuses (it came too late): a new tab at once
  assert.deepStrictEqual(await worker('/', [{ url: '/', answer: 'no' }])('/?backups=1'),
    [['focus', '/'], ['message', '/', { type: 'open-target', url: '/?backups=1' }], ['open', '/?backups=1']]);
  // a tab that closed between the list and the focus: the next hub tab, else a new tab
  assert.deepStrictEqual(await worker('/', [{ url: '/', focus: 'reject' }, '/index.html'])('/mobile#chat=forge'),
    [['focus failed', '/'], ['focus', '/index.html'], ['message', '/index.html', { type: 'open-target', url: '/?agent=forge' }]]);
  assert.deepStrictEqual(await worker('/', [{ url: '/', focus: 'reject' }])('/mobile#chat=forge'), [['focus failed', '/'], ['open', '/?agent=forge']]);
  assert.deepStrictEqual(await worker('/', [{ url: '/users', focus: 'reject' }])('/users'), [['focus failed', '/users'], ['open', '/users']]);
});

test('phone worker (scope /mobile): unchanged, reuses the phone page or opens it', async () => {
  assert.deepStrictEqual(await worker('/mobile', ['/mobile'])('/mobile#chat=forge'), [['navigate', '/mobile', '/mobile#chat=forge'], ['focus', '/mobile#chat=forge']]);
  assert.deepStrictEqual(await worker('/mobile', ['/mobile#chat=forge'])('/mobile#chat=forge'), [['focus', '/mobile#chat=forge']]);
  assert.deepStrictEqual(await worker('/mobile', [])('/mobile#chat=forge'), [['open', '/mobile#chat=forge']]);
  assert.deepStrictEqual(await worker('/mobile', ['/', '/mobile'])('/mobile?update=1'), [['navigate', '/mobile', '/mobile?update=1'], ['focus', '/mobile?update=1']]);
});
