'use strict';
// Secret values from .env stay in an in-memory store (lib/hub-secrets) and never reach process.env or a child's environment.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const hs = require('../lib/hub-secrets');

const ENV_TEXT = [
  'GITHUB_TOKEN=ghp-test-123',
  'HUB_AUTH_PASSWORD= pw-test-123 ',
  'HUB_AUTH_USERNAME=sam',
  'HUB_WALLET_OWNER=owner-address-placeholder',
  'OPENAI_API_KEY=sk-test-123',
  'HUB_SETUP_TOKEN=setup-test-123',
  'PORT=3999',
  'HUB_AUTH_DIR=/tmp/auth-dir',
  'LM_STUDIO_URL=http://localhost:1234/v1',
  'not a line',
].join('\n');

function envFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-secrets-'));
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, ENV_TEXT);
  return f;
}
const SECRET_NAMES = ['GITHUB_TOKEN', 'HUB_AUTH_PASSWORD', 'HUB_AUTH_USERNAME', 'HUB_WALLET_OWNER', 'OPENAI_API_KEY', 'HUB_SETUP_TOKEN'];

function withStore(fn) {
  return async () => {
    hs._resetForTests();
    const saved = { ...process.env };
    for (const n of SECRET_NAMES) delete process.env[n];
    try { await fn(); } finally {
      hs._resetForTests();
      for (const n of SECRET_NAMES) { if (n in saved) process.env[n] = saved[n]; else delete process.env[n]; }
    }
  };
}

test('isSecretName: secrets, wallet names, and the non-secret exceptions', () => {
  for (const n of ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'HUB_AUTH_PASSWORD', 'GMAIL_OAUTH_CLIENT_SECRET', 'HUB_WALLET_OWNER', 'HUB_WALLET_BACKUP_DIR']) assert.equal(hs.isSecretName(n), true, n);
  for (const n of ['PORT', 'LM_STUDIO_URL', 'HUB_AUTH_DIR', 'SSH_AUTH_SOCK', 'XAUTHORITY', 'GPG_AGENT_INFO']) assert.equal(hs.isSecretName(n), false, n);
});

test('loadEnvFile: secret names go to the store, the others into env', withStore(() => {
  const env = {};
  const r = hs.loadEnvFile(envFile(), { env });
  assert.deepStrictEqual(env, { PORT: '3999', HUB_AUTH_DIR: '/tmp/auth-dir', LM_STUDIO_URL: 'http://localhost:1234/v1' });
  assert.deepStrictEqual(r.loaded.sort(), ['HUB_AUTH_DIR', 'LM_STUDIO_URL', 'PORT']);
  assert.deepStrictEqual(r.secret.sort(), [...SECRET_NAMES].sort());
  assert.equal(JSON.stringify(r).includes('sk-test-123'), false, 'names only');
  assert.equal(hs.get('OPENAI_API_KEY'), 'sk-test-123');
  assert.equal(hs.get('HUB_AUTH_PASSWORD'), 'pw-test-123', 'trimmed');
  assert.equal(hs.has('GITHUB_TOKEN'), true);
  assert.equal(hs.has('PORT'), false);
  assert.deepStrictEqual(hs.names().sort(), [...SECRET_NAMES].sort());
  assert.equal(hs.loadEnvFile('/nonexistent/.env', { env }).loaded.length, 0);
}));

test('loadEnvFile: a launch-time value in env is left alone, and the .env value still wins for readers, as before', withStore(() => {
  const env = { OPENAI_API_KEY: 'sk-launch-1' };
  hs.loadEnvFile(envFile(), { env });
  assert.equal(env.OPENAI_API_KEY, 'sk-launch-1');
  assert.equal(hs.has('OPENAI_API_KEY'), true);
  assert.notEqual(hs.get('OPENAI_API_KEY'), 'sk-launch-1');
}));

