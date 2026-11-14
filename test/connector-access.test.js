'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// lib/ comes from a throwaway install, so nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('connector-access-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const { createConnectorAccess, runTool, OWNER_ONLY } = L('connector-access');

const YES = async () => true;

function rig({ pushThrows = false, auditPath } = {}) {
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
  const auditFile = auditPath || path.join(dir, 'sub', 'connector-access.jsonl');
  const access = createConnectorAccess({
    connectors, modules, agents, leadNames: ['owner'], push, auditFile, now: () => Date.UTC(2026, 10, 6, 12),
    isMemberOwned: (a) => a.owner === 'member1', isVirtual: (n) => n === 'temp1',
  });
  return { access, calls, rows, auditFile, dir, connectors };
}

test('list shape', () => {
  const { access } = rig();
  const l = access.list();
  assert.deepEqual(l[0], { id: 'notes', name: 'Notes', module: null, classes: ['read', 'write'], money: false, sensitive: false, agents: ['helper'] });
  assert.equal(l[1].module, 'mailmod'); assert.deepEqual(l[1].agents, []);
  assert.equal(l[2].money, true); assert.equal(l[3].sensitive, true);
});

test('grant and revoke a hand-made connector', async () => {
  const { access, calls } = rig();
  assert.deepEqual(await access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: YES }), { ok: true, agents: ['helper', 'scout'] });
  assert.deepEqual(calls.grants, [['notes', ['helper', 'scout']]]);
  assert.deepEqual(await access.revoke({ connector: 'notes', agent: 'helper', by: 'owner', confirm: YES }), { ok: true, agents: ['scout'] });
  assert.equal(calls.setAgents.length, 0);
});

test('grant and revoke a module connector go through modules.setAgents', async () => {
  const { access, calls } = rig();
  assert.deepEqual(await access.grant({ connector: 'mail', agent: 'helper', by: 'owner', confirm: YES }), { ok: true, agents: ['helper'] });
  assert.deepEqual(calls.setAgents[0], ['mailmod', ['helper'], { by: 'owner' }]);
  assert.deepEqual(await access.revoke({ connector: 'mail', agent: 'helper', by: 'owner', confirm: YES }), { ok: true, agents: [] });
  assert.equal(calls.grants.length, 0);
});

test('refusals change nothing', async () => {
  const { access, calls, auditFile } = rig();
  const bad = (o, re) => assert.rejects(() => access.grant({ by: 'owner', confirm: YES, ...o }), re);
  await bad({ connector: 'notes', agent: 'ghost' }, /No agent named "ghost"/);
  await bad({ connector: 'notes', agent: 'sam' }, /belongs to a member/);
  await bad({ connector: 'notes', agent: 'temp1' }, /temporary worker/);
  await bad({ connector: 'notes', agent: 'owner' }, /lead agent/);
  await bad({ connector: 'nope', agent: 'helper' }, /No data connector/);
  await assert.rejects(() => access.grant({ connector: 'bank', agent: 'helper', by: 'owner', confirm: YES }), new RegExp(OWNER_ONLY('Bank').replace(/[.,]/g, '\\$&')));
  await assert.rejects(() => access.revoke({ connector: 'chart', agent: 'helper', by: 'owner', confirm: YES }), /Only the owner can change access to Chart, in Settings, Data connectors\./);
  assert.equal(calls.grants.length + calls.setAgents.length + calls.push.length, 0);
  assert.equal(fs.existsSync(auditFile), false);
});

