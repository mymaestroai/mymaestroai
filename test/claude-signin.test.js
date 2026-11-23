'use strict';
// lib/claude-signin.js against the stand-in client (test/fixtures/fake-claude-client.js). No real `claude` program, no real
// HOME: every run uses a temp CLAUDE_CONFIG_DIR. The lib is loaded from a throwaway install (the suite's data guard).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('claude-signin-iso-');
const S = require(path.join(ISO.inst, 'lib', 'claude-signin'));

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'claude-signin-'));
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); fs.rmSync(ISO.root, { recursive: true, force: true }); });
const BIN = path.join(TMP, 'claude');
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-claude-client.js'), BIN);
fs.chmodSync(BIN, 0o755);
const GOOD = 'GOOD-CODE-12345';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(15); }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function setup({ mode = '', verify = async () => ({ ok: true, state: 'ready' }), timeoutMs, signedIn = false, find = () => ({ bin: BIN, source: 'test' }), install } = {}) {
  const cfg = fs.mkdtempSync(path.join(TMP, 'cfg-'));
  if (signedIn) fs.writeFileSync(path.join(cfg, '.credentials.json'), '{}');
  const env = { PATH: process.env.PATH, HOME: cfg, CLAUDE_CONFIG_DIR: cfg, FAKE_CLAUDE_MODE: mode };
  const children = [];
  const spawnSpy = (...a) => { const c = spawn(...a); children.push(c); return c; };
  const si = S.createSignIn({ spawn: spawnSpy, env: () => env, findClient: find, installClient: install, verify, timeoutMs });
  const seen = [];
  const snap = () => { const s = si.state(); seen.push(JSON.stringify(s)); return s; };
  return { si, cfg, env, children, snap, seen, creds: path.join(cfg, '.credentials.json') };
}

test('WORDS never mention the token variable or setup-token', () => {
  const all = JSON.stringify(S.WORDS);
  assert.doesNotMatch(all, /CLAUDE_CODE_OAUTH_TOKEN|setup-token/);
  for (const k of ['code', 'network', 'account', 'limit', 'timeout', 'missing', 'busy', 'error']) assert.ok(S.WORDS.failed[k], k);
});

test('success: link extracted, code accepted, checking, verify ok -> done; the code is in no state', async () => {
  const t = setup();
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => logged.push(a.join(' ')); console.error = console.log; console.warn = console.log;
  try {
    const first = await t.si.start();
    assert.strictEqual(first.ok, true);
    assert.match(first.id, /^[A-Za-z0-9_-]{12}$/);
    const s = await until(() => { const x = t.snap(); return x.state === 'link' && x; }, 'link');
    assert.strictEqual(s.id, first.id, 'state() carries the attempt id');
    assert.strictEqual(s.link, 'https://claude.example/oauth/authorize?code=true&state=standin');
    assert.deepStrictEqual(t.si.submitCode(GOOD), { ok: true });
    await until(() => t.snap().state === 'done', 'done');
    assert.strictEqual(t.si.state().message, S.WORDS.done);
    assert.strictEqual(t.si.state().link, undefined);
  } finally { Object.assign(console, orig); }
  assert.ok(fs.existsSync(t.creds));
  for (const j of t.seen) assert.ok(!j.includes(GOOD), 'the code is never in state');
  assert.ok(!JSON.stringify(t.si.state()).includes(GOOD));
  assert.deepStrictEqual(logged, [], 'client output never reaches console');
});

test('a bad code -> failed code, with the plain sentence', async () => {
  const t = setup();
  await t.si.start();
  await until(() => t.snap().state === 'link', 'link');
  t.si.submitCode('WRONG-CODE-99999');
  const s = await until(() => { const x = t.snap(); return x.state === 'failed' && x; }, 'failed');
  assert.strictEqual(s.reason, 'code');
  assert.strictEqual(s.message, S.WORDS.failed.code);
  assert.ok(!t.seen.join('').includes('WRONG-CODE-99999'));
});

test('no network -> failed network', async () => {
  const t = setup({ mode: 'network' });
  await t.si.start();
  const s = await until(() => { const x = t.snap(); return x.state === 'failed' && x; }, 'failed');
  assert.strictEqual(s.reason, 'network');
});

test('a hung client: the timeout ends it, reason timeout, and the process is gone', async () => {
  const t = setup({ mode: 'hang', timeoutMs: 300 });
  await t.si.start();
  const s = await until(() => { const x = t.snap(); return x.state === 'failed' && x; }, 'timeout');
  assert.strictEqual(s.reason, 'timeout');
  assert.strictEqual(s.message, S.WORDS.failed.timeout);
  const pid = t.children[0].pid;
  await until(() => !alive(pid), 'process end');
});

test('cancel ends the process and the state is cancelled', async () => {
  const t = setup();
  await t.si.start();
  await until(() => t.snap().state === 'link', 'link');
  const pid = t.children[0].pid;
  assert.deepStrictEqual(t.si.cancel(), { ok: true });
  assert.strictEqual(t.si.state().state, 'cancelled');
  await until(() => !alive(pid), 'process end');
  assert.strictEqual(t.si.state().state, 'cancelled');
  // the slot is held until the client has really exited, then a new attempt may start
  let again = await t.si.start();
  for (let i = 0; !again.ok && i < 200; i++) { await sleep(15); again = await t.si.start(); }
  assert.strictEqual(again.ok, true, 'a new attempt may start once the client is gone');
  t.si.cancel();
});

