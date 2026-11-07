'use strict';
// Remote computers, service mode: MeshCentral runs as its own systemd service, installed once by the owner. Nothing here starts a process:
// the spawn, the command runs, the probe, the signals and the timers are stand-ins, and every file lives in a temporary folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMeshServer, hashPassword, REPROBE_MS } = require('../modules/remote-computers/lib/meshserver');
const { createRemote } = require('../modules/remote-computers/server');
const checks = require('../modules/remote-computers/index').checks;

const MODULE_DIR = path.join(__dirname, '..', 'modules', 'remote-computers');
const SETTINGS = { address_name: 'hub.example.ts.net', listen_ip: '100.64.0.10', control_port: 9971, agent_port: 9972, agent_allowed: '198.51.100.0/24, 100.64.0.0/10', levels: ['maestro:look'], session_minutes: 30 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-svc-'));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const modeOf = (f) => fs.statSync(f).mode & 0o777;

function fakeRuntime() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'node_modules', 'meshcentral'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'meshcentral', 'meshcentral.js'), '// stand-in\n');
  return dir;
}

// A clock whose timers only move when the test says so.
function makeClock() {
  let t = 1000000, seq = 0;
  const q = [];
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { const h = { id: ++seq, at: t + ms, fn }; q.push(h); return h; },
      clearTimeout(h) { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
    },
    pending: () => q.length,
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        await flush();
        q.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!q.length || q[0].at > target) break;
        const h = q.shift();
        t = Math.max(t, h.at);
        h.fn();
      }
      t = target;
      await flush();
    },
  };
}

// Stand-ins that fail the test when used: in service mode nothing is run and nothing is spawned.
function forbidden() {
  const calls = [];
  const spawn = (...a) => { calls.push(['spawn', ...a]); throw new Error('spawn must not be called'); };
  const execFile = (...a) => { calls.push(['execFile', ...a]); throw new Error('execFile must not be called'); };
  return { spawn, execFile, calls };
}

function newSvc(over = {}) {
  const runtimeDir = over.runtimeDir || fakeRuntime(), home = over.home || tmp();
  const clock = over.clock || makeClock();
  const fb = forbidden();
  const state = { up: over.up !== undefined ? over.up : true, probes: 0 };
  const signals = [];
  const retried = [];
  const agentCalls = [];
  const ensureAgents = over.ensureAgents || (async (a) => { agentCalls.push(a); });
  const ms = createMeshServer({
    runtimeDir, home, settings: over.settings || SETTINGS, mode: over.mode || 'service', serviceName: over.serviceName, moduleDir: over.moduleDir === undefined ? MODULE_DIR : over.moduleDir,
    ensureAgents,
    spawn: fb.spawn, execFile: fb.execFile, now: clock.now, timers: clock.timers, log: () => {},
    probe: async () => { state.probes += 1; return state.up; },
    killPid: (pid, sig) => { signals.push([pid, sig]); over.onKill && over.onKill(pid, sig); },
    onRetryReady: () => retried.push(clock.now()),
    ...(over.procRoot ? { procRoot: over.procRoot } : {}),
  });
  return { ms, runtimeDir, home, clock, fb, state, signals, retried, agentCalls };
}
// What install.sh leaves behind: installed.json and the certificate in the service folder, and the request file deleted.
const markInstalled = (ms) => {
  fs.mkdirSync(ms.paths.serviceDir, { recursive: true });
  fs.writeFileSync(ms.paths.installed, '{"installed":true}\n');
  fs.writeFileSync(ms.paths.rootCert, 'cert');
  fs.rmSync(ms.paths.request, { force: true });
};

const KEYS = ['MMR_VERSION', 'MMR_NAME', 'MMR_HUB_HOME', 'MMR_APP_DIR', 'MMR_RUNTIME_DIR', 'MMR_NODE', 'MMR_MESH_VERSION', 'MMR_CONTROL_PORT', 'MMR_AGENT_ALLOWED',
  'MMR_ADMIN_USER', 'MMR_ADMIN_HASH', 'MMR_AGENT_USER', 'MMR_AGENT_HASH'];
const parseRequest = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]);

