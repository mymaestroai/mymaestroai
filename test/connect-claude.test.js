'use strict';
// `mymaestro connect claude` (scripts/hub-cli.js). The command is called in process with injected terminal flag, reader, check,
// hidden mode and output, and the stand-in client (test/fixtures/fake-claude-client.js) as the client. One child-process test:
// a piped stdin is refused. No real `claude` program, no real installer.
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
const TERMINAL_SENTENCE = 'connect claude asks for the code in a terminal; run it in a terminal on the computer that runs your Maestro.';
const SSH_LINE = "Over SSH a Mac's keychain can be locked. Run this in Terminal on the Mac itself, or press Sign in again on your Maestro's page.";
const S = () => require(path.join(ISO.inst, 'lib', 'claude-signin'));
const CLI_MOD = () => require(CLI);
// What the command says on success: it qualifies what was verified (this installation's CLI settings), unlike the page's sentence.
const CLI_DONE_A = "Claude answered using this installation's CLI settings";
const CLI_DONE_B = 'custom account or Claude folder';
const saidDone = (said) => said.some(s => s.includes(CLI_DONE_A) && s.includes(CLI_DONE_B));

// In-process setup: the stand-in client, a temp config folder, an injected check, and a log of the order of calls.
function inproc({ extraEnv = {}, signedIn = false } = {}) {
  const cfg = fs.mkdtempSync(path.join(TMP, 'cfgp-'));
  if (signedIn) fs.writeFileSync(path.join(cfg, '.credentials.json'), '{}');
  const env = { PATH: process.env.PATH, HOME: cfg, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CLI_PATH: BIN, ...extraEnv };
  const said = [], err = [], log = [];
  const envFile = path.join(cfg, 'install.env');   // the install's .env: it sets the same folder as the terminal here
  fs.writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${cfg}\n`);
  const hidden = { begin: () => log.push('begin'), end: () => log.push('end') };
  const opts = {
    rootNote: () => null,
    say: (s) => { said.push(s); log.push('say:' + s); },
    sayErr: (s) => { err.push(s); log.push('err:' + s); },
    env, hidden, envFile, isTTY: true, pollMs: 20,
    verify: async () => ({ ok: true, state: 'ready' }),
  };
  return { cfg, env, said, err, log, hidden, opts, creds: path.join(cfg, '.credentials.json') };
}
const transcript = (t) => t.said.join('\n') + '\n' + t.err.join('\n') + '\n' + t.log.join('\n');

test('piped stdin (a child process): refused with the terminal sentence, exit 1, nothing installed or started', () => {
  const cfg = fs.mkdtempSync(path.join(TMP, 'cfgc-'));
  const env = { PATH: process.env.PATH, HOME: cfg, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CLI_PATH: BIN };
  const r = spawnSync(process.execPath, [CLI, 'connect', 'claude'], { env, input: GOOD + '\n', encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 1, r.stderr + r.stdout);
  assert.ok(r.stderr.includes(TERMINAL_SENTENCE));
  assert.ok(!r.stdout.includes('oauth'));
  assert.ok(!r.stdout.includes('Installing'));
  assert.ok(!fs.existsSync(path.join(cfg, '.credentials.json')));
  assert.ok(!(r.stdout + r.stderr).includes(GOOD));
});

test('`connect` usage and the help list claude', () => {
  const u = spawnSync(process.execPath, [CLI, 'connect', 'other'], { encoding: 'utf8' });
  assert.strictEqual(u.status, 1);
  assert.match(u.stderr, /mymaestro connect claude/);
  assert.match(u.stderr, /mymaestro connect chatgpt/);
  const h = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8' }).stdout;
  assert.match(h, /mymaestro connect claude/);
  assert.match(h, /mymaestro version/);
});

test('the shipped command reads no environment variable of its own to change behaviour (no test stub, no NODE_ENV)', () => {
  const REAL = path.join(__dirname, '..');
  const cli = fs.readFileSync(path.join(REAL, 'scripts', 'hub-cli.js'), 'utf8');
  assert.ok(!cli.includes('MM_SIGNIN_VERIFY_STUB'));
  assert.ok(!/NODE_ENV/.test(cli));
  const inLib = fs.readdirSync(path.join(REAL, 'lib')).filter(f => f.endsWith('.js') && fs.readFileSync(path.join(REAL, 'lib', f), 'utf8').includes('MM_SIGNIN_VERIFY_STUB'));
  assert.deepStrictEqual(inLib, []);
});

test('refusals come first: sudo, then a stdin that is not a terminal, before find, install, hidden mode or the engine', async () => {
  const real = S();
  const calls = [];
  const spy = (n, f) => (...a) => { calls.push(n); return f(...a); };
  const signin = {
    ...real,
    findClient: spy('find', () => null),
    installClient: spy('install', async () => false),
    authStatus: spy('status', async () => ({ loggedIn: false })),
    createSignIn: spy('engine', () => { throw new Error('must not start'); }),
  };
  const hidden = { begin: () => calls.push('begin'), end: () => calls.push('end') };
  // not a terminal
  let t = inproc();
  let code = await CLI_MOD().connectClaude({ ...t.opts, signin, hidden, isTTY: false, read: async () => { calls.push('read'); return GOOD; } });
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(t.err, [TERMINAL_SENTENCE]);
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(t.said, []);
  // sudo wins over the terminal check
  t = inproc();
  code = await CLI_MOD().connectClaude({ ...t.opts, signin, hidden, isTTY: false, rootNote: () => 'Run this without sudo, as the user that runs your Maestro (user id 1000).' });
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(t.err, ['Run this without sudo, as the user that runs your Maestro (user id 1000).']);
  assert.deepStrictEqual(calls, []);
  assert.ok(!fs.existsSync(t.creds));
});

test('signed out, good code: the steps, the done sentence, exit 0, credentials created, the code is in no transcript line', async () => {
  const t = inproc();
  const prompts = [];
  const code = await CLI_MOD().connectClaude({ ...t.opts, read: async (q) => { t.log.push('read'); prompts.push(q); return GOOD; } });
  assert.strictEqual(code, 0, t.err.join('\n'));
  assert.deepStrictEqual(prompts, ['> ']);
  assert.ok(t.said.includes(S().WORDS.signedOut));
  assert.ok(t.said.includes(S().WORDS.openLink));
  assert.ok(t.said.includes('  https://claude.example/oauth/authorize?code=true&state=standin'));
  assert.ok(t.said.includes('Paste the code below and press Enter. It is not shown as you paste it.'));
  assert.ok(t.said.includes(S().WORDS.checking) && saidDone(t.said));
  assert.ok(!t.said.includes(S().WORDS.done), 'the page\'s sentence is not used by the command');
  assert.ok(fs.existsSync(t.creds));
  assert.ok(!transcript(t).includes(GOOD));
  assert.ok(!prompts.join('').includes(GOOD));
  assert.doesNotMatch(transcript(t), /CLAUDE_CODE_OAUTH_TOKEN|setup-token|dummy-token/);
});

test('hidden mode is entered before the link is printed, kept until the code is read, and restored at the end', async () => {
  const t = inproc();
  const code = await CLI_MOD().connectClaude({ ...t.opts, read: async () => { t.log.push('read'); return GOOD; } });
  assert.strictEqual(code, 0, t.err.join('\n'));
  const i = (x) => t.log.indexOf(x);
  const link = t.log.findIndex(l => l.startsWith('say:  https://'));
  assert.strictEqual(t.log[0], 'begin', 'the first thing is the hidden mode');
  assert.ok(i('begin') < link && link < i('read') && i('read') < i('end'), t.log.join(' | '));
  assert.strictEqual(t.log.filter(l => l === 'begin').length, 1);
  assert.strictEqual(t.log.filter(l => l === 'end').length, 1);
  assert.strictEqual(t.log[t.log.length - 1], 'end');
});

test('hidden mode is restored when the sign-in fails (bad code) and when the check fails', async () => {
  // a bad code: the engine ends with the code sentence
  const t = inproc();
  const code = await CLI_MOD().connectClaude({ ...t.opts, read: async () => { t.log.push('read'); return 'WRONG-CODE-99999'; } });
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(t.err, [S().WORDS.failed.code]);
  assert.ok(!fs.existsSync(t.creds));
  assert.ok(!transcript(t).includes('WRONG-CODE-99999'));
  assert.deepStrictEqual([t.log[0], t.log[t.log.length - 1]], ['begin', 'end']);
  // the check fails after a good code
  const t2 = inproc();
  const c2 = await CLI_MOD().connectClaude({ ...t2.opts, verify: async () => ({ ok: false, state: 'limit' }), read: async () => GOOD });
  assert.strictEqual(c2, 1);
  assert.deepStrictEqual(t2.err, [S().WORDS.failed.limit]);
  assert.strictEqual(t2.log[t2.log.length - 1], 'end');
  // already signed in and the check fails
  const t3 = inproc({ signedIn: true });
  const c3 = await CLI_MOD().connectClaude({ ...t3.opts, verify: async () => ({ ok: false, state: 'network' }), read: async () => GOOD });
  assert.strictEqual(c3, 1);
  assert.deepStrictEqual(t3.err, [S().WORDS.failed.network]);
  assert.strictEqual(t3.log[t3.log.length - 1], 'end');
  // an exception
  const t4 = inproc();
  const signin = { ...S(), createSignIn: () => { throw new Error('boom'); } };
  await assert.rejects(CLI_MOD().connectClaude({ ...t4.opts, signin, read: async () => GOOD }), /boom/);
  assert.deepStrictEqual([t4.log[0], t4.log[t4.log.length - 1]], ['begin', 'end']);
});

test('Ctrl-C: the client is stopped, the hidden mode is restored, the exit code is 130', async () => {
  const t = inproc();
  const exits = [];
  const exit = (c) => { exits.push(c); throw new Error('exit-called'); };
  const real = S();
  let engine = null;
  const signin = { ...real, createSignIn: (d) => { engine = real.createSignIn(d); return engine; } };
  const listeners = process.listenerCount('SIGINT');
  await assert.rejects(CLI_MOD().connectClaude({
    ...t.opts, signin, exit,
    read: async () => { t.log.push('read'); process.emit('SIGINT'); return GOOD; },
  }), /exit-called/);
  assert.deepStrictEqual(exits, [130]);
  assert.ok(t.log.includes('end'));
  assert.strictEqual(t.log.filter(l => l === 'end').length, 1);
  assert.ok(t.log.indexOf('read') < t.log.indexOf('end'));
  assert.ok(!fs.existsSync(t.creds));
  assert.ok(['cancelled', 'idle'].includes(engine.state().state), engine.state().state);
  assert.strictEqual(process.listenerCount('SIGINT'), listeners, 'the signal listener is removed');
});

test('a code that is too short asks again, three times, then exit 1; one bad try then the good code works', async () => {
  const t = inproc();
  let n = 0;
  const code = await CLI_MOD().connectClaude({ ...t.opts, read: async () => { n++; return 'short'; } });
  assert.strictEqual(code, 1);
  assert.strictEqual(n, 3);
  assert.strictEqual(t.said.filter(s => /doesn't look like the whole code/.test(s)).length, 3);
  assert.ok(!fs.existsSync(t.creds));
  assert.strictEqual(t.log[t.log.length - 1], 'end');
  const t2 = inproc();
  const answers = ['short', GOOD];
  const c2 = await CLI_MOD().connectClaude({ ...t2.opts, read: async () => answers.shift() });
  assert.strictEqual(c2, 0, t2.err.join('\n'));
});

test('already signed in: no sign-in step, just the check, exit 0', async () => {
  const t = inproc({ signedIn: true });
  const code = await CLI_MOD().connectClaude({ ...t.opts, read: async () => { throw new Error('no code is asked'); } });
  assert.strictEqual(code, 0, t.err.join('\n'));
  assert.ok(saidDone(t.said));
  assert.ok(!t.said.includes(S().WORDS.signedOut));
  assert.ok(!t.said.some(s => /oauth/.test(s)));
});

test('the check fails when signed in: the limit and network sentences, exit 1', async () => {
  for (const [state, reason] of [['limit', 'limit'], ['network', 'network']]) {
    const t = inproc({ signedIn: true });
    const code = await CLI_MOD().connectClaude({ ...t.opts, verify: async () => ({ ok: false, state }) });
    assert.strictEqual(code, 1, state);
    assert.deepStrictEqual(t.err, [S().WORDS.failed[reason]], state);
    assert.ok(!t.said.includes(S().WORDS.done));
  }
});

test('an expired login that "auth status" still reports as signed in: goes to the sign-in once, then the check decides', async () => {
  // first check: signed-out (account); after the fresh sign-in: ok
  const t = inproc({ signedIn: true });
  let checks = 0;
  const verify = async () => { checks++; return checks === 1 ? { ok: false, state: 'signed-out' } : { ok: true, state: 'ready' }; };
  const prompts = [];
  const code = await CLI_MOD().connectClaude({ ...t.opts, verify, read: async (q) => { prompts.push(q); return GOOD; } });
  assert.strictEqual(code, 0, t.err.join('\n'));
  assert.strictEqual(checks, 2);
  assert.strictEqual(prompts.length, 1);
  assert.ok(t.said.includes(S().WORDS.signedOut), 'the signed-out sentence is printed first');
  assert.ok(t.said.indexOf(S().WORDS.signedOut) < t.said.findIndex(s => /oauth/.test(s)));
  assert.deepStrictEqual(t.err, []);
  assert.ok(saidDone(t.said));
  // a second failure after the fresh sign-in reports the account sentence, and only then
  const t2 = inproc({ signedIn: true });
  let c2n = 0;
  const code2 = await CLI_MOD().connectClaude({ ...t2.opts, verify: async () => { c2n++; return { ok: false, state: 'signed-out' }; }, read: async () => GOOD });
  assert.strictEqual(code2, 1);
  assert.strictEqual(c2n, 2);
  assert.deepStrictEqual(t2.err, [S().WORDS.failed.account]);
  assert.strictEqual(t2.said.filter(s => s === S().WORDS.signedOut).length, 1);
});

test('the attempt id of start() is passed to submitCode and cancel', async () => {
  const calls = [];
  const real = S();
  let st = { state: 'starting', id: 'att-7' };
  const engine = {
    start: async () => { st = { state: 'link', id: 'att-7', link: 'https://claude.example/oauth/x' }; return { ok: true, id: 'att-7' }; },
    state: () => st,
    submitCode: (c, id) => { calls.push(['submit', id]); if (calls.length === 1) return { ok: false, reason: 'format' }; st = { state: 'done', id }; return { ok: true }; },
    cancel: (id) => { calls.push(['cancel', id]); return { ok: true }; },
  };
  const signin = { ...real, createSignIn: () => engine };
  const t = inproc();
  const code = await CLI_MOD().connectClaude({ ...t.opts, signin, read: async () => GOOD });
  assert.strictEqual(code, 0, t.err.join('\n'));
  assert.deepStrictEqual(calls.filter(c => c[0] === 'submit'), [['submit', 'att-7'], ['submit', 'att-7']]);
  assert.ok(calls.filter(c => c[0] === 'cancel').every(c => c[1] === 'att-7'));
  // too many tries: cancel carries the id too
  calls.length = 0; st = { state: 'link', id: 'att-7', link: 'https://claude.example/oauth/x' };
  engine.start = async () => ({ ok: true, id: 'att-7' });
  engine.submitCode = (c, id) => { calls.push(['submit', id]); return { ok: false, reason: 'format' }; };
  const t2 = inproc();
  const c2 = await CLI_MOD().connectClaude({ ...t2.opts, signin, read: async () => 'x' });
  assert.strictEqual(c2, 1);
  assert.ok(calls.some(c => c[0] === 'cancel' && c[1] === 'att-7'));
  assert.ok(calls.filter(c => c[0] === 'submit').every(c => c[1] === 'att-7'));
});

test('the install .env CLAUDE_CONFIG_DIR wins over the terminal\'s: sign-in env and process.env during the check, one note, process.env restored', async () => {
  const real = S();
  const fromFile = fs.mkdtempSync(path.join(TMP, 'cfgenv-'));
  const envFile = path.join(TMP, 'env-b');
  fs.writeFileSync(envFile, `SESSION_SECRET=top-secret-value\nCLAUDE_CONFIG_DIR=${fromFile}\n`);
  const t = inproc();
  const saved = {};
  for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CLI_PATH']) saved[k] = process.env[k];
  let seen = null, atCheck = 'unset';
  const signin = { ...real, createSignIn: (deps) => { seen = deps.env(); return real.createSignIn(deps); } };
  try {
    Object.assign(process.env, { HOME: t.cfg, CLAUDE_CONFIG_DIR: t.cfg, CLAUDE_CLI_PATH: BIN });   // the terminal's own folder
    const code = await CLI_MOD().connectClaude({
      ...t.opts, env: process.env, signin, envFile, read: async () => GOOD,
      verify: async () => { atCheck = process.env.CLAUDE_CONFIG_DIR; return { ok: true, state: 'ready' }; },
    });
    assert.strictEqual(code, 0, t.err.join('\n'));
    assert.strictEqual(seen.CLAUDE_CONFIG_DIR, fromFile);
    assert.strictEqual(atCheck, fromFile);
    assert.ok(fs.existsSync(path.join(fromFile, '.credentials.json')), 'the sign-in landed in the .env folder');
    assert.ok(!fs.existsSync(t.creds), 'not in the terminal folder');
    assert.ok(!Object.values(seen).includes('top-secret-value'));
    assert.deepStrictEqual(t.said.filter(s => /^Using the Claude folder/.test(s)),
      [`Using the Claude folder your Maestro uses: ${fromFile} (this terminal's CLAUDE_CONFIG_DIR is not used).`]);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, saved.CLAUDE_CONFIG_DIR);
  // the same value in both: no note
  const t2 = inproc({ signedIn: true });
  const envFile2 = path.join(TMP, 'env-c');
  fs.writeFileSync(envFile2, `CLAUDE_CONFIG_DIR=${t2.cfg}\n`);
  const c2 = await CLI_MOD().connectClaude({ ...t2.opts, envFile: envFile2 });
  assert.strictEqual(c2, 0, t2.err.join('\n'));
  assert.ok(!t2.said.some(s => /^Using the/.test(s)));
});

