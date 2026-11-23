'use strict';

/**
 * background-work.js: what an agent has running in the background, for the "Working on" panel and the blue ring.
 *
 * Three kinds count for an agent (scheduled tasks alone never do):
 *   1. hand-offs it started (caller = the agent) that are queued, running or waiting,
 *   2. background jobs it owns that are running or cancelling,
 *   3. temporary workers it runs now (resolved through nested workers up to the named agent).
 *
 * Sources are injected so tests need no real hub; getBackgroundWork() wires the real ones lazily. Pure and offline: a source
 * that throws gives an empty list for its kind, never an error. countFor() reads no files.
 */

const fs = require('fs');
const path = require('path');

const OPEN_HAND_OFF = new Set(['queued', 'running', 'waiting']);
const OPEN_JOB = new Set(['running', 'cancelling']);
const LINE_CHARS = 200;
const RECHECK_MS = 15000;
const COUNTS_TTL_MS = 1000;   // counts() readers (the status feed) get a result at most this old
const OWNER_REQUESTER = '@owner';   // lib/scheduled-tasks OWNER: sees every task

const safeList = (fn) => { try { const r = fn(); return Array.isArray(r) ? r : []; } catch { return []; } };
const iso = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

/** The latest status line of a STATUS.md: the first content line under a "Next" or "Running" heading, else the first
 *  non-heading line; bullets and emphasis marks are dropped; cut to 200 chars. null when there is none. */
function statusLineOf(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = text.split(/\r?\n/);
  const heading = (l) => /^\s{0,3}#{1,6}\s/.test(l);
  const clean = (l) => {
    let s = l.trim().replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '').replace(/^\d+[.)]\s+/, '').replace(/^\*\*(.+?)\*\*/, '$1').trim();
    if (s.length > LINE_CHARS) s = s.slice(0, LINE_CHARS - 1).trimEnd() + '…';
    return s || null;
  };
  for (const want of ['next', 'running']) {
    const at = lines.findIndex((l) => heading(l) && new RegExp(`^\\s{0,3}#{1,6}\\s*${want}\\b`, 'i').test(l));
    if (at < 0) continue;
    for (let i = at + 1; i < lines.length; i++) {
      if (heading(lines[i])) break;
      if (lines[i].trim()) return clean(lines[i]);
    }
  }
  for (const l of lines) if (l.trim() && !heading(l)) return clean(l);
  return null;
}

/** mtime (ISO) of <folder>/STATUS.md: a regular file (never a link), inside the folder itself; else null. */
function statusMtime(folder) {
  try {
    if (!folder || typeof folder !== 'string') return null;
    const file = path.join(folder, 'STATUS.md');
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    const realDir = fs.realpathSync(folder);
    if (fs.realpathSync(file) !== path.join(realDir, 'STATUS.md')) return null;
    return st.mtime.toISOString();
  } catch { return null; }
}

const wholeWord = (hay, id) => !!id && new RegExp(`(^|[^A-Za-z0-9_-])${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_-])`).test(String(hay || ''));

/**
 * @param {object} src
 * @param {{forCaller(agent):object[], listShown(agent,opts):Promise<object[]>}} src.handOffs
 * @param {{list(requester):object[]}} src.jobs
 * @param {{listVirtual():object[], getVirtual(id):object}} src.workers
 * @param {{list(requester,opts):object[]}} src.tasks
 * @param {()=>number} [src.now]
 * @param {(type:string, data:object, opts?:object)=>void} [src.publish]   the hub event stream
 * @param {(folder:string)=>(string|null)} [src.statusMtime]
 */