test('audit lines (mode 0600) and one admin notice per change', async () => {
  const { access, calls, auditFile } = rig();
  await access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: YES });
  await access.revoke({ connector: 'notes', agent: 'scout', by: 'owner', confirm: YES });
  const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 4, 'requested + done for each change');
  assert.deepEqual(lines[0], { at: '2026-11-06T12:00:00.000Z', by: 'owner', action: 'grant', connector: 'notes', agent: 'scout', agentsBefore: ['helper'], agentsAfter: ['helper', 'scout'], state: 'requested' });
  assert.deepEqual(lines[1], { ...lines[0], state: 'done' });
  assert.deepEqual(lines[3].agentsAfter, ['helper']);
  assert.equal(lines[3].state, 'done');
  assert.equal(fs.statSync(auditFile).mode & 0o777, 0o600);
  assert.equal(calls.push.length, 2);
  assert.deepEqual(calls.push[0], [{ title: 'Data connector access changed', body: 'owner gave scout access to Notes', url: '/?connectors=1' }, { adminsOnly: true }]);
  assert.equal(calls.push[1][0].body, "owner removed scout's access to Notes");
});

test('a failing notice does not undo the change; a no-op logs nothing', async () => {
  const { access, rows, calls, auditFile } = rig({ pushThrows: true });
  assert.deepEqual((await access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: YES })).agents, ['helper', 'scout']);
  assert.deepEqual(rows[0].agents, ['helper', 'scout']);
  assert.equal(fs.readFileSync(auditFile, 'utf8').trim().split('\n').length, 2, 'requested + done');
  const n = calls.push.length;
  assert.deepEqual((await access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: YES })).agents, ['helper', 'scout']);
  assert.equal(calls.push.length, n);
});

test('runTool returns plain text, including refusals', async () => {
  const { access } = rig();
  assert.match(await runTool(access, { action: 'list' }), /notes \(Notes\): agents: helper/);
  assert.match(await runTool(access, { action: 'list' }), /bank \(Bank\): owner only/);
  assert.match(await runTool(access, { action: 'grant', connector: 'notes', agent: 'scout' }, 'owner', YES), /^Done\./);
  assert.match(await runTool(access, { action: 'grant', connector: 'bank', agent: 'scout' }, 'owner', YES), /Only the owner can change access to Bank/);
  assert.match(await runTool(access, { action: 'zap' }), /list, grant or revoke/);
});

test('sdk-chat wiring: virtual is passed and connector_access is gated', () => {
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.equal((sdk.match(/toolSpecsFor\(agentName, \{ consultationDepth, virtual: temporalWorkers\.isVirtual\(agentName\) \}\)/g) || []).length, 2, 'both tool paths');
  assert.match(sdk, /function connectorsTextFor\(agentName, consultationDepth = 0\)[^\n]*contextTextFor\(agentName, \{ consultationDepth, virtual: temporalWorkers\.isVirtual\(agentName\) \}\)/);
  assert.match(sdk, /function connectorAccessOffered\(agentName, consultationDepth\) \{[\s\S]{0,200}consultationDepth !== 0 \|\| temporalWorkers\.isVirtual\(agentName\) \|\| !ownerTurnAgents\.has\(agentName\)[\s\S]{0,200}ownerLeadNames\(\)/);
  assert.equal((sdk.match(/\.\.\.\(connectorAccessOffered\(agentName, consultationDepth\)/g) || []).length, 2, 'gateway list and SDK mcpTools');
  assert.equal((sdk.match(/=> (text\(await )?runConnectorAccess\(agentName, sseRes, args, consultationDepth, (signal|abortSignal)\)/g) || []).length, 2, 'both tool paths use the shared handler');
  assert.equal((sdk.match(/\+ connectorsTextFor\(agentName, (consultationDepth|options\.consultationDepth \|\| 0)\)/g) || []).length, 3, 'all three callers pass a depth');
  assert.equal((sdk.match(/connectorsTextFor\(agentName\)/g) || []).length, 0);
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

test('grant without confirm is refused; confirm false refuses; confirm true proceeds', async () => {
  const { access, calls } = rig();
  await assert.rejects(() => access.grant({ connector: 'notes', agent: 'scout', by: 'owner' }), /didn't confirm/);
  await assert.rejects(() => access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: async () => false }), /didn't confirm/);
  await assert.rejects(() => access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: async () => { throw new Error('x'); } }), /didn't confirm/);
  assert.equal(calls.grants.length, 0);
  let asked = null;
  const r = await access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: async (q) => { asked = q; return true; } });
  assert.deepEqual(r.agents, ['helper', 'scout']);
  assert.equal(asked, 'owner wants to give scout access to Notes. Allow?');
  assert.match(await runTool(access, { action: 'grant', connector: 'notes', agent: 'helper' }, 'owner'), /didn't confirm, so nothing changed/);
});

test('audit: requested before the change, done after', async () => {
  const seen = [];
  // observe the audit file at the moment the change is made
  const rig2 = rig();
  const orig = rig2.connectors.setGrants;
  rig2.connectors.setGrants = (id, names) => { seen.push(fs.readFileSync(rig2.auditFile, 'utf8').trim().split('\n').map(JSON.parse).map(l => l.state)); return orig(id, names); };
  await rig2.access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: YES });
  assert.deepEqual(seen, [['requested']]);
  assert.deepEqual(fs.readFileSync(rig2.auditFile, 'utf8').trim().split('\n').map(JSON.parse).map(l => l.state), ['requested', 'done']);
});

test('audit: an unwritable audit file refuses the change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-access-ro-'));
  const blocker = path.join(dir, 'file'); fs.writeFileSync(blocker, 'x');
  const { access, calls } = rig({ auditPath: path.join(blocker, 'sub', 'a.jsonl') });   // a parent that is a file
  await assert.rejects(() => access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: YES }), /Couldn't record the change, so nothing changed\./);
  assert.equal(calls.grants.length, 0);
});