test('a child started with the env object shows no secret name', withStore(() => {
  const env = { PATH: process.env.PATH };
  hs.loadEnvFile(envFile(), { env });
  const r = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(Object.keys(process.env)))'], { env, encoding: 'utf8' });
  const keys = JSON.parse(r.stdout);
  for (const n of SECRET_NAMES) assert.equal(keys.includes(n), false, n);
  assert.ok(keys.includes('PORT'));
}));

test('get falls back to process.env; envView merges and is a copy', withStore(() => {
  process.env.SOME_TEST_TOKEN = 'launch-value';
  try {
    hs.loadEnvFile(envFile(), { env: {} });
    assert.equal(hs.get('SOME_TEST_TOKEN'), 'launch-value');
    assert.equal(hs.get('NOT_THERE_AT_ALL'), undefined);
    const v = hs.envView();
    assert.equal(v.SOME_TEST_TOKEN, 'launch-value');
    assert.equal(v.OPENAI_API_KEY, 'sk-test-123');
    v.OPENAI_API_KEY = 'changed';
    assert.equal(hs.get('OPENAI_API_KEY'), 'sk-test-123');
    assert.equal(process.env.OPENAI_API_KEY, undefined);
  } finally { delete process.env.SOME_TEST_TOKEN; }
}));

test('settings: a provider key held only in the store is found', withStore(() => {
  hs.loadEnvFile(envFile(), { env: {} });
  const settings = require('../lib/settings');
  if (settings.get().providers?.openai?.apiKey) return;   // a saved key would win; not the case in a clean checkout
  assert.equal(settings.getProviderKey('openai'), 'sk-test-123');
  assert.equal(settings.keySource('openai'), 'environment');
}));

test('bind-host: legacy auth held only in the store lets a network bind through', withStore(() => {
  const { resolveBindHost } = require('../lib/bind-host');
  const base = { HUB_BIND_HOST: '0.0.0.0' };
  assert.equal(resolveBindHost({ ...base }).exposed, false);   // an explicit env without the pair: refused
  const before = process.env.HUB_BIND_HOST;
  process.env.HUB_BIND_HOST = '0.0.0.0';
  try {
    assert.equal(resolveBindHost().exposed, false, 'no auth anywhere');
    hs.loadEnvFile(envFile(), { env: {} });
    const r = resolveBindHost();
    assert.equal(r.exposed, true);
    assert.equal(r.host, '0.0.0.0');
  } finally { if (before === undefined) delete process.env.HUB_BIND_HOST; else process.env.HUB_BIND_HOST = before; }
}));

test('readiness: legacyAuth sees the pair held only in the store', withStore(async () => {
  const { getReadiness } = require('../lib/readiness');
  const r0 = getReadiness({ hasUsers: () => true });
  const ids = async () => (await r0.check()).items.map(i => i.id);
  assert.equal((await ids()).includes('legacy-auth'), false);
  hs.loadEnvFile(envFile(), { env: {} });
  assert.equal((await ids()).includes('legacy-auth'), true);
}));

test('welcome: the setup token held only in the store is the code', withStore(() => {
  hs.loadEnvFile(envFile(), { env: {} });
  const { createWelcome } = require('../lib/welcome');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'welcome-hs-'));
  const w = createWelcome({ dataDir: dir, settings: { get: () => ({ providers: {} }) }, claudeAuth: { hasSdkCredentials: () => false } });
  assert.equal(w.readToken(), 'setup-test-123');
}));

test('settings adoptEnvFileKeys sees HUB_KEEP_ENV_KEYS held in the store', withStore(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-hs-'));
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, 'HUB_KEEP_ENV_KEYS=1\nOPENAI_API_KEY=sk-test-123\n');
  hs.loadEnvFile(f, { env: {} });
  const r = require('../lib/settings').adoptEnvFileKeys({ envFile: f });
  assert.equal(r.kept, true);
  assert.equal(fs.readFileSync(f, 'utf8').includes('sk-test-123'), true, 'the file is left alone');
}));
