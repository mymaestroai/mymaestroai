'use strict';
// Per-computer approval policy of a module with levels (levels.sessionApproval.policy): the manifest field, parsePolicy, the hold on a
// restore, mods.approvalPolicy / setApprovalPolicy, the revoke rule of setAgentPermissions, the protected setting, the hub/approve
// dayEnds answer, the guard's allowedBy copy, and the routes in server.js. Fake connectors, no real servers.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('mod-policy-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const manifestLib = L('modules/manifest');
const { createModules } = L('modules');
const { createConnectors } = L('connectors');

const LEVELS = { setting: 'levels', choices: ['look', 'act', 'drive'], default: 'look', sessionApproval: { setting: 'no_ask_agents', levels: ['act', 'drive'], policy: 'approval_policy' } };
const baseManifest = () => ({
  id: 'poldemo', name: 'Policy demo', category: 'Test', summary: 'Policy', risk: 'read',
  server: { type: 'mcp-stdio', script: 'server.js' },
  settings: [
    { key: 'levels', type: 'list', label: 'Levels', default: ['owner:look'], pattern: '^[a-z][a-z0-9_-]{0,63}:(look|act|drive)$' },
    { key: 'no_ask_agents', type: 'list', label: 'No ask', default: [] },
    { key: 'approval_policy', type: 'list', label: 'Approval policy', default: [] },
    { key: 'note', type: 'string', label: 'Note', default: 'x' },
  ],
  tools: { ping: 'read' }, levels: JSON.parse(JSON.stringify(LEVELS)),
});
const probs = (m) => manifestLib.validateManifest(m, 'poldemo').problems.join(' | ');
const SETUP = { steps: [
  { id: 'install', type: 'install', title: 'Install' },
  { id: 'agents', type: 'grant', title: 'Agents' },
  { id: 'done', type: 'finish', title: 'Done' },
] };
const AGENTS = [{ name: 'owner', lead: true }, { name: 'sam' }, { name: 'helper' }, { name: 'scout' }, { name: 'kid', owner: 'u_member' }, { name: 'tw-1' }];
const ADMIN = { adminBrowser: true, userId: 'u_admin', name: 'Jo', steppedUp: true };   // the server sets steppedUp after the account password was checked
const ADMIN_NO_STEP = { adminBrowser: true, userId: 'u_admin', name: 'Jo' };
const PC = 'abc$@x-1';          // a computer id (the last part of a node id)
const PC2 = 'zzzzzzzz9';

