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
  assert.deepStrictEqual(w.args.slice(0, 3), ['--user', '--scope', '--quiet']);
  assert.ok(!w.args.includes('--collect'), 'no --collect: a scope killed for memory stays loaded until its Result is read');
  assert.match(w.args[3], /^--unit=hub-cmd-[0-9a-f]{10}$/);
  assert.strictEqual(w.unit, w.args[3].slice('--unit='.length) + '.scope');
  assert.strictEqual(w.limit, lim);
  assert.ok(w.args.includes(`MemoryMax=${lim}`) && w.args.includes('MemorySwapMax=0'));
  assert.ok(!w.args.some(a => /OOMScoreAdjust/.test(a)), 'systemd-run --scope rejects OOMScoreAdjust');
  assert.deepStrictEqual(w.args.slice(w.args.indexOf('--')), ['--', 'bash', '-c', 'echo hi']);
  const free = sw.wrap('bash', ['-c', 'x'], { can: true, limit: null });
  assert.ok(!free.args.some(a => /MemoryMax/.test(a)));
  assert.deepStrictEqual(free.args.slice(free.args.indexOf('--')), ['--', 'bash', '-c', 'x']);
  assert.notStrictEqual(w.args[3], sw.wrap('bash', [], { can: true, limit: lim }).args[3], 'a fresh unit name each time');
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

// ── round 5: a command that ends by a signal is asked for its scope's Result (the scope is kept: no --collect) ──
const { EventEmitter: EE } = require('events');
const fakeChild = (end) => { const c = new EE(); const { PassThrough } = require('stream'); c.pid = 99999999; c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); setImmediate(() => end(c)); return c; };
const scopeSpy = (result, extra = {}) => {
  const calls = [];
  const exec = (cmd, args, o, cb) => { calls.push(args.slice(1).join(' ')); cb(null, args[1] === 'show' ? result + '\n' : ''); };
  return { calls, scope: { wrap: (f, a, o) => sw.wrap(f, a, { ...o, can: true, limit: 4 * memLimit.GB }), envFor: (e) => e, afterSignal: (unit, o) => sw.afterSignal(unit, { ...o, exec }), ...extra } };
};

test('afterSignal: oom-kill gives the notice, then reset-failed clears the scope; anything else gives null (and still clears)', async () => {
  for (const [result, want] of [['oom-kill', 'Stopped because memory ran short (the limit for one command is 4 GB; you can ask your Maestro to raise it)'], ['success', null], ['', null]]) {
    const calls = [];
    const exec = (cmd, args, o, cb) => { calls.push([cmd, ...args]); cb(null, args[1] === 'show' ? result : ''); };
    assert.strictEqual(await sw.afterSignal('hub-cmd-abc.scope', { exec, limit: 4 * memLimit.GB }), want);
    assert.deepStrictEqual(calls, [['systemctl', '--user', 'show', 'hub-cmd-abc.scope', '-p', 'Result', '--value'], ['systemctl', '--user', 'reset-failed', 'hub-cmd-abc.scope']]);
  }
  assert.strictEqual(await sw.afterSignal('u.scope', { exec: (c, a, o, cb) => cb(new Error('no systemctl')) }), null, 'errors are swallowed');
});

test('hub-tools Bash: a command killed by a signal in a scope that says oom-kill gets the Stopped notice; the scope is then reset', async () => {
  const spy = scopeSpy('oom-kill');
  const spawnImpl = () => fakeChild(c => c.emit('close', null, 'SIGKILL'));
  const t = createHubTools({ cwd: os.tmpdir(), scopeWrap: spy.scope, spawnImpl });
  const r = await t.call('Bash', { command: 'python big.py' });
  const text = typeof r === 'string' ? r : (r && r.text) || JSON.stringify(r);
  assert.match(text, /Stopped because memory ran short \(the limit for one command is 4 GB; you can ask your Maestro to raise it\)/);
  assert.ok(!/it used more than/.test(text), 'no claim that the command itself exceeded the limit');
  assert.strictEqual(spy.calls.length, 2);
  assert.match(spy.calls[0], /^show hub-cmd-[0-9a-f]{10}\.scope -p Result --value$/);
  assert.match(spy.calls[1], /^reset-failed hub-cmd-[0-9a-f]{10}\.scope$/);
});

