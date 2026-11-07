'use strict';
// Remote computers, the core: the manifest, the MeshCentral config and first accounts, the process and its supervision, the control client,
// the device group and the MCP server. Nothing here runs MeshCentral: processes, command runs and sockets are stand-ins.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn: realSpawn, spawnSync } = require('node:child_process');
const { loadModule, safeSettings, coerceSettings } = require('../lib/modules/manifest');
const { createMeshServer, hashPassword, redact, RESTART_DELAYS_MS, LOG_ROTATE_BYTES } = require('../modules/remote-computers/lib/meshserver');
const checks = require('../modules/remote-computers/index').checks;
const { createMeshClient, matchReply, b64, MAX_PAYLOAD, MAX_STRING } = require('../modules/remote-computers/lib/meshclient');
const { ensureGroup, AGENT_RIGHTS } = require('../modules/remote-computers/lib/setupgroup');
const { createRemote, TOOLS, NOT_YET, REINSTALL, WAITING } = require('../modules/remote-computers/server');

const DIR = path.join(__dirname, '..', 'modules', 'remote-computers');
const SERVER = path.join(DIR, 'server.js');
const SETTINGS = { address_name: 'hub.example.ts.net', listen_ip: '100.64.0.10', control_port: 9971, agent_port: 9972, levels: ['maestro:look'], session_minutes: 30 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-core-'));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const mode = (f) => fs.statSync(f).mode & 0o777;

// A runtime folder that looks installed: node_modules/meshcentral/meshcentral.js exists (it is never run).
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
  const clock = {
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
  return clock;
}

// A stand-in child process.
function fakeSpawn({ autoExitOnTerm = true, failFirst = 0 } = {}) {
  const calls = [];
  let attempts = 0;
  const spawn = (file, args, opts) => {
    if (++attempts <= failFirst) throw new Error('spawn EAGAIN');
    const p = new EventEmitter();
    p.pid = 4000 + calls.length;
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.signals = [];
    p.kill = (sig) => {
      p.signals.push(sig);
      if (sig === 'SIGKILL' || (sig === 'SIGTERM' && autoExitOnTerm)) setImmediate(() => p.emit('exit', null, sig));
      return true;
    };
    calls.push({ file, args, opts, proc: p });
    return p;
  };
  spawn.calls = calls;
  return spawn;
}

function newServer(over = {}) {
  const runtimeDir = over.runtimeDir || fakeRuntime(), home = over.home || tmp();
  const clock = over.clock || makeClock();
  const spawn = over.spawn || fakeSpawn();
  const logs = [];
  const probes = [];
  const ms = createMeshServer({
    runtimeDir, home, settings: over.settings || SETTINGS, spawn, now: clock.now, timers: clock.timers,
    execFile: over.execFile, probe: over.probe || (async (port) => { probes.push(port); return true; }), log: (...a) => logs.push(a.join(' ')),
    ...(over.procRoot ? { procRoot: over.procRoot } : {}), ...(over.killPid ? { killPid: over.killPid } : {}), ...(over.onRetryReady ? { onRetryReady: over.onRetryReady } : {}),
  });
  return { ms, runtimeDir, home, clock, spawn, logs, probes };
}
const touchCert = (ms) => { fs.mkdirSync(ms.paths.dataPath, { recursive: true }); fs.writeFileSync(ms.paths.rootCert, 'cert'); };

// ── the manifest ──
test('the manifest, setup and check load through the hub loader', () => {
  const m = loadModule(DIR);
  assert.deepStrictEqual(m.problems, []);
  const mf = m.manifest;
  assert.strictEqual(mf.id, 'remote-computers');
  assert.strictEqual(mf.name, 'Remote computers');
  assert.deepStrictEqual(mf.server, { type: 'mcp-stdio', script: 'server.js', background: true, callTimeoutSec: 300, callerIdentity: true });
  assert.deepStrictEqual(mf.runtime, { lockfile: 'runtime', timeoutSec: 900 });
  assert.strictEqual(mf.approvals, true);
  assert.ok(!('media' in mf), 'screenshots are not shared in a common folder: agents get them inline');
  assert.deepStrictEqual(mf.health, { check: 'server' });
  assert.strictEqual(typeof m.code.checks.server, 'function');
  assert.strictEqual(m.hasGuide, true);
  assert.deepStrictEqual(mf.tools, {
    computers: 'read', info: 'read', screenshot: 'read', run: 'write', click: 'write', type: 'write', key: 'write', scroll: 'write',
    health: 'hub', start: 'hub', installer_link: 'hub', computers_status: 'hub',
  });
  assert.deepStrictEqual(TOOLS.map((t) => t.name).sort(), Object.keys(mf.tools).sort());
  const byKey = Object.fromEntries(mf.settings.map((s) => [s.key, s]));
  assert.deepStrictEqual(Object.keys(byKey), ['address_name', 'listen_ip', 'control_port', 'agent_port', 'agent_allowed', 'levels', 'session_minutes']);
  assert.strictEqual(byKey.agent_allowed.default, '100.64.0.0/10');
  assert.strictEqual(byKey.control_port.default, 9971);
  assert.strictEqual(byKey.agent_port.default, 9972);
  assert.deepStrictEqual(byKey.levels.default, ['maestro:look']);
  assert.strictEqual(byKey.session_minutes.default, 30);
  assert.deepStrictEqual([byKey.control_port.min, byKey.control_port.max, byKey.agent_port.min, byKey.agent_port.max, byKey.session_minutes.min, byKey.session_minutes.max], [1024, 65535, 1024, 65535, 5, 120]);
  for (const s of mf.settings) assert.ok(s.label && s.help, `${s.key} has a label and help`);
  assert.deepStrictEqual(safeSettings(mf, {}), { address_name: '', listen_ip: '', control_port: 9971, agent_port: 9972, agent_allowed: '100.64.0.0/10', levels: ['maestro:look'], session_minutes: 30 });
  const allowed = (v) => new RegExp(byKey.agent_allowed.pattern).test(v);
  for (const ok of ['100.64.0.0/10', '10.0.0.1', '100.64.0.0/10, 192.168.0.5', '1.2.3.4/32,5.6.7.8/0']) assert.ok(allowed(ok), ok);
  for (const bad of ['', 'hub', '100.64.0.256', '100.64.0.0/33', '100.64.0.0/', '1.2.3.4,', '1.2.3.4;5.6.7.8', '::1']) assert.ok(!allowed(bad), bad);
});

test('the settings rules of the manifest are enforced by the hub', () => {
  const mf = loadModule(DIR).manifest;
  assert.throws(() => coerceSettings(mf, { levels: ['maestro:root'] }), /not valid/);
  assert.throws(() => coerceSettings(mf, { levels: ['Maestro:look'] }), /not valid/);
  assert.deepStrictEqual(coerceSettings(mf, { levels: 'maestro:look, support:act' }).levels, ['maestro:look', 'support:act']);
  assert.throws(() => coerceSettings(mf, { control_port: 80 }), /at least 1024/);
  assert.throws(() => coerceSettings(mf, { session_minutes: 121 }), /at most 120/);
  const pat = (k) => new RegExp(mf.settings.find((s) => s.key === k).pattern);
  assert.ok(pat('address_name').test('hub.example.ts.net') && !pat('address_name').test('hub') && !pat('address_name').test('hub.example.ts.net/x'));
  assert.ok(pat('listen_ip').test('100.64.0.10') && !pat('listen_ip').test('100.64.0.256') && !pat('listen_ip').test('hub'));
});

test('the runtime folder holds the pinned lockfile of MeshCentral 1.3.1', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'runtime', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.dependencies.meshcentral, '1.3.1');
  const lock = JSON.parse(fs.readFileSync(path.join(DIR, 'runtime', 'package-lock.json'), 'utf8'));
  assert.strictEqual(lock.lockfileVersion, 3);
  assert.strictEqual(Object.keys(lock.packages).length, 182);
  assert.strictEqual(lock.packages['node_modules/meshcentral'].version, '1.3.1');
  assert.strictEqual(lock.packages['node_modules/ws'].version, '8.21.1');
});

// ── configFor ──
test('configFor builds the MeshCentral settings from the module settings', () => {
  const { ms, home } = newServer();
  const c = ms.configFor(SETTINGS);
  assert.deepStrictEqual(c.settings, {
    cert: 'hub.example.ts.net', port: 9971, portBind: '127.0.0.1', agentPort: 9972, agentPortBind: '100.64.0.10',
    redirPort: 0, mpsPort: 0, wanOnly: true, exactPorts: true, newAccounts: false, lockAgentDownload: true,
    userAllowedIp: '127.0.0.1', agentAllowedIp: '100.64.0.0/10', cookieIpCheck: 'strict',
    agentDownloads: { enabled: true, fetchReleases: false }, autoBackup: false, filesPath: path.join(home, 'meshcentral-files'),
  });
  assert.deepStrictEqual(c.domains, { '': { title: 'My Maestro computers', newAccounts: false, passwordRequirements: { logintokens: false } } });   // MeshCentral reads domain.passwordrequirements.logintokens === false (meshuser.js:5363,5402) after lower-casing the keys
  for (const k of ['plugins', 'allowLoginToken', 'ignoreAgentHashCheck', 'aliasPort', 'agentAliasPort', 'tlsOffload']) assert.ok(!(k in c.settings), `${k} is not set`);
  assert.strictEqual(ms.configFor({ ...SETTINGS, address_name: 'Hub.Example.TS.net' }).settings.cert, 'hub.example.ts.net');
});

test('configFor uses agent_allowed for agentAllowedIp (default 100.64.0.0/10), trimmed, and refuses a bad list', () => {
  const { ms } = newServer();
  const allowed = (v) => ms.configFor({ ...SETTINGS, agent_allowed: v }).settings.agentAllowedIp;
  assert.strictEqual(ms.configFor({ ...SETTINGS }).settings.agentAllowedIp, '100.64.0.0/10');
  assert.strictEqual(allowed(''), '100.64.0.0/10');
  assert.strictEqual(allowed('192.168.0.0/24'), '192.168.0.0/24');
  assert.strictEqual(allowed(' 100.64.0.0/10 , 10.1.2.3 '), '100.64.0.0/10,10.1.2.3');
  for (const bad of ['hub', '100.64.0.256', '1.2.3.4/33', '1.2.3.4,,5.6.7.8', '1.2.3.4;5.6.7.8', '1.2.3.4/']) assert.throws(() => allowed(bad), /allowed addresses are not valid/, bad);
});

