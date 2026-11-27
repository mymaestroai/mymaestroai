'use strict';
// lib/mem-watch.js: a best-effort memory watchdog for computers with no systemd user manager (a Mac, or Linux without one).
// With systemd the kernel enforces the limit inside a scope (lib/scope-wrap, lib/jobs.js); here a watcher reads the process
// table every 2 s and stops a process that has grown past the limit.
//
//   parseTable(text)           `ps -A -o pid=,ppid=,pgid=,rss=[,lstart=]` output -> [{ pid, ppid, pgid, rssKb, start }]
//                               (start = the text after the 4 numbers, joined by single spaces, or null)
//   readTable(exec, opts)       the table WITH a process birth identity per row (`start`, an exact string): Linux reads field 22
//                               (starttime, clock ticks) of /proc/<pid>/stat for the pids of the sample (the comm field may hold
//                               spaces and parentheses: split after the last ')'); macOS and the rest use ps's lstart (5 tokens,
//                               kept joined). A ps error, or a row with no identity, makes the sample unusable: null (nothing is
//                               measured, nothing is signalled). A pid that vanished between ps and /proc is simply dropped.
//   counted(table, root, group, seen) -> the rows that count. `seen` is a Map pid -> identity: every member counted before.
//                               A member whose identity is not an exact, non-empty match is a different process (the pid was
//                               reused): it is dropped, never counted, never signalled. Descendants are walked from EVERY
//                               still-verified member, so a process started by a reparented helper is counted too.
//   measure(table, root, group, seen)  -> bytes
//   sample(root, group, seen, exec)    one table read (the shared sampler) + measure -> bytes, or null when ps can't be read
//   createSampler(opts) / shared       ONE `ps -A` run every 2 s for every watcher in the process: it starts with the first
//                               subscriber and stops with the last. read() also serves the jobs fallback (reads inside 1 s
//                               share a table; reads in flight share a run).
//   watch(root, { limitBytes, group, onStop, ... }) -> { stop(), tick() }   past the limit, the group (and every counted
//                               process) gets SIGTERM, 3 s later ps is read again and SIGKILL goes only to members that are still
//                               the same processes (the group only while its leader is). onStop(text) is called once. Once tripped,
//                               the escalation finishes on its own: stop() does not cancel the SIGKILL stage.
//   stoppedText(bytes)          the notice for a person.
//
// RSS sums count shared pages once per process, so the number can read higher than the real use: the limit is applied as is
// and every message says "best effort".
const { execFile } = require('child_process');
const fs = require('fs');
const { gbText } = require('./mem-limit');

const INTERVAL_MS = 2000;
const KILL_GRACE_MS = 3000;
const SHARE_MS = 1000;

function stoppedText(bytes) {
  return `stopped: it used more than ${gbText(bytes)} of memory (best effort, checked every 2 s)`;
}

function parseTable(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\S.*))?$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), rssKb: Number(m[4]), start: m[5] === undefined ? null : m[5].trim().split(/\s+/).join(' ') });
  }
  return out;
}

/** Field 22 of /proc/<pid>/stat (starttime, clock ticks since boot) as a string, or null. The comm field (2) sits in parentheses and
 *  may hold spaces and parentheses itself: everything after the LAST ')' is split, and field 3 (state) is the first of those. */
function procStartTime(statText) {
  const s = String(statText || '');
  const i = s.lastIndexOf(')');
  if (i < 0) return null;
  const f = s.slice(i + 1).trim().split(/\s+/);
  const v = f[19];   // field 22 = index 22 - 3
  return v && /^\d+$/.test(v) ? v : null;
}

/** Is this row still the process remembered as `start`? Only an exact, non-empty identity match is the same process. */
function sameProcess(start, row) {
  return !!row && typeof start === 'string' && start !== '' && row.start === start;
}