test('a second start while one runs -> busy; the first goes on', async () => {
  const t = setup();
  await t.si.start();
  assert.deepStrictEqual(await t.si.start(), { ok: false, reason: 'busy' });
  assert.strictEqual(t.children.length, 1);
  assert.strictEqual(t.si.state().state === 'failed', false);
  t.si.cancel();
});

test('code format: too short, with a space, empty -> format, and the state stays link', async () => {
  const t = setup();
  await t.si.start();
  await until(() => t.snap().state === 'link', 'link');
  for (const bad of ['ab', 'has space in it', '', null, 'x'.repeat(4097)]) {
    assert.deepStrictEqual(t.si.submitCode(bad), { ok: false, reason: 'format' }, String(bad).slice(0, 10));
    assert.strictEqual(t.si.state().state, 'link');
  }
  assert.strictEqual(t.si.submitCode('  ' + GOOD + ' \n').ok, true, 'trimmed');
  await until(() => t.snap().state === 'done', 'done');
});

test('submitCode outside the link state is refused', async () => {
  const t = setup();
  assert.strictEqual(t.si.submitCode(GOOD).ok, false);
});

test('verify says signed-out -> account; limit -> limit; network -> network; anything else -> error', async () => {
  for (const [state, reason] of [['signed-out', 'account'], ['limit', 'limit'], ['network', 'network'], ['unknown', 'error']]) {
    const t = setup({ verify: async () => ({ ok: false, state }) });
    await t.si.start();
    await until(() => t.snap().state === 'link', 'link');
    t.si.submitCode(GOOD);
    const s = await until(() => { const x = t.snap(); return x.state === 'failed' && x; }, 'failed');
    assert.strictEqual(s.reason, reason, state);
    assert.strictEqual(s.message, S.WORDS.failed[reason]);
  }
});

test('the sign-in succeeds but the status says signed out -> error', async () => {
  const t = setup();
  const si = S.createSignIn({ spawn: (...a) => spawn(...a), env: () => t.env, findClient: () => ({ bin: BIN }), authStatus: async () => ({ loggedIn: false, method: null }), verify: async () => { throw new Error('must not be reached'); } });
  await si.start();
  await until(() => si.state().state === 'link', 'link');
  si.submitCode(GOOD);
  const s = await until(() => { const x = si.state(); return (x.state === 'failed' || x.state === 'done') && x; }, 'end');
  assert.strictEqual(s.state, 'failed');
  assert.strictEqual(s.reason, 'error');
});

test('the person finished in a browser on this computer: a client that exits 0 before any code goes straight to checking', async () => {
  // The client is a fake group leader that prints "Login successful" and reports exit 0 (no real program).
  const script = BIN;
  const quickSpawn = () => {
    const k = fakeKid(9300);
    setImmediate(() => { k.stdout.emit('data', 'Login successful\n'); k.emit('message', { op: 'result', code: 0 }); });
    return k;
  };
  let verified = 0;
  const cfg = fs.mkdtempSync(path.join(TMP, 'cfg-'));
  fs.writeFileSync(path.join(cfg, '.credentials.json'), '{}');
  const real = fs.copyFileSync;
  const si = S.createSignIn({ spawn: quickSpawn, kill: () => { throw ESRCH(); }, env: () => ({ PATH: process.env.PATH, CLAUDE_CONFIG_DIR: cfg }), findClient: () => ({ bin: script }), authStatus: async () => ({ loggedIn: true, method: 'claude.ai' }), verify: async () => { verified++; return { ok: true }; } });
  assert.ok(real);
  await si.start();
  await until(() => si.state().state === 'done', 'done');
  assert.strictEqual(verified, 1);
});

test('clearTokenCache is called before verify when claude-auth has it', async () => {
  const ca = require(path.join(ISO.inst, 'lib', 'claude-auth'));
  const had = Object.prototype.hasOwnProperty.call(ca, 'clearTokenCache');
  const orig = ca.clearTokenCache;
  const order = [];
  ca.clearTokenCache = () => order.push('clear');
  try {
    const t = setup({ verify: async () => { order.push('verify'); return { ok: true }; } });
    await t.si.start();
    await until(() => t.snap().state === 'link', 'link');
    t.si.submitCode(GOOD);
    await until(() => t.snap().state === 'done', 'done');
    assert.deepStrictEqual(order, ['clear', 'verify']);
  } finally { if (had) ca.clearTokenCache = orig; else delete ca.clearTokenCache; }
});

test('no client: installClient is called once, then failed missing when still not found', async () => {
  let installs = 0, finds = 0;
  const t = setup({ find: () => { finds++; return null; }, install: async () => { installs++; return true; } });
  const r = await t.si.start();
  assert.strictEqual(r.ok, true, 'start answers at once; the rest goes on in the background');
  await until(() => t.si.state().state === 'failed', 'failed missing');
  assert.strictEqual(installs, 1);
  assert.strictEqual(finds, 2);
  assert.strictEqual(t.si.state().reason, 'missing');
  assert.strictEqual(t.si.state().message, S.WORDS.failed.missing);
  assert.strictEqual(t.children.length, 0);
});