test('configFor refuses agent_allowed ranges wider than /8 and 0.0.0.0', () => {
  const { ms } = newServer();
  const allowed = (v) => ms.configFor({ ...SETTINGS, agent_allowed: v }).settings.agentAllowedIp;
  for (const wide of ['0.0.0.0', '0.0.0.0/0', '0.0.0.0/8', '10.0.0.0/0', '10.0.0.0/7', '128.0.0.0/1', '100.64.0.0/10,10.0.0.0/4', '192.168.0.0/24, 0.0.0.0']) assert.throws(() => allowed(wide), /too wide/, wide);
  assert.strictEqual(allowed('10.0.0.0/8'), '10.0.0.0/8');
  assert.strictEqual(allowed('1.2.3.4/32,100.64.0.0/10'), '1.2.3.4/32,100.64.0.0/10');
});

test('configFor refuses a missing or invalid name, address or port', () => {
  const { ms } = newServer();
  const bad = (over, re) => assert.throws(() => ms.configFor({ ...SETTINGS, ...over }), re);
  bad({ address_name: '' }, /Waiting for setup/);
  bad({ listen_ip: '' }, /Waiting for setup/);
  bad({ address_name: 'hub' }, /not valid/);                      // no dot: MeshCentral would switch to LAN mode
  bad({ address_name: 'hub.example.ts.net:443' }, /not valid/);
  bad({ address_name: 'a b.example.net' }, /not valid/);
  bad({ address_name: 'hub..example.net' }, /not valid/);
  bad({ listen_ip: '100.64.0.256' }, /not valid/);
  bad({ listen_ip: 'hub.example.ts.net' }, /not valid/);
  bad({ listen_ip: '0.0.0.0' }, /not valid/);
  bad({ control_port: 80 }, /control port/);
  bad({ agent_port: 70000 }, /computer port/);
  bad({ agent_port: 9971 }, /different/);
});

test('writeConfig writes config.json privately and atomically', () => {
  const { ms, home } = newServer();
  ms.writeConfig();
  assert.strictEqual(mode(ms.paths.configFile), 0o600);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(ms.paths.configFile, 'utf8')), ms.configFor(SETTINGS));
  assert.deepStrictEqual(fs.readdirSync(ms.paths.dataPath).filter((n) => n.endsWith('.tmp')), []);
  assert.strictEqual(mode(ms.paths.dataPath), 0o700);
  assert.strictEqual(ms.paths.accountsFile, path.join(home, 'accounts.json'));
  assert.strictEqual(ms.paths.logFile, path.join(home, 'meshcentral.log'));
  assert.strictEqual(ms.paths.stateFile, path.join(home, 'state.json'));
});

// ── the npm guard ──
test('--npmpath is a command that fails loudly instead of installing', () => {
  const { ms } = newServer();
  const args = ms.npmGuardArgs();
  assert.strictEqual(args[0], '--npmpath');
  const [node, script] = args[1].split(' ');
  assert.strictEqual(node, process.execPath);
  assert.ok(script.endsWith(path.join('remote-computers', 'lib', 'no-npm.js')));
  // MeshCentral runs it as: <npmpath> install --save-exact ... through a shell.
  const r = spawnSync('/bin/sh', ['-c', `${args[1]} install --save-exact --no-audit --no-optional --omit=optional ws@8.21.1`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout + r.stderr, /runtime installs are disabled; reinstall the connector/);
  assert.throws(() => createMeshServer({ runtimeDir: '/tmp/x', home: '/tmp/y', settings: SETTINGS, npmGuard: '/tmp/a"b/no-npm.js' }).npmGuardArgs(), /cannot be used in a command line/);
});

// ── bootstrap ──
// A stand-in for execFile: answers on the next tick with `out` (a text or a function of the args and the call number); the returned child records the signals it gets.
function fakeExec(out = 'Done.\n', fail = null) {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    const proc = new EventEmitter();
    proc.signals = [];
    proc.kill = (sig) => { proc.signals.push(sig); return true; };
    calls.push({ file, args, opts, proc });
    const o = typeof out === 'function' ? out(args, calls.length) : out;
    const f = typeof fail === 'function' ? fail(args, calls.length) : fail;
    setImmediate(() => cb(f, o, ''));
    return proc;
  };
  execFile.calls = calls;
  return execFile;
}
// An execFile whose commands never end until they are killed (SIGTERM, or only SIGKILL when stubborn); then the callback gets a killed error.
function hangingExec({ stubborn = false } = {}) {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    const proc = new EventEmitter();
    proc.signals = [];
    proc.kill = (sig) => {
      proc.signals.push(sig);
      if (sig === 'SIGKILL' || (sig === 'SIGTERM' && !stubborn)) setImmediate(() => cb(Object.assign(new Error('Command failed'), { killed: true, signal: sig }), '', ''));
      return true;
    };
    calls.push({ file, args, opts, proc });
    return proc;
  };
  execFile.calls = calls;
  return execFile;
}
const hashArgOf = (args) => args[args.indexOf('--hashpass') + 1];
// The password whose MeshCentral hash is "<salt>,<hash>" (proof that what went on the command line is the hash of what was saved).
const hashesTo = (arg, pass) => { const [salt, hash] = arg.split(','); return hashPassword(pass, salt).hash === hash; };

test('hashPassword is MeshCentral\'s own hash: PBKDF2-SHA384, 12000 rounds, 128 bytes, base64, the salt used as its base64 text', () => {
  // pass.js:14-17,39-43 of MeshCentral 1.3.1 (and --hashpass "<salt>,<hash>", meshcentral.js:1049-1055). The vector below is
  // crypto.pbkdf2Sync('correct horse battery staple', salt, 12000, 128, 'sha384') as that function calls it, with the salt string as given.
  const salt = 'c2FsdC1mb3ItdGhlLXRlc3QtdmVjdG9y';
  const expected = 'oFJkVzQPJm9cF6Lk/Fp9Yv/sl2KsC14wgGbB+1DcH1hSdYogwmWz9Yrz9OmCdPwtRY5ChVuKxvvNdbNf8Wv3D6izcXrttW4pWhINGQhh7rOwNgafIX8ZiNpjdk5dBQ4CnvaK8xdy5faMfZ4/VDQlzAhq4vULD8CYNLbtms2+sAY=';
  const h = hashPassword('correct horse battery staple', salt);
  assert.strictEqual(h.hash, expected);
  assert.strictEqual(h.salt, salt);
  assert.strictEqual(h.arg, `${salt},${expected}`);
  assert.strictEqual(Buffer.from(expected, 'base64').length, 128);
  // A fresh salt is 128 random bytes as base64 (172 characters); neither part has a comma, so "<salt>,<hash>" splits in two.
  const f = hashPassword('x');
  assert.strictEqual(Buffer.from(f.salt, 'base64').length, 128);
  assert.strictEqual(f.salt.length, 172);
  assert.strictEqual(f.arg.split(',').length, 2);
  assert.notStrictEqual(hashPassword('x').salt, f.salt);
  assert.strictEqual(redact('node m.js --pass abc --hashpass s,h x', ['abc']), 'node m.js --pass [secret] --hashpass [secret] x');
});

test('bootstrap makes the admin and the agent account while stopped, with a hashed password and never a password on a command line', async () => {
  const execFile = fakeExec();
  const s = newServer({ execFile });
  const r = await s.ms.bootstrap();
  assert.deepStrictEqual(r, { created: true });
  assert.strictEqual(execFile.calls.length, 3);
  const argsOf = (i) => execFile.calls[i].args;
  const acc = JSON.parse(fs.readFileSync(s.ms.paths.accountsFile, 'utf8'));
  assert.strictEqual(acc.admin.user, 'admin');
  assert.strictEqual(acc.agent.user, 'maestro');
  assert.match(acc.admin.pass, /^[A-Za-z0-9_-]{32}$/);
  assert.match(acc.agent.pass, /^[A-Za-z0-9_-]{32}$/);
  assert.notStrictEqual(acc.admin.pass, acc.agent.pass);
  assert.ok(Number.isFinite(Date.parse(acc.createdAt)));
  const g = s.ms.npmGuardArgs();
  const mainJs = path.join(s.runtimeDir, 'node_modules', 'meshcentral', 'meshcentral.js');
  const head = [mainJs, '--datapath', s.ms.paths.dataPath, ...g];
  assert.deepStrictEqual(argsOf(0), [...head, '--createaccount', 'admin', '--hashpass', hashArgOf(argsOf(0))]);
  assert.deepStrictEqual(argsOf(1), [...head, '--adminaccount', 'admin']);
  assert.deepStrictEqual(argsOf(2), [...head, '--createaccount', 'maestro', '--hashpass', hashArgOf(argsOf(2))]);
  assert.ok(hashesTo(hashArgOf(argsOf(0)), acc.admin.pass), 'the admin hash is the hash of the saved admin password');
  assert.ok(hashesTo(hashArgOf(argsOf(2)), acc.agent.pass), 'the agent hash is the hash of the saved agent password');
  for (const c of execFile.calls) {
    assert.strictEqual(c.file, process.execPath);
    assert.strictEqual(c.opts.cwd, s.runtimeDir);
    assert.strictEqual(c.opts.timeout, 120000);
    assert.deepStrictEqual(Object.keys(c.opts.env).sort(), ['HOME', 'PATH']);
    assert.strictEqual(c.opts.env.HOME, s.home);
    assert.ok(!c.args.includes('--pass'), 'no --pass');
    assert.ok(!c.args.some((a) => a.includes(acc.admin.pass) || a.includes(acc.agent.pass)), 'no password in any argument');
  }
  assert.strictEqual(mode(s.ms.paths.accountsFile), 0o600);
  assert.ok(!fs.existsSync(s.ms.paths.pendingFile), 'no pending file');
  assert.deepStrictEqual(fs.readdirSync(s.home).filter((n) => n.endsWith('.tmp')), []);
  assert.ok(fs.existsSync(s.ms.paths.configFile), 'the config is written before the accounts are made');
  for (const line of s.logs) assert.ok(!line.includes(acc.admin.pass) && !line.includes(acc.agent.pass), 'no password in a log line');
  // A second call changes nothing.
  assert.deepStrictEqual(await s.ms.bootstrap(), { created: false });
  assert.strictEqual(execFile.calls.length, 3);
});

