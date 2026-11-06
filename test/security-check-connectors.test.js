'use strict';
// Security check: sensitive data connectors. Lead-only is the safe default; listing any other agent is a warning.
const { test } = require('node:test');
const assert = require('node:assert');
const sc = require('../lib/security-check');

const byId = (r, id) => r.items.find(i => i.id === id);
const BASE = {
  platform: 'linux', installDir: '/h/hub', dataDir: '/h/hub/data', hubHome: '/h', homeDir: '/home/x', env: {}, port: 8888, host: '127.0.0.1', exposed: () => false,
  hasUsers: () => true, listUsers: () => [{ id: 'u0', login: 'owner', role: 'admin', totpEnabled: true }], listTokens: () => [],
  agents: async () => [{ name: 'owner', lead: true, model: 'claude-sdk/claude-x' }, { name: 'sam', model: 'claude-sdk/claude-x' }],
  isMemberOwned: () => false, getSetting: () => undefined, rootGrants: () => [], stat: () => null, readdir: () => [],
  listeners: async () => [], tailscale: async () => [], sshdConfig: async () => '', sudoStatus: async () => ({ nopasswd: false }),
  dockerGroup: async () => ({ inGroup: false, rootless: false }), sandboxStatus: async () => ({ docker: true, imageReady: true, containers: [] }),
  git: async () => ({ branch: 'main', dirty: [], tracked: [], historySecrets: [], fetchAgeDays: 1 }),
  now: () => new Date('2026-10-17T13:00:00Z'), log: () => {},
};
const check = (list) => sc.createSecurityCheck({ ...BASE, connectors: () => ({ connectors: list }) }).check();
const conn = (o) => ({ id: 'records', sensitive: true, protect: 'own', agents: [], ...o });

test('sensitive connector used by the lead only (agents empty) is fine', async () => {
  const r = await check([conn({})]);
  assert.strictEqual(byId(r, 'connectors').level, 'ok');
});

test('sensitive connector that lists another agent is a warning that names it', async () => {
  const it = byId(await check([conn({ agents: ['sam'] })]), 'connectors');
  assert.strictEqual(it.level, 'warn');
  assert.match(it.detail, /shared beyond the lead agent: records/);
});

test('an old stored null is no longer a warning by itself; protect none still is', async () => {
  assert.strictEqual(byId(await check([conn({ agents: null })]), 'connectors').level, 'ok');
  const it = byId(await check([conn({ protect: 'none' })]), 'connectors');
  assert.strictEqual(it.level, 'warn');
  assert.match(it.detail, /no passphrase: records/);
});

test('a connector that is not sensitive can list agents without a warning', async () => {
  assert.strictEqual(byId(await check([conn({ sensitive: false, agents: ['sam'] })]), 'connectors').level, 'ok');
});