test('no client at first but the install puts one there: sign-in goes on', async () => {
  let installed = false;
  const t = setup({ find: () => (installed ? { bin: BIN } : null), install: async () => { installed = true; return true; } });
  assert.strictEqual((await t.si.start()).ok, true);
  await until(() => t.snap().state === 'link', 'link');
  t.si.cancel();
});

test('extractLink: after "visit:", else the first https link with oauth, trailing punctuation trimmed, partial chunk is not a link', () => {
  assert.strictEqual(S.extractLink('x\nIf the browser didn\'t open, visit:\nhttps://a.example/oauth/authorize?x=1&y=2.\nPaste'), 'https://a.example/oauth/authorize?x=1&y=2');
  assert.strictEqual(S.extractLink('see https://docs.example/help then https://a.example/oauth/z) \n'), 'https://a.example/oauth/z');
  assert.strictEqual(S.extractLink('visit:\nhttps://a.example/oau'), null);
});

test('authStatus: signed in, signed out (exit 1, no JSON), and an unusable answer', async () => {
  const t = setup({ signedIn: true });
  assert.deepStrictEqual(await S.authStatus({ bin: BIN, env: t.env }), { loggedIn: true, method: 'claude.ai' });
  const o = setup();
  assert.strictEqual((await S.authStatus({ bin: BIN, env: o.env })).loggedIn, false);
  // An unusable answer: a fake client that prints "hello" and exits 3 (no real program).
  const junkSpawn = () => {
    const c = new (require('events').EventEmitter)();
    c.stdout = new (require('events').EventEmitter)();
    setImmediate(() => { c.stdout.emit('data', 'hello'); c.emit('exit', 3); c.emit('close', 3); });
    return c;
  };
  assert.strictEqual((await S.authStatus({ bin: BIN, env: o.env, spawn: junkSpawn })).loggedIn, null);
  // A program that is not the stand-in (here: one that does not exist) is refused at the boundary, before any spawn.
  assert.throws(() => S.authStatus({ bin: path.join(TMP, 'nope'), env: o.env }), /refused to run a real program/);
});

test('findClient: CLAUDE_CLI_PATH as an executable file wins; a directory or a non-executable file is skipped', () => {
  const none = { resolveCli: () => null, sdkDir: path.join(TMP, 'no-sdk'), home: path.join(TMP, 'no-home') };
  assert.deepStrictEqual(S.findClient({ env: { CLAUDE_CLI_PATH: BIN, PATH: '' }, ...none }), { bin: BIN, source: 'CLAUDE_CLI_PATH' });
  const dir = path.join(TMP, 'adir'); fs.mkdirSync(dir);
  assert.strictEqual(S.findClient({ env: { CLAUDE_CLI_PATH: dir, PATH: '' }, ...none }), null);
  const plain = path.join(TMP, 'plain'); fs.writeFileSync(plain, 'x', { mode: 0o644 });
  assert.strictEqual(S.findClient({ env: { CLAUDE_CLI_PATH: plain, PATH: '' }, ...none }), null);
  // falls through to the loader, then PATH, then the home folders
  assert.deepStrictEqual(S.findClient({ env: { CLAUDE_CLI_PATH: dir, PATH: '' }, ...none, resolveCli: () => ({ bin: BIN, source: 'npm-global' }) }), { bin: BIN, source: 'npm-global' });
  assert.deepStrictEqual(S.findClient({ env: { PATH: TMP }, ...none }), { bin: BIN, source: 'PATH' });
  const home = path.join(TMP, 'h'); fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.copyFileSync(BIN, path.join(home, '.local', 'bin', 'claude')); fs.chmodSync(path.join(home, '.local', 'bin', 'claude'), 0o755);
  assert.strictEqual(S.findClient({ env: { PATH: '' }, ...none, home }).source, 'home');
});

test('findClient: the SDK\'s bundled native client next to the SDK package', () => {
  const sdk = path.join(TMP, 'nm', '@anthropic-ai', 'claude-agent-sdk');
  const nat = path.join(TMP, 'nm', '@anthropic-ai', `claude-agent-sdk-linux-${process.arch}-musl`);
  fs.mkdirSync(sdk, { recursive: true }); fs.mkdirSync(nat, { recursive: true });
  fs.copyFileSync(BIN, path.join(nat, 'claude')); fs.chmodSync(path.join(nat, 'claude'), 0o755);
  const r = S.findClient({ env: { PATH: '' }, platform: 'linux', arch: process.arch, resolveCli: () => null, sdkDir: sdk, home: path.join(TMP, 'no-home') });
  assert.deepStrictEqual(r, { bin: path.join(nat, 'claude'), source: 'sdk-bundled' });
});