test('bootstrap does not trust a pending file: it is deleted, and every attempt makes fresh passwords', async () => {
  const s = newServer({ execFile: fakeExec() });
  fs.mkdirSync(s.home, { recursive: true });
  fs.writeFileSync(s.ms.paths.pendingFile, JSON.stringify({ adminPass: 'old-admin-pass', agentPass: 'old-agent-pass' }));
  await s.ms.bootstrap();
  const acc = JSON.parse(fs.readFileSync(s.ms.paths.accountsFile, 'utf8'));
  assert.notStrictEqual(acc.admin.pass, 'old-admin-pass');
  assert.notStrictEqual(acc.agent.pass, 'old-agent-pass');
  assert.ok(!fs.existsSync(s.ms.paths.pendingFile));
});

test('bootstrap fails without leaking a password, salt, hash or command line (stdout, stderr or err.message); a retry converges with a reset', async () => {
  let first1 = '', failedArgs = null;
  const first = fakeExec(
    (args, n) => {
      if (n === 1) { first1 = hashArgOf(args); return 'Done.\n'; }
      if (n === 2) return 'Done. This command will only work if MeshCentral is stopped.\n';
      failedArgs = args;
      return `Unexpected failure while creating the account\nbad option --hashpass ${hashArgOf(args)}\n`;
    },
    (args, n) => (n === 3 ? Object.assign(new Error(`Command failed: ${process.execPath} ${args.join(' ')}\nbad ${hashArgOf(args)}`), { code: 1 }) : null),
  );
  const s = newServer({ execFile: first });
  await assert.rejects(() => s.ms.bootstrap(), (e) => {
    assert.match(e.message, /Could not create the agent account/);
    const [salt, hash] = hashArgOf(failedArgs).split(',');
    for (const secret of [first1, first1.split(',')[0], first1.split(',')[1], hashArgOf(failedArgs), salt, hash]) assert.ok(!e.message.includes(secret), 'no salt or hash in the error');
    assert.match(e.message, /\[secret\]/);
    return true;
  });
  assert.ok(!fs.existsSync(s.ms.paths.accountsFile), 'accounts.json is written only after every step worked');
  assert.ok(!fs.existsSync(s.ms.paths.pendingFile), 'no pending file is kept');
  // An error with nothing on stdout: err.message (which holds the command line) is redacted too.
  const quiet = fakeExec('', (args) => Object.assign(new Error(`Command failed: node ${args.join(' ')}`), { code: 1 }));
  const q = newServer({ execFile: quiet });
  await assert.rejects(() => q.ms.bootstrap(), (e) => {
    assert.match(e.message, /Could not create the admin account/);
    assert.ok(!e.message.includes(hashArgOf(quiet.calls[0].args)) && !e.message.includes(hashArgOf(quiet.calls[0].args).split(',')[0]));
    return true;
  });
  // Retry: the admin account exists (an earlier attempt made it with another password): it is reset to the NEW password, then the rest goes on.
  const second = fakeExec((args) => (args.includes('--createaccount') && args.includes('admin') ? 'User already exists.\n' : 'Done.\n'));
  const ms2 = createMeshServer({ runtimeDir: s.runtimeDir, home: s.home, settings: SETTINGS, execFile: second, probe: async () => true });
  assert.deepStrictEqual(await ms2.bootstrap(), { created: true });
  const acc = JSON.parse(fs.readFileSync(ms2.paths.accountsFile, 'utf8'));
  const verbs = second.calls.map((c) => c.args.find((a) => /^--(createaccount|resetaccount|adminaccount)$/.test(a)));
  assert.deepStrictEqual(verbs, ['--createaccount', '--resetaccount', '--adminaccount', '--createaccount']);
  const reset = second.calls[1].args;
  assert.deepStrictEqual(reset.slice(-4), ['--resetaccount', 'admin', '--hashpass', hashArgOf(reset)]);
  assert.ok(hashesTo(hashArgOf(reset), acc.admin.pass), 'the reset sets the password that is saved');
  assert.notStrictEqual(hashArgOf(reset), first1, 'a fresh password and salt for the new attempt');
  assert.ok(hashesTo(hashArgOf(second.calls[3].args), acc.agent.pass));
  for (const c of second.calls) assert.ok(!c.args.includes('--pass'));
  // An account that exists but cannot be reset is an error, not a silent success.
  const stuck = fakeExec('User already exists.\n');
  await assert.rejects(() => newServer({ execFile: stuck }).ms.bootstrap(), /Could not reset the admin account's password: User already exists/);
});

test('bootstrap stops with a clear error when accounts.json cannot be read; only a missing file means "not made yet"', async () => {
  for (const make of [(f) => fs.writeFileSync(f, '{not json'), (f) => fs.mkdirSync(f), (f) => fs.writeFileSync(f, '{"admin":{"user":"admin"},"agent":null}'), (f) => fs.writeFileSync(f, '')]) {
    const execFile = fakeExec();
    const s = newServer({ execFile });
    fs.mkdirSync(s.home, { recursive: true });
    make(s.ms.paths.accountsFile);
    await assert.rejects(() => s.ms.bootstrap(), /accounts file (could not be read|is not in the form).*Nothing was changed/);
    assert.strictEqual(execFile.calls.length, 0, 'no account command was run');
    assert.ok(fs.existsSync(s.ms.paths.accountsFile), 'the file was left alone');
  }
});

test('bootstrap refuses while the server is running, and needs a valid configuration', async () => {
  const execFile = fakeExec();
  const s = newServer({ execFile });
  touchCert(s.ms);
  const started = s.ms.start();
  await s.clock.advance(0);
  await started;
  await assert.rejects(() => s.ms.bootstrap(), /only be made while it is stopped/);
  assert.strictEqual(execFile.calls.length, 0);
  await s.ms.stop();
  const bad = newServer({ execFile, settings: { ...SETTINGS, address_name: '' } });
  await assert.rejects(() => bad.ms.bootstrap(), /Waiting for setup/);
  assert.strictEqual(execFile.calls.length, 0);
});

test('bootstrap treats a timed-out run as a failure', async () => {
  const s = newServer({ execFile: fakeExec('Done.\n', Object.assign(new Error('timed out'), { killed: true })) });
  await assert.rejects(() => s.ms.bootstrap(), /Could not create the admin account/);
});

// ── start, ready, supervision ──
test('start spawns MeshCentral and is ready once the port answers and the root certificate exists', async () => {
  let up = false;
  const s = newServer({ probe: async () => up });
  const p = s.ms.start();
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await s.clock.advance(1500);
  assert.strictEqual(settled, false, 'not ready: no certificate and no port');
  touchCert(s.ms);
  await s.clock.advance(1000);
  assert.strictEqual(settled, false, 'not ready: the port does not answer');
  up = true;
  await s.clock.advance(600);
  const r = await p;
  assert.strictEqual(r.pid, s.spawn.calls[0].proc.pid);
  const c = s.spawn.calls[0];
  const mainJs = path.join(s.runtimeDir, 'node_modules', 'meshcentral', 'meshcentral.js');
  assert.strictEqual(c.file, process.execPath);
  assert.deepStrictEqual(c.args, [mainJs, '--datapath', s.ms.paths.dataPath, ...s.ms.npmGuardArgs()]);
  assert.strictEqual(c.opts.cwd, s.runtimeDir);
  assert.deepStrictEqual(c.opts.env, { PATH: process.env.PATH, HOME: s.home, NODE_ENV: 'production' });
  assert.deepStrictEqual(c.opts.stdio, ['ignore', 'pipe', 'pipe'], 'the output goes through the module\'s bounded log writer');
  assert.strictEqual(mode(s.ms.paths.logFile), 0o600);
  assert.strictEqual(fs.readFileSync(s.ms.paths.pidFile, 'utf8'), `${c.proc.pid}\n`, 'the pid file names the process');
  assert.strictEqual(mode(s.ms.paths.pidFile), 0o600);
  const st = s.ms.status();
  assert.strictEqual(st.running, true);
  assert.strictEqual(st.pid, c.proc.pid);
  assert.strictEqual(st.restarts, 0);
  assert.strictEqual(st.lastError, null);
  assert.ok(Number.isFinite(Date.parse(st.startedAt)));
  // One process at a time: a second start joins the running one.
  assert.strictEqual((await s.ms.start()).already, true);
  assert.strictEqual(s.spawn.calls.length, 1);
  await s.ms.stop();
  assert.ok(!fs.existsSync(s.ms.paths.pidFile), 'a clean stop removes the pid file');
});

test('start probes the loopback control port', async () => {
  const s = newServer({ settings: { ...SETTINGS, control_port: 9980 } });
  touchCert(s.ms);
  const p = s.ms.start();
  await s.clock.advance(0);
  await p;
  assert.deepStrictEqual([...new Set(s.probes)], [9980]);
  await s.ms.stop();
});

test('start rejects with the log tail when MeshCentral exits early or never becomes ready', async () => {
  const early = newServer({ probe: async () => false });
  touchCert(early.ms);
  const p1 = early.ms.start();
  p1.catch(() => {});
  await flush();
  fs.appendFileSync(early.ms.paths.logFile, 'first line\nERROR: Unable to install required modules.\n');
  early.spawn.calls[0].proc.emit('exit', 0, null);
  await assert.rejects(p1, /stopped while starting.*Unable to install required modules/);
  assert.match(early.ms.status().lastError, /MeshCentral stopped \(exit code 0\)/);
  await early.ms.stop();

  const slow = newServer({ probe: async () => false });
  touchCert(slow.ms);
  const p2 = slow.ms.start();
  p2.catch(() => {});
  await flush();
  fs.appendFileSync(slow.ms.paths.logFile, 'still warming up\n');
  await slow.clock.advance(91000);
  await assert.rejects(p2, /did not become ready within 90 s.*still warming up/);
  assert.ok(slow.spawn.calls[0].proc.signals.includes('SIGKILL'));
  await slow.ms.stop();
});

test('start refuses when MeshCentral is not installed, and rotates a big log', async () => {
  const empty = tmp();
  const none = newServer({ runtimeDir: empty });
  await assert.rejects(() => none.ms.start(), /Reinstall needed/);
  const s = newServer();
  touchCert(s.ms);
  fs.mkdirSync(s.home, { recursive: true });
  fs.writeFileSync(s.ms.paths.logFile, Buffer.alloc(10 * 1024 * 1024 + 1));
  const p = s.ms.start();
  await s.clock.advance(0);
  await p;
  assert.ok(fs.existsSync(`${s.ms.paths.logFile}.1`));
  assert.ok(fs.statSync(s.ms.paths.logFile).size < 1024);
  await s.ms.stop();
});

test('an unexpected exit restarts after 5 s, 30 s, 2 min and 10 min, and the back-off resets after 10 stable minutes', async () => {
  const s = newServer();
  touchCert(s.ms);
  const first = s.ms.start();
  await s.clock.advance(0);
  await first;
  assert.deepStrictEqual(RESTART_DELAYS_MS, [5000, 30000, 120000, 600000]);
  const expected = [5000, 30000, 120000, 600000, 600000];
  for (let i = 0; i < expected.length; i++) {
    const before = s.spawn.calls.length;
    s.spawn.calls[before - 1].proc.emit('exit', 1, null);
    assert.strictEqual(s.ms.status().running, false);
    assert.strictEqual(s.ms.status().restarts, i + 1);
    assert.match(s.ms.status().lastError, /exit code 1/);
    await s.clock.advance(expected[i] - 1);
    assert.strictEqual(s.spawn.calls.length, before, `not restarted before ${expected[i]} ms`);
    await s.clock.advance(1);
    assert.strictEqual(s.spawn.calls.length, before + 1, `restarted after ${expected[i]} ms`);
    assert.strictEqual(s.ms.status().running, true);
  }
  await s.clock.advance(10 * 60 * 1000);   // stable
  const n = s.spawn.calls.length;
  s.spawn.calls[n - 1].proc.emit('exit', 1, null);
  await s.clock.advance(4999);
  assert.strictEqual(s.spawn.calls.length, n);
  await s.clock.advance(1);
  assert.strictEqual(s.spawn.calls.length, n + 1, 'the first delay again');
  await s.ms.stop();
});

test('stop sends SIGTERM, then SIGKILL after 10 s, and cancels restarts', async () => {
  const quiet = newServer({ spawn: fakeSpawn({ autoExitOnTerm: false }) });
  touchCert(quiet.ms);
  const p = quiet.ms.start();
  await quiet.clock.advance(0);
  await p;
  const proc = quiet.spawn.calls[0].proc;
  let stopped = false;
  const stopP = quiet.ms.stop().then(() => { stopped = true; });
  await quiet.clock.advance(9999);
  assert.deepStrictEqual(proc.signals, ['SIGTERM']);
  assert.strictEqual(stopped, false);
  await quiet.clock.advance(1);
  await stopP;
  assert.deepStrictEqual(proc.signals, ['SIGTERM', 'SIGKILL']);
  assert.strictEqual(quiet.ms.status().running, false);
  assert.strictEqual(quiet.ms.status().restarts, 0, 'a stop is not an unexpected exit');

  const polite = newServer();
  touchCert(polite.ms);
  const p2 = polite.ms.start();
  await polite.clock.advance(0);
  await p2;
  await polite.ms.stop();
  assert.deepStrictEqual(polite.spawn.calls[0].proc.signals, ['SIGTERM']);

  const crashed = newServer();
  touchCert(crashed.ms);
  const p3 = crashed.ms.start();
  await crashed.clock.advance(0);
  await p3;
  crashed.spawn.calls[0].proc.emit('exit', 1, null);
  await crashed.ms.stop();
  await crashed.clock.advance(11 * 60 * 1000);
  assert.strictEqual(crashed.spawn.calls.length, 1, 'no restart after stop');
});

// ── stop during bootstrap, orphans, the log writer, start retries ──
test('stop during bootstrap: the account commands get SIGTERM, then SIGKILL after 5 s, stop waits for them, and nothing goes on', async () => {
  const polite = hangingExec();
  const s = newServer({ execFile: polite });
  const b = s.ms.bootstrap();
  b.catch(() => {});
  await s.clock.advance(0);
  assert.strictEqual(polite.calls.length, 1);
  await s.ms.stop();
  assert.deepStrictEqual(polite.calls[0].proc.signals, ['SIGTERM']);
  await assert.rejects(b, (e) => e.code === 'ECANCEL');
  assert.strictEqual(polite.calls.length, 1, 'no later step ran');
  assert.ok(!fs.existsSync(s.ms.paths.accountsFile));

  const stubborn = hangingExec({ stubborn: true });
  const t = newServer({ execFile: stubborn });
  const b2 = t.ms.bootstrap();
  b2.catch(() => {});
  await t.clock.advance(0);
  let stopped = false;
  const stopP = t.ms.stop().then(() => { stopped = true; });
  await t.clock.advance(4999);
  assert.deepStrictEqual(stubborn.calls[0].proc.signals, ['SIGTERM']);
  assert.strictEqual(stopped, false, 'stop waits for the command');
  await t.clock.advance(1);
  await stopP;
  assert.deepStrictEqual(stubborn.calls[0].proc.signals, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(b2, (e) => e.code === 'ECANCEL');
  assert.strictEqual(stubborn.calls.length, 1);
});

test('stop before a start spawns anything cancels it: nothing is spawned', async () => {
  const s = newServer();
  touchCert(s.ms);
  fs.mkdirSync(s.home, { recursive: true });
  const p = s.ms.start();
  p.catch(() => {});
  await s.ms.stop();
  await assert.rejects(p, (e) => e.code === 'ECANCEL' || /stopped while starting/.test(e.message));
  await s.clock.advance(60000);
  assert.strictEqual(s.spawn.calls.length, 0);
  assert.ok(!fs.existsSync(s.ms.paths.pidFile));
});

// A fake /proc: <root>/<pid>/cmdline holds NUL-separated arguments.
function fakeProc(s, pid, args) {
  const root = tmp();
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'cmdline'), `${args.join('\0')}\0`);
  return { root, dir };
}
const ourArgs = (s) => [process.execPath, s.ms.paths.mainJs, '--datapath', s.ms.paths.dataPath, '--npmpath', 'x'];

