'use strict';
// lib/mem-watch.js: a best-effort memory watchdog for computers with no systemd user manager (a Mac, or Linux without one).
// With systemd the kernel enforces the limit inside a scope (lib/scope-wrap, lib/jobs.js); here a watcher reads the process
// table every 2 s and stops a process that has grown past the limit.
//
//   parseTable(text, now)       `ps -A -o pid=,ppid=,pgid=,rss=,etimes=` output -> [{ pid, ppid, pgid, rssKb, start }]
//                               (start = now - etimes, in ms; null when the table has no etimes column)
//   counted(table, root, group, seen) -> the rows that count. `seen` is a Map pid -> start time: every member counted before.
//                               A member whose start time no longer matches (within 2 s) is a different process (the pid was
//                               reused): it is dropped, never counted, never signalled. Descendants are walked from EVERY
//                               still-verified member, so a process started by a reparented helper is counted too.
//   measure(table, root, group, seen)  -> bytes
//   sample(root, group, seen, exec)    one table read (the shared sampler) + measure -> bytes, or null when ps can't be read
//   createSampler(opts) / shared       ONE `ps -A` run every 2 s for every watcher in the process: it starts with the first
//                               subscriber and stops with the last. read() also serves the jobs fallback (reads inside 1 s
//                               share a table; reads in flight share a run).
//   watch(root, { limitBytes, group, onStop, ... }) -> { stop(), tick() }   past the limit, the group (and every counted
//                               process) gets SIGTERM, 3 s later ps is read again and SIGKILL goes only to members that are still
//                               the same processes (the group only while its leader is). onStop(text) is called once.
//   stoppedText(bytes)          the notice for a person.
//
// RSS sums count shared pages once per process, so the number can read higher than the real use: the limit is applied as is
// and every message says "best effort".
const { execFile } = require('child_process');
const { gbText } = require('./mem-limit');

const INTERVAL_MS = 2000;
const KILL_GRACE_MS = 3000;
const START_TOLERANCE_MS = 2000;
const SHARE_MS = 1000;

function stoppedText(bytes) {
  return `stopped: it used more than ${gbText(bytes)} of memory (best effort, checked every 2 s)`;
}

function parseTable(text, now = Date.now()) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), rssKb: Number(m[4]), start: m[5] === undefined ? null : now - Number(m[5]) * 1000 });
  }
  return out;
}

/** Is this row still the process remembered as `start`? (an unknown start on either side counts as the same) */
function sameProcess(start, row) {
  if (!row) return false;
  if (start === null || start === undefined || row.start === null || row.start === undefined) return true;
  return Math.abs(start - row.start) <= START_TOLERANCE_MS;
}

/** Which rows count for `root` / `group` right now. `seen` (a Map pid -> start) is updated: gone or different processes leave it. */
function counted(table, root, group, seen = new Map()) {
  const byPid = new Map(table.map(r => [r.pid, r]));
  for (const [p, start] of [...seen]) if (!sameProcess(start, byPid.get(p))) seen.delete(p);   // gone, or a reused pid
  const add = (r) => { if (!seen.has(r.pid)) seen.set(r.pid, r.start === undefined ? null : r.start); };
  if (!seen.rootAdded) { const r = byPid.get(root); if (r) { add(r); seen.rootAdded = true; } }
  // the group's rows join while a verified member is in that group (a group id is not reused while one member lives)
  if (group) {
    let held = false;
    for (const p of seen.keys()) { const r = byPid.get(p); if (r && r.pgid === group) { held = true; break; } }
    if (held) for (const r of table) if (r.pgid === group) add(r);
  }
  const byParent = new Map();
  for (const r of table) { if (!byParent.has(r.ppid)) byParent.set(r.ppid, []); byParent.get(r.ppid).push(r.pid); }
  const stack = [...seen.keys()], visited = new Set(stack);
  for (let guard = 0; stack.length && guard < 1000000; guard++) {
    const p = stack.pop();
    for (const c of byParent.get(p) || []) {
      if (visited.has(c)) continue;
      visited.add(c); add(byPid.get(c)); stack.push(c);
    }
  }
  return table.filter(r => seen.has(r.pid));
}

function measure(table, root, group, seen = new Map()) {
  let kb = 0;
  for (const r of counted(table, root, group, seen)) kb += r.rssKb;
  return kb * 1024;
}

function readTable(exec = execFile, now = Date.now) {
  return new Promise((resolve) => {
    try {
      exec('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss=,etimes='], { timeout: 3000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return resolve(null);
        resolve(parseTable(stdout, now()));
      });
    } catch { resolve(null); }
  });
}

