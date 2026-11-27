'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sw = require('../lib/scope-wrap');
const memLimit = require('../lib/mem-limit');
const { createHubTools } = require('../lib/hub-tools');
const clientWatch = require('../lib/client-watch');
const { AppServerClient: AppServer } = require('../lib/codex-cli/app-server');

test('canScope: Linux probes once and keeps a success; a failure is probed again after 60 s; non-Linux is always false', () => {
  sw.resetCache();
  let n = 0, ok = false;
  const spawnFake = () => { n++; return { status: ok ? 0 : 1 }; };
  let t = 1000;
  const o = { spawn: spawnFake, platform: 'linux', now: () => t };
  assert.strictEqual(sw.canScope(o), false); assert.strictEqual(n, 1);
  assert.strictEqual(sw.canScope(o), false); assert.strictEqual(n, 1, 'cached inside 60 s');
  t += 61000; ok = true;
  assert.strictEqual(sw.canScope(o), true); assert.strictEqual(n, 2);
  t += 299000;
  assert.strictEqual(sw.canScope(o), true); assert.strictEqual(n, 2, 'a success is kept for 5 minutes');
  t += 2000;
  assert.strictEqual(sw.canScope(o), true); assert.strictEqual(n, 3, 'after 5 minutes a success is probed again');
  assert.strictEqual(sw.canScope({ ...o, platform: 'darwin' }), false); assert.strictEqual(n, 3, 'no probe on a Mac');
  sw.resetCache();
  assert.strictEqual(sw.canScope(o), true); assert.strictEqual(n, 4, 'resetCache forgets a success');
  sw.resetCache();
});

test('probe: runs with the real properties (and plain with no limit)', () => {
  sw.resetCache();
  const seen = [];
  const spawn = (cmd, args) => { seen.push(args.join(' ')); return { status: 0 }; };
  sw.canScope({ spawn, platform: 'linux', limit: 8 * memLimit.GB, fresh: true });
  sw.resetCache();
  sw.canScope({ spawn, platform: 'linux', fresh: true });
  assert.strictEqual(seen[0], ['--user', '--scope', '--quiet', '--collect', ...memLimit.scopeProps(8 * memLimit.GB), 'true'].join(' '), 'the exact launch properties (memLimit.scopeProps)');
  assert.strictEqual(seen[0], `--user --scope --quiet --collect -p MemoryMax=${8 * memLimit.GB} -p MemorySwapMax=0 true`);
  assert.strictEqual(seen[1], '--user --scope --quiet --collect true');
  sw.resetCache();
});

