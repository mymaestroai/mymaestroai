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

// A tap opens the agent it is about. The phone's worker (scope /mobile) reuses the phone page as before. The desktop's
// worker (scope /) brings the open hub tab forward and asks it to open the agent (the page listens for 'open-target'),
// rather than opening a second tab on /mobile; with no hub tab open it opens the desktop page at /?agent=<name>.
function desktopTarget(href) {
  const u = new URL(href);
  if (!u.pathname.startsWith('/mobile')) return u.pathname + u.search + u.hash;   // /users and other pages: as given
  const m = /^#chat=(.+)$/.exec(u.hash);
  return m ? `/?agent=${encodeURIComponent(decodeURIComponent(m[1]))}` : '/';
}
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/mobile', self.location.origin).href;
  const desktop = new URL(self.registration.scope).pathname === '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const exact = list.find(c => c.url === url);
      if (exact) return exact.focus();
      const pathOf = (c) => new URL(c.url).pathname;
      if (desktop) {
        const target = desktopTarget(url);
        // list is in most-recently-focused order: the hub's main page first, then any other hub page
        const main = list.find(c => /^\/(index\.html)?$/.test(pathOf(c)));
        if (main) return main.focus().then(c => { (c || main).postMessage({ type: 'open-target', url: target }); return c; });
        const other = list.find(c => !pathOf(c).startsWith('/mobile')) || list[0];
        if (other && 'navigate' in other) return other.navigate(new URL(target, self.location.origin).href).then(c => c && c.focus());
        return self.clients.openWindow(target);
      }
      const same = list.find(c => pathOf(c).startsWith('/mobile'));
      if (same) {
        if ('navigate' in same) return same.navigate(url).then(c => c && c.focus());
        return same.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