test('an orphan from an earlier run is stopped before the new start: SIGTERM, SIGKILL after 10 s, and only when its command line is ours', async () => {
  const base = newServer({});   // gives the home and runtime folder that the fake processes below belong to
  // 1. a polite orphan: gone after SIGTERM
  const sig = [];
  const fp = fakeProc(base, 777, ourArgs(base));
  const polite = newServer({ home: base.home, runtimeDir: base.runtimeDir, procRoot: fp.root, killPid: (pid, signal) => { sig.push([pid, signal]); fs.rmSync(fp.dir, { recursive: true, force: true }); } });
  touchCert(polite.ms);
  fs.writeFileSync(polite.ms.paths.pidFile, '777\n');
  const p = polite.ms.start();
  await polite.clock.advance(0);
  await p;
  assert.deepStrictEqual(sig, [[777, 'SIGTERM']]);
  assert.strictEqual(fs.readFileSync(polite.ms.paths.pidFile, 'utf8'), `${polite.spawn.calls[0].proc.pid}\n`, 'the pid file now names the new process');
  await polite.ms.stop();

  // 2. a stubborn one: SIGKILL after 10 s
  const sig2 = [];
  const dirs = fakeProc(base, 778, ourArgs(base));
  const stub = newServer({ home: base.home, runtimeDir: base.runtimeDir, procRoot: dirs.root, killPid: (pid, signal) => { sig2.push([pid, signal]); if (signal === 'SIGKILL') fs.rmSync(dirs.dir, { recursive: true, force: true }); } });
  touchCert(stub.ms);
  fs.writeFileSync(stub.ms.paths.pidFile, '778\n');
  const p2 = stub.ms.start();
  await stub.clock.advance(9000);
  assert.deepStrictEqual(sig2, [[778, 'SIGTERM']]);
  assert.strictEqual(stub.spawn.calls.length, 0, 'nothing is spawned while the old one lives');
  await stub.clock.advance(1500);
  await p2;
  assert.deepStrictEqual(sig2, [[778, 'SIGTERM'], [778, 'SIGKILL']]);
  assert.strictEqual(stub.spawn.calls.length, 1);
  await stub.ms.stop();
});

test('an orphan check never signals anything that is not ours: another program, our script with another datapath, a dead pid, junk in the pid file', async () => {
  const base = newServer({});
  const cases = [
    ['another program', [ '/usr/bin/vim', 'notes.txt' ], '901\n'],
    ['our script, another datapath', [process.execPath, base.ms.paths.mainJs, '--datapath', '/somewhere/else'], '902\n'],
    ['the datapath but not our script', [process.execPath, '/tmp/other.js', '--datapath', base.ms.paths.dataPath], '903\n'],
    ['a pid with no process', null, '904\n'],
    ['junk', null, 'not-a-number\n'],
    ['pid 1', [ '/sbin/init' ], '1\n'],
  ];
  for (const [name, args, pidText] of cases) {
    const sig = [];
    const s = newServer({ home: base.home, runtimeDir: base.runtimeDir, procRoot: args ? fakeProc(base, Number(pidText) || 1, args).root : tmp(), killPid: (pid, signal) => { sig.push([pid, signal]); } });
    touchCert(s.ms);
    fs.writeFileSync(s.ms.paths.pidFile, pidText);
    const p = s.ms.start();
    await s.clock.advance(0);
    await p;
    assert.deepStrictEqual(sig, [], `${name}: nothing was signalled`);
    assert.strictEqual(fs.readFileSync(s.ms.paths.pidFile, 'utf8'), `${s.spawn.calls[0].proc.pid}\n`, name);
    await s.ms.stop();
  }
});

test('the child\'s output goes through a bounded writer: meshcentral.log rotates to .1 past 10 MB, two files at most, private', async () => {
  const s = newServer();
  touchCert(s.ms);
  const p = s.ms.start();
  await s.clock.advance(0);
  await p;
  const proc = s.spawn.calls[0].proc;
  proc.stdout.emit('data', Buffer.from('hello from stdout\n'));
  proc.stderr.emit('data', Buffer.from('hello from stderr\n'));
  assert.match(fs.readFileSync(s.ms.paths.logFile, 'utf8'), /hello from stdout\nhello from stderr\n/);
  assert.strictEqual(mode(s.ms.paths.logFile), 0o600);
  const mb = Buffer.alloc(1024 * 1024, 'x');
  for (let i = 0; i < 25; i++) proc.stdout.emit('data', mb);   // 25 MB in all
  const files = fs.readdirSync(s.home).filter((n) => n.startsWith('meshcentral.log')).sort();
  assert.deepStrictEqual(files, ['meshcentral.log', 'meshcentral.log.1']);
  assert.ok(fs.statSync(s.ms.paths.logFile).size <= LOG_ROTATE_BYTES + 1024 * 1024);
  assert.ok(fs.statSync(`${s.ms.paths.logFile}.1`).size > LOG_ROTATE_BYTES, 'the rotated file passed the limit');
  assert.strictEqual(mode(`${s.ms.paths.logFile}.1`), 0o600);
  await s.ms.stop();
  proc.stdout.emit('data', Buffer.from('late line\n'));   // after the stop nothing breaks
  proc.emit('close', 0);
});

