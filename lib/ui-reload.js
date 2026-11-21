'use strict';
/**
 * ui-reload.js — "Reload" for the desktop page (app.js) and the phone page (mobile.js): a real fresh load of the app,
 * for the installed app (desktop app window, phone home-screen app) where the browser offers no reload button. The pages
 * carry byte-identical copies between the markers below; test/ui-reload.test.js proves the copies match and tests the
 * rules here.
 *
 *   appIsInstalled(win) -> boolean
 *       True when the page runs as an installed app: display-mode standalone, minimal-ui or window-controls-overlay, or
 *       iOS's navigator.standalone.
 *   appReloadUrls(doc, origin) -> [absolute url]
 *       The page itself and its own scripts and style sheets (same origin only, no duplicates). Scripts under /vendor/
 *       (large libraries the page loads on first use) are left out.
 *   appFreshFetch({ urls, fetch, swUpdate, timeoutMs = 4000, setTimer }) -> Promise<'done' | 'timeout'>
 *       Fetches every url with cache: 'reload' and reads each answer to the end (scripts here have no cache headers, so
 *       a plain reload can keep old code), and asks the service worker registration to update (swUpdate, optional);
 *       settles when all of them are done or after timeoutMs, whichever is first. A failed fetch (offline) never rejects.
 *   appNavigationWasReload(perf) -> boolean
 *       True when this page was loaded by a reload (the Navigation Timing entry's type, or the older performance.navigation);
 *       false when the browser cannot tell. A hand-over is only used after a reload, never after other navigation.
 *   appReloadStashSave(storage, chats, now) / appReloadStashTake(storage, now, maxAgeMs = 60000) / appReloadStashClear(storage)
 *       One-shot hand-over across the reload (sessionStorage): the open chats [{ agent, text, front }] in tab order,
 *       written when the page unloads. Take removes it and returns the valid entries; an old or unreadable stash gives
 *       null. Save with no chats clears it.
 *   createAppReloader({ questions, confirm, prepare, go, onBusy, setTimer, busyMs = 8000 }) -> { reload(), busy() }
 *       reload(): does nothing while busy (no double press). Asks each of questions() with confirm() (for example
 *       APP_RELOAD_CALL_QUESTION during a live voice call); a Cancel stops it. Then busy on (onBusy(true)) and prepare()
 *       (the fresh fetch). When that settles, questions() is asked again and any question not already answered is put
 *       (a call started or text typed meanwhile); a Cancel ends the attempt (onBusy(false)). Then go() (the reload). If
 *       the page is still here busyMs later (the person kept a dialog's unsaved edits when the browser asked), the attempt
 *       ends (onBusy(false)). Never reloads by itself.
 */
