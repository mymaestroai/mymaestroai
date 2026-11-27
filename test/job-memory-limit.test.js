'use strict';
// Memory limit for background jobs (lib/mem-limit + lib/jobs.js): the scope properties on the systemd-run argv, how a memory kill is
// read (wrapper marker, scope Result), and the watchdog that stands in for the kernel where there is no systemd.
// Nothing real is started: a fake spawn records the argv, ps and systemctl answers are injected.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { JobRunner } = require('../lib/jobs.js');
const { GB, scopeProps } = require('../lib/mem-limit.js');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'job-mem-')));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function rig(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'r'));
  const calls = [];
  const spawn = (file, args, opts) => { calls.push({ file, args, opts }); const c = new EventEmitter(); c.unref = () => {}; return c; };
  const notes = [];
  const runner = new JobRunner({
    dataDir, spawnMode: 'systemd', pollMs: 50, retryMs: 20, log: () => {}, defaultCwd: async () => dataDir, spawn,
    notify: async (agent, message) => { notes.push({ agent, message }); },
    memLimit: () => 8 * GB, scopePeak: async () => null, liveMembers: async () => 0, ...extra,
  });
  return { runner, calls, dataDir, notes };
}
const start = async (r, over = {}) => {
  const j = await r.runner.run({ owner: 'trader', name: 'mem', command: 'true', ...over });
  return r.runner.jobs.get(j.id);
};
const jdir = (r, j) => path.join(r.dataDir, 'jobs', j.id);
const props = (args) => args.filter((a, i) => args[i - 1] === '-p');
const NOTE8 = 'stopped: it used more than 8 GB of memory (its limit). Raise the limit in Settings or make the job use less.';

test('systemd argv carries MemoryMax/MemoryHigh/MemorySwapMax for the configured limit (no OOMScoreAdjust: scopes refuse it)', async () => {
  const r = rig({ memLimit: () => 8 * GB });
  const j = await start(r);
  const a = r.calls[0].args;
  assert.deepStrictEqual(props(a), scopeProps(8 * GB).filter((x) => x !== '-p'));
  assert.ok(props(a).includes(`MemoryMax=${8 * GB}`) && props(a).includes('MemorySwapMax=0') && !props(a).some((p) => p.startsWith('OOMScoreAdjust')));
  assert.ok(!props(a).some((p) => p.startsWith('MemoryHigh=')), 'no MemoryHigh: it only throttles');
  assert.ok(a.indexOf('setsid') > a.lastIndexOf('-p'), 'properties come before `setsid bash <wrapper>`');
  assert.ok(!a.includes('--collect'), 'host jobs keep their failed scope until the Result is read');
  assert.strictEqual(j.memLimitBytes, 8 * GB);
});

test('the automatic limit (mem-limit.limitBytes) reaches the argv and the job record', async () => {
  const { limitBytes } = require('../lib/mem-limit.js');
  const want = limitBytes({ getSetting: () => null, total: 100 * GB });   // a quarter: 25 GB
  const r = rig({ memLimit: () => limitBytes({ getSetting: () => null, total: 100 * GB }) });
  const j = await start(r);
  assert.strictEqual(want, 25 * GB);
  assert.ok(props(r.calls[0].args).includes(`MemoryMax=${25 * GB}`));
  assert.strictEqual(j.memLimitBytes, 25 * GB);
});

test('limit 0 means no Memory* properties at all', async () => {
  const r = rig({ memLimit: () => null });
  const j = await start(r);
  assert.deepStrictEqual(props(r.calls[0].args), []);
  assert.strictEqual(j.memLimitBytes, undefined);
});

test('the setting is read at each job start', async () => {
  let v = 2 * GB;
  const r = rig({ memLimit: () => v });
  await start(r); v = 3 * GB; await start(r);
  assert.ok(props(r.calls[0].args).includes(`MemoryMax=${2 * GB}`));
  assert.ok(props(r.calls[1].args).includes(`MemoryMax=${3 * GB}`));
});

test('the wrapper reads its own cgroup memory.events and marks oom before the exit file (systemd mode)', async () => {
  const r = rig();
  const j = await start(r);
  const w = fs.readFileSync(path.join(jdir(r, j), 'wrapper.sh'), 'utf8');
  assert.match(w, /cut -d: -f3 \/proc\/self\/cgroup/);
  assert.match(w, /memory\.events/);
  assert.match(w, /oom_kill/);
  assert.ok(w.indexOf('oom_kill') < w.lastIndexOf('exit.tmp" && mv'), 'the marker comes before the exit file');
});

test('setsid mode: the wrapper has no cgroup read (it would see the hub\'s own cgroup)', async () => {
  const r = rig({ spawnMode: 'setsid' });
  const j = await start(r);
  assert.ok(!/memory\.events/.test(fs.readFileSync(path.join(jdir(r, j), 'wrapper.sh'), 'utf8')));
});