/** One process table reader for everyone. Subscribers get every table the interval reads; the interval runs only while someone is subscribed. */
function createSampler({ exec = execFile, intervalMs = INTERVAL_MS, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, now = Date.now } = {}) {
  const subs = new Set();
  let timer = null, inflight = null, last = null;   // last: { at, table }
  function read({ fresh = false } = {}) {
    if (!fresh) {
      if (last && now() - last.at < SHARE_MS) return Promise.resolve(last.table);
      if (inflight) return inflight;
    }
    const p = readTable(exec, now).then((table) => { if (table) last = { at: now(), table }; return table; });
    const mine = p.finally(() => { if (inflight === mine) inflight = null; });
    inflight = mine;
    return mine;
  }
  async function tick() {
    if (!subs.size) return;
    const table = await read({ fresh: true });
    if (!table) return;
    for (const fn of [...subs]) { try { fn(table); } catch {} }
  }
  function subscribe(fn) {
    subs.add(fn);
    if (!timer) { timer = setIntervalImpl(() => { tick().catch(() => {}); }, intervalMs); if (timer && timer.unref) timer.unref(); }
    return () => {
      subs.delete(fn);
      if (!subs.size && timer) { clearIntervalImpl(timer); timer = null; }
    };
  }
  return { read, subscribe, tick, size: () => subs.size, running: () => !!timer };
}

const shared = createSampler();

async function sample(root, group, seen, exec) {
  const table = exec ? await readTable(exec) : await shared.read();
  return table ? measure(table, Number(root), group ? Number(group) : 0, seen) : null;
}

/** How many counted members of `root` / `group` are still alive (null when ps can't be read). */
async function liveMembers(root, group, seen, exec) {
  const table = exec ? await readTable(exec) : await shared.read({ fresh: true });
  return table ? counted(table, Number(root), group ? Number(group) : 0, seen).length : null;
}

function watch(root, { limitBytes, group = 0, onStop = () => {}, graceMs = KILL_GRACE_MS, exec = null, intervalMs = null,
  kill = (p, s) => process.kill(p, s), setIntervalImpl = null, clearIntervalImpl = null, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, sampler = null } = {}) {
  // Tests pass their own exec / timers: that gets a private sampler; the running hub always uses the one shared sampler.
  const smp = sampler || ((exec || setIntervalImpl || intervalMs) ? createSampler({ ...(exec ? { exec } : {}), ...(setIntervalImpl ? { setIntervalImpl } : {}), ...(clearIntervalImpl ? { clearIntervalImpl } : {}), ...(intervalMs ? { intervalMs } : {}) }) : shared);
  const seen = new Map();
  const rootPid = Number(root), groupPid = group ? Number(group) : 0;
  let stopped = false, busy = false, tripped = false, unsub = null, killTimer = null;
  const halt = () => { stopped = true; if (unsub) { unsub(); unsub = null; } };
  const stop = () => { halt(); if (killTimer) { clearTimeoutImpl(killTimer); killTimer = null; } };
  function handle(table) {
    if (stopped || busy || tripped || !limitBytes || !table) return;
    const members = counted(table, rootPid, groupPid, seen);
    let kb = 0; for (const r of members) kb += r.rssKb;
    if (kb * 1024 <= limitBytes) return;
    tripped = true;
    const leaderVerified = !!groupPid && seen.has(groupPid);
    const send = (sig, pids, withGroup) => {
      if (withGroup && groupPid !== process.pid) { try { kill(-groupPid, sig); } catch {} }
      for (const p of pids) { try { kill(p, sig); } catch {} }
    };
    send('SIGTERM', members.map(r => r.pid).filter(p => p !== process.pid), leaderVerified);
    // Before SIGKILL, ps is read again: only members that are still the same processes are signalled (a pid that was reused in
    // the meantime is somebody else's), and the group only while its leader still is the same process.
    killTimer = setTimeoutImpl(async () => {
      killTimer = null;
      const t = await readTable(exec || undefined).catch(() => null);
      if (!t) return;
      const byPid = new Map(t.map(r => [r.pid, r]));
      const still = [...seen].filter(([p, start]) => sameProcess(start, byPid.get(p))).map(([p]) => p).filter(p => p !== process.pid);
      const leaderStill = !!groupPid && leaderVerified && sameProcess(seen.get(groupPid), byPid.get(groupPid)) && byPid.has(groupPid);
      send('SIGKILL', still, leaderStill);
    }, graceMs);
    if (killTimer && killTimer.unref) killTimer.unref();
    try { onStop(stoppedText(limitBytes)); } catch {}
    halt();
  }
  unsub = smp.subscribe(handle);
  async function tick() {
    if (stopped || busy || tripped || !limitBytes) return;
    busy = true;
    try { const table = await smp.read({ fresh: true }); busy = false; handle(table); } finally { busy = false; }
  }
  return { stop, tick };
}

module.exports = { watch, sample, liveMembers, measure, counted, parseTable, readTable, createSampler, shared, stoppedText, INTERVAL_MS, KILL_GRACE_MS };
