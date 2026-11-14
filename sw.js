'use strict';
const VERSION = 'hub-mobile-v69';
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
// The desktop's worker (scope /) never uses a phone page. A target on the hub's main page (/?agent=<name>,
// /?backups=1, /?update=1) is offered to every open hub tab at once; a page that can take it says yes on the offer's
// port (app.js, lib/ui-open-target.js). The worker then spends the tap's one window action: it brings forward the
// yes-tab used last and tells it to go, and only then does that page act. A target on another page (/users) brings
// that page forward. When no tab says yes in time (no tab, an older page, one still loading or closed), the one action
// is a new tab instead. One action per tap because Chrome lets a tap focus or open a window once; the answers that
// count come within OFFER_MS of the tap because Firefox allows a new window only for about a second after it
// (dom.webnotifications.disable_open_click_delay) and Safari for two.
const OFFER_MS = 700;
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
  if (u.searchParams.get('wallet') === 'unlock') return '/?wallet=unlock';   // the wallet-locked notice: the desktop's Wallet panel
  return u.searchParams.get('update') === '1' ? '/?update=1' : '/';   // the update notice: the desktop's update card
}
// Offers a target to hub tabs (most recently used first); resolves with the first of them, in that order, that said
// yes, as { client, port }, or null when none did by the deadline. A tab used more recently that hasn't answered yet
// is waited for until the deadline.
function offer(tabs, target, deadline) {
  return new Promise((resolve) => {
    if (!tabs.length) { resolve(null); return; }
    const state = tabs.map(() => 'waiting');
    const ports = [];
    let settled = false; let timer = null;
    const settle = (timeUp) => {
      if (settled) return;
      const first = state.findIndex(st => st !== 'no');
      let pick;
      if (first < 0) pick = -1;                             // every tab said no, or couldn't be asked
      else if (state[first] === 'yes') pick = first;
      else if (timeUp) pick = state.indexOf('yes');
      else return;                                           // still waiting on a tab used more recently
      settled = true; clearTimeout(timer);
      ports.forEach((p, i) => { if (p && i !== pick) { p.onmessage = null; try { p.close(); } catch { /* closed */ } } });
      resolve(pick >= 0 ? { client: tabs[pick], port: ports[pick] } : null);
    };
    tabs.forEach((client, i) => {
      let ch;
      try { ch = new MessageChannel(); } catch { state[i] = 'no'; return; }
      ports[i] = ch.port1;
      ch.port1.onmessage = (e) => { if (state[i] === 'waiting') { state[i] = e.data && e.data.ok === true ? 'yes' : 'no'; settle(false); } };
      try { client.postMessage({ type: 'open-target', url: target }, [ch.port2]); } catch { state[i] = 'no'; }
    });
    timer = setTimeout(() => settle(true), Math.max(0, deadline - Date.now()));
    settle(false);
  });
}
async function openOnDesktop(url, tappedAt) {
  const pathOf = (c) => new URL(c.url).pathname;
  const tabs = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(c => !pathOf(c).startsWith('/mobile'));
  const target = desktopTarget(url);
  const page = new URL(target, self.location.origin).pathname;
  if (!MAIN_PAGE.test(page)) {
    const same = tabs.find(c => pathOf(c) === page);
    if (same) { try { await same.focus(); return; } catch { /* it closed meanwhile: a new tab (Chrome may refuse a second action) */ } }
    await self.clients.openWindow(target);
    return;
  }
  const yes = await offer(tabs.filter(c => MAIN_PAGE.test(pathOf(c))), target, tappedAt + OFFER_MS);
  if (!yes) { await self.clients.openWindow(target); return; }
  const go = () => { try { yes.port.postMessage({ go: true }); } catch { /* the tab is gone */ } setTimeout(() => { try { yes.port.close(); } catch { /* closed */ } }, 1000); };
  try { await yes.client.focus(); }
  catch { yes.port.onmessage = null; try { yes.port.close(); } catch { /* closed */ } await self.clients.openWindow(target); return; }   // it closed meanwhile
  go();
}
self.addEventListener('notificationclick', (event) => {
  const tappedAt = Date.now();
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/mobile', self.location.origin).href;
  if (new URL(self.registration.scope).pathname === '/') { event.waitUntil(openOnDesktop(url, tappedAt)); return; }
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