test('an oom marker turns the end into the memory notice', async () => {
  const r = rig();
  const j = await start(r);
  fs.writeFileSync(path.join(jdir(r, j), 'oom'), '');
  fs.writeFileSync(path.join(jdir(r, j), 'exit'), '137\n');
  await r.runner._tick();
  assert.strictEqual(j.status, 'failed');
  assert.strictEqual(j.exitCode, 137);
  assert.strictEqual(j.memoryKilled, true);
  assert.strictEqual(j.note, NOTE8);
  const m = r.notes[0].message;
  assert.match(m, /was STOPPED: it used too much memory/);
  assert.ok(m.includes(NOTE8));
  assert.ok(!/FAILED \(exit/.test(m));
  assert.match(r.runner.reportMessage(j, 'x'), /was STOPPED: it used too much memory/);
});

test('exit 137 with scope Result oom-kill gives the notice', async () => {
  const asked = [];
  const r = rig({ scopeResult: async (u) => { asked.push(u); return 'oom-kill'; }, scopePeak: async () => 8 * GB });
  const j = await start(r);
  fs.writeFileSync(path.join(jdir(r, j), 'exit'), '137\n');
  await r.runner._tick();
  assert.deepStrictEqual(asked, [`${j.unit}.scope`]);
  assert.strictEqual(j.memoryKilled, true);
  assert.strictEqual(j.exitCode, 137);
  assert.strictEqual(j.note, NOTE8);
});

test('a job that ends with no exit file and Result oom-kill gets the notice (not LOST) when the scope peaked at its limit', async () => {
  const r = rig({ scopeResult: async () => 'oom-kill', scopePeak: async () => 0.96 * 8 * GB });
  const j = await start(r);
  Object.assign(j, { _childExited: true, _childCode: 0 });
  fs.writeFileSync(path.join(jdir(r, j), 'pid'), String(require('child_process').spawnSync('true').pid));   // a dead pid
  await r.runner._tick();
  assert.strictEqual(j.status, 'failed');
  assert.strictEqual(j.memoryKilled, true);
  assert.strictEqual(j.note, NOTE8);
});

test('Result oom-kill alone is not proof of this job\'s limit: a low MemoryPeak (or none) gets the neutral wording, in the heading too', async () => {
  const NEUTRAL = 'Note: a process in this job was killed because the computer ran short of memory.';
  for (const peak of [0.3 * 8 * GB, null, 0.94 * 8 * GB]) {
    const r = rig({ scopeResult: async () => 'oom-kill', scopePeak: async () => peak });
    const j = await start(r);
    fs.writeFileSync(path.join(jdir(r, j), 'exit'), '137\n');
    await r.runner._tick();
    assert.strictEqual(j.status, 'failed');
    assert.strictEqual(j.memoryKilled, undefined, `peak ${peak}`);
    assert.strictEqual(j.note, NEUTRAL);
    assert.ok(!/its limit|too much memory/.test(r.notes[0].message), 'no limit claim in the completion heading or note');
    assert.match(r.notes[0].message, /FAILED \(exit 137\)/);
    assert.match(r.notes[0].message, /ran short of memory/);
    assert.ok(!/STOPPED/.test(r.runner.reportMessage(j, 'ok')), 'nor in the report heading');
  }
  // the wrapper's own `oom` mark (memory.events oom > 0) still proves the limit, whatever the peak says
  const r = rig({ scopeResult: async () => 'oom-kill', scopePeak: async () => null });
  const j = await start(r);
  fs.writeFileSync(path.join(jdir(r, j), 'oom'), ''); fs.writeFileSync(path.join(jdir(r, j), 'exit'), '137\n');
  await r.runner._tick();
  assert.strictEqual(j.memoryKilled, true);
});

test('the default peak reader asks systemctl for MemoryPeak with the Result (source check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'jobs.js'), 'utf8');
  assert.match(src, /'show', unit, '-p', 'MemoryPeak', '--value'/);
});

test('plain 137 without oom (scope Result success) is an ordinary FAILED (exit 137)', async () => {
  const r = rig({ scopeResult: async () => 'success' });
  const j = await start(r);
  fs.writeFileSync(path.join(jdir(r, j), 'exit'), '137\n');
  await r.runner._tick();
  assert.strictEqual(j.status, 'failed');
  assert.strictEqual(j.exitCode, 137);
  assert.strictEqual(j.memoryKilled, undefined);
  assert.strictEqual(j.note, undefined);
  assert.match(r.notes[0].message, /FAILED \(exit 137\)/);
});

// ── setsid mode: the watchdog ────────────────────────────────────────
function watchRig(rssOf, extra = {}) {
  const r = rig({ spawnMode: 'setsid', memLimit: () => 1 * GB, ...extra });
  const asked = [];
  r.runner.rssBytes = async (pgid) => { asked.push(pgid); return rssOf(pgid); };
  r.asked = asked;
  return r;
}
async function running(r) {
  const j = await start(r);
  fs.writeFileSync(path.join(jdir(r, j), 'pid'), String(process.pid));   // a live pid (this process); _kill is stubbed
  r.killed = [];
  r.runner._kill = (x) => { r.killed.push(x.id); };
  return j;
}