// -- mode resolution --
function remoteFor(settings, deps = {}) {
  return createRemote({
    env: { MODULE_SETTINGS: JSON.stringify({ ...SETTINGS, ...settings }), CONNECTOR_DATA_HOME: tmp(), MODULE_RUNTIME_DIR: fakeRuntime() },
    write: () => {}, log: () => {}, deps: { platform: 'linux', ...deps },
  });
}

test('run_as: auto follows the injected detection, service and hub are taken as set', () => {
  assert.strictEqual(remoteFor({}, { serviceSupported: true }).mode, 'service');          // run_as defaults to auto
  assert.strictEqual(remoteFor({ run_as: 'auto' }, { serviceSupported: false }).mode, 'hub');
  assert.strictEqual(remoteFor({ run_as: 'auto' }, { serviceSupported: () => true }).mode, 'service');
  assert.strictEqual(remoteFor({ run_as: 'auto' }, { serviceSupported: () => false }).mode, 'hub');
  assert.strictEqual(remoteFor({ run_as: 'service' }, { serviceSupported: false }).mode, 'service');
  assert.strictEqual(remoteFor({ run_as: 'hub' }, { serviceSupported: true }).mode, 'hub');
  assert.strictEqual(remoteFor({ run_as: 'auto' }, { platform: 'darwin', serviceSupported: true }).mode, 'hub');
  assert.strictEqual(remoteFor({ run_as: 'service' }).mesh.mode, 'service');
  assert.strictEqual(remoteFor({ run_as: 'hub' }).mesh.mode, 'hub');
});

test('the service name from the settings reaches the mesh server; a bad one falls back to the default', () => {
  const r = remoteFor({ run_as: 'service', service_name: 'mymaestro-remote-b2' });
  assert.strictEqual(r.mesh.configFor(SETTINGS, { service: true }).settings.filesPath, '/var/lib/mymaestro-remote-b2/meshcentral-files');
  const bad = remoteFor({ run_as: 'service', service_name: 'other' });
  assert.strictEqual(bad.mesh.configFor(SETTINGS, { service: true }).settings.filesPath, '/var/lib/mymaestro-remote/meshcentral-files');
});

// -- paths and config --
test('service mode paths and config: the files path is the service data folder, everything else is as in hub mode', () => {
  const s = newSvc();
  const h = newSvc({ mode: 'hub', home: s.home });
  assert.strictEqual(s.ms.paths.serviceDir, path.join(s.home, 'service'));
  assert.strictEqual(s.ms.paths.rootCert, path.join(s.home, 'service', 'root-cert-public.crt'));
  assert.strictEqual(s.ms.paths.request, path.join(s.home, 'service', 'request.env'));
  assert.strictEqual(s.ms.paths.serviceConfig, path.join(s.home, 'service', 'config.json'));
  assert.strictEqual(s.ms.paths.installed, path.join(s.home, 'service', 'installed.json'));
  const svcCfg = s.ms.configFor(SETTINGS, { service: true });
  const hubCfg = h.ms.configFor(SETTINGS);
  assert.strictEqual(svcCfg.settings.filesPath, '/var/lib/mymaestro-remote/meshcentral-files');
  assert.strictEqual(hubCfg.settings.filesPath, path.join(s.home, 'meshcentral-files'));
  assert.deepStrictEqual({ ...svcCfg.settings, filesPath: 0, agentDownloads: 0 }, { ...hubCfg.settings, filesPath: 0, agentDownloads: 0 });
  assert.deepStrictEqual(svcCfg.settings.agentDownloads, { enabled: false, fetchReleases: false });
  assert.deepStrictEqual(hubCfg.settings.agentDownloads, { enabled: true, fetchReleases: false });
  assert.deepStrictEqual(svcCfg.domains, hubCfg.domains);
  assert.deepStrictEqual(s.ms.configFor(SETTINGS), svcCfg, 'in service mode the default is the service config');
  assert.strictEqual(newSvc({ serviceName: 'mymaestro-remote-b2' }).ms.configFor(SETTINGS).settings.filesPath, '/var/lib/mymaestro-remote-b2/meshcentral-files');
  assert.throws(() => newSvc({ serviceName: 'sshd' }), /service name is not valid/);
});

