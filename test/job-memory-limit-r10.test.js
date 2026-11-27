'use strict';
// Round 10: (1) a stopping job's members are signalled inside its own probe, right after its fresh read, before any other job's probe
// is awaited (no shared barrier); (2) the SIGKILL grace runs from the moment SIGTERM was actually sent (j.sigtermAt, persisted).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { JobRunner } = require('../lib/jobs.js');
const { GB } = require('../lib/mem-limit.js');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'job-mem10-')));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function mk(dataDir, extra = {}) {
  const spawn = () => { const c = new EventEmitter(); c.unref = () => {}; return c; };
  return new JobRunner({ dataDir, spawnMode: 'setsid', pollMs: 60000, retryMs: 20, log: () => {}, defaultCwd: async () => dataDir, spawn, notify: async () => {}, agentExists: async () => true, memLimit: () => 1 * GB, ...extra });
}

async function stoppingJob(runner, name, rootPid, members, at) {
  const j0 = await runner.run({ owner: 'trader', name, command: 'true' });
  const j = runner.jobs.get(j0.id);
  fs.writeFileSync(path.join(runner.dir, j.id, 'pid'), String(rootPid));
  j.status = 'stopping'; j.stoppingAt = at;
  j.stoppingMembers = members.map(p => ({ pid: p, id: 'id-' + p }));
  return j;
}

test('round 10: job A\'s members are signalled before job B\'s (unresolved) probe finishes', async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'r'));
  const sent = [];
  const t = Date.parse('2026-11-26T12:00:00Z');
  const runner = mk(dataDir, { now: () => t, signal: (p, s) => sent.push([p, s]) });
  const a = await stoppingJob(runner, 'a', 5000, [5001], t);
  const b = await stoppingJob(runner, 'b', 6000, [6001], t);
  let releaseB;
  const gateB = new Promise(r => { releaseB = r; });
  let bStarted = false;
  runner.memberState = async (pid) => {
    if (pid === 6000) { bStarted = true; await gateB; return { count: 1, pids: [6001] }; }
    return { count: 1, pids: [5001] };
  };
  const tick = runner._tick();
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  assert.ok(bStarted, 'B\'s probe is in flight');
  assert.deepStrictEqual(sent, [[5001, 'SIGTERM']], 'A was signalled while B\'s probe is still unresolved');
  releaseB();
  await tick;
  assert.deepStrictEqual(sent, [[5001, 'SIGTERM'], [6001, 'SIGTERM']]);
  assert.ok(a.sigtermAt > 0 && b.sigtermAt > 0);
});

test('round 10: the SIGKILL grace is measured from the first SIGTERM actually sent, and sigtermAt is persisted', async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'r'));
  const sent = [];
  let t = Date.parse('2026-11-26T12:00:00Z');
  const runner = mk(dataDir, { now: () => t, signal: (p, s) => sent.push([p, s]) });
  const live = { n: 0, pids: [] };   // nothing alive to signal for the first 10 s of the stop
  runner.memberState = async () => ({ count: Math.max(live.n, 1), pids: live.pids });
  const j = await stoppingJob(runner, 'a', 5000, [5001], t);
  await runner._tick();
  assert.deepStrictEqual(sent, [], 'nothing to signal yet');
  assert.ok(!(j.sigtermAt > 0), 'no SIGTERM sent, so no sigtermAt');
  t += 10000; live.n = 1; live.pids = [5001];
  await runner._tick();   // 10 s after stoppingAt: the first SIGTERM goes out now, NOT SIGKILL
  assert.deepStrictEqual(sent, [[5001, 'SIGTERM']]);
  assert.strictEqual(j.sigtermAt, t);
  const onDisk = JSON.parse(fs.readFileSync(runner.indexFile, 'utf8')).jobs.find(q => q.id === j.id);
  assert.strictEqual(onDisk.sigtermAt, t, 'persisted');
  sent.length = 0; t += 2000; await runner._tick();
  assert.deepStrictEqual(sent, [[5001, 'SIGTERM']], 'still inside the 3 s grace');
  sent.length = 0; t += 1000; await runner._tick();
  assert.deepStrictEqual(sent, [[5001, 'SIGKILL']], '3 s after the SIGTERM');
});
