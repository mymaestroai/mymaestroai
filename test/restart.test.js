'use strict';
// The restart path (a tester's report: the button never restarted a systemd install). Under systemd the process
// signals itself and exits 75; elsewhere safe-restart.sh runs detached with a visible log. Scripts and wiring checked
// at the source level.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const R = require('../lib/restart');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('underSystemd: any of the systemd-provided variables', () => {
  assert.strictEqual(R.underSystemd({}), false);
  assert.strictEqual(R.underSystemd({ INVOCATION_ID: 'abc' }), true);
  assert.strictEqual(R.underSystemd({ JOURNAL_STREAM: '9:1' }), true);
  assert.strictEqual(R.underSystemd({ NOTIFY_SOCKET: '/run/x' }), true);
});

test('systemd mode: no script, a delayed SIGUSR2 to itself, exit code 75 advertised', () => {
  let scheduled = null; let signalled = null; const logs = [];
  const r = R.requestRestart({ projectDir: '/nowhere', reason: 'test', by: 'owner', env: { INVOCATION_ID: 'x' }, platform: 'linux', folder: { kind: 'systemd', unit: 'mymaestroai.service' },
    fsImpl: { ...fs, readFileSync: (f, e) => (String(f).startsWith('/proc/') ? '' : fs.readFileSync(f, e)) }, execImpl: (cmd, args) => (args.includes('MainPID') ? `${process.pid}\n` : ''), setTimeoutImpl: (fn, ms) => { scheduled = { fn, ms }; return { unref() {} }; }, killImpl: (pid, sig) => { signalled = { pid, sig }; }, log: (s) => logs.push(s) });
  assert.strictEqual(r.mode, 'systemd'); assert.match(r.note, /code 75/);
  assert.strictEqual(scheduled.ms, R.SYSTEMD_DELAY_MS);
  scheduled.fn();
  assert.deepStrictEqual(signalled, { pid: process.pid, sig: 'SIGUSR2' });
  assert.ok(logs[0].includes('running under systemd'));
});

test('relaunch mode (no supervisor): scripts/relaunch.js spawned detached with the hub\'s node, args and port, output in a writable log, then SIGUSR2 to itself; a missing script is reported, not thrown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  fs.mkdirSync(path.join(dir, 'scripts')); fs.writeFileSync(path.join(dir, 'scripts', 'relaunch.js'), '// stub\n');
  let spawned = null; let scheduled = null; let signalled = null;
  const r = R.requestRestart({ projectDir: dir, port: 9123, reason: 'test', env: {}, platform: 'linux', argv: ['server.js', '--flag'], pid: 4242,
    spawnImpl: (cmd, args, opts) => { spawned = { cmd, args, opts }; return { unref() {} }; },
    setTimeoutImpl: (fn, ms) => { scheduled = { fn, ms }; return { unref() {} }; }, killImpl: (pid, sig) => { signalled = { pid, sig }; }, log: () => {} });
  assert.strictEqual(r.mode, 'relaunch'); assert.strictEqual(r.log, path.join(dir, 'data', 'restart.log'));
  assert.strictEqual(spawned.cmd, process.execPath);
  assert.deepStrictEqual(spawned.args, [path.join(dir, 'scripts', 'relaunch.js'), '--dir', dir, '--pid', '4242', '--port', '9123', '--argv', '["server.js","--flag"]']);
  assert.strictEqual(spawned.opts.detached, true); assert.strictEqual(spawned.opts.stdio[0], 'ignore'); assert.strictEqual(typeof spawned.opts.stdio[1], 'number', 'output goes to the log, not /dev/null');
  assert.strictEqual(scheduled.ms, R.SYSTEMD_DELAY_MS); scheduled.fn(); assert.deepStrictEqual(signalled, { pid: 4242, sig: 'SIGUSR2' });
  const none = R.requestRestart({ projectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'restart2-')), env: {}, platform: 'linux', log: () => {} });
  assert.match(none.error, /relaunch\.js not found/);
  // port falls back to env.PORT
  spawned = null;
  R.requestRestart({ projectDir: dir, env: { PORT: '7777' }, platform: 'linux', spawnImpl: (c, a, o) => { spawned = a; return { unref() {} }; }, setTimeoutImpl: () => ({ unref() {} }), log: () => {} });
  assert.strictEqual(spawned[spawned.indexOf('--port') + 1], '7777');
});

