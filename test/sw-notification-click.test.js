'use strict';
// sw.js notificationclick: a tap brings forward the hub tab that is already open and opens what the notification is
// about there, instead of a new /mobile tab (a desktop browser reported a second tab per tap). The worker offers the
// target to the open hub tabs, picks the one used last that says yes, and spends the tap's one window action on it
// (Chrome allows one focus or new window per tap, so this stand-in browser refuses a second); with no yes in time,
// the one action is a new tab. The phone's worker keeps its behaviour. The worker runs in a sandbox.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ORIGIN = 'http://localhost:8888';
const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

// windows: '/path' (a current page: says yes at once), or { url, answer: 'yes' | 'no' | 'silent', after: ms, focus: 'reject' }.
// 'silent' is an older page with no listener, or one still loading.
function worker(scope, windows, { matchAllMs = 0 } = {}) {
  const handlers = {}; const log = []; let actions = 0;
  const windowAction = (what) => { if (++actions > 1) { log.push(['refused', what]); throw new Error('InvalidAccessError: Not allowed to open a window.'); } };
  const client = (w) => {
    const o = typeof w === 'string' ? { url: w } : w;
    const now = () => c.url.replace(ORIGIN, '');
    const c = {
      url: ORIGIN + o.url,
      focus: async () => { windowAction(`focus ${now()}`); if (o.focus === 'reject') { log.push(['focus failed', now()]); throw new Error('closed'); } log.push(['focus', now()]); return c; },
      postMessage: (m, ports) => {
        log.push(['offer', now(), m.url]);
        const port = ports[0];
        port.onmessage = (e) => { if (e.data && e.data.go === true) log.push(['go', now()]); };
        const answer = o.answer || 'yes';
        if (answer !== 'silent') setTimeout(() => port.postMessage({ ok: answer === 'yes' }), o.after || 1);
      },
      navigate: async (to) => { log.push(['navigate', now(), to.replace(ORIGIN, '')]); c.url = to; return c; },
    };
    return c;
  };
  const self = {
    location: new URL(ORIGIN + '/sw.js'), registration: { scope: ORIGIN + scope, showNotification: async () => {} },
    clients: {
      matchAll: async () => { if (matchAllMs) await new Promise(r => setTimeout(r, matchAllMs)); return windows.map(client); },
      openWindow: async (u) => { windowAction(`open ${String(u).replace(ORIGIN, '')}`); log.push(['open', String(u).replace(ORIGIN, '')]); return null; },
      claim: async () => {},
    },
    addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: () => {},
  };
  vm.runInNewContext(src, { self, URL, MessageChannel, setTimeout, clearTimeout, caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [], delete: async () => true }, fetch: async () => ({}), console, Promise, Response: function () {} });
  return async (url) => {
    let done; const t0 = Date.now();
    handlers.notificationclick({ notification: { data: { url }, close: () => {} }, waitUntil: (p) => { done = p; } });
    await done.catch(() => {});
    await new Promise(r => setTimeout(r, 30));   // a go posted on the port arrives a moment later
    const out = JSON.parse(JSON.stringify(log));  // objects made inside the sandbox belong to another realm
    out.ms = Date.now() - t0;
    return out;
  };
}
const steps = (r) => r.filter(x => Array.isArray(x));

test('desktop worker: the open hub tab says yes, comes forward and is told to go; no second tab', async () => {
  assert.deepStrictEqual(steps(await worker('/', ['/', '/users'])('/mobile#chat=forge')),
    [['offer', '/', '/?agent=forge'], ['focus', '/'], ['go', '/']]);
  // the hub tab in the background behind another hub page: still the hub tab that gets it
  assert.deepStrictEqual(steps(await worker('/', ['/agent-settings.html', '/index.html'])('/mobile#chat=dash')),
    [['offer', '/index.html', '/?agent=dash'], ['focus', '/index.html'], ['go', '/index.html']]);
  // no hub tab open: the desktop page opens at the agent, not /mobile; another hub page is left as it is
  assert.deepStrictEqual(steps(await worker('/', ['/users'])('/mobile#chat=scout')), [['open', '/?agent=scout']]);
  assert.deepStrictEqual(steps(await worker('/', [])('/mobile#chat=forge')), [['open', '/?agent=forge']]);
  assert.deepStrictEqual(steps(await worker('/', [])('/mobile')), [['open', '/']]);
  // agent names are passed encoded and come back intact; a malformed one is passed on, not a failed tap
  assert.deepStrictEqual(steps(await worker('/', [])(`/mobile#chat=${encodeURIComponent('my agent')}`)), [['open', '/?agent=my%20agent']]);
  assert.deepStrictEqual(steps(await worker('/', [])('/mobile#chat=50%')), [['open', '/?agent=50%25']]);
});