// -- bootstrap --
test('bootstrap in service mode writes the request and the config, runs nothing and makes no meshcentral-data', async () => {
  const s = newSvc();
  const r = await s.ms.bootstrap();
  assert.strictEqual(r.needsService, true);
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.command, `sudo bash '${path.join(MODULE_DIR, 'service', 'install.sh')}' '${path.join(s.home, 'service', 'request.env')}'`);
  assert.deepStrictEqual(s.fb.calls, [], 'no CLI run, no spawn');
  assert.ok(!fs.existsSync(path.join(s.home, 'meshcentral-data')));
  assert.ok(!fs.existsSync(path.join(s.home, 'meshcentral-files')));
  assert.strictEqual(modeOf(s.ms.paths.serviceDir), 0o700);

  const pairs = parseRequest(s.ms.paths.request);
  assert.deepStrictEqual(pairs.map((p) => p[0]), KEYS);
  const v = Object.fromEntries(pairs);
  assert.deepStrictEqual([v.MMR_VERSION, v.MMR_NAME, v.MMR_HUB_HOME, v.MMR_APP_DIR, v.MMR_RUNTIME_DIR, v.MMR_NODE, v.MMR_MESH_VERSION, v.MMR_CONTROL_PORT, v.MMR_AGENT_ALLOWED],
    ['1', 'mymaestro-remote', s.home, path.resolve(MODULE_DIR, '..', '..'), s.runtimeDir, process.execPath, '1.3.1', '9971', '198.51.100.0/24, 100.64.0.0/10']);
  assert.strictEqual(fs.readFileSync(s.ms.paths.request, 'utf8').split('\n').length, 14, 'thirteen lines and a final newline');
  assert.ok(!/["']/.test(fs.readFileSync(s.ms.paths.request, 'utf8')), 'no quotes');
  assert.strictEqual(modeOf(s.ms.paths.request), 0o600);

  const acc = JSON.parse(fs.readFileSync(s.ms.paths.accountsFile, 'utf8'));
  assert.strictEqual(modeOf(s.ms.paths.accountsFile), 0o600);
  assert.deepStrictEqual([acc.admin.user, acc.agent.user], ['admin', 'maestro']);
  assert.strictEqual(v.MMR_ADMIN_USER, 'admin');
  assert.strictEqual(v.MMR_AGENT_USER, 'maestro');
  for (const [who, pass] of [['ADMIN', acc.admin.pass], ['AGENT', acc.agent.pass]]) {
    const [salt, hash] = v[`MMR_${who}_HASH`].split(',');
    assert.strictEqual(hashPassword(pass, salt).hash, hash, `${who} hash matches the stored password`);
    assert.ok(!fs.readFileSync(s.ms.paths.request, 'utf8').includes(pass), 'no plain password in the request');
  }

  const cfg = JSON.parse(fs.readFileSync(s.ms.paths.serviceConfig, 'utf8'));
  assert.strictEqual(cfg.settings.filesPath, '/var/lib/mymaestro-remote/meshcentral-files');
  assert.strictEqual(cfg.settings.cert, 'hub.example.ts.net');
  assert.strictEqual(cfg.settings.agentAllowedIp, '198.51.100.0/24,100.64.0.0/10');
  assert.strictEqual(modeOf(s.ms.paths.serviceConfig), 0o600);
  assert.deepStrictEqual(fs.readdirSync(s.ms.paths.serviceDir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left');
});

test('bootstrap in service mode gets the agent files first: the request does not exist while ensureAgents runs', async () => {
  const seen = [];
  let s;
  const ensureAgents = async (a) => {
    seen.push({ a, request: fs.existsSync(s.ms.paths.request), config: fs.existsSync(s.ms.paths.serviceConfig) });
  };
  s = newSvc({ ensureAgents });
  const r = await s.ms.bootstrap();
  assert.strictEqual(r.needsService, true);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].a.runtimeDir, s.runtimeDir);
  assert.strictEqual(typeof seen[0].a.log, 'function');
  assert.strictEqual(seen[0].request, false, 'no request yet');
  assert.strictEqual(seen[0].config, false, 'no config yet');
  assert.ok(fs.existsSync(s.ms.paths.request));
});

test('an installed service with unchanged settings never downloads the agent files', async () => {
  const s = newSvc({ up: true });
  await s.ms.bootstrap();
  assert.strictEqual(s.agentCalls.length, 1);
  markInstalled(s.ms);
  const again = await s.ms.bootstrap();
  assert.deepStrictEqual(again, { created: false, needsService: false });
  assert.strictEqual((await s.ms.checkService()).ready, true);
  assert.strictEqual(s.agentCalls.length, 1, 'ensureAgents was not called again');
});

test('a failing ensureAgents makes bootstrap reject and writes no request', async () => {
  const s = newSvc({ ensureAgents: async () => { throw new Error('x.exe: the download was refused (HTTP 404)'); } });
  await assert.rejects(() => s.ms.bootstrap(), (e) => e.message === 'Could not download the MeshCentral agent files: x.exe: the download was refused (HTTP 404)');
  assert.ok(!fs.existsSync(s.ms.paths.request), 'no request');
  assert.ok(!fs.existsSync(s.ms.paths.serviceConfig), 'no config');
  assert.deepStrictEqual(s.fb.calls, []);
});

test('hub mode never fetches the agent files', async () => {
  const s = newSvc({ mode: 'hub', ensureAgents: async () => { throw new Error('must not be called'); } });
  assert.deepStrictEqual(s.ms.configFor(SETTINGS).settings.agentDownloads, { enabled: true, fetchReleases: false });
  assert.deepStrictEqual(newSvc().ms.configFor(SETTINGS).settings.agentDownloads, { enabled: false, fetchReleases: false });
});

test('a second bootstrap keeps the accounts and writes the request again', async () => {
  const s = newSvc();
  await s.ms.bootstrap();
  const before = fs.readFileSync(s.ms.paths.accountsFile, 'utf8');
  const r = await s.ms.bootstrap();
  assert.strictEqual(r.created, false);
  assert.strictEqual(r.needsService, true);
  assert.strictEqual(fs.readFileSync(s.ms.paths.accountsFile, 'utf8'), before);
  assert.deepStrictEqual(parseRequest(s.ms.paths.request).map((p) => p[0]), KEYS);
  assert.deepStrictEqual(s.fb.calls, []);
});

test('bootstrap in service mode refuses a path the root script would refuse, and writes nothing', async () => {
  const base = tmp();
  const refused = [
    ['a space', { home: path.join(base, 'with space') }],
    ['a dollar sign', { home: path.join(base, 'a$b') }],
    ['a dotdot part', { home: `${base}/x/../y` }],
    ['a dot part', { home: `${base}/./y` }],
    ['a quote', { home: path.join(base, "it's") }],
    ['a runtime with a space', { runtimeDir: path.join(base, 'run time') }],
    ['a runtime with a dotdot part', { runtimeDir: `${base}/r/../r` }],
  ];
  for (const [label, o] of refused) {
    const s = newSvc(o);
    await assert.rejects(() => s.ms.bootstrap(), /cannot be set up/, label);
    assert.ok(!fs.existsSync(path.join(s.home, 'service', 'request.env')), `${label}: no request`);
    assert.ok(!fs.existsSync(path.join(s.home, 'accounts.json')), `${label}: no accounts`);
    assert.deepStrictEqual(s.fb.calls, []);
  }
  // A module folder with a single quote cannot be put in a command.
  const q = newSvc({ moduleDir: "/tmp/it's/module" });
  await assert.rejects(() => q.ms.bootstrap(), /single quote/);
  const none = newSvc({ moduleDir: '' });
  await assert.rejects(() => none.ms.bootstrap(), /install command cannot be made/);
});

test('bootstrap in service mode refuses a newline in the allowed addresses and a missing setting as hub mode does', async () => {
  const s = newSvc({ settings: { ...SETTINGS, agent_allowed: '\n100.64.0.0/10' } });
  await assert.rejects(() => s.ms.bootstrap(), /not valid/);
  const w = newSvc({ settings: { ...SETTINGS, address_name: '' } });
  await assert.rejects(() => w.ms.bootstrap(), /^Error: Waiting for setup/);
});

// -- start --
test('start in service mode: not installed reports the install command, writes the request and never spawns', async () => {
  const s = newSvc({ up: true });
  const r = await s.ms.start();
  assert.strictEqual(r.ready, false);
  assert.strictEqual(r.reason, 'not-installed');
  assert.strictEqual(r.command, `sudo bash '${path.join(MODULE_DIR, 'service', 'install.sh')}' '${s.ms.paths.request}'`);
  assert.match(r.message, /^MeshCentral needs to be installed as its own service once\. Run this in a terminal on this computer \(it asks for an administrator password\), or press Ask Maestro: sudo bash /);
  assert.ok(r.message.endsWith(r.command));
  assert.ok(fs.existsSync(s.ms.paths.request), 'request.env was written because it was missing');
  assert.deepStrictEqual(s.fb.calls, []);
  assert.ok(!fs.existsSync(s.ms.paths.pidFile));
  assert.ok(!fs.existsSync(s.ms.paths.logFile));
  assert.strictEqual(s.ms.isRunning(), false);
  assert.strictEqual(s.state.probes, 0, 'not installed: the port is not even tried');
  assert.strictEqual(s.ms.status().running, false);
});

test('start in service mode: installed but not answering reports the restart command', async () => {
  const s = newSvc({ up: false });
  markInstalled(s.ms);
  const r = await s.ms.start();
  assert.strictEqual(r.ready, false);
  assert.strictEqual(r.reason, 'not-running');
  assert.strictEqual(r.command, 'sudo systemctl restart mymaestro-remote');
  assert.match(r.message, /sudo systemctl restart mymaestro-remote$/);
  assert.strictEqual(s.state.probes, 1);
  assert.strictEqual(s.ms.isRunning(), false);
  assert.deepStrictEqual(s.fb.calls, []);
  // installed.json without the certificate is also "not running"
  const t = newSvc({ up: true, serviceName: 'mymaestro-remote-b2' });
  fs.mkdirSync(t.ms.paths.serviceDir, { recursive: true });
  fs.writeFileSync(t.ms.paths.installed, '{}');
  const r2 = await t.ms.start();
  assert.deepStrictEqual([r2.ready, r2.reason, r2.command], [false, 'not-running', 'sudo systemctl restart mymaestro-remote-b2']);
});

test('start in service mode: ready when installed.json and the certificate exist and the probe answers', async () => {
  const s = newSvc({ up: true });
  markInstalled(s.ms);
  const r = await s.ms.start();
  assert.strictEqual(r.ready, true);
  assert.strictEqual(s.ms.isRunning(), true);
  assert.strictEqual(s.ms.status().running, true);
  assert.deepStrictEqual(s.fb.calls, []);
  assert.strictEqual(s.clock.pending(), 0, 'no re-probe timer once ready');
  assert.ok(!fs.existsSync(s.ms.paths.pidFile));
  assert.ok(!fs.existsSync(s.ms.paths.logFile));
  s.state.up = false;
  const again = await s.ms.checkService();
  assert.strictEqual(again.reason, 'not-running');
  assert.strictEqual(s.ms.isRunning(), false, 'isRunning is the last probe');
});

test('logTail in service mode points to journalctl', () => {
  const s = newSvc();
  assert.strictEqual(s.ms.logTail(), 'MeshCentral runs as the system service mymaestro-remote; its log: journalctl -u mymaestro-remote');
  assert.ok(!fs.existsSync(s.ms.paths.logFile));
});

test('stop in service mode sends no signal and leaves the timer cleared', async () => {
  const s = newSvc({ up: false });
  markInstalled(s.ms);
  await s.ms.start();
  assert.strictEqual(s.clock.pending(), 1, 'the re-probe timer waits');
  await s.ms.stop();
  assert.deepStrictEqual(s.signals, []);
  assert.strictEqual(s.clock.pending(), 0);
  assert.deepStrictEqual(s.fb.calls, []);
  await s.clock.advance(REPROBE_MS * 3);
  assert.strictEqual(s.state.probes, 1, 'no probe after stop');
  const r = newSvc({ up: true });
  markInstalled(r.ms);
  await r.ms.start();
  await r.ms.stop();
  assert.deepStrictEqual(r.signals, [], 'a ready service is not signalled either');
});

test('an old pid file from hub mode is still reaped in service mode', async () => {
  const procRoot = tmp();
  const home = tmp(), runtimeDir = fakeRuntime();
  const mainJs = path.join(runtimeDir, 'node_modules', 'meshcentral', 'meshcentral.js');
  const cmd = path.join(procRoot, '4242', 'cmdline');
  fs.mkdirSync(path.dirname(cmd), { recursive: true });
  fs.writeFileSync(cmd, ['/usr/bin/node', mainJs, '--datapath', path.join(home, 'meshcentral-data'), ''].join('\0'));
  fs.writeFileSync(path.join(home, 'meshcentral.pid'), '4242\n');
  const s = newSvc({ home, runtimeDir, procRoot, up: true, onKill: (pid, sig) => { if (sig === 'SIGTERM') fs.rmSync(cmd); } });
  markInstalled(s.ms);
  const r = await s.ms.start();
  assert.deepStrictEqual(s.signals, [[4242, 'SIGTERM']]);
  assert.ok(!fs.existsSync(path.join(home, 'meshcentral.pid')), 'the pid file is removed');
  assert.strictEqual(r.ready, true);
  assert.deepStrictEqual(s.fb.calls, []);

  // A pid file whose number belongs to another program is removed, and nothing is signalled.
  const home2 = tmp(), proc2 = tmp();
  fs.mkdirSync(path.join(proc2, '777'), { recursive: true });
  fs.writeFileSync(path.join(proc2, '777', 'cmdline'), ['/usr/bin/vim', 'notes.txt', ''].join('\0'));
  fs.writeFileSync(path.join(home2, 'meshcentral.pid'), '777\n');
  const o = newSvc({ home: home2, procRoot: proc2 });
  await o.ms.start();
  assert.deepStrictEqual(o.signals, []);
  assert.ok(!fs.existsSync(path.join(home2, 'meshcentral.pid')));
});

test('every 30 seconds until ready: the module connects by itself after the service appears', async () => {
  const s = newSvc({ up: true });
  const first = await s.ms.start();
  assert.strictEqual(first.reason, 'not-installed');
  assert.strictEqual(s.clock.pending(), 1);
  await s.clock.advance(REPROBE_MS);
  assert.deepStrictEqual(s.retried, [], 'still not installed');
  assert.strictEqual(s.clock.pending(), 1, 'looks again');
  // installed.json appears (install.sh deletes the request), but the certificate and the service are not there yet
  fs.writeFileSync(s.ms.paths.installed, '{}');
  fs.rmSync(s.ms.paths.request, { force: true });
  s.state.up = false;
  await s.clock.advance(REPROBE_MS);
  assert.deepStrictEqual(s.retried, []);
  assert.strictEqual((await s.ms.checkService()).reason, 'not-running');
  // the certificate appears and the port answers
  fs.writeFileSync(s.ms.paths.rootCert, 'cert');
  s.state.up = true;
  await s.clock.advance(REPROBE_MS);
  assert.strictEqual(s.retried.length, 1, 'the retry callback fired once');
  assert.strictEqual(s.ms.isRunning(), true);
  assert.strictEqual(s.clock.pending(), 0, 'the timer stops once ready');
  await s.clock.advance(REPROBE_MS * 4);
  assert.strictEqual(s.retried.length, 1);
  assert.deepStrictEqual(s.fb.calls, []);
});

// -- the tools --
function toolRemote(over = {}) {
  const home = tmp();
  const probe = { up: false };
  const logs = [];
  const remote = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify({ ...SETTINGS, run_as: over.run_as || 'service' }), CONNECTOR_DATA_HOME: home, MODULE_RUNTIME_DIR: fakeRuntime() },
    write: () => {}, log: (...a) => logs.push(a.join(' ')),
    deps: {
      platform: 'linux', WebSocket: over.WebSocket,
      mesh: { ensureAgents: async () => {}, probe: async () => probe.up, spawn: forbidden().spawn, execFile: forbidden().execFile, ...(over.mesh || {}) },
    },
  });
  return { remote, home, probe, logs };
}