function rig({ manifest = baseManifest(), agents = AGENTS, auditFile = null, pushThrows = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-pol-'));
  const root = path.join(dir, 'root'); fs.mkdirSync(path.join(root, 'poldemo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'poldemo', 'module.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'poldemo', 'setup.json'), JSON.stringify(SETUP));
  fs.writeFileSync(path.join(root, 'poldemo', 'server.js'), '// not run\n');
  const conns = new Map(); const stopped = []; const pushes = []; const logs = [];
  const connectors = {
    list: () => ({ connectors: [...conns.values()].map(c => ({ ...c, secretNames: [] })) }),
    upsert: (spec) => { const c = { agents: [], enabled: false, ...(conns.get(spec.id) || {}), ...spec }; conns.set(spec.id, c); return c; },
    stop: (id) => stopped.push(id), remove: (id) => conns.delete(id), readSecrets: () => ({}),
  };
  const aFile = auditFile || path.join(dir, 'connector-access.jsonl');
  const mods = createModules({
    root, dataDir: path.join(dir, 'modules'), stateFile: path.join(dir, 'modules.json'), connectorsFile: path.join(dir, 'connectors.json'), connectors,
    isWalletAgent: () => false, isMemberOwned: (a) => a.owner === 'u_member', isVirtual: (n) => n.startsWith('tw-'), isAdminUser: (u) => u === 'u_admin',
    listAgents: () => agents, publish: () => {}, log: (m) => logs.push(String(m)), auditFile: aFile,
    pushAdmins: (p) => { pushes.push(p); if (pushThrows) throw new Error('push down'); return Promise.resolve(); },
  });
  const stateFile = path.join(dir, 'modules.json');
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).modules.poldemo;
  const policy = () => (state().settings || {}).approval_policy || [];
  const audit = () => { try { return fs.readFileSync(aFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  const finish = async (grant = ['sam', 'helper']) => { await mods.runStep('poldemo', 'install', {}); await mods.runStep('poldemo', 'agents', { agents: grant }); await mods.runStep('poldemo', 'done', {}); };
  const set = (input, who = ADMIN) => mods.setApprovalPolicy('poldemo', input, who);
  return { dir, root, mods, conns, stopped, pushes, logs, state, policy, audit, finish, set, stateFile, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const refused = (fn, status, re) => assert.throws(fn, (e) => e.status === status && (!re || re.test(e.message)), `${status} ${re || ''}`);
const withAck = (o) => ({ ...o, acknowledged: true });

// ── manifest ──
test('manifest: policy is accepted when it names a list setting that defaults empty and differs from the other keys', () => {
  assert.strictEqual(probs(baseManifest()), '');
  const lv = manifestLib.levelsOf(baseManifest());
  assert.deepStrictEqual(lv.ask, { setting: 'no_ask_agents', levels: ['act', 'drive'], policy: 'approval_policy' });
  const { policy, ...saNoPolicy } = LEVELS.sessionApproval;
  assert.strictEqual(probs({ ...baseManifest(), levels: { ...LEVELS, sessionApproval: saNoPolicy } }), '', 'policy is optional');
  assert.strictEqual(manifestLib.levelsOf({ ...baseManifest(), levels: { ...LEVELS, sessionApproval: saNoPolicy } }).ask.policy, null);
});

test('manifest: a policy key that is missing, not a list, not empty by default, or the same as another key is refused', () => {
  const withPolicy = (key) => ({ ...baseManifest(), levels: { ...LEVELS, sessionApproval: { ...LEVELS.sessionApproval, policy: key } } });
  assert.match(probs(withPolicy('nope')), /sessionApproval\.policy: "nope" is not a declared setting/);
  assert.match(probs(withPolicy('note')), /sessionApproval\.policy: setting note must be of type list/);
  assert.match(probs(withPolicy('levels')), /policy must differ from levels\.setting/);
  assert.match(probs(withPolicy('no_ask_agents')), /policy must differ from levels\.setting and levels\.sessionApproval\.setting/);
  assert.match(probs(withPolicy('')), /sessionApproval\.policy must name a setting/);
  const m = withPolicy('approval_policy'); m.settings[2].default = ['abc:day'];
  assert.match(probs(m), /sessionApproval\.policy: setting approval_policy must default to an empty list/);
  const m2 = withPolicy('approval_policy'); m2.settings[2].default = undefined;
  assert.match(probs(m2), /sessionApproval\.policy: setting approval_policy must default to an empty list/);
  assert.strictEqual(manifestLib.levelsOf(m), null);
});

test('protectedSettingKeys includes the policy key, also for an invalid levels block', () => {
  assert.deepStrictEqual(manifestLib.protectedSettingKeys(baseManifest()), ['levels', 'no_ask_agents', 'approval_policy']);
  const broken = { ...baseManifest(), levels: { setting: 'levels', sessionApproval: { setting: 'no_ask_agents', policy: 'approval_policy' } } };
  assert.ok(probs(broken) !== '');
  assert.ok(manifestLib.protectedSettingKeys(broken).includes('approval_policy'));
  assert.ok(manifestLib.validateManifest(baseManifest(), 'poldemo').protectedKeys.has('approval_policy'));
});

// ── parsePolicy ──
test('parsePolicy: day and trust entries per computer; malformed entries are ignored', () => {
  const p = manifestLib.parsePolicy([`${PC}:day`, `${PC}:trust:sam`, `${PC}:trust:helper`, `${PC}:trust:sam`, `${PC2}:trust:scout`]);
  assert.deepStrictEqual([...p.keys()], [PC, PC2]);
  assert.deepStrictEqual(p.get(PC), { mode: 'day', trusted: ['sam', 'helper'] });
  assert.deepStrictEqual(p.get(PC2), { mode: 'session', trusted: ['scout'] });
  const bad = manifestLib.parsePolicy(['', 'x', ':day', `${PC}:week`, `${PC}:trust`, `${PC}:trust:`, `${PC}:trust:a:b`, `${PC}:day:x`, 'bad id:day', `${'a'.repeat(101)}:day`, 7, null, {}, `${PC}:Day`]);
  assert.strictEqual(bad.size, 0);
  assert.strictEqual(manifestLib.parsePolicy('nope').size, 0);
  assert.strictEqual(manifestLib.parsePolicy(undefined).size, 0);
  assert.deepStrictEqual(manifestLib.parsePolicy([` ${PC}:day `]).get(PC), { mode: 'day', trusted: [] });
});

// ── restore hold ──
test('holdNoAskSettings empties the declared policy key and the conventional approval_policy key', () => {
  const modulesRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hold-pol-')), 'modules');
  try {
    fs.mkdirSync(path.join(modulesRoot, 'poldemo'), { recursive: true });
    const man = baseManifest();
    man.levels.sessionApproval.policy = 'computer_rules'; man.settings.push({ key: 'computer_rules', type: 'list', label: 'Rules', default: [] });
    fs.writeFileSync(path.join(modulesRoot, 'poldemo', 'module.json'), JSON.stringify(man));
    fs.mkdirSync(path.join(modulesRoot, 'other'), { recursive: true });
    fs.writeFileSync(path.join(modulesRoot, 'other', 'module.json'), JSON.stringify({ ...baseManifest(), id: 'other', levels: undefined }));
    const staged = { modules: {
      poldemo: { settings: { no_ask_agents: ['sam'], computer_rules: [`${PC}:day`], approval_policy: [`${PC}:day`], note: 'keep' } },
      other: { settings: { approval_policy: [`${PC}:trust:sam`], note: 'keep' } },
      nomanifest: { settings: { approval_policy: ['x:day'] } },
    } };
    assert.strictEqual(manifestLib.holdNoAskSettings(staged, modulesRoot), true);
    assert.deepStrictEqual(staged.modules.poldemo.settings, { no_ask_agents: [], computer_rules: [], approval_policy: [], note: 'keep' });
    assert.deepStrictEqual(staged.modules.other.settings.approval_policy, []);
    assert.strictEqual(staged.modules.other.settings.note, 'keep');
    assert.deepStrictEqual(staged.modules.nomanifest.settings.approval_policy, []);
    assert.strictEqual(manifestLib.holdNoAskSettings(staged, modulesRoot), false, 'nothing left to change');
  } finally { fs.rmSync(path.dirname(modulesRoot), { recursive: true, force: true }); }
});

// ── approvalPolicy (read) ──
test('approvalPolicy: nothing set by default; lists the policy and the agents that can use the module with their levels', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const d = r.mods.approvalPolicy('poldemo');
  assert.deepStrictEqual(d.policy, {});
  assert.deepStrictEqual(d.agents.map(a => a.name).sort(), ['helper', 'owner', 'sam']);
  assert.ok(d.agents.every(a => a.level === 'look'));
  r.set(withAck({ computer: PC, mode: 'day', trusted: ['sam'] }));
  assert.deepStrictEqual(r.mods.approvalPolicy('poldemo').policy, { [PC]: { mode: 'day', trusted: ['sam'] } });
});

// ── setApprovalPolicy ──
test('setApprovalPolicy: only a live admin in their own browser; checked before the input is read', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const input = { computer: PC, mode: 'day', trusted: [], acknowledged: true };
  for (const who of [null, {}, { adminBrowser: true }, { adminBrowser: true, userId: 'u_member' }, { adminBrowser: false, userId: 'u_admin' }, { userId: 'u_admin' }, { adminBrowser: 'true', userId: 'u_admin' }]) {
    refused(() => r.set(input, who), 403);
    refused(() => r.set({ nonsense: 1 }, who), 403, /admin/);   // a bad input from a non-admin is still a 403, never a hint about the input
    refused(() => r.set(null, who), 403);
  }
  assert.deepStrictEqual(r.policy(), []);
  assert.deepStrictEqual(r.audit(), []);
});

test('setApprovalPolicy: a module without a policy, or not installed, is refused', async (t) => {
  const m = baseManifest(); delete m.levels.sessionApproval.policy;
  const r1 = rig({ manifest: m }); t.after(r1.cleanup);
  await r1.finish();
  refused(() => r1.set({ computer: PC, mode: 'day', trusted: [] }), 400, /no approval policy/);
  const r2 = rig(); t.after(r2.cleanup);
  refused(() => r2.set({ computer: PC, mode: 'day', trusted: [] }), 400, /Install/);
});

test('setApprovalPolicy: unknown fields, a bad computer id, a bad mode and an agent that cannot use the module are refused', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const ok = { computer: PC, mode: 'session', trusted: [] };
  refused(() => r.set('x'), 400); refused(() => r.set(null), 400); refused(() => r.set([]), 400);
  refused(() => r.set({ ...ok, extra: 1 }), 400, /Unknown field "extra"/);
  refused(() => r.set({ ...ok, name: 'My PC' }), 400, /Unknown field "name"/);
  for (const bad of [undefined, '', 'a b', 'a/b', 'a:b', 'x'.repeat(101), 5, null, 'node//abc', 'é']) refused(() => r.set({ ...ok, computer: bad }), 400, /computer/);
  for (const bad of [undefined, 'week', 'Day', '', 1, null]) refused(() => r.set({ ...ok, mode: bad }), 400, /mode/);
  for (const bad of [undefined, 'sam', null, [1], [null]]) refused(() => r.set({ ...ok, trusted: bad }), 400, /trusted/);
  refused(() => r.set({ ...ok, trusted: ['sam', 'sam'] }), 400, /twice/);
  refused(() => r.set({ ...ok, trusted: Array.from({ length: 65 }, (_, i) => `a${i}`) }), 400, /up to 64/);
  refused(() => r.set({ ...ok, trusted: ['scout'] }), 400, /"scout" cannot use/);   // exists, but not given the module
  refused(() => r.set({ ...ok, trusted: ['kid'] }), 400, /"kid"/);                  // member's agent
  refused(() => r.set({ ...ok, trusted: ['tw-1'] }), 400, /"tw-1"/);                // temporary worker
  refused(() => r.set({ ...ok, trusted: ['nobody'] }), 400, /"nobody"/);
  refused(() => r.set({ ...ok, trusted: ['sam:x'] }), 400, /"sam:x"/);
  refused(() => r.set({ ...ok, acknowledged: 'yes' }), 400, /acknowledged/);
  assert.deepStrictEqual(r.policy(), []);
  assert.deepStrictEqual(r.audit(), []);
});

test('setApprovalPolicy: loosening needs acknowledged (session to day, a newly trusted agent); tightening does not', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  let e = null;
  try { r.set({ computer: PC, mode: 'day', trusted: [] }); } catch (x) { e = x; }
  assert.ok(e && e.status === 409 && e.needsAck === true, 'session to day');
  assert.match(e.message, /^On computer abc\$@x, one approval would last until midnight\. Confirm that you understand this to continue\.$/);
  assert.match(e.message, /abc\$@x/, 'names the computer by its first characters');
  try { e = null; r.set({ computer: PC, mode: 'session', trusted: ['sam'] }); } catch (x) { e = x; }
  assert.ok(e && e.status === 409 && e.needsAck === true, 'newly trusted');
  assert.match(e.message, /sam/);
  assert.deepStrictEqual(r.policy(), []);
  assert.deepStrictEqual(r.audit(), [], 'a refused change leaves no record and no push');
  assert.strictEqual(r.pushes.length, 0);
  // allowed after the owner confirms
  assert.strictEqual(r.set(withAck({ computer: PC, mode: 'day', trusted: ['sam', 'helper'] })).changed, true);
  assert.deepStrictEqual(r.mods.approvalPolicy('poldemo').policy[PC], { mode: 'day', trusted: ['sam', 'helper'] });
  // tightening: untrust one agent and day -> session: no acknowledgement
  assert.strictEqual(r.set({ computer: PC, mode: 'day', trusted: ['sam'] }).changed, true);
  assert.strictEqual(r.set({ computer: PC, mode: 'session', trusted: ['sam'] }).changed, true);
  assert.strictEqual(r.set({ computer: PC, mode: 'session', trusted: [] }).changed, true);
  assert.deepStrictEqual(r.policy(), []);
  // a day computer: keeping day and adding a trusted agent is loosening; keeping the trusted set and day is not
  r.set(withAck({ computer: PC, mode: 'day', trusted: ['sam'] }));
  refused(() => r.set({ computer: PC, mode: 'day', trusted: ['sam', 'helper'] }), 409);
  assert.strictEqual(r.set({ computer: PC, mode: 'day', trusted: ['sam'] }).changed, false);
});

test('setApprovalPolicy: the audit record is written before the setting is saved, and closed with done', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const seen = [];
  const real = fs.appendFileSync;
  fs.appendFileSync = function (file, data, ...rest) {
    if (String(file).endsWith('connector-access.jsonl')) { const rec = JSON.parse(String(data)); seen.push({ state: rec.state, policyThen: (r.state().settings || {}).approval_policy || [] }); }
    return real.call(this, file, data, ...rest);
  };
  try { r.set(withAck({ computer: PC, mode: 'day', trusted: ['sam'] })); } finally { fs.appendFileSync = real; }
  assert.deepStrictEqual(seen.map(s => s.state), ['requested', 'done']);
  assert.deepStrictEqual(seen[0].policyThen, [], 'nothing saved yet when the request was recorded');
  assert.deepStrictEqual(seen[1].policyThen.slice().sort(), [`${PC}:day`, `${PC}:trust:sam`].sort(), 'saved by the time it is closed');
  const recs = r.audit();
  assert.strictEqual(recs[0].action, 'approval-policy');
  assert.strictEqual(recs[0].connector, 'poldemo');
  assert.strictEqual(recs[0].computer, PC);
  assert.strictEqual(recs[0].by, 'Jo');
  assert.ok(!Number.isNaN(Date.parse(recs[0].at)));
  assert.deepStrictEqual(recs[0].from, { mode: 'session', trusted: [] });
  assert.deepStrictEqual(recs[0].to, { mode: 'day', trusted: ['sam'] });
  assert.strictEqual(recs[0].state, 'requested');
});

