'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

test('discovery binds parsed chat models to the effective source and rejects changes during fetch', async t => {
  const inst = makeIsolatedInstall();
  const local = name => require.resolve(path.join(inst.lib, name));
  const stub = (name, exports) => { require.cache[local(name)] = { exports, loaded: true }; };
  let key = 'synthetic-key-a';
  const endpoint = 'http://fixture.invalid/v1';
  stub('settings', {
    getProviderKey: p => p === 'openai' ? key : null,
    getProviderUrl: p => p === 'local' ? endpoint : p === 'openai' ? 'https://api.openai.com/v1' : null,
    PROVIDER_DEFAULTS: { openai: { url: 'https://api.openai.com/v1' } },
  });
  stub('claude-auth', { hasSdkCredentials: () => false });
  stub('codex-cli/update-lock', { active: () => true });
  stub('gateway-client', { invalidateModelsCache() {}, cachedModels: () => null });
  const discovery = require(local('model-discovery'));
  const accounts = require(local('model-offer-accounts'));
  let rotate = false;
  t.mock.method(global, 'fetch', async (url, opts) => {
    if (url === endpoint + '/models') return { ok: true, json: async () => ({ data: [{ id: 'local-model' }] }) };
    if (url !== 'https://api.openai.com/v1/models') return { ok: false };
    assert.equal(opts.headers.Authorization, 'Bearer ' + key);
    if (rotate) key = 'synthetic-key-b';
    return { ok: true, json: async () => ({ data: ['gpt-6-astra', 'gpt-10.2-mini', 'gpt-6-audio'].map(id => ({ id })) }) };
  });
  const first = await discovery.runDiscovery();
  assert.deepEqual(first.openai, ['gpt-6-astra', 'gpt-10.2-mini']);
  assert.equal(first.offerSources.openai.id, accounts.source('openai'));
  assert.equal(first.offerSources.local.id, accounts.source('local'));
  assert.ok(Number.isFinite(Date.parse(first.offerSources.openai.at)));
  assert.deepEqual(discovery.loadCache().offerSources, first.offerSources);
  assert.doesNotMatch(JSON.stringify(first.offerSources), /synthetic-key|fixture\.invalid/);
  const registry = require(local('agents'));
  const fs = require('node:fs');
  const names = ['alpha', 'beta'];
  fs.writeFileSync(path.join(inst.data, 'agents.json'), JSON.stringify(names.map(name => ({
    name, box: name + '-box', model: 'openai/gpt-5-astra',
  }))));
  const groups = require(local('model-offer-groups')).createModelOfferGroups({
    enabled: () => true, ownerAllowed: () => true,
  });
  const [offer] = await groups.list();
  assert.deepEqual(offer?.rows.map(row => row.name), names);
  const result = await groups.answer(offer.id, 'apply', { stillAllowed: () => true, isBusy: name => name === 'beta' });
  assert.deepEqual(result.results.map(row => row.status), ['switched', 'busy']);
  assert.deepEqual(registry.readAgentsFileStrict().map(a => a.model), ['openai/gpt-6-astra', 'openai/gpt-5-astra']);
  rotate = true;
  const next = await discovery.runDiscovery();
  assert.equal(next.offerSources.openai, undefined);
  assert.notEqual(first.offerSources.openai.id, accounts.source('openai'));
  assert.equal(next.offerSources.local.id, first.offerSources.local.id);
});

test('subscription discovery pins each client and drops ambiguous or changed provenance', async t => {
  const inst = makeIsolatedInstall();
  const local = name => require.resolve(path.join(inst.lib, name));
  const stub = (name, exports) => { require.cache[local(name)] = { exports, loaded: true }; };
  const env = { HOME: inst.home, CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-token' };
  const ctx = { env, bin: '/synthetic/client' };
  let codexId = 'plan-a', changePlan = false, listed = true, locked = false;
  stub('settings', { getProviderKey: () => null, getProviderUrl: () => null });
  stub('gateway-client', { invalidateModelsCache() {} });
  stub('claude-auth', { hasSdkCredentials: () => true, getOauthToken: e => e.CLAUDE_CODE_OAUTH_TOKEN });
  stub('client-isolation', { mergeInto: o => o, isolationFor: () => ({}) });
  stub('billing', { claudeClientEnv: () => env });
  stub('sdk-loader', { cliOptions: () => ({}), loadSdk: async () => ({
    query: ({ options }) => {
      assert.equal(options.env, env);
      if (!listed) return { supportedModels: async () => [] };
      assert.equal(options.pathToClaudeCodeExecutable, ctx.bin);
      return { supportedModels: async () => [{ value: 'sonnet' }] };
    },
  }) });
  stub('model-offer-accounts', {
    context: () => ctx, stamp: () => 'stable', source: () => null,
    account: async (provider, client) => {
      assert.equal(client, ctx);
      return provider === 'claude-sdk' ? 'claude-plan' : codexId;
    },
  });
  stub('codex-cli/update-lock', { active: () => locked });
  stub('codex-cli', { discoverModels: async client => {
    assert.equal(client, ctx);
    if (changePlan) codexId = 'plan-b';
    return [{ id: 'gpt-6-astra' }];
  } });
  t.mock.method(global, 'fetch', async (url, opts) => {
    if (String(url).startsWith('https://api.anthropic.com/v1/models')) {
      assert.equal(opts.headers.Authorization, 'Bearer synthetic-token');
      return { ok: listed, json: async () => ({ data: [{ id: 'claude-opus-6' }] }) };
    }
    return { ok: false };
  });
  const discovery = require(local('model-discovery'));
  const first = await discovery.runDiscovery();
  assert.equal(first.offerSources['claude-sdk'].id, 'claude-plan');
  assert.equal(first.offerSources['codex-cli'].id, 'plan-a');
  locked = true;
  listed = false;
  const reused = await discovery.runDiscovery();
  assert.deepEqual(reused.offerSources['codex-cli'], first.offerSources['codex-cli']);
  assert.equal(reused.offerSources['claude-sdk'], undefined);
  locked = false;
  changePlan = true;
  assert.equal((await discovery.runDiscovery()).offerSources['codex-cli'], undefined);
});
