'use strict';
// lib/child-env: allow-listed environments for what a non-lead agent runs, and the spawn paths that use it.
// Only fake environments (example values); nothing here reads the real process environment's values.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ce = require('../lib/child-env.js');
const { buildChildEnv, envForAgent, cleanEnvKeep, envKeepOf, BASE_KEEP, HOST_KEEP, CLIENT_KEEP, SECRET_RE, ENV_NAME_RE, ENV_MAX } = ce;

const FAKE = {
  PATH: '/usr/bin:/bin', HOME: '/home/owner', USER: 'owner', LANG: 'C.UTF-8', LC_ALL: 'C', TERM: 'xterm', PORT: '3000',
  XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', npm_config_cache: '/tmp/npm',
  ANTHROPIC_API_KEY: 'sk-test-123', OPENAI_API_KEY: 'sk-test-123', GITHUB_TOKEN: 'ghp_test123',
  HUB_AUTH_PASSWORD: 'pw-test', HUB_WALLET_OWNER: 'owner', SSH_AUTH_SOCK: '/tmp/ssh-x/agent.1', SSH_AGENT_PID: '123',
  GPG_AGENT_INFO: '/tmp/gpg:1:1', LM_STUDIO_URL: 'http://192.0.2.5:1234', FOO_BAR: 'baz',
  npm_config__authToken: 'tok-test', 'npm_config_//registry/:_auth': 'abc', LC_SECRET_X: 'x',
  CLAUDE_CODE_OAUTH_TOKEN: 'oat-test', CLAUDE_CONFIG_DIR: '/home/owner/.claude', CODEX_HOME: '/home/owner/.codex',
};

test('constants: the first eleven BASE_KEEP names are fixed, PORT follows', () => {
  assert.deepStrictEqual(BASE_KEEP.slice(0, 11), ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_*', 'TERM', 'TZ', 'COLUMNS', 'LINES']);
  assert.strictEqual(BASE_KEEP[11], 'PORT');
  assert.ok(HOST_KEEP.includes('XDG_*') && HOST_KEEP.includes('ProgramFiles(x86)'));
  assert.deepStrictEqual(CLIENT_KEEP, { claude: ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN'], codex: ['CODEX_HOME'] });
  assert.ok(SECRET_RE.test('my_Token') && !SECRET_RE.test('LANG'));
  assert.ok(ENV_NAME_RE.test('FOO_1') && !ENV_NAME_RE.test('1FOO') && ENV_MAX === 32);
});

test('buildChildEnv keeps the basics and drops every secret and unknown name', () => {
  const out = buildChildEnv(FAKE);
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'PORT', 'npm_config_cache']) assert.strictEqual(out[k], FAKE[k], k);
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'HUB_AUTH_PASSWORD', 'HUB_WALLET_OWNER', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
    'GPG_AGENT_INFO', 'LM_STUDIO_URL', 'FOO_BAR', 'npm_config__authToken', 'npm_config_//registry/:_auth', 'LC_SECRET_X', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME']) {
    assert.ok(!(k in out), `${k} must not pass`);
  }
});

test('buildChildEnv: set wins, undefined skipped, base untouched, result is a new object', () => {
  const base = { PATH: '/bin', HOME: '/h', FOO: 'x', GONE: undefined };
  const copy = { ...base };
  const out = buildChildEnv(base, { set: { PATH: '/custom', EXTRA: '1', NOPE: undefined }, keep: ['FOO'] });
  assert.deepStrictEqual(out, { PATH: '/custom', HOME: '/h', FOO: 'x', EXTRA: '1' });
  assert.deepStrictEqual(base, copy);
  assert.notStrictEqual(out, base);
  assert.deepStrictEqual(buildChildEnv(undefined), {});
});

test('keep: an exact name passes even when it looks secret; a wildcard never does', () => {
  const out = buildChildEnv(FAKE, { keep: ['GITHUB_TOKEN'] });
  assert.strictEqual(out.GITHUB_TOKEN, 'ghp_test123');
  assert.ok(!('ANTHROPIC_API_KEY' in out));
  assert.ok(!('npm_config__authToken' in out) && !('LC_SECRET_X' in out));
  assert.strictEqual(buildChildEnv(FAKE, { keep: ['LC_SECRET_X'] }).LC_SECRET_X, 'x');
});