test('audit: a failing change records failed and rethrows', async () => {
  const r = rig();
  r.connectors.setGrants = () => { throw new Error('disk full'); };
  await assert.rejects(() => r.access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: YES }), /disk full/);
  const lines = fs.readFileSync(r.auditFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l => l.state), ['requested', 'failed']);
  assert.equal(lines[1].error, 'disk full');
});

test('the owner_turn mark is set on the stream route too, with the same expression', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const expr = "body.owner_turn = req.hubIdentKind === 'user' && !req.hubPendingTotp && !req.hubToken && !req.hubService && access.isAdmin(req.hubUser);";
  const i = server.indexOf("pathname === '/api/chat/stream' && req.method === 'POST'");
  const j = server.indexOf("pathname === '/api/chat' && req.method === 'POST'");
  assert.ok(i > 0 && j > i);
  assert.ok(server.slice(i, j).includes(expr), 'stream route');
  assert.ok(server.slice(j, j + 900).includes(expr), 'plain route');
  assert.equal(server.split(expr).length - 1, 2);
});

test('ownerLeadNames: owner-less and admin-owned flagged leads, never a member-owned one, no fallback', () => {
  const agents = L('agents');
  const list = [
    { name: 'a1', lead: true }, { name: 'a2', lead: true, owner: 'adm1' }, { name: 'a3', lead: true, owner: 'mem1' },
    { name: 'a4', category: 'primary' }, { name: 'a5', lead: false },
  ];
  const auth = L('auth'); const real = auth.getAuth;
  auth.getAuth = () => ({ admins: () => [{ id: 'adm1' }] });
  try {
    assert.deepEqual(agents.ownerLeadNames(list), ['a1', 'a2']);
    assert.deepEqual(agents.ownerLeadNames([{ name: 'p', category: 'primary' }, { name: 'q' }]), [], 'no fallback when none is flagged');
  } finally { auth.getAuth = real; }
});

