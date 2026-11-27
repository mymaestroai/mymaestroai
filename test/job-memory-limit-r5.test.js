'use strict';
// Round 5: a no-systemd job that the watchdog stopped ('stopping') keeps its verified members (pid + identity) on the record, before anything
// is signalled; after a hub restart those members are waited for and signalled one by one, the root pid is never adopted afresh, and an
// unreadable table is "unknown", never zero. cancel() of a stopping job stays a memory stop.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { JobRunner } = require('../lib/jobs.js');
const mw = require('../lib/mem-watch');
const { GB } = require('../lib/mem-limit.js');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'job-mem5-')));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function mk(dataDir, extra = {}) {
  const spawn = () => { const c = new EventEmitter(); c.unref = () => {}; return c; };
  return new JobRunner({ dataDir, spawnMode: 'setsid', pollMs: 60000, retryMs: 20, log: () => {}, defaultCwd: async () => dataDir, spawn, notify: async () => {}, agentExists: async () => true, memLimit: () => 1 * GB, ...extra });
}
const jdir = (r, j) => path.join(r.dir, j.id);
async function stoppedJob(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'r'));
  const sent = [];
  let t = Date.parse('2026-11-26T12:00:00Z');
  const runner = mk(dataDir, { now: () => t, signal: (p, s) => sent.push([p, s]), ...extra });
  const j0 = await runner.run({ owner: 'trader', name: 'mem', command: 'true' });
  const j = runner.jobs.get(j0.id);
  fs.writeFileSync(path.join(jdir(runner, j), 'pid'), String(process.pid));   // a live pid (this process); _kill is stubbed
  const killed = []; runner._kill = (x) => killed.push(x.id);
  runner.rssBytes = async (pid, seen) => { seen.set(4001, 'id-4001'); seen.set(4002, 'id-4002'); seen.rootAdded = true; return 2 * GB; };
  return { runner, j, dataDir, sent, killed, at: (ms) => { t += ms; }, now: () => t };
}

test('the verified members are on the record BEFORE anything is signalled', async () => {
  const s = await stoppedJob();
  let onDisk = null;
  s.runner._kill = (x) => { s.killed.push(x.id); };
  await s.runner._tick();
  onDisk = JSON.parse(fs.readFileSync(s.runner.indexFile, 'utf8')).jobs.find(q => q.id === s.j.id);
  assert.deepStrictEqual(s.killed, [], 'the over-limit branch itself never group-kills');
  assert.deepStrictEqual(s.sent, [], 'and nothing is signalled before the record is on disk');
  assert.strictEqual(s.j.status, 'stopping');
  assert.ok(onDisk, 'the registry was saved before _kill ran');
  assert.strictEqual(onDisk.status, 'stopping');
  assert.deepStrictEqual(onDisk.stoppingMembers, [{ pid: 4001, id: 'id-4001' }, { pid: 4002, id: 'id-4002' }]);
});

test('after a hub restart the members come back from the record; survivors are signalled one by one (SIGTERM, then SIGKILL after 3 s), never the group or the pid file\'s pid', async () => {
  const s = await stoppedJob();
  await s.runner._tick();
  assert.strictEqual(s.j.status, 'stopping');
  // a new hub: a fresh runner on the same directory, a live count of 2, and the pids that are verified
  const sent = [];
  let t = s.now() + 1000;
  const live = { n: 2 };
  const seenArgs = [];
  const r2 = mk(s.dataDir, { now: () => t, signal: (p, sg) => sent.push([p, sg]), liveMembers: async (pid, seen) => { seenArgs.push([...seen]); return live.n; }, memberPids: async () => [4001, 4002] });
  r2._kill = () => { throw new Error('a stopping job is never group-killed after a restart'); };
  r2._reconcile();   // what start() does at boot
  const j = r2.jobs.get(s.j.id);
  assert.strictEqual(j.status, 'stopping', 'not finished at once by the restart');
  assert.deepStrictEqual(seenArgs, []);
  await r2._tick();
  assert.deepStrictEqual(seenArgs[0], [[4001, 'id-4001'], [4002, 'id-4002']], 'the restored members, with their identities');
  assert.deepStrictEqual(sent, [[4001, 'SIGTERM'], [4002, 'SIGTERM']]);
  assert.strictEqual(j.status, 'stopping');
  sent.length = 0; t += 4000; await r2._tick();   // 5 s after the stop: SIGKILL
  assert.deepStrictEqual(sent, [[4001, 'SIGKILL'], [4002, 'SIGKILL']]);
  live.n = 0; t += 1000; await r2._tick();
  assert.strictEqual(j.status, 'failed');
  assert.strictEqual(j.memoryKilled, true);
  assert.ok(!/still running|could not be checked/.test(j.note));
  assert.strictEqual(j.stoppingMembers, undefined, 'dropped from the record when finished');
});

