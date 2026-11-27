'use strict';
// When scopes break: the Bash tool re-runs a command whose scope never started (once, unscoped); the clients are probed fresh
// before each spawn; with no systemd the best-effort watchdog (lib/mem-watch) is wired in. Fake spawns and fake ps: nothing real runs.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const sw = require('../lib/scope-wrap');
const memLimit = require('../lib/mem-limit');
const { createHubTools } = require('../lib/hub-tools');
const clientWatch = require('../lib/client-watch');

function fakeChild({ stdout = '', stderr = '', code = 0, pid = 99999998 } = {}) {
  const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = pid;
  setImmediate(() => { if (stdout) c.stdout.emit('data', stdout); if (stderr) c.stderr.emit('data', stderr); c.emit('close', code, null); });
  return c;
}
const scopeStub = (extra = {}) => ({ wrap: (f, a, o) => sw.wrap(f, a, { ...o, can: true, limit: 4 * memLimit.GB }), envFor: (e) => e, failedToStart: sw.failedToStart, resetCache: () => { scopeStub.resets = (scopeStub.resets || 0) + 1; }, ...extra });

test('Bash: a scope that failed to start is never replayed: the first result is returned and only the probe is forgotten', async () => {
  scopeStub.resets = 0;
  const seen = [];
  const spawnImpl = (file, args) => { seen.push(file); return seen.length === 1 ? fakeChild({ stderr: 'Failed to start transient scope unit: Connection refused\n', code: 1 }) : fakeChild({ stdout: 'hello\n' }); };
  const t = createHubTools({ cwd: os.tmpdir(), scopeWrap: scopeStub(), spawnImpl, memLimit: () => null });
  const r = await t.call('Bash', { command: 'echo hello' });
  assert.deepStrictEqual(seen, ['systemd-run'], 'one run, never twice');
  assert.strictEqual(scopeStub.resets, 1, 'the next command probes again');
  assert.match(r.text || String(r), /Failed to start transient scope/);
  assert.doesNotMatch(r.text || String(r), /hello/);
});

test('Bash: a payload that failed (it printed, or another error) is never run twice', async () => {
  scopeStub.resets = 0;
  const seen = [];
  const t = createHubTools({ cwd: os.tmpdir(), scopeWrap: scopeStub(), memLimit: () => null, spawnImpl: (file) => { seen.push(file); return fakeChild({ stdout: 'partial\n', stderr: 'Failed to start transient scope unit', code: 1 }); } });
  await t.call('Bash', { command: 'x' });
  assert.deepStrictEqual(seen, ['systemd-run']);
  const seen2 = [];
  const t2 = createHubTools({ cwd: os.tmpdir(), scopeWrap: scopeStub(), memLimit: () => null, spawnImpl: (file) => { seen2.push(file); return fakeChild({ stderr: 'grep: x: No such file\n', code: 2 }); } });
  await t2.call('Bash', { command: 'x' });
  assert.deepStrictEqual(seen2, ['systemd-run']);
  assert.strictEqual(scopeStub.resets, 0);
});

test('Bash without a scope: the best-effort watchdog watches the command and its stop notice reaches the answer', async () => {
  const watched = [];
  const memWatch = { watch: (pid, o) => { watched.push({ pid, o }); return { stop() { watched[0].stopped = true; } }; } };
  const off = { wrap: (f, a) => ({ file: f, args: a }), envFor: (e) => e };
  const spawnImpl = () => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 4321;
    setImmediate(() => { watched[0].o.onStop('stopped: it used more than 2 GB of memory (best effort, checked every 2 s)'); c.emit('close', null, 'SIGTERM'); });
    return c;
  };
  const t = createHubTools({ cwd: os.tmpdir(), scopeWrap: off, spawnImpl, memLimit: () => 2 * memLimit.GB, memWatch });
  const r = await t.call('Bash', { command: 'big' });
  assert.strictEqual(watched[0].pid, 4321);
  assert.strictEqual(watched[0].o.limitBytes, 2 * memLimit.GB);
  assert.strictEqual(watched[0].o.group, 4321);
  assert.strictEqual(watched[0].stopped, true);
  assert.match(r.text, /stopped: it used more than 2 GB of memory \(best effort, checked every 2 s\)/);
  // a scoped command is never watched by the fallback
  watched.length = 0;
  const t2 = createHubTools({ cwd: os.tmpdir(), scopeWrap: scopeStub(), spawnImpl: () => fakeChild({}), memLimit: () => 2 * memLimit.GB, memWatch });
  await t2.call('Bash', { command: 'x' });
  assert.deepStrictEqual(watched, []);
});