test('desktop worker: backup and update notices keep their action', async () => {
  assert.deepStrictEqual(steps(await worker('/', ['/'])('/?backups=1')), [['offer', '/', '/?backups=1'], ['focus', '/'], ['go', '/']]);
  assert.deepStrictEqual(steps(await worker('/', [])('/?backups=1')), [['open', '/?backups=1']]);
  assert.deepStrictEqual(steps(await worker('/', ['/'])('/mobile?update=1')), [['offer', '/', '/?update=1'], ['focus', '/'], ['go', '/']]);
  assert.deepStrictEqual(steps(await worker('/', [])('/mobile?update=1')), [['open', '/?update=1']]);
});

test('desktop worker: a Users notice goes to the Users page and leaves the hub tab alone', async () => {
  assert.deepStrictEqual(steps(await worker('/', ['/', '/users?tab=requests'])('/users')), [['focus', '/users?tab=requests']]);
  assert.deepStrictEqual(steps(await worker('/', ['/'])('/users')), [['open', '/users']]);
});

test('desktop worker: a phone page in the same browser is never offered anything or used', async () => {
  assert.deepStrictEqual(steps(await worker('/', ['/mobile#chat=forge', '/'])('/mobile#chat=forge')), [['offer', '/', '/?agent=forge'], ['focus', '/'], ['go', '/']]);
  assert.deepStrictEqual(steps(await worker('/', ['/mobile#chat=forge'])('/mobile#chat=dash')), [['open', '/?agent=dash']]);
});

test('desktop worker: one window action per tap: a tab that does not say yes in time gets nothing, a new tab opens', async () => {
  // an older page (no listener) or one still loading: nothing is focused, so the one action is the new tab
  const r = await worker('/', [{ url: '/', answer: 'silent' }])('/mobile#chat=forge');
  assert.deepStrictEqual(steps(r), [['offer', '/', '/?agent=forge'], ['open', '/?agent=forge']]);
  assert.ok(r.ms >= 650, `waited for the answer until the deadline (${r.ms} ms)`);
  // a tab that says no: a new tab at once
  const no = await worker('/', [{ url: '/', answer: 'no' }])('/?backups=1');
  assert.deepStrictEqual(steps(no), [['offer', '/', '/?backups=1'], ['open', '/?backups=1']]);
  assert.ok(no.ms < 400, `${no.ms} ms`);
  // a yes after the deadline is too late: the new tab, and the late tab is never told to go
  assert.deepStrictEqual(steps(await worker('/', [{ url: '/', after: 900 }])('/mobile#chat=forge')).filter(x => x[0] !== 'offer'), [['open', '/?agent=forge']]);
  // the deadline counts from the tap, not from when the tabs were listed (Firefox's second)
  const slow = await worker('/', [{ url: '/', answer: 'silent' }], { matchAllMs: 400 })('/mobile#chat=forge');
  assert.ok(slow.ms < 900, `decided ${slow.ms} ms after the tap`);
});

test('desktop worker: two hub tabs: the one used last that says yes gets it, the other is never told to go', async () => {
  // the tab used last is an older page: the next one says yes
  assert.deepStrictEqual(steps(await worker('/', [{ url: '/', answer: 'silent' }, '/index.html'])('/mobile#chat=forge')),
    [['offer', '/', '/?agent=forge'], ['offer', '/index.html', '/?agent=forge'], ['focus', '/index.html'], ['go', '/index.html']]);
  // both current: the one used last, even when the other answers first
  assert.deepStrictEqual(steps(await worker('/', [{ url: '/', after: 60 }, { url: '/index.html', after: 1 }])('/mobile#chat=forge')).filter(x => x[0] !== 'offer'),
    [['focus', '/'], ['go', '/']]);
});

test('desktop worker: the chosen tab closed before it could come forward: no go; the new tab is tried', async () => {
  const r = steps(await worker('/', [{ url: '/', focus: 'reject' }])('/mobile#chat=forge'));
  assert.deepStrictEqual(r.filter(x => x[0] !== 'offer'), [['focus failed', '/'], ['refused', 'open /?agent=forge']], 'Chrome refuses the second action; nothing is told to go');
});

test('phone worker (scope /mobile): unchanged, reuses the phone page or opens it', async () => {
  assert.deepStrictEqual(steps(await worker('/mobile', ['/mobile'])('/mobile#chat=forge')), [['navigate', '/mobile', '/mobile#chat=forge'], ['focus', '/mobile#chat=forge']]);
  assert.deepStrictEqual(steps(await worker('/mobile', ['/mobile#chat=forge'])('/mobile#chat=forge')), [['focus', '/mobile#chat=forge']]);
  assert.deepStrictEqual(steps(await worker('/mobile', [])('/mobile#chat=forge')), [['open', '/mobile#chat=forge']]);
  assert.deepStrictEqual(steps(await worker('/mobile', ['/', '/mobile'])('/mobile?update=1')), [['navigate', '/mobile', '/mobile?update=1'], ['focus', '/mobile?update=1']]);
});