test('a restored root pid is never adopted afresh: a replacement process under it is not a member', () => {
  const r = mk(fs.mkdtempSync(path.join(TMP, 'r')));
  const j = { id: 'x', stoppingMembers: [{ pid: 100, id: 'old-start' }, { pid: 101, id: 'child-start' }] };
  const seen = r._stoppingSeen(j);
  assert.strictEqual(seen.rootAdded, true);
  const row = (pid, ppid, id) => ({ pid, ppid, pgid: pid, rssKb: 1, start: id });
  // pid 100 now belongs to a replacement (a different identity); 101 is the same child
  const n = mw.counted([row(100, 1, 'new-start'), row(101, 100, 'child-start'), row(300, 100, 'its-child')], 100, 100, seen).map(x => x.pid);
  assert.ok(!n.includes(100), 'the replacement root is not counted (so it is never signalled)');
  assert.ok(n.includes(101));
});

test('an unreadable table (null) or no record of the members is "unknown", never zero: the job stays stopping, then finishes saying it could not be checked', async () => {
  for (const noRecord of [false, true]) {
    const s = await stoppedJob();
    await s.runner._tick();
    const sent = [];
    let t = s.now() + 1000;
    const r2 = mk(s.dataDir, { now: () => t, signal: (p, sg) => sent.push([p, sg]), liveMembers: async () => null, memberPids: async () => null });
    if (noRecord) { const rec = r2.jobs.get(s.j.id); delete rec.stoppingMembers; }
    r2._reconcile();
    const j = r2.jobs.get(s.j.id);
    await r2._tick();
    assert.strictEqual(j.status, 'stopping', 'unknown is not zero: not finished');
    assert.deepStrictEqual(sent, []);
    t += 16000; await r2._tick();
    assert.strictEqual(j.status, 'failed');
    assert.strictEqual(j.memoryKilled, true);
    assert.match(j.note, /could not be checked/);
    assert.ok(!/ 0 process|still running 15 s/.test(j.note), 'never reported as none left, nor as a count');
  }
});

test('cancel() of a stopping job keeps it a memory stop (memoryKilled and the note); cancelAll leaves it alone', async () => {
  const s = await stoppedJob({ liveMembers: async () => 0 });
  await s.runner._tick();
  assert.strictEqual(s.j.status, 'stopping');
  s.killed.length = 0;
  const out = s.runner.cancel(s.j.id);
  assert.strictEqual(s.j.status, 'stopping', 'not turned into "cancelling"');
  assert.deepStrictEqual(s.runner.cancelAll(), []);
  assert.ok(out && out.id === s.j.id);
  await s.runner._tick();
  assert.strictEqual(s.j.status, 'failed');
  assert.strictEqual(s.j.memoryKilled, true);
  assert.match(s.j.note, /Raise the limit in Settings/);
});

test('round 6: a failed save before the stop signals nothing; the job goes back to running and the next poll retries', async () => {
  const s = await stoppedJob();
  const realSave = s.runner._save.bind(s.runner);
  let fail = true;
  s.runner._save = () => (fail ? false : realSave());
  await s.runner._tick();
  assert.strictEqual(s.j.status, 'running', 'rolled back');
  assert.ok(!('stoppingAt' in s.j) && !('stoppingMembers' in s.j), 'the stopping fields are removed');
  assert.deepStrictEqual(s.killed, [], 'nothing signalled');
  assert.deepStrictEqual(s.sent, [], 'nothing signalled');
  fail = false;
  await s.runner._tick();
  assert.strictEqual(s.j.status, 'stopping', 'retried on the next poll');
  assert.deepStrictEqual(s.killed, [], 'never group-killed');
});