test('the Claude client: probed fresh right before each spawn; unscoped, the watchdog runs and its notice is passed on', () => {
  const wraps = [];
  const spawnImpl = () => { const c = new EventEmitter(); c.pid = 777; c.stderr = new EventEmitter(); return c; };
  const off = { wrap: (f, a, o) => { wraps.push(o); return { file: f, args: a }; }, envFor: (e) => e };
  const watched = []; const told = [];
  const memWatch = { watch: (pid, o) => { watched.push({ pid, o }); return { stop() { watched[0].stopped = true; } }; } };
  const w = clientWatch.forTurn({ agentName: 'a', spawnImpl, scopeWrap: off, memWatch, memLimit: () => 3 * memLimit.GB, onMemoryStop: (t) => told.push(t), log: () => {} });
  const child = w.spawn({ command: '/bin/claude', args: [], cwd: '/tmp', env: {} });
  assert.strictEqual(wraps[0].fresh, true, 'a fresh probe before this spawn');
  assert.strictEqual(watched[0].pid, 777);
  assert.strictEqual(watched[0].o.limitBytes, 3 * memLimit.GB);
  watched[0].o.onStop('stopped: x');
  assert.deepStrictEqual(told, ['stopped: x']);
  child.emit('exit');
  assert.strictEqual(watched[0].stopped, true);
  // scoped: no fallback watcher
  watched.length = 0;
  const on = { wrap: (f, a) => ({ file: 'systemd-run', args: ['--', f, ...a] }), envFor: (e) => e };
  clientWatch.forTurn({ agentName: 'a', spawnImpl, scopeWrap: on, memWatch, memLimit: () => 3 * memLimit.GB }).spawn({ command: '/bin/claude', args: [], cwd: '/tmp', env: {} });
  assert.deepStrictEqual(watched, []);
});

test('Codex spawns probe fresh and are watched without a scope (source check)', () => {
  const chat = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(chat, /label: `codex \$\{agentName\}`, fresh: true/);
  assert.match(chat, /require\('\.\/mem-watch'\)\.watch\(child\.pid/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codex-cli', 'app-server.js'), 'utf8');
  assert.match(app, /label: `codex \$\{agentName\}`, fresh: true/);
  assert.match(app, /memWatch\.watch\(this\.child\.pid/);
});

test('wrap(fresh) probes again only when the cached answer is older than 60 s, with a 2 s timeout', () => {
  sw.resetCache();
  let n = 0; const timeouts = [];
  const spawn = (c, a, o) => { n++; timeouts.push(o.timeout); return { status: 0 }; };
  let t = 1000;
  const o = { spawn, platform: 'linux', now: () => t };
  sw.canScope(o);
  sw.canScope(o);
  assert.strictEqual(n, 1);
  t += 30000;
  sw.canScope({ ...o, fresh: true });
  assert.strictEqual(n, 1, 'a 30 s old answer is good enough for a fresh caller');
  t += 31000;
  sw.canScope({ ...o, fresh: true });
  assert.strictEqual(n, 2, 'older than 60 s: probed again');
  assert.deepStrictEqual(timeouts, [5000, 2000], 'a fresh probe never blocks 5 s');
  sw.resetCache();
});