test('installClient: runs the installer command with bash on linux and darwin only; true on exit 0', async () => {
  const calls = [];
  // The spawn gets the group leader (the supervisor); the installer command reaches it as its `start` message, and the leader
  // answers with its result.
  const fakeSpawn = (code) => Object.assign((cmd, args, opts) => {
    const { EventEmitter } = require('events');
    const c = new EventEmitter();
    c.pid = 9100; c.connected = true;
    c.send = (m, cb) => {
      calls.push([m.bin, m.args, opts]);
      if (cb) cb();
      setImmediate(() => { c.emit('message', { op: 'result', code }); });
      return true;
    };
    c.disconnect = () => {};
    return c;
  }, { __fakeSpawn: true });
  const gone = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
  assert.strictEqual(await S.installClient({ spawn: fakeSpawn(0), platform: 'linux', kill: gone }), true);
  assert.deepStrictEqual(calls[0].slice(0, 2), ['bash', ['-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash']]);
  assert.strictEqual(calls[0][2] && calls[0][2].detached, true, 'its own process group');
  assert.strictEqual(await S.installClient({ spawn: fakeSpawn(1), platform: 'darwin', kill: gone }), false);
  const n = calls.length;
  assert.strictEqual(await S.installClient({ spawn: fakeSpawn(0), platform: 'win32', kill: gone }), false);
  assert.strictEqual(calls.length, n, 'nothing runs on other platforms');
});

// ── attempt ids, the background start, process groups, wrong codes, the exit hook (fake children and a fake clock) ──
const { EventEmitter } = require('node:events');
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
const OVERALL = 777000;
// The client and the installer run in a process group led by a supervisor (lib/claude-signin-group.js): the engine's spawn gets
// the LEADER, the engine talks to it over IPC (start / stop messages), and a leader's exit is followed by probes of its group
// (kill(-pid, 0), never a destructive signal from the parent). The slot is free only when the group is gone (job.drained).
// fakeKid is such a leader: `sent` are the IPC messages it got, `disconnected` is set by job.disconnect().
function fakeKid(pid) {
  const c = new EventEmitter();
  c.pid = pid; c.connected = true; c.sent = []; c.disconnected = false;
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = Object.assign(new EventEmitter(), { written: [], write(s) { this.written.push(String(s)); } });
  c.send = (m, cb) => { c.sent.push(m); if (cb) cb(); return true; };
  c.disconnect = () => { c.connected = false; c.disconnected = true; };
  c.stops = () => c.sent.filter(m => m.op === 'stop').length;
  return c;
}
// What bootstrap installers and the like are handed through onChild: a job (stop, disconnect, drained).
function fakeJob() {
  let drain;
  const j = { stops: 0, disconnects: 0, drained: new Promise((r) => { drain = r; }), drain };
  j.stop = () => { j.stops++; };
  j.disconnect = () => { j.disconnects++; };
  return j;
}
const ESRCH = () => Object.assign(new Error('gone'), { code: 'ESRCH' });
function fakeEngine(o = {}) {
  const kills = [], kids = [], timers = [], spawned = [], gone = new Set();
  let pid = 4000;
  const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; timers.push(t); return t; };
  const clearTimer = (t) => { if (t) t.cleared = true; };
  const si = S.createSignIn({
    spawn: (bin, args, opts) => { const k = fakeKid(++pid); kids.push(k); spawned.push({ bin, args, opts }); return k; },
    // The parent only probes (signal 0); the group is "gone" once the test says so.
    kill: (p, sig) => { kills.push([p, sig]); if (gone.has(p)) throw ESRCH(); }, setTimer, clearTimer, timeoutMs: OVERALL,
    env: () => ({}), findClient: o.find || (() => ({ bin: BIN })), installClient: o.install || (async () => false),
    authStatus: async () => ({ loggedIn: true }), verify: async () => ({ ok: true }), resetCli: o.resetCli, existingClient: o.existing,
  });
  const live = () => timers.filter(t => !t.cleared);
  const fire = (ms) => { const t = live().find(x => x.ms === ms); if (!t) throw new Error('no timer of ' + ms); t.cleared = true; t.fn(); };
  // The leader exits and its whole group is gone: the job drains and the slot is released.
  const exit = async (i = 0) => { gone.add(-kids[i].pid); kids[i].emit('exit', null, 'SIGTERM'); await flush(); };
  const toLink = async () => { const r = await si.start(); await flush(); kids[kids.length - 1].stdout.emit('data', 'visit: https://claude.ai/oauth/authorize?x=1 \n'); return r; };
  return { si, kills, kids, spawned, timers, live, fire, toLink, exit, gone };
}

test('each attempt has its own random id; state() carries it; a stale id is refused by submitCode and cancel', async () => {
  const e = fakeEngine();
  const a = await e.toLink();
  assert.strictEqual(e.si.state().id, a.id);
  assert.strictEqual(e.si.submitCode('ABCDEFGH12345', 'other-id').reason, 'stale');
  assert.deepStrictEqual(e.si.cancel('other-id'), { ok: false, reason: 'stale' });
  assert.strictEqual(e.si.state().state, 'link', 'a stale call changes nothing');
  assert.strictEqual(e.kids[0].stdin.written.length, 0);
  assert.deepStrictEqual(e.si.submitCode('ABCDEFGH12345', a.id), { ok: true });
  assert.deepStrictEqual(e.kids[0].stdin.written, ['ABCDEFGH12345\n']);
  assert.deepStrictEqual(e.si.cancel(a.id), { ok: true });
  assert.strictEqual(e.si.state().state, 'cancelled');
  await e.exit();
  const b = await e.si.start();
  assert.notStrictEqual(b.id, a.id);
  assert.strictEqual(e.si.submitCode('ABCDEFGH12345', a.id).reason, 'stale', 'the old attempt\'s id no longer fits');
  e.si.cancel(b.id);
});