/** Which rows count for `root` / `group` right now. `seen` (a Map pid -> start) is updated: gone or different processes leave it. */
function counted(table, root, group, seen = new Map()) {
  const byPid = new Map(table.map(r => [r.pid, r]));
  // table.unreadable (a Set of pids): their /proc/<pid>/stat read failed for a reason other than "gone". Such a pid keeps its saved
  // identity, is not counted or signalled this sample, and makes the live-member count unknown (res.unreadable > 0).
  const unreadable = table.unreadable instanceof Set ? table.unreadable : new Set();
  let unreadableMembers = 0;
  for (const [p, start] of [...seen]) {
    if (unreadable.has(p) && !byPid.has(p)) { unreadableMembers++; continue; }
    if (!sameProcess(start, byPid.get(p))) seen.delete(p);   // gone, or a reused pid
  }
  if (!seen.rootAdded && unreadable.has(root) && !byPid.has(root)) unreadableMembers++;
  const add = (r) => { if (!seen.has(r.pid) && typeof r.start === 'string' && r.start !== '') seen.set(r.pid, r.start); };   // a row with no identity is never counted
  if (!seen.rootAdded) { const r = byPid.get(root); if (r && typeof r.start === 'string' && r.start !== '') { add(r); seen.rootAdded = true; } }
  // the group's rows join while a verified member is in that group (a group id is not reused while one member lives)
  if (group) {
    let held = false;
    for (const p of seen.keys()) { const r = byPid.get(p); if (r && r.pgid === group) { held = true; break; } }
    if (held) for (const r of table) if (r.pgid === group) add(r);
  }
  const byParent = new Map();
  for (const r of table) { if (!byParent.has(r.ppid)) byParent.set(r.ppid, []); byParent.get(r.ppid).push(r.pid); }
  // Only members verified in THIS sample anchor the walk; an unreadable identity stays in `seen` for a retry but anchors nothing.
  const stack = [...seen.keys()].filter(p => sameProcess(seen.get(p), byPid.get(p))), visited = new Set(stack);
  for (let guard = 0; stack.length && guard < 1000000; guard++) {
    const p = stack.pop();
    for (const c of byParent.get(p) || []) {
      if (visited.has(c)) continue;
      visited.add(c); add(byPid.get(c)); stack.push(c);
    }
  }
  const res = table.filter(r => seen.has(r.pid));
  Object.defineProperty(res, 'unreadable', { value: unreadableMembers, enumerable: false });
  return res;
}

function measure(table, root, group, seen = new Map()) {
  let kb = 0;
  for (const r of counted(table, root, group, seen)) kb += r.rssKb;
  return kb * 1024;
}

let pageSizeCache = 0;
const defaultGetconf = () => require('child_process').execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8', timeout: 2000 });
const defaultAuxv = () => fs.readFileSync('/proc/self/auxv');
/** The page size: `getconf PAGESIZE`, else AT_PAGESZ (type 6) from /proc/self/auxv (pairs of native-endian unsigned longs).
 *  null when neither works: no guess is made or cached, the sample is unusable and the next sample retries.
 *  Only the real readers' answer is cached; injected readers (tests) always read fresh. */
function getPageSize({ getconf = null, auxv = null } = {}) {
  const injected = !!(getconf || auxv);
  if (!injected && pageSizeCache) return pageSizeCache;
  const ok = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
  let v = null;
  try { const n = Number(String((getconf || defaultGetconf)()).trim()); if (ok(n)) v = n; } catch {}
  if (v === null) {
    try {
      const buf = Buffer.from((auxv || defaultAuxv)());
      const size = ['ia32', 'arm', 'mips', 'mipsel', 'ppc', 's390'].includes(process.arch) ? 4 : 8;   // unsigned long: 8 bytes on 64-bit
      const le = require('os').endianness() === 'LE';
      const rd = (i) => size === 8 ? Number(le ? buf.readBigUInt64LE(i) : buf.readBigUInt64BE(i)) : (le ? buf.readUInt32LE(i) : buf.readUInt32BE(i));
      for (let i = 0; i + 2 * size <= buf.length; i += 2 * size) {
        const type = rd(i), val = rd(i + size);
        if (type === 0) break;   // AT_NULL
        if (type === 6) { if (ok(val)) v = val; break; }
      }
    } catch {}
  }
  if (v !== null && !injected) pageSizeCache = v;
  return v;
}

const readProcStat = (pid) => fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');

