'use strict';
// The guard fails closed: without the explicit opt-in (allowRealEffects, an in-process flag) no default real effect of the Claude
// sign-in code may run: the installer, the client's sign-in and status, the group supervisor's worker, the check turn. The decision
// does not depend on NODE_TEST_CONTEXT: every test here runs with it deleted. A program is allowed only when it does not exist (a
// fake spawn handles it) or is byte-identical to test/fixtures/fake-claude-client.js. Nothing here runs a real program: every
// refusal is thrown before a spawn, and the allowed runs use a verified copy of the stand-in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { EventEmitter } = require('node:events');

// A throwaway install (the suite's data guard); its test/fixtures folder holds the stand-in the guard compares with.
const { makeIsolatedInstall, REAL } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('claude-signin-guard-iso-', { copy: ['scripts', 'test/fixtures'] });
test.after(() => fs.rmSync(ISO.root, { recursive: true, force: true }));

// The decision must not depend on NODE_TEST_CONTEXT: it is gone for the whole file (restored after).
const savedCtx = process.env.NODE_TEST_CONTEXT;
delete process.env.NODE_TEST_CONTEXT;
test.after(() => { if (savedCtx !== undefined) process.env.NODE_TEST_CONTEXT = savedCtx; });
const savedPath = process.env.PATH;

const GUARD_PATH = path.join(ISO.inst, 'lib', 'claude-signin-guard');
const G = require(GUARD_PATH);
const S = require(path.join(ISO.inst, 'lib', 'claude-signin'));
const { startGroup, SUPERVISOR_MARKER } = require(path.join(ISO.inst, 'lib', 'claude-signin-group'));
const SUP = require(path.join(ISO.inst, 'lib', 'claude-signin-supervisor'));
const { supervise, MARKER } = SUP;
const CLI = require(path.join(ISO.inst, 'scripts', 'hub-cli'));

const REFUSED = /refused to run a real program without the explicit opt-in/;
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'claude-signin-guard-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const FIXTURE = path.join(ISO.inst, 'test', 'fixtures', 'fake-claude-client.js');
const OUTSIDE = fs.realpathSync(process.execPath);   // a real program that is not the stand-in
// A verified copy of the stand-in (byte for byte), and a real program that is not the stand-in, both inside os.tmpdir().
const STAND_IN = path.join(TMP, 'claude');
fs.copyFileSync(FIXTURE, STAND_IN);
fs.chmodSync(STAND_IN, 0o755);
const NOT_STAND_IN = path.join(TMP, 'not-the-stand-in');
fs.copyFileSync(fs.existsSync('/bin/true') ? '/bin/true' : '/usr/bin/true', NOT_STAND_IN);
fs.chmodSync(NOT_STAND_IN, 0o755);
const SCRIPT = path.join(TMP, 'small-script');
fs.writeFileSync(SCRIPT, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));\n', { mode: 0o755 });
const tripwire = () => { throw new Error('a program was spawned'); };
const credsDir = () => { const d = fs.mkdtempSync(path.join(TMP, 'cfg-')); fs.writeFileSync(path.join(d, '.credentials.json'), '{}'); return d; };

test('no opt-in in this process, and the decision does not look at NODE_TEST_CONTEXT', () => {
  assert.strictEqual(process.env.NODE_TEST_CONTEXT, undefined);
  assert.strictEqual(G.realAllowed(), false);
});