test('health and start tools report mode, reason, message and command when the service is missing', async () => {
  const t = toolRemote();
  const started = await t.remote.callTool('start');
  assert.strictEqual(started.ok, false);
  assert.strictEqual(started.mode, 'service');
  assert.strictEqual(started.reason, 'not-installed');
  assert.match(started.message, /^MeshCentral needs to be installed as its own service once\./);
  assert.match(started.command, /^sudo bash '.*\/service\/install\.sh' '.*\/service\/request\.env'$/);
  assert.ok(started.message.endsWith(started.command));
  assert.strictEqual(started.running, false);
  const h = await t.remote.callTool('health');
  assert.deepStrictEqual([h.ok, h.mode, h.reason, h.command], [false, 'service', 'not-installed', started.command]);
  assert.ok(!h.warnings.some((w) => /Run as/.test(w)), 'no hub warning in service mode');

  // installed, but the service does not answer
  const mesh = t.remote.mesh;
  markInstalled(mesh);
  const h2 = await t.remote.callTool('health');
  assert.deepStrictEqual([h2.ok, h2.mode, h2.reason, h2.command], [false, 'service', 'not-running', 'sudo systemctl restart mymaestro-remote']);
  assert.match(h2.message, /sudo systemctl restart mymaestro-remote$/);
  const s2 = await t.remote.callTool('start');
  assert.deepStrictEqual([s2.ok, s2.mode, s2.reason], [false, 'service', 'not-running']);
  await t.remote.stop();
});