test('setApprovalPolicy: a failed audit write refuses with 500 and changes nothing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pol-badaudit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'afile'), 'not a folder');
  const r = rig({ auditFile: path.join(dir, 'afile', 'log.jsonl') }); t.after(r.cleanup);
  await r.finish();
  const stoppedBefore = r.stopped.length;
  refused(() => r.set(withAck({ computer: PC, mode: 'day', trusted: ['sam'] })), 500, /nothing changed/);
  assert.deepStrictEqual(r.policy(), []);
  assert.strictEqual(r.pushes.length, 0);
  assert.strictEqual(r.stopped.length, stoppedBefore, 'the connector was not restarted');
});

test('setApprovalPolicy: admins are told about every change, tightening too; a failing push changes nothing', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  r.set(withAck({ computer: PC, mode: 'day', trusted: ['sam', 'helper'] }));
  assert.strictEqual(r.pushes.length, 1);
  assert.deepStrictEqual(r.pushes[0], { title: 'Remote computer approvals changed', body: 'Jo set computer abc$@x to ask once a day; not asked: sam, helper.', url: '/modules#poldemo' });
  r.set({ computer: PC, mode: 'session', trusted: [] });   // tightening
  assert.strictEqual(r.pushes.length, 2);
  assert.strictEqual(r.pushes[1].body, 'Jo set computer abc$@x to ask every session.');
  assert.strictEqual(r.set({ computer: PC, mode: 'session', trusted: [] }).changed, false);
  assert.strictEqual(r.pushes.length, 2, 'no change, no notice');
  const r2 = rig({ pushThrows: true }); t.after(r2.cleanup);
  await r2.finish();
  assert.strictEqual(r2.set(withAck({ computer: PC, mode: 'day', trusted: [] })).changed, true, 'a push that throws is ignored');
  assert.deepStrictEqual(r2.policy(), [`${PC}:day`]);
});