test('only one code is accepted per attempt: a second one is refused with state', async () => {
  const e = fakeEngine();
  const a = await e.toLink();
  assert.strictEqual(e.si.submitCode('ABCDEFGH12345', a.id).ok, true);
  assert.deepStrictEqual(e.si.submitCode('ZZZZZZZZ99999', a.id), { ok: false, reason: 'state' });
  assert.deepStrictEqual(e.kids[0].stdin.written, ['ABCDEFGH12345\n']);
  e.si.cancel();
});

test('start answers at once, before the client is found; the attempt is busy meanwhile', async () => {
  let release;
  const e = fakeEngine({ find: () => new Promise((res) => { release = () => res({ bin: BIN }); }) });
  const r = await e.si.start();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(e.si.state().state, 'starting');
  assert.strictEqual(e.kids.length, 0);
  assert.deepStrictEqual(await e.si.start(), { ok: false, reason: 'busy' });
  release(); await flush();
  assert.strictEqual(e.kids.length, 1);
  e.si.cancel();
});

test('the client is started in its own process group, and cancel asks the group leader to stop (the leader does SIGTERM, then SIGKILL after 3 s, see the drain tests); the slot stays busy until the group is gone', async () => {
  const e = fakeEngine();
  await e.toLink();
  assert.deepStrictEqual(e.kids[0].sent[0], { op: 'start', bin: BIN, args: ['auth', 'login', '--claudeai'], allowReal: false });
  assert.strictEqual(e.spawned[0].opts.detached, true);
  const pid = e.kids[0].pid;
  e.si.cancel();
  assert.strictEqual(e.kids[0].stops(), 1);
  assert.ok(e.kills.every(([, sig]) => sig === 0), 'the parent never sends a destructive signal');
  assert.strictEqual(e.si.state().state, 'cancelled');
  assert.deepStrictEqual(await e.si.start(), { ok: false, reason: 'busy' }, 'the group has not drained yet');
  await e.exit();
  assert.ok(e.kills.some(([p, sig]) => p === -pid && sig === 0), 'the group is probed');
  assert.strictEqual((await e.si.start()).ok, true, 'free once the group is gone');
  e.si.cancel();
});

test('the installer belongs to the attempt: installing state, onChild tracked, cancel ends its process group', async () => {
  let done, gotChild;
  const e = fakeEngine({ find: () => null, install: (o) => { gotChild = fakeJob(); o.onChild(gotChild); return new Promise((res) => { done = res; }); } });
  const r = await e.si.start();
  await flush();
  assert.strictEqual(e.si.state().state, 'installing');
  assert.strictEqual(e.si.state().id, r.id);
  assert.deepStrictEqual(await e.si.start(), { ok: false, reason: 'busy' }, 'installing is a busy state');
  e.si.cancel(r.id);
  assert.strictEqual(gotChild.stops, 1, 'the installer job is told to stop');
  assert.strictEqual(e.si.state().state, 'cancelled');
  assert.deepStrictEqual(await e.si.start(), { ok: false, reason: 'busy' }, 'the installer group has not drained');
  gotChild.drain(); done(false); await flush();
  assert.strictEqual(e.kids.length, 0, 'no client was started for a cancelled attempt');
  assert.strictEqual((await e.si.start()).ok, true);
});

test('the overall timeout ends a running installer by group too, and the state is failed timeout', async () => {
  let gotChild;
  const e = fakeEngine({ find: () => null, install: (o) => { gotChild = fakeJob(); o.onChild(gotChild); return new Promise(() => {}); } });
  await e.si.start(); await flush();
  assert.strictEqual(e.si.state().state, 'installing');
  e.fire(OVERALL);
  assert.strictEqual(e.si.state().state, 'failed');
  assert.strictEqual(e.si.state().reason, 'timeout');
  assert.strictEqual(gotChild.stops, 1);
  gotChild.drain(); await flush();
  assert.strictEqual((await e.si.start()).ok, true, 'free once the installer group drained');
  e.si.cancel();
});

test('after the install the client is found again and the sign-in goes on from installing to the link', async () => {
  let installed = false, done;
  const e = fakeEngine({ find: () => (installed ? { bin: BIN } : null), install: () => new Promise((res) => { done = () => { installed = true; res(true); }; }) });
  await e.si.start(); await flush();
  assert.strictEqual(e.si.state().state, 'installing');
  done(); await flush();
  assert.strictEqual(e.kids.length, 1);
  e.kids[0].stdout.emit('data', 'visit: https://claude.ai/oauth/authorize?x=1 \n');
  assert.strictEqual(e.si.state().state, 'link');
  e.si.cancel();
});