// launchctl print / systemctl show stand-ins: jobs maps label -> pid (null = loaded, not running); a missing label throws.
const launchctl = (jobs, calls = []) => (cmd, args) => {
  calls.push([cmd, ...args]);
  if (cmd === 'launchctl' && args[0] === 'print') {
    const label = args[1].split('/').pop();
    if (!(label in jobs)) throw new Error('Could not find service');
    return `${label} = {\n\tactive count = 1\n\tstate = ${jobs[label] ? 'running' : 'not running'}\n${jobs[label] ? `\tpid = ${jobs[label]}\n` : ''}\tendpoints = {\n\t\tpid = 999999\n\t}\n}\n`;
  }
  return '';
};
const none = { kind: 'none' };

test('launchd identity: a label counts only when launchd says its job IS this process (legacy com.agent-hub, installer label, this folder\'s own)', () => {
  // the live hub here: legacy label, its own pid
  assert.deepStrictEqual(R.supervisor({ platform: 'darwin', pid: 3475, env: { XPC_SERVICE_NAME: 'com.agent-hub' }, execImpl: launchctl({ 'com.agent-hub': 3475 }), folder: none }), { kind: 'launchd', label: 'com.agent-hub' });
  // an installer-made hub (ai.mymaestro.hub, recorded in data/install.json)
  assert.deepStrictEqual(R.supervisor({ platform: 'darwin', pid: 700, env: { XPC_SERVICE_NAME: 'ai.mymaestro.hub' }, execImpl: launchctl({ 'ai.mymaestro.hub': 700 }), folder: { kind: 'launchd', label: 'ai.mymaestro.hub' } }), { kind: 'launchd', label: 'ai.mymaestro.hub' });
  // a per-install label found only through this folder's service
  assert.deepStrictEqual(R.supervisor({ platform: 'darwin', pid: 701, env: {}, execImpl: launchctl({ 'ai.mymaestro.hub.1a2b3c4d': 701, 'com.agent-hub': 3475 }), folder: { kind: 'launchd', label: 'ai.mymaestro.hub.1a2b3c4d' } }), { kind: 'launchd', label: 'ai.mymaestro.hub.1a2b3c4d' });
  assert.strictEqual(R.launchdLabel({ platform: 'linux', env: { XPC_SERVICE_NAME: 'com.agent-hub' }, folder: none }), null);
});

