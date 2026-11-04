'use strict';
const VERSION = 'hub-mobile-v61';
// Pre-cached at install (must all exist). '/mobile' is only cached once it answers 200 (it needs the server route).
const SHELL = ['/mobile.html', '/mobile.js'];
// Visual-block libraries (svg sanitizer, mermaid, Chart.js): lazy-loaded by the page on first use and
// cached here only once fetched (mermaid is 5 MB; pre-caching it at install would slow every update).
const VENDOR = ['/vendor/purify.min.js', '/vendor/mermaid.min.js', '/vendor/chart.umd.min.js'];
// Manifest and icons are never cached: Chrome reads the app name/icon from them and a stale copy sticks.
const RUNTIME = [...SHELL, '/mobile', ...VENDOR];
const ICON = '/icons/hub-192.png';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // network only: never cached, never wrapped (keeps SSE streaming)
  if (url.pathname === '/manifest.json' || url.pathname.startsWith('/icons/')) return;   // always fresh
  if (!RUNTIME.includes(url.pathname)) return;
  // Network first: online users always get the current page and script; the cache is
  // only a fallback when the hub is unreachable. (Cache-first made phones run stale code
  // for one or two opens after every update.)
  event.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(url.pathname, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});

// Web Push from the hub: payload is { title, body, url, tag, ts } and never carries message content.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'My Maestro AI';
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/mobile';
  // No banner when the app is open and in front: the page already shows the turn live. A test push (force) is
  // shown regardless, so the owner can see the whole path work while looking at the app.
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    if (!data.force && list.some(c => c.focused && c.visibilityState === 'visible')) return;
    return self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || 'hub',
      data: { url },
      icon: ICON,
      badge: ICON,
      renotify: true,
      timestamp: data.ts ? new Date(data.ts).getTime() || Date.now() : Date.now(),
    });
  }));
});

// A tap opens what the notification is about. The phone's worker (scope /mobile) reuses the phone page as before.
// The desktop's worker (scope /) never uses a phone page: a target on the hub's main page (/?agent=<name>, /?backups=1,
// /?update=1) goes to the open hub tab, which confirms on the message's port that it took it (app.js,
// lib/ui-open-target.js); a target on another page (/users) brings that page forward. What no tab takes (no tab open,
// an older page without the listener, a tab that closed meanwhile) opens in a new tab. Firefox lets a worker open a
// tab only within about a second of the tap, so the wait for the confirmation is short.
const HANDOFF_MS = 600;
const HANDOFF_MARGIN_MS = 150;   // the page takes a target only until this long before the worker stops waiting
const MAIN_PAGE = /^\/(index\.html)?$/;
function desktopTarget(href) {
  const u = new URL(href);
  if (!u.pathname.startsWith('/mobile')) return u.pathname + u.search + u.hash;   // /?backups=1, /users and other pages: as given
  const m = /^#chat=(.+)$/.exec(u.hash);
  if (m) {
    let name = m[1];
    try { name = decodeURIComponent(name); } catch { /* not encoded as expected: pass it on as sent */ }
    return `/?agent=${encodeURIComponent(name)}`;
  }
  return u.searchParams.get('update') === '1' ? '/?update=1' : '/';   // the update notice: the desktop's update card
}
// Hands a target to an open hub tab; true only when the page confirms it took it.
function handOff(client, target) {
  return new Promise((resolve) => {
    let ch;
    try { ch = new MessageChannel(); } catch { resolve(false); return; }
    let timer = null;
    const done = (ok) => { clearTimeout(timer); ch.port1.onmessage = null; try { ch.port1.close(); } catch { /* closed */ } resolve(ok); };
    timer = setTimeout(() => done(false), HANDOFF_MS);
    ch.port1.onmessage = (e) => done(!!(e.data && e.data.ok === true));
    try { client.postMessage({ type: 'open-target', url: target, until: Date.now() + HANDOFF_MS - HANDOFF_MARGIN_MS }, [ch.port2]); }
    catch { done(false); }
  });
}
async function openOnDesktop(url) {
  const pathOf = (c) => new URL(c.url).pathname;
  const tabs = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(c => !pathOf(c).startsWith('/mobile'));
  const target = desktopTarget(url);
  const page = new URL(target, self.location.origin).pathname;
  const focus = (c) => Promise.resolve().then(() => c.focus()).then(() => true, () => false);
  if (MAIN_PAGE.test(page)) {
    // the list is in most-recently-focused order: the hub tab used last gets it
    for (const c of tabs.filter(c => MAIN_PAGE.test(pathOf(c)))) {
      if (!(await focus(c))) continue;   // it closed meanwhile: the next one
      if (await handOff(c, target)) return;
      break;                             // an older page, or too late: a new tab instead
    }
  } else {
    for (const c of tabs.filter(c => pathOf(c) === page)) if (await focus(c)) return;
  }
  await self.clients.openWindow(target);
}
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/mobile', self.location.origin).href;
  if (new URL(self.registration.scope).pathname === '/') { event.waitUntil(openOnDesktop(url)); return; }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const same = list.find(c => c.url === url) || list.find(c => new URL(c.url).pathname.startsWith('/mobile'));
      if (same) {
        if (same.url !== url && 'navigate' in same) return same.navigate(url).then(c => c && c.focus());
        return same.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