/** The process table with a birth identity on every row, or null (the sample is unusable). opts: { platform, readStat }. */
function readTable(exec = execFile, opts = {}) {
  const platform = opts.platform || process.platform, readStat = opts.readStat || readProcStat;
  const linux = platform === 'linux';
  return new Promise((resolve) => {
    try {
      const cols = linux ? 'pid=,ppid=,pgid=,rss=' : 'pid=,ppid=,pgid=,rss=,lstart=';
      exec('ps', ['-A', '-o', cols], { timeout: 3000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);   // an error from ps: the sample is not trusted
        const rows = parseTable(stdout);
        if (!linux) return resolve(rows.every(r => r.start && r.start.split(' ').length === 5) ? rows : null);   // lstart is 5 tokens; a row without it makes the sample unusable
        // ps only lists pids: every row is built from ONE /proc/<pid>/stat read, so a reused pid can't mix two processes.
        // A vanished pid, or any other read/parse problem for one pid, drops that pid only (never counted, never signalled).
        // No page size (getconf and auxv both unavailable): no guess, the sample is unusable and the next sample retries.
        const pageSize = opts.pageSize || getPageSize(opts.pageReaders || {});
        if (!pageSize) return resolve(null);
        const unreadable = new Set();
        const readRow = async (r) => {
          try {
            const stat = String(await readStat(r.pid));
            // A stat that reads but does not parse (no ')', missing or NaN fields) is unreadable, not vanished: kept for a retry.
            if (stat.lastIndexOf(')') < 0) { unreadable.add(r.pid); return null; }
            const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
            const row = { pid: r.pid, ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19], rssKb: Number(fields[21]) * pageSize / 1024 };
            if (!Number.isFinite(row.ppid) || !Number.isFinite(row.pgid) || !Number.isFinite(row.rssKb) || !/^\d+$/.test(row.start || '')) { unreadable.add(r.pid); return null; }
            return row;
          } catch (e) {
            // ENOENT / ESRCH: the process is gone (dropped). Any other read error (EMFILE, EACCES, EIO...): unreadable, not vanished.
            if (!e || e.code !== 'ENOENT' && e.code !== 'ESRCH') unreadable.add(r.pid);
            return null;
          }
        };
        (async () => {
          const out = [];
          for (let i = 0; i < rows.length; i += 32) out.push(...await Promise.all(rows.slice(i, i + 32).map(readRow)));
          const table = out.filter(Boolean);
          Object.defineProperty(table, 'unreadable', { value: unreadable, enumerable: false });
          return table;
        })().then(resolve, () => resolve(null));
      });
    } catch { resolve(null); }
  });
}