test('the handlers re-check the offer and ask the owner through ask_user', () => {
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const i = sdk.indexOf('async function runConnectorAccess');
  const body = sdk.slice(i, i + 1200);
  assert.match(body, /if \(!connectorAccessOffered\(agentName, consultationDepth\)\) return CONNECTOR_ACCESS_NOT_OFFERED;/);
  assert.match(sdk, /const CONNECTOR_ACCESS_NOT_OFFERED = 'This can only be done in a turn the owner started\.';/);
  assert.match(body, /const confirm = async \(question, yesLabel\) =>/);
  assert.match(body, /runAskUser\(agentName, sseRes, \{ question, options: \[yesLabel, other\], header: 'Data connector access', adminOnly: true \}, \{ consultationDepth, signal \}\)/);
  assert.match(body, /yesLabel === 'Allow' \? "Don't allow" : 'Keep access'/);
  assert.match(body, /answer === yesLabel/);
  assert.match(body, /const stillAllowed = \(\) => connectorAccessOffered\(agentName, consultationDepth\) && !\(signal && signal\.aborted\);/);
  assert.match(body, /runTool\(connectorAccessLib\.getConnectorAccess\(\), args, agentName, confirm, stillAllowed\)/);
});

test('revoke is confirmed too: its own question and yes label; no confirm, a no, or a thrown answer changes nothing', async () => {
  const { access, calls, rows } = rig();
  await assert.rejects(() => access.revoke({ connector: 'notes', agent: 'helper', by: 'owner' }), /didn't confirm/);
  await assert.rejects(() => access.revoke({ connector: 'notes', agent: 'helper', by: 'owner', confirm: async () => false }), /didn't confirm/);
  await assert.rejects(() => access.revoke({ connector: 'notes', agent: 'helper', by: 'owner', confirm: async () => 'Remove access' }), /didn't confirm/, 'only true counts');
  assert.equal(calls.grants.length, 0);
  const seen = [];
  const r = await access.revoke({ connector: 'notes', agent: 'helper', by: 'owner', confirm: async (q, y) => { seen.push([q, y]); return true; } });
  assert.deepEqual(r, { ok: true, agents: [] });
  assert.deepEqual(seen, [["owner wants to remove helper's access to Notes. Remove it?", 'Remove access']]);
  const g = [];
  await access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: async (q, y) => { g.push([q, y]); return true; } });
  assert.deepEqual(g, [['owner wants to give scout access to Notes. Allow?', 'Allow']]);
  assert.deepEqual(rows[0].agents, ['scout']);
});

test('after the answer everything is checked again, and the new list is built from the current one', async () => {
  const r = rig();
  // while the owner thinks, another change adds "extra" to the list
  await r.access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: async () => { r.rows[0].agents = ['helper', 'extra']; return true; } });
  assert.deepEqual(r.calls.grants, [['notes', ['helper', 'extra', 'scout']]], 'the list read before the question is not written back');
  // the change already happened by itself: ok, nothing written, nothing logged
  const r2 = rig();
  const before = r2.calls.grants.length;
  const out = await r2.access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: async () => { r2.rows[0].agents = ['helper', 'scout']; return true; } });
  assert.deepEqual(out, { ok: true, agents: ['helper', 'scout'] });
  assert.equal(r2.calls.grants.length, before); assert.equal(fs.existsSync(r2.auditFile), false); assert.equal(r2.calls.push.length, 0);
  const r3 = rig();
  const out3 = await r3.access.revoke({ connector: 'notes', agent: 'helper', by: 'owner', confirm: async () => { r3.rows[0].agents = []; return true; } });
  assert.deepEqual(out3, { ok: true, agents: [] }); assert.equal(r3.calls.grants.length, 0);
});

test('each rule is repeated after the answer: connector turned money or sensitive, agent gone, member-owned, temporary, a lead', async () => {
  const cases = [
    ['connector became sensitive', (r) => { r.rows[0].sensitive = true; }, /Only the owner can change access to Notes/],
    ['connector got a money tool', (r) => { r.rows[0].tools = { pay: { cls: 'money' } }; }, /Only the owner/],
    ['connector removed', (r) => { r.rows.splice(0, 1); }, /No data connector/],
    ['agent removed', (r) => { r.agentList.splice(r.agentList.findIndex(a => a.name === 'scout'), 1); }, /No agent named "scout"/],
    ['agent handed to a member', (r) => { r.agentList.find(a => a.name === 'scout').owner = 'member1'; }, /belongs to a member/],
    ['agent became temporary', (r) => { r.virtual.add('scout'); }, /temporary worker/],
    ['agent became a lead', (r) => { r.leads.push('scout'); }, /lead agent/],
  ];
  for (const [label, mutate, re] of cases) {
    const r = rig2();
    await assert.rejects(() => r.access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: async () => { mutate(r); return true; } }), re, label);
    assert.equal(r.calls.grants.length, 0, label); assert.equal(fs.existsSync(r.auditFile), false, label);
  }
});