test('the .env supplies the folder when the terminal has none', async () => {
  const real = S();
  const fromFile = fs.mkdtempSync(path.join(TMP, 'cfgenv2-'));
  const envFile = path.join(TMP, 'env-d');
  fs.writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${fromFile}\n`);
  let seen = null;
  const signin = { ...real, createSignIn: (deps) => { seen = deps.env(); return real.createSignIn(deps); } };
  const t = inproc();
  delete t.env.CLAUDE_CONFIG_DIR;
  const code = await CLI_MOD().connectClaude({ ...t.opts, signin, envFile, read: async () => GOOD });
  assert.strictEqual(code, 0, t.err.join('\n'));
  assert.strictEqual(seen.CLAUDE_CONFIG_DIR, fromFile);
  assert.ok(fs.existsSync(path.join(fromFile, '.credentials.json')));
  assert.ok(!t.said.some(s => /^Using the/.test(s)), 'nothing to explain');
});

test('the .env has no CLAUDE_CONFIG_DIR: the terminal\'s is removed from the sign-in env and from process.env during the check, with one note', async () => {
  const real = S();
  const envFile = path.join(TMP, 'env-e');
  fs.writeFileSync(envFile, 'SESSION_SECRET=top-secret-value\n');
  const t = inproc();
  const terminalDir = t.cfg;
  const saved = {};
  for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CLI_PATH']) saved[k] = process.env[k];
  let seen = null, atCheck = 'unset';
  const signin = { ...real, createSignIn: (deps) => { seen = deps.env(); return real.createSignIn(deps); } };
  try {
    Object.assign(process.env, { HOME: t.cfg, CLAUDE_CONFIG_DIR: terminalDir, CLAUDE_CLI_PATH: BIN });
    const code = await CLI_MOD().connectClaude({
      ...t.opts, env: process.env, signin, envFile, read: async () => GOOD,
      verify: async () => { atCheck = process.env.CLAUDE_CONFIG_DIR; return { ok: true, state: 'ready' }; },
    });
    assert.strictEqual(code, 0, t.err.join('\n'));
    assert.ok(!('CLAUDE_CONFIG_DIR' in seen), 'the sign-in env has no CLAUDE_CONFIG_DIR');
    assert.strictEqual(atCheck, undefined, 'process.env has none during the check');
    assert.ok(fs.existsSync(path.join(t.cfg, '.claude', '.credentials.json')), 'the client used the default folder under HOME');
    assert.ok(!fs.existsSync(t.creds));
    assert.strictEqual(t.said.filter(s => /^Using the default Claude folder/.test(s)).length, 1);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, saved.CLAUDE_CONFIG_DIR);
});

test('a Mac over SSH: a failed sign-in or check adds the keychain line; other systems and a success do not', async () => {
  const run = async ({ platform, ssh, signedIn, verify, read }) => {
    const t = inproc({ signedIn, extraEnv: ssh ? { SSH_CONNECTION: '10.0.0.2 5555 10.0.0.1 22' } : {} });
    const code = await CLI_MOD().connectClaude({ ...t.opts, platform, verify, read });
    return { code, t };
  };
  const bad = async () => ({ ok: false, state: 'limit' });
  // the check fails
  let r = await run({ platform: 'darwin', ssh: true, signedIn: true, verify: bad });
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(r.t.err, [S().WORDS.failed.limit, SSH_LINE]);
  // the sign-in fails (bad code)
  r = await run({ platform: 'darwin', ssh: true, signedIn: false, read: async () => 'WRONG-CODE-99999' });
  assert.deepStrictEqual(r.t.err, [S().WORDS.failed.code, SSH_LINE]);
  // not over SSH, or not a Mac: no line
  r = await run({ platform: 'darwin', ssh: false, signedIn: true, verify: bad });
  assert.deepStrictEqual(r.t.err, [S().WORDS.failed.limit]);
  r = await run({ platform: 'linux', ssh: true, signedIn: true, verify: bad });
  assert.deepStrictEqual(r.t.err, [S().WORDS.failed.limit]);
  // a success has none
  r = await run({ platform: 'darwin', ssh: true, signedIn: true, verify: async () => ({ ok: true, state: 'ready' }) });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.t.err, []);
});

test('no client anywhere: the engine installs once (stand-in, under its own cancellation), then the missing sentence, exit 1', async () => {
  const real = S();
  let installs = 0;
  const signin = {
    ...real, findClient: () => null,
    installClient: async () => assert.fail('untracked install'),   // the command itself never installs
    createSignIn: (d) => real.createSignIn({ ...d, installClient: async () => { installs++; return false; } }),
  };
  const t = inproc();
  const code = await CLI_MOD().connectClaude({ ...t.opts, signin, env: {} });
  assert.strictEqual(code, 1);
  assert.strictEqual(installs, 1);
  assert.ok(t.said.some(s => /Installing/.test(s)));
  assert.deepStrictEqual(t.err, [real.WORDS.failed.missing]);
  assert.strictEqual(t.log[t.log.length - 1], 'end');
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

// A hidden-mode stand-in that records the Ctrl-C watchers: each watch() call keeps its callback and options, and counts its release.
function recordingHidden(log) {
  const h = { watchers: [], releases: 0, ends: 0 };
  h.begin = () => log.push('begin');
  h.end = () => { h.ends++; log.push('end'); };
  h.watch = (cb, opts) => { h.watchers.push({ cb, opts }); return () => { h.releases++; }; };
  return h;
}
const untilTrue = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };

test('Ctrl-C while the engine installs the client: the engine gets the cancel for the started attempt, the terminal is restored, nothing is installed outside the engine', async () => {
  const real = S();
  const t = inproc();
  const h = recordingHidden(t.log);
  const exits = [], cancels = [];
  let st = { state: 'starting', id: 'att-9' };
  const engine = {
    start: async () => { st = { state: 'installing', id: 'att-9' }; return { ok: true, id: 'att-9' }; },
    state: () => st,
    submitCode: () => assert.fail('no code is asked while installing'),
    cancel: (id) => { cancels.push(id); st = { state: 'cancelled', id: 'att-9' }; return { ok: true }; },
  };
  const signin = {
    ...real, findClient: () => null,
    installClient: async () => assert.fail('untracked install'),
    createSignIn: () => engine,
  };
  const p = CLI_MOD().connectClaude({ ...t.opts, signin, hidden: h, exit: (c) => exits.push(c), read: async () => assert.fail('no reader') });
  await untilTrue(() => t.said.some(s => /Installing it/.test(s)));
  assert.strictEqual(h.watchers.length, 1, 'the first watcher is on');
  h.watchers[0].cb();   // Ctrl-C typed in the raw mode
  const code = await p;
  assert.deepStrictEqual(exits, [130]);
  assert.ok(cancels.length >= 1 && cancels.every(id => id === 'att-9'), 'the cancel names the started attempt: ' + cancels);
  assert.strictEqual(h.ends, 1, 'the terminal is restored once');
  assert.strictEqual(h.releases, 1);
  assert.strictEqual(code, 1, 'the sign-in loop ended after the cancel');
  assert.ok(!saidDone(t.said));
});

test('Ctrl-C while the check runs after the code was accepted: a second watcher (keepInput false) cancels the bound attempt, exit 130, one restore, no success message', async () => {
  const real = S();
  const t = inproc();
  const h = recordingHidden(t.log);
  const exits = [], cancels = [], submits = [];
  let st = { state: 'starting', id: 'att-5' };
  const engine = {
    start: async () => { st = { state: 'link', id: 'att-5', link: 'https://claude.example/oauth/x' }; return { ok: true, id: 'att-5' }; },
    state: () => st,
    submitCode: (c, id) => { submits.push(id); st = { state: 'checking', id: 'att-5' }; return { ok: true }; },   // held in checking
    cancel: (id) => { cancels.push(id); st = { state: 'cancelled', id: 'att-5' }; return { ok: true }; },
  };
  const signin = { ...real, createSignIn: () => engine };
  const p = CLI_MOD().connectClaude({ ...t.opts, signin, hidden: h, exit: (c) => exits.push(c), read: async () => GOOD });
  await untilTrue(() => h.watchers.length === 2);
  assert.strictEqual(h.releases, 1, 'the first watcher was released before the reader took over');
  assert.strictEqual(h.watchers[1].opts.keepInput, false);
  assert.deepStrictEqual(submits, ['att-5']);
  h.watchers[1].cb();
  const code = await p;
  assert.deepStrictEqual(exits, [130]);
  assert.ok(cancels.length >= 1 && cancels.every(id => id === 'att-5'), 'the bound attempt is cancelled: ' + cancels);
  assert.strictEqual(h.ends, 1);
  assert.strictEqual(h.releases, 2, 'both watchers released, once each');
  assert.strictEqual(code, 1);
  assert.ok(!saidDone(t.said) && !t.said.includes(S().WORDS.done), 'no success message');
});
