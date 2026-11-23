'use strict';
// `mymaestro connect claude` (scripts/hub-cli.js) run for real from a throwaway install, with the stand-in client
// (test/fixtures/fake-claude-client.js) as CLAUDE_CLI_PATH and a temp CLAUDE_CONFIG_DIR. No real `claude` program.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('connect-claude-iso-', { copy: ['scripts'] });
const CLI = path.join(ISO.inst, 'scripts', 'hub-cli.js');
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'connect-claude-'));
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); fs.rmSync(ISO.root, { recursive: true, force: true }); });
const BIN = path.join(TMP, 'claude');
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-claude-client.js'), BIN);
fs.chmodSync(BIN, 0o755);
const GOOD = 'GOOD-CODE-12345';

function run(input, { stub = 'ok', signedIn = false, args = ['connect', 'claude'], extra = {} } = {}) {
  const cfg = fs.mkdtempSync(path.join(TMP, 'cfg-'));
  if (signedIn) fs.writeFileSync(path.join(cfg, '.credentials.json'), '{}');
  const env = { PATH: process.env.PATH, HOME: cfg, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CLI_PATH: BIN, NODE_ENV: 'test', ...(stub ? { MM_SIGNIN_VERIFY_STUB: stub } : {}), ...extra };
  const r = spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: 'utf8', timeout: 30000 });
  return { ...r, cfg, creds: path.join(cfg, '.credentials.json') };
}
const S = () => require(path.join(ISO.inst, 'lib', 'claude-signin'));

test('signed out, good code: prints the steps and the done sentence, exit 0, credentials created, no code in the output', () => {
  const r = run(GOOD + '\n');
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes(S().WORDS.signedOut));
  assert.ok(r.stdout.includes(S().WORDS.openLink));
  assert.ok(r.stdout.includes('Paste the code below and press Enter. It is not shown as you paste it.'));
  assert.ok(r.stdout.includes('https://claude.example/oauth/authorize'), 'the client prints the link');
  assert.ok(r.stdout.includes(S().WORDS.checking));
  assert.ok(r.stdout.includes(S().WORDS.done));
  assert.ok(fs.existsSync(r.creds));
  assert.ok(!(r.stdout + r.stderr).includes(GOOD));
  assert.doesNotMatch(r.stdout + r.stderr, /CLAUDE_CODE_OAUTH_TOKEN|setup-token|dummy-token/);
});