test('setApprovalPolicy: the connector restarts, other computers keep their entries, no change gives changed:false', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  r.set(withAck({ computer: PC2, mode: 'day', trusted: ['helper'] }));
  const stopped = r.stopped.length;
  const out = r.set(withAck({ computer: PC, mode: 'day', trusted: ['sam'] }));
  assert.strictEqual(out.ok, true); assert.strictEqual(out.changed, true);
  assert.ok(out.module && out.module.id === 'poldemo');
  assert.strictEqual(r.stopped.length, stopped + 1, 'live sessions end');
  assert.deepStrictEqual(r.policy().slice().sort(), [`${PC2}:day`, `${PC2}:trust:helper`, `${PC}:day`, `${PC}:trust:sam`].sort());
  // changing one computer leaves the other alone
  r.set({ computer: PC, mode: 'session', trusted: [] });
  assert.deepStrictEqual(r.policy().slice().sort(), [`${PC2}:day`, `${PC2}:trust:helper`].sort());
  const before = r.audit().length, stops = r.stopped.length;
  const same = r.set({ computer: PC2, mode: 'day', trusted: ['helper'] });
  assert.deepStrictEqual({ ok: same.ok, changed: same.changed }, { ok: true, changed: false });
  assert.ok(same.module);
  assert.strictEqual(r.audit().length, before); assert.strictEqual(r.stopped.length, stops);
  // a computer that was never listed set to "ask every session" is no change
  assert.strictEqual(r.set({ computer: 'neverlisted', mode: 'session', trusted: [] }).changed, false);
});

test('the policy is protected: saveSettings and settings steps cannot write it', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  assert.throws(() => r.mods.saveSettings('poldemo', { approval_policy: [`${PC}:day`] }), /permission editor/);
  assert.throws(() => r.mods.saveSettings('poldemo', { note: 'y', approval_policy: [] }), /permission editor/);
  assert.deepStrictEqual(r.policy(), []);
  r.set(withAck({ computer: PC, mode: 'day', trusted: [] }));
  assert.strictEqual(r.mods.saveSettings('poldemo', { note: 'y' }).settings.note, 'y');
  assert.deepStrictEqual(r.policy(), [`${PC}:day`], 'a generic save keeps the stored policy');
});

test('setAgentPermissions: an agent that loses the module loses its trust entries; others keep theirs', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish(['sam', 'helper']);
  r.set(withAck({ computer: PC, mode: 'day', trusted: ['sam', 'helper'] }));
  r.set(withAck({ computer: PC2, mode: 'session', trusted: ['sam'] }));
  const perms = { owner: { level: 'look', askEachSession: true }, helper: { level: 'act', askEachSession: true } };
  const out = r.mods.setAgentPermissions('poldemo', { agents: ['helper'], permissions: perms }, ADMIN);   // sam is revoked; helper stays at Act
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual(r.policy().slice().sort(), [`${PC}:day`, `${PC}:trust:helper`].sort());
  assert.deepStrictEqual(r.mods.approvalPolicy('poldemo').policy, { [PC]: { mode: 'day', trusted: ['helper'] } });
  // giving it back does not revive the entry
  r.mods.setAgentPermissions('poldemo', { agents: ['helper', 'sam'], permissions: { ...perms, sam: { level: 'look', askEachSession: true } } }, ADMIN);
  assert.ok(!r.policy().some(e => e.endsWith(':trust:sam')));
});

test('setAgentPermissions: an agent set to Look loses its trust entries, and raising it again later does not bring them back', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish(['sam', 'helper']);
  const act = { owner: { level: 'look', askEachSession: true }, helper: { level: 'act', askEachSession: true }, sam: { level: 'act', askEachSession: true } };
  r.mods.setAgentPermissions('poldemo', { agents: ['helper', 'sam'], permissions: act }, ADMIN);
  r.set(withAck({ computer: PC, mode: 'day', trusted: ['sam', 'helper'] }));
  r.set(withAck({ computer: PC2, mode: 'session', trusted: ['sam'] }));
  r.mods.setAgentPermissions('poldemo', { agents: ['helper', 'sam'], permissions: { ...act, sam: { level: 'look', askEachSession: true } } }, ADMIN);
  assert.ok(!r.policy().some(e => e.endsWith(':trust:sam')), 'sam at Look keeps no trust entry');
  assert.ok(r.policy().includes(`${PC}:trust:helper`) && r.policy().includes(`${PC}:day`), 'helper and the day mode stay');
  r.mods.setAgentPermissions('poldemo', { agents: ['helper', 'sam'], permissions: act }, ADMIN);   // back to Act, asked
  assert.ok(!r.policy().some(e => e.endsWith(':trust:sam')), 'raising it again does not revive the old trust');
  assert.deepStrictEqual(r.mods.approvalPolicy('poldemo').policy[PC], { mode: 'day', trusted: ['helper'] });
});