test('Windows names match case-insensitively, other platforms exactly', () => {
  const base = { Path: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', comspec: 'cmd.exe', Foo: 'x', userprofile: 'C:\\Users\\owner', lc_all: 'C', GITHUB_TOKEN: 't' };
  const win = buildChildEnv(base, { platform: 'win32' });
  assert.deepStrictEqual(Object.keys(win).sort(), ['Path', 'SYSTEMROOT', 'comspec', 'lc_all', 'userprofile'].sort());
  const linux = buildChildEnv(base, { platform: 'linux' });
  assert.deepStrictEqual(Object.keys(linux), []);
  assert.ok(ce.matcher(['SystemRoot'], { windows: true })('SYSTEMROOT'));
  assert.ok(!ce.matcher(['SystemRoot'], { windows: false })('SYSTEMROOT'));
  assert.ok(!ce.matcher(['LC_*'], { windows: true })('lc_token'));
});

test('envForAgent: a lead keeps everything (and set), a non-lead is filtered', () => {
  const lead = envForAgent({ name: 'agent-a', lead: true }, { base: FAKE, set: { X_SET: '1' } });
  assert.deepStrictEqual(lead, { ...FAKE, X_SET: '1' });
  assert.notStrictEqual(lead, FAKE);
  const plain = envForAgent({ name: 'sam' }, { base: FAKE, set: { X_SET: '1' } });
  assert.strictEqual(plain.X_SET, '1');
  assert.ok(plain.PATH && !plain.GITHUB_TOKEN && !plain.HUB_AUTH_PASSWORD && !plain.SSH_AUTH_SOCK);
  // an isLead function decides instead of the flag
  assert.deepStrictEqual(envForAgent({ name: 'robin' }, { base: FAKE, isLead: (a) => a.name === 'robin' }), { ...FAKE });
  assert.ok(!('GITHUB_TOKEN' in envForAgent({ name: 'robin', lead: true }, { base: FAKE, isLead: () => false })));
  assert.ok(!('GITHUB_TOKEN' in envForAgent({ name: 'robin' }, { base: FAKE, isLead: () => { throw new Error('x'); } })), 'a throwing check means not lead');
});

test('envForAgent: client grants are per client; envKeep grants exact names; null agent is filtered', () => {
  const c = envForAgent({ name: 'sam' }, { base: FAKE, client: 'claude' });
  assert.strictEqual(c.CLAUDE_CODE_OAUTH_TOKEN, 'oat-test'); assert.strictEqual(c.CLAUDE_CONFIG_DIR, '/home/owner/.claude'); assert.ok(!('CODEX_HOME' in c));
  const x = envForAgent({ name: 'sam' }, { base: FAKE, client: 'codex' });
  assert.strictEqual(x.CODEX_HOME, '/home/owner/.codex'); assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in x) && !('CLAUDE_CONFIG_DIR' in x));
  const none = envForAgent({ name: 'sam' }, { base: FAKE });
  assert.ok(!('CODEX_HOME' in none) && !('CLAUDE_CONFIG_DIR' in none));
  const k = envForAgent({ name: 'sam', envKeep: ['GITHUB_TOKEN', 'FOO_BAR'] }, { base: FAKE });
  assert.strictEqual(k.GITHUB_TOKEN, 'ghp_test123'); assert.strictEqual(k.FOO_BAR, 'baz'); assert.ok(!('OPENAI_API_KEY' in k));
  const n = envForAgent(null, { base: FAKE, client: 'claude', set: { Z: '1' } });
  assert.ok(n.PATH && n.Z === '1' && !n.GITHUB_TOKEN && n.CLAUDE_CODE_OAUTH_TOKEN === 'oat-test');
  assert.ok(!('GITHUB_TOKEN' in envForAgent(undefined, { base: FAKE })));
});

test('cleanEnvKeep: every refusal, trimming and de-duplication', () => {
  assert.deepStrictEqual(cleanEnvKeep(null), { ok: true, value: [] });
  assert.deepStrictEqual(cleanEnvKeep(undefined), { ok: true, value: [] });
  assert.deepStrictEqual(cleanEnvKeep(['  A_B ', 'C', 'A_B']), { ok: true, value: ['A_B', 'C'] });
  assert.deepStrictEqual(cleanEnvKeep('A'), { ok: false, error: 'envKeep must be a list of environment variable names' });
  assert.deepStrictEqual(cleanEnvKeep({ a: 1 }), { ok: false, error: 'envKeep must be a list of environment variable names' });
  assert.deepStrictEqual(cleanEnvKeep(['A', 5]), { ok: false, error: 'envKeep holds names only' });
  assert.strictEqual(cleanEnvKeep(['1ABC']).error, '"1ABC" is not a valid environment variable name (letters, digits and _, not starting with a digit, up to 64 characters)');
  assert.strictEqual(cleanEnvKeep(['A=B']).ok, false);
  assert.strictEqual(cleanEnvKeep(['']).ok, false);
  assert.strictEqual(cleanEnvKeep(['x'.repeat(65)]).error, `"${'x'.repeat(40)}" is not a valid environment variable name (letters, digits and _, not starting with a digit, up to 64 characters)`);
  assert.strictEqual(cleanEnvKeep(['x'.repeat(64)]).ok, true);
  const many = Array.from({ length: 33 }, (_, i) => `V${i}`);
  assert.deepStrictEqual(cleanEnvKeep(many), { ok: false, error: 'envKeep may list at most 32 names' });
  assert.strictEqual(cleanEnvKeep(many.slice(0, 32)).ok, true);
  assert.strictEqual(cleanEnvKeep([...many.slice(0, 32), 'V0']).ok, true, 'duplicates do not count');
});

