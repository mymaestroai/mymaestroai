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
 *       The page itself and its own scripts and style sheets (same origin only, no duplicates), to fetch again.
 *   appFreshReload({ urls, fetch, swUpdate, reload, timeoutMs = 4000, setTimer }) -> Promise
 *       Fetches every url with cache: 'reload' (scripts here have no cache headers, so a plain reload can keep old code)
 *       and asks the service worker registration to update (swUpdate, optional), waits for all of them or timeoutMs,
 *       whichever is first, then calls reload(). A failed fetch (offline) does not stop the reload.
 *   appReloadStashSave(storage, entry, now) / appReloadStashTake(storage, now, maxAgeMs = 60000) -> entry | null
 *       One-shot hand-over across the reload (sessionStorage): the open chat's agent and the text in its message box.
 *       Take removes it; an entry older than maxAgeMs (or unreadable) is dropped and gives null.
 *   createAppReloader({ inCall, confirm, before, run, onBusy, setTimer, busyMs = 8000 }) -> { reload(), busy() }
 *       reload(): does nothing while busy (no double press). During a live voice call (inCall()) it asks
 *       confirm(APP_RELOAD_CALL_QUESTION) and does nothing on Cancel. Then busy on (onBusy(true)), before() (save what
 *       must survive), run() (the fresh reload). If the page is still here after busyMs (the person kept a dialog's
 *       unsaved edits when the browser asked), busy goes off again. Never reloads by itself.
 */
// ── app reload (begin) ──
const APP_RELOAD_STASH_KEY = 'hub-reload-stash';
const APP_RELOAD_CALL_QUESTION = 'Reloading ends the call. Reload?';
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
    if (url.origin !== origin) return;
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
function appFreshReload({ urls = [], fetch: f, swUpdate, reload, timeoutMs = 4000, setTimer = setTimeout } = {}) {
  const jobs = [];
  for (const u of urls) { try { jobs.push(Promise.resolve(f(u, { cache: 'reload', credentials: 'same-origin' })).catch(() => null)); } catch { /* skipped */ } }
  if (typeof swUpdate === 'function') { try { jobs.push(Promise.resolve(swUpdate()).catch(() => null)); } catch { /* skipped */ } }
  const all = Promise.all(jobs).then(() => 'done');
  const late = new Promise(r => setTimer(() => r('timeout'), timeoutMs));
  return Promise.race([all, late]).then((how) => { reload(); return how; });
}
function appReloadStashSave(storage, entry, now) {
  try { storage.setItem(APP_RELOAD_STASH_KEY, JSON.stringify({ agent: String(entry.agent || ''), text: String(entry.text || ''), at: now })); return true; } catch { return false; }
}
function appReloadStashTake(storage, now, maxAgeMs = 60000) {
  let raw = null;
  try { raw = storage.getItem(APP_RELOAD_STASH_KEY); storage.removeItem(APP_RELOAD_STASH_KEY); } catch { return null; }
  if (!raw) return null;
  let e;
  try { e = JSON.parse(raw); } catch { return null; }
  if (!e || typeof e.agent !== 'string' || !e.agent || typeof e.at !== 'number' || !(now - e.at >= 0 && now - e.at <= maxAgeMs)) return null;
  return { agent: e.agent, text: typeof e.text === 'string' ? e.text : '' };
}
function createAppReloader({ inCall = () => false, confirm: ask = () => true, before = () => {}, run, onBusy = () => {}, setTimer = setTimeout, busyMs = 8000 } = {}) {
  let busy = false;
  function reload() {
    if (busy) return false;
    if (inCall() && !ask(APP_RELOAD_CALL_QUESTION)) return false;
    busy = true;
    try { onBusy(true); } catch { /* paint only */ }
    try { before(); } catch { /* the reload still goes on */ }
    setTimer(() => { busy = false; try { onBusy(false); } catch { /* paint only */ } }, busyMs);
    Promise.resolve().then(run).catch(() => {});
    return true;
  }
  return { reload, busy: () => busy };
}
// ── app reload (end) ──
if (typeof module !== 'undefined' && module.exports) module.exports = { APP_RELOAD_STASH_KEY, APP_RELOAD_CALL_QUESTION, appIsInstalled, appReloadUrls, appFreshReload, appReloadStashSave, appReloadStashTake, createAppReloader };