test('a start that fails before a process is made is retried with the crash back-off, and the owner of the supervisor is told when it works', async () => {
  let ready = 0;
  const s = newServer({ spawn: fakeSpawn({ failFirst: 2 }), onRetryReady: () => { ready += 1; } });
  touchCert(s.ms);
  const first = s.ms.start();
  first.catch(() => {});
  await assert.rejects(first, /spawn EAGAIN/);
  assert.match(s.ms.status().lastError, /could not be started \(spawn EAGAIN\)/);
  assert.strictEqual(s.ms.status().restarts, 0, 'not counted as a crash');
  await s.clock.advance(4999);
  assert.strictEqual(s.spawn.calls.length, 0);
  await s.clock.advance(1);   // the second try: fails again, next wait is 30 s
  assert.strictEqual(s.spawn.calls.length, 0);
  assert.strictEqual(ready, 0);
  await s.clock.advance(29999);
  assert.strictEqual(s.spawn.calls.length, 0);
  await s.clock.advance(1);
  assert.strictEqual(s.spawn.calls.length, 1, 'the third try spawns');
  assert.strictEqual(ready, 1);
  assert.strictEqual(s.ms.status().running, true);
  await s.ms.stop();
  // "not installed" and a stop are not retried.
  const none = newServer({ runtimeDir: tmp() });
  await assert.rejects(() => none.ms.start(), /Reinstall needed/);
  await none.clock.advance(60000);
  assert.strictEqual(none.spawn.calls.length, 0);
});

// ── the client ──
class FakeWebSocket extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.sent = []; this.closed = false; FakeWebSocket.instances.push(this); }
  send(data) { if (this.closed) throw new Error('closed'); this.sent.push(JSON.parse(data)); this.emit('sent', this.sent[this.sent.length - 1]); }
  close() { if (this.closed) return; this.closed = true; setImmediate(() => this.emit('close', 1000)); }
  terminate() { this.close(); }
  deliver(frame) { this.emit('message', Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame)), false); }
}
FakeWebSocket.instances = [];
const newClient = (over = {}) => {
  FakeWebSocket.instances = [];
  return createMeshClient({ url: 'wss://127.0.0.1:9971/control.ashx', ca: 'CA-PEM', servername: 'hub.example.ts.net', user: 'maestro', pass: 'p@ss:w,rd', WebSocket: FakeWebSocket, ...over });
};
const lastSocket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
async function loggedIn(over) {
  const c = newClient(over);
  const r = c.ready();
  const ws = lastSocket();
  ws.deliver({ action: 'serverinfo', serverinfo: {} });
  ws.deliver({ action: 'userinfo', userinfo: { name: 'maestro' } });
  await r;
  return { c, ws };
}
const nextSent = (ws) => new Promise((resolve) => { if (ws.sent.length > (ws._seen || 0)) { ws._seen = (ws._seen || 0) + 1; resolve(ws.sent[ws._seen - 1]); } else ws.once('sent', () => { ws._seen = (ws._seen || 0) + 1; resolve(ws.sent[ws._seen - 1]); }); });

test('the client logs in with the x-meshauth header, pinned TLS and a 16 MB limit, and is ready on userinfo', async () => {
  const c = newClient();
  let ready = false;
  const r = c.ready().then(() => { ready = true; });
  const ws = lastSocket();
  assert.strictEqual(ws.url, 'wss://127.0.0.1:9971/control.ashx');
  assert.strictEqual(ws.opts.headers['x-meshauth'], `${b64('maestro')},${b64('p@ss:w,rd')}`);
  assert.strictEqual(b64('maestro'), 'bWFlc3Rybw==');
  assert.strictEqual(ws.opts.ca, 'CA-PEM');
  assert.strictEqual(ws.opts.servername, 'hub.example.ts.net');
  assert.strictEqual(ws.opts.rejectUnauthorized, true);
  assert.strictEqual(ws.opts.maxPayload, 16 * 1024 * 1024);
  assert.strictEqual(MAX_PAYLOAD, 16 * 1024 * 1024);
  ws.deliver({ action: 'serverinfo', serverinfo: {} });
  await flush();
  assert.strictEqual(ready, false, 'serverinfo is not the login');
  ws.deliver({ action: 'userinfo', userinfo: {} });
  await r;
  assert.strictEqual(ready, true);
  assert.strictEqual(FakeWebSocket.instances.length, 1);
});

test('beforeSend runs after the reconnect, right before sock.send; a throw sends nothing (sent: false) and a number shortens the wait', async () => {
  const c = newClient({ timeoutMs: 30000 });
  const order = [];
  let alive = true;
  const p = c.request('runcommands', { cmds: 'x' }, { beforeSend: () => { order.push('check'); if (!alive) throw Object.assign(new Error('The approval has ended.'), { marker: 1 }); return 8000; } });
  const ws = lastSocket();
  ws.on('sent', () => order.push('send'));
  await flush();
  assert.deepStrictEqual(order, [], 'the connection is not ready yet: not checked yet, nothing sent');
  alive = false;   // the session expires while the connection is being made
  ws.deliver({ action: 'userinfo', userinfo: {} });
  await assert.rejects(p, (e) => { assert.strictEqual(e.marker, 1); assert.strictEqual(e.sent, false); return true; });
  assert.deepStrictEqual(order, ['check']);
  assert.strictEqual(ws.sent.length, 0, 'nothing went out');
  // Alive again: the check runs once, directly before the send.
  alive = true; order.length = 0;
  const p2 = c.request('runcommands', { cmds: 'y' }, { timeoutMs: 20000, beforeSend: () => { order.push('check'); return 8000; } });
  const sent = await nextSent(ws);
  assert.deepStrictEqual(order, ['check', 'send']);
  assert.strictEqual(sent.cmds, 'y');
  ws.deliver({ action: 'msg', type: 'runcommands', responseid: sent.responseid, result: 'done' });
  assert.strictEqual((await p2).result, 'done');
});

test('a request that times out carries the wait that applied (err.waitMs), after the beforeSend clamp', async () => {
  const c = newClient({ timeoutMs: 30000 });
  const p = c.request('runcommands', { cmds: 'x' }, { timeoutMs: 60, beforeSend: () => 25 });
  lastSocket().deliver({ action: 'userinfo', userinfo: {} });
  await assert.rejects(p, (e) => { assert.strictEqual(e.code, 'ETIMEDOUT'); assert.strictEqual(e.sent, true); assert.strictEqual(e.waitMs, 25); return true; });
  const d = newClient({ timeoutMs: 30000 });
  const q = d.request('runcommands', { cmds: 'x' }, { timeoutMs: 40 });
  lastSocket().deliver({ action: 'userinfo', userinfo: {} });
  await assert.rejects(q, (e) => e.waitMs === 40);
});

test('ready rejects on a refused login, a closed socket and silence, never mentioning the password', async () => {
  const a = newClient();
  const pa = a.ready();
  lastSocket().deliver({ action: 'close', cause: 'noauth', msg: 'noauth-2a' });
  await assert.rejects(pa, (e) => { assert.strictEqual(e.code, 'EAUTH'); assert.match(e.message, /noauth.*noauth-2a/); assert.ok(!e.message.includes('p@ss')); return true; });

  const b = newClient();
  const pb = b.ready();
  lastSocket().close();
  await assert.rejects(pb, (e) => e.code === 'ECLOSED' && !e.message.includes('p@ss'));

  const c = newClient();
  const pc = c.ready();
  lastSocket().emit('error', Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }));
  await assert.rejects(pc, /DEPTH_ZERO_SELF_SIGNED_CERT/);

  const d = newClient({ readyMs: 40 });
  await assert.rejects(d.ready(), (e) => e.code === 'ETIMEDOUT' && e.login === true, 'a login that timed out is marked: nothing was sent');
});

test('a command that gets no answer is ETIMEDOUT without the login mark', async () => {
  const { c } = await loggedIn();
  await assert.rejects(c.request('nodes', {}, { timeoutMs: 20 }), (e) => e.code === 'ETIMEDOUT' && e.login === undefined);
  c.close();
});

