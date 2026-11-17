'use strict';
// claudeClientEnv and the Claude client start sites. Fake values only; hub-secrets is a require.cache stand-in.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const B = require('../lib/billing');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('claudeClientEnv: no API key, plus the .env-held sign-in token from the store (which wins over a launch-time one)', () => {
  const hsPath = require.resolve('../lib/hub-secrets');
  const saved = require.cache[hsPath];
  const store = { CLAUDE_CODE_OAUTH_TOKEN: 'oat-test', OTHER_TOKEN: 'ghp-test-1' };
  require.cache[hsPath] = { id: hsPath, filename: hsPath, loaded: true, exports: { has: (n) => n in store, get: (n) => store[n] } };
  try {
    assert.deepStrictEqual(B.claudeClientEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-test-123' }), { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oat-test' });
    assert.strictEqual(B.claudeClientEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'launch-old' }).CLAUDE_CODE_OAUTH_TOKEN, 'oat-test', 'the .env value wins, as everywhere in the hub');
    delete store.CLAUDE_CODE_OAUTH_TOKEN;
    assert.strictEqual('CLAUDE_CODE_OAUTH_TOKEN' in B.claudeClientEnv({ PATH: '/bin' }), false);
    assert.strictEqual(B.claudeClientEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'launch-old' }).CLAUDE_CODE_OAUTH_TOKEN, 'launch-old', 'a launch-time token passes when .env has none');
  } finally { if (saved) require.cache[hsPath] = saved; else delete require.cache[hsPath]; }
});

test('every Claude client start passes env from claudeClientEnv; the chat client always gets the allow-listed environment', () => {
  for (const f of ['lib/dream.js', 'lib/model-discovery.js', 'lib/plan-usage.js']) {
    const src = read(f);
    const n = (src.match(/sdk(?:Module)?\.query\(/g) || []).length;
    assert.ok(n > 0, f);
    assert.strictEqual((src.match(/env: require\('\.\/billing'\)\.claudeClientEnv\(\)/g) || []).length, n, `${f}: ${n} query sites`);
    // The env sits inside the options handed to the client isolation merge, which keeps it and adds its own switches.
    assert.strictEqual((src.match(/clientIsolation\.mergeInto\(\{[^]*?env: require\('\.\/billing'\)\.claudeClientEnv\(\)[^]*?\}, /g) || []).length, n, `${f}: env inside mergeInto`);
  }
  assert.match(read('lib/welcome.js'), /require\('\.\/billing'\)\.claudeClientEnv\)\(childEnv\)/);
  // Security R2: the Claude client never runs in a box, so there is no in-box branch with its own environment; every
  // agent's client (boxed agents' included) starts from the allow-listed one, and the isolation merge is applied on top.
  const chat = read('lib/sdk-chat.js');
  assert.ok(!chat.includes('? { PATH: process.env.PATH, HOME: process.env.HOME,'), 'no in-box client environment');
  assert.match(chat, /\n {6}env: childEnv\.envForAgent\(hands\.agent, \{ base: require\('\.\/billing'\)\.clientEnvWithoutApiKey\(process\.env\), client: 'claude', isLead: leadFor\(agentName\)/);
  assert.match(chat, /clientIsolation\.mergeInto\(queryOptions, isolation\)/);
});

test('the client isolation merge keeps the allow-listed client environment, adds its switch, and lets no secret name through', () => {
  const ce = require('../lib/child-env');
  const ci = require('../lib/client-isolation');
  const launch = { PATH: '/usr/bin', HOME: '/home/sam', LANG: 'C.UTF-8', CLAUDE_CONFIG_DIR: '/home/sam/.claude-alt',
    ANTHROPIC_API_KEY: 'sk-ant-fake-1', OPENAI_API_KEY: 'sk-fake-1', GITHUB_TOKEN: 'ghp-fake-1', SSH_AUTH_SOCK: '/tmp/fake-agent.sock' };
  const store = { CLAUDE_CODE_OAUTH_TOKEN: 'oat-fake-1' };
  const secrets = (n) => store[n];
  const clientEnv = (agent, lead) => ce.envForAgent(agent, { base: B.clientEnvWithoutApiKey(launch), client: 'claude', isLead: () => lead, secrets, set: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' } });
  const cases = [
    ['host agent', clientEnv({ name: 'sam' }, false), ci.isolationFor({})],
    ['boxed agent', clientEnv({ name: 'sam' }, false), ci.isolationFor({ boxed: true })],
    ['member-reachable agent', clientEnv({ name: 'sam' }, false), ci.isolationFor({ memberReachable: true })],
  ];
  for (const [label, env, iso] of cases) {
    const o = ci.mergeInto({ model: 'x', env }, iso);
    for (const n of ['PATH', 'HOME', 'LANG', 'CLAUDE_CONFIG_DIR']) assert.strictEqual(o.env[n], launch[n], `${label}: ${n}`);
    assert.strictEqual(o.env.CLAUDE_CODE_OAUTH_TOKEN, 'oat-fake-1', `${label}: the sign-in token from the store`);
    assert.strictEqual(o.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false', `${label}: connectors off`);
    assert.strictEqual(o.strictMcpConfig, true, label);
    for (const n of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) assert.ok(!(n in o.env), `${label}: ${n}`);
  }
  assert.deepStrictEqual(ci.mergeInto({ env: clientEnv({ name: 'sam' }, false) }, ci.isolationFor({ boxed: true })).settingSources, []);
  // The lead keeps its environment (the owner's design) minus the API key, with the same switch on top.
  const lead = ci.mergeInto({ env: clientEnv({ name: 'lead' }, true) }, ci.isolationFor({}));
  assert.strictEqual(lead.env.OPENAI_API_KEY, 'sk-fake-1');
  assert.ok(!('ANTHROPIC_API_KEY' in lead.env));
  assert.strictEqual(lead.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.deepStrictEqual(lead.settingSources, ['user']);
});