test('the generic grant (setAgents) and identity changes also drop trust entries of an agent that loses the module', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish(['sam', 'helper']);
  r.set(withAck({ computer: PC, mode: 'session', trusted: ['sam', 'helper'] }));
  r.mods.setAgents('poldemo', ['helper']);
  assert.deepStrictEqual(r.policy(), [`${PC}:trust:helper`]);
  const res = r.mods.forgetAgentPermissions(['helper']);
  assert.deepStrictEqual(res.cleared, ['poldemo']);
  assert.deepStrictEqual(r.policy(), []);
  // a computer whose id equals an agent's name is not mistaken for that agent
  const r2 = rig({ agents: [...AGENTS, { name: 'pcname' }] }); t.after(r2.cleanup);
  await r2.finish(['sam', 'pcname']);
  r2.set(withAck({ computer: 'pcname', mode: 'day', trusted: ['sam'] }));
  r2.mods.setAgents('poldemo', ['sam']);   // pcname loses the module
  assert.deepStrictEqual(r2.policy().slice().sort(), ['pcname:day', 'pcname:trust:sam']);
});

// ── hub/approve: dayEnds ──
function approveRig(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pol-approve-'));
  const all = [];
  class FakeClient extends EventEmitter {
    constructor() { super(); this.calls = []; this.responses = []; this.errors = []; all.push(this); }
    async connect() {} async listTools() { return [{ name: 'one' }]; } async disconnect() {}
    async callTool(name, args) { this.calls.push({ name, args }); return { content: [{ type: 'text', text: 'ok' }] }; }
    respond(id, r) { this.responses.push({ id, result: r }); }
    respondError(id, code, message) { this.errors.push({ id, code, message }); }
  }
  const open = [];
  const approvals = { request: (spec) => { let resolve; const promise = new Promise(rs => { resolve = rs; }); open.push({ spec, resolve }); return { id: `ap${open.length}`, promise }; } };
  const cx = createConnectors({ file: path.join(dir, 'connectors.json'), keyFile: path.join(dir, '.auth-key'), McpClient: FakeClient, log: () => {}, unlockTtlMs: 0, baseEnv: { PATH: process.env.PATH }, leadNames: () => ['owner'], getApprovals: () => approvals, ...o });
  cx.upsert({ id: 'rc', label: 'Remote computers', kind: 'mcp', command: process.execPath, args: ['x'], module: 'rc', enabled: true, approvals: true, agents: ['sam'] }, { byModule: true });
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(rs => setImmediate(rs)); };
  /** Ask once and answer with `answer`; returns what the server was told. */
  async function ask(answer) {
    const s = (await cx.toolSpecsFor('sam')).find(x => x.connector === 'rc');
    await s.handler({});
    const cl = all[all.length - 1];
    let release; const prev = cl.callTool;
    cl.callTool = async function (name, args) { this.calls.push({ name, args }); await new Promise(rs => { release = rs; }); return { content: [{ type: 'text', text: 'ok' }] }; };
    const pending = s.handler({}); await tick(); cl.callTool = prev;
    const id = cl.calls[cl.calls.length - 1].args.__call;
    const n = cl.responses.length;
    cl.emit('request', { id: 100 + n, method: 'hub/approve', params: { call: id, title: 'Open it' } }); await tick();
    open[open.length - 1].resolve(answer); await tick();
    release(); await pending;
    return cl.responses[n].result;
  }
  return { cx, ask, done: () => { cx.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const nyMidnight = (y, mo, d) => {   // the instant of 00:00 on y-mo-d in America/New_York, worked out independently of lib/timezone
  for (const h of [4, 5]) { const ms = Date.UTC(y, mo - 1, d, h); const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', day: '2-digit' }).formatToParts(ms); const g = (t) => p.find(x => x.type === t).value; if (g('hour') === '00' && g('minute') === '00' && Number(g('day')) === d) return ms; }
  throw new Error('no midnight');
};

test('hub/approve: an allow carries dayEnds = the next midnight in the owner zone; deny and timeout carry none', async () => {
  const clock = { t: Date.UTC(2026, 0, 15, 15, 0) };   // 10:00 in New York (EST)
  const r = approveRig({ now: () => clock.t, zone: () => 'America/New_York' });
  try {
    const allow = await r.ask({ decision: 'allow', by: 'owner' });
    assert.strictEqual(allow.decision, 'allow');
    assert.strictEqual(allow.dayEnds, Date.UTC(2026, 0, 16, 5, 0));
    assert.strictEqual(allow.dayEnds, nyMidnight(2026, 1, 16));
    clock.t += 16000;
    assert.deepStrictEqual(await r.ask({ decision: 'deny', by: 'owner' }), { decision: 'deny' });
    clock.t += 16000;
    assert.deepStrictEqual(await r.ask({ decision: 'deny', by: 'timeout' }), { decision: 'timeout' });
  } finally { r.done(); }
});

test('hub/approve: dayEnds follows the zone across a DST change and a late-evening answer', async () => {
  const cases = [
    { now: Date.UTC(2026, 2, 7, 20, 0), ends: nyMidnight(2026, 3, 8), what: 'the evening before spring forward' },      // 15:00 EST, midnight is still EST
    { now: Date.UTC(2026, 2, 8, 16, 0), ends: nyMidnight(2026, 3, 9), what: 'the day of spring forward (23 hours)' },    // 12:00 EDT
    { now: Date.UTC(2026, 10, 1, 17, 0), ends: nyMidnight(2026, 11, 2), what: 'the day of fall back (25 hours)' },       // 12:00 EST
    { now: Date.UTC(2026, 0, 16, 4, 59), ends: Date.UTC(2026, 0, 16, 5, 0), what: 'one minute before midnight' },
    { now: Date.UTC(2026, 0, 16, 5, 0), ends: Date.UTC(2026, 0, 17, 5, 0), what: 'exactly at midnight starts the next day' },
  ];
  for (const c of cases) {
    const r = approveRig({ now: () => c.now, zone: () => 'America/New_York' });
    try {
      const a = await r.ask({ decision: 'allow', by: 'owner' });
      assert.strictEqual(a.dayEnds, c.ends, c.what);
      assert.ok(a.dayEnds > c.now, c.what);
    } finally { r.done(); }
  }
  // the DST day really is 23 and 25 hours long
  assert.strictEqual(nyMidnight(2026, 3, 9) - nyMidnight(2026, 3, 8), 23 * 3600000);
  assert.strictEqual(nyMidnight(2026, 11, 2) - nyMidnight(2026, 11, 1), 25 * 3600000);
  // another zone gives another instant
  const r = approveRig({ now: () => Date.UTC(2026, 0, 15, 14, 0), zone: () => 'Asia/Tokyo' });   // 23:00 on Jan 15 in Tokyo
  try { assert.strictEqual((await r.ask({ decision: 'allow', by: 'owner' })).dayEnds, Date.UTC(2026, 0, 15, 15, 0)); } finally { r.done(); }
});

test('hub/approve: a broken zone gives a plain allow, never a bad dayEnds', async () => {
  for (const zone of [() => { throw new Error('no zone'); }, () => 'Not/AZone']) {
    const r = approveRig({ now: () => Date.UTC(2026, 0, 15, 15, 0), zone });
    try {
      const a = await r.ask({ decision: 'allow', by: 'owner' });
      assert.strictEqual(a.decision, 'allow');
      if ('dayEnds' in a) assert.ok(Number.isFinite(a.dayEnds) && a.dayEnds > Date.UTC(2026, 0, 15, 15, 0));
    } finally { r.done(); }
  }
});

// ── the guard: allowedBy ──
function guardServer(meta) {
  return `'use strict';
let buf = '';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'g', version: '1' } } });
    else if (m.method === 'tools/call') out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }], _meta: ${JSON.stringify(meta)} } });
  } });
`;
}
async function guardAudit(meta) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pol-'));
  const root = path.join(dir, 'root'); fs.mkdirSync(path.join(root, 'guarddemo'), { recursive: true });
  const FIX = path.join(__dirname, 'fixtures', 'modules', 'guarddemo');
  // a write-class tool: the guard watches its answer (read-class calls are not audited)
  fs.writeFileSync(path.join(root, 'guarddemo', 'module.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIX, 'module.json'), 'utf8')), risk: 'write', tools: { ping: 'write' } }));
  fs.writeFileSync(path.join(root, 'guarddemo', 'setup.json'), JSON.stringify({ steps: [{ id: 'done', type: 'finish', title: 'Finish' }] }));
  fs.writeFileSync(path.join(root, 'guarddemo', 'server.js'), guardServer(meta));
  const g = spawn(process.execPath, [path.join(ISO.lib, 'modules', 'mcp-guard.js'), 'guarddemo', '--root', root, '--data', path.join(dir, 'modules'), '--state', path.join(dir, 'modules.json'), '--connectors', path.join(dir, 'connectors.json')], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH } });
  try {
    const out = []; let buf = '';
    g.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const until = async (f) => { for (let i = 0; i < 100; i++) { if (f()) return true; await new Promise(res => setTimeout(res, 50)); } return false; };
    g.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    assert.ok(await until(() => out.some(m => m.id === 1)));
    g.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } }) + '\n');
    assert.ok(await until(() => out.some(m => m.id === 2)), 'the call finished');
    const file = path.join(dir, 'modules', 'guarddemo', 'audit.jsonl');
    assert.ok(await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('"done"')), 'the done line is written');
    return fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).find(x => x.decision === 'done');
  } finally { g.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('guard: a valid mymaestro/allowedBy is copied into the done line; an invalid one or none is not', async () => {
  assert.strictEqual((await guardAudit({ 'mymaestro/allowedBy': 'trusted' })).allowedBy, 'trusted');
  assert.strictEqual((await guardAudit({ 'mymaestro/allowedBy': 'day' })).allowedBy, 'day');
  assert.strictEqual((await guardAudit({ 'mymaestro/allowedBy': 'owner-ok' })).allowedBy, 'owner-ok');
  for (const bad of ['Trusted', 'a_b', 'x'.repeat(25), '', 'two words', 5, null, { a: 1 }, ['day'], 'day\n']) {
    const line = await guardAudit({ 'mymaestro/allowedBy': bad });
    assert.ok(!('allowedBy' in line), `ignored: ${JSON.stringify(bad)}`);
  }
  assert.ok(!('allowedBy' in await guardAudit({})), 'no meta key');
  assert.ok(!('allowedBy' in await guardAudit(null)), 'no meta at all');
  assert.ok(!('allowedBy' in await guardAudit('day')), 'meta is not an object');
});

// ── routes (source level: server.js is not started here) ──
test('server.js: the approval-policy routes sit behind the same admin-browser check as agent-permissions', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const check = "req.hubIdentKind === 'user' && !req.hubPendingTotp && !req.hubToken && !req.hubService && access.isAdmin(req.hubUser)";
  const i = src.indexOf('/approval-policy$/');
  assert.ok(i > 0, 'the route exists');
  const block = src.slice(i, src.indexOf("/help$/", i));
  assert.ok(block.includes(check), 'same check as agent-permissions');
  assert.ok(src.slice(src.indexOf('/agent-permissions$/'), i).includes(check));
  assert.ok(block.indexOf(check) < block.indexOf('mods.approvalPolicy') && block.indexOf(check) < block.indexOf('mods.setApprovalPolicy'), 'the check comes first');
  assert.match(block, /req\.method === 'GET' \|\| req\.method === 'POST'/);
  assert.match(block, /mods\.setApprovalPolicy\(m\[1\], body, \{ adminBrowser: true, userId: String\(req\.hubUser\.id\)/);
  assert.match(block, /\{ computerName: known \? known\.name : '', computerKnown \}/, 'the name for the notice comes from the module, not the request');
  assert.match(block, /const computerKnown = listed && listed\.length \? !!known : null;/, 'true / false when the list was read and is not empty, null otherwise');
  assert.match(block, /'computers_status', \{\}, \{ hub: true, timeoutMs \}/);
  assert.match(block, /computersOf\(30000\)/);
  assert.match(block, /Could not load the computers\./);
  assert.ok(!/if \(listed && !known\)/.test(block), 'the route no longer refuses an unknown computer by itself: setApprovalPolicy decides (only when the change asks less)');
  assert.match(block, /id: x\.nodeid\.split\('\/'\)\.pop\(\), nodeid: x\.nodeid, name: String\(x\.name \|\| ''\)/);
  assert.match(block, /403/);
});

test('setApprovalPolicy: the notice, the 409 and the audit record name the computer the server looked up', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const mods = r.mods;
  const auth = { ...ADMIN, name: 'Jo' };
  let e = null;
  try { mods.setApprovalPolicy('poldemo', { computer: PC, mode: 'day', trusted: ['sam'] }, auth, { computerName: 'PC-A\u0007' }); } catch (x) { e = x; }
  assert.ok(e && e.status === 409);
  assert.strictEqual(e.message, 'On PC-A (abc$@x), one approval would last until midnight, and sam would never be asked. Confirm that you understand this to continue.');
  mods.setApprovalPolicy('poldemo', { computer: PC, mode: 'day', trusted: ['sam'], acknowledged: true }, auth, { computerName: 'PC-A' });
  assert.strictEqual(r.pushes.at(-1).body, 'Jo set PC-A (abc$@x) to ask once a day; not asked: sam.');
  const recs = r.audit().filter((x) => x.action === 'approval-policy');
  assert.ok(recs.length >= 2 && recs.every((x) => x.computerName === 'PC-A' && x.computer === PC));
});

test('setApprovalPolicy: loosening needs the account password (steppedUp) as well as the acknowledgement; tightening needs neither', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const day = { computer: PC, mode: 'day', trusted: [] };
  const trust = { computer: PC, mode: 'session', trusted: ['sam'] };
  for (const input of [day, trust]) {
    // acknowledged, not stepped up
    let e = null;
    try { r.set(withAck(input), ADMIN_NO_STEP); } catch (x) { e = x; }
    assert.ok(e && e.status === 409 && e.needsAck === true && e.needsStepUp === true, JSON.stringify(input));
    for (const bogus of ['yes', 1, 'true', {}, null]) refused(() => r.set(withAck(input), { ...ADMIN_NO_STEP, steppedUp: bogus }), 409);
    // stepped up, not acknowledged
    try { e = null; r.set(input, ADMIN); } catch (x) { e = x; }
    assert.ok(e && e.status === 409 && e.needsAck === true && e.needsStepUp === true);
  }
  refused(() => r.set({ ...withAck(day), steppedUp: true }, ADMIN_NO_STEP), 400, /Unknown field "steppedUp"/);
  assert.deepStrictEqual(r.policy(), []);
  assert.deepStrictEqual(r.audit(), [], 'a refused change leaves no record and no push');
  assert.strictEqual(r.pushes.length, 0);
  // both: allowed, and the audit record says steppedUp
  assert.strictEqual(r.set(withAck({ computer: PC, mode: 'day', trusted: ['sam', 'helper'] }), ADMIN).changed, true);
  assert.ok(r.audit().length > 0 && r.audit().every(x => x.steppedUp === true));
  // tightening needs neither
  const n = r.audit().length;
  assert.strictEqual(r.set({ computer: PC, mode: 'day', trusted: ['sam'] }, ADMIN_NO_STEP).changed, true);
  assert.strictEqual(r.set({ computer: PC, mode: 'session', trusted: ['sam'] }, ADMIN_NO_STEP).changed, true);
  assert.strictEqual(r.set({ computer: PC, mode: 'session', trusted: [] }, ADMIN_NO_STEP).changed, true);
  assert.ok(r.audit().slice(n).length > 0 && r.audit().slice(n).every(x => !('steppedUp' in x)), 'tightening is not marked');
});