test('setsid-mode watchdog stops an over-limit job with the notice', async () => {
  const r = watchRig(() => 2 * GB);
  const j = await running(r);
  await r.runner._tick();
  assert.deepStrictEqual(r.killed, [j.id]);
  assert.strictEqual(j.status, 'stopping', 'stopped, but not finished until its processes have exited');
  await r.runner._tick();   // liveMembers says 0 (the rig default): now it is finished
  assert.strictEqual(j.status, 'failed');
  assert.strictEqual(j.memoryKilled, true);
  assert.strictEqual(j.note, 'stopped: it used more than 1 GB of memory (best effort, checked every few seconds). Raise the limit in Settings or make the job use less.');
  assert.strictEqual(r.asked.length, 1, 'ps once per tick per job');
  assert.deepStrictEqual(r.asked, [process.pid]);
});

test('setsid-mode watchdog: the job stays stopping while counted processes live, and survivors after 15 s are named', async () => {
  let t = Date.parse('2026-11-26T12:00:00Z'), alive = 2;
  const r = watchRig(() => 2 * GB, { now: () => t, liveMembers: async () => alive });
  const j = await running(r);
  await r.runner._tick();
  assert.strictEqual(j.status, 'stopping');
  assert.strictEqual(r.notes.length, 0, 'no completion notice yet');
  t += 5000; await r.runner._tick();
  assert.strictEqual(j.status, 'stopping', '2 processes still alive');
  alive = 1; t += 5000; await r.runner._tick();
  assert.strictEqual(j.status, 'stopping');
  t += 6000; await r.runner._tick();   // 16 s after the stop, one still alive
  assert.strictEqual(j.status, 'failed');
  assert.strictEqual(j.memoryKilled, true);
  assert.match(j.note, /1 process of it was still running 15 s after the stop/);
  // and a job whose members exit finishes without that note
  alive = 2; t = Date.parse('2026-11-26T13:00:00Z');
  const r2 = watchRig(() => 2 * GB, { now: () => t, liveMembers: async () => alive });
  const k = await running(r2);
  await r2.runner._tick();
  alive = 0; t += 3000; await r2.runner._tick();
  assert.strictEqual(k.status, 'failed');
  assert.ok(!/still running/.test(k.note));
});

test('setsid-mode watchdog leaves an under-limit job alone', async () => {
  const r = watchRig(() => 0.5 * GB);
  const j = await running(r);
  await r.runner._tick(); await r.runner._tick();
  assert.deepStrictEqual(r.killed, []);
  assert.strictEqual(j.status, 'running');
  assert.strictEqual(r.asked.length, 2);
});

test('no limit (0): no watchdog reading at all', async () => {
  const r = watchRig(() => 99 * GB, { memLimit: () => null });
  const j = await running(r);
  await r.runner._tick();
  assert.deepStrictEqual(r.asked, []);
  assert.strictEqual(j.status, 'running');
});

test('systemd-mode jobs are never watched (the kernel does it)', async () => {
  const r = rig({ memLimit: () => 1 * GB });
  const asked = []; r.runner.rssBytes = async (p) => { asked.push(p); return 9 * GB; };
  const j = await start(r);
  fs.writeFileSync(path.join(jdir(r, j), 'pid'), String(process.pid));
  r.runner._kill = () => { throw new Error('must not kill'); };
  await r.runner._tick();
  assert.deepStrictEqual(asked, []);
  assert.strictEqual(j.status, 'running');
});

test('boxed jobs get no properties and no watchdog', async () => {
  const r = rig({ boxFor: async () => ({ name: 'box1', mounts: [TMP] }), memLimit: () => 1 * GB });
  const asked = []; r.runner.rssBytes = async (p) => { asked.push(p); return 9 * GB; };
  const j = await start(r, { cwd: TMP });
  assert.deepStrictEqual(props(r.calls[0].args), []);
  assert.ok(!r.calls[0].args.includes('-p'));
  assert.strictEqual(j.memLimitBytes, undefined);
  const w = fs.readFileSync(path.join(jdir(r, j), 'wrapper.sh'), 'utf8');
  assert.ok(!/memory\.events/.test(w));
  fs.writeFileSync(path.join(jdir(r, j), 'pid'), String(process.pid));
  await r.runner._tick();
  assert.deepStrictEqual(asked, []);
  assert.strictEqual(j.status, 'running');
});

test('boxed job in setsid mode: no watchdog either', async () => {
  const r = rig({ spawnMode: 'setsid', boxFor: async () => ({ name: 'box1', mounts: [TMP] }), memLimit: () => 1 * GB });
  const asked = []; r.runner.rssBytes = async (p) => { asked.push(p); return 9 * GB; };
  const j = await start(r, { cwd: TMP });
  fs.writeFileSync(path.join(jdir(r, j), 'pid'), String(process.pid));
  await r.runner._tick();
  assert.deepStrictEqual(asked, []);
  assert.strictEqual(j.status, 'running');
});