test('round 9: a reused wrapper pid (identity mismatch) plus an over-limit detached helper: only the verified helper is signalled, never the replacement pid or its group', async () => {
  const s = await stoppedJob();
  const groupKills = [];
  s.runner._kill = (x) => groupKills.push(x.id);
  const orig = process.kill;
  const rawKills = [];
  // the wrapper (pid file) is now somebody else's process: it is not in the verified set, the helper (4002) is
  s.runner.rssBytes = async (pid, seen) => { seen.set(4002, 'id-4002'); seen.rootAdded = true; return 2 * GB; };
  s.runner.memberState = async (pid, seen) => {
    assert.ok(!seen.has(pid), 'the replacement root pid is not a member');
    return { count: 1, pids: [4002] };
  };
  await s.runner._tick();
  assert.strictEqual(s.j.status, 'stopping');
  assert.deepStrictEqual(groupKills, [], 'no group kill from the pid file');
  assert.deepStrictEqual(s.sent, [], 'nothing signalled in the tick that begins the stop');
  await s.runner._tick();   // the next poll signals the verified members
  assert.deepStrictEqual(s.sent, [[4002, 'SIGTERM']]);
  assert.ok(!s.sent.some(([p]) => p === process.pid || p === -process.pid), 'the replacement pid and its group get nothing');
  assert.deepStrictEqual(rawKills, []);
  assert.strictEqual(process.kill, orig);
});

test('round 7: one member\'s stat read fails once (EMFILE): it is unreadable, not vanished - never signalled that tick, the job is not finished with zero survivors, and the helper is still escalated to SIGKILL', async () => {
  const s = await stoppedJob();
  await s.runner._tick();
  const sent = [];
  let t = s.now() + 1000;
  const pst = (ppid, pgid, start) => `1 (c d) S ${ppid} ${pgid} 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 1 10 1`;
  let failures = 2;   // tick 1's two table reads (the count, then the pids) both hit EMFILE on the helper
  const exec = (cmd, args, o, cb) => cb(null, '4001 1 4001 1\n4002 4001 4001 1\n');
  const readStat = async (pid) => { if (pid === 4002 && failures > 0) { failures--; const e = new Error('too many open files'); e.code = 'EMFILE'; throw e; } return pid === 4001 ? pst(1, 4001, 10) : pst(4001, 4001, 11); };
  const o = { platform: 'linux', pageSize: 4096, readStat };
  const r2 = mk(s.dataDir, { now: () => t, signal: (p, sg) => sent.push([p, sg]),
    liveMembers: (pid, seen) => mw.liveMembers(pid, pid, seen, exec, o), memberPids: (pid, seen) => mw.memberPids(pid, pid, seen, exec, o) });
  r2.jobs.get(s.j.id).stoppingMembers = [{ pid: 4001, id: '10' }, { pid: 4002, id: '11' }];
  r2._reconcile();
  const j = r2.jobs.get(s.j.id);
  await r2._tick();
  assert.strictEqual(j.status, 'stopping', 'an unreadable member: the count is unknown, not zero');
  assert.deepStrictEqual(sent, [[4001, 'SIGTERM']], 'the unreadable helper is not signalled this tick');
  sent.length = 0; t += 4000; await r2._tick();   // the helper reads fine now, still alive: escalated
  assert.deepStrictEqual(sent, [[4001, 'SIGKILL'], [4002, 'SIGKILL']], 'its saved identity was kept, so it is signalled once readable');
  assert.strictEqual(j.status, 'stopping');
});

test('round 8: a stopping job takes its live count AND the pids to signal from ONE fresh table (one memberState call per poll)', async () => {
  const s = await stoppedJob();
  await s.runner._tick();
  const sent = [];
  let t = s.now() + 1000, calls = 0;
  const boom = () => { throw new Error('the two separate reads must not be used'); };
  const r2 = mk(s.dataDir, { now: () => t, signal: (p, sg) => sent.push([p, sg]), liveMembers: boom, memberPids: boom,
    memberState: async () => { calls++; return { count: 2, pids: [4001, 4002] }; } });
  r2._kill = () => { throw new Error('never group-killed after a restart'); };
  r2._reconcile();
  await r2._tick();
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(sent, [[4001, 'SIGTERM'], [4002, 'SIGTERM']]);
});