test('the server check passes the message and the command through to the setup page', async () => {
  const t = toolRemote();
  const run = async () => checks.server({ platform: 'linux', settings: {}, parse: JSON.parse, callTool: async (name) => JSON.stringify(await t.remote.callTool(name)) });
  const c = await run();
  assert.strictEqual(c.ok, false);
  assert.match(c.summary, /^MeshCentral needs to be installed as its own service once\./);
  assert.match(c.command, /^sudo bash '/);
  assert.ok(c.summary.includes(c.command));
  assert.deepStrictEqual(c.lines, [c.command]);
  markInstalled(t.remote.mesh);
  const c2 = await run();
  assert.strictEqual(c2.reason, 'not-running');
  assert.strictEqual(c2.command, 'sudo systemctl restart mymaestro-remote');
  await t.remote.stop();
});

test('once the service answers, the start sequence goes on to the control connection', async () => {
  const sockets = [];
  class Refuse { constructor(url, opts) { sockets.push({ url, ca: String(opts && opts.ca) }); throw new Error('connection refused'); } }
  const t = toolRemote({ WebSocket: Refuse });
  await t.remote.callTool('start');
  assert.strictEqual(sockets.length, 0);
  markInstalled(t.remote.mesh);
  t.probe.up = true;
  const h = await t.remote.callTool('health');
  assert.strictEqual(h.mode, 'service');
  assert.strictEqual(h.reason, undefined, 'no not-ready reason once the service answers');
  assert.strictEqual(h.running, true);
  assert.ok(sockets.length >= 1, 'the admin client tried the control port');
  assert.match(sockets[0].url, /^wss:\/\/127\.0\.0\.1:9971\/control\.ashx/);
  assert.strictEqual(sockets[0].ca, 'cert', 'the CA is read through mesh.paths.rootCert');
  assert.strictEqual(h.ok, false, 'the stand-in socket never connects');
  await t.remote.stop();
});

// -- hub mode is as it was --
test('hub mode: health says so and warns; the paths and the process are as before', async () => {
  const t = toolRemote({ run_as: 'hub' });
  const h = await t.remote.callTool('health');
  assert.strictEqual(h.mode, 'hub');
  assert.ok(h.warnings.includes('MeshCentral runs under My Maestro\'s own account. On Linux, set "Run as" to service to give it its own locked-down account.'));
  assert.strictEqual(h.reason, undefined);
  const mesh = t.remote.mesh;
  assert.strictEqual(mesh.mode, 'hub');
  assert.strictEqual(mesh.paths.rootCert, path.join(t.home, 'meshcentral-data', 'root-cert-public.crt'));
  assert.strictEqual(mesh.paths.serviceDir, undefined);
  assert.strictEqual(mesh.configFor(SETTINGS).settings.filesPath, path.join(t.home, 'meshcentral-files'));
  assert.strictEqual(mesh.logTail(), '', 'no log yet');
  await t.remote.stop();
});

test('hub mode: createMeshServer defaults to hub and still spawns MeshCentral', async () => {
  const runtimeDir = fakeRuntime(), home = tmp();
  const clock = makeClock();
  const calls = [];
  const { EventEmitter } = require('node:events');
  const spawn = (file, args) => {
    const p = new EventEmitter();
    p.pid = 5151; p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.kill = () => { setImmediate(() => p.emit('exit', null, 'SIGTERM')); return true; };
    calls.push({ file, args });
    return p;
  };
  const ms = createMeshServer({ runtimeDir, home, settings: SETTINGS, spawn, now: clock.now, timers: clock.timers, probe: async () => true });
  assert.strictEqual(ms.paths.serviceDir, undefined);
  fs.mkdirSync(ms.paths.dataPath, { recursive: true });
  fs.writeFileSync(ms.paths.rootCert, 'cert');
  const r = await ms.start();
  assert.deepStrictEqual([r.pid, r.already], [5151, false]);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].file, process.execPath);
  assert.strictEqual(fs.readFileSync(ms.paths.pidFile, 'utf8').trim(), '5151');
  assert.ok(fs.existsSync(ms.paths.logFile));
  assert.strictEqual(ms.isRunning(), true);
  assert.ok(!fs.existsSync(path.join(home, 'service')));
  await ms.stop();
  assert.strictEqual(ms.isRunning(), false);
});