test('server.js: both routes take password and code out of the body, check them with the shared helper, and set steppedUp only from that result', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // the one helper, used by the backups routes too
  assert.match(src, /\nfunction accountStepUp\(user, b, ip\) \{/);
  assert.strictEqual((src.match(/String\(b\.password \|\| ''\)/g) || []).length, 1, 'the step-up password check lives in one place');
  const backups = src.slice(src.indexOf("pathname === '/api/backups' || pathname.startsWith"));
  assert.match(backups.slice(0, 1500), /const stepUp = \(b\) => accountStepUp\(req\.hubUser, b, req\.socket && req\.socket\.remoteAddress\);/);
  assert.ok(!/const stepUp = \(b\) => \{/.test(src));
  assert.match(src, /return r\.locked \? r\.error : 'That password is not right\.';/);
  assert.match(src, /'That two-factor code is not right\.'/);
  // the modules routes
  const take = src.slice(src.indexOf('const takeStepUp = (b) =>'), src.indexOf('// Changes come from a person on the page'));
  assert.match(take, /typeof input\.password !== 'string'/, 'present means a string, even an empty one');
  assert.match(take, /delete input\.password; delete input\.code;/);
  assert.match(take, /accountStepUp\(req\.hubUser, given, /);
  assert.match(take, /steppedUp: true/);
  assert.ok(!/steppedUp: true/.test(take.replace(/\{ input, steppedUp: true, denied: null \}/, '')), 'steppedUp true only on the helper success');
  const perms = src.slice(src.indexOf('/agent-permissions$/'), src.indexOf('/approval-policy$/'));
  const pol = src.slice(src.indexOf('/approval-policy$/'), src.indexOf('/help$/'));
  for (const [name, block, call] of [['agent-permissions', perms, 'mods.setAgentPermissions'], ['approval-policy', pol, 'mods.setApprovalPolicy']]) {
    assert.match(block, /const su = takeStepUp\(await bodyJson\(\)\);/, name);
    assert.match(block, /if \(su\.denied\) return jsonResponse\(res, 403, \{ error: su\.denied, stepUp: true \}\);/, name);
    assert.ok(block.indexOf('takeStepUp') < block.indexOf(call), `${name}: the check comes before the change`);
    assert.match(block, /steppedUp: su\.steppedUp \}/, name);
    assert.ok(!/b(ody)?\.steppedUp|req\.body/.test(block), `${name}: steppedUp never comes from the body`);
  }
  assert.match(perms, /mods\.setAgentPermissions\(m\[1\], su\.input,/);
  assert.match(pol, /const body = su\.input;/);
  // fail() forwards the flags
  const fail = src.slice(src.indexOf('const userHasTotp = '), src.indexOf('const takeStepUp'));
  assert.match(fail, /e\.needsAck \? \{ needsAck: true \}/);
  assert.match(fail, /e\.needsStepUp \? \{ needsStepUp: true, totp: /);
  assert.match(fail, /req\.hubUser\.totp && req\.hubUser\.totp\.enabled/, "the signed-in account's own flag");
});

// ── review fixes ──
test('setApprovalPolicy: an unknown computer is refused only when the change asks less; clearing a stale computer always works', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const unknown = { computerKnown: false };
  // asks less (a day-long approval, a newly trusted agent): 400, before the step-up rules, nothing recorded
  refused(() => r.mods.setApprovalPolicy('poldemo', { computer: PC, mode: 'day', trusted: [] }, ADMIN, unknown), 400, /That computer is not set up here\./);
  refused(() => r.mods.setApprovalPolicy('poldemo', withAck({ computer: PC, mode: 'session', trusted: ['sam'] }), ADMIN, unknown), 400, /That computer is not set up here\./);
  assert.deepStrictEqual(r.policy(), []);
  assert.deepStrictEqual(r.audit(), []);
  // a computer that is gone but still has entries: asking more (back to every session, nobody trusted) is saved
  r.set(withAck({ computer: PC, mode: 'day', trusted: ['sam', 'helper'] }));
  assert.strictEqual(r.mods.setApprovalPolicy('poldemo', { computer: PC, mode: 'day', trusted: ['sam'] }, ADMIN_NO_STEP, unknown).changed, true, 'tightening');
  assert.strictEqual(r.mods.setApprovalPolicy('poldemo', { computer: PC, mode: 'session', trusted: [] }, ADMIN_NO_STEP, unknown).changed, true, 'cleared');
  assert.deepStrictEqual(r.policy(), []);
});

test('setApprovalPolicy: a computer that is known, or whose list could not be read (computerKnown true / null / absent), goes on to the normal step-up rules', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const loosen = { computer: PC, mode: 'day', trusted: ['sam'] };
  for (const opts of [{ computerKnown: null }, { computerKnown: true }, {}, undefined]) {
    let e = null;
    try { r.mods.setApprovalPolicy('poldemo', loosen, ADMIN, opts); } catch (x) { e = x; }
    assert.ok(e && e.status === 409 && e.needsAck === true && e.needsStepUp === true, JSON.stringify(opts));
  }
  assert.strictEqual(r.mods.setApprovalPolicy('poldemo', withAck(loosen), ADMIN, { computerKnown: null }).changed, true, 'unreadable list: saved by id with the acknowledgement and the password');
});

const ACT = { owner: { level: 'look', askEachSession: true }, helper: { level: 'act', askEachSession: true }, sam: { level: 'act', askEachSession: true } };
const policyPushes = (r) => r.pushes.filter(p => p.title === 'Remote computer approvals changed');

test('setAgentPermissions: entries that go are recorded as policyRemoved and admins get one notice naming the agents and the computers', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish(['sam', 'helper']);
  r.mods.setAgentPermissions('poldemo', { agents: ['helper', 'sam'], permissions: ACT }, ADMIN);
  r.set(withAck({ computer: PC, mode: 'day', trusted: ['sam', 'helper'] }));
  r.set(withAck({ computer: PC2, mode: 'session', trusted: ['sam'] }));
  const n0 = r.pushes.length, a0 = r.audit().length;
  r.mods.setAgentPermissions('poldemo', { agents: ['helper'], permissions: { owner: ACT.owner, helper: ACT.helper } }, ADMIN);   // sam is revoked
  const recs = r.audit().slice(a0).filter(x => x.action === 'permissions');
  assert.ok(recs.length >= 2);
  for (const x of recs) assert.deepStrictEqual([...x.policyRemoved].sort(), [`${PC}:trust:sam`, `${PC2}:trust:sam`].sort());
  const sent = r.pushes.slice(n0);
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0], { title: 'Remote computer approvals changed', body: 'Jo: sam will be asked again on 2 computers.', url: '/modules#poldemo' });
  // one computer, one agent, set to Look
  const n1 = r.pushes.length;
  r.mods.setAgentPermissions('poldemo', { agents: ['helper'], permissions: { owner: ACT.owner, helper: { level: 'look', askEachSession: true } } }, ADMIN);
  assert.strictEqual(r.pushes[n1].body, 'Jo: helper will be asked again on 1 computer.');
  assert.deepStrictEqual(r.audit().filter(x => x.action === 'permissions').at(-1).policyRemoved, [`${PC}:trust:helper`]);
});