// A socket that can ping.
class PingSocket extends FakeWebSocket {
  ping() { this.pings = (this.pings || 0) + 1; if (PingSocket.pong) setImmediate(() => this.emit('pong')); }
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test('keepalive: a ping every interval; a socket that never answers is dropped and its requests fail', async () => {
  PingSocket.pong = true;
  const alive = await loggedIn({ WebSocket: PingSocket, pingMs: 30, pongMs: 40 });
  await sleepMs(200);
  assert.ok(alive.ws.pings >= 3, `pings sent (${alive.ws.pings})`);
  assert.strictEqual(alive.ws.closed, false, 'answered pings keep it open');
  alive.c.close();

  PingSocket.pong = false;
  const dead = await loggedIn({ WebSocket: PingSocket, pingMs: 30, pongMs: 40 });
  const pending = dead.c.request('nodes', {}, { timeoutMs: 5000 });
  pending.catch(() => {});
  await assert.rejects(pending, (e) => e.code === 'ECLOSED');
  assert.strictEqual(dead.ws.closed, true, 'terminated');
  assert.strictEqual(dead.ws.pings, 1, 'not pinged again once dropped');
  // The next request logs in again on a new socket.
  PingSocket.pong = true;
  const next = dead.c.request('nodes');
  await flush();
  const ws2 = lastSocket();
  assert.notStrictEqual(ws2, dead.ws);
  ws2.deliver({ action: 'userinfo', userinfo: {} });
  const s = await nextSent(ws2);
  ws2.deliver({ action: 'nodes', responseid: s.responseid, nodes: {} });
  await next;
  dead.c.close();
  PingSocket.pong = false;
});

test('a request that times out does not give up its socket (no uncorrelated requests remain), and the error says it was sent', async () => {
  const { c, ws } = await loggedIn();
  const slow = c.request('nodes', {}, { timeoutMs: 30 });
  const other = c.request('nodes', {}, { timeoutMs: 5000 });
  slow.catch(() => {}); other.catch(() => {});
  const s1 = await nextSent(ws);
  const s2 = await nextSent(ws);
  await assert.rejects(slow, (e) => e.code === 'ETIMEDOUT' && e.sent === true);
  assert.strictEqual(ws.closed, false, 'the socket stays');
  ws.deliver({ action: 'nodes', responseid: s1.responseid, nodes: { late: [] } });   // the late answer is ignored
  ws.deliver({ action: 'nodes', responseid: s2.responseid, nodes: { fine: [] } });
  assert.deepStrictEqual((await other).nodes, { fine: [] });
  assert.strictEqual(FakeWebSocket.instances.length, 1);
  c.close();
});

test('err.sent: false when the failure came before the request was sent, true after it (timeout, lost connection, server refusal)', async () => {
  // Before: the login failed or timed out; the send itself threw.
  const a = newClient({ readyMs: 30 });
  await assert.rejects(a.request('nodes', {}), (e) => e.code === 'ETIMEDOUT' && e.login === true && e.sent === false);
  const b = newClient();
  const pb = b.request('nodes', {});
  lastSocket().deliver({ action: 'close', cause: 'noauth', msg: 'x' });
  await assert.rejects(pb, (e) => e.code === 'EAUTH' && e.sent === false);
  const { c, ws } = await loggedIn();
  ws.send = () => { throw new Error('socket is gone'); };
  await assert.rejects(c.request('runcommands', { nodeids: ['n'], cmds: 'x' }), (e) => e.code === 'ECLOSED' && e.sent === false && /Could not send/.test(e.message));
  c.close();
  // After: the connection closes while the request waits, the server refuses it, the reply is too big.
  const d = await loggedIn();
  const lost = d.c.request('runcommands', { nodeids: ['n'], cmds: 'x' });
  const sd = await nextSent(d.ws);
  d.ws.close();
  await assert.rejects(lost, (e) => e.code === 'ECLOSED' && e.sent === true);
  const e2 = await loggedIn();
  const refused = e2.c.request('runcommands', { nodeids: ['n'], cmds: 'x' });
  const se = await nextSent(e2.ws);
  e2.ws.deliver({ action: 'runcommands', responseid: se.responseid, result: 'Agent not connected' });
  await assert.rejects(refused, (e) => e.code === 'EMESH' && e.sent === true);
  assert.ok(sd);
  e2.c.close();
  // Each failed request gets its own error object.
  const f = await loggedIn();
  const r1 = f.c.request('nodes', {}), r2 = f.c.request('nodes', {});
  r1.catch(() => {}); r2.catch(() => {});
  await nextSent(f.ws); await nextSent(f.ws);
  f.c.close();
  const [x1, x2] = await Promise.all([r1.catch((e) => e), r2.catch((e) => e)]);
  assert.notStrictEqual(x1, x2);
  assert.ok(x1.sent === true && x2.sent === true);
});

test('matchReply follows the control-message rules for every kind of request', () => {
  const ok = (r) => r && r.ok === true;
  const err = (r, re) => r && r.ok === false && re.test(r.error);
  // default: action + responseid; a text result other than ok/OK is an error
  const req = { responseid: 'r1' };
  assert.ok(ok(matchReply('createmesh', req, { action: 'createmesh', responseid: 'r1', result: 'ok', meshid: 'mesh//x' })));
  assert.ok(ok(matchReply('nodes', req, { action: 'nodes', responseid: 'r1', nodes: {} })));
  assert.ok(ok(matchReply('toast', req, { action: 'toast', responseid: 'r1', result: 'OK' })));
  assert.ok(err(matchReply('nodes', req, { action: 'nodes', responseid: 'r1', result: 'Invalid group id' }), /Invalid group id/));
  assert.strictEqual(matchReply('nodes', req, { action: 'nodes', responseid: 'other' }), null);
  assert.strictEqual(matchReply('nodes', req, { action: 'nodes' }), null, 'the unsolicited node list is not ours');
  assert.strictEqual(matchReply('nodes', req, { action: 'userinfo', responseid: 'r1' }), null);
  // runcommands with reply:true
  const rc = { responseid: 'r2', reply: true };
  const out = matchReply('runcommands', rc, { action: 'msg', type: 'runcommands', responseid: 'r2', result: 'hello\r\n', nodeid: 'node//a' });
  assert.ok(ok(out));
  assert.strictEqual(out.reply.result, 'hello\r\n');
  assert.ok(err(matchReply('runcommands', rc, { action: 'runcommands', responseid: 'r2', result: 'Agent not connected' }), /Agent not connected/));
  assert.strictEqual(matchReply('runcommands', rc, { action: 'runcommands', responseid: 'r2', result: 'OK' }).ok, false, 'OK is not the output when reply was asked');
  assert.strictEqual(matchReply('runcommands', rc, { action: 'msg', type: 'runcommands', responseid: 'zzz', result: 'x' }), null);
  assert.strictEqual(matchReply('runcommands', rc, { action: 'msg', type: 'messagebox', responseid: 'r2' }), null);
  assert.ok(ok(matchReply('runcommands', { responseid: 'r3', reply: false }, { action: 'runcommands', responseid: 'r3', result: 'OK' })));
  // getsysinfo: action + tag
  const gs = { responseid: 'r4', tag: 't4', nodeid: 'node//a' };
  assert.ok(ok(matchReply('getsysinfo', gs, { action: 'getsysinfo', nodeid: 'node//a', tag: 't4', hardware: {} })));
  assert.strictEqual(matchReply('getsysinfo', gs, { action: 'getsysinfo', nodeid: 'node//a', tag: 'other' }), null);
  assert.ok(err(matchReply('getsysinfo', gs, { action: 'getsysinfo', nodeid: 'node//a', tag: 't4', noinfo: true, result: 'Invalid device id' }), /Invalid device id/));
  // getnetworkinfo is not used any more: it has no special rule (an answer without a responseid is not ours).
  assert.strictEqual(matchReply('getnetworkinfo', { responseid: 'r5', nodeid: 'abc' }, { action: 'getnetworkinfo', nodeid: 'node/dom/abc', netif2: {} }), null);
  // addmeshuser: success > 0
  const am = { responseid: 'r6' };
  assert.ok(ok(matchReply('addmeshuser', am, { action: 'addmeshuser', responseid: 'r6', result: 'Added user maestro', success: 1, failed: 0 })));
  assert.ok(err(matchReply('addmeshuser', am, { action: 'addmeshuser', responseid: 'r6', result: 'Unknown user maestro', success: 0, failed: 1 }), /Unknown user/));
  assert.ok(err(matchReply('addmeshuser', am, { action: 'addmeshuser', responseid: 'r6', result: 'Permission denied' }), /Permission denied/));
  // createLoginToken: no responseid on success
  const lt = { responseid: 'r7', name: 'tok' };
  assert.ok(ok(matchReply('createLoginToken', lt, { action: 'createLoginToken', name: 'tok', tokenUser: '~t:x', tokenPass: 'y' })));
  assert.strictEqual(matchReply('createLoginToken', lt, { action: 'createLoginToken', name: 'other', tokenUser: '~t:x' }), null);
  assert.ok(err(matchReply('createLoginToken', lt, { action: 'createLoginToken', responseid: 'r7', result: 'Not supported' }), /Not supported/));
  assert.strictEqual(matchReply('nodes', req, null), null);
});

test('request sends a unique responseid, matches its reply and ignores other frames', async () => {
  const { c, ws } = await loggedIn();
  const p = c.request('createmesh', { meshname: 'x', meshtype: 2 });
  const sent = await nextSent(ws);
  assert.strictEqual(sent.action, 'createmesh');
  assert.strictEqual(sent.meshname, 'x');
  assert.match(sent.responseid, /^[0-9a-f-]{36}$/);
  ws.deliver({ action: 'nodes', nodes: {} });
  ws.deliver({ action: 'createmesh', responseid: 'someone-else', result: 'ok', meshid: 'wrong' });
  ws.deliver('this is not json');
  ws.deliver({ action: 'event', event: {} });
  ws.deliver({ action: 'createmesh', responseid: sent.responseid, result: 'ok', meshid: 'mesh//right' });
  assert.strictEqual((await p).meshid, 'mesh//right');
  const q1 = c.request('nodes'), q2 = c.request('nodes');
  const s1 = await nextSent(ws), s2 = await nextSent(ws);
  assert.notStrictEqual(s1.responseid, s2.responseid);
  ws.deliver({ action: 'nodes', responseid: s2.responseid, nodes: { m: [1, 2] } });
  ws.deliver({ action: 'nodes', responseid: s1.responseid, nodes: { m: [1] } });
  assert.strictEqual((await q1).nodes.m.length, 1);
  assert.strictEqual((await q2).nodes.m.length, 2);
  // An error reply rejects.
  const bad = c.request('nodes', { meshid: 'nope' });
  const sb = await nextSent(ws);
  ws.deliver({ action: 'nodes', responseid: sb.responseid, result: 'Invalid group id' });
  await assert.rejects(bad, (e) => e.code === 'EMESH' && /Invalid group id/.test(e.message));
  c.close();
});

test('runcommands asks for the output and getsysinfo carries a tag', async () => {
  const { c, ws } = await loggedIn();
  const run = c.request('runcommands', { nodeids: ['node//a'], type: 2, cmds: 'Get-Date', runAsUser: 2 });
  const sr = await nextSent(ws);
  assert.strictEqual(sr.reply, true);
  assert.strictEqual(sr.type, 2);
  ws.deliver({ action: 'msg', type: 'runcommands', responseid: sr.responseid, result: 'Friday', nodeid: 'node//a' });
  assert.strictEqual((await run).result, 'Friday');
  const run2 = c.request('runcommands', { nodeids: ['node//a'], cmds: 'x' });
  const sr2 = await nextSent(ws);
  ws.deliver({ action: 'runcommands', responseid: sr2.responseid, result: 'Access denied' });
  await assert.rejects(run2, /Access denied/);

  const si = c.request('getsysinfo', { nodeid: 'node//a', nodeinfo: true });
  const ss = await nextSent(ws);
  assert.match(ss.tag, /^[0-9a-f-]{36}$/);
  ws.deliver({ action: 'getsysinfo', nodeid: 'node//a', tag: ss.tag, hardware: { windows: {} }, node: {}, rights: 1 });
  assert.deepStrictEqual((await si).hardware, { windows: {} });

  c.close();
});

test('a request that gets no answer times out with ETIMEDOUT', async () => {
  const { c, ws } = await loggedIn({ timeoutMs: 5000 });
  const p = c.request('nodes', {}, { timeoutMs: 30 });
  const sent = await nextSent(ws);
  await assert.rejects(p, (e) => e.code === 'ETIMEDOUT');
  // A late reply to it is ignored, and the next request still works.
  ws.deliver({ action: 'nodes', responseid: sent.responseid, nodes: {} });
  const q = c.request('nodes');
  const s2 = await nextSent(ws);
  ws.deliver({ action: 'nodes', responseid: s2.responseid, nodes: { a: [] } });
  assert.ok((await q).nodes);
  c.close();
});

test('pending requests are rejected when the socket closes, and the next request reconnects lazily on one connection', async () => {
  const { c, ws } = await loggedIn();
  const a = c.request('nodes'), b = c.request('toast', { nodeids: [] });
  await flush();
  ws.close();
  await assert.rejects(a, (e) => e.code === 'ECLOSED');
  await assert.rejects(b, (e) => e.code === 'ECLOSED');
  assert.strictEqual(FakeWebSocket.instances.length, 1, 'no reconnect without a request');
  const x = c.request('nodes'), y = c.request('nodes');   // two at once: one connection
  await flush();
  assert.strictEqual(FakeWebSocket.instances.length, 2);
  const ws2 = lastSocket();
  assert.strictEqual(ws2.opts.headers['x-meshauth'], ws.opts.headers['x-meshauth']);
  ws2.deliver({ action: 'userinfo', userinfo: {} });
  const s1 = await nextSent(ws2), s2 = await nextSent(ws2);
  ws2.deliver({ action: 'nodes', responseid: s1.responseid, nodes: { m: [] } });
  ws2.deliver({ action: 'nodes', responseid: s2.responseid, nodes: { m: [] } });
  await x; await y;
  assert.strictEqual(FakeWebSocket.instances.length, 2);
  // A late close event of the first socket does not fail the second one's requests.
  const z = c.request('nodes');
  const s3 = await nextSent(ws2);
  ws.emit('close', 1006);
  ws2.deliver({ action: 'nodes', responseid: s3.responseid, nodes: {} });
  await z;
  c.close();
});

test('a failed login lets the next request try again', async () => {
  const c = newClient();
  const p1 = c.request('nodes');
  await flush();
  lastSocket().deliver({ action: 'close', cause: 'noauth', msg: 'noauth-2a' });
  await assert.rejects(p1, (e) => e.code === 'EAUTH');
  const p2 = c.request('nodes');
  await flush();
  assert.strictEqual(FakeWebSocket.instances.length, 2);
  const ws2 = lastSocket();
  ws2.deliver({ action: 'userinfo', userinfo: {} });
  const s = await nextSent(ws2);
  ws2.deliver({ action: 'nodes', responseid: s.responseid, nodes: {} });
  await p2;
  c.close();
});

test('the client caps a string result at 12 MB', async () => {
  const { c, ws } = await loggedIn();
  const p = c.request('runcommands', { nodeids: ['node//a'], cmds: 'x' });
  const s = await nextSent(ws);
  ws.deliver({ action: 'msg', type: 'runcommands', responseid: s.responseid, result: 'a'.repeat(MAX_STRING + 1) });
  await assert.rejects(p, (e) => e.code === 'ETOOBIG');
  const q = c.request('runcommands', { nodeids: ['node//a'], cmds: 'x' });
  const s2 = await nextSent(ws);
  ws.deliver({ action: 'msg', type: 'runcommands', responseid: s2.responseid, result: 'a'.repeat(MAX_STRING) });
  assert.strictEqual((await q).result.length, MAX_STRING);
  // A frame above the 16 MB limit is dropped, not parsed.
  const r = c.request('nodes', {}, { timeoutMs: 40 });
  const s3 = await nextSent(ws);
  ws.deliver(JSON.stringify({ action: 'nodes', responseid: s3.responseid, pad: 'a'.repeat(MAX_PAYLOAD) }));
  await assert.rejects(r, (e) => e.code === 'ETIMEDOUT');
  c.close();
});

// ── the device group ──
test('ensureGroup creates the group, grants the limited rights and remembers the group', async () => {
  const sent = [];
  const client = { async request(action, fields) { sent.push({ action, fields }); return action === 'createmesh' ? { meshid: 'mesh//abc', result: 'ok' } : { success: 1, result: 'Added user maestro' }; } };
  const store = { data: {}, read() { return this.data; }, write(o) { this.data = o; } };
  assert.strictEqual(AGENT_RIGHTS, 1263104);
  assert.strictEqual(AGENT_RIGHTS, 131072 + 1048576 + 16384 + 65536 + 512 + 1024);
  assert.strictEqual(await ensureGroup(client, store), 'mesh//abc');
  assert.deepStrictEqual(sent.map((s) => s.action), ['createmesh', 'addmeshuser']);
  assert.deepStrictEqual(sent[0].fields, { meshname: 'My Maestro computers', desc: sent[0].fields.desc, meshtype: 2, consent: 0 });
  assert.deepStrictEqual(sent[1].fields, { meshid: 'mesh//abc', usernames: ['maestro'], meshadmin: 1263104 });
  assert.deepStrictEqual(store.data, { meshid: 'mesh//abc' });
  // Next time the remembered group is used, with no second group.
  sent.length = 0;
  assert.strictEqual(await ensureGroup(client, store), 'mesh//abc');
  assert.deepStrictEqual(sent.map((s) => s.action), ['addmeshuser']);
});

test('ensureGroup saves the group before it grants rights, and fails when no user was added', async () => {
  const store = { data: {}, read() { return this.data; }, write(o) { this.data = o; } };
  const client = { async request(action) { if (action === 'createmesh') return { meshid: 'mesh//abc' }; return { success: 0, result: 'Unknown user maestro' }; } };
  await assert.rejects(() => ensureGroup(client, store), /could not be added/);
  assert.deepStrictEqual(store.data, { meshid: 'mesh//abc' }, 'the group is kept, not made twice');
  await assert.rejects(() => ensureGroup({ async request() { return {}; } }, { read: () => ({}), write() {} }), /did not return/);
});

test('the real state store keeps state.json private', () => {
  const { ms } = newServer();
  assert.deepStrictEqual(ms.state.read(), {});
  ms.state.write({ meshid: 'mesh//abc' });
  assert.deepStrictEqual(ms.state.read(), { meshid: 'mesh//abc' });
  assert.strictEqual(mode(ms.paths.stateFile), 0o600);
});

// ── the MCP server ──
function rpcChild(env) {
  const child = realSpawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', seq = 0;
  const waiting = new Map();
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10000);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => { const r = await call('tools/call', { name, arguments: args }); return r.result; };
  const close = () => new Promise((resolve) => { child.once('exit', resolve); child.stdin.end(); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); });
  return { call, tool, close, stderr: () => stderr };
}
const health = async (rpc) => JSON.parse((await rpc.tool('health')).content[0].text);

