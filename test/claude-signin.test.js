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
    assert.deepStrictEqual(await t.si.start(), { ok: true });
    const s = await until(() => { const x = t.snap(); return x.state === 'link' && x; }, 'link');
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
  assert.deepStrictEqual(await t.si.start().then(r => { t.si.cancel(); return r; }), { ok: true }, 'a new attempt may start after cancel');
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
  const script = path.join(TMP, 'quick.js');
  fs.writeFileSync(script, '#!/usr/bin/env node\nprocess.stdout.write("Login successful\\n");\n', { mode: 0o755 });
  let verified = 0;
  const cfg = fs.mkdtempSync(path.join(TMP, 'cfg-'));
  fs.writeFileSync(path.join(cfg, '.credentials.json'), '{}');
  const real = fs.copyFileSync;
  const si = S.createSignIn({ env: () => ({ PATH: process.env.PATH, CLAUDE_CONFIG_DIR: cfg }), findClient: () => ({ bin: script }), authStatus: async () => ({ loggedIn: true, method: 'claude.ai' }), verify: async () => { verified++; return { ok: true }; } });
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
  assert.deepStrictEqual(r, { ok: false, reason: 'missing' });
  assert.strictEqual(installs, 1);
  assert.strictEqual(finds, 2);
  assert.strictEqual(t.si.state().reason, 'missing');
  assert.strictEqual(t.si.state().message, S.WORDS.failed.missing);
  assert.strictEqual(t.children.length, 0);
});

test('no client at first but the install puts one there: sign-in goes on', async () => {
  let installed = false;
  const t = setup({ find: () => (installed ? { bin: BIN } : null), install: async () => { installed = true; return true; } });
  assert.deepStrictEqual(await t.si.start(), { ok: true });
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
  const junk = path.join(TMP, 'junk.js');
  fs.writeFileSync(junk, '#!/usr/bin/env node\nprocess.stdout.write("hello");process.exit(3);\n', { mode: 0o755 });
  assert.strictEqual((await S.authStatus({ bin: junk, env: o.env })).loggedIn, null);
  assert.strictEqual((await S.authStatus({ bin: path.join(TMP, 'nope'), env: o.env })).loggedIn, null);
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
  const fakeSpawn = (code) => (cmd, args) => {
    calls.push([cmd, args]);
    const { EventEmitter } = require('events');
    const c = new EventEmitter(); c.kill = () => {};
    setImmediate(() => c.emit('close', code));
    return c;
  };
  assert.strictEqual(await S.installClient({ spawn: fakeSpawn(0), platform: 'linux' }), true);
  assert.deepStrictEqual(calls[0], ['bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash']]);
  assert.strictEqual(await S.installClient({ spawn: fakeSpawn(1), platform: 'darwin' }), false);
  const n = calls.length;
  assert.strictEqual(await S.installClient({ spawn: fakeSpawn(0), platform: 'win32' }), false);
  assert.strictEqual(calls.length, n, 'nothing runs on other platforms');
});