test('two hubs on one Mac: a hub started from the live hub\'s shell (inherited XPC_SERVICE_NAME=com.agent-hub) is NOT that service, and its Restart never kickstarts it', () => {
  const calls = [];
  const exec = launchctl({ 'com.agent-hub': 3475 }, calls);
  assert.deepStrictEqual(R.supervisor({ platform: 'darwin', pid: 9001, env: { XPC_SERVICE_NAME: 'com.agent-hub' }, execImpl: exec, folder: none }), { kind: 'none' });
  assert.strictEqual(R.launchdLabel({ platform: 'darwin', pid: 9001, env: { XPC_SERVICE_NAME: 'com.agent-hub' }, execImpl: exec, folder: none }), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-two-'));
  fs.mkdirSync(path.join(dir, 'scripts')); fs.writeFileSync(path.join(dir, 'scripts', 'relaunch.js'), '// stub\n');
  let scheduled = null; let spawned = null;
  const r = R.requestRestart({ projectDir: dir, port: 8892, env: { XPC_SERVICE_NAME: 'com.agent-hub' }, platform: 'darwin', pid: 9001, folder: none, execImpl: exec,
    spawnImpl: (c, a) => { spawned = a; return { unref() {} }; }, setTimeoutImpl: (fn, ms) => { scheduled = { fn, ms }; return { unref() {} }; }, killImpl: () => {}, log: () => {} });
  assert.strictEqual(r.mode, 'relaunch', 'it relaunches itself');
  scheduled.fn();
  assert.ok(!calls.some(c => c[1] === 'kickstart'), 'no launchctl kickstart of anything');
  assert.strictEqual(spawned[spawned.indexOf('--pid') + 1], '9001');
});

test('launchd mode: kickstart -k of the verified label only, after the delay', () => {
  const calls = []; let scheduled = null;
  const r = R.requestRestart({ projectDir: '/nowhere', env: { XPC_SERVICE_NAME: 'com.agent-hub' }, platform: 'darwin', pid: 3475, uid: 501, folder: none, execImpl: launchctl({ 'com.agent-hub': 3475, 'ai.mymaestro.hub': 700 }, calls), setTimeoutImpl: (fn, ms) => { scheduled = { fn, ms }; return { unref() {} }; }, log: () => {} });
  assert.strictEqual(r.mode, 'launchd'); scheduled.fn();
  assert.deepStrictEqual(calls.filter(c => c[1] === 'kickstart'), [['launchctl', 'kickstart', '-k', 'gui/501/com.agent-hub']]);
});

test('unknown identity refuses: this folder\'s service runs another process, so nothing is restarted or kickstarted', () => {
  const calls = []; let scheduled = false; let spawned = false;
  const r = R.requestRestart({ projectDir: '/nowhere', env: {}, platform: 'darwin', pid: 9002, folder: { kind: 'launchd', label: 'ai.mymaestro.hub' }, execImpl: launchctl({ 'ai.mymaestro.hub': 700 }, calls),
    spawnImpl: () => { spawned = true; return { unref() {} }; }, setTimeoutImpl: () => { scheduled = true; return { unref() {} }; }, killImpl: () => { throw new Error('must not signal'); }, log: () => {} });
  assert.strictEqual(r.mode, 'refused'); assert.match(r.error, /ai\.mymaestro\.hub is running another process \(pid 700\)/);
  assert.strictEqual(scheduled, false); assert.strictEqual(spawned, false);
  assert.ok(!calls.some(c => c[1] === 'kickstart'));
});

test('systemd identity: the unit from /proc/<pid>/cgroup counts only when its MainPID is this process; inherited variables alone refuse', () => {
  const fsAt = (cg) => ({ ...fs, readFileSync: (f, e) => (String(f).startsWith('/proc/') ? cg : fs.readFileSync(f, e)) });
  const show = (pids) => (cmd, args) => { if (cmd === 'systemctl' && args.includes('MainPID')) { const u = args[args.length - 1]; if (args[0] === '--user' && u in pids) return `${pids[u]}\n`; throw new Error('no'); } return ''; };
  const cg = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/mymaestroai.service\n';
  assert.deepStrictEqual(R.supervisor({ platform: 'linux', pid: 50, env: { INVOCATION_ID: 'x' }, fsImpl: fsAt(cg), execImpl: show({ 'mymaestroai.service': 50 }), folder: none }), { kind: 'systemd', unit: 'mymaestroai.service', scope: 'user' });
  // a hub started from inside another hub's unit (same cgroup, inherited INVOCATION_ID): not that unit's main process
  assert.deepStrictEqual(R.supervisor({ platform: 'linux', pid: 51, env: { INVOCATION_ID: 'x' }, fsImpl: fsAt(cg), execImpl: show({ 'mymaestroai.service': 50 }), folder: none }), { kind: 'none' });
  // systemd's variables but nothing can confirm: refuse rather than guess
  const u = R.supervisor({ platform: 'linux', pid: 52, env: { INVOCATION_ID: 'x' }, fsImpl: fsAt(''), execImpl: show({}), folder: none });
  assert.strictEqual(u.kind, 'unknown'); assert.match(u.reason, /no unit could be confirmed/);
});

test('restartLogTail returns the last lines of the restart and server logs that exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart4-'));
  fs.mkdirSync(path.join(dir, 'data')); fs.writeFileSync(path.join(dir, 'data', 'restart.log'), Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'));
  const t = R.restartLogTail(dir, { lines: 5 });
  assert.strictEqual(t.restart.tail, 'line 45\nline 46\nline 47\nline 48\nline 49');
  assert.strictEqual(t.server, undefined);
});

test('restartLogPath prefers data/restart.log and falls back to the temp dir when data/ is not writable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart3-'));
  assert.strictEqual(R.restartLogPath(dir), path.join(dir, 'data', 'restart.log'));
  const fsNoWrite = { ...fs, mkdirSync: () => {}, accessSync: () => { throw new Error('EACCES'); } };
  assert.strictEqual(R.restartLogPath(dir, fsNoWrite), path.join(os.tmpdir(), 'agent-hub-restart.log'));
});