test('allowedProgram: bash never; missing paths yes; existing only when byte-identical to the stand-in', () => {
  assert.strictEqual(G.allowedProgram(STAND_IN), true, 'a verified copy of the stand-in');
  assert.strictEqual(G.allowedProgram(FIXTURE), true, 'the stand-in itself');
  assert.strictEqual(G.allowedProgram(NOT_STAND_IN), false, 'an existing executable in os.tmpdir() that is not the stand-in');
  assert.strictEqual(G.allowedProgram(SCRIPT), false, 'a small script in os.tmpdir() that is not the stand-in');
  assert.strictEqual(G.allowedProgram(OUTSIDE), false);
  assert.strictEqual(G.allowedProgram('/nonexistent/claude'), false, 'a path that does not exist is refused too: only the stand-in itself passes');
  assert.strictEqual(G.allowedProgram(path.join(TMP, 'not-there')), false);
  assert.strictEqual(G.allowedProgram(''), false);
  assert.strictEqual(G.allowedProgram('bash'), false);
  assert.strictEqual(G.allowedProgram('/nonexistent/bash'), false, 'bash is refused even where it does not exist');
  const bash = path.join(TMP, 'bash');
  fs.copyFileSync(FIXTURE, bash);
  assert.strictEqual(G.allowedProgram(bash), true, 'the name does not matter: byte-identical to the stand-in is the stand-in');
  fs.writeFileSync(bash, '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(G.allowedProgram(bash), false, 'a file called bash with other content');
  const toOutside = path.join(TMP, 'link-to-outside');
  fs.symlinkSync(OUTSIDE, toOutside);
  assert.strictEqual(G.allowedProgram(toOutside), false, 'a link to a program that is not the stand-in is resolved');
  const toStandIn = path.join(TMP, 'link-to-stand-in');
  fs.symlinkSync(STAND_IN, toStandIn);
  assert.strictEqual(G.allowedProgram(toStandIn), true, 'a link to a verified copy');
  const dangling = path.join(TMP, 'dangling');
  fs.symlinkSync(path.join(TMP, 'gone'), dangling);
  assert.strictEqual(G.allowedProgram(dangling), false, 'a dangling link is not "nothing there"');
});

test('allowedProgram: a bare name is refused, whether it resolves on PATH or not', () => {
  const bin = fs.mkdtempSync(path.join(TMP, 'bin-'));
  fs.writeFileSync(path.join(bin, 'mm-guard-prog'), '#!/bin/sh\n', { mode: 0o755 });
  try {
    process.env.PATH = bin + path.delimiter + '/usr/bin';
    assert.strictEqual(G.allowedProgram('mm-guard-prog'), false);
    assert.strictEqual(G.allowedProgram('mm-guard-no-such-prog'), false);
    assert.strictEqual(G.allowedProgram('ls'), false);
  } finally { process.env.PATH = savedPath; }
});

test('test mode is captured at load: the opt-in cannot enable real effects, even in a fresh copy of the guard, and with the context variables gone', () => {
  assert.strictEqual(G.underTest(), true, 'sealed (MM_TEST_NO_REAL_CLAUDE or the install marker), NODE_TEST_CONTEXT or not');
  const key = require.resolve(GUARD_PATH);
  const cached = require.cache[key];
  delete require.cache[key];
  try {
    const fresh = require(GUARD_PATH);
    assert.notStrictEqual(fresh, G);
    assert.strictEqual(fresh.underTest(), true);
    assert.throws(() => fresh.guardProgram(OUTSIDE), REFUSED);
    fresh.allowRealEffects();
    assert.strictEqual(fresh.realAllowed(), false, 'a test-mode process cannot opt in');
    assert.throws(() => fresh.guardProgram(OUTSIDE), REFUSED);
    assert.throws(() => fresh.guardProgram('bash'), REFUSED);
    assert.throws(() => fresh.guardProgram(), REFUSED);
  } finally { require.cache[key] = cached; }
  assert.strictEqual(G.realAllowed(), false);
  assert.throws(() => G.guardProgram(OUTSIDE), REFUSED);
  assert.throws(() => G.guardProgram(), REFUSED, 'the check turn: no program given');
  assert.throws(() => G.guardProgramWith(true, OUTSIDE), REFUSED, 'a sealed supervisor ignores the parent\'s opt-in');
  assert.throws(() => G.guardProgramWith(false, OUTSIDE), REFUSED);
  assert.throws(() => G.guardProgramWith(undefined, OUTSIDE), REFUSED);
});

test('the default installClient never runs without the opt-in, and neither does an injected real spawn', () => {
  assert.throws(() => S.installClient({ platform: 'linux' }), REFUSED);
  assert.throws(() => S.installClient({ platform: 'darwin' }), REFUSED);
  assert.throws(() => S.installClient({ platform: 'linux', spawn: cp.spawn }), REFUSED, 'child_process.spawn injected: still the real boundary');
});

test('the engine without an injected installClient or spawn: the installer is refused, the attempt ends missing, nothing ran', async () => {
  const si = S.createSignIn({ env: () => ({}), findClient: () => null, verify: async () => ({ ok: true }), authStatus: async () => ({ loggedIn: true }), existingClient: () => null });
  assert.strictEqual((await si.start()).ok, true);
  for (let i = 0; i < 200 && si.state().state !== 'failed'; i++) await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(si.state().state, 'failed');
  assert.strictEqual(si.state().reason, 'missing');
});

test('the default sign-in spawn refuses a bin that is not the stand-in (startGroup, no injected spawn)', () => {
  const stdio = { stdio: ['ignore', 'ignore', 'ignore'] };
  assert.throws(() => startGroup(OUTSIDE, ['auth', 'login', '--claudeai'], { stdio: ['pipe', 'pipe', 'pipe'] }), REFUSED);
  assert.throws(() => startGroup(NOT_STAND_IN, ['x'], stdio), REFUSED);
  assert.throws(() => startGroup(SCRIPT, ['x'], stdio), REFUSED);
  assert.throws(() => startGroup('bash', ['-c', 'true'], stdio), REFUSED);
  assert.throws(() => startGroup(path.join(TMP, 'bash'), ['-c', 'true'], stdio), REFUSED);
  assert.throws(() => startGroup('/nonexistent/bash', ['-c', 'true'], stdio), REFUSED);
});

test('an injected spawn that is child_process.spawn is refused at the boundary for a bin that is not the stand-in', () => {
  const stdio = { spawn: cp.spawn, stdio: ['ignore', 'ignore', 'ignore'] };
  assert.throws(() => startGroup(NOT_STAND_IN, ['x'], stdio), REFUSED);
  assert.throws(() => startGroup(OUTSIDE, ['x'], stdio), REFUSED);
  assert.throws(() => startGroup('bash', ['-c', 'true'], stdio), REFUSED);
  assert.throws(() => S.authStatus({ bin: NOT_STAND_IN, spawn: cp.spawn }), REFUSED);
  assert.throws(() => S.authStatus({ bin: OUTSIDE, spawn: cp.spawn }), REFUSED);
});

test('the engine with a real-machine bin and no injected spawn: refused, failed missing', async () => {
  const si = S.createSignIn({ env: () => ({}), findClient: () => ({ bin: OUTSIDE }), authStatus: async () => ({ loggedIn: true }), verify: async () => ({ ok: true }) });
  await si.start();
  for (let i = 0; i < 200 && si.state().state === 'starting'; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepStrictEqual([si.state().state, si.state().reason], ['failed', 'missing']);
});

test('a fake spawn still handles the installer (through a marked fake) and a stand-in client; a missing client path is refused', async () => {
  const seen = [];
  const gone = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
  const fake = Object.assign((bin, args) => { seen.push([bin, args]); const k = new EventEmitter(); k.pid = 9001; k.connected = false; return k; }, { __fakeSpawn: true });
  S.installClient({ spawn: fake, platform: 'linux', kill: gone, timeoutMs: 5 });
  startGroup(STAND_IN, ['x'], { spawn: fake, stdio: ['ignore', 'ignore', 'ignore'], kill: gone });
  assert.throws(() => startGroup('/nonexistent/claude', ['x'], { spawn: fake, stdio: ['ignore', 'ignore', 'ignore'], kill: gone }), REFUSED, 'a missing path is refused now');
  assert.strictEqual(seen.length, 2);
  assert.ok(seen.every(([, a]) => a[1] === SUPERVISOR_MARKER), 'the supervisor is started with the marker');
});

test('a wrapper around child_process.spawn is the real spawn: installClient refuses it before calling it (no marker)', () => {
  const calls = [];
  const wrapper = (...a) => { calls.push(a); throw new Error('the wrapper must never be called'); };   // stands for (...a) => cp.spawn(...a)
  assert.throws(() => S.installClient({ spawn: wrapper, platform: 'linux' }), REFUSED);
  assert.throws(() => S.installClient({ spawn: wrapper, platform: 'darwin' }), REFUSED);
  assert.deepStrictEqual(calls, [], 'never called');
  // a marker inherited rather than own, or not exactly true, does not count
  const inherited = Object.setPrototypeOf((...a) => { calls.push(a); }, Object.assign(() => {}, { __fakeSpawn: true }));
  assert.throws(() => S.installClient({ spawn: inherited, platform: 'linux' }), REFUSED);
  const notTrue = Object.assign((...a) => { calls.push(a); }, { __fakeSpawn: 1 });
  assert.throws(() => S.installClient({ spawn: notTrue, platform: 'linux' }), REFUSED);
  assert.deepStrictEqual(calls, []);
});

test('a wrapper spawn gets the program-path rule too: authStatus and startGroup refuse an existing non-stand-in before calling it', () => {
  const calls = [];
  const wrapper = (...a) => { calls.push(a); throw new Error('the wrapper must never be called'); };
  for (const bin of [NOT_STAND_IN, SCRIPT, OUTSIDE, 'bash']) {
    assert.throws(() => S.authStatus({ bin, spawn: wrapper }), REFUSED, bin);
    assert.throws(() => startGroup(bin, ['x'], { spawn: wrapper, stdio: ['ignore', 'ignore', 'ignore'] }), REFUSED, bin);
  }
  const bin = fs.mkdtempSync(path.join(TMP, 'bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  try {
    process.env.PATH = bin + path.delimiter + '/usr/bin';
    assert.throws(() => S.authStatus({ bin: 'claude', spawn: wrapper }), REFUSED, 'a bare name on PATH');
  } finally { process.env.PATH = savedPath; }
  assert.deepStrictEqual(calls, [], 'never called');
});

test('the default authStatus spawn refuses a bin that is not the stand-in', () => {
  assert.throws(() => S.authStatus({ bin: OUTSIDE }), REFUSED);
  assert.throws(() => S.authStatus({ bin: NOT_STAND_IN }), REFUSED);
  const bin = fs.mkdtempSync(path.join(TMP, 'bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  try {
    process.env.PATH = bin + path.delimiter + '/usr/bin';
    assert.throws(() => S.authStatus({ bin: 'claude' }), REFUSED, 'a bare name that resolves on PATH');
  } finally { process.env.PATH = savedPath; }
});

function channelOf(connected = true) {
  const sent = [];
  const channel = new EventEmitter();
  channel.connected = connected;
  channel.send = (m, cb) => { sent.push(m); cb && cb(); return true; };
  return { channel, sent };
}

test('the supervisor\'s own default spawn refuses too (no opt-in in the message): result 1, nothing spawned', () => {
  for (const msg of [{ op: 'start', bin: OUTSIDE, args: ['auth', 'status'] }, { op: 'start', bin: NOT_STAND_IN, args: [], allowReal: false }, { op: 'start', bin: 'bash', args: ['-c', 'true'], allowReal: false }]) {
    const { channel, sent } = channelOf();
    supervise({ channel, argv: ['node', 'sup', MARKER], ownsProcessGroup: () => true, kill: () => {}, setTimer: () => {} });
    channel.emit('message', msg);
    assert.strictEqual(sent[0].op, 'result');
    assert.strictEqual(sent[0].code, 1);
  }
});

test('the supervisor applies the boundary to an injected child_process.spawn too, unless the message carries the opt-in', () => {
  const { channel, sent } = channelOf();
  supervise({ channel, argv: ['node', 'sup', MARKER], ownsProcessGroup: () => true, kill: () => {}, setTimer: () => {}, spawn: cp.spawn });
  channel.emit('message', { op: 'start', bin: NOT_STAND_IN, args: [], allowReal: false });
  assert.strictEqual(sent[0].code, 1);
});

test('the supervisor with a stand-in path and an injected fake spawn still starts it', () => {
  const { channel } = channelOf();
  const seen = [];
  supervise({ channel, argv: ['node', 'sup', MARKER], ownsProcessGroup: () => true, kill: () => {}, setTimer: () => {}, spawn: (bin, args) => { seen.push([bin, args]); return new EventEmitter(); } });
  channel.emit('message', { op: 'start', bin: STAND_IN, args: ['x'] });
  assert.deepStrictEqual(seen, [[STAND_IN, ['x']]]);
});

test('the supervisor without IPC or without the marker exits 1 and never calls kill', () => {
  for (const [connected, argv] of [[false, ['node', 'sup', MARKER]], [true, ['node', 'sup']], [false, ['node', 'sup']], [true, []]]) {
    const { channel } = channelOf(connected);
    const kills = [], exits = [], timers = [];
    supervise({ channel, argv, exit: (c) => exits.push(c), kill: (...a) => kills.push(a), setTimer: (...a) => timers.push(a) });
    assert.deepStrictEqual(exits, [1], `connected=${connected} argv=${argv}`);
    assert.deepStrictEqual(kills, [], 'no kill of any group');
    // nothing was wired: not a disconnect, not a SIGTERM, not a message
    channel.emit('disconnect'); channel.emit('SIGTERM'); channel.emit('message', { op: 'stop' }); channel.emit('message', { op: 'start', bin: STAND_IN, args: [] });
    assert.deepStrictEqual(kills, [], 'still no kill');
    assert.strictEqual(timers.length, 0);
  }
});

test('startGroup passes the marker and the parent\'s opt-in to the supervisor', () => {
  const spawnArgs = [], sent = [];
  const fake = (bin, args, opts) => { spawnArgs.push(args); const k = new EventEmitter(); k.pid = 9002; k.connected = true; k.send = (m, cb) => { sent.push(m); cb && cb(); }; k.disconnect = () => {}; return k; };
  startGroup(STAND_IN, ['x'], { spawn: fake, stdio: ['ignore', 'ignore', 'ignore'], kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
  assert.strictEqual(spawnArgs[0][spawnArgs[0].length - 1], '--mm-claude-supervisor');
  assert.strictEqual(SUPERVISOR_MARKER, MARKER);
  assert.deepStrictEqual(sent[0], { op: 'start', bin: STAND_IN, args: ['x'], allowReal: false });
});

test('the default verify (the check turn) refuses without the opt-in, in the engine\'s lib and in the command', () => {
  assert.throws(() => S.defaultVerify({}), REFUSED);
  assert.throws(() => CLI.defaultCheck({}), REFUSED);
});

test('connectClaude with no injected check and a signed-in stand-in: the default check is refused, so it fails instead of reaching Claude', async () => {
  const err = [];
  const cfg = fs.mkdtempSync(path.join(TMP, 'cfg-'));
  const code = await CLI.connectClaude({
    rootNote: () => null, say() {}, sayErr: (s) => err.push(s), isTTY: true, pollMs: 10,
    hidden: { begin() {}, end() {} }, read: async () => tripwire(),
    env: { PATH: process.env.PATH, HOME: cfg, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CLI_PATH: STAND_IN },
    envFile: path.join(cfg, 'none.env'),
    signin: { ...S, createSignIn: () => { throw new Error('no engine needed: signed in, the check fails first'); }, authStatus: async () => ({ loggedIn: true, method: 'claude.ai' }) },
  });
  assert.strictEqual(code, 1);
  assert.ok(err.length >= 1);
  assert.strictEqual(G.realAllowed(), false, 'connectClaude called in process never opts in');
});

test('a verified copy of the stand-in is allowed: authStatus runs it (default spawn)', async () => {
  const cfg = credsDir();
  assert.deepStrictEqual(await S.authStatus({ bin: STAND_IN, env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: cfg, HOME: cfg } }), { loggedIn: true, method: 'claude.ai' });
});

test('a verified copy of the stand-in is allowed: startGroup starts the supervisor with it (default spawn, marker, IPC)', async () => {
  const cfg = credsDir();
  const job = startGroup(STAND_IN, ['auth', 'status'], { env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: cfg, HOME: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  job.stdout.on('data', d => { out += d; });
  const code = await new Promise(resolve => job.once('result', resolve));
  assert.strictEqual(code, 0);
  await job.drained;
  assert.match(out, /loggedIn/);
});

// ── allowRealEffects( appears only where it must ──
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data'].includes(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && /\.(js|cjs|mjs|ts|html|sh|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('allowRealEffects( appears only in server.js and the one hub-cli.js place (and the guard module and its two tests)', () => {
  const hits = {};
  for (const f of walk(REAL)) {
    const n = fs.readFileSync(f, 'utf8').split('allowRealEffects(').length - 1;
    if (n) hits[path.relative(REAL, f)] = n;
  }
  assert.deepStrictEqual(Object.keys(hits).sort(), ['lib/claude-signin-guard.js', 'scripts/hub-cli.js', 'server.js', 'test/claude-signin-boundaries.test.js', 'test/claude-signin-guard.test.js']);
  assert.strictEqual(hits['server.js'], 1);
  assert.strictEqual(hits['scripts/hub-cli.js'], 1);
  // In hub-cli.js: inside the `connect claude` command path, before connectClaude() runs; not at module load, not in connectClaude.
  const src = fs.readFileSync(path.join(REAL, 'scripts', 'hub-cli.js'), 'utf8');
  const at = src.indexOf('allowRealEffects(');
  const open = src.indexOf("if (argv[1] === 'claude') {");
  const run = src.indexOf('await connectClaude()');
  assert.ok(open > 0 && open < at && at < run, 'between the claude branch and the connectClaude() call');
  assert.ok(src.indexOf('async function connectClaude') < open, 'the command path comes after the function, so not inside connectClaude');
  // In server.js: at the start, before the hub listens.
  const srv = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  assert.ok(srv.indexOf('allowRealEffects(') < srv.indexOf('server.listen('));
});
