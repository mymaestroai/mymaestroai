'use strict';
// lib/welcome: what reaches a child process is never the secrets view. Fake values only; nothing reads data/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWelcome } = require('../lib/welcome');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'welcome-r5-'));
const settings = { get: () => ({}), updateSettings: () => {}, hasAnyApiKey: () => false, getProviderKey: () => '', getProviderUrl: () => '' };
const noClaude = { hasSdkCredentials: () => false, hasSignIn: () => false };

test('welcome: child processes get process.env-based env, never the secrets view (only the sign-in token from the store)', async () => {
  const hs = require('../lib/hub-secrets');
  const f = path.join(tmp(), 'env');
  fs.writeFileSync(f, 'GITHUB_TOKEN=ghp-test-1\nHUB_SETUP_TOKEN=setup-test-123\nCLAUDE_CODE_OAUTH_TOKEN=oat-test\n');
  const NAMES = ['GITHUB_TOKEN', 'HUB_SETUP_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
  const savedEnv = Object.fromEntries(NAMES.map(k => [k, process.env[k]]));   // the launch environment may hold real ones: set aside
  for (const k of NAMES) delete process.env[k];
  hs.loadEnvFile(f, { env: {} });
  try {
    let seen = null; const codexSeen = [];
    const sdk = { query: ({ options }) => { seen = options.env; return (async function* () { yield { type: 'result', is_error: false, result: 'OK' }; })(); } };
    const codexFake = {
      resolveBinary: (e) => { codexSeen.push(e); return '/bin/codex'; },
      loginStatus: async ({ env }) => { codexSeen.push(env); return { installed: true, loggedIn: true, mode: 'chatgpt' }; },
      discoverModels: async ({ env }) => { codexSeen.push(env); return [{ id: 'm1' }]; },
      askOneWord: async ({ env }) => { codexSeen.push(env); return { ok: true }; },
    };
    const w = createWelcome({ dataDir: tmp(), settings, claudeAuth: noClaude, sdkLoader: { loadSdk: async () => sdk, cliOptions: () => ({}) }, sdkModels: async () => [], runDiscovery: () => {}, codex: codexFake });
    assert.strictEqual(w.readToken(), 'setup-test-123', 'reads still see the store');
    assert.strictEqual((await w.checkClaude({ timeoutMs: 5000 })).ok, true);
    assert.strictEqual(seen.CLAUDE_CODE_OAUTH_TOKEN, 'oat-test');
    assert.strictEqual(seen.GITHUB_TOKEN, undefined);
    assert.strictEqual(seen.HUB_SETUP_TOKEN, undefined);
    assert.strictEqual((await w.checkChatGPT({ timeoutMs: 5000 })).ok, true);
    await w.chatgptStatus();
    assert.ok(codexSeen.length >= 5);
    for (const e of codexSeen) for (const k of ['GITHUB_TOKEN', 'HUB_SETUP_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.strictEqual(e[k], undefined, k);
  } finally { hs._resetForTests(); for (const k of NAMES) if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]; }
});