test('stillAllowed is asked after the answer: false ends it with the turn-ended message, nothing changes', async () => {
  const r = rig();
  let order = [];
  await assert.rejects(() => r.access.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: async () => { order.push('confirm'); return true; }, stillAllowed: () => { order.push('still'); return false; } }), { message: 'The turn ended before the owner answered, so nothing changed.' });
  assert.deepEqual(order, ['confirm', 'still']);
  assert.equal(r.calls.grants.length, 0);
  assert.equal(await runTool(r.access, { action: 'revoke', connector: 'notes', agent: 'helper' }, 'owner', YES, () => false), 'The turn ended before the owner answered, so nothing changed.');
  assert.match(await runTool(r.access, { action: 'revoke', connector: 'notes', agent: 'helper' }, 'owner', YES, () => true), /^Done\./);
});

// A rig whose agent list, lead list and temporary set can change during the question.
function rig2() {
  const r = rig();
  const agentList = [{ name: 'owner' }, { name: 'helper' }, { name: 'scout' }];
  const leads = ['owner']; const virtual = new Set();
  const access = createConnectorAccess({
    connectors: r.connectors, modules: { setAgents() {} }, agents: () => agentList, leadNames: () => leads, push: { notify: () => Promise.resolve() },
    auditFile: r.auditFile, isMemberOwned: (a) => a.owner === 'member1', isVirtual: (n) => virtual.has(n),
  });
  return { ...r, access, agentList, leads, virtual };
}

test('a replaced agent (new box id, same name) or a connector that gained a stamp is refused; unchanged goes through', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-access-b-'));
  const mk = (list, rowsArr) => createConnectorAccess({
    connectors: { list: () => ({ connectors: rowsArr }), setGrants: (id, names) => { rowsArr[0].agents = names; } },
    modules: {}, agents: () => list, leadNames: [], push: { notify: () => Promise.resolve() }, auditFile: path.join(dir, 'a.jsonl'),
    isMemberOwned: () => false, isVirtual: () => false,
  });
  const MSG = 'The agent or connector changed while you were answering, so nothing changed.';
  const row = () => [{ id: 'notes', label: 'Notes', tools: { r: { cls: 'read' } }, agents: [], createdAt: 't1' }];
  let list = [{ name: 'scout', box: 'box-1' }];
  let r = row();
  const a = mk(list, r);
  await assert.rejects(a.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: async () => { list.splice(0, 1, { name: 'scout', box: 'box-2' }); return true; } }), { message: MSG });
  assert.deepEqual(r[0].agents, []);
  list = [{ name: 'scout', box: 'box-1' }]; r = row();
  const b = mk(list, r);
  await assert.rejects(b.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: async () => { delete list[0].box; return true; } }), { message: MSG }, 'missing on one side');
  list = [{ name: 'scout', box: 'box-1' }]; r = row();
  const c = mk(list, r);
  await assert.rejects(c.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: async () => { r[0].createdAt = 't2'; return true; } }), { message: MSG });
  list = [{ name: 'scout', box: 'box-1' }]; r = row();
  const d = mk(list, r);
  assert.deepEqual(await d.grant({ connector: 'notes', agent: 'scout', by: 'owner', confirm: YES }), { ok: true, agents: ['scout'] });
  fs.rmSync(dir, { recursive: true, force: true });
});