test('a wrong code while the client stays alive: failed code at once, and the client is ended (real stand-in client)', async () => {
  const t = setup({ mode: 'stay' });
  await t.si.start();
  await until(() => t.snap().state === 'link', 'link');
  const pid = t.children[0].pid;
  t.si.submitCode('WRONG-CODE-99999');
  const s = await until(() => { const x = t.snap(); return x.state === 'failed' && x; }, 'failed code');
  assert.strictEqual(s.reason, 'code');
  await until(() => !alive(pid), 'the client ended');
});

test('a wrong code with a fake client that stays alive: failed code, group kill; output before the code does not count', async () => {
  const e = fakeEngine();
  const a = await e.toLink();
  e.kids[0].stdout.emit('data', 'If the code is invalid or expired you can start again\n');   // before any code: not an answer
  assert.strictEqual(e.si.state().state, 'link');
  e.si.submitCode('ABCDEFGH12345', a.id);
  e.kids[0].stdout.emit('data', 'OAuth error: Invalid code. Please make sure the full code was copied\n');
  assert.strictEqual(e.si.state().state, 'failed');
  assert.strictEqual(e.si.state().reason, 'code');
  assert.strictEqual(e.kids[0].stops(), 1, 'the client\'s group is told to stop');
  await e.exit();
});

test('no change within 60 s after a code: failed error; any new output starts the wait over (fake clock)', async () => {
  const e = fakeEngine();
  const a = await e.toLink();
  e.si.submitCode('ABCDEFGH12345', a.id);
  assert.strictEqual(e.live().filter(t => t.ms === 60000).length, 1);
  e.kids[0].stdout.emit('data', 'Working...\n');
  assert.strictEqual(e.live().filter(t => t.ms === 60000).length, 1, 'one wait at a time, restarted');
  assert.strictEqual(e.si.state().state, 'link');
  e.fire(60000);
  assert.strictEqual(e.si.state().state, 'failed');
  assert.strictEqual(e.si.state().reason, 'error');
  assert.strictEqual(e.si.state().message, S.WORDS.failed.error);
  assert.strictEqual(e.kids[0].stops(), 1, 'the client\'s group is told to stop');
  await e.exit();
});

test('a code that is accepted and answered in time is not failed by the 60 s wait', async () => {
  const e = fakeEngine();
  const a = await e.toLink();
  e.si.submitCode('ABCDEFGH12345', a.id);
  e.kids[0].stdout.emit('data', 'Login successful\n');
  assert.strictEqual(e.live().filter(t => t.ms === 60000).length, 0, 'the wait is cancelled once it is checking');
  await until(() => e.si.state().state === 'done', 'done');
  assert.ok(e.kids[0].stops() >= 1, 'the finished attempt ends its client');
  await e.exit();
});

test('hub exit: a running attempt registers an exit handler that disconnects its group leaders (which then kill their groups); it is removed when the attempt ends', async () => {
  const before = new Set(process.listeners('exit'));
  const mine = () => process.listeners('exit').filter(f => !before.has(f)).length;
  const e = fakeEngine();
  await e.toLink();
  const added = process.listeners('exit').filter(f => !before.has(f));
  assert.strictEqual(added.length, 1);
  added[0]();   // what the hub's exit does
  assert.strictEqual(e.kids[0].disconnected, true);
  assert.ok(e.kills.every(([, sig]) => sig === 0), 'the parent sends no signal itself');
  e.si.cancel();
  assert.strictEqual(mine(), 1, 'still there while the client group has not drained');
  await e.exit();
  assert.strictEqual(mine(), 0, 'removed once the attempt and its children are done');
  // an attempt that ends with no children left removes it at once
  const f = fakeEngine({ find: () => null, install: async () => false });
  await f.si.start(); await flush();
  assert.strictEqual(f.si.state().reason, 'missing');
  assert.strictEqual(mine(), 0);
});

test('installClient: onChild gets the installer job; a timeout tells it to stop (the leader ends the group: SIGTERM, then SIGKILL after 3 s, see the drain tests), and the answer is false', async () => {
  const kills = [], timers = [];
  const kid = fakeKid(7001);
  let seen = null;
  const p = S.installClient({
    spawn: Object.assign(() => kid, { __fakeSpawn: true }), platform: 'linux', onChild: (c) => { seen = c; },
    kill: (pid, sig) => { kills.push([pid, sig]); throw ESRCH(); }, timeoutMs: 1234,
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; }, clearTimer: () => {},
  });
  assert.strictEqual(typeof seen.stop, 'function');
  assert.strictEqual(typeof seen.disconnect, 'function');
  assert.ok(seen.drained instanceof Promise);
  timers.find(t => t.ms === 1234).fn();
  assert.strictEqual(kid.stops(), 1);
  kid.emit('exit', null, 'SIGTERM');   // the leader ends with its group
  assert.strictEqual(await p, false);
  await seen.drained;
  assert.deepStrictEqual(kills, [[-7001, 0]], 'the parent only probes the group, never signals it');
});

