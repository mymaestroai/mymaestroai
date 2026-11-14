'use strict';
/**
 * ui-busy-workers.js — the "who is busy" chip and the hub-wide worker groups, on the desktop page (app.js) and the phone
 * page (mobile.js). The pages carry byte-identical copies between the markers below; test/ui-busy-workers.test.js proves
 * the copies match and tests the rules here.
 *
 *   busySplit(statusMap, localBusyNames) -> { agents, workers }
 *       statusMap: the hub's status feed { <name>: { busy, busySince, activity, pendingQuestion, worker?, parent?, label?,
 *       model?, consultedBy? } }. A name is a worker when entry.worker === true, or when there is no `worker` field and
 *       it starts with "tw-"; everything else is a named agent. An entry counts when busy or pendingQuestion; the names
 *       this page streams a reply for (localBusyNames) always count (without an entry: an agent unless it starts "tw-").
 *       Both lists are deduplicated and sorted.
 *   busyChipLabel(split, filtering)  "1 agent · 6 workers working", "2 agents working", "" when nobody is busy; with
 *       filtering on and agents busy, " · showing only these ✕" is appended.
 *   hubWorkerGroups(statusMap, { known, skipIds, skipKeys, now }) -> [{ parent, parentLabel, items }]
 *       Busy temporary workers (grouped under entry.parent) and busy named agents that were consulted (grouped under
 *       consultedBy). items: { id, kind: 'temporary' | 'consulted', label, model, startedAt, elapsedMs }. known maps agent
 *       names to display names; skipIds / skipKeys ("parent>id") leave out what the page's own cards show. Groups sort by
 *       parentLabel with the unknown-parent group last; items oldest first.
 *   hubWorkerCount(groups)  the number of items in all groups.
 *   fmtElapsedShort(ms)     m:ss, or h:mm:ss past an hour; '' when there is no time.
 *   workerGoneStep(prev, { running, statusMap, now, graceMs = 15000, confirmMs = 4000 }) -> { next, gone }
 *       Which running temporary-worker cards (running: [{ id, startedAt }], ids starting "tw-" only) the full status feed no
 *       longer lists as busy or asking. prev / next: id -> ms it was first seen missing. A card younger than graceMs is
 *       never missing; one missing in two steps at least confirmMs apart is gone (sorted ids). Pure: now is passed in.
 */
// ── busy and hub workers helpers (begin) ──
function busyIsWorker(name, entry) {
  return entry && typeof entry.worker === 'boolean' ? entry.worker : /^tw-/.test(name);
}
function busySplit(statusMap, localBusyNames) {
  const agents = new Set(), workers = new Set();
  for (const [name, entry] of Object.entries(statusMap || {})) {
    if (!entry || !(entry.busy || entry.pendingQuestion)) continue;
    (busyIsWorker(name, entry) ? workers : agents).add(name);
  }
  for (const name of localBusyNames || []) {
    const entry = (statusMap || {})[name];
    (busyIsWorker(name, entry) ? workers : agents).add(name);
  }
  return { agents: [...agents].sort(), workers: [...workers].sort() };
}
function busyChipLabel(split, filtering) {
  const a = split.agents.length, w = split.workers.length;
  if (!a && !w) return '';
  const parts = [];
  if (a) parts.push(`${a} agent${a === 1 ? '' : 's'}`);
  if (w) parts.push(`${w} worker${w === 1 ? '' : 's'}`);
  return `${parts.join(' · ')} working${filtering && a ? ' · showing only these ✕' : ''}`;
}
function fmtElapsedShort(ms) {
  if (ms == null || !(ms >= 0)) return '';
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function hubWorkerGroups(statusMap, opts) {
  const { known = {}, skipIds = [], skipKeys = [], now } = opts || {};
  const byParent = new Map();
  const add = (parent, kind, id, label, entry) => {
    const startedAt = Date.parse(entry.busySince) || null;
    const item = { id, kind, label, model: entry.model || '', startedAt, elapsedMs: startedAt ? Math.max(0, now - startedAt) : null };
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(item);
  };
  for (const [name, entry] of Object.entries(statusMap || {})) {
    if (!entry || !entry.busy || skipIds.includes(name)) continue;
    if (busyIsWorker(name, entry)) add(entry.parent || null, 'temporary', name, entry.label || 'Worker', entry);
    else if (entry.consultedBy && !skipKeys.includes(`${entry.consultedBy}>${name}`)) add(entry.consultedBy, 'consulted', name, known[name] || name, entry);
  }
  const groups = [...byParent].map(([parent, items]) => {
    items.sort((x, y) => ((x.startedAt == null) - (y.startedAt == null)) || ((x.startedAt || 0) - (y.startedAt || 0)) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    return { parent, parentLabel: parent ? (known[parent] || parent) : 'Unknown agent', items };
  });
  groups.sort((x, y) => ((x.parent == null) - (y.parent == null)) || x.parentLabel.localeCompare(y.parentLabel));
  return groups;
}
function hubWorkerCount(groups) {
  return (groups || []).reduce((n, g) => n + g.items.length, 0);
}
function workerGoneStep(prev, opts) {
  const { running, statusMap, now, graceMs = 15000, confirmMs = 4000 } = opts || {};
  const before = prev || {}, map = statusMap || {}, next = {}, gone = [];
  for (const w of running || []) {
    const id = w && w.id;
    if (typeof id !== 'string' || !/^tw-/.test(id)) continue;
    const entry = map[id];
    if (entry && (entry.busy || entry.pendingQuestion)) continue;
    const startedAt = Number.isFinite(w.startedAt) ? w.startedAt : now;
    if (now - startedAt < graceMs) continue;
    if (id in before && now - before[id] >= confirmMs) gone.push(id);
    else next[id] = id in before ? before[id] : now;
  }
  return { next, gone: gone.sort() };
}
// ── busy and hub workers helpers (end) ──

module.exports = { busySplit, busyChipLabel, hubWorkerGroups, hubWorkerCount, fmtElapsedShort, workerGoneStep };
