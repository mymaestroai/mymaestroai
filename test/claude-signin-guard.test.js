'use strict';
// Under node --test no default real effect of the Claude sign-in code may run: the installer, the client's sign-in and status,
// the group supervisor, the check turn. A stand-in program inside os.tmpdir() or test/fixtures still may. Nothing here runs a
// real program: every refusal is thrown before a spawn, and the one allowed run is a stand-in script in a temp folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('node:events');

// A throwaway install (the suite's data guard); its test/fixtures folder is the one the guard allows.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('claude-signin-guard-iso-', { copy: ['scripts', 'test/fixtures'] });
test.after(() => fs.rmSync(ISO.root, { recursive: true, force: true }));
const G = require(path.join(ISO.inst, 'lib', 'claude-signin-guard'));
const S = require(path.join(ISO.inst, 'lib', 'claude-signin'));
const { startGroup } = require(path.join(ISO.inst, 'lib', 'claude-signin-group'));
const { supervise } = require(path.join(ISO.inst, 'lib', 'claude-signin-supervisor'));
const CLI = require(path.join(ISO.inst, 'scripts', 'hub-cli'));

const REFUSED = /refused to run a real program under node --test/;
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'claude-signin-guard-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const OUTSIDE = fs.realpathSync(process.execPath);   // a real program that is not in tmp or test/fixtures
const STAND_IN = path.join(TMP, 'claude');
fs.writeFileSync(STAND_IN, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));\n', { mode: 0o755 });
const tripwire = () => { throw new Error('a program was spawned'); };

test('this test process is under node --test', () => {
  assert.strictEqual(G.underTest(), true);
});

test('allowedProgram: files in os.tmpdir() and test/fixtures yes; elsewhere no; bash never', () => {
  assert.strictEqual(G.allowedProgram(STAND_IN), true);
  assert.strictEqual(G.allowedProgram(path.join(ISO.inst, 'test', 'fixtures', 'fake-claude-client.js')), true);
  assert.strictEqual(G.allowedProgram(OUTSIDE), false);
  assert.strictEqual(G.allowedProgram('/nonexistent/claude'), false);
  assert.strictEqual(G.allowedProgram(''), false);
  const bash = path.join(TMP, 'bash');
  fs.writeFileSync(bash, '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(G.allowedProgram(bash), false, 'bash is never allowed, whatever the path');
  const link = path.join(TMP, 'link-to-outside');
  fs.symlinkSync(OUTSIDE, link);
  assert.strictEqual(G.allowedProgram(link), false, 'a link inside tmp to a program outside is resolved');
});

test('the default installClient never runs under test', () => {
  assert.throws(() => S.installClient({ platform: 'linux' }), REFUSED);
  assert.throws(() => S.installClient({ platform: 'darwin' }), REFUSED);
});

test('the engine without an injected installClient or spawn: the installer is refused, the attempt ends missing, nothing ran', async () => {
  const si = S.createSignIn({ env: () => ({}), findClient: () => null, verify: async () => ({ ok: true }), authStatus: async () => ({ loggedIn: true }), existingClient: () => null });
  assert.strictEqual((await si.start()).ok, true);
  for (let i = 0; i < 200 && si.state().state !== 'failed'; i++) await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(si.state().state, 'failed');
  assert.strictEqual(si.state().reason, 'missing');
});

test('the default sign-in spawn refuses a bin outside tmp and fixtures (startGroup, no injected spawn)', () => {
  assert.throws(() => startGroup(OUTSIDE, ['auth', 'login', '--claudeai'], { stdio: ['pipe', 'pipe', 'pipe'] }), REFUSED);
  assert.throws(() => startGroup('bash', ['-c', 'true'], { stdio: ['ignore', 'ignore', 'ignore'] }), REFUSED);
  assert.throws(() => startGroup(path.join(TMP, 'bash'), ['-c', 'true'], { stdio: ['ignore', 'ignore', 'ignore'] }), REFUSED);
});

test('the engine with a real-machine bin and no injected spawn: refused, failed missing', async () => {
  const si = S.createSignIn({ env: () => ({}), findClient: () => ({ bin: OUTSIDE }), authStatus: async () => ({ loggedIn: true }), verify: async () => ({ ok: true }) });
  await si.start();
  for (let i = 0; i < 200 && si.state().state === 'starting'; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepStrictEqual([si.state().state, si.state().reason], ['failed', 'missing']);
});

test('the default authStatus spawn refuses a bin outside tmp and fixtures', () => {
  assert.throws(() => S.authStatus({ bin: OUTSIDE }), REFUSED);
  assert.throws(() => S.authStatus({ bin: 'claude' }), REFUSED);
});

test('the supervisor\'s own default spawn refuses too: result 1, nothing spawned', () => {
  const sent = [];
  const channel = new EventEmitter();
  channel.connected = true;
  channel.send = (m, cb) => { sent.push(m); cb && cb(); return true; };
  supervise({ channel, kill: () => {}, setTimer: () => {} });
  channel.emit('message', { op: 'start', bin: OUTSIDE, args: ['auth', 'status'] });
  assert.strictEqual(sent[0].op, 'result');
  assert.strictEqual(sent[0].code, 1);
});

test('the supervisor with a stand-in in tmp and an injected spawn still starts it', () => {
  const channel = new EventEmitter();
  channel.connected = true;
  channel.send = (m, cb) => cb && cb();
  const seen = [];
  supervise({ channel, kill: () => {}, setTimer: () => {}, spawn: (bin, args) => { seen.push([bin, args]); return new EventEmitter(); } });
  channel.emit('message', { op: 'start', bin: STAND_IN, args: ['x'] });
  assert.deepStrictEqual(seen, [[STAND_IN, ['x']]]);
});

test('the default verify (the check turn) refuses under test, in the engine\'s lib and in the command', () => {
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
    signin: { ...S, createSignIn: () => { throw new Error('no engine needed: signed in, the check fails first'); } },
  });
  assert.strictEqual(code, 1);
  assert.ok(err.length >= 1);
});

test('a stand-in in os.tmpdir() is still allowed: authStatus runs it (default spawn)', async () => {
  assert.deepStrictEqual(await S.authStatus({ bin: STAND_IN, env: { PATH: process.env.PATH } }), { loggedIn: true, method: 'claude.ai' });
});

test('a stand-in in os.tmpdir() is still allowed: startGroup starts the supervisor with it (default spawn)', async () => {
  const job = startGroup(STAND_IN, ['auth', 'status'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  job.stdout.on('data', d => { out += d; });
  const code = await new Promise(resolve => job.once('result', resolve));
  assert.strictEqual(code, 0);
  await job.drained;
  assert.match(out, /loggedIn/);
});
