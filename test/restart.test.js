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
  const r = R.requestRestart({ projectDir: '/nowhere', reason: 'test', by: 'owner', env: { INVOCATION_ID: 'x' }, setTimeoutImpl: (fn, ms) => { scheduled = { fn, ms }; return { unref() {} }; }, killImpl: (pid, sig) => { signalled = { pid, sig }; }, log: (s) => logs.push(s) });
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

test('launchd mode (macOS service): the label from XPC_SERVICE_NAME or launchctl print; kickstart -k after the delay', () => {
  assert.strictEqual(R.launchdLabel({ platform: 'linux', env: { XPC_SERVICE_NAME: 'com.agent-hub' } }), null);
  assert.strictEqual(R.launchdLabel({ platform: 'darwin', env: { XPC_SERVICE_NAME: 'com.agent-hub' }, execImpl: () => { throw new Error('no'); } }), 'com.agent-hub');
  assert.strictEqual(R.launchdLabel({ platform: 'darwin', env: { XPC_SERVICE_NAME: '0' }, execImpl: () => '' }), 'com.agent-hub', 'launchctl print found the job');
  assert.strictEqual(R.launchdLabel({ platform: 'darwin', env: {}, execImpl: () => { throw new Error('no such job'); } }), null);
  const calls = []; let scheduled = null;
  const r = R.requestRestart({ projectDir: '/nowhere', env: { XPC_SERVICE_NAME: 'com.agent-hub' }, platform: 'darwin', execImpl: (c, a) => { calls.push([c, ...a]); }, setTimeoutImpl: (fn, ms) => { scheduled = { fn, ms }; return { unref() {} }; }, log: () => {} });
  assert.strictEqual(r.mode, 'launchd'); scheduled.fn();
  assert.strictEqual(calls[0][0], 'launchctl'); assert.strictEqual(calls[0][1], 'kickstart'); assert.strictEqual(calls[0][2], '-k'); assert.match(calls[0][3], /^gui\/\d+\/com\.agent-hub$/);
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
  const ss = read('scripts/safe-restart.sh');
  assert.match(ss, /data\/restart\.log/); assert.match(ss, /agent-hub-restart\.log/); assert.match(ss, /restart\.sh FAILED/);
  assert.ok(!/^\s*set -e/m.test(ss), 'a failed redirect no longer kills the script silently');
});
