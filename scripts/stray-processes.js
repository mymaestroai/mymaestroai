'use strict';
// Finds processes a test run left behind (scripts/run-tests.js). Every process of a run carries HUB_TEST_RUN=<id> in its
// environment, so a leftover is found by reading /proc/<pid>/environ of this user's processes; those are stopped. A leftover
// started with an environment of its own has no marker: one still in the run's cgroup is only named.
// Processes are named by pid and program name (comm) only: a command line can hold a secret passed as an argument.
// Synchronous on purpose: the runner's exit stays a plain process.exit at the end of the file.
const fs = require('fs');
const path = require('path');

const read = (procRoot, pid, file) => fs.readFileSync(path.join(procRoot, String(pid), file), 'utf8');

// Fields after the command name in /proc/<pid>/stat (the name in field 2 may hold spaces and parentheses).
function statFields(procRoot, pid) {
  try { const s = read(procRoot, pid, 'stat'); return s.slice(s.lastIndexOf(')') + 2).split(' '); } catch { return null; }
}
// Field 22 (start time, clock ticks since boot) as a string, or null.
function startTime(procRoot, pid) { const f = statFields(procRoot, pid); return (f && f[19]) || null; }
function isZombie(procRoot, pid) { const f = statFields(procRoot, pid); return !f || f[0] === 'Z'; }
// A process sets its own name: printable ASCII only, so a name cannot carry terminal escapes into the log.
function comm(procRoot, pid) { try { return read(procRoot, pid, 'comm').trim().replace(/[^\x20-\x7e]/g, '?').slice(0, 32); } catch { return '?'; } }

// [{ pid, name, start }] for every process of this user whose environment holds HUB_TEST_RUN=<id>; never this process.
// The start time is read before and after the environment: a process that exited and whose pid was reused in between has a
// different start time and is left out, so the marker and the identity belong to the same process.
function findByMarker(id, { procRoot = '/proc', self = process.pid } = {}) {
  const found = [];
  if (!id) return found;
  const marker = `HUB_TEST_RUN=${id}`;
  let names;
  try { names = fs.readdirSync(procRoot); } catch { return found; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    if (pid === self) continue;
    try {
      if (procRoot === '/proc' && uid !== null && fs.statSync(path.join(procRoot, n)).uid !== uid) continue;
      const before = startTime(procRoot, pid);
      if (!before) continue;
      if (!read(procRoot, pid, 'environ').split('\0').includes(marker)) continue;
      const name = comm(procRoot, pid);
      if (startTime(procRoot, pid) !== before) continue;
      found.push({ pid, name, start: before });
    } catch { /* unreadable or gone: skip quietly */ }
  }
  return found;
}

const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };
const same = (p, procRoot) => startTime(procRoot, p.pid) === p.start && !isZombie(procRoot, p.pid);

// SIGTERM each, wait up to waitMs, SIGKILL those still alive. A pid is signalled only while it still has the start time read at
// the scan. Returns the number of processes signalled with SIGTERM.
function stopAll(list, { procRoot = '/proc', waitMs = 2000, kill = process.kill.bind(process) } = {}) {
  let n = 0;
  for (const p of list) {
    if (!p.start || !same(p, procRoot)) continue;
    try { kill(p.pid, 'SIGTERM'); n++; } catch { /* gone */ }
  }
  const end = Date.now() + waitMs;
  while (list.some((p) => p.start && same(p, procRoot)) && Date.now() < end) pause(50);
  for (const p of list) {
    if (!p.start || !same(p, procRoot)) continue;
    try { kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  return n;
}

// Stops every process carrying the marker, scanning again after each pass: a stray's TERM handler may start a new marked
// process before it exits. At most `passes` passes within `deadlineMs`. Returns { found: every process seen (first sighting),
// stopped: SIGTERMs sent, survivors: marked processes still running at the end }.
function stopMarked(id, { procRoot = '/proc', self = process.pid, passes = 4, deadlineMs = 8000, waitMs = 2000,
  kill = process.kill.bind(process) } = {}) {
  const seen = new Map();
  let stopped = 0;
  const end = Date.now() + deadlineMs;
  let list = findByMarker(id, { procRoot, self });
  for (let i = 0; i < passes && list.length && Date.now() < end; i++) {
    for (const p of list) if (!seen.has(`${p.pid}:${p.start}`)) seen.set(`${p.pid}:${p.start}`, p);
    stopped += stopAll(list, { procRoot, waitMs: Math.max(0, Math.min(waitMs, end - Date.now())), kill });
    pause(100);   // a moment for a killed process's children to appear in /proc
    list = findByMarker(id, { procRoot, self });
  }
  for (const p of list) if (!seen.has(`${p.pid}:${p.start}`)) seen.set(`${p.pid}:${p.start}`, p);
  return { found: [...seen.values()], stopped, survivors: list };
}

// The cgroup path of a process ('' when unreadable): the unified (v2) line "0::<path>".
function cgroupOf(procRoot, pid) {
  try { const l = read(procRoot, pid, 'cgroup').split('\n').find((x) => x.startsWith('0::')); return l ? l.slice(3) : ''; } catch { return ''; }
}

// Processes in the same cgroup as `self`, started at or after `sinceTicks`, that are not `self` or one of its ancestors and
// not in `exclude`: a test may have left them with an environment of its own. Only named, never stopped (outside a hub job the
// cgroup can be a shared session holding other programs). [{ pid, name }]
function findInCgroup(sinceTicks, { procRoot = '/proc', self = process.pid, exclude = [] } = {}) {
  const found = [];
  const mine = cgroupOf(procRoot, self);
  if (!mine || mine === '/' || sinceTicks === null || sinceTicks === undefined) return found;
  const skip = new Set([self, ...exclude.map(Number)]);
  for (let p = self, i = 0; p > 1 && i < 64; i++) {
    const f = statFields(procRoot, p);
    const ppid = f ? Number(f[1]) : 0;
    if (!ppid) break;
    skip.add(ppid); p = ppid;
  }
  let names;
  try { names = fs.readdirSync(procRoot); } catch { return found; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    if (skip.has(pid) || cgroupOf(procRoot, pid) !== mine) continue;
    const st = startTime(procRoot, pid);
    if (st === null || Number(st) < Number(sinceTicks) || isZombie(procRoot, pid)) continue;
    found.push({ pid, name: comm(procRoot, pid) });
  }
  return found;
}

module.exports = { findByMarker, findInCgroup, stopAll, stopMarked, startTime };
