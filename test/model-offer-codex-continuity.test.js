'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

test('Codex group approvals bind the turn binary, credential generation and effective workspace route', async t => {
  const inst = makeIsolatedInstall();
  const mod = name => require(path.join(inst.lib, name));
  const stub = (name, exports) => { require.cache[require.resolve(path.join(inst.lib, name))] = { exports }; };
  const cwd = process.cwd(), original = process.env;
  const bin = path.join(inst.home, 'custom-client');
  const home = path.join(inst.home, '.codex');
  const workspace = path.join(inst.inst, 'workspaces', 'alpha');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(bin, '', { mode: 0o700 });
  process.chdir(inst.inst);
  process.env = { HOME: inst.home, PATH: '', CODEX_CLI_PATH: bin, CODEX_HOME: home,
    OPENAI_API_KEY: 'fixture', CHATGPT_BASE_URL: 'https://fixture.invalid' };
  t.after(() => { process.chdir(cwd); process.env = original; });
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (file, opts) => {
    if (opts?.bigint && !String(file).startsWith(inst.root + path.sep)) return undefined;
    return stat(file, opts);
  });
  t.mock.method(global, 'fetch', () => assert.fail('unexpected network request'));
  stub('hub-secrets', { has: () => false });
  const auth = path.join(home, 'auth.json');
  fs.writeFileSync(auth, 'fixture A');
  const agent = { name: 'alpha', model: 'codex-cli/gpt-5-astra' };
  const target = 'codex-cli/gpt-6-astra';
  const configFile = path.join(home, 'config.toml');
  const projectFile = path.join(workspace, '.codex', 'config.toml');
  stub('codex-cli/app-server', { AppServerClient: class {
    constructor(ctx) {
      assert.equal(ctx.bin, bin);
      assert.equal(ctx.env.OPENAI_API_KEY, undefined);
      assert.equal(ctx.env.CODEX_CLI_PATH, undefined);
      this.cwd = ctx.cwd || process.cwd();
    }
    async initialize() {}
    close() {}
    async request(method, params) {
      if (method === 'account/read') {
        assert.equal(params.refreshToken, false);
        return { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'team' } };
      }
      assert.equal(method, 'config/read');
      assert.equal(params.cwd, this.cwd);
      const config = { model_reasoning_effort: 'high', model_provider: 'openai' };
      if (fs.existsSync(configFile)) config.chatgpt_base_url = fs.readFileSync(configFile, 'utf8');
      if (this.cwd === workspace && fs.existsSync(projectFile)) config.model_provider = 'custom';
      return { config, layers: [{ name: { type: 'user', file: configFile } }] };
    }
  } });
  const accounts = mod('model-offer-accounts');
  const provider = 'codex-cli';
  assert.equal(accounts.context(provider).bin, bin);
  const first = await accounts.account(provider);
  assert.match(first, /^[0-9a-f]{64}$/);
  fs.writeFileSync(auth, 'fixture generation B');
  const second = await accounts.account(provider);
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  const cache = { [provider]: [target.split('/')[1]], offerSources: {
    [provider]: { id: second, at: new Date().toISOString() },
  } };
  stub('model-discovery', { loadCache: () => cache, getDiscoveredModels: () => [target] });
  stub('gateway-client', { cachedModels: () => null });
  stub('agents', { getAgentWorkspace: async () => workspace, isChatModel: () => true,
    ownerLeadNames: () => [], getAgentsSync: () => [agent] });
  stub('model-offers-service', { createModelOffers: () => ({ list: async () => [{
    name: agent.name, from: agent.model, to: target, route: mod('billing').billingOf(target).route, kind: 'newer',
  }] }) });
  let writeGuardCalls = 0;
  const groups = mod('model-offer-groups').createModelOfferGroups({
    records: () => [agent], stamp: () => 'fixture', enabled: () => true,
    ownerAllowed: () => true, setModel: (name, model, guard) => {
      writeGuardCalls++;
      fs.writeFileSync(projectFile, 'model_provider = "custom"');
      return { success: false, status: guard(agent, 'fixture') };
    },
  });
  const [offer] = await groups.list();
  assert.ok(offer);
  const changed = async () => assert.deepEqual((await groups.answer(offer.id, 'apply', {
    stillAllowed: () => true, isBusy: () => false,
  })).results, [{ name: agent.name, status: 'changed' }]);
  fs.writeFileSync(configFile, 'https://other.invalid');
  assert.equal(await accounts.account(provider), null);
  await changed();
  fs.unlinkSync(configFile);
  assert.equal((await groups.list())[0].id, offer.id);
  fs.mkdirSync(path.dirname(projectFile));
  fs.writeFileSync(projectFile, 'model_provider = "custom"');
  assert.deepEqual(await groups.list(), []);
  await changed();
  fs.unlinkSync(projectFile);
  assert.equal(writeGuardCalls, 0);
  await changed();
  assert.equal(writeGuardCalls, 1);
  fs.unlinkSync(projectFile);
  agent.envKeep = ['CHATGPT_BASE_URL'];
  assert.deepEqual(await groups.list(), []);
  await changed();
});