test('already signed in: no sign-in step, just the check, exit 0', () => {
  const r = run('', { signedIn: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(S().WORDS.done));
  assert.ok(!r.stdout.includes(S().WORDS.signedOut));
  assert.ok(!r.stdout.includes('oauth/authorize'));
});

test('a bad code: exit non-zero with the code sentence, nothing signed in', () => {
  const r = run('WRONG-CODE-99999\n');
  assert.notStrictEqual(r.status, 0);
  assert.ok(r.stderr.includes(S().WORDS.failed.code));
  assert.ok(!fs.existsSync(r.creds));
  assert.ok(!r.stdout.includes(S().WORDS.done));
  assert.ok(!(r.stdout + r.stderr).includes('WRONG-CODE-99999'));
});

test('the check fails: the account, limit and network sentences, exit 1', () => {
  for (const [stub, reason] of [['signed-out', 'account'], ['limit', 'limit'], ['network', 'network']]) {
    const r = run('', { signedIn: true, stub });
    assert.strictEqual(r.status, 1, stub);
    assert.ok(r.stderr.includes(S().WORDS.failed[reason]), stub);
    assert.ok(!r.stdout.includes(S().WORDS.done));
  }
});

test('the verify stub is read only by the CLI and only under NODE_ENV "test"', () => {
  // (Not run without NODE_ENV=test: the real check would start the SDK's own client.)
  const REAL = path.join(__dirname, '..');
  const cli = fs.readFileSync(path.join(REAL, 'scripts', 'hub-cli.js'), 'utf8');
  assert.match(cli, /env\.NODE_ENV === 'test' \? env\.MM_SIGNIN_VERIFY_STUB : null/);
  for (const f of ['server.js', 'lib/claude-signin.js', 'lib/welcome.js']) {
    let src = ''; try { src = fs.readFileSync(path.join(REAL, f), 'utf8'); } catch { /* not there */ }
    assert.ok(!src.includes('MM_SIGNIN_VERIFY_STUB'), f);
  }
  const inLib = fs.readdirSync(path.join(REAL, 'lib')).filter(f => f.endsWith('.js') && fs.readFileSync(path.join(REAL, 'lib', f), 'utf8').includes('MM_SIGNIN_VERIFY_STUB'));
  assert.deepStrictEqual(inLib, []);
});

test('no client anywhere: installs once (stand-in), then the missing sentence, exit 1', async () => {
  // In-process with a stand-in engine: a real run would fall through to the SDK's bundled client or the real installer.
  const { connectClaude } = require(path.join(ISO.inst, 'scripts', 'hub-cli.js'));
  const real = S();
  let installs = 0;
  const signin = { ...real, findClient: () => null, installClient: async () => { installs++; return false; } };
  const said = [], err = [];
  const code = await connectClaude({ signin, rootNote: () => null, say: (s) => said.push(s), sayErr: (s) => err.push(s), env: {} });
  assert.strictEqual(code, 1);
  assert.strictEqual(installs, 1);
  assert.ok(said.some(s => /Installing/.test(s)));
  assert.deepStrictEqual(err, [real.WORDS.failed.missing]);
});

test('`connect` usage and the help list claude', () => {
  const u = run('', { args: ['connect', 'other'] });
  assert.strictEqual(u.status, 1);
  assert.match(u.stderr, /mymaestro connect claude/);
  assert.match(u.stderr, /mymaestro connect chatgpt/);
  const h = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8' }).stdout;
  assert.match(h, /mymaestro connect claude/);
  assert.match(h, /mymaestro version/);
});

// In-process helpers: the real engine and the stand-in client, an injected reader and check.
function inproc(extraEnv = {}) {
  const cfg = fs.mkdtempSync(path.join(TMP, 'cfgp-'));
  const env = { PATH: process.env.PATH, HOME: cfg, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CLI_PATH: BIN, ...extraEnv };
  const said = [], err = [];
  const opts = { rootNote: () => null, say: (s) => said.push(s), sayErr: (s) => err.push(s), env, verify: async () => ({ ok: true, state: 'ready' }), pollMs: 20 };
  return { cfg, env, said, err, opts };
}

test('a terminal: the injected hidden reader is used, the code goes to the engine, and no transcript line contains it', async () => {
  const { connectClaude } = require(path.join(ISO.inst, 'scripts', 'hub-cli.js'));
  const t = inproc();
  const prompts = [];
  const code = await connectClaude({ ...t.opts, isTTY: true, read: async (q) => { prompts.push(q); return GOOD; } });
  assert.strictEqual(code, 0, t.err.join('\n'));
  assert.strictEqual(prompts.length, 1);
  assert.ok(t.said.includes('  https://claude.example/oauth/authorize?code=true&state=standin'));
  assert.ok(t.said.includes('Paste the code below and press Enter. It is not shown as you paste it.'));
  assert.ok(t.said.includes(S().WORDS.checking) && t.said.includes(S().WORDS.done));
  assert.ok(fs.existsSync(path.join(t.cfg, '.credentials.json')));
  assert.ok(!(t.said.join('\n') + t.err.join('\n')).includes(GOOD));
  assert.ok(!prompts.join('').includes(GOOD));
});

test('a terminal: a code that is too short asks again, three times, then exit 1', async () => {
  const { connectClaude } = require(path.join(ISO.inst, 'scripts', 'hub-cli.js'));
  const t = inproc();
  let n = 0;
  const code = await connectClaude({ ...t.opts, isTTY: true, read: async () => { n++; return 'short'; } });
  assert.strictEqual(code, 1);
  assert.strictEqual(n, 3);
  assert.strictEqual(t.said.filter(s => /doesn't look like the whole code/.test(s)).length, 3);
  assert.ok(!fs.existsSync(path.join(t.cfg, '.credentials.json')));
  // and one bad try, then the good code, works
  const t2 = inproc();
  const answers = ['short', GOOD];
  const c2 = await connectClaude({ ...t2.opts, isTTY: true, read: async () => answers.shift() });
  assert.strictEqual(c2, 0, t2.err.join('\n'));
});

test('stdin is not a terminal and NODE_ENV is not test: refused before anything starts', async () => {
  const { connectClaude } = require(path.join(ISO.inst, 'scripts', 'hub-cli.js'));
  const t = inproc();
  let asked = 0;
  const code = await connectClaude({ ...t.opts, isTTY: false, read: async () => { asked++; return GOOD; } });
  assert.strictEqual(code, 1);
  assert.strictEqual(asked, 0);
  assert.deepStrictEqual(t.err, ['connect claude asks for the code in a terminal; run it in a terminal on the computer that runs your Maestro.']);
  assert.ok(!t.said.some(s => /oauth/.test(s)));
  assert.ok(!fs.existsSync(path.join(t.cfg, '.credentials.json')));
});

test('configDirFromEnvFile returns only the CLAUDE_CONFIG_DIR value', () => {
  const f = path.join(TMP, 'env-a');
  const { configDirFromEnvFile } = S();
  fs.writeFileSync(f, '# comment\nSESSION_SECRET=top-secret-value\nexport CLAUDE_CONFIG_DIR="/srv/claude cfg"\nOPENAI_API_KEY=sk-nope\n');
  const v = configDirFromEnvFile(f);
  assert.strictEqual(v, '/srv/claude cfg');
  assert.ok(!String(v).includes('secret') && !String(v).includes('sk-nope'));
  fs.writeFileSync(f, "CLAUDE_CONFIG_DIR='/a/b'\n");
  assert.strictEqual(configDirFromEnvFile(f), '/a/b');
  fs.writeFileSync(f, 'CLAUDE_CONFIG_DIR=/plain/dir # note\n');
  assert.strictEqual(configDirFromEnvFile(f), '/plain/dir');
  fs.writeFileSync(f, 'SESSION_SECRET=top-secret-value\nCLAUDE_CONFIG_DIRX=/no\n');
  assert.strictEqual(configDirFromEnvFile(f), null);
  fs.writeFileSync(f, 'CLAUDE_CONFIG_DIR=\n');
  assert.strictEqual(configDirFromEnvFile(f), null);
  assert.strictEqual(configDirFromEnvFile(path.join(TMP, 'no-such-env')), null);
});

test('the install .env supplies CLAUDE_CONFIG_DIR to the engine when the environment lacks it, and the environment wins when it has it', async () => {
  const { connectClaude } = require(path.join(ISO.inst, 'scripts', 'hub-cli.js'));
  const real = S();
  const fromFile = fs.mkdtempSync(path.join(TMP, 'cfgenv-'));
  const envFile = path.join(TMP, 'env-b');
  fs.writeFileSync(envFile, `SESSION_SECRET=top-secret-value\nCLAUDE_CONFIG_DIR=${fromFile}\n`);
  let seen = null;
  const signin = { ...real, createSignIn: (deps) => { seen = deps.env(); return real.createSignIn(deps); } };
  const t = inproc();
  delete t.env.CLAUDE_CONFIG_DIR;
  const code = await connectClaude({ ...t.opts, signin, isTTY: true, envFile, read: async () => GOOD });
  assert.strictEqual(code, 0, t.err.join('\n'));
  assert.strictEqual(seen.CLAUDE_CONFIG_DIR, fromFile);
  assert.ok(fs.existsSync(path.join(fromFile, '.credentials.json')), 'the sign-in landed in the .env directory');
  assert.ok(!Object.values(seen).includes('top-secret-value'));
  // the environment's own value wins
  const t2 = inproc();
  seen = null;
  const c2 = await connectClaude({ ...t2.opts, signin, isTTY: true, envFile, read: async () => GOOD });
  assert.strictEqual(c2, 0, t2.err.join('\n'));
  assert.strictEqual(seen.CLAUDE_CONFIG_DIR, t2.cfg);
});

test('refused under sudo: a root run on an install whose data folder belongs to someone else', async () => {
  const { connectClaude } = require(path.join(ISO.inst, 'scripts', 'hub-cli.js'));
  const lines = [];
  const code = await connectClaude({ rootNote: () => 'Run this without sudo, as the user that runs your Maestro (user id 1000).', sayErr: (s) => lines.push(s), say: () => lines.push('said') });
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(lines, ['Run this without sudo, as the user that runs your Maestro (user id 1000).']);
});