test('wiring: server handles SIGUSR2 with exit 75 and the button uses lib/restart; the RestartHub tool too; the scripts have the systemd branch and a writable log', () => {
  const server = read('server.js');
  assert.match(server, /process\.on\('SIGUSR2', \(\) => gracefulShutdown\('SIGUSR2', require\('\.\/lib\/restart'\)\.EXIT_RESTART\)\)/);
  assert.match(server, /function gracefulShutdown\(signal, code = 0\)[\s\S]*process\.exit\(code\)/);
  assert.match(server, /require\('\.\/lib\/restart'\)\.requestRestart\(\{ projectDir: __dirname, port: PORT, reason: 'UI button'/);
  assert.match(server, /pathname === '\/api\/restart\/log'/);
  assert.match(server, /return jsonResponse\(res, 200, \{ status: 'ok', bootId: require\('\.\/lib\/hub-events'\)\.BOOT_ID, pid: process\.pid \}\);/, 'health carries the boot id');
  const app = read('app.js');
  assert.match(app, /if \(before && h\.bootId && h\.bootId === before\) throw new Error\('same process'\);/, 'the page never calls the old server answering again a success');
  assert.match(app, /async function restartFailed\(btn, why\)[\s\S]*fetch\('\/api\/restart\/log'/);
  assert.ok(!/spawn\(script, \[\], \{ detached: true, stdio: 'ignore'/.test(server), 'the silent spawn is gone');
  const tools = read('lib/provider-tools.js');
  assert.match(tools, /require\('\.\/restart'\)\.requestRestart\(\{ projectDir, reason, by: 'agent \(RestartHub\)' \}\)/);
  const rs = read('scripts/restart.sh');
  assert.match(rs, /Running under systemd/); assert.match(rs, /systemctl \$_scope restart "\$_unit"/); assert.match(rs, /kill -USR2 "\$_lp"/);
  assert.ok(rs.indexOf('find_listener() {') < rs.indexOf('Running under systemd'), 'the branch comes after find_listener is defined');
  assert.ok(!/com\.agent-hub"/.test(rs), 'no fixed launchd label');
  assert.match(rs, /Not touching it/); assert.match(rs, /_how=1; if \[ -n "\$_jpid" \]; then service_runs "\$_lp" "\$_jpid" && _how=0 \|\| _how=\$\?; fi/, 'kickstarts only the job whose process is the listener (or its wrapper)');
  assert.ok(rs.indexOf('Only ever this folder') < rs.indexOf('Kill what still listens'), 'the folder check comes before any kill');
  assert.match(rs, /nohup env -i "\$\{_keep\[@\]\}" node server\.js/, 'the hub starts with an allow-listed environment');
  const ss = read('scripts/safe-restart.sh');
  assert.match(ss, /data\/restart\.log/); assert.match(ss, /agent-hub-restart\.log/); assert.match(ss, /restart\.sh FAILED/);
  assert.ok(!/^\s*set -e/m.test(ss), 'a failed redirect no longer kills the script silently');
});

// A stand-in /proc: { pid: { ppid, comm, argv, cgroup } }; a pid not listed, or a file listed in `hide`, can't be read.
function procFs(procs, hide = []) {
  return { ...fs, readFileSync: (f, e) => {
    const m = /^\/proc\/(\d+)\/(status|comm|cmdline|cgroup)$/.exec(String(f));
    if (!m) return fs.readFileSync(f, e);
    const p = procs[m[1]];
    if (!p || hide.includes(`${m[1]}/${m[2]}`)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (m[2] === 'status') return `Name:\t${p.comm}\nPPid:\t${p.ppid}\n`;
    if (m[2] === 'comm') return `${p.comm}\n`;
    if (m[2] === 'cmdline') return (p.argv || [p.comm]).join('\0') + '\0';
    return p.cgroup || '';
  } };
}
// systemctl show -p MainPID per scope: { 'user:x.service': 50, 'system:x.service': 60 }; a scope not in `reach` has no bus.
function systemctl(mainPids, reach = ['user', 'system'], calls = []) {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'systemctl') throw new Error(`unexpected ${cmd}`);
    const scope = args[0] === '--user' ? 'user' : 'system';
    if (!reach.includes(scope)) throw new Error('Failed to connect to bus');
    return `${mainPids[`${scope}:${args[args.length - 1]}`] || 0}\n`;
  };
}
const userCg = (unit) => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`;
const sysCg = (unit) => `0::/system.slice/${unit}\n`;
const userManager = { 5: { ppid: 1, comm: 'systemd', argv: ['/usr/lib/systemd/systemd', '--user'] } };

test('a service that runs node through a shell or npm (nvm, npm start) counts: its process is our parent and the manager started it', () => {
  const cg = userCg('mymaestroai.service');
  const hub = { 70: { ppid: 60, comm: 'node', argv: ['node', 'server.js'], cgroup: cg } };
  const sup = (wrapper, mainPid = 60) => R.supervisor({ platform: 'linux', pid: 70, env: {}, fsImpl: procFs({ ...userManager, ...hub, 60: wrapper }), execImpl: systemctl({ 'user:mymaestroai.service': mainPid }), folder: none });
  const systemd = { kind: 'systemd', unit: 'mymaestroai.service', scope: 'user' };
  assert.deepStrictEqual(sup({ ppid: 5, comm: 'bash', argv: ['/bin/bash', '-lc', 'source ~/.nvm/nvm.sh && node server.js'] }), systemd);
  assert.deepStrictEqual(sup({ ppid: 5, comm: 'node', argv: ['node', '/usr/lib/node_modules/npm/bin/npm-cli.js', 'start'] }), systemd);
  assert.deepStrictEqual(sup({ ppid: 5, comm: 'npm start', argv: ['npm start'] }), systemd);
  // not a wrapper, or a wrapper the manager didn't start (a shell inside another process), or not our parent: not ours
  assert.deepStrictEqual(sup({ ppid: 5, comm: 'python3', argv: ['python3', 'x.py'] }), { kind: 'none' });
  assert.deepStrictEqual(R.supervisor({ platform: 'linux', pid: 70, env: {}, fsImpl: procFs({ ...userManager, ...hub, 60: { ppid: 40, comm: 'bash' }, 40: { ppid: 5, comm: 'node' } }), execImpl: systemctl({ 'user:mymaestroai.service': 60 }), folder: none }), { kind: 'none' });
  assert.deepStrictEqual(sup({ ppid: 5, comm: 'bash' }, 61), { kind: 'none' });
  // macOS: launchd reports the wrapper; it counts when its parent is launchd (pid 1)
  const ps = (tree, jobs) => (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print') { const l = args[1].split('/').pop(); if (l in jobs) return `\tpid = ${jobs[l]}\n`; throw new Error('not loaded'); }
    if (cmd === 'ps') { const p = tree[args[args.length - 1]]; if (!p) throw new Error('no such process'); return args[1] === 'args=' ? `${p.args}\n` : `${p.ppid} ${p.comm}\n`; }
    return '';
  };
  const mac = { 70: { ppid: 60, comm: '/n/bin/node', args: '/n/bin/node server.js' }, 60: { ppid: 1, comm: '/bin/bash', args: '/bin/bash -lc node server.js' } };
  assert.deepStrictEqual(R.supervisor({ platform: 'darwin', pid: 70, uid: 501, env: {}, execImpl: ps(mac, { 'ai.mymaestro.hub': 60 }), folder: { kind: 'launchd', label: 'ai.mymaestro.hub' } }), { kind: 'launchd', label: 'ai.mymaestro.hub' });
  const other = R.supervisor({ platform: 'darwin', pid: 70, uid: 501, env: {}, execImpl: ps({ ...mac, 60: { ...mac[60], ppid: 400 }, 400: { ppid: 1, comm: '/sbin/launchd-helper', args: 'x' } }, { 'ai.mymaestro.hub': 60 }), folder: { kind: 'launchd', label: 'ai.mymaestro.hub' } });
  assert.strictEqual(other.kind, 'unknown', 'a shell the manager did not start is not a wrapper of ours');
});

test('a hub started from an agent\'s shell inside another hub\'s unit relaunches itself: the unit\'s process is the other hub', () => {
  const cg = userCg('agent-hub-v5.service');
  const procs = { ...userManager, 10: { ppid: 5, comm: 'node', argv: ['/usr/bin/node', 'server.js'], cgroup: cg }, 30: { ppid: 10, comm: 'claude', cgroup: cg },
    40: { ppid: 30, comm: 'bash', cgroup: cg }, 51: { ppid: 40, comm: 'node', argv: ['node', 'server.js'], cgroup: cg } };
  const calls = [];
  const opts = { platform: 'linux', pid: 51, env: { INVOCATION_ID: 'inherited' }, fsImpl: procFs(procs), execImpl: systemctl({ 'user:agent-hub-v5.service': 10 }, ['user', 'system'], calls), folder: none };
  assert.deepStrictEqual(R.supervisor(opts), { kind: 'none' });
  // even with the shell started right under the other hub, and with no bus to ask
  const direct = { ...procs, 40: { ppid: 10, comm: 'bash', cgroup: cg } };
  assert.deepStrictEqual(R.supervisor({ ...opts, fsImpl: procFs(direct) }), { kind: 'none' });
  assert.deepStrictEqual(R.supervisor({ ...opts, fsImpl: procFs(direct), execImpl: systemctl({}, []) }), { kind: 'none' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-agent-shell-'));
  fs.mkdirSync(path.join(dir, 'scripts')); fs.writeFileSync(path.join(dir, 'scripts', 'relaunch.js'), '// stub\n');
  const r = R.requestRestart({ ...opts, projectDir: dir, port: 8899, spawnImpl: () => ({ unref() {} }), setTimeoutImpl: () => ({ unref() {} }), killImpl: () => {}, log: () => {} });
  assert.strictEqual(r.mode, 'relaunch');
  assert.ok(!calls.some(c => c.includes('restart')), 'systemd is never asked to restart anything');
});

test('no bus to ask systemd: the unit in the cgroup counts only when systemd itself started this process', () => {
  const cg = sysCg('mymaestroai.service');
  const noBus = systemctl({}, []);
  const sup = (procs, hide) => R.supervisor({ platform: 'linux', pid: 70, env: { INVOCATION_ID: 'x' }, fsImpl: procFs(procs, hide), execImpl: noBus, folder: none });
  const systemd = { kind: 'systemd', unit: 'mymaestroai.service', scope: 'system' };
  assert.deepStrictEqual(sup({ 70: { ppid: 1, comm: 'node', cgroup: cg } }), systemd);
  assert.deepStrictEqual(sup({ 70: { ppid: 60, comm: 'node', cgroup: cg }, 60: { ppid: 1, comm: 'bash' } }), systemd, 'through a wrapper');
  assert.deepStrictEqual(sup({ 70: { ppid: 40, comm: 'node', cgroup: cg }, 40: { ppid: 30, comm: 'bash' }, 30: { ppid: 1, comm: 'claude' } }), { kind: 'none' }, 'an agent\'s shell: relaunch');
  const u = sup({ 70: { ppid: 1, comm: 'node', cgroup: cg } }, ['70/status']);
  assert.strictEqual(u.kind, 'unknown', 'this process can\'t be looked at: refused, not guessed'); assert.match(u.reason, /can't be asked/);
});

test('a user unit with the same name as the system unit running this hub: both scopes are asked', () => {
  const procs = { 200: { ppid: 1, comm: 'node', cgroup: sysCg('mymaestroai.service') } };
  const mainPids = { 'user:mymaestroai.service': 100, 'system:mymaestroai.service': 200 };
  assert.deepStrictEqual(R.supervisor({ platform: 'linux', pid: 200, env: {}, fsImpl: procFs(procs), execImpl: systemctl(mainPids), folder: { kind: 'systemd', unit: 'mymaestroai.service' } }),
    { kind: 'systemd', unit: 'mymaestroai.service', scope: 'system' });
  // and the other way round: a user unit running this hub, a system unit of that name running something else
  const mine = { 100: { ppid: 5, comm: 'node', cgroup: userCg('mymaestroai.service') }, ...userManager };
  assert.deepStrictEqual(R.supervisor({ platform: 'linux', pid: 100, env: {}, fsImpl: procFs(mine), execImpl: systemctl(mainPids), folder: none }),
    { kind: 'systemd', unit: 'mymaestroai.service', scope: 'user' });
});

test('wrapper chains (bash -> npm -> sh -> node, a #! start script) count; a wrapper whose unit also runs another hub does not', () => {
  const cg = userCg('mymaestroai.service');
  const chain = { ...userManager, 70: { ppid: 63, comm: 'node', argv: ['node', 'server.js'], cgroup: cg }, 63: { ppid: 62, comm: 'sh', argv: ['sh', '-c', 'node server.js'] },
    62: { ppid: 60, comm: 'npm start', argv: ['npm start'] }, 60: { ppid: 5, comm: 'bash', argv: ['/bin/bash', '-lc', 'npm start'] } };
  const show = (unitText) => (cmd, args) => {
    if (cmd !== 'systemctl') throw new Error('unexpected');
    if (args.includes('cat')) { if (unitText === null) throw new Error('no bus'); return unitText; }
    return args[0] === '--user' ? 'MainPID=60\n' : 'MainPID=0\n';
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-chain-'));
  const sup = (procs, unitText = '') => R.supervisor({ platform: 'linux', pid: 70, env: { XDG_RUNTIME_DIR: home }, home, projectDir: '/srv/hub-a', fsImpl: procFs(procs), execImpl: show(unitText), folder: none });
  const systemd = { kind: 'systemd', unit: 'mymaestroai.service', scope: 'user' };
  assert.deepStrictEqual(sup(chain), systemd, 'bash -> npm -> sh -> node');
  const script = { ...userManager, 70: { ppid: 60, comm: 'node', argv: ['node', 'server.js'], cgroup: cg }, 60: { ppid: 5, comm: 'start.sh', argv: ['/bin/bash', '/home/u/hub/start.sh'] } };
  assert.deepStrictEqual(sup(script), systemd, 'a #! script runs as its shell');
  const twoHubs = "[Service]\nExecStart=/bin/bash -c 'node /srv/hub-a/server.js & node /srv/hub-b/server.js & wait'\n";
  assert.deepStrictEqual(sup(script, twoHubs), { kind: 'none' }, 'one wrapper running two hubs: restarting it would take the other hub down');
  assert.deepStrictEqual(sup(script, "[Service]\nExecStart=/bin/bash -c 'node /srv/hub-a/server.js'\n"), systemd);
  // a chain broken by something that is not a wrapper (the live hub, claude): not ours
  const broken = { ...chain, 62: { ppid: 60, comm: 'claude', argv: ['claude'] } };
  assert.deepStrictEqual(sup(broken), { kind: 'none' });
});

test('no bus: the cgroup unit\'s own file decides for an adopted process; only the cgroup\'s own scope counts as asked', () => {
  const cg = userCg('agent-hub-v5.service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-nobus-'));
  const runtime = path.join(dir, 'run'); fs.mkdirSync(path.join(runtime, 'systemd/transient'), { recursive: true });
  const unitFile = (txt) => fs.writeFileSync(path.join(runtime, 'systemd/transient/agent-hub-v5.service'), txt);
  // a hand-started hub adopted by the user manager (its shell exited), no bus to ask
  const procs = { ...userManager, 51: { ppid: 5, comm: 'node', argv: ['node', 'server.js'], cgroup: cg } };
  const sup = (execImpl) => R.supervisor({ platform: 'linux', pid: 51, projectDir: '/srv/test-hub', home: dir, env: { XDG_RUNTIME_DIR: runtime }, fsImpl: procFs(procs), execImpl, folder: none });
  unitFile('[Service]\nWorkingDirectory=/srv/live-hub\nExecStart=/usr/bin/node /srv/live-hub/server.js\n');
  assert.deepStrictEqual(sup(systemctl({}, [])), { kind: 'none' }, 'the unit runs another hub: this one relaunches itself');
  unitFile('[Service]\nExecStart=/usr/bin/node /srv/test-hub/server.js\n');
  assert.deepStrictEqual(sup(systemctl({}, [])), { kind: 'systemd', unit: 'agent-hub-v5.service', scope: 'user' }, 'its own unit: systemd brings it back');
  // the user bus is down but the system bus answers 0 for that name: still "can't ask", so the file decides (not a relaunch race)
  unitFile('[Service]\nExecStart=/usr/bin/node /srv/test-hub/server.js\n');
  assert.deepStrictEqual(sup(systemctl({}, ['system'])), { kind: 'systemd', unit: 'agent-hub-v5.service', scope: 'user' });
});