test('a group leader without a pid (the spawn failed) drains at once and is never signalled; a group that is still there keeps the job undrained (probe, no signal)', async () => {
  const { startGroup } = require(path.join(ISO.inst, 'lib', 'claude-signin-group'));
  const probes = [], timers = [];
  const noPid = new EventEmitter(); noPid.connected = false;
  const j1 = startGroup(BIN, [], { spawn: () => noPid, kill: (p, s) => probes.push([p, s]), stdio: ['ignore', 'ignore', 'ignore'] });
  noPid.emit('exit', 1);
  await j1.drained;
  assert.deepStrictEqual(probes, []);
  const there = fakeKid(9);
  const j2 = startGroup(BIN, [], { spawn: () => there, kill: (p, s) => { probes.push([p, s]); }, setTimer: (fn, ms) => timers.push([fn, ms]), stdio: ['ignore', 'ignore', 'ignore'] });
  let drained = false; j2.drained.then(() => { drained = true; });
  there.emit('exit', 1);
  await flush();
  assert.strictEqual(drained, false, 'a member of the group is still there');
  assert.deepStrictEqual(probes, [[-9, 0]]);
  assert.strictEqual(timers[0][1], 500, 'the probe is repeated');
});

// ── round 2: cancellation reaches the status and the verification; the slot is held until they settle ──
for (const phase of ['status', 'verify']) {
  test(`cancel during ${phase} holds the slot through settlement`, async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = () => true;

    let entered, finish, observed;
    const ready = new Promise(resolve => { entered = resolve; });
    const deferred = ({ signal }) => {
      observed = signal;
      entered();
      return new Promise(resolve => { finish = resolve; });
    };
    const engine = S.createSignIn({
      findClient: () => ({ bin: BIN }),
      env: () => ({}),
      spawn: () => child,
      authStatus: phase === 'status' ? deferred : async () => ({ loggedIn: true }),
      verify: phase === 'verify' ? deferred : async () => assert.fail('late verify')
    });
    const a = await engine.start();
    await new Promise(resolve => setImmediate(resolve));
    child.emit('message', { op: 'result', code: 0 });   // the client finished (the group leader reports its exit code)
    child.emit('close', 0);                              // and the group is gone (no pid: nothing to probe)
    await ready;
    try {
      engine.cancel(a.id);
      assert.equal(observed.aborted, true);
      assert.equal((await engine.start()).reason, 'busy');
      finish({ ok: true, loggedIn: true });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(engine.state().state, 'cancelled');
      const b = await engine.start();
      assert.equal(b.ok, true);
      await new Promise(resolve => setImmediate(resolve));
      engine.cancel(b.id);
      child.emit('close', 1);
    } finally {
      finish?.({ ok: false });
    }
  });
}

test('the overall timeout still ends an attempt that is checking: failed timeout, the check is aborted, the slot is held until it settles', async () => {
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; timers.push(t); return t; };
  const child = fakeKid(5150);
  let finish;
  const observed = {};
  const verifyEntered = new Promise(r => { observed.resolve = r; });
  const engine = S.createSignIn({
    findClient: () => ({ bin: BIN }), env: () => ({}), spawn: () => child, kill: () => { throw ESRCH(); }, setTimer, clearTimer: (t) => { if (t) t.cleared = true; },
    timeoutMs: OVERALL, authStatus: async () => ({ loggedIn: true }),
    verify: ({ signal }) => { observed.signal = signal; observed.resolve(); return new Promise(r => { finish = r; }); },
  });
  const a = await engine.start();
  await flush();
  child.stdout.emit('data', 'Login successful.\n');
  await verifyEntered;
  assert.equal(engine.state().state, 'checking');
  const overall = timers.find(t => t.ms === OVERALL && !t.cleared);
  assert.ok(overall, 'the overall timer is still armed while checking');
  overall.fn();
  assert.deepStrictEqual([engine.state().state, engine.state().reason], ['failed', 'timeout']);
  assert.equal(observed.signal.aborted, true);
  assert.equal((await engine.start()).reason, 'busy', 'the check and the client have not settled');
  finish({ ok: true });
  child.emit('close', null);
  await flush();
  const b = await engine.start();
  assert.equal(b.ok, true);
  assert.notEqual(b.id, a.id);
  engine.cancel(b.id);
  child.emit('close', null);
});

