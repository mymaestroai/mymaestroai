'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConnectorAccess, runTool, OWNER_ONLY } = require('../lib/connector-access');

function rig({ pushThrows = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-access-'));
  const rows = [
    { id: 'notes', label: 'Notes', module: null, tools: { search: { cls: 'read' }, add: { cls: 'write' } }, sensitive: false, agents: ['helper'] },
    { id: 'mail', label: 'Mail', module: 'mailmod', tools: { read: { cls: 'read' } }, sensitive: false, agents: null },
    { id: 'bank', label: 'Bank', module: null, tools: { pay: { cls: 'money' } }, sensitive: false, agents: [] },
    { id: 'chart', label: 'Chart', module: null, tools: { read: { cls: 'read' } }, sensitive: true, agents: [] },
  ];
  const calls = { grants: [], setAgents: [], push: [] };
  const connectors = {
    list: () => ({ connectors: rows.map(r => ({ ...r })), groups: [] }),
    setGrants: (id, names) => { calls.grants.push([id, names]); rows.find(r => r.id === id).agents = names; },
  };
  const modules = { setAgents: (id, names, o) => { calls.setAgents.push([id, names, o]); rows.find(r => r.module === id).agents = names; } };
  const agents = [{ name: 'owner' }, { name: 'sam', owner: 'member1' }, { name: 'helper' }, { name: 'scout' }, { name: 'temp1' }];
  const push = { notify: (p, o) => { calls.push.push([p, o]); if (pushThrows) throw new Error('push down'); return Promise.resolve(); } };
  const auditFile = path.join(dir, 'sub', 'connector-access.jsonl');
  const access = createConnectorAccess({
    connectors, modules, agents, leadNames: ['owner'], push, auditFile, now: () => Date.UTC(2026, 10, 6, 12),
    isMemberOwned: (a) => a.owner === 'member1', isVirtual: (n) => n === 'temp1',
  });
  return { access, calls, rows, auditFile };
}

test('list shape', () => {
  const { access } = rig();
  const l = access.list();
  assert.deepEqual(l[0], { id: 'notes', name: 'Notes', module: null, classes: ['read', 'write'], money: false, sensitive: false, agents: ['helper'] });
  assert.equal(l[1].module, 'mailmod'); assert.deepEqual(l[1].agents, []);
  assert.equal(l[2].money, true); assert.equal(l[3].sensitive, true);
});

test('grant and revoke a hand-made connector', () => {
  const { access, calls } = rig();
  assert.deepEqual(access.grant({ connector: 'notes', agent: 'scout', by: 'owner' }), { ok: true, agents: ['helper', 'scout'] });
  assert.deepEqual(calls.grants, [['notes', ['helper', 'scout']]]);
  assert.deepEqual(access.revoke({ connector: 'notes', agent: 'helper', by: 'owner' }), { ok: true, agents: ['scout'] });
  assert.equal(calls.setAgents.length, 0);
});

test('grant and revoke a module connector go through modules.setAgents', () => {
  const { access, calls } = rig();
  assert.deepEqual(access.grant({ connector: 'mail', agent: 'helper', by: 'owner' }), { ok: true, agents: ['helper'] });
  assert.deepEqual(calls.setAgents[0], ['mailmod', ['helper'], { by: 'owner' }]);
  assert.deepEqual(access.revoke({ connector: 'mail', agent: 'helper', by: 'owner' }), { ok: true, agents: [] });
  assert.equal(calls.grants.length, 0);
});

test('refusals change nothing', () => {
  const { access, calls, auditFile } = rig();
  const bad = (o, re) => assert.throws(() => access.grant({ by: 'owner', ...o }), re);
  bad({ connector: 'notes', agent: 'ghost' }, /No agent named "ghost"/);
  bad({ connector: 'notes', agent: 'sam' }, /belongs to a member/);
  bad({ connector: 'notes', agent: 'temp1' }, /temporary worker/);
  bad({ connector: 'notes', agent: 'owner' }, /lead agent/);
  bad({ connector: 'nope', agent: 'helper' }, /No data connector/);
  assert.throws(() => access.grant({ connector: 'bank', agent: 'helper', by: 'owner' }), new RegExp(OWNER_ONLY('Bank').replace(/[.,]/g, '\\$&')));
  assert.throws(() => access.revoke({ connector: 'chart', agent: 'helper', by: 'owner' }), /Only the owner can change access to Chart, in Settings, Data connectors\./);
  assert.equal(calls.grants.length + calls.setAgents.length + calls.push.length, 0);
  assert.equal(fs.existsSync(auditFile), false);
});

test('audit line (mode 0600) and one admin notice per change', () => {
  const { access, calls, auditFile } = rig();
  access.grant({ connector: 'notes', agent: 'scout', by: 'owner' });
  access.revoke({ connector: 'notes', agent: 'scout', by: 'owner' });
  const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { at: '2026-11-06T12:00:00.000Z', by: 'owner', action: 'grant', connector: 'notes', agent: 'scout', agentsAfter: ['helper', 'scout'] });
  assert.deepEqual(lines[1].agentsAfter, ['helper']);
  assert.equal(fs.statSync(auditFile).mode & 0o777, 0o600);
  assert.equal(calls.push.length, 2);
  assert.deepEqual(calls.push[0], [{ title: 'Data connector access changed', body: 'owner gave scout access to Notes', url: '/?connectors=1' }, { adminsOnly: true }]);
  assert.equal(calls.push[1][0].body, "owner removed scout's access to Notes");
});

