'use strict';
// Round 2 of the job memory limit: evidence-based wording, and the final state is saved before the scope is cleared.
// Same rig as job-memory-limit.test.js: a fake spawn, injected systemctl answers; nothing real is started.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { JobRunner } = require('../lib/jobs.js');
const { GB } = require('../lib/mem-limit.js');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'job-mem2-')));
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
const KILLNOTE = 'Note: a process in this job was killed because the computer ran short of memory.';

test('the wrapper records both oom and oom_kill from memory.events (or memory.events.local)', async () => {
  const r = rig();
  const j = await start(r);
  const w = fs.readFileSync(path.join(jdir(r, j), 'wrapper.sh'), 'utf8');
  assert.match(w, /memory\.events memory\.events\.local/);
  assert.match(w, /s\/\^oom \/\/p/);
  assert.match(w, /s\/\^oom_kill \/\/p/);
  assert.match(w, /: > "\$D\/oom"/);
  assert.match(w, /: > "\$D\/oom_kill"/);
});

test('only oom_kill > 0 (no oom): the computer-ran-short wording, not the limit notice', async () => {
  const r = rig();
  const j = await start(r);
  mark(r, j, 'oom_kill'); mark(r, j, 'exit', '1\n');
  await r.runner._tick();
  assert.strictEqual(j.status, 'failed');
  assert.strictEqual(j.memoryKilled, undefined);
  assert.strictEqual(j.note, KILLNOTE);
  assert.ok(!/its limit/.test(r.notes[0].message));
});

test('the limit notice needs oom > 0 or Result oom-kill', async () => {
  const r = rig();
  const j = await start(r);
  mark(r, j, 'oom'); mark(r, j, 'exit', '1\n');
  await r.runner._tick();
  assert.strictEqual(j.memoryKilled, true);
  assert.match(j.note, /^stopped: it used more than 8 GB of memory \(its limit\)/);
});

test('a marker with exit 0 is a finished job; a killed child is mentioned only for oom_kill', async () => {
  const r = rig();
  const j = await start(r);
  mark(r, j, 'oom'); mark(r, j, 'oom_kill'); mark(r, j, 'exit', '0\n');
  await r.runner._tick();
  assert.strictEqual(j.status, 'finished');
  assert.strictEqual(j.memoryKilled, undefined);
  assert.match(j.note, /a process in this job was killed because the computer ran short of memory/);
  assert.match(r.notes[0].message, /finished \(exit 0\)/);
  const r2 = rig();
  const j2 = await start(r2);
  mark(r2, j2, 'oom'); mark(r2, j2, 'exit', '0\n');
  await r2.runner._tick();
  assert.strictEqual(j2.status, 'finished');
  assert.strictEqual(j2.note, undefined);
});

test('exit 0 with scope Result oom-kill is still finished', async () => {
  const r = rig({ scopeResult: async () => 'oom-kill' });
  const j = await start(r);
  mark(r, j, 'exit', '0\n');
  await r.runner._tick();
  assert.strictEqual(j.status, 'finished');
  assert.strictEqual(j.memoryKilled, undefined);
});

test('the Result is read without resetting; the final state is on disk before reset-failed; the oom marker case and a plain finish are cleared too', async () => {
  const seenOnDisk = [];
  const r = rig({
    scopeResult: async () => 'oom-kill',
    resetScope: async (u) => { const f = r.runner.indexFile; seenOnDisk.push([u, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '']); },
  });
  const j = await start(r);
  mark(r, j, 'exit', '137\n');
  await r.runner._tick();
  assert.strictEqual(seenOnDisk.length, 1);
  assert.strictEqual(seenOnDisk[0][0], `${j.unit}.scope`);
  assert.match(seenOnDisk[0][1], /"status":\s*"failed"/, 'the job was saved as failed before its scope was cleared');

  const o2 = [];
  const r2 = rig({ scopeResult: async () => { o2.push('read'); return null; }, resetScope: async () => { o2.push('reset'); } });
  const j2 = await start(r2);
  mark(r2, j2, 'oom'); mark(r2, j2, 'exit', '137\n');
  await r2.runner._tick();
  assert.deepStrictEqual(o2, ['reset'], 'the marker decided: no read, but the scope is cleared');

  const o3 = [];
  const r3 = rig({ resetScope: async (u) => { o3.push(u); } });
  const j3 = await start(r3);
  mark(r3, j3, 'exit', '0\n');
  await r3.runner._tick();
  assert.deepStrictEqual(o3, [`${j3.unit}.scope`]);
});

test('the default scope reader never runs reset-failed itself', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'jobs.js'), 'utf8');
  const a = src.indexOf('function readScopeResult'), b = src.indexOf('/** `systemctl --user reset-failed');
  assert.ok(a > 0 && b > a);
  assert.ok(!/reset-failed/.test(src.slice(a, b)));
});

test('setsid watchdog: the reader gets the same seen-set each tick (reparented pids stay counted)', async () => {
  const sets = [];
  const r = rig({ spawnMode: 'setsid' });
  r.runner.rssBytes = async (pid, seen) => { sets.push(seen); return 0.1 * GB; };
  const j = await start(r);
  mark(r, j, 'pid', String(process.pid));
  await r.runner._tick(); await r.runner._tick();
  assert.ok(sets[0] instanceof Map && sets[0] === sets[1], 'a Map pid -> start time: a reused pid is told apart');
});

test('the setsid reader sums by group and tree through lib/mem-watch, not `ps -g`', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'jobs.js'), 'utf8');
  assert.ok(!/'-g'/.test(src), 'no ps -g');
  assert.match(src, /require\('\.\/mem-watch'\)\.sample/);
});

test('_save returns true only after the rename; the reset queue waits for a successful save', async () => {
  const resets = [];
  const r = rig({ resetScope: async (u) => { resets.push(u); } });
  assert.strictEqual(r.runner._save(), true);
  const good = r.runner.indexFile;
  r.runner.indexFile = path.join(r.dataDir, 'no-such-dir', 'jobs.json');
  assert.strictEqual(r.runner._save(), false, 'a failed write is false');
  r.runner.indexFile = good;
  const j = await start(r);
  mark(r, j, 'exit', '0\n');
  r.runner.indexFile = path.join(r.dataDir, 'no-such-dir', 'jobs.json');   // the save will fail
  await r.runner._tick();
  assert.strictEqual(j.status, 'finished');
  assert.deepStrictEqual(resets, [], 'the final state is not on disk: the scope is not cleared');
  r.runner.indexFile = good;
  await r.runner._tick();   // nothing else changed, but the queued reset still saves first and then clears
  assert.deepStrictEqual(resets, [`${j.unit}.scope`]);
  assert.match(fs.readFileSync(good, 'utf8'), /"status":\s*"finished"/);
  assert.strictEqual(r.runner._resetQueue.length, 0);
});
