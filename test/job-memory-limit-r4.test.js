'use strict';
// Round 4: a real OOM kill makes systemd stop the whole scope, so the wrapper ends with exit 143 (its TERM trap), not 137.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { JobRunner } = require('../lib/jobs.js');
const { GB } = require('../lib/mem-limit.js');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'job-mem4-')));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function rig(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'r'));
  const spawn = () => { const c = new EventEmitter(); c.unref = () => {}; return c; };
  const notes = [];
  const runner = new JobRunner({
    dataDir, spawnMode: 'systemd', pollMs: 50, retryMs: 20, log: () => {}, defaultCwd: async () => dataDir, spawn,
    notify: async (agent, message) => { notes.push({ agent, message }); },
    memLimit: () => 8 * GB, scopePeak: async () => 8 * GB, liveMembers: async () => 0, ...extra,
  });
  return { runner, dataDir, notes };
}
const start = async (r) => { const j = await r.runner.run({ owner: 'trader', name: 'mem', command: 'true' }); return r.runner.jobs.get(j.id); };
const jdir = (r, j) => path.join(r.dataDir, 'jobs', j.id);
const mark = (r, j, name, body = '') => fs.writeFileSync(path.join(jdir(r, j), name), body);

test('exit 143 + Result oom-kill + the oom mark -> the limit notice (the peak plays no part)', async () => {
  const r = rig({ scopeResult: async () => 'oom-kill' });
  const j = await start(r);
  mark(r, j, 'oom'); mark(r, j, 'exit', '143\n');
  await r.runner._tick();
  assert.strictEqual(j.status, 'failed');
  assert.strictEqual(j.memoryKilled, true);
  assert.match(j.note, /its limit/);
});

test('exit 143 + the oom marker -> the limit notice', async () => {
  const r = rig();
  const j = await start(r);
  mark(r, j, 'oom'); mark(r, j, 'exit', '143\n');
  await r.runner._tick();
  assert.strictEqual(j.memoryKilled, true);
});

test('exit 143 + Result oom-kill without the oom mark is not the limit notice', async () => {
  const r = rig({ scopeResult: async () => 'oom-kill' });
  const j = await start(r);
  mark(r, j, 'exit', '143\n');
  await r.runner._tick();
  assert.strictEqual(j.status, 'failed');
  assert.strictEqual(j.memoryKilled, undefined);
});

test('exit 143 from a cancel stays cancelled', async () => {
  const r = rig({ scopeResult: async () => 'oom-kill' });
  const j = await start(r);
  j.status = 'cancelling';
  mark(r, j, 'exit', '143\n');
  await r.runner._tick();
  assert.strictEqual(j.status, 'cancelled');
  assert.strictEqual(j.memoryKilled, undefined);
});

test('the wrapper TERM trap reads memory.events and marks oom before the exit file', async () => {
  const r = rig();
  const j = await start(r);
  const w = fs.readFileSync(path.join(jdir(r, j), 'wrapper.sh'), 'utf8');
  const trap = w.split('\n').find(l => /^trap '.*' TERM$/.test(l));
  assert.ok(trap);
  assert.match(trap, /memory\.events/);
  assert.match(trap, /: > "\$D\/oom"/);
  assert.ok(trap.indexOf('/oom"') < trap.indexOf('echo 143'));
});

test('a stopping job is listed as running with stopping: true', async () => {
  const r = rig();
  const j = await start(r);
  j.status = 'stopping';
  const row = r.runner.list(null).find(x => x.id === j.id);
  assert.strictEqual(row.status, 'running');
  assert.strictEqual(row.stopping, true);
});
