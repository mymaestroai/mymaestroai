'use strict';
// Module permissions (a level, "start without asking") are kept by agent NAME. These tests run the real lifecycle calls of lib/agents.js
// (create, clone, addAgentEntries, delete, rename, lead/owner changes) and lib/auth.js (role, disabled, delete) in a copy of lib/ in a temp
// "hub" dir, wired to a real createModules over fake connectors, and prove that a name or standing that changes hands never inherits an old
// level or no-ask entry, that unrelated edits keep them, and that a failed clearing stops the change. Also: the two index.js ordering rules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REAL_ROOT = path.join(__dirname, '..');
const roots = [];
const saved = { mem: process.env.HUB_MEMORY_DB, auth: process.env.HUB_AUTH_DIR };
test.after(() => {
  for (const [k, v] of [['HUB_MEMORY_DB', saved.mem], ['HUB_AUTH_DIR', saved.auth]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const LEVELS = { setting: 'levels', choices: ['look', 'act', 'drive'], default: 'look', sessionApproval: { setting: 'no_ask_agents', levels: ['act', 'drive'] } };
const MANIFEST = {
  id: 'levdemo', name: 'Levels demo', category: 'Test', summary: 'Levels', risk: 'read',
  server: { type: 'mcp-stdio', script: 'server.js' },
  settings: [
    { key: 'levels', type: 'list', label: 'Levels', default: ['owner:look'], pattern: '^[a-z][a-z0-9_-]{0,63}:(look|act|drive)$' },
    { key: 'no_ask_agents', type: 'list', label: 'No ask', default: [] },
    { key: 'note', type: 'string', label: 'Note', default: 'x' },
  ],
  tools: { ping: 'read' }, levels: LEVELS,
};
const SETUP = { steps: [
  { id: 'install', type: 'install', title: 'Install' },
  { id: 'agents', type: 'grant', title: 'Agents' },
  { id: 'done', type: 'finish', title: 'Done' },
] };
const PW = 'correct horse battery staple';
const perm = (level, ask = true) => ({ level, askEachSession: ask });
const ADMIN = { adminBrowser: true, userId: 'u_admin', name: 'Jo' };

/** A temp hub with a copy of lib/, a real createModules over fake connectors, and the lifecycle hooks of agents.js and auth.js pointed at it. */
async function hub({ agents = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-lifecycle-'));
  roots.push(root);
  const hubDir = path.join(root, 'hub');
  fs.mkdirSync(path.join(root, 'share'));
  fs.cpSync(path.join(REAL_ROOT, 'lib'), path.join(hubDir, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, 'package.json'), path.join(hubDir, 'package.json'));
  fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(hubDir, 'node_modules'));
  const data = path.join(hubDir, 'data');
  fs.mkdirSync(data, { recursive: true });
  process.env.HUB_MEMORY_DB = path.join(data, 'memory.db');
  process.env.HUB_AUTH_DIR = data;
  const gw = new Module(path.join(hubDir, 'lib', 'gateway-client.js'));
  gw.filename = gw.id; gw.loaded = true;
  gw.exports = { listModels: async () => ['claude-sdk/x'], chatCompletion: async () => { throw new Error('no model here'); } };
  require.cache[gw.id] = gw;

  const ag = require(path.join(hubDir, 'lib', 'agents.js'));
  ag.__archive.configure({ sandbox: () => ({ retire: async () => ({ result: 'no Docker here' }), remove: async () => {} }), isBoxed: () => false, log: () => {} });
  const modsLib = require(path.join(hubDir, 'lib', 'modules', 'index.js'));

  // the module, with fake connectors (no processes)
  const modRoot = path.join(root, 'modules-root');
  fs.mkdirSync(path.join(modRoot, 'levdemo'), { recursive: true });
  fs.writeFileSync(path.join(modRoot, 'levdemo', 'module.json'), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(modRoot, 'levdemo', 'setup.json'), JSON.stringify(SETUP));
  fs.writeFileSync(path.join(modRoot, 'levdemo', 'server.js'), '// not run\n');
  const conns = new Map(); const stopped = []; const order = [];
  const stateFile = path.join(root, 'modules.json');
  const fail = { upsert: false };
  const connectors = {
    list: () => ({ connectors: [...conns.values()].map(c => ({ ...c, secretNames: [] })) }),
    upsert: (spec) => {
      if (fail.upsert && spec.agents) throw new Error('connector store is read-only');
      if (spec.agents) order.push({ upsert: spec.agents.slice(), stateAtThatTime: stateOnDisk() });
      const c = { agents: [], enabled: false, ...(conns.get(spec.id) || {}), ...spec }; conns.set(spec.id, c); return c;
    },
    stop: (id) => stopped.push(id), remove: (id) => conns.delete(id), readSecrets: () => ({}),
  };
  const stateOnDisk = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')).modules.levdemo.settings || {}; } catch { return {}; } };

  // accounts: the real auth of the copy, with the clearing hook pointed at the module store
  const authLib = require(path.join(hubDir, 'lib', 'auth.js'));
  let hook = (names) => mods.forgetAgentPermissions(names);   // swapped by the failure tests
  const auth = authLib.getAuth({ dataDir: data, log: () => {}, forgetPermissions: (names) => hook(names) });
  const admin1 = auth.createUser({ login: 'one@example.com', role: 'admin', password: PW }).user;
  const admin2 = auth.createUser({ login: 'two@example.com', role: 'admin', password: PW }).user;
  const member = auth.createUser({ login: 'mem@example.com', role: 'member', password: PW }).user;
  const adminIds = () => new Set(auth.admins().map(u => String(u.id)));

  fs.writeFileSync(path.join(data, 'agents.json'), JSON.stringify(agents.map(a => ({ ...a, owner: a.owner === 'admin1' ? admin1.id : a.owner === 'admin2' ? admin2.id : a.owner === 'member' ? member.id : a.owner }))));
  const mods = modsLib.createModules({
    root: modRoot, dataDir: path.join(root, 'moddata'), stateFile, connectorsFile: path.join(root, 'connectors.json'), connectors,
    isMemberOwned: (a) => !!(a && a.owner && !adminIds().has(String(a.owner))), isVirtual: () => false, isAdminUser: (u) => u === 'u_admin',
    listAgents: () => ag.getAgentsSync(true), publish: () => {}, log: () => {}, auditFile: path.join(root, 'connector-access.jsonl'), pushAdmins: () => Promise.resolve(),
  });
  ag.__permissions.configure((names) => hook(names));
  await mods.runStep('levdemo', 'install', {}); await mods.runStep('levdemo', 'agents', { agents: [] }); await mods.runStep('levdemo', 'done', {});

  const list = () => JSON.parse(fs.readFileSync(path.join(data, 'agents.json'), 'utf8'));
  const entry = (n) => list().find(a => a.name === n);
  // What the editor does for the module: every agent that can use it, with the given settings.
  const edit = (permissions, grants = [], extra = {}) => mods.setAgentPermissions('levdemo', { agents: grants, permissions, ...extra }, ADMIN);
  const policy = () => stateOnDisk();
  const row = (n) => mods.detail('levdemo').permissions.agents.find(a => a.name === n);
  const entriesOf = (n) => ({ levels: (policy().levels || []).filter(e => e.split(':')[0] === n), noAsk: (policy().no_ask_agents || []).filter(e => e === n) });
  const plant = (levels, noAsk) => {
    const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    j.modules.levdemo.settings = { ...(j.modules.levdemo.settings || {}), levels: [...(j.modules.levdemo.settings || {}).levels || [], ...levels], no_ask_agents: [...((j.modules.levdemo.settings || {}).no_ask_agents || []), ...noAsk] };
    fs.writeFileSync(stateFile, JSON.stringify(j));
  };
  const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
  return { ag, auth, authLib, mods, conns, stopped, order, fail, root, data, admin1, admin2, member, list, entry, edit, policy, row, entriesOf, plant, quiet, setHook: (fn) => { hook = fn; }, stateFile };
}

// An admin-owned lead that has been told "drive, without asking".
async function noAskLead(h, name = 'bob') {
  h.edit({ [name]: perm('drive', false) }, [], { acknowledged: true });
  assert.deepStrictEqual(h.entriesOf(name), { levels: [`${name}:drive`], noAsk: [name] });
  assert.strictEqual(h.row(name).askEachSession, false);
}

test('delete then create the same name: the new lead is asked at the default level', async () => {
  const h = await hub({ agents: [{ name: 'bob', model: 'm', lead: true, owner: 'admin1' }] });
  await noAskLead(h);
  const r = await h.ag.deleteAgent('bob'); assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.deepStrictEqual(h.entriesOf('bob'), { levels: [], noAsk: [] }, 'cleared when the agent was deleted');
  // an old store (before this change) may still hold the entries of a deleted agent: creating the name clears them too
  h.plant(['bob:drive'], ['bob']);
  const c = await h.quiet(() => h.ag.createAgent('bob', 'm', null, null, null, h.admin1.id)); assert.strictEqual(c.success, true, JSON.stringify(c));
  assert.deepStrictEqual(h.entriesOf('bob'), { levels: [], noAsk: [] });
  assert.strictEqual((await h.ag.updateAgentField('bob', { lead: true })).success, true);
  assert.strictEqual(h.row('bob').askEachSession, true); assert.strictEqual(h.row('bob').level, 'look');
  assert.ok(!h.mods.detail('levdemo').permissions.runsWithoutAsking.includes('bob'));
});

test('rename: the old name frees nothing to inherit, and renaming into a name with stale entries starts that name over', async () => {
  const h = await hub({ agents: [{ name: 'bob', model: 'm', lead: true, owner: 'admin1' }, { name: 'ann', model: 'm', owner: 'admin1' }] });
  await noAskLead(h, 'bob');
  h.plant(['zed:act'], ['zed']);   // left behind by an earlier agent named zed
  const r = await h.quiet(() => h.ag.renameAgent('bob', 'zed')); assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.deepStrictEqual(h.entriesOf('bob'), { levels: [], noAsk: [] });
  assert.deepStrictEqual(h.entriesOf('zed'), { levels: [], noAsk: [] });
  assert.strictEqual(h.row('zed').askEachSession, true); assert.strictEqual(h.row('zed').level, 'look');
  // the name bob is free: a new lead bob does not get bob's old choice back
  const c = await h.quiet(() => h.ag.createAgent('bob', 'm', null, null, null, h.admin1.id)); assert.strictEqual(c.success, true);
  await h.ag.updateAgentField('bob', { lead: true });
  assert.strictEqual(h.row('bob').askEachSession, true);
});

test('clone and addAgentEntries into a name with stale entries clear them', async () => {
  const h = await hub({ agents: [{ name: 'bob', model: 'm', lead: true, owner: 'admin1' }] });
  h.plant(['cl:drive', 'tm:act'], ['cl', 'tm', 'bob']);
  const c = await h.quiet(() => h.ag.cloneAgent('bob', 'cl')); assert.strictEqual(c.success, true, JSON.stringify(c));
  assert.deepStrictEqual(h.entriesOf('cl'), { levels: [], noAsk: [] });
  assert.deepStrictEqual(h.entriesOf('tm'), { levels: ['tm:act'], noAsk: ['tm'] }, 'other names are left alone');
  assert.deepStrictEqual(h.ag.addAgentEntries([{ name: 'tm', model: 'm', lead: true, owner: h.admin1.id }]), ['tm']);
  assert.deepStrictEqual(h.entriesOf('tm'), { levels: [], noAsk: [] });
  assert.deepStrictEqual(h.entriesOf('bob').noAsk, ['bob'], 'an unrelated agent keeps its entries');
  assert.strictEqual(h.row('tm').askEachSession, true);
});

test('lead flag toggled either way cannot revive a no-ask entry', async () => {
  const h = await hub({ agents: [{ name: 'bob', model: 'm', lead: true, owner: 'admin1' }, { name: 'ann', model: 'm', owner: 'admin1' }] });
  // ann is a plain grant with a stale/previous no-ask choice, then is made a lead
  h.mods.setAgents('levdemo', ['ann']);
  h.edit({ bob: perm('look'), ann: perm('drive', false) }, ['ann'], { acknowledged: true });
  assert.strictEqual(h.row('ann').askEachSession, false);
  await h.ag.updateAgentField('ann', { lead: true });
  assert.deepStrictEqual(h.entriesOf('ann'), { levels: [], noAsk: [] }, 'false -> true');
  assert.strictEqual(h.row('ann').askEachSession, true);
  h.edit({ bob: perm('look'), ann: perm('drive', false) }, [], { acknowledged: true });
  await h.ag.updateAgentField('ann', { lead: false });
  assert.deepStrictEqual(h.entriesOf('ann'), { levels: [], noAsk: [] }, 'true -> false');
  h.plant(['ann:drive'], ['ann']);   // an entry that survived by any other route
  await h.ag.updateAgentField('ann', { lead: true });
  assert.deepStrictEqual(h.entriesOf('ann'), { levels: [], noAsk: [] }, 'and back to true');
  assert.strictEqual(h.row('ann').askEachSession, true);
});

test('owner admin -> member -> admin cannot revive it; an agent handed to a member loses it at once', async () => {
  const h = await hub({ agents: [{ name: 'bob', model: 'm', lead: true, owner: 'admin1' }] });
  await noAskLead(h);
  const stopsBefore = h.stopped.length;
  await h.ag.updateAgentField('bob', { owner: h.member.id });
  assert.deepStrictEqual(h.entriesOf('bob'), { levels: [], noAsk: [] });
  assert.ok(h.stopped.length > stopsBefore, 'the connector was restarted, so no approved session survives');
  h.plant(['bob:drive'], ['bob']);
  await h.ag.updateAgentField('bob', { owner: h.admin2.id });   // back to an admin
  assert.deepStrictEqual(h.entriesOf('bob'), { levels: [], noAsk: [] });
  assert.strictEqual(h.row('bob').askEachSession, true);
  await noAskLead(h);
  await h.ag.updateAgentField('bob', { owner: null });   // infrastructure
  assert.deepStrictEqual(h.entriesOf('bob'), { levels: [], noAsk: [] });
});

test('the owner account: demoted, disabled or deleted loses it for its agents; promoted again it does not come back', async () => {
  const h = await hub({ agents: [{ name: 'bob', model: 'm', lead: true, owner: 'admin1' }, { name: 'sue', model: 'm', lead: true, owner: 'admin2' }] });
  h.edit({ bob: perm('drive', false), sue: perm('drive', false) }, [], { acknowledged: true });
  assert.strictEqual(h.auth.updateUser(h.admin1.id, { role: 'member' }).ok, true);
  assert.deepStrictEqual(h.entriesOf('bob'), { levels: [], noAsk: [] }, 'demoted');
  assert.deepStrictEqual(h.entriesOf('sue').noAsk, ['sue'], 'another account is untouched');
  h.plant(['bob:drive'], ['bob']);   // anything that survived by another route
  assert.strictEqual(h.auth.updateUser(h.admin1.id, { role: 'admin' }).ok, true);
  assert.deepStrictEqual(h.entriesOf('bob'), { levels: [], noAsk: [] }, 'promoted again');
  assert.strictEqual(h.row('bob').askEachSession, true);
  h.edit({ bob: perm('drive', false), sue: perm('drive', false) }, [], { acknowledged: true });
  assert.strictEqual(h.auth.updateUser(h.admin1.id, { disabled: true }).ok, true);
  assert.deepStrictEqual(h.entriesOf('bob'), { levels: [], noAsk: [] }, 'disabled');
  h.plant(['bob:drive'], ['bob']);
  assert.strictEqual(h.auth.updateUser(h.admin1.id, { disabled: false }).ok, true);
  assert.deepStrictEqual(h.entriesOf('bob'), { levels: [], noAsk: [] }, 're-enabled');
  h.plant(['bob:act'], ['bob']);
  assert.strictEqual(h.auth.deleteUser(h.admin1.id).ok, true);
  assert.deepStrictEqual(h.entriesOf('bob'), { levels: [], noAsk: [] }, 'deleted');
});

test('unrelated edits keep the permissions: other fields, the same lead/owner, a name, a role that does not change', async () => {
  const h = await hub({ agents: [{ name: 'bob', model: 'm', lead: true, owner: 'admin1' }] });
  await noAskLead(h);
  const same = JSON.stringify(h.policy());
  const stops = h.stopped.length;
  await h.ag.updateAgentField('bob', { blurb: 'hello', category: 'primary', sharedWith: ['u_x'], effort: 'high' });
  await h.ag.updateAgentField('bob', { lead: true, owner: h.admin1.id });   // the same values
  assert.strictEqual((await h.ag.setAgentDisplay('bob', 'Bobby')).success, true);
  assert.strictEqual(h.auth.updateUser(h.admin1.id, { name: 'Renamed' }).ok, true);
  assert.strictEqual(h.auth.updateUser(h.admin1.id, { role: 'admin', disabled: false }).ok, true);   // nothing changes
  assert.strictEqual(JSON.stringify(h.policy()), same);
  assert.strictEqual(h.stopped.length, stops, 'no restart either');
  assert.strictEqual(h.row('bob').askEachSession, false);
  // creating a different agent does not touch bob either
  assert.strictEqual((await h.quiet(() => h.ag.createAgent('other', 'm', null, null, null, h.admin1.id))).success, true);
  assert.strictEqual(JSON.stringify(h.policy()), same);
});

test('failed clearing stops the change: create, clone, add, delete, rename, lead, owner, role, disabled and account delete', async () => {
  const h = await hub({ agents: [{ name: 'bob', model: 'm', lead: true, owner: 'admin1' }, { name: 'ann', model: 'm', owner: 'admin1' }] });
  await noAskLead(h);
  h.plant(['kim:act'], ['kim']);
  const calls = [];
  h.setHook((names) => { calls.push(names); throw new Error('state is read-only'); });
  const names = () => h.list().map(a => a.name).sort();
  const before = JSON.stringify(h.list());
  const wsOf = (n) => path.join(h.root, 'hub', 'workspaces', n);
  const err = async (p) => (await p).error || '';
  assert.match(await err(h.quiet(() => h.ag.createAgent('kim', 'm', null, null, null, h.admin1.id))), /module permissions/);
  assert.match(await err(h.quiet(() => h.ag.cloneAgent('bob', 'kim'))), /module permissions/);
  assert.throws(() => h.ag.addAgentEntries([{ name: 'kim', model: 'm' }]), /read-only/);
  assert.match(await err(h.ag.deleteAgent('bob')), /Nothing was deleted/);
  assert.match(await err(h.quiet(() => h.ag.renameAgent('bob', 'kim'))), /Nothing was renamed/);
  assert.match(await err(h.ag.updateAgentField('ann', { lead: true })), /module permissions/);
  assert.match(await err(h.ag.updateAgentField('bob', { owner: h.member.id })), /module permissions/);
  assert.strictEqual(JSON.stringify(h.list()), before, 'the agent list is exactly as it was');
  assert.deepStrictEqual(names(), ['ann', 'bob']);
  assert.ok(!fs.existsSync(wsOf('kim')), 'no folder was made');
  assert.ok(calls.length >= 7);
  for (const patch of [{ role: 'member' }, { disabled: true }]) {
    const r = h.auth.updateUser(h.admin1.id, patch);
    assert.strictEqual(r.ok, false); assert.match(r.error, /Nothing was changed/);
  }
  assert.strictEqual(h.auth.getUser(h.admin1.id).role, 'admin'); assert.ok(!h.auth.getUser(h.admin1.id).disabled);
  assert.match(h.auth.deleteUser(h.admin1.id).error, /Nothing was deleted/);
  assert.ok(h.auth.getUser(h.admin1.id));
  assert.deepStrictEqual(h.entriesOf('bob').noAsk, ['bob'], 'the entries are not touched either');
  // the real failure: the module store cannot be written
  h.setHook((n) => h.mods.forgetAgentPermissions(n));
  const real = fs.renameSync;
  fs.renameSync = (from, to, ...a) => { if (String(to) === h.stateFile) throw new Error('disk full'); return real(from, to, ...a); };
  try {
    assert.match(await err(h.quiet(() => h.ag.createAgent('kim', 'm', null, null, null, h.admin1.id))), /disk full/);
    assert.match(await err(h.ag.deleteAgent('bob')), /disk full/);
    assert.strictEqual(h.auth.updateUser(h.admin1.id, { role: 'member' }).ok, false);
    assert.strictEqual((await h.ag.updateAgentField('bob', { lead: false })).success, false);
  } finally { fs.renameSync = real; }
  assert.deepStrictEqual(names(), ['ann', 'bob']); assert.strictEqual(h.entry('bob').lead, true);
  // and once the store works the same change goes through
  assert.strictEqual((await h.ag.deleteAgent('bob')).success, true);
  assert.deepStrictEqual(h.entriesOf('bob'), { levels: [], noAsk: [] });
});

test('generic grant: a newly granted agent loses its stale level as well as its stale no-ask entry', async () => {
  const h = await hub({ agents: [{ name: 'bob', model: 'm', lead: true, owner: 'admin1' }, { name: 'ann', model: 'm', owner: 'admin1' }] });
  h.plant(['ann:drive'], ['ann']);
  h.mods.setAgents('levdemo', ['ann']);
  assert.deepStrictEqual(h.entriesOf('ann'), { levels: [], noAsk: [] });
  assert.strictEqual(h.row('ann').level, 'look'); assert.strictEqual(h.row('ann').askEachSession, true);
  // an already granted agent keeps what the editor gave it when the list is saved again
  h.edit({ bob: perm('look'), ann: perm('act', false) }, ['ann'], { acknowledged: true });
  h.mods.setAgents('levdemo', ['ann']);
  assert.deepStrictEqual(h.entriesOf('ann'), { levels: ['ann:act'], noAsk: ['ann'] });
});

test('setAgentPermissions saves the protected policy BEFORE it publishes grants, and a failure never goes back to the looser state', async () => {
  const h = await hub({ agents: [{ name: 'bob', model: 'm', lead: true, owner: 'admin1' }, { name: 'ann', model: 'm', owner: 'admin1' }, { name: 'sam', model: 'm', owner: 'admin1' }] });
  h.mods.setAgents('levdemo', ['sam']);
  h.edit({ bob: perm('look'), sam: perm('drive', false) }, ['sam'], { acknowledged: true });
  h.plant(['ann:drive'], ['ann']);   // stale entries for ann, who is about to be given the module
  h.order.length = 0;
  h.edit({ bob: perm('look'), sam: perm('drive', false), ann: perm('look') }, ['sam', 'ann'], { acknowledged: true });
  assert.strictEqual(h.order.length, 1);
  assert.deepStrictEqual(h.order[0].upsert.slice().sort(), ['ann', 'sam']);
  assert.deepStrictEqual(h.order[0].stateAtThatTime.no_ask_agents.slice().sort(), ['sam'], 'when the grant was published the stale no-ask entry was already gone');
  assert.ok(!h.order[0].stateAtThatTime.levels.includes('ann:drive'));
  assert.ok(h.order[0].stateAtThatTime.levels.includes('ann:look'));

  // the policy write fails: nothing is published and nothing changed
  h.order.length = 0;
  const real = fs.renameSync;
  fs.renameSync = (from, to, ...a) => { if (String(to) === h.stateFile) throw new Error('disk full'); return real(from, to, ...a); };
  try { assert.throws(() => h.edit({ bob: perm('look'), sam: perm('drive', false) }, ['sam']), /disk full/); } finally { fs.renameSync = real; }
  assert.deepStrictEqual(h.order, [], 'no grant was published');
  assert.deepStrictEqual(h.conns.get('levdemo').agents.slice().sort(), ['ann', 'sam']);

  // the grant publish fails after the policy was saved: the stricter policy stays (ann's entries are gone with her grant), the connector restarts, the error is reported and audited
  const stops = h.stopped.length;
  h.fail.upsert = true;
  assert.throws(() => h.edit({ bob: perm('look'), sam: perm('drive', false) }, ['sam']), /read-only/);
  h.fail.upsert = false;
  assert.deepStrictEqual(h.entriesOf('ann'), { levels: [], noAsk: [] }, 'not rolled back to the looser state');
  assert.deepStrictEqual(h.conns.get('levdemo').agents.slice().sort(), ['ann', 'sam']);
  assert.ok(h.stopped.length > stops, 'sessions approved under the old policy end');
  const log = fs.readFileSync(path.join(h.root, 'connector-access.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(log.pop().state, 'failed');
});