test('failedToStart: systemd-run\'s own failure with no stdout; never a payload failure', () => {
  assert.strictEqual(sw.failedToStart({ code: 1, stdout: '', stderr: 'Failed to start transient scope unit: x\n' }), true);
  assert.strictEqual(sw.failedToStart({ code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' }), true);
  assert.strictEqual(sw.failedToStart({ code: 1, stdout: '', stderr: 'Unknown assignment: Foo=1' }), true);
  assert.strictEqual(sw.failedToStart({ code: 1, stdout: 'ran', stderr: 'Failed to start transient scope unit' }), false, 'the payload printed: it ran');
  assert.strictEqual(sw.failedToStart({ code: 0, stdout: '', stderr: 'Failed to determine x' }), false);
  assert.strictEqual(sw.failedToStart({ code: 2, stdout: '', stderr: 'grep: nothing' }), false);
});

test('wrap: argv with a limit, with no limit, and untouched when scopes are not available', () => {
  const lim = 8 * memLimit.GB;
  const w = sw.wrap('bash', ['-c', 'echo hi'], { can: true, limit: lim, label: 'Bash' });
  assert.strictEqual(w.file, 'systemd-run');
  assert.deepStrictEqual(w.args.slice(0, 4), ['--user', '--scope', '--quiet', '--collect']);
  assert.match(w.args[4], /^--unit=hub-cmd-[0-9a-f]{10}$/);
  assert.ok(w.args.includes(`MemoryMax=${lim}`) && w.args.includes('MemorySwapMax=0'));
  assert.ok(!w.args.some(a => /OOMScoreAdjust/.test(a)), 'systemd-run --scope rejects OOMScoreAdjust');
  assert.deepStrictEqual(w.args.slice(w.args.indexOf('--')), ['--', 'bash', '-c', 'echo hi']);
  const free = sw.wrap('bash', ['-c', 'x'], { can: true, limit: null });
  assert.ok(!free.args.some(a => /MemoryMax/.test(a)));
  assert.deepStrictEqual(free.args.slice(free.args.indexOf('--')), ['--', 'bash', '-c', 'x']);
  assert.notStrictEqual(w.args[4], sw.wrap('bash', [], { can: true, limit: lim }).args[4], 'a fresh unit name each time');
  assert.deepStrictEqual(sw.wrap('bash', ['-c', 'x'], { can: false }), { file: 'bash', args: ['-c', 'x'] });
  sw.resetCache();
  assert.deepStrictEqual(sw.wrap('bash', ['-c', 'x'], { can: sw.canScope({ platform: 'darwin' }) }), { file: 'bash', args: ['-c', 'x'] });
});

test('the in-place claim: a scope-style wrapper that execs keeps the pid, stdio and the group kill working', async () => {
  // fake "systemd-run --scope": drops its own options up to `--` and execs the command in place, as the real one does
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scopewrap-'));
  const fake = path.join(dir, 'fake-run.sh');
  fs.writeFileSync(fake, '#!/bin/bash\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n', { mode: 0o755 });
  const w = sw.wrap('bash', ['-c', 'echo $$; sleep 30 & wait'], { can: true, limit: null });
  const child = spawn(fake, w.args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  await new Promise(r => setTimeout(r, 500));
  assert.strictEqual(Number(out.trim()), child.pid, 'the command runs under the pid the caller got');
  process.kill(-child.pid, 'SIGTERM');   // the caller's group kill
  const code = await new Promise(r => child.on('exit', (c, s) => r(s || c)));
  assert.strictEqual(code, 'SIGTERM');
});

test('hub-tools Bash: the spawn gets systemd-run, and the lockbox helper runs inside it', async () => {
  const seen = [];
  const spawnImpl = (file, args, opts) => { seen.push({ file, args, opts }); const { EventEmitter } = require('events'); const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 99999999; setImmediate(() => c.emit('close', 0, null)); return c; };
  const fakeScope = { wrap: (f, a, o) => sw.wrap(f, a, { ...o, can: true, limit: 4 * memLimit.GB }), envFor: (e) => ({ ...e, XDG_RUNTIME_DIR: '/run/user/1' }) };
  const plain = createHubTools({ cwd: os.tmpdir(), scopeWrap: fakeScope, spawnImpl });
  await plain.call('Bash', { command: 'echo a' });
  assert.strictEqual(seen[0].file, 'systemd-run');
  assert.deepStrictEqual(seen[0].args.slice(seen[0].args.indexOf('--')), ['--', 'bash', '-c', 'echo a']);
  assert.strictEqual(seen[0].opts.env.XDG_RUNTIME_DIR, '/run/user/1');
  const lock = require('../lib/lockbox');
  const boxed = createHubTools({ cwd: os.tmpdir(), scopeWrap: fakeScope, spawnImpl, lockboxFor: async () => ({ profile: { mode: 'watch' }, mode: 'watch' }) });
  await boxed.call('Bash', { command: 'echo b' });
  const lb = lock.argvFor({ mode: 'watch' }, ['bash', '-c', 'echo b']);
  const rest = seen[1].args.slice(seen[1].args.indexOf('--') + 1);
  assert.strictEqual(seen[1].file, 'systemd-run');
  assert.deepStrictEqual(rest, [lb.file, ...lb.args], 'the lockbox helper is what runs inside the scope');
  // no scope available: the command is spawned as before
  const off = createHubTools({ cwd: os.tmpdir(), scopeWrap: { wrap: (f, a) => ({ file: f, args: a }), envFor: (e) => e }, spawnImpl });
  await off.call('Bash', { command: 'echo c' });
  assert.deepStrictEqual([seen[2].file, seen[2].args], ['bash', ['-c', 'echo c']]);
});

test('the Claude client spawn is wrapped (pid tracking unchanged); without scopeWrap it is not', () => {
  const calls = [];
  const spawnImpl = (file, args, opts) => { calls.push({ file, args, opts }); const { EventEmitter } = require('events'); const c = new EventEmitter(); c.pid = 4242; c.stderr = new EventEmitter(); return c; };
  const fakeScope = { wrap: (f, a, o) => sw.wrap(f, a, { ...o, can: true, limit: null }), envFor: (e) => ({ ...e, DBUS_SESSION_BUS_ADDRESS: 'x' }) };
  const w = clientWatch.forTurn({ agentName: 'a', spawnImpl, scopeWrap: fakeScope });
  w.spawn({ command: '/bin/claude', args: ['--print'], cwd: '/tmp', env: { A: '1' } });
  assert.strictEqual(calls[0].file, 'systemd-run');
  assert.deepStrictEqual(calls[0].args.slice(calls[0].args.indexOf('--')), ['--', '/bin/claude', '--print']);
  assert.strictEqual(calls[0].opts.env.DBUS_SESSION_BUS_ADDRESS, 'x');
  assert.strictEqual(w.pid(), 4242, 'the tracked pid is the spawned process (systemd-run execs in place)');
  const w2 = clientWatch.forTurn({ agentName: 'a', spawnImpl });
  w2.spawn({ command: '/bin/claude', args: ['--print'], cwd: '/tmp', env: {} });
  assert.strictEqual(calls[1].file, '/bin/claude');
  // and sdk-chat opts in
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /clientWatch\.forTurn\(\{\s*agentName, onStderr: sdkStderr, scopeWrap: require\('\.\/scope-wrap'\)/);
});

test('Codex: the app-server spawn is wrapped, and the exec path wraps through scope-wrap', () => {
  const calls = [];
  const { EventEmitter } = require('events');
  const spawnImpl = (file, args, opts) => { calls.push({ file, args, opts }); const c = new EventEmitter(); const { PassThrough } = require('stream'); c.pid = 7; c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); return c; };
  const fakeScope = { wrap: (f, a, o) => sw.wrap(f, a, { ...o, can: true, limit: null }), envFor: (e) => e || {} };
  new AppServer({ bin: '/bin/codex', cwd: '/tmp', env: {}, spawnImpl, scopeWrap: fakeScope });
  assert.strictEqual(calls[0].file, 'systemd-run');
  assert.deepStrictEqual(calls[0].args.slice(calls[0].args.indexOf('--')), ['--', '/bin/codex', 'app-server']);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /require\('\.\/scope-wrap'\)\.wrap\(bin, args/);
});
