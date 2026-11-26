'use strict';
// A restart confirmation covers exactly the jobs it named; after an accepted restart no new job starts; the scope probe retry and
// the linger read never block your Maestro (asynchronous, one shared in-flight probe, linger cached for 10 minutes).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const J = require('../lib/jobs');
const { JobRunner, restartGate } = J;
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function mk(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-jobs-rc-'));
  const runner = new JobRunner({ dataDir, spawnMode: 'setsid', pollMs: 60000, log: () => {}, defaultCwd: async () => dataDir, notify: async () => {}, agentExists: async () => true, ...extra });
  return { runner, dataDir };
}
const fakeJob = (r, o) => { r.jobs.set(o.id, { id: o.id, name: o.name || 'backup', owner: 'owner', reportTo: null, command: 'true', cwd: '/', timeoutMinutes: 5, status: 'running', startedAt: new Date().toISOString(), endedAt: null, exitCode: null, mode: o.mode || 'setsid', unit: `hub-job-${o.id}`, box: null }); };
const later = (ms) => new Promise((r) => setTimeout(r, ms));

describe('J1: a restart confirmation covers exactly the jobs it named', () => {
  it('confirm with the shown ids restarts (order does not matter)', () => {
    const { runner } = mk();
    fakeJob(runner, { id: 'aaaa1111' }); fakeJob(runner, { id: 'bbbb2222' });
    const g = restartGate(runner, {});
    assert.equal(g.needsConfirm, true);
    assert.equal(restartGate(runner, { confirm: true, jobs: g.jobs.map((j) => j.id) }), null);
    assert.equal(restartGate(runner, { confirm: true, jobs: ['bbbb2222', 'aaaa1111'] }), null);
  });
  it('a job that started between the 409 and the confirm gives a fresh 409 naming it', () => {
    const { runner } = mk();
    fakeJob(runner, { id: 'aaaa1111', name: 'first' });
    const shown = restartGate(runner, {}).jobs.map((j) => j.id);
    fakeJob(runner, { id: 'cccc3333', name: 'newcomer' });
    const g = restartGate(runner, { confirm: true, jobs: shown });
    assert.ok(g, 'not restarted');
    assert.equal(g.status, 'confirm'); assert.equal(g.needsConfirm, true);
    assert.deepEqual(g.jobs.map((j) => j.id).sort(), ['aaaa1111', 'cccc3333']);
    assert.match(g.message, /newcomer/);
  });
  it('a confirmed set that names a job that is not running (and one that is) is a fresh 409', () => {
    const { runner } = mk();
    fakeJob(runner, { id: 'aaaa1111' });
    assert.ok(restartGate(runner, { confirm: true, jobs: ['aaaa1111', 'zzzz9999'] }));
    assert.ok(restartGate(runner, { confirm: true, jobs: [] }));
  });
  it('{ confirm: true } without jobs works only when no unprotected job is running', () => {
    const { runner } = mk();
    assert.equal(restartGate(runner, { confirm: true }), null, 'idle');
    fakeJob(runner, { id: 'sys00001', mode: 'systemd' });
    assert.equal(restartGate(runner, { confirm: true }), null, 'only protected jobs');
    fakeJob(runner, { id: 'bbbb2222' });
    assert.ok(restartGate(runner, { confirm: true }), 'an unprotected job is running');
    assert.ok(restartGate(runner, { confirm: true, jobs: 'bbbb2222' }), 'jobs must be a list');
    assert.ok(restartGate(runner, { confirm: 'true', jobs: ['bbbb2222'] }), 'only a real true confirms');
  });
  it('after an accepted restart new jobs are refused with the plain message', async () => {
    const { runner } = mk();
    runner.refuseNewJobs();
    await assert.rejects(() => runner.run({ owner: 'owner', name: 'late', command: 'true' }), (e) => e.message === 'Your Maestro is restarting; start it again in a minute.');
    assert.equal(runner.list(null).length, 0);
    runner.allowNewJobs();   // a restart that could not be started lets jobs begin again
    const j = await runner.run({ owner: 'owner', name: 'again', command: 'true' });
    assert.ok(j.id);
    runner.stop();
  });
  it('server.js gates, then refuses new jobs, then restarts; both pages send the ids they showed', () => {
    const s = read('server.js');
    const i = s.indexOf("pathname === '/api/restart' && req.method === 'POST'");
    const block = s.slice(i, s.indexOf("'/api/restart/log'", i));
    const a = block.indexOf('restartGate'), b = block.indexOf('refuseNewJobs'), c = block.indexOf('requestRestart');
    assert.ok(a > 0 && a < b && b < c, 'gate, refuse, restart in that order');
    assert.match(block, /allowNewJobs/, 'a restart that fails lets jobs start again');
    assert.match(block, /armRestartFallback\(getJobRunner\(\), attempt\)/, 'a restart that never exits does not refuse jobs for good (that attempt only, after 10 minutes)');
    assert.doesNotMatch(block, /120000/, 'no 2-minute timer');
    assert.match(block, /refuseNewJobs\(attempt\)/, 'admission is tied to this attempt');
    assert.match(block, /allowNewJobs\(attempt\)/, 'a failed attempt re-opens only itself');
    for (const f of ['app.js', 'mobile.js']) {
      const src = read(f);
      assert.match(src, /confirm: true, jobs: \(d\.jobs \|\| \[\]\)\.map\(/, `${f} sends the ids it showed`);
    }
  });
});

describe('R1: job admission is tied to the restart attempt', () => {
  const jobsStart = async (runner) => { try { const j = await runner.run({ owner: 'owner', name: 'x', command: 'true' }); return !!j.id; } catch (e) { return false; } };
  it('an earlier attempt never re-opens a later one', async () => {
    const { runner } = mk();
    runner.refuseNewJobs('first');
    runner.refuseNewJobs('second');   // a later accepted restart
    assert.equal(runner.allowNewJobs('first'), false);
    assert.equal(await jobsStart(runner), false, 'still refused for the later attempt');
    assert.equal(runner.allowNewJobs('second'), true);
    assert.equal(await jobsStart(runner), true);
    runner.stop();
  });
  it('a failed attempt re-opens its own admission', async () => {
    const { runner } = mk();
    runner.refuseNewJobs('only');
    assert.equal(await jobsStart(runner), false);
    assert.equal(runner.allowNewJobs('only'), true);
    assert.equal(await jobsStart(runner), true);
    runner.stop();
  });
  it('the 10-minute fallback re-opens only its own attempt (unref\'d)', async () => {
    assert.equal(J.RESTART_FALLBACK_MS, 10 * 60 * 1000);
    const { runner } = mk();
    runner.refuseNewJobs('a1');
    const t1 = J.armRestartFallback(runner, 'a1', 20);
    assert.equal(typeof t1.hasRef, 'function'); assert.equal(t1.hasRef(), false, 'does not keep the process alive');
    runner.refuseNewJobs('a2');   // another restart is accepted before a1's timer fires
    await later(60);
    assert.equal(await jobsStart(runner), false, 'a1\'s timer did not re-open a2');
    runner.refuseNewJobs('a3');
    const t3 = J.armRestartFallback(runner, 'a3', 20);
    await later(60);
    assert.equal(await jobsStart(runner), true, 'a3\'s own timer re-opened a3');
    clearTimeout(t3);
    runner.stop();
  });
  it('the error path of server.js passes the attempt', () => {
    const s = read('server.js');
    const i = s.indexOf("pathname === '/api/restart' && req.method === 'POST'");
    const block = s.slice(i, s.indexOf("'/api/restart/log'", i));
    assert.match(block, /if \(r\.error\) \{ getJobRunner\(\)\.allowNewJobs\(attempt\);/);
  });
});

describe('J2: probes never block your Maestro', () => {
  it('concurrent retries share one probe; the answer lands for the next job', async () => {
    let t = 1000; let asked = 0; let release;
    const { runner } = mk({ spawnMode: 'auto', now: () => t, probeBackoffMs: 10, probe: () => 'setsid',
      probeAsync: () => { asked++; return new Promise((res) => { release = () => res('systemd'); }); } });
    assert.equal(runner.mode(), 'setsid');
    t += 100;
    const t0 = Date.now();
    assert.equal(runner.mode({ retry: true }), 'setsid', 'returns the current mode at once');
    assert.equal(runner.mode({ retry: true }), 'setsid');
    const p1 = runner.retryProbe(); const p2 = runner.retryProbe();
    assert.equal(p1, p2, 'callers wait on the same promise');
    assert.ok(Date.now() - t0 < 500);
    assert.equal(asked, 1);
    release(); await p1;
    assert.equal(runner.mode(), 'systemd');
    assert.equal(asked, 1);
    t += 99999;
    runner.mode({ retry: true });
    assert.equal(asked, 1, 'a success is never probed again');
  });
  it('the job start does not wait for the retry; the next job uses its answer', async () => {
    let t = 0; let release; let asked = 0;
    const { runner } = mk({ spawnMode: 'auto', now: () => t, probeBackoffMs: 10, probe: () => 'setsid',
      probeAsync: () => { asked++; return new Promise((res) => { release = () => res('setsid'); }); } });
    runner.mode(); t += 100;
    const t0 = Date.now();
    const j = await runner.run({ owner: 'owner', name: 'quick', command: 'true' });
    assert.ok(Date.now() - t0 < 2000, 'did not wait for the probe');
    assert.equal(j.mode, 'setsid');
    assert.equal(asked, 1, 'the retry was started in the background');
    release(); await runner.retryProbe(); runner.stop();
    await later(50);
  });
  it('a failing or throwing retry probe keeps the current mode', async () => {
    let t = 0;
    const { runner } = mk({ spawnMode: 'auto', now: () => t, probeBackoffMs: 10, probe: () => 'setsid', probeAsync: () => Promise.reject(new Error('boom')) });
    runner.mode(); t += 100;
    runner.mode({ retry: true }); await runner.retryProbe();
    assert.equal(runner.mode(), 'setsid');
  });
  it('the real async probe and linger read run through execFile with a timeout, never spawnSync', async () => {
    const calls = [];
    const fake = (cmd, args, opts, cb) => { calls.push({ cmd, args, opts }); if (cmd === 'loginctl') cb(null, 'Linger=no\n', ''); else cb(new Error('no bus')); return {}; };
    assert.equal(typeof J.detectSpawnModeAsync, 'function');
    assert.equal(typeof J.lingerStateAsync, 'function');
    assert.equal(await J.detectSpawnModeAsync({ env: {}, uid: 5, exists: () => true, execFile: (c, a, o, cb) => { calls.push({ cmd: c, args: a, opts: o }); cb(null); return {}; } }), 'systemd');
    assert.equal(await J.detectSpawnModeAsync({ env: {}, exists: () => false, execFile: fake }), 'setsid');
    assert.equal(await J.lingerStateAsync('sam', fake), 'no');
    for (const c of calls) assert.ok(c.opts && c.opts.timeout > 0, `${c.cmd} has a timeout`);
    assert.equal(calls[0].opts.env.XDG_RUNTIME_DIR, '/run/user/5');
    assert.deepEqual(calls.find((c) => c.cmd === 'loginctl').args, ['show-user', 'sam', '-p', 'Linger']);
    assert.equal(await J.lingerStateAsync('sam', (c, a, o, cb) => { cb(new Error('x')); return {}; }), null);
    assert.equal(await J.lingerStateAsync('sam', (c, a, o, cb) => { cb(null, 'garbage', ''); return {}; }), null);
  });
  it('readiness uses the last known answers, kicks one refresh, and caches the linger answer for 10 minutes', async () => {
    let t = 0; let lingerAsked = 0; let release;
    const { runner } = mk({ spawnMode: 'auto', now: () => t, probe: () => 'setsid', probeBackoffMs: 1e9,
      lingerAsync: () => { lingerAsked++; return new Promise((res) => { release = () => res('no'); }); } });
    runner.mode();
    const first = runner.readinessItems({ user: 'sam', platform: 'linux' });
    assert.equal(first.length, 1, 'answers at once with what is known');
    runner.readinessItems({ user: 'sam', platform: 'linux' });
    assert.equal(lingerAsked, 1, 'one refresh in flight, shared');
    release(); await runner.refreshLinger('sam');
    const known = runner.readinessItems({ user: 'sam', platform: 'linux' });
    assert.match(known[0].fix, /enable-linger sam/);
    t += 9 * 60 * 1000; runner.readinessItems({ user: 'sam', platform: 'linux' });
    assert.equal(lingerAsked, 1, 'cached inside 10 minutes');
    t += 2 * 60 * 1000; runner.readinessItems({ user: 'sam', platform: 'linux' });
    assert.equal(lingerAsked, 2, 'asked again after 10 minutes');
    assert.match(runner.readinessItems({ user: 'sam', platform: 'linux' })[0].fix, /enable-linger sam/, 'the old answer stands while it refreshes');
    release();
  });
  it('readiness, mode retry and the job start never call spawnSync', async () => {
    const real = cp.spawnSync; let sync = 0;
    cp.spawnSync = (...a) => { sync++; return real(...a); };
    try {
      const { runner } = mk({ spawnMode: 'auto', probe: () => 'setsid', probeBackoffMs: 0, probeAsync: async () => 'setsid', lingerAsync: async () => 'yes' });
      runner.mode();
      const before = sync;
      runner.readinessItems({ user: 'sam', platform: 'linux' });
      runner.mode({ retry: true });
      await runner.retryProbe();
      const src = read('lib/jobs.js');
      const body = src.slice(src.indexOf('  mode({ retry'), src.indexOf('  // ── persistence'));
      assert.ok(!/spawnSync/.test(body), 'mode(), runningUnprotected() and readinessItems() do not use spawnSync');
      assert.equal(sync, before);
    } finally { cp.spawnSync = real; }
  });
});
