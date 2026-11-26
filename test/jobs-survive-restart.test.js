'use strict';
// Bug 3: a Maestro restart killed running jobs on installs where the systemd scope probe failed (jobs fell back to setsid
// inside the service's cgroup). Probe environment, retry after a failure, honest warnings in setsid mode only, the restart
// route's list/confirm, and the readiness line.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const J = require('../lib/jobs');
const { JobRunner, probeEnv, detectSpawnMode, lingerState, restartGate, RESTART_WARNING } = J;
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function mk(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-jobs-sr-'));
  const runner = new JobRunner({ dataDir, spawnMode: 'setsid', pollMs: 60000, log: () => {}, defaultCwd: async () => dataDir, notify: async () => {}, agentExists: async () => true, ...extra });
  return { runner, dataDir };
}
const fakeJob = (r, o) => { r.jobs.set(o.id, { id: o.id, name: o.name || 'backup', owner: 'owner', reportTo: null, command: 'true', cwd: '/', timeoutMinutes: 5, status: 'running', startedAt: new Date().toISOString(), endedAt: null, exitCode: null, mode: o.mode, unit: `hub-job-${o.id}`, box: null }); };

describe('probeEnv: what the scope probe (and the jobs) need from the user bus', () => {
  it('derives XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS when missing and their sockets/dirs exist', () => {
    const seen = [];
    const env = probeEnv({ PATH: '/bin' }, { uid: 1234, exists: (p) => { seen.push(p); return true; } });
    assert.equal(env.XDG_RUNTIME_DIR, '/run/user/1234');
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1234/bus');
    assert.equal(env.PATH, '/bin');
    assert.ok(seen.includes('/run/user/1234/bus'));
  });
  it('leaves values that are already set, and sets nothing whose socket is missing', () => {
    const own = { XDG_RUNTIME_DIR: '/x', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x/b' };
    assert.deepEqual(probeEnv(own, { uid: 1, exists: () => true }), own);
    const none = probeEnv({}, { uid: 1, exists: () => false });
    assert.equal(none.XDG_RUNTIME_DIR, undefined); assert.equal(none.DBUS_SESSION_BUS_ADDRESS, undefined);
    const dirOnly = probeEnv({}, { uid: 7, exists: (p) => p === '/run/user/7' });
    assert.equal(dirOnly.XDG_RUNTIME_DIR, '/run/user/7'); assert.equal(dirOnly.DBUS_SESSION_BUS_ADDRESS, undefined);
    assert.equal(probeEnv({ XDG_RUNTIME_DIR: '/x' }, { uid: 1, exists: () => true }).DBUS_SESSION_BUS_ADDRESS, 'unix:path=/x/bus');
  });
  it('detectSpawnMode runs the probe with the derived environment', () => {
    let got = null;
    const m = detectSpawnMode({ env: {}, uid: 5, exists: () => true, spawn: (cmd, args, opts) => { got = { cmd, args, opts }; return { status: 0 }; } });
    assert.equal(m, 'systemd');
    assert.deepEqual(got.args, ['--user', '--scope', '--quiet', '--collect', 'true']);
    assert.equal(got.opts.env.XDG_RUNTIME_DIR, '/run/user/5');
    assert.equal(detectSpawnMode({ env: {}, exists: () => false, spawn: () => ({ status: 1 }) }), 'setsid');
    assert.equal(detectSpawnMode({ env: {}, exists: () => false, spawn: () => { throw new Error('ENOENT'); } }), 'setsid');
  });
});

describe('linger (read-only)', () => {
  it('lingerState reads loginctl show-user -p Linger', () => {
    let args = null;
    assert.equal(lingerState('sam', (c, a) => { args = [c, ...a]; return { status: 0, stdout: 'Linger=no\n' }; }), 'no');
    assert.deepEqual(args, ['loginctl', 'show-user', 'sam', '-p', 'Linger']);
    assert.equal(lingerState('sam', () => ({ status: 0, stdout: 'Linger=yes\n' })), 'yes');
    assert.equal(lingerState('sam', () => ({ status: 1, stdout: '' })), null);
    assert.equal(lingerState('sam', () => { throw new Error('x'); }), null);
  });
});

describe('the probe is retried after a failure, with a back-off', () => {
  it('a failed probe is asked again (in the background) at the next job start once the back-off passed; success is cached for good', async () => {
    let t = 1000; const answers = ['setsid', 'systemd']; let asked = 0;
    const { runner } = mk({ spawnMode: 'auto', now: () => t, probeBackoffMs: 30000, probe: () => { asked++; return answers.shift() || 'systemd'; } });
    assert.equal(runner.mode(), 'setsid'); assert.equal(asked, 1);
    assert.equal(runner.mode(), 'setsid'); assert.equal(asked, 1, 'plain mode() just reports what is known');
    assert.equal(runner.mode({ retry: true }), 'setsid'); assert.equal(asked, 1, 'inside the back-off: no new probe');
    t += 30001;
    assert.equal(runner.mode({ retry: true }), 'setsid', 'the retry does not block: this caller sees what is known');
    await runner.retryProbe(); assert.equal(asked, 2);
    assert.equal(runner.mode({ retry: true }), 'systemd', 'the next caller sees the retry answer');
    t += 999999;
    assert.equal(runner.mode({ retry: true }), 'systemd'); assert.equal(asked, 2, 'a success is never probed again');
  });
  it('an explicit spawnMode is never re-probed', () => {
    let asked = 0; const { runner } = mk({ spawnMode: 'setsid', probe: () => { asked++; return 'systemd'; } });
    assert.equal(runner.mode({ retry: true }), 'setsid'); assert.equal(asked, 0);
  });
  it('run() starts a job in systemd mode when the retry succeeded, and records that mode', async () => {
    let t = 0; const answers = ['setsid', 'systemd'];
    const { runner } = mk({ spawnMode: 'auto', now: () => t, probeBackoffMs: 10, probe: () => answers.shift() || 'systemd' });
    assert.equal(runner.mode(), 'setsid'); t += 100;
    const src = read('lib/jobs.js');
    assert.match(src, /mode: this\.mode\(\{ retry: true \}\)/, 'run() asks with retry');
    runner.stop();
  });
});

describe('a setsid job says it stops if your Maestro restarts; a systemd job says nothing new', () => {
  it('run() reply and status carry the words in setsid mode', async () => {
    const { runner } = mk();
    const j = await runner.run({ owner: 'owner', name: 'backup', command: 'sleep 5' });
    try {
      assert.equal(j.mode, 'setsid');
      assert.match(j.restartWarning, new RegExp(RESTART_WARNING));
      assert.equal(RESTART_WARNING, 'stops if your Maestro restarts');
      assert.match(runner.status(j.id).restartWarning, /stops if your Maestro restarts/);
      assert.match(runner.list('owner')[0].restartWarning, /stops if your Maestro restarts/);
    } finally { runner.cancel(j.id); await new Promise(r => setTimeout(r, 300)); runner.stop(); }
  });
  it('a job in systemd mode, and a finished job, carry no warning', () => {
    const { runner } = mk();
    fakeJob(runner, { id: 'aaaa1111', mode: 'systemd' });
    assert.equal(runner.status('aaaa1111').restartWarning, undefined);
    assert.equal(runner.list(null)[0].restartWarning, undefined);
    fakeJob(runner, { id: 'bbbb2222', mode: 'setsid' }); runner.jobs.get('bbbb2222').status = 'finished';
    assert.equal(runner.status('bbbb2222').restartWarning, undefined);
    assert.ok(!('restartWarning' in runner.list(null).find(x => x.id === 'aaaa1111')));
  });
  it('runningUnprotected lists only running setsid jobs', () => {
    const { runner } = mk();
    fakeJob(runner, { id: 'aaaa1111', mode: 'systemd' }); fakeJob(runner, { id: 'bbbb2222', mode: 'setsid', name: 'backup' });
    assert.deepEqual(runner.runningUnprotected().map(j => [j.id, j.name]), [['bbbb2222', 'backup']]);
  });
  it('the jobs page text no longer promises survival unconditionally', () => {
    const app = read('app.js');
    assert.match(app, /stops if your Maestro restarts/);
  });
});

describe('the restart route lists the jobs and waits for a confirm', () => {
  it('restartGate: nothing at risk or confirmed -> go on; otherwise the list, naming the jobs', () => {
    const { runner } = mk();
    assert.equal(restartGate(runner, {}), null);
    fakeJob(runner, { id: 'aaaa1111', mode: 'systemd' });
    assert.equal(restartGate(runner, {}), null, 'systemd jobs survive: no warning');
    fakeJob(runner, { id: 'bbbb2222', mode: 'setsid', name: 'nightly backup' });
    const g = restartGate(runner, {});
    assert.equal(g.status, 'confirm'); assert.equal(g.needsConfirm, true);
    assert.deepEqual(g.jobs.map(j => j.id), ['bbbb2222']);
    assert.match(g.message, /nightly backup/); assert.match(g.message, /stop/i);
    assert.equal(restartGate(runner, { confirm: true, jobs: ['bbbb2222'] }), null);
    assert.ok(restartGate(runner, { confirm: 'true', jobs: ['bbbb2222'] }), 'only a real true confirms');
  });
  it('server.js applies the gate before restarting, and the pages ask the person', () => {
    const s = read('server.js');
    const i = s.indexOf("pathname === '/api/restart' && req.method === 'POST'");
    const block = s.slice(i, s.indexOf("'/api/restart/log'", i));
    assert.ok(block.indexOf('restartGate') > 0 && block.indexOf('restartGate') < block.indexOf('requestRestart'), 'gate runs before the restart');
    assert.match(block, /409/);
    assert.match(read('app.js'), /needsConfirm/);
    assert.match(read('mobile.js'), /needsConfirm/);
  });
});

describe('the readiness list has one plain line', () => {
  it('setsid mode: a warning with the fix; systemd mode: nothing', () => {
    const { runner } = mk();
    const it1 = runner.readinessItems({ linger: 'no', user: 'sam', platform: 'linux' });
    assert.equal(it1.length, 1);
    assert.equal(it1[0].level, 'warn');
    assert.match(it1[0].title, /stops if your Maestro restarts/);
    assert.match(it1[0].fix, /sudo loginctl enable-linger sam/);
    assert.ok(!/hub/i.test(it1[0].title + it1[0].detail + it1[0].fix));
    const noBus = runner.readinessItems({ linger: 'yes', user: 'sam', platform: 'linux' });
    assert.match(noBus[0].fix, /XDG_RUNTIME_DIR/);
    const mac = runner.readinessItems({ linger: null, user: 'sam', platform: 'darwin' });
    assert.match(mac[0].fix, /finish/i);
    const sys = mk({ spawnMode: 'systemd' }).runner;
    assert.deepEqual(sys.readinessItems({ linger: 'no', user: 'sam', platform: 'linux' }), []);
  });
  it('readiness.js adds the jobs items', async () => {
    const { createReadiness } = require('../lib/readiness');
    const r = createReadiness({ jobItems: () => [{ id: 'jobs-restart', level: 'warn', title: 't', detail: 'd', fix: 'f' }] });
    const out = await r.check();
    assert.ok(out.items.some(i => i.id === 'jobs-restart'));
    assert.match(read('lib/readiness.js'), /jobItems: \(\) =>/);
  });
});