test('a failing notice does not undo the change; a no-op logs nothing', () => {
  const { access, rows, calls, auditFile } = rig({ pushThrows: true });
  assert.deepEqual(access.grant({ connector: 'notes', agent: 'scout', by: 'owner' }).agents, ['helper', 'scout']);
  assert.deepEqual(rows[0].agents, ['helper', 'scout']);
  assert.equal(fs.readFileSync(auditFile, 'utf8').trim().split('\n').length, 1);
  const n = calls.push.length;
  assert.deepEqual(access.grant({ connector: 'notes', agent: 'scout', by: 'owner' }).agents, ['helper', 'scout']);
  assert.equal(calls.push.length, n);
});

test('runTool returns plain text, including refusals', () => {
  const { access } = rig();
  assert.match(runTool(access, { action: 'list' }), /notes \(Notes\): agents: helper/);
  assert.match(runTool(access, { action: 'list' }), /bank \(Bank\): owner only/);
  assert.match(runTool(access, { action: 'grant', connector: 'notes', agent: 'scout' }, 'owner'), /^Done\./);
  assert.match(runTool(access, { action: 'grant', connector: 'bank', agent: 'scout' }, 'owner'), /Only the owner can change access to Bank/);
  assert.match(runTool(access, { action: 'zap' }), /list, grant or revoke/);
});

test('sdk-chat wiring: virtual is passed and connector_access is gated', () => {
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.equal((sdk.match(/toolSpecsFor\(agentName, \{ consultationDepth, virtual: temporalWorkers\.isVirtual\(agentName\) \}\)/g) || []).length, 2, 'both tool paths');
  assert.match(sdk, /contextTextFor\(agentName, \{ virtual: temporalWorkers\.isVirtual\(agentName\) \}\)/);
  assert.match(sdk, /function connectorAccessOffered\(agentName, consultationDepth\) \{[\s\S]{0,200}consultationDepth !== 0 \|\| temporalWorkers\.isVirtual\(agentName\) \|\| !ownerTurnAgents\.has\(agentName\)[\s\S]{0,200}a\.lead === true/);
  assert.equal((sdk.match(/\.\.\.\(connectorAccessOffered\(agentName, consultationDepth\)/g) || []).length, 2, 'gateway list and SDK mcpTools');
  assert.equal((sdk.match(/connectorAccessLib\.runTool\(connectorAccessLib\.getConnectorAccess\(\), args, agentName\)/g) || []).length, 2);
  assert.equal((sdk.match(/\+ connectorsTextFor\(agentName\)/g) || []).length, 3);
});

test('owner turns: only a signed-in admin\'s own message marks a turn, and the mark ends with the turn', () => {
  const fs2 = require('fs'); const p = require('path');
  const server = fs2.readFileSync(p.join(__dirname, '..', 'server.js'), 'utf8');
  const sdk = fs2.readFileSync(p.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(server, /const HUB_ONLY_CHAT_FIELDS = \[[^\]]*'owner_turn'/, 'programs cannot send owner_turn themselves');
  assert.match(server, /body\.owner_turn = req\.hubIdentKind === 'user' && !req\.hubPendingTotp && !req\.hubToken && !req\.hubService && access\.isAdmin\(req\.hubUser\)/);
  assert.match(sdk, /const ownerTurn = owner_turn === true && !ephemeral && !tiger_team && !consulted_by && !\(origin && typeof origin === 'object' && origin\.kind\)/);
  assert.match(sdk, /if \(ownerTurn\) ownerTurnAgents\.add\(agent\);/);
  assert.match(sdk, /finally \{[\s\S]{0,400}if \(ownerTurn\) ownerTurnAgents\.delete\(agent\);/);
});