test('authStatus: an abort kills the child and answers unknown only after it closed; an already-aborted signal spawns nothing', async () => {
  const mk = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.signals = []; c.kill = (s) => { c.signals.push(s); return true; }; return c; };
  const timers = [];
  const deps = { setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.cleared = true; } };
  // abort in flight
  const c = mk();
  const ac = new AbortController();
  let answer;
  const p = S.authStatus({ bin: BIN, signal: ac.signal, spawn: () => c, ...deps }).then(v => { answer = v; return v; });
  ac.abort();
  await flush();
  assert.deepStrictEqual(c.signals, ['SIGKILL']);
  assert.equal(answer, undefined, 'not settled before the child closed');
  c.stdout.emit('data', JSON.stringify({ loggedIn: true }));   // late output is ignored once stopped
  c.emit('close', 0);
  assert.deepStrictEqual(await p, { loggedIn: null, method: null });
  assert.ok(timers.every(t => t.cleared), 'its timer is cleared');
  // already aborted
  let spawned = 0;
  assert.deepStrictEqual(await S.authStatus({ bin: BIN, signal: AbortSignal.abort(), spawn: () => { spawned++; return mk(); }, ...deps }), { loggedIn: null, method: null });
  assert.equal(spawned, 0);
  // the timeout kills it, and the answer comes at close
  const c2 = mk();
  const p2 = S.authStatus({ bin: BIN, spawn: () => c2, ...deps });
  timers[timers.length - 1].fn();
  assert.deepStrictEqual(c2.signals, ['SIGKILL']);
  c2.emit('close', null);
  assert.deepStrictEqual(await p2, { loggedIn: null, method: null });
  // a spawn error then close (as Node does): unknown, no hang
  const c3 = mk();
  const p3 = S.authStatus({ bin: BIN, spawn: () => c3, ...deps });
  c3.emit('error', new Error('ENOENT'));
  c3.emit('close', -2);
  assert.deepStrictEqual(await p3, { loggedIn: null, method: null });
  // the ordinary answers still work with a fake child
  const c4 = mk();
  const p4 = S.authStatus({ bin: BIN, spawn: () => c4, ...deps });
  c4.stdout.emit('data', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
  c4.emit('close', 0);
  assert.deepStrictEqual(await p4, { loggedIn: true, method: 'claude.ai' });
  const c5 = mk();
  const p5 = S.authStatus({ bin: BIN, spawn: () => c5, ...deps });
  c5.emit('close', 1);
  assert.deepStrictEqual(await p5, { loggedIn: false, method: null });
});

test('a leader that exited (its \'exit\' event) frees the slot once its group is gone, even when a grandchild keeps the pipes open; the parent never signals the group', async () => {
  const e = fakeEngine();
  await e.toLink();
  const pid = e.kids[0].pid;
  e.si.cancel();
  assert.strictEqual(e.kids[0].stops(), 1);
  assert.deepStrictEqual(await e.si.start(), { ok: false, reason: 'busy' });
  e.kids[0].emit('exit', null, 'SIGTERM');   // no 'close': a grandchild still holds the pipes; the group is still there
  await flush();
  assert.deepStrictEqual(await e.si.start(), { ok: false, reason: 'busy' }, 'the group is not gone: still busy');
  e.gone.add(-pid);
  e.fire(500);   // the next probe finds the group gone
  await flush();
  assert.ok(e.kills.every(([p, sig]) => p === -pid && sig === 0), 'only probes, never a signal');
  const b = await e.si.start();
  assert.equal(b.ok, true, 'the slot is free');
  e.si.cancel();
  // the exit hook of the finished attempt is gone: only the new attempt's hook is left
  await e.exit(e.kids.length - 1);
});

test('install only when no usable client exists: a client the hub already resolves (the SDK loader\'s or the SDK\'s own) is never replaced by an install', async () => {
  let installs = 0;
  const e = fakeEngine({ find: () => null, install: async () => { installs++; return true; }, existing: () => ({ bin: '/somewhere/claude.exe', source: 'npm-global' }) });
  await e.si.start(); await flush();
  assert.strictEqual(installs, 0, 'nothing is installed');
  assert.deepStrictEqual([e.si.state().state, e.si.state().reason], ['failed', 'error'], 'it exists but cannot run: error, not missing');
  assert.strictEqual(e.kids.length, 0);
  // and with no such client the install does run
  const f = fakeEngine({ find: () => null, install: async () => { installs++; return false; }, existing: () => null });
  await f.si.start(); await flush();
  assert.strictEqual(installs, 1);
  assert.strictEqual(f.si.state().reason, 'missing');
});

test('after any install the hub\'s client resolution is reset before the client is looked up again (the installer may have moved the client)', async () => {
  const order = [];
  let installed = false;
  const e = fakeEngine({
    find: () => { order.push(installed ? 'find-after' : 'find-before'); return installed ? { bin: BIN } : null; },
    install: async () => { order.push('install'); installed = true; return true; },
    resetCli: () => order.push('resetCli'),
  });
  await e.si.start(); await flush();
  assert.deepStrictEqual(order, ['find-before', 'install', 'resetCli', 'find-after']);
  assert.strictEqual(e.kids.length, 1, 'the sign-in goes on with the found client');
  e.si.cancel();
  // a failed (or timed out) install resets too: it may have moved the client before it failed
  const order2 = [];
  const f = fakeEngine({ find: () => null, install: async () => false, resetCli: () => order2.push('resetCli') });
  await f.si.start(); await flush();
  assert.deepStrictEqual(order2, ['resetCli']);
});

test('a rejected code is "invalid code" or "code (has) expired"; other sentences that merely mention a code do not end the attempt', async () => {
  for (const [line, ends] of [['Invalid code', true], ['Error: invalid code', true], ['The code has expired', true], ['this code expired', true],
    ['Your code is almost there, valid for 5 more minutes', false], ['Paste code here if prompted', false], ['code is invalid', false]]) {
    const e = fakeEngine();
    await e.toLink();
    assert.deepStrictEqual(e.si.submitCode(GOOD), { ok: true });
    e.kids[0].stdout.emit('data', line + '\n');
    assert.equal(e.si.state().state, ends ? 'failed' : 'link', line);
    if (ends) assert.equal(e.si.state().reason, 'code', line);
    e.si.cancel();
  }
});
