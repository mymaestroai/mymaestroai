'use strict';
/**
 * ui-open-target.js — a notification tapped while the desktop page is open. The desktop's service worker (sw.js)
 * offers the notification's target to every open hub tab over a message channel; a page says yes on that channel,
 * and acts only when the worker says go, which it does after bringing that tab forward (Chrome allows one focus or new
 * window per tap, so the worker decides first and acts once). A tab that never says yes in time (an older page, one
 * still loading, a closed one) gets nothing to do and the worker opens a new tab instead; an offer that never gets a go
 * is dropped. app.js carries a byte-identical copy between the markers below; test/ui-open-target.test.js proves the
 * copy matches and tests the behaviour here.
 *
 *   parseOpenTarget(data, origin)  an 'open-target' message for this origin's main page (/ or /index.html) as
 *                                  { agent, backups, update, security }; null for anything else.
 *   createOpenTargets({ origin, run, store, keepMs })  returns { onMessage(e), ready(own) }. onMessage takes the
 *                                  page's service-worker 'message' events. Targets run one after another through
 *                                  run(t) (it may be async), never two at once. Every go is kept in `store` (as
 *                                  { id, t }) until its target has run, so a reload or a sign-in page in between
 *                                  doesn't lose it.
 *                                  ready(own) runs the page's own address target first, then those waiting.
 *   createTargetStore(storage, now, ttlMs)  { load(), save(list), clear() } over sessionStorage (this tab only).
 */
// ── open-target helpers (begin) ──
const OPEN_TARGET_MAIN = /^\/(index\.html)?$/;
const OPEN_TARGET_KEY = 'hub-open-targets';
function parseOpenTarget(data, origin) {
  if (!data || data.type !== 'open-target' || typeof data.url !== 'string') return null;
  let u;
  try { u = new URL(data.url, origin); } catch { return null; }
  if (u.origin !== origin || !OPEN_TARGET_MAIN.test(u.pathname)) return null;
  const q = u.searchParams;
  return { agent: q.get('agent') || '', backups: q.get('backups') === '1', update: q.get('update') === '1', security: q.get('security') === '1' };
}
function createTargetStore(storage, now = () => Date.now(), ttlMs = 10 * 60 * 1000) {
  return {
    load() {
      try { const v = JSON.parse(storage.getItem(OPEN_TARGET_KEY) || 'null'); return v && Array.isArray(v.targets) && now() - v.at < ttlMs ? v.targets : []; } catch { return []; }
    },
    save(list) { try { storage.setItem(OPEN_TARGET_KEY, JSON.stringify({ at: now(), targets: list })); } catch { /* storage full or off */ } },
    clear() { try { storage.removeItem(OPEN_TARGET_KEY); } catch { /* off */ } },
  };
}
function createOpenTargets({ origin, run, store = null, keepMs = 10000 }) {
  // One queue for this tab, kept in `store` until each target has run: a go before ready() waits there, and a reload
  // (or the sign-in page) in between, or while an earlier target is still running, doesn't lose it. Entries carry an id
  // and a page adds or removes only its own in what the store holds now, so an older copy of the page (one the browser
  // kept for Back) can't overwrite a newer one's. A target still running when the page reloads runs again after it,
  // so targets must stay safe to run twice (each one opens something).
  const waiting = store ? store.load().filter(e => e && e.id && e.t) : [];
  let isReady = false;
  let chain = Promise.resolve();
  const add = (e) => { if (store) { const cur = store.load(); if (!cur.some(x => x && x.id === e.id)) cur.push(e); store.save(cur); } };
  const drop = (e) => { if (store) { const cur = store.load().filter(x => x && x.id !== e.id); if (cur.length) store.save(cur); else store.clear(); } };
  const runInTurn = (t, entry) => {
    chain = chain.then(() => run(t)).catch(() => { /* one failed target must not stop the next */ }).then(() => {
      if (!entry) return;
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
      drop(entry);
    });
    return chain;
  };
  let seq = 0;
  const take = (t) => {
    const e = { id: `${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`, t };
    waiting.push(e); add(e);
    if (isReady) runInTurn(t, e);
  };
  return {
    onMessage(e) {
      const d = e && e.data;
      if (!d || d.type !== 'open-target') return;
      const port = e.ports && e.ports[0];
      if (!port) return;
      const t = parseOpenTarget(d, origin);
      if (!t) { try { port.postMessage({ ok: false }); } catch { /* the worker stopped waiting */ } return; }
      let live = true;
      const end = () => { live = false; port.onmessage = null; try { port.close(); } catch { /* closed */ } };
      const timer = setTimeout(end, keepMs);   // an offer the worker gave to another tab, or gave up on
      port.onmessage = (m) => {
        if (!live || !m || !m.data || m.data.go !== true) return;
        clearTimeout(timer); end();
        take(t);
      };
      try { port.postMessage({ ok: true }); } catch { clearTimeout(timer); end(); }
    },
    ready(own) {
      if (isReady) return chain;
      isReady = true;
      if (own) runInTurn(own, null);
      for (const e of waiting.slice()) runInTurn(e.t, e);
      return chain;
    },
  };
}
// ── open-target helpers (end) ──

module.exports = { parseOpenTarget, createOpenTargets, createTargetStore, OPEN_TARGET_MAIN, OPEN_TARGET_KEY };