test('server.js reports "Reinstall needed" and starts nothing when the runtime is missing', async () => {
  const home = tmp();
  const rpc = rpcChild({ MODULE_SETTINGS: JSON.stringify(SETTINGS), CONNECTOR_DATA_HOME: home, MODULE_RUNTIME_DIR: path.join(tmp(), 'runtime') });
  try {
    const init = await rpc.call('initialize', { protocolVersion: '2024-11-05' });
    assert.strictEqual(init.result.serverInfo.name, 'remote-computers');
    const list = await rpc.call('tools/list');
    assert.deepStrictEqual(list.result.tools.map((t) => t.name).sort(), TOOLS.map((t) => t.name).sort());
    const h = await health(rpc);
    assert.deepStrictEqual({ ok: h.ok, running: h.running, version: h.version, group: h.group, computers: h.computers }, { ok: false, running: false, version: '1.3.1', group: null, computers: null });
    assert.deepStrictEqual(h.warnings, []);
    assert.strictEqual(h.waiting, REINSTALL);
    assert.match(REINSTALL, /Reinstall needed: open Data connectors and run Install again/);
    const started = JSON.parse((await rpc.tool('start')).content[0].text);
    assert.strictEqual(started.waiting, REINSTALL);
    assert.deepStrictEqual(fs.readdirSync(home), [], 'nothing was created');
  } finally { await rpc.close(); }
  // The same when no runtime folder is given at all.
  const rpc2 = rpcChild({ MODULE_SETTINGS: JSON.stringify(SETTINGS), CONNECTOR_DATA_HOME: tmp() });
  try { assert.strictEqual((await health(rpc2)).waiting, REINSTALL); } finally { await rpc2.close(); }
});

test('server.js reports "Waiting for setup" and starts nothing when the name or address is not set', async () => {
  const home = tmp();
  const rpc = rpcChild({ MODULE_SETTINGS: JSON.stringify({ ...SETTINGS, address_name: '' }), CONNECTOR_DATA_HOME: home, MODULE_RUNTIME_DIR: fakeRuntime() });
  try {
    await rpc.call('initialize', {});
    await new Promise((r) => setTimeout(r, 200));
    const h = await health(rpc);
    assert.strictEqual(h.ok, false);
    assert.strictEqual(h.running, false);
    assert.strictEqual(h.waiting, WAITING);
    assert.strictEqual(h.group, null);
    assert.strictEqual((JSON.parse((await rpc.tool('start')).content[0].text)).waiting, WAITING);
    assert.deepStrictEqual(fs.readdirSync(home), [], 'no config, accounts or log were made');
    // The agent tools refuse a caller the hub did not name, and say plainly that the server is not ready; the one that arrives later says so.
    const full = { computer: 'x', command: 'dir', x: 1, y: 1, text: 'a', keys: 'a', amount: 1 };
    for (const name of ['computers', 'info', 'screenshot', 'run', 'click', 'type', 'key', 'scroll']) {
      const anon = await rpc.tool(name, full);
      assert.strictEqual(anon.isError, true, name);
      assert.match(anon.content[0].text, /did not say which agent/, name);
      const named = await rpc.tool(name, { ...full, __agent: 'sam' });
      assert.strictEqual(named.isError, true, name);
      assert.match(named.content[0].text, /not ready yet: Waiting for setup/, name);
    }
    const later = await rpc.tool('installer_link', {});
    assert.strictEqual(later.isError, true);
    assert.match(later.content[0].text, /tailnet name/);   // it is real now (it needs the tailnet name from the settings)
    const unknown = await rpc.call('tools/call', { name: 'nope', arguments: {} });
    assert.strictEqual(unknown.error.code, -32602);
  } finally { await rpc.close(); }
});

