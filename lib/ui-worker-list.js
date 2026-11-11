'use strict';
/**
 * ui-worker-list.js — which workers the Workers button lists, on the desktop page (app.js) and the phone page
 * (mobile.js). The pages carry byte-identical copies between the markers below; test/ui-worker-list.test.js proves the
 * copies match and tests the rules here.
 *
 *   workerListPick(entries, now, activeId) -> { items, gone, counts, alert }
 *       entries: [{ id, state: 'running' | 'done' | 'stopped' | 'failed', startedAt, endedAt, failSeen, ...more }].
 *       items: what the list shows, running first, then the newest ended (each entry's own fields kept); gone: the ids
 *       that leave the page. A finished or stopped worker stays 2 minutes after it ends; a failed one until it is
 *       opened (failSeen) or for 10 minutes, the newest 3 of those; the one on screen (activeId) never leaves.
 *       counts: { running, done (finished or stopped), failed }; alert: a failed worker in the list not opened yet.
 *   workerButtonLabel(counts)  "3 working · 2 done", "… · 1 failed", or "Workers" when the list is empty.
 *   fmtWorkerClock(ms)         m:ss, or h:mm:ss past an hour.
 */
// ── worker list helpers (begin) ──
const WORKER_DONE_MS = 2 * 60 * 1000, WORKER_FAILED_MS = 10 * 60 * 1000, WORKER_FAILED_MAX = 3;
function workerListPick(entries, now, activeId) {
  const items = [], gone = [], failed = [];
  for (const e of entries || []) {
    if (!e) continue;
    const item = { ...e, endedAt: e.state === 'running' ? null : (e.endedAt || now) };
    if (e.state === 'running') items.push(item);
    else if (e.state === 'failed') failed.push(item);
    else if (e.id === activeId || now - item.endedAt < WORKER_DONE_MS) items.push(item);
    else gone.push(e.id);
  }
  failed.sort((a, b) => b.endedAt - a.endedAt);
  let kept = 0;
  for (const item of failed) {
    const waiting = !item.failSeen && now - item.endedAt < WORKER_FAILED_MS && kept < WORKER_FAILED_MAX;
    if (waiting) kept++;
    if (waiting || item.id === activeId) items.push(item); else gone.push(item.id);
  }
  items.sort((a, b) => ((b.state === 'running') - (a.state === 'running')) || ((b.endedAt || now) - (a.endedAt || now)) || ((b.startedAt || 0) - (a.startedAt || 0)));
  const counts = { running: 0, done: 0, failed: 0 };
  for (const i of items) counts[i.state === 'running' ? 'running' : i.state === 'failed' ? 'failed' : 'done']++;
  return { items, gone, counts, alert: items.some(i => i.state === 'failed' && !i.failSeen) };
}
function workerButtonLabel(counts) {
  if (!counts.running && !counts.done && !counts.failed) return 'Workers';
  return `${counts.running} working · ${counts.done} done${counts.failed ? ` · ${counts.failed} failed` : ''}`;
}
function fmtWorkerClock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
// ── worker list helpers (end) ──

module.exports = { workerListPick, workerButtonLabel, fmtWorkerClock, WORKER_DONE_MS, WORKER_FAILED_MS, WORKER_FAILED_MAX };