// ── app reload (begin) ──
const APP_RELOAD_STASH_KEY = 'hub-reload-stash';
const APP_RELOAD_CALL_QUESTION = 'Reloading ends the call. Reload?';
const APP_RELOAD_GROUP_QUESTION = 'Text typed in a group chat will be lost. Reload?';
const APP_RELOAD_OFFLINE_QUESTION = 'This device seems to be offline, so the page may not come back until it is online again. Reload anyway?';
function appIsInstalled(win) {
  try {
    if (win && win.navigator && win.navigator.standalone === true) return true;
    if (!win || typeof win.matchMedia !== 'function') return false;
    return ['standalone', 'minimal-ui', 'window-controls-overlay'].some(m => !!win.matchMedia(`(display-mode: ${m})`).matches);
  } catch { return false; }
}
function appReloadUrls(doc, origin) {
  const out = [], seen = new Set();
  const add = (u) => {
    if (!u) return;
    let url;
    try { url = new URL(u, origin + '/'); } catch { return; }
    if (url.origin !== origin || url.pathname.startsWith('/vendor/')) return;
    url.hash = '';
    const s = url.href;
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  };
  try { add(doc.location && doc.location.href); } catch { /* no address */ }
  const list = (sel) => { try { return Array.from(doc.querySelectorAll(sel) || []); } catch { return []; } };
  for (const s of list('script[src]')) add(s.getAttribute('src'));
  for (const l of list('link[rel="stylesheet"][href]')) add(l.getAttribute('href'));
  return out;
}
function appFreshFetch({ urls = [], fetch: f, swUpdate, timeoutMs = 4000, setTimer = setTimeout } = {}) {
  const jobs = [];
  const body = (r) => (r && r.ok && typeof r.arrayBuffer === 'function' ? r.arrayBuffer() : null);
  for (const u of urls) { try { jobs.push(Promise.resolve(f(u, { cache: 'reload', credentials: 'same-origin' })).then(body).catch(() => null)); } catch { /* skipped */ } }
  if (typeof swUpdate === 'function') { try { jobs.push(Promise.resolve(swUpdate()).catch(() => null)); } catch { /* skipped */ } }
  const all = Promise.all(jobs).then(() => 'done');
  const late = new Promise(r => setTimer(() => r('timeout'), timeoutMs));
  return Promise.race([all, late]);
}
function appNavigationWasReload(perf) {
  try {
    const nav = perf && typeof perf.getEntriesByType === 'function' ? perf.getEntriesByType('navigation') : null;
    if (nav && nav[0] && typeof nav[0].type === 'string') return nav[0].type === 'reload';
  } catch { /* try the older API */ }
  try {
    if (perf && perf.navigation && typeof perf.navigation.type === 'number') return perf.navigation.type === 1;
  } catch { /* cannot tell */ }
  return false;
}
function appReloadStashClear(storage) {
  try { storage.removeItem(APP_RELOAD_STASH_KEY); } catch { /* nothing to clear */ }
}
function appReloadStashSave(storage, chats, now) {
  const list = (Array.isArray(chats) ? chats : []).filter(c => c && c.agent).map(c => ({ agent: String(c.agent), text: String(c.text || ''), front: !!c.front }));
  if (!list.length) { appReloadStashClear(storage); return true; }
  try { storage.setItem(APP_RELOAD_STASH_KEY, JSON.stringify({ chats: list, at: now })); return true; } catch { return false; }
}
function appReloadStashTake(storage, now, maxAgeMs = 60000) {
  let raw = null;
  try { raw = storage.getItem(APP_RELOAD_STASH_KEY); storage.removeItem(APP_RELOAD_STASH_KEY); } catch { return null; }
  if (!raw) return null;
  let e;
  try { e = JSON.parse(raw); } catch { return null; }
  if (!e || !Array.isArray(e.chats) || typeof e.at !== 'number' || !(now - e.at >= 0 && now - e.at <= maxAgeMs)) return null;
  const list = e.chats.filter(c => c && typeof c.agent === 'string' && c.agent).map(c => ({ agent: c.agent, text: typeof c.text === 'string' ? c.text : '', front: c.front === true }));
  return list.length ? list : null;
}
function createAppReloader({ questions = () => [], confirm: ask = () => true, prepare = () => null, go, onBusy = () => {}, setTimer = setTimeout, busyMs = 8000 } = {}) {
  let busy = false, attempt = 0;
  const qsNow = () => { try { return questions() || []; } catch { return []; } };
  const yes = (q) => { try { return !!ask(q); } catch { return false; } };   // a dialog that cannot open counts as Cancel
  const end = (my) => { if (my !== attempt || !busy) return; busy = false; try { onBusy(false); } catch { /* paint only */ } };
  function reload() {
    if (busy) return false;
    const asked = new Set();
    for (const q of qsNow()) { if (!yes(q)) return false; asked.add(q); }
    busy = true;
    const my = ++attempt;
    try { onBusy(true); } catch { /* paint only */ }
    Promise.resolve().then(prepare).catch(() => null).then(() => {
      for (const q of qsNow()) if (!asked.has(q) && !yes(q)) { end(my); return; }
      try { go(); } catch { /* the page stays */ }
      setTimer(() => end(my), busyMs);
    });
    return true;
  }
  return { reload, busy: () => busy };
}
// ── app reload (end) ──
if (typeof module !== 'undefined' && module.exports) module.exports = { APP_RELOAD_STASH_KEY, APP_RELOAD_CALL_QUESTION, APP_RELOAD_GROUP_QUESTION, APP_RELOAD_OFFLINE_QUESTION, appIsInstalled, appReloadUrls, appFreshFetch, appNavigationWasReload, appReloadStashClear, appReloadStashSave, appReloadStashTake, createAppReloader };