test('hub-tools Bash: a signal end with Result success has no notice; a zero exit costs no extra call; any non-zero exit reads and clears the scope', async () => {
  const sigEnd = scopeSpy('success');
  const t1 = createHubTools({ cwd: os.tmpdir(), scopeWrap: sigEnd.scope, spawnImpl: () => fakeChild(c => c.emit('close', null, 'SIGTERM')) });
  const r1 = await t1.call('Bash', { command: 'sleep 9' });
  assert.ok(!/Stopped because/.test(typeof r1 === 'string' ? r1 : (r1 && r1.text) || ''));
  assert.strictEqual(sigEnd.calls.length, 2, 'asked once, cleared once');
  const normal = scopeSpy('oom-kill');
  const t2 = createHubTools({ cwd: os.tmpdir(), scopeWrap: normal.scope, spawnImpl: () => fakeChild(c => c.emit('close', 0, null)) });
  const r2 = await t2.call('Bash', { command: 'true' });
  assert.ok(!/Stopped because/.test(typeof r2 === 'string' ? r2 : (r2 && r2.text) || ''));
  assert.deepStrictEqual(normal.calls, [], 'exit 0: no systemctl call');
  for (const code of [1, 2, 127]) {
    const failed = scopeSpy('success');
    const t3 = createHubTools({ cwd: os.tmpdir(), scopeWrap: failed.scope, spawnImpl: () => fakeChild(c => c.emit('close', code, null)) });
    await t3.call('Bash', { command: 'false' });
    assert.strictEqual(failed.calls.length, 2, `exit ${code}: Result read, then reset-failed`);
    assert.match(failed.calls[1], /^reset-failed hub-cmd-[0-9a-f]{10}\.scope$/);
  }
  // the Claude client and Codex app-server: exit 1 also clears; exit 0 asks nothing
  const spy4 = scopeSpy('success'); const ch = new EE(); ch.pid = 4244; ch.stderr = new EE();
  clientWatch.forTurn({ agentName: 'a', spawnImpl: () => ch, scopeWrap: spy4.scope, onMemoryStop: () => {}, log: () => {} }).spawn({ command: '/bin/claude', args: ['--print'], cwd: '/tmp', env: {} });
  ch.emit('exit', 1, null);
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(spy4.calls.length, 2, 'client exit 1');
  const { PassThrough } = require('stream');
  const spy5 = scopeSpy('success'); const c5 = new EE(); c5.pid = 10; c5.stdin = new PassThrough(); c5.stdout = new PassThrough(); c5.stderr = new PassThrough();
  const srv = new AppServer({ bin: '/bin/codex', cwd: '/tmp', env: {}, spawnImpl: () => c5, scopeWrap: spy5.scope });
  const ex = srv.whenExited(); const oe = console.error; console.error = () => {};
  try { c5.emit('close', 1, null); await ex; } finally { console.error = oe; }
  assert.strictEqual(spy5.calls.length, 2, 'codex exit 1');
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');   // Codex exec (too entangled to spawn here)
  assert.match(sdk, /if \(w\.unit && \(sig \|\| \(Number\.isInteger\(code\) && code !== 0\)\)\) \{\s*try \{ const t = await require\('\.\/scope-wrap'\)\.afterSignal/);
});

test('exit code >= 128 (no signal) also reads and resets the scope: hub-tools Bash, the Claude client, Codex', async () => {
  const spy = scopeSpy('oom-kill');
  const t = createHubTools({ cwd: os.tmpdir(), scopeWrap: spy.scope, spawnImpl: () => fakeChild(c => c.emit('close', 137, null)) });
  const r = await t.call('Bash', { command: 'python big.py' });
  assert.match(typeof r === 'string' ? r : (r && r.text) || JSON.stringify(r), /Stopped because memory ran short/);
  assert.strictEqual(spy.calls.length, 2);
  const spy2 = scopeSpy('oom-kill'); const got = [];
  const child = new EE(); child.pid = 4243; child.stderr = new EE();
  const w = clientWatch.forTurn({ agentName: 'a', spawnImpl: () => child, scopeWrap: spy2.scope, onMemoryStop: (x) => got.push(x), log: () => {} });
  w.spawn({ command: '/bin/claude', args: ['--print'], cwd: '/tmp', env: {} });
  child.emit('exit', 137, null);
  await new Promise(r2 => setTimeout(r2, 30));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(spy2.calls.length, 2);
  const { PassThrough } = require('stream');
  const spy3 = scopeSpy('oom-kill');
  const c3 = new EE(); c3.pid = 9; c3.stdin = new PassThrough(); c3.stdout = new PassThrough(); c3.stderr = new PassThrough();
  const origErr = console.error; console.error = () => {};
  try {
    const srv = new AppServer({ bin: '/bin/codex', cwd: '/tmp', env: {}, spawnImpl: () => c3, scopeWrap: spy3.scope });
    const ex = srv.whenExited();
    c3.emit('close', 143, null);
    const err = await ex;
    assert.match(err.message, /Stopped because memory ran short/);
    assert.strictEqual(spy3.calls.length, 2);
  } finally { console.error = origErr; }
});

test('the Claude client: ended by a signal inside a scope that says oom-kill -> onMemoryStop gets the notice; a normal end asks nothing', async () => {
  const mkClient = (spy, onMemoryStop) => {
    const child = new EE(); child.pid = 4242; child.stderr = new EE();
    const w = clientWatch.forTurn({ agentName: 'a', spawnImpl: () => child, scopeWrap: spy.scope, onMemoryStop, log: () => {} });
    w.spawn({ command: '/bin/claude', args: ['--print'], cwd: '/tmp', env: {} });
    return child;
  };
  const spy = scopeSpy('oom-kill'); const got = [];
  const c1 = mkClient(spy, (t) => got.push(t));
  c1.emit('exit', null, 'SIGKILL');
  await new Promise(r => setTimeout(r, 30));
  assert.deepStrictEqual(got, ['Stopped because memory ran short (the limit for one command is 4 GB; you can ask your Maestro to raise it)']);
  assert.strictEqual(spy.calls.length, 2);
  const spy2 = scopeSpy('oom-kill'); const got2 = [];
  const c2 = mkClient(spy2, (t) => got2.push(t));
  c2.emit('exit', 0, null);
  await new Promise(r => setTimeout(r, 30));
  assert.deepStrictEqual([got2, spy2.calls], [[], []]);
});

test('Codex app-server: ended by a signal inside a scope that says oom-kill -> the exit error says Stopped: ...', async () => {
  const { PassThrough } = require('stream');
  const spy = scopeSpy('oom-kill');
  const child = new EE(); child.pid = 7; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const origErr = console.error; console.error = () => {};
  try {
    const srv = new AppServer({ bin: '/bin/codex', cwd: '/tmp', env: {}, spawnImpl: () => child, scopeWrap: spy.scope });
    const exited = srv.whenExited();
    child.emit('close', null, 'SIGKILL');
    const err = await exited;
    assert.match(err.message, /Stopped because memory ran short \(the limit for one command is 4 GB; you can ask your Maestro to raise it\)/);
    assert.strictEqual(spy.calls.length, 2);
  } finally { console.error = origErr; }
  const spy2 = scopeSpy('oom-kill');
  const child2 = new EE(); child2.pid = 8; child2.stdin = new PassThrough(); child2.stdout = new PassThrough(); child2.stderr = new PassThrough();
  const srv2 = new AppServer({ bin: '/bin/codex', cwd: '/tmp', env: {}, spawnImpl: () => child2, scopeWrap: spy2.scope });
  const ex2 = srv2.whenExited();
  child2.emit('close', 0, null);
  await ex2;
  assert.deepStrictEqual(spy2.calls, [], 'a normal end asks nothing');
});

test('hub-tools: the dead runOnce parameter is gone (source check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'hub-tools.js'), 'utf8');
  assert.ok(!/runOnce\s*=\s*async\s*\(\s*\w+/.test(src) && !/runOnce\(true\)/.test(src));
});
