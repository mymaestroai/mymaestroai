'use strict';
/**
 * ui-open-target.js — a notification tapped while the desktop page is open. The desktop's service worker (sw.js)
 * brings the hub tab forward and hands it the notification's target over a message channel; the page confirms on
 * that channel that it took it, and the worker opens a new tab only when no page confirms (an older page without
 * this listener, a tab that closed, a page too busy to answer in time). app.js carries a byte-identical copy between
 * the markers below; test/ui-open-target.test.js proves the copy matches and tests the behaviour here.
 *
 *   parseOpenTarget(data, origin)  an 'open-target' message for this origin's main page (/ or /index.html) as
 *                                  { agent, backups, update, security }; null for anything else (another origin,
 *                                  another page, a malformed address).
 *   createOpenTargets({ origin, now, run })  returns { onMessage(e), ready() }. onMessage takes the page's
 *                                  service-worker 'message' events: a target that parses and arrives before the
 *                                  message's `until` is confirmed at once (ok: true on its port) and run once ready()
 *                                  has been called, in arrival order; one that doesn't is refused (ok: false). The
 *                                  page registers it before its first await, so a tap while the page loads is kept.
 */
// ── open-target helpers (begin) ──
const OPEN_TARGET_MAIN = /^\/(index\.html)?$/;
function parseOpenTarget(data, origin) {
  if (!data || data.type !== 'open-target' || typeof data.url !== 'string') return null;
  let u;
  try { u = new URL(data.url, origin); } catch { return null; }
  if (u.origin !== origin || !OPEN_TARGET_MAIN.test(u.pathname)) return null;
  const q = u.searchParams;
  return { agent: q.get('agent') || '', backups: q.get('backups') === '1', update: q.get('update') === '1', security: q.get('security') === '1' };
}
function createOpenTargets({ origin, now = () => Date.now(), run }) {
  const waiting = [];
  let isReady = false;
  const answer = (e, ok) => { try { if (e.ports && e.ports[0]) e.ports[0].postMessage({ ok }); } catch { /* the worker stopped waiting */ } };
  return {
    onMessage(e) {
      const d = e && e.data;
      if (!d || d.type !== 'open-target') return;
      const t = parseOpenTarget(d, origin);
      // Past `until` the worker is about to open a new tab itself: taking the target too would show it twice.
      if (!t || typeof d.until !== 'number' || now() > d.until) { answer(e, false); return; }
      answer(e, true);
      if (isReady) run(t); else waiting.push(t);
    },
    ready() {
      isReady = true;
      while (waiting.length) run(waiting.shift());
    },
  };
}
// ── open-target helpers (end) ──

module.exports = { parseOpenTarget, createOpenTargets, OPEN_TARGET_MAIN };