test('envKeepOf never throws', () => {
  assert.deepStrictEqual(envKeepOf({ envKeep: ['A', 'A'] }), ['A']);
  assert.deepStrictEqual(envKeepOf({ envKeep: 'bad' }), []);
  assert.deepStrictEqual(envKeepOf(null), []);
  assert.deepStrictEqual(envKeepOf({ envKeep: [{}] }), []);
});

test('leadCheck returns a function that is false for no agent and never throws', () => {
  const f = ce.leadCheck();
  assert.strictEqual(typeof f, 'function');
  assert.strictEqual(f(null), false);
  assert.strictEqual(f({}), false);
});

// ── Spawn paths ──────────────────────────────────────────────────────────────────────────────────────────────
test('hub tools: Bash runs with the env it was given (not the hub\'s)', async () => {
  const { createHubTools } = require('../lib/hub-tools.js');
  process.env.CHILD_ENV_TEST_HUB_ONLY = 'hub-only-value';
  try {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'childenv-'));
    const t = createHubTools({ cwd: d, log: () => {}, env: { PATH: process.env.PATH, KEEP_ME: 'yes-123' } });
    const r = await t.call('Bash', { command: 'echo "[$KEEP_ME][$CHILD_ENV_TEST_HUB_ONLY][$TERM]"' });
    assert.strictEqual(r.text, '[yes-123][][dumb]');
    const old = createHubTools({ cwd: d, log: () => {} });
    assert.strictEqual((await old.call('Bash', { command: 'echo "[$CHILD_ENV_TEST_HUB_ONLY]"' })).text, '[hub-only-value]', 'without env: unchanged behaviour');
    fs.rmSync(d, { recursive: true, force: true });
  } finally { delete process.env.CHILD_ENV_TEST_HUB_ONLY; }
});