function createBackgroundWork({ handOffs, jobs, workers, tasks, now = Date.now, publish = null, statusMtime: mtimeOf = statusMtime, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  const hoRows = (agent) => safeList(() => handOffs.forCaller(agent)).filter((r) => r && r.caller === agent && OPEN_HAND_OFF.has(r.state));
  const jobRows = () => safeList(() => jobs.list(null)).filter((j) => j && OPEN_JOB.has(j.status));
  /** The named agent a worker belongs to: through nested workers, as statusExtras does (5 levels). */
  const rootOf = (v) => {
    let parent = v && v.parent ? String(v.parent) : null;
    for (let i = 0; i < 5 && parent; i++) {
      let pv = null;
      try { pv = workers.getVirtual(parent); } catch { pv = null; }
      if (!pv) break;
      parent = pv.parent ? String(pv.parent) : null;
    }
    return parent;
  };
  const workerRows = () => safeList(() => workers.listVirtual()).filter((v) => v && !v.selfCheck);
  const workersOf = (agent) => workerRows().filter((v) => rootOf(v) === agent);

  function countFor(agent) {
    return hoRows(agent).length + jobRows().filter((j) => j.owner === agent).length + workersOf(agent).length;
  }

  /** Every agent with work in one pass: Map name -> count (only > 0). Readers get a result at most COUNTS_TTL_MS old;
   *  recheckAll() always computes fresh (computeCounts) and refreshes the cache. */
  let cache = null;   // { at, map }
  function counts() {
    const t = now();
    if (cache && t - cache.at >= 0 && t - cache.at < COUNTS_TTL_MS) return new Map(cache.map);
    return computeCounts();
  }
  function computeCounts() {
    const m = new Map();
    const add = (n) => { if (n) m.set(n, (m.get(n) || 0) + 1); };
    // callers named by open records, each counted through forCaller (the identity check countFor uses)
    const callers = new Set(safeList(() => handOffs.all ? handOffs.all() : []).filter((r) => r && OPEN_HAND_OFF.has(r.state)).map((r) => r.caller));
    for (const c of callers) for (let i = hoRows(c).length; i > 0; i--) add(c);
    for (const j of jobRows()) add(j.owner);
    for (const v of workerRows()) add(rootOf(v));
    cache = { at: now(), map: new Map(m) };
    return m;
  }

  async function handOffViews(agent, viewer) {
    let rows = [];
    try { rows = await handOffs.listShown(agent, { includeDone: false, withStatus: true }); } catch { rows = []; }
    if (!Array.isArray(rows)) rows = [];
    // a viewer sees a target's words (status line, folder, file time) only when they may see that target
    const mayRead = (target) => {
      if (viewer && viewer.isAdmin) return true;
      if (!viewer || typeof viewer.canSee !== 'function') return false;
      try { return !!viewer.canSee(target); } catch { return false; }
    };
    return rows.map((v) => {
      const { status, folder, ...rest } = v;
      const seen = mayRead(v.target);
      const withheld = !seen || !!v.withheld || !folder;
      const statusLine = withheld ? null : statusLineOf(typeof status === 'string' ? status : '');
      const mtime = withheld ? null : (() => { try { return mtimeOf(folder); } catch { return null; } })();
      const latest = Math.max(...[v.reportedAt, v.endedAt, v.startedAt, v.createdAt].map((x) => (typeof x === 'number' ? x : Date.parse(x))).filter(Number.isFinite), -Infinity);
      const out = { ...rest, statusLine, changedAt: mtime || (Number.isFinite(latest) ? new Date(latest).toISOString() : null) };
      if (seen && folder !== undefined) out.folder = folder;
      return out;
    });
  }

  function nextCheckFor(agent, handOffIds, jobIds) {
    const ids = [...handOffIds, ...jobIds];
    if (!ids.length) return null;
    const open = new Set(handOffIds);
    let best = null;
    for (const t of safeList(() => tasks.list(OWNER_REQUESTER, { includeDone: false }))) {
      if (!t || t.agent !== agent || t.status !== 'active') continue;
      const at = typeof t.nextRunAt === 'number' ? t.nextRunAt : Date.parse(t.nextRunAt);
      if (!Number.isFinite(at)) continue;
      const linked = (t.handOff && open.has(t.handOff)) || ids.some((id) => wholeWord(t.label, id) || wholeWord(t.prompt, id));
      if (linked && (!best || at < best.ms)) best = { ms: at, at: new Date(at).toISOString(), taskId: t.id };
    }
    return best ? { at: best.at, taskId: best.taskId } : null;
  }

  async function viewFor(agent, viewer) {
    const handOffList = await handOffViews(agent, viewer);
    const myJobs = jobRows().filter((j) => j.owner === agent);
    const myWorkers = workersOf(agent);
    const openIds = handOffList.filter((v) => OPEN_HAND_OFF.has(v.state)).map((v) => v.id);
    const isAdmin = !!(viewer && viewer.isAdmin);
    return {
      agent,
      count: hoRows(agent).length + myJobs.length + myWorkers.length,
      handOffs: handOffList,
      jobs: isAdmin ? myJobs.map((j) => ({ id: j.id, name: j.name, startedAt: j.startedAt, status: j.status })) : null,
      jobCount: myJobs.length,
      workers: myWorkers.map((v) => ({ id: v.id, label: String(v.label || ''), model: String(v.model || ''), startedAt: iso(v.createdAt) })),
      nextCheck: nextCheckFor(agent, openIds, myJobs.map((j) => j.id)),
    };
  }

  // ---- the event: published only when an agent's count changes ------------------------------------------------
  const last = new Map();   // agent -> last published count (absent = 0)
  function emit(agent, n) {
    if ((last.get(agent) || 0) === n) return false;
    if (n > 0) last.set(agent, n); else last.delete(agent);
    if (publish) { try { publish('background', { agent, count: n }, { keep: false }); } catch {} }
    return true;
  }
  function recheck(agent) { return agent ? emit(String(agent), countFor(String(agent))) : false; }
  /** Every agent with work now, and every agent that had some: one pass. Returns the number of events published. */
  function recheckAll() {
    const now_ = computeCounts();
    let n = 0;
    for (const [a, c] of now_) if (emit(a, c)) n++;
    for (const a of [...last.keys()]) if (!now_.has(a) && emit(a, 0)) n++;
    return n;
  }
  /** Saves come in bursts: one recheckAll on the next turn of the loop, however many calls came before it. */
  let pending = false;
  function recheckSoon() {
    if (pending) return;
    pending = true;
    setImmediate(() => { pending = false; try { recheckAll(); } catch {} });
  }
  let timer = null;
  function start() {
    if (timer) return;
    timer = setTimer(() => { try { recheckAll(); } catch {} }, RECHECK_MS);
    if (timer && timer.unref) timer.unref();
  }
  function stop() { if (timer) { clearTimer(timer); timer = null; } }

  return { countFor, counts, viewFor, recheck, recheckAll, recheckSoon, start, stop, _last: last, now };
}

// ---- the real instance, wired lazily (sdk-chat requires this file) -----------------------------------------------
let _inst = null;
function getBackgroundWork() {
  if (_inst) return _inst;
  const sdk = () => require('./sdk-chat');
  _inst = createBackgroundWork({
    handOffs: {
      forCaller: (a) => sdk().getHandOffRunner().forCaller(a),
      all: () => [...sdk().getHandOffRunner().items.values()],
      listShown: (a, o) => sdk().getHandOffRunner().listShown(a, o),
    },
    jobs: { list: (r) => sdk().getJobRunner().list(r) },
    workers: { listVirtual: () => require('./temporal-workers').listVirtual(), getVirtual: (id) => require('./temporal-workers').getVirtual(id) },
    tasks: { list: (r, o) => sdk().getScheduledTasks().list(r, o) },
    publish: (type, data, opts) => require('./hub-events').events.publish(type, data, opts),
  });
  return _inst;
}

/** GET /api/agents/<name>/working-on: { status, body }. `agentNames` are the known agents; `viewer.isAdmin` comes from the
 *  trusted session (never the request). The access check itself is the route's (lib/access AGENT_PATH). */
async function workingOnResponse(name, { agentNames, viewer, work = getBackgroundWork() } = {}) {
  if (!name || !Array.isArray(agentNames) || !agentNames.includes(name)) return { status: 404, body: { error: 'unknown agent' } };
  return { status: 200, body: { ok: true, ...(await work.viewFor(name, { isAdmin: !!(viewer && viewer.isAdmin), canSee: viewer && typeof viewer.canSee === 'function' ? viewer.canSee : null })) } };
}

module.exports = { workingOnResponse, createBackgroundWork, getBackgroundWork, statusLineOf, statusMtime, OPEN_HAND_OFF, OPEN_JOB };