test('setAgentPermissions: no policyRemoved and no policy notice when no entry goes', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish(['sam', 'helper']);
  r.set(withAck({ computer: PC, mode: 'day', trusted: ['sam'] }));
  const before = policyPushes(r).length, a0 = r.audit().length;
  r.mods.setAgentPermissions('poldemo', { agents: ['helper', 'sam'], permissions: ACT }, ADMIN);   // both are raised to Act; sam's entry stays
  assert.ok(r.audit().slice(a0).filter(x => x.action === 'permissions').length >= 2);
  assert.ok(r.audit().slice(a0).filter(x => x.action === 'permissions').every(x => !('policyRemoved' in x)));
  assert.strictEqual(policyPushes(r).length, before);
});

test('setAgentPermissions: the same save that turns asking off keeps its own notice too; a failing push undoes nothing', async (t) => {
  const r = rig({ pushThrows: true }); t.after(r.cleanup);
  await r.finish(['sam', 'helper']);
  r.mods.setAgentPermissions('poldemo', { agents: ['helper', 'sam'], permissions: ACT }, ADMIN);
  r.set(withAck({ computer: PC, mode: 'session', trusted: ['sam'] }));
  const n0 = r.pushes.length;
  const perms = { owner: ACT.owner, helper: { level: 'act', askEachSession: false }, sam: { level: 'look', askEachSession: true } };   // helper not asked, sam to Look
  const out = r.mods.setAgentPermissions('poldemo', { agents: ['helper', 'sam'], permissions: perms, acknowledged: true }, ADMIN);
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual(r.pushes.slice(n0).map(p => p.title).sort(), ['An agent can now work without asking', 'Remote computer approvals changed']);
  assert.ok(!r.policy().some(e => e.endsWith(':trust:sam')), 'saved although the notices threw');
  assert.strictEqual(r.audit().filter(x => x.action === 'permissions').at(-1).state, 'done');
});

test('forgetPermissions (setAgents, forgetAgentPermissions): a log line says which agents lose "don\'t ask" and on how many computers', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish(['sam', 'helper']);
  r.set(withAck({ computer: PC, mode: 'session', trusted: ['sam', 'helper'] }));
  r.set(withAck({ computer: PC2, mode: 'session', trusted: ['sam'] }));
  r.mods.setAgents('poldemo', ['helper']);   // sam loses the module
  assert.ok(r.logs.includes('poldemo: approval policy: sam lose "don\'t ask" on 2 computer(s) (access changed)'), r.logs.join('\n'));
  r.mods.forgetAgentPermissions(['helper']);
  assert.ok(r.logs.includes('poldemo: approval policy: helper lose "don\'t ask" on 1 computer(s) (access changed)'), r.logs.join('\n'));
  const before = r.logs.filter(l => l.includes('approval policy:')).length;
  r.mods.forgetAgentPermissions(['scout']);
  assert.strictEqual(r.logs.filter(l => l.includes('approval policy:')).length, before, 'nothing went: no line');
});