test('the server starts MeshCentral, makes the group and reports health (stand-in process and sockets)', async () => {
  const runtimeDir = fakeRuntime(), home = tmp();
  const execFile = fakeExec();
  const spawn = fakeSpawn();
  const sockets = [];
  class Mesh extends FakeWebSocket {
    constructor(url, opts) {
      super(url, opts); sockets.push(this);
      this.user = Buffer.from(opts.headers['x-meshauth'].split(',')[0], 'base64').toString();
      setImmediate(() => this.deliver({ action: 'userinfo', userinfo: { name: this.user } }));
      this.on('sent', (f) => setImmediate(() => {
        if (f.action === 'createmesh') this.deliver({ action: 'createmesh', responseid: f.responseid, result: 'ok', meshid: 'mesh//g1' });
        if (f.action === 'addmeshuser') this.deliver({ action: 'addmeshuser', responseid: f.responseid, result: 'Added user maestro', success: 1, failed: 0 });
        if (f.action === 'nodes') this.deliver({ action: 'nodes', responseid: f.responseid, nodes: { 'mesh//g1': [{ _id: 'node//a' }, { _id: 'node//b' }] } });
      }));
    }
  }
  const logs = [];
  // The certificate the server waits for appears as MeshCentral would write it.
  const remote = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify(SETTINGS), CONNECTOR_DATA_HOME: home, MODULE_RUNTIME_DIR: runtimeDir },
    write: () => {}, log: (...a) => logs.push(a.join(' ')),
    deps: { WebSocket: Mesh, mesh: { spawn, execFile, probe: async () => true } },
  });
  fs.mkdirSync(remote.mesh.paths.dataPath, { recursive: true });
  fs.writeFileSync(remote.mesh.paths.rootCert, 'ROOT-CA');
  const h = JSON.parse((await remote.callTool('start')) && JSON.stringify(await remote.callTool('health')));
  assert.strictEqual(h.ok, true, JSON.stringify(h));
  assert.strictEqual(h.running, true);
  assert.strictEqual(h.group, 'mesh//g1');
  assert.strictEqual(h.computers, 2, 'registered computers');
  assert.strictEqual(h.online, 0, 'none of the stand-in nodes has conn set');
  assert.strictEqual(h.version, '1.3.1');
  assert.deepStrictEqual(execFile.calls.length, 3);
  assert.ok(execFile.calls.every((c) => !c.args.includes('--pass')));
  assert.strictEqual(spawn.calls.length, 1);
  assert.deepStrictEqual(sockets.map((s) => s.user), ['admin', 'maestro'], 'the admin sets the group up, the limited account reads the list');
  assert.strictEqual(sockets[0].opts.ca.toString(), 'ROOT-CA');
  assert.strictEqual(sockets[0].url, 'wss://127.0.0.1:9971/control.ashx');
  assert.strictEqual(sockets[0].opts.servername, 'hub.example.ts.net');
  assert.deepStrictEqual(sockets[0].sent.map((f) => f.action), ['createmesh', 'addmeshuser']);
  assert.strictEqual(sockets[0].sent[1].meshadmin, 1263104);
  assert.strictEqual(sockets[0].closed, true, 'the admin session is closed after the setup');
  // start again: idempotent
  const again = await remote.callTool('start');
  assert.strictEqual(again.ok, true);
  assert.strictEqual(spawn.calls.length, 1);
  assert.strictEqual(execFile.calls.length, 3);
  // nothing secret in anything said
  const acc = JSON.parse(fs.readFileSync(remote.mesh.paths.accountsFile, 'utf8'));
  const everything = JSON.stringify([h, again, logs]);
  assert.ok(!everything.includes(acc.admin.pass) && !everything.includes(acc.agent.pass) && !everything.includes('accounts.json'));
  await remote.stop();
  assert.deepStrictEqual(spawn.calls[0].proc.signals, ['SIGTERM']);
});

const remoteWith = (mesh, extra = {}) => createRemote({
  env: { MODULE_SETTINGS: JSON.stringify(SETTINGS), CONNECTOR_DATA_HOME: tmp(), MODULE_RUNTIME_DIR: fakeRuntime() },
  write: () => {}, log: () => {}, deps: { mesh, ...extra },
});

test('stop during bootstrap: the start sequence never goes on to start MeshCentral, and stop waits for it to settle', async () => {
  const execFile = hangingExec();
  const spawn = fakeSpawn();
  const remote = remoteWith({ execFile, spawn, probe: async () => true });
  await remote.start();
  await flush();
  assert.strictEqual(execFile.calls.length, 1, 'bootstrap is running its first command');
  await remote.stop();
  assert.deepStrictEqual(execFile.calls[0].proc.signals, ['SIGTERM']);
  assert.strictEqual(spawn.calls.length, 0, 'mesh.start() was never reached');
  assert.strictEqual(execFile.calls.length, 1);
  assert.strictEqual(remote.state.phase, 'stopped');
  assert.strictEqual(remote.state.lastError, null, 'a stop is not an error');
  assert.strictEqual(remote.isStopping(), true);
  // After a stop the sequence does not start again.
  await remote.callTool('start');
  assert.strictEqual(spawn.calls.length, 0);
});

test('stop while MeshCentral is starting: the process is stopped, no group is made, and stop returns', async () => {
  const spawn = fakeSpawn();
  let probes = 0;
  const sockets = [];
  class Mesh extends FakeWebSocket { constructor(url, o) { super(url, o); sockets.push(this); } }
  const remote = remoteWith({ execFile: fakeExec(), spawn, probe: async () => { probes += 1; return false; } }, { WebSocket: Mesh });
  fs.mkdirSync(remote.mesh.paths.dataPath, { recursive: true });
  fs.writeFileSync(remote.mesh.paths.rootCert, 'ROOT-CA');
  await remote.start();
  for (let i = 0; i < 20 && !spawn.calls.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(spawn.calls.length, 1);
  await remote.stop();
  assert.ok(spawn.calls[0].proc.signals.includes('SIGTERM'));
  assert.strictEqual(sockets.length, 0, 'no control connection was opened');
  assert.notStrictEqual(remote.state.phase, 'ready');
  assert.strictEqual(remote.mesh.status().running, false);
});

// ── the server check (index.js) ──
test('the server check is ok only when the control connection works (health.ok === true), and counts registered computers', async () => {
  const run = (h) => checks.server({ callTool: async () => JSON.stringify(h), parse: (t) => JSON.parse(t), settings: {} });
  const base = { running: true, group: 'mesh//g1', warnings: [] };
  const a = await run({ ...base, ok: false, lastError: 'login refused', computers: null });
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.summary, 'login refused');
  const b = await run({ ...base, ok: false, warnings: ['The computer list could not be read (ETIMEDOUT).', 'second'] });
  assert.deepStrictEqual([b.ok, b.summary], [false, 'The computer list could not be read (ETIMEDOUT).']);
  const c = await run({ ...base, ok: false });
  assert.deepStrictEqual([c.ok, c.summary], [false, 'The control connection is not ready.']);
  const d = await run({ ...base, ok: true, computers: 3, online: 1 });
  assert.deepStrictEqual([d.ok, d.summary], [true, 'The server is running. 3 computers registered, 1 online.']);
  assert.strictEqual((await run({ ...base, ok: true, computers: 1, online: 0 })).summary, 'The server is running. 1 computer registered, 0 online.');
  assert.strictEqual((await run({ ...base, ok: true, computers: 0, online: 0 })).summary, 'The server is running. No computer has been added yet.');
  assert.strictEqual((await run({ running: false, group: null, ok: false })).ok, false);
  assert.strictEqual((await run({ running: true, group: null, ok: false })).ok, false);
});

test('a failed start is reported in health and can be retried', async () => {
  const runtimeDir = fakeRuntime(), home = tmp();
  const remote = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify(SETTINGS), CONNECTOR_DATA_HOME: home, MODULE_RUNTIME_DIR: runtimeDir },
    write: () => {}, log: () => {},
    deps: { mesh: { execFile: fakeExec('Something else\n'), spawn: fakeSpawn(), probe: async () => true } },
  });
  const h = await remote.callTool('start');
  assert.strictEqual(h.ok, false);
  assert.match(h.lastError, /Could not create the admin account/);
  assert.strictEqual(h.running, false);
  assert.strictEqual(h.computers, null);
  await remote.stop();
});

test('on a system other than Linux, health and the server check say it needs Linux for now, the agent tools refuse, and nothing starts', async () => {
  const LINUX_ONLY = 'Remote computers needs My Maestro on Linux for now.';
  for (const platform of ['win32', 'darwin']) {
    const runtimeDir = fakeRuntime(), home = tmp();
    const exec = fakeExec('Done.\n'), spawn = fakeSpawn();
    const remote = createRemote({
      env: { MODULE_SETTINGS: JSON.stringify(SETTINGS), CONNECTOR_DATA_HOME: home, MODULE_RUNTIME_DIR: runtimeDir },
      write: () => {}, log: () => {},
      deps: { platform, mesh: { execFile: exec, spawn, probe: async () => true } },
    });
    await remote.start();
    const started = await remote.callTool('start');
    for (const h of [started, await remote.callTool('health')]) {
      assert.strictEqual(h.ok, false, platform);
      assert.strictEqual(h.waiting, LINUX_ONLY, platform);
      assert.strictEqual(h.running, false);
    }
    assert.strictEqual(spawn.calls.length, 0, 'no server process');
    assert.strictEqual(exec.calls.length, 0, 'no setup command');
    assert.strictEqual(remote.state.phase, 'unsupported');
    await assert.rejects(remote.callTool('computers', { __agent: 'maestro' }), (e) => e.message === LINUX_ONLY);
    // The server check shows the same words, whatever the tool said.
    const check = await checks.server({ platform, settings: {}, parse: JSON.parse, callTool: async () => JSON.stringify(started) });
    assert.deepStrictEqual([check.ok, check.summary], [false, LINUX_ONLY]);
    await remote.stop();
  }
  // On Linux (the test machine) the platform is not an obstacle.
  const runtimeDir = fakeRuntime(), home = tmp();
  const remote = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify(SETTINGS), CONNECTOR_DATA_HOME: home, MODULE_RUNTIME_DIR: runtimeDir },
    write: () => {}, log: () => {}, deps: { platform: 'linux', mesh: { execFile: fakeExec('Something else\n'), spawn: fakeSpawn(), probe: async () => true } },
  });
  assert.notStrictEqual((await remote.callTool('start')).waiting, LINUX_ONLY);
  await remote.stop();
});
