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
  assert.ok(r.stdout.includes(S().WORDS.pasteCode));
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

test('refused under sudo: a root run on an install whose data folder belongs to someone else', async () => {
  const { connectClaude } = require(path.join(ISO.inst, 'scripts', 'hub-cli.js'));
  const lines = [];
  const code = await connectClaude({ rootNote: () => 'Run this without sudo, as the user that runs your Maestro (user id 1000).', sayErr: (s) => lines.push(s), say: () => lines.push('said') });
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(lines, ['Run this without sudo, as the user that runs your Maestro (user id 1000).']);
});
