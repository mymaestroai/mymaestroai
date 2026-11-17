'use strict';
// lib/child-env: scheme-less credentials, and envKeep grants reaching store-held secrets. Fake values only.
const test = require('node:test');
const assert = require('node:assert');
const ce = require('../lib/child-env.js');
const { buildChildEnv, envForAgent } = ce;

test('credentials in a value: scheme-less user:pass@host proxies are dropped, e-mail addresses and plain proxies stay', () => {
  const base = { PATH: '/bin', http_proxy: 'user:pass@127.0.0.1:8080', HTTPS_PROXY: 'user:pass@127.0.0.1:8080/', all_proxy: 'https://user:pass@192.0.2.1/', ALL_PROXY: 'socks5://sam@192.0.2.1:1080', npm_config_email: 'sam@example.com', no_proxy: 'http://proxy:8080', HTTP_PROXY: 'http://192.0.2.1:8080' };
  const out = buildChildEnv(base);
  for (const k of ['http_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) assert.strictEqual(out[k], undefined, k);
  assert.strictEqual(out.npm_config_email, 'sam@example.com');
  assert.strictEqual(out.no_proxy, 'http://proxy:8080');
  assert.strictEqual(out.HTTP_PROXY, 'http://192.0.2.1:8080');
  assert.strictEqual(buildChildEnv(base, { keep: ['http_proxy'] }).http_proxy, 'user:pass@127.0.0.1:8080', 'an exact grant bypasses the check');
  const win = buildChildEnv({ USERPROFILE: 'C:\\Users\\sam@corp', APPDATA: 'C:/Users/sam@corp/AppData' }, { platform: 'win32' });
  assert.strictEqual(win.USERPROFILE, 'C:\\Users\\sam@corp', 'a Windows path with @ is not a credential');
  assert.strictEqual(win.APPDATA, 'C:/Users/sam@corp/AppData');
});

test('envKeep grants reach store-held secrets (exact names only); client exclusions hold', () => {
  const store = { GITHUB_TOKEN: 'ghp-test-1', OPENAI_API_KEY: 'sk-test-123', CLAUDE_CODE_OAUTH_TOKEN: 'oat-test', OTHER_SECRET: 'sk-test-123', ANTHROPIC_API_KEY: 'sk-test-123' };
  const secrets = (n) => store[n];
  const base = { PATH: '/bin' };
  const a = { name: 'sam', envKeep: ['GITHUB_TOKEN'] };
  const r = envForAgent(a, { base, secrets });
  assert.strictEqual(r.GITHUB_TOKEN, 'ghp-test-1');
  assert.strictEqual(r.OTHER_SECRET, undefined, 'a non-granted store secret never appears');
  assert.strictEqual(r.OPENAI_API_KEY, undefined);
  const cx = envForAgent({ name: 'sam', envKeep: ['OPENAI_API_KEY'] }, { base, secrets, client: 'codex' });
  assert.strictEqual(cx.OPENAI_API_KEY, undefined, 'codex never gets its provider key from the store');
  const cl = envForAgent({ name: 'sam', envKeep: ['ANTHROPIC_API_KEY'] }, { base, secrets, client: 'claude' });
  assert.strictEqual(cl.ANTHROPIC_API_KEY, undefined);
  assert.strictEqual(cl.CLAUDE_CODE_OAUTH_TOKEN, 'oat-test', 'claude gets its sign-in token from the store');
  assert.strictEqual(cl.OTHER_SECRET, undefined);
  assert.strictEqual(envForAgent(a, { base: { GITHUB_TOKEN: 'ghp-test-2' }, secrets }).GITHUB_TOKEN, 'ghp-test-1', 'the .env value in the store wins over a launch-time one, as for the hub itself');
  assert.strictEqual(envForAgent(a, { base: { GITHUB_TOKEN: 'ghp-test-2' }, secrets: () => undefined }).GITHUB_TOKEN, 'ghp-test-2', 'a launch-time value passes when the store has none');
  for (const n of ['HUB_AUTH_PASSWORD', 'HUB_WALLET_OWNER', 'HUB_SETUP_TOKEN', 'MYMAESTRO_HUB_SECRET', 'CLAUDE_CODE_OAUTH_TOKEN', 'hub_auth_username']) {
    const r2 = ce.cleanEnvKeep([n]);
    assert.strictEqual(r2.ok, false, n);
    assert.match(r2.error, /belongs to the hub itself/);
  }
  assert.deepStrictEqual(ce.cleanEnvKeep(['GITHUB_TOKEN']).value, ['GITHUB_TOKEN'], 'an ordinary secret name stays grantable');
  assert.deepStrictEqual(envForAgent({ name: 'sam', envKeep: ['HUB_AUTH_PASSWORD'] }, { base: {}, secrets: () => 'pw-test-1' }).HUB_AUTH_PASSWORD, undefined, 'a stored reserved grant gives nothing');
  assert.deepStrictEqual(envForAgent({ name: 'maestro', lead: true }, { base, secrets }), base, 'the lead path is unchanged');
  assert.ok(ce.CLIENT_EXCLUDE.codex.includes('OPENAI_BASE_URL') && ce.CLIENT_EXCLUDE.claude.includes('ANTHROPIC_AUTH_TOKEN'));
});