test('jobs: the process gets envFor(owner); without envFor the hub\'s env as before', async () => {
  const { JobRunner } = require('../lib/jobs.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'childenv-jobs-'));
  const seen = [];
  const mk = (extra) => new JobRunner({ dataDir: dir, spawnMode: 'setsid', pollMs: 50, log: () => {}, defaultCwd: async () => dir, notify: async () => {}, agentExists: async () => true, ...extra });
  const out = path.join(dir, 'env.txt');
  const r = mk({ envFor: (owner) => { seen.push(owner); return { PATH: process.env.PATH, JOB_MARK: `for-${owner}` }; } });
  await r.run({ owner: 'sam', name: 'e', command: `echo "$JOB_MARK|$HOME" > ${out}` });
  for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise(x => setTimeout(x, 50));
  assert.deepStrictEqual(seen, ['sam']);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'for-sam|');
  r.cancelAll && r.cancelAll();
  assert.strictEqual(mk({}).envFor, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skill manager builds a filtered env for stdio skills', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'skills', 'skill-manager.js'), 'utf8');
  assert.match(src, /buildChildEnv\(process\.env, \{ set: skill\.env \|\| \{\} \}\)/);
  assert.ok(!/\{ \.\.\.process\.env, \.\.\.skill\.env \}/.test(src));
  assert.ok(!/skill\.env \? \{/.test(src));
  const McpStdioClient = require('../lib/skills/mcp-stdio.js');
  const c = new McpStdioClient('true', [], { env: buildChildEnv(FAKE, { set: { SKILL_X: '1' } }) });
  assert.ok(c.env.SKILL_X === '1' && !('GITHUB_TOKEN' in c.env));
});

test('sdk-chat: hands, the Claude client, the Codex client and jobs use childEnv.envForAgent', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /const childEnv = require\('\.\/child-env'\)/);
  assert.match(src, /createHubTools\(\{[^\n]*env: childEnv\.envForAgent\(agent, \{ isLead: leadFor\(agentName\) \}\)/);
  assert.match(src, /childEnv\.envForAgent\(hands\.agent, \{ base: require\('\.\/billing'\)\.clientEnvWithoutApiKey\(process\.env\), client: 'claude', isLead: leadFor\(agentName\), set: \{ CLAUDE_CODE_AUTO_COMPACT_WINDOW: String\(autoCompactWindow\),/);
  assert.match(src, /const env = childEnv\.envForAgent\(hands\.agent, \{ base: codexBase, client: 'codex', isLead: leadFor\(agentName\) \}\)/);
  assert.ok(!/const env = \{ \.\.\.process\.env \};/.test(src), 'the old full copy at the Codex site is gone');
  assert.ok(/delete codexBase\.OPENAI_API_KEY; delete codexBase\.CODEX_API_KEY; delete codexBase\.OPENAI_BASE_URL;/.test(src));
  assert.match(src, /envFor: \(owner\) =>[\s\S]{0,700}childEnv\.buildChildEnv\(process\.env\)/);
});

test('server.js: envKeep changes are refused for members and service calls', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /'envKeep' in body && \(req\.hubService \|\| req\.hubToken \|\| !req\.hubUser \|\| !access\.isAdmin\(req\.hubUser\)/);
});

// ── Round 5 fixes ────────────────────────────────────────────────────────────────────────────────────────────
test('DOCKER_KEEP lists the Docker endpoint names and the filter still drops them', () => {
  assert.deepStrictEqual(ce.DOCKER_KEEP, ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']);
  assert.ok(!('DOCKER_HOST' in buildChildEnv({ PATH: '/bin', DOCKER_HOST: 'tcp://192.0.2.7:2375' })));
});

test('jobs: a boxed job\'s wrapper gets the Docker endpoint on top of envFor (and no hub secret)', async () => {
  const { JobRunner } = require('../lib/jobs.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'childenv-box-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const out = path.join(dir, 'docker-env.txt');
  // a fake docker: records the endpoint it was started with, then exits
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash\necho "[$DOCKER_HOST][$DOCKER_CONTEXT][$HUB_SECRET_X]" >> ${out}\n`, { mode: 0o755 });
  const saved = { h: process.env.DOCKER_HOST, c: process.env.DOCKER_CONTEXT, s: process.env.HUB_SECRET_X };
  process.env.DOCKER_HOST = 'tcp://192.0.2.7:2375'; process.env.DOCKER_CONTEXT = 'ctx-test'; process.env.HUB_SECRET_X = 'sk-test-123';
  try {
    const r = new JobRunner({ dataDir: path.join(dir, 'a'), spawnMode: 'setsid', pollMs: 50, log: () => {}, defaultCwd: async () => dir, notify: async () => {}, agentExists: async () => true,
      boxFor: async () => ({ name: 'box-test', mounts: [dir] }), envFor: () => ({ PATH: `${bin}:${process.env.PATH}` }) });
    await r.run({ owner: 'sam', name: 'b', command: 'true', cwd: dir });
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise(x => setTimeout(x, 50));
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim().split('\n')[0], '[tcp://192.0.2.7:2375][ctx-test][]', 'endpoint kept, hub secret not');
    r.cancelAll && r.cancelAll();
  } finally {
    for (const [k, v] of [['DOCKER_HOST', saved.h], ['DOCKER_CONTEXT', saved.c], ['HUB_SECRET_X', saved.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('URL credentials: a proxy or registry URL carrying user:pass is dropped unless granted by exact name', () => {
  const base = {
    PATH: '/bin', HTTPS_PROXY: 'http://sam:pw-test@192.0.2.9:8080', HTTP_PROXY: 'http://192.0.2.9:8080', no_proxy: 'localhost',
    npm_config_registry: 'https://sam:pw-test@192.0.2.10/', npm_config_cache: '/tmp/npm', ALL_PROXY: 'socks5://tok@192.0.2.9:1080',
  };
  const out = buildChildEnv(base);
  assert.ok(!('HTTPS_PROXY' in out) && !('npm_config_registry' in out) && !('ALL_PROXY' in out), 'credentialed URLs dropped');
  assert.strictEqual(out.HTTP_PROXY, 'http://192.0.2.9:8080', 'a proxy without credentials stays');
  assert.strictEqual(out.npm_config_cache, '/tmp/npm');
  assert.strictEqual(buildChildEnv({ HTTPS_PROXY: 'https://192.0.2.9/a@b' }).HTTPS_PROXY, 'https://192.0.2.9/a@b', '@ after the authority is not userinfo');
  assert.strictEqual(buildChildEnv(base, { keep: ['HTTPS_PROXY'] }).HTTPS_PROXY, base.HTTPS_PROXY, 'an exact grant keeps it');
  assert.strictEqual(envForAgent({ name: 'sam', envKeep: ['HTTPS_PROXY'] }, { base }).HTTPS_PROXY, base.HTTPS_PROXY);
  assert.ok(!('HTTPS_PROXY' in envForAgent({ name: 'sam' }, { base })));
});

test('leadCheck uses the owner-lead rule (admin-owned flagged leads only)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'child-env.js'), 'utf8');
  assert.match(src, /ag\.ownerLeadNames\(ag\.getAgentsSync\(\)\)\.includes\(agent\.name\)/);
  assert.ok(!/isLeadAgent/.test(src));
  // A stand-in agent list: this test never reads the install's own data/ (the suite's data guard refuses it).
  const agentsPath = require.resolve('../lib/agents.js');
  const saved = require.cache[agentsPath];
  require.cache[agentsPath] = { id: agentsPath, filename: agentsPath, loaded: true, exports: {
    getAgentsSync: () => [{ name: 'lead-a', lead: true }, { name: 'lead-m', lead: true, owner: 'member-1' }, { name: 'sam' }],
    ownerLeadNames: (list) => list.filter(a => a.lead && !a.owner).map(a => a.name),
  } };
  try {
    const isLead = ce.leadCheck();
    assert.strictEqual(isLead({ name: 'lead-a' }), true);
    assert.strictEqual(isLead({ name: 'lead-m' }), false, 'a member-owned lead is not a lead here');
    assert.strictEqual(isLead({ name: 'sam' }), false);
    assert.strictEqual(isLead({ name: 'no-such-agent-zz' }), false);
  } finally { if (saved) require.cache[agentsPath] = saved; else delete require.cache[agentsPath]; }
});

test('sdk-chat: a temporary worker never gets the lead\'s environment, at every call site', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /const leadFor = \(name\) => \{[^\n]*temporalWorkers\.getVirtual\(name\)[^\n]*\(\) => false : childEnv\.leadCheck\(\)/);
  assert.match(src, /childEnv\.envForAgent\(rec, \{ isLead: leadFor\(owner\) \}\)/);
  assert.ok(!/isLead: childEnv\.leadCheck\(\)/.test(src), 'no call site uses the bare lead check');
});

test('hub tools: rg, pdftotext and pdftoppm get the given env (and none when no env was given)', async () => {
  const { createHubTools } = require('../lib/hub-tools.js');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'childenv-rg-'));
  try {
    fs.writeFileSync(path.join(d, 'a.txt'), 'needle\n');
    const calls = [];
    const exec = async (cmd, args, opts) => { calls.push({ cmd, opts }); if (cmd === 'rg' && args[0] !== '--version') return { stdout: `${path.join(d, 'a.txt')}:1:needle\n` }; return { stdout: '' }; };
    const t = createHubTools({ cwd: d, log: () => {}, exec, env: { PATH: '/bin', KEEP_ME: 'yes-123' } });
    await t.call('Grep', { pattern: 'needle', path: d });
    assert.ok(calls.length >= 2 && calls.every(c => c.cmd === 'rg' && c.opts.env && c.opts.env.KEEP_ME === 'yes-123'), JSON.stringify(calls.map(c => [c.cmd, !!c.opts.env])));
    fs.writeFileSync(path.join(d, 'x.pdf'), '%PDF-1.4');
    calls.length = 0;
    await t.call('Read', { file_path: path.join(d, 'x.pdf'), pages: '1' }).catch(() => {});
    assert.ok(calls.some(c => c.cmd === 'pdftotext') && calls.every(c => c.opts.env && c.opts.env.KEEP_ME === 'yes-123'));
    const t2 = createHubTools({ cwd: d, log: () => {}, exec });
    calls.length = 0;
    await t2.call('Grep', { pattern: 'needle', path: d });
    assert.ok(calls.length >= 1 && calls.every(c => !('env' in c.opts)), 'no env given: unchanged');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('sdk-chat: a throw while building the hands drops the module-level shell and file tools', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /catch \(e\) \{\s*console\.warn\(`\[hub-tools\] \$\{agentName\}: \$\{e\.message\}`\);[\s\S]{0,500}for \(const name of hubToolsLib\.TOOL_NAMES\) \{[\s\S]{0,400}handlers\.delete\(name\);/);
});