test('the request file is never world readable even if the umask is open', async () => {
  const old = process.umask(0);
  try {
    const s = newSvc();
    await s.ms.bootstrap();
    for (const f of [s.ms.paths.request, s.ms.paths.serviceConfig, s.ms.paths.accountsFile]) assert.strictEqual(modeOf(f), 0o600, f);
    assert.strictEqual(modeOf(s.ms.paths.serviceDir), 0o700);
  } finally { process.umask(old); }
});

test('after the install: no new request with the same settings, and a settings change asks for the install again', async () => {
  const s = newSvc({ up: true });
  await s.ms.start();                       // not installed: writes the request and the config
  markInstalled(s.ms);                      // what install.sh does
  const again = await s.ms.bootstrap();
  assert.deepStrictEqual(again, { created: false, needsService: false });
  assert.ok(!fs.existsSync(s.ms.paths.request), 'no request file with hashes is written again');
  assert.strictEqual((await s.ms.checkService()).ready, true);

  // the owner changes a setting that ends up in MeshCentral's config: a new request, and the check says to run the install again
  const t = newSvc({ up: true, home: s.home, runtimeDir: s.runtimeDir, settings: { ...SETTINGS, control_port: 9981 } });
  const b = await t.ms.bootstrap();
  assert.strictEqual(b.needsService, true);
  assert.ok(fs.existsSync(t.ms.paths.request));
  const c = await t.ms.checkService();
  assert.deepStrictEqual([c.ready, c.reason, c.command], [false, 'needs-update', b.command]);
  assert.match(c.message, /^The settings changed after MeshCentral was installed as the system service mymaestro-remote\. Run the install again/);
  assert.deepStrictEqual(t.fb.calls, [], 'nothing was run or spawned');
});

test('auto keeps a setup that already ran in hub mode in hub mode, and says what a switch costs', () => {
  const mk = (withHubData, runAs) => {
    const home = tmp();
    if (withHubData) {
      fs.mkdirSync(path.join(home, 'meshcentral-data'), { recursive: true });
      fs.writeFileSync(path.join(home, 'meshcentral-data', 'root-cert-public.crt'), 'cert');
    }
    return createRemote({
      env: { MODULE_SETTINGS: JSON.stringify({ ...SETTINGS, run_as: runAs }), CONNECTOR_DATA_HOME: home, MODULE_RUNTIME_DIR: fakeRuntime() },
      write: () => {}, log: () => {},
      deps: { platform: 'linux', serviceSupported: true, mesh: { ensureAgents: async () => {}, probe: async () => false, spawn: forbidden().spawn, execFile: forbidden().execFile } },
    });
  };
  assert.strictEqual(mk(false, 'auto').mode, 'service', 'a fresh setup on systemd');
  assert.strictEqual(mk(true, 'auto').mode, 'hub', 'hub-mode data present: stays in hub mode');
  assert.strictEqual(mk(true, 'service').mode, 'service', 'an explicit choice wins');
  assert.strictEqual(mk(true, 'hub').mode, 'hub');
});