/** One process table reader for everyone. Subscribers get every table the interval reads; the interval runs only while someone is subscribed. */
function createSampler({ exec = execFile, intervalMs = INTERVAL_MS, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, now = Date.now, platform = null, readStat = null, pageSize = null, pageReaders = null } = {}) {
  const subs = new Set();
  let timer = null, inflight = null, last = null;   // last: { at, table }
  function read({ fresh = false } = {}) {
    if (!fresh) {
      if (last && now() - last.at < SHARE_MS) return Promise.resolve(last.table);
      if (inflight) return inflight;
    }
    const at = now();   // taken before the read: a table is never fresher than it claims
    const p = readTable(exec, { platform, readStat, pageSize, pageReaders }).then((table) => { if (table) last = { at, table }; return table; });
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

async function sample(root, group, seen, exec, opts) {
  const table = exec ? await readTable(exec, opts) : await shared.read();
  return table ? measure(table, Number(root), group ? Number(group) : 0, seen) : null;
}

/** How many counted members of `root` / `group` are still alive (null when ps can't be read). */
async function liveMembers(root, group, seen, exec, opts) {
  const table = exec ? await readTable(exec, opts) : await shared.read({ fresh: true });
  if (!table) return null;
  const members = counted(table, Number(root), group ? Number(group) : 0, seen);
  return members.unreadable > 0 ? null : members.length;   // an unreadable member: the count is unknown, never "none left"
}

/** The live count (null: unknown) and the pids to signal, both from ONE fresh table (null when the table can't be read). */
async function memberState(root, group, seen, exec, opts) {
  const table = exec ? await readTable(exec, opts) : await shared.read({ fresh: true });
  if (!table) return null;
  const members = counted(table, Number(root), group ? Number(group) : 0, seen);
  return { count: members.unreadable > 0 ? null : members.length, pids: members.map(r => r.pid) };
}

/** The pids of the counted members that are still the same processes (null when the table can't be read). */
async function memberPids(root, group, seen, exec, opts, fresh = false) {
  const table = exec ? await readTable(exec, opts) : await shared.read({ fresh });
  return table ? counted(table, Number(root), group ? Number(group) : 0, seen).map(r => r.pid) : null;
}

function watch(root, { limitBytes, group = 0, onStop = () => {}, graceMs = KILL_GRACE_MS, exec = null, intervalMs = null,
  kill = (p, s) => process.kill(p, s), setIntervalImpl = null, clearIntervalImpl = null, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, sampler = null, platform = null, readStat = null, pageSize = null } = {}) {
  // Tests pass their own exec / timers: that gets a private sampler; the running hub always uses the one shared sampler.
  const smp = sampler || ((exec || setIntervalImpl || intervalMs) ? createSampler({ ...(exec ? { exec } : {}), ...(setIntervalImpl ? { setIntervalImpl } : {}), ...(clearIntervalImpl ? { clearIntervalImpl } : {}), ...(intervalMs ? { intervalMs } : {}), platform, readStat, pageSize }) : shared);
  const seen = new Map();
  const rootPid = Number(root), groupPid = group ? Number(group) : 0;
  let stopped = false, busy = false, tripped = false, unsub = null, killTimer = null;
  const halt = () => { stopped = true; if (unsub) { unsub(); unsub = null; } };
  // stop() ends the watching. A watchdog that has already tripped finishes its escalation on its own: the pending SIGKILL stage
  // (which re-reads the table and signals only still-verified members) is NOT cancelled, whoever stops the watcher meanwhile.
  const stop = () => { halt(); };
  function handle(table) {
    if (stopped || busy || tripped || !limitBytes || !table) return;
    const members = counted(table, rootPid, groupPid, seen);
    let kb = 0; for (const r of members) kb += r.rssKb;
    if (kb * 1024 <= limitBytes) return;
    tripped = true;
    const leaderVerified = !!groupPid && members.some(r => r.pid === groupPid);   // verified in THIS sample, not merely remembered
    const send = (sig, pids, withGroup) => {
      if (withGroup && groupPid !== process.pid) { try { kill(-groupPid, sig); } catch {} }
      for (const p of pids) { try { kill(p, sig); } catch {} }
    };
    send('SIGTERM', members.map(r => r.pid).filter(p => p !== process.pid), leaderVerified);
    // Before SIGKILL, ps is read again: only members that are still the same processes are signalled (a pid that was reused in
    // the meantime is somebody else's), and the group only while its leader still is the same process.
    // An unusable read, or a saved member that can't be read right now, is retried every RETRY_MS (at most MAX_TRIES reads in all);
    // each try signals only exact current matches. It stops once no saved member is unaccounted for (all vanished, or all read).
    const RETRY_MS = 1000, MAX_TRIES = 10;
    let tries = 0;
    const escalate = async () => {
      killTimer = null;
      tries++;
      const t = await readTable(exec || undefined, { platform, readStat, pageSize }).catch(() => null);
      let retry = !t;
      if (t) {
        const byPid = new Map(t.map(r => [r.pid, r]));
        const still = [...seen].filter(([p, start]) => sameProcess(start, byPid.get(p))).map(([p]) => p).filter(p => p !== process.pid);
        const leaderStill = !!groupPid && leaderVerified && sameProcess(seen.get(groupPid), byPid.get(groupPid)) && byPid.has(groupPid);
        send('SIGKILL', still, leaderStill);
        const unreadable = t.unreadable instanceof Set ? t.unreadable : new Set();
        retry = [...seen.keys()].some(p => unreadable.has(p) && !byPid.has(p));
      }
      if (retry && tries < MAX_TRIES) {
        killTimer = setTimeoutImpl(escalate, RETRY_MS);
        if (killTimer && killTimer.unref) killTimer.unref();
      }
    };
    killTimer = setTimeoutImpl(escalate, graceMs);
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

module.exports = { watch, sample, liveMembers, memberPids, memberState, procStartTime, sameProcess, measure, counted, getPageSize, parseTable, readTable, createSampler, shared, stoppedText, INTERVAL_MS, KILL_GRACE_MS };
