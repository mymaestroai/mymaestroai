'use strict';
// Agent levels in a module manifest (levels: { setting, choices, default, sessionApproval }), the permission editor
// (setAgentPermissions), the protected settings, the status summary and the backup restore rule. Fake connectors, no processes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const manifestLib = require('../lib/modules/manifest');
const { createModules } = require('../lib/modules');

const LEVELS = { setting: 'levels', choices: ['look', 'act', 'drive'], default: 'look', sessionApproval: { setting: 'no_ask_agents', levels: ['act', 'drive'] } };
const baseManifest = () => ({
  id: 'levdemo', name: 'Levels demo', category: 'Test', summary: 'Levels', risk: 'read',
  server: { type: 'mcp-stdio', script: 'server.js' },
  settings: [
    { key: 'levels', type: 'list', label: 'Levels', default: ['owner:look'], pattern: '^[a-z][a-z0-9_-]{0,63}:(look|act|drive)$' },
    { key: 'no_ask_agents', type: 'list', label: 'No ask', default: [] },
    { key: 'note', type: 'string', label: 'Note', default: 'x' },
  ],
  tools: { ping: 'read' }, levels: LEVELS,
});
const probs = (m) => manifestLib.validateManifest(m, 'levdemo').problems.join(' | ');
const SETUP = { steps: [
  { id: 'install', type: 'install', title: 'Install' },
  { id: 'limits', type: 'settings', title: 'Limits', fields: ['note'], optional: true },
  { id: 'agents', type: 'grant', title: 'Agents' },
  { id: 'done', type: 'finish', title: 'Done' },
] };
const AGENTS = [{ name: 'owner', lead: true }, { name: 'sam' }, { name: 'ann' }, { name: 'kid', owner: 'u_member' }, { name: 'tw-1' }];
const ADMIN = { adminBrowser: true, userId: 'u_admin', name: 'Jo' };

function rig({ manifest = baseManifest(), agents = AGENTS, withLevels = true, wallet = () => false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-lev-'));
  const root = path.join(dir, 'root'); fs.mkdirSync(path.join(root, 'levdemo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'levdemo', 'module.json'), JSON.stringify(withLevels ? manifest : { ...manifest, levels: undefined }));
  fs.writeFileSync(path.join(root, 'levdemo', 'setup.json'), JSON.stringify(SETUP));
  fs.writeFileSync(path.join(root, 'levdemo', 'server.js'), '// not run\n');
  const conns = new Map(); const stopped = []; const pushes = [];
  const connectors = {
    list: () => ({ connectors: [...conns.values()].map(c => ({ ...c, secretNames: [] })) }),
    upsert: (spec) => { const c = { agents: [], enabled: false, ...(conns.get(spec.id) || {}), ...spec }; conns.set(spec.id, c); return c; },
    stop: (id) => stopped.push(id), remove: (id) => conns.delete(id), readSecrets: () => ({}),
  };
  const auditFile = path.join(dir, 'connector-access.jsonl');
  const mods = createModules({
    root, dataDir: path.join(dir, 'modules'), stateFile: path.join(dir, 'modules.json'), connectorsFile: path.join(dir, 'connectors.json'), connectors,
    isWalletAgent: wallet, isMemberOwned: (a) => a.owner === 'u_member', isVirtual: (n) => n.startsWith('tw-'), isAdminUser: (u) => u === 'u_admin',
    listAgents: () => agents, publish: () => {}, log: () => {}, auditFile, pushAdmins: (p) => { pushes.push(p); return Promise.resolve(); },
  });
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'modules.json'), 'utf8')).modules.levdemo;
  const audit = () => { try { return fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  const finish = async (grant = ['sam', 'ann']) => { await mods.runStep('levdemo', 'install', {}); await mods.runStep('levdemo', 'agents', { agents: grant }); await mods.runStep('levdemo', 'done', {}); };
  return { dir, root, mods, conns, stopped, pushes, state, audit, finish, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const perm = (level, ask = true) => ({ level, askEachSession: ask });
// What the page sends: agents = the granted agents that are not locked leads, permissions = every agent that can use the module (locked leads included), `edited` laid over what is saved now.
const save = (r, edited, permissions, extra = {}, who = ADMIN) => {
  const d = r.mods.detail('levdemo');
  if (!d.permissions) return r.mods.setAgentPermissions('levdemo', { agents: edited, permissions, ...extra }, who);
  const leadsLocked = d.leadsAlways ? new Set(d.leads) : new Set();
  const rows = d.permissions.agents.filter(a => a.allowed);
  const grants = new Set([...rows.map(a => a.name), ...edited].filter(n => !leadsLocked.has(n)));
  const perms = {};
  for (const a of rows) perms[a.name] = { level: a.level, askEachSession: a.askEachSession };
  for (const n of Object.keys(permissions)) perms[n] = permissions[n];
  for (const n of Object.keys(perms)) if (!grants.has(n) && !leadsLocked.has(n)) delete perms[n];
  return r.mods.setAgentPermissions('levdemo', { agents: [...grants], permissions: perms, ...extra }, who);
};
const raw = (r, input, who = ADMIN) => r.mods.setAgentPermissions('levdemo', input, who);

// ── manifest ──
test('manifest levels: a good block is valid; each bad shape and backing setting is reported', () => {
  assert.strictEqual(probs(baseManifest()), '');
  assert.strictEqual(probs({ ...baseManifest(), levels: { ...LEVELS, sessionApproval: undefined } }), '', 'sessionApproval is optional');
  const bad = (levels, re) => assert.match(probs({ ...baseManifest(), levels }), re, JSON.stringify(levels));
  bad('x', /levels must be an object/);
  bad({ ...LEVELS, extra: 1 }, /levels\.extra: unknown field/);
  bad({ ...LEVELS, choices: ['look'] }, /levels\.choices/);
  bad({ ...LEVELS, choices: ['look', 'look'] }, /levels\.choices/);
  bad({ ...LEVELS, choices: ['look', 'Act'] }, /levels\.choices/);
  bad({ ...LEVELS, default: 'root' }, /levels\.default must be one of/);
  bad({ ...LEVELS, setting: 'nope' }, /levels\.setting: "nope" is not a declared setting/);
  bad({ ...LEVELS, setting: 'note' }, /setting note must be of type list/);
  bad({ ...LEVELS, sessionApproval: { setting: 'levels', levels: ['act'] } }, /must differ from levels\.setting/);
  bad({ ...LEVELS, sessionApproval: { setting: 'missing', levels: ['act'] } }, /sessionApproval\.setting: "missing" is not a declared setting/);
  bad({ ...LEVELS, sessionApproval: { setting: 'no_ask_agents', levels: [] } }, /sessionApproval\.levels/);
  bad({ ...LEVELS, sessionApproval: { setting: 'no_ask_agents', levels: ['root'] } }, /sessionApproval\.levels/);
  bad({ ...LEVELS, sessionApproval: { setting: 'no_ask_agents', levels: ['act'], more: 1 } }, /sessionApproval\.more: unknown field/);
  const m = baseManifest();
  m.settings[1].default = ['sam'];
  assert.match(probs(m), /must default to an empty list/);
  const m2 = baseManifest(); m2.settings[0].default = ['owner:root'];
  assert.match(probs(m2), /default entry "owner:root"/);
  const m3 = baseManifest(); m3.settings[1].type = 'string';
  assert.match(probs(m3), /must be of type list/);
});

test('manifest levels: a settings step cannot list a protected setting; a module without levels is unchanged', () => {
  const v = manifestLib.validateManifest(baseManifest(), 'levdemo');
  const sp = manifestLib.validateSetup({ steps: [{ id: 'a', type: 'settings', title: 'A', fields: ['no_ask_agents'] }, { id: 'b', type: 'finish', title: 'B' }] }, v).join(' | ');
  assert.match(sp, /no_ask_agents holds agent permissions/);
  const { levels, ...plain } = baseManifest();
  assert.strictEqual(manifestLib.validateManifest(plain, 'levdemo').problems.length, 0);
  assert.deepStrictEqual([...manifestLib.validateManifest(plain, 'levdemo').protectedKeys], []);
  assert.strictEqual(manifestLib.levelsOf(plain), null);
});

// ── defaults, exposure, status ──
test('default: every agent is asked at the default level; detail and summary expose the table', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  assert.deepStrictEqual(r.state().settings.no_ask_agents === undefined ? [] : r.state().settings.no_ask_agents, []);
  const d = r.mods.detail('levdemo');
  assert.deepStrictEqual(d.settings.no_ask_agents, []);
  assert.deepStrictEqual(d.permissions.choices, ['look', 'act', 'drive']);
  assert.deepStrictEqual(d.permissions.askLevels, ['act', 'drive']);
  const byName = Object.fromEntries(d.permissions.agents.map(a => [a.name, a]));
  assert.ok(!byName.kid && !byName['tw-1'], 'member and temporary agents are not listed');
  assert.strictEqual(byName.sam.level, 'look'); assert.strictEqual(byName.sam.askEachSession, true); assert.strictEqual(byName.sam.runsWithoutAsking, false);
  assert.strictEqual(byName.owner.lead, true); assert.strictEqual(byName.owner.level, 'look');
  assert.deepStrictEqual(d.permissions.runsWithoutAsking, []);
  assert.deepStrictEqual(r.mods.list().find(x => x.id === 'levdemo').runsWithoutAsking, []);
});

test('a module without levels: no permissions in detail or summary, the editor refuses it, generic saves work', async (t) => {
  const r = rig({ withLevels: false }); t.after(r.cleanup);
  await r.finish();
  assert.strictEqual('permissions' in r.mods.detail('levdemo'), false);
  assert.strictEqual('runsWithoutAsking' in r.mods.list()[0], false);
  assert.throws(() => save(r, ['sam'], { sam: perm('act') }), /no agent levels/);
  assert.strictEqual(r.mods.saveSettings('levdemo', { note: 'y', levels: 'sam:drive' }).settings.note, 'y');
  const out = await r.mods.runStep('levdemo', 'limits', { values: { note: 'z' } });
  assert.strictEqual(out.result.settings.note, 'z');
});

// ── the dedicated save ──
test('dedicated save: an admin sets levels and asking; unedited entries stay; the connector restarts; audit line written', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const out = save(r, ['sam'], { sam: perm('act', true) });
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual(r.state().settings.levels, ['owner:look', 'sam:act', 'ann:look'], 'every agent that can use the module is written, ann at the level she already had');
  assert.deepStrictEqual(r.state().settings.no_ask_agents, []);
  assert.ok(r.stopped.includes('levdemo'), 'connector restarted so sessions end');
  const stoppedBefore = r.stopped.length;
  save(r, ['ann'], { ann: perm('drive', true) });
  assert.deepStrictEqual(r.state().settings.levels, ['owner:look', 'sam:act', 'ann:drive'], 'sam was not edited and stays');
  assert.ok(r.stopped.length > stoppedBefore);
  const lines = r.audit();
  assert.deepStrictEqual(lines.map(l => l.state), ['requested', 'done', 'requested', 'done']);
  assert.strictEqual(lines[0].action, 'permissions'); assert.strictEqual(lines[0].by, 'Jo'); assert.strictEqual(lines[0].connector, 'levdemo');
  assert.strictEqual(r.pushes.length, 0, 'asking stayed on: no phone notice');
  // saving what is already there changes and logs nothing
  const n = r.audit().length;
  assert.strictEqual(save(r, ['sam'], { sam: perm('act', true) }).changed, false);
  assert.strictEqual(r.audit().length, n);
  // a lead can be edited; the lowest of duplicates counts as the module reads it
  assert.strictEqual(save(r, ['owner'], { owner: perm('act', true) }).changed, true);
});

test('dedicated save: legacy entries of agents not edited are kept; an unreadable stored list counts as its default', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const f = path.join(r.dir, 'modules.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  s.modules.levdemo.settings.levels = ['owner:look', 'old-agent:drive', 'sam:act'];
  fs.writeFileSync(f, JSON.stringify(s));
  save(r, ['sam'], { sam: perm('look') });
  assert.deepStrictEqual(r.state().settings.levels.slice().sort(), ['ann:look', 'old-agent:drive', 'owner:look', 'sam:look']);
  // one malformed entry makes the module read the default list; the save must not revive the rest
  s.modules.levdemo.settings.levels = ['sam:drive', 'garbage!!'];
  fs.writeFileSync(f, JSON.stringify(s));
  save(r, ['ann'], { ann: perm('act') });
  assert.deepStrictEqual(r.state().settings.levels.slice().sort(), ['ann:act', 'owner:look', 'sam:look']);
});

test('dedicated save: refused without trusted admin authority, whatever the body says', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const input = { agents: ['sam'], permissions: { sam: perm('drive', true) } };
  const call = (auth, inp = input) => r.mods.setAgentPermissions('levdemo', inp, auth);
  for (const bad of [undefined, null, {}, 'admin', { adminBrowser: true }, { adminBrowser: true, userId: '' }, { userId: 'u_admin' }, { adminBrowser: 'true', userId: 'u_admin' },
    { adminBrowser: true, userId: 'u_member' }, { adminBrowser: true, userId: 'u_admin' ? 'hub' : '' }, { hubService: true }, { hubToken: true, userId: 'u_admin' }, { admin: true, userId: 'u_admin' }]) {
    assert.throws(() => call(bad), (e) => e.status === 403, JSON.stringify(bad));
  }
  assert.throws(() => call(undefined, { ...input, userId: 'u_admin', adminBrowser: true }), (e) => e.status === 403, 'identity in the body is not trusted');
  assert.throws(() => r.mods.setAgentPermissions('levdemo', input), (e) => e.status === 403, 'no third argument');
  assert.deepStrictEqual(r.state().settings.levels === undefined ? ['owner:look'] : r.state().settings.levels, ['owner:look']);
  assert.strictEqual(r.audit().length, 0);
});

test('dedicated save: malformed input, unknown/member/virtual agents; nothing is written when any part is bad (atomic)', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const before = fs.readFileSync(path.join(r.dir, 'modules.json'), 'utf8');
  const bad = (input, re) => {
    assert.throws(() => r.mods.setAgentPermissions('levdemo', input, ADMIN), re, JSON.stringify(input));
    assert.strictEqual(fs.readFileSync(path.join(r.dir, 'modules.json'), 'utf8'), before, 'state untouched');
    assert.strictEqual(r.audit().length, 0); assert.strictEqual(r.stopped.length, 0); assert.strictEqual(r.pushes.length, 0);
  };
  bad(null, /Send/); bad([], /Send/); bad('x', /Send/);
  bad({ agents: 'sam', permissions: {} }, /agents must be/);
  bad({ agents: [1], permissions: {} }, /agents must be/);
  bad({ agents: ['a:b'], permissions: {} }, /agents must be/);
  bad({ agents: ['sa m'], permissions: {} }, /agents must be/);
  bad({ agents: Array.from({ length: 65 }, (_, i) => `a${i}`), permissions: {} }, /agents must be/);
  bad({ agents: ['sam', 'sam'], permissions: { sam: perm('act'), owner: perm('look') } }, /twice/);
  bad({ agents: ['sam'] }, /permissions must/);
  bad({ agents: ['sam'], permissions: [] }, /permissions must/);
  bad({ agents: ['sam'], permissions: {} }, /exactly one entry/);
  bad({ agents: [], permissions: {} }, /exactly one entry/);   // the locked lead is part of the set
  bad({ agents: ['sam'], permissions: { sam: perm('act') } }, /exactly one entry/);   // lead missing
  bad({ agents: ['sam'], permissions: { sam: perm('act'), owner: perm('look'), ann: perm('act') } }, /exactly one entry/);   // ann is not granted
  bad({ agents: ['sam'], permissions: { ann: perm('act'), owner: perm('look') } }, /exactly one entry/);
  const OK = { owner: perm('look') };
  bad({ agents: ['sam'], permissions: { ...OK, sam: 'act' } }, /give only level/);
  bad({ agents: ['sam'], permissions: { ...OK, sam: { level: 'act', askEachSession: true, extra: 1 } } }, /give only level/);
  bad({ agents: ['sam'], permissions: { ...OK, sam: { level: 'root', askEachSession: true } } }, /level must be one of/);
  bad({ agents: ['sam'], permissions: { ...OK, sam: { askEachSession: true } } }, /level must be one of/);
  bad({ agents: ['sam'], permissions: { ...OK, sam: { level: 'act' } } }, /askEachSession must be/);
  bad({ agents: ['sam'], permissions: { ...OK, sam: { level: 'act', askEachSession: 'false' } } }, /askEachSession must be/);
  bad({ agents: ['sam'], permissions: { ...OK, sam: perm('look', false) }, acknowledged: true }, /only asked at act and drive/);   // no dormant no-ask setting on a level with no question
  bad({ agents: [], permissions: { owner: perm('look', false) }, acknowledged: true }, /only asked at act and drive/);
  bad({ agents: ['sam'], permissions: { ...OK, sam: perm('act') }, acknowledged: 'yes' }, /acknowledged must be/);
  bad({ agents: ['sam'], permissions: { ...OK, sam: perm('act') }, role: 'admin' }, /Unknown field/);
  bad({ agents: ['ghost'], permissions: { ...OK, ghost: perm('act') } }, /ghost.*unknown/);
  bad({ agents: ['kid'], permissions: { ...OK, kid: perm('act') } }, /kid.*member/);
  bad({ agents: ['tw-1'], permissions: { ...OK, 'tw-1': perm('act') } }, /temporary worker/);
  // a member's or temporary lead is vetted too, even though leads are normally always allowed
  bad({ agents: ['kid', 'sam'], permissions: { ...OK, sam: perm('drive'), kid: perm('act') } }, /kid/);
  // the good one first, the bad one second: still nothing is written
  bad({ agents: ['sam', 'ghost'], permissions: { ...OK, sam: perm('drive'), ghost: perm('act') } }, /ghost/);
  bad({ agents: ['sam', 'kid'], permissions: { ...OK, sam: perm('drive'), kid: perm('act') } }, /kid/);
  // an unacknowledged no-ask on a new grant fails before the grant is written
  assert.throws(() => raw(r, { agents: ['sam'], permissions: { ...OK, sam: perm('act', false) } }), (e) => e.needsAck === true);
  assert.strictEqual(fs.readFileSync(path.join(r.dir, 'modules.json'), 'utf8'), before); assert.deepStrictEqual(r.conns.get('levdemo').agents, ['sam', 'ann']);
  const proto = JSON.parse('{"agents":["sam"],"permissions":{"__proto__":{"level":"drive","askEachSession":true}}}');
  bad(proto, /exactly one entry/);
  const lead = JSON.parse('{"agents":[],"permissions":{"owner":{"level":"look","askEachSession":true},"__proto__":{"level":"drive","askEachSession":true}}}');
  assert.ok(Object.keys(lead.permissions).length === 2);
  bad(lead, /exactly one entry/);
});

test('dedicated save: a money module takes wallet agents only; a lead needs eligibility and a grant like anyone else', async (t) => {
  const m = { ...baseManifest(), risk: 'money', tools: { buy: 'money' } };
  const wallets = new Set(['sam']);
  const r = rig({ manifest: m, wallet: (n) => wallets.has(n) }); t.after(r.cleanup);
  await r.mods.runStep('levdemo', 'install', {});
  // the lead is not always allowed here: nothing can use the module until it is granted
  assert.deepStrictEqual(r.mods.detail('levdemo').permissions.agents.filter(a => a.allowed), []);
  assert.deepStrictEqual(r.mods.detail('levdemo').permissions.runsWithoutAsking, []);
  assert.throws(() => raw(r, { agents: ['ann'], permissions: { ann: perm('act') } }), /wallet agent/);
  assert.throws(() => raw(r, { agents: ['owner'], permissions: { owner: perm('act') } }), (e) => e.status === 400 && /owner.*wallet agent/.test(e.message), 'an ineligible lead is refused, not waved through');
  assert.throws(() => raw(r, { agents: [], permissions: { owner: perm('act') } }), /exactly one entry/, 'an ungranted money lead has no entry');
  assert.strictEqual(raw(r, { agents: [], permissions: {} }).changed, false, 'nobody granted, nothing to set');
  assert.strictEqual(r.audit().length, 0);
  // sam is eligible; the lead becomes eligible and is then granted like anyone else
  assert.strictEqual(raw(r, { agents: ['sam'], permissions: { sam: perm('act') } }).changed, true);
  assert.deepStrictEqual(r.conns.get('levdemo').agents, ['sam']);
  wallets.add('owner');
  assert.deepStrictEqual(r.mods.detail('levdemo').permissions.agents.filter(a => a.allowed).map(a => a.name), ['sam'], 'an eligible but ungranted lead is still not allowed');
  assert.throws(() => raw(r, { agents: ['sam'], permissions: { sam: perm('act'), owner: perm('look') } }), /exactly one entry/);
  raw(r, { agents: ['sam', 'owner'], permissions: { sam: perm('act'), owner: perm('look') } });
  assert.deepStrictEqual(r.conns.get('levdemo').agents, ['sam', 'owner']);
  // a lead that loses eligibility cannot be kept
  wallets.delete('owner');
  assert.throws(() => raw(r, { agents: ['sam', 'owner'], permissions: { sam: perm('act'), owner: perm('look') } }), /owner.*wallet agent/);
});

test('dedicated save: any named agent is vetted, a virtual or member-owned lead included', async (t) => {
  const agents = [{ name: 'owner', lead: true }, { name: 'tw-lead', lead: true }, { name: 'kid-lead', lead: true, owner: 'u_member' }, { name: 'sam' }];
  const r = rig({ agents }); t.after(r.cleanup);
  await r.finish([]);
  const before = fs.readFileSync(path.join(r.dir, 'modules.json'), 'utf8');
  for (const bad of ['tw-lead', 'kid-lead']) {
    assert.throws(() => raw(r, { agents: [bad], permissions: { owner: perm('look'), [bad]: perm('look') } }), (e) => e.status === 400 && new RegExp(bad).test(e.message), bad);
    assert.throws(() => r.mods.setAgents('levdemo', [bad]), new RegExp(bad));
  }
  assert.strictEqual(fs.readFileSync(path.join(r.dir, 'modules.json'), 'utf8'), before);
  // such a lead is not locked in either: only the valid lead is in the set
  assert.strictEqual(raw(r, { agents: [], permissions: { owner: perm('look') } }).changed, false);
});

test('dedicated save: an empty grant list works with the locked lead; the no-change check includes the grants', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish(['sam']);
  save(r, [], {});   // sam is still granted
  assert.deepStrictEqual(r.conns.get('levdemo').agents, ['sam']);
  // same levels, different grants: a change, not "nothing to do"
  const cur = r.mods.detail('levdemo').permissions.agents.filter(a => a.allowed);
  const perms = Object.fromEntries(cur.map(a => [a.name, perm(a.level, a.askEachSession)]));
  save(r, ['sam'], {});
  const n = r.audit().length;
  assert.strictEqual(raw(r, { agents: ['sam'], permissions: perms }).changed, false);
  assert.strictEqual(r.audit().length, n);
  const only = raw(r, { agents: [], permissions: { owner: perm('look') } });
  assert.strictEqual(only.changed, true, 'revoking sam alone is a change');
  assert.deepStrictEqual(r.conns.get('levdemo').agents, []);
  assert.deepStrictEqual(only.module.agents, []);
  assert.ok(!r.state().settings.levels.some(e => e.startsWith('sam:')), 'her entries went with the grant');
  assert.strictEqual(raw(r, { agents: [], permissions: { owner: perm('look') } }).changed, false);
  // a listed lead is not stored as a grant
  assert.strictEqual(raw(r, { agents: ['owner'], permissions: { owner: perm('look') } }).changed, false);
  assert.deepStrictEqual(r.conns.get('levdemo').agents, []);
});

test('dedicated save: grants and levels are saved together; a revoked agent loses its no-ask right; a failed write puts the grants back', async (t) => {
  const r = rig({ agents: [...AGENTS, { name: 'stranger' }] }); t.after(r.cleanup);
  await r.finish([]);
  raw(r, { agents: ['sam', 'ann'], permissions: { owner: perm('look'), sam: perm('drive', false), ann: perm('act', false) }, acknowledged: true });
  assert.deepStrictEqual(r.state().settings.no_ask_agents.slice().sort(), ['ann', 'sam']);
  // revoke sam while editing ann: sam's level and no-ask entries go in the same save; irrelevant legacy entries stay
  const f = path.join(r.dir, 'modules.json'); const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  st.modules.levdemo.settings.levels.push('stranger:drive'); st.modules.levdemo.settings.no_ask_agents.push('stranger'); fs.writeFileSync(f, JSON.stringify(st));
  const stoppedBefore = r.stopped.length;
  raw(r, { agents: ['ann'], permissions: { owner: perm('look'), ann: perm('drive', false) }, acknowledged: true });
  assert.deepStrictEqual(r.conns.get('levdemo').agents, ['ann']);
  assert.deepStrictEqual(r.state().settings.levels.slice().sort(), ['ann:drive', 'owner:look', 'stranger:drive']);
  assert.deepStrictEqual(r.state().settings.no_ask_agents.slice().sort(), ['ann', 'stranger']);
  assert.strictEqual(r.stopped.length, stoppedBefore + 1, 'restarted once');
  const done = r.audit().filter(l => l.state === 'done').pop();
  assert.deepStrictEqual(done.grants, ['ann']); assert.deepStrictEqual(done.revoked, ['sam']);
  // a stale no-ask entry on an agent that is not allowed does not count as "already running without asking"
  assert.throws(() => raw(r, { agents: ['ann', 'stranger'], permissions: { owner: perm('look'), ann: perm('drive', false), stranger: perm('act', false) } }), (e) => e.needsAck === true && e.agents.includes('stranger'));
  // a failed settings write puts the grants back and logs the failure
  const real = fs.renameSync; const pushes = r.pushes.length;
  fs.renameSync = (...a) => { fs.renameSync = real; throw new Error('disk full'); };
  try { assert.throws(() => raw(r, { agents: [], permissions: { owner: perm('look') } }), /disk full/); } finally { fs.renameSync = real; }
  assert.deepStrictEqual(r.conns.get('levdemo').agents, ['ann'], 'grants restored');
  assert.strictEqual(r.audit().pop().state, 'failed'); assert.strictEqual(r.pushes.length, pushes);
  assert.deepStrictEqual(r.state().settings.levels.slice().sort(), ['ann:drive', 'owner:look', 'stranger:drive']);
});

test('dedicated save: asking turned off is announced once as soon as it is saved, even if publishing the grants then fails', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish(['sam']);
  const stoppedBefore = r.stopped.length;
  const realSet = r.conns.set;
  r.conns.set = () => { throw new Error('grant store down'); };
  try {
    assert.throws(() => raw(r, { agents: ['sam', 'ann'], permissions: { owner: perm('look'), sam: perm('act'), ann: perm('act', false) }, acknowledged: true }), /grant store down/);
  } finally { r.conns.set = realSet; }
  assert.deepStrictEqual(r.state().settings.no_ask_agents, ['ann'], 'the policy that was saved stays');
  assert.deepStrictEqual(r.conns.get('levdemo').agents, ['sam'], 'the new grant was not published');
  assert.strictEqual(r.pushes.length, 1); assert.match(r.pushes[0].body, /ann/); assert.match(r.pushes[0].body, /without asking/);
  assert.strictEqual(r.stopped.length, stoppedBefore + 1, 'restarted once');
  const states = r.audit().map(l => l.state);
  assert.deepStrictEqual(states, ['requested', 'failed']);
  assert.match(r.audit().pop().error, /grant store down/);
});

test('dedicated save: when the settings cannot be saved nothing is announced', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish(['sam']);
  const real = fs.renameSync;
  fs.renameSync = () => { fs.renameSync = real; throw new Error('disk full'); };
  try { assert.throws(() => raw(r, { agents: ['sam', 'ann'], permissions: { owner: perm('look'), sam: perm('act'), ann: perm('act', false) }, acknowledged: true }), /disk full/); } finally { fs.renameSync = real; }
  assert.strictEqual(r.pushes.length, 0);
  assert.deepStrictEqual(r.audit().map(l => l.state), ['requested', 'failed']);
  assert.deepStrictEqual(r.state().settings.no_ask_agents || [], []);
  assert.deepStrictEqual(r.conns.get('levdemo').agents, ['sam']);
});

test('UI contract: the editor body (agents = chosen unlocked grants, permissions = those plus the locked lead) saves, grants and revokes coherently', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish([]);
  const stopped0 = r.stopped.length;
  // 1. only the locked lead, no grants
  assert.throws(() => raw(r, { agents: [], permissions: { owner: { level: 'drive', askEachSession: false } } }), (e) => e.status === 409 && e.needsAck === true && e.agents.join() === 'owner');
  assert.strictEqual(r.audit().length, 0);
  const a1 = raw(r, { agents: [], permissions: { owner: { level: 'drive', askEachSession: false } }, acknowledged: true });
  assert.strictEqual(a1.changed, true); assert.deepStrictEqual(a1.turnedAskingOff, ['owner']);
  assert.deepStrictEqual(r.state().settings.levels, ['owner:drive']); assert.deepStrictEqual(r.state().settings.no_ask_agents, ['owner']);
  assert.deepStrictEqual(r.conns.get('levdemo').agents, []);
  assert.strictEqual(r.stopped.length, stopped0 + 1); assert.strictEqual(r.pushes.length, 1); assert.match(r.pushes[0].body, /owner/);
  assert.deepStrictEqual(a1.module.permissions.runsWithoutAsking, ['owner']);
  // 2. newly grant sam alongside owner
  const a2 = raw(r, { agents: ['sam'], permissions: { owner: { level: 'drive', askEachSession: false }, sam: { level: 'act', askEachSession: true } } });
  assert.strictEqual(a2.changed, true); assert.deepStrictEqual(a2.turnedAskingOff, [], 'owner was already running without asking');
  assert.deepStrictEqual(r.conns.get('levdemo').agents, ['sam']);
  assert.deepStrictEqual(r.state().settings.levels.slice().sort(), ['owner:drive', 'sam:act']); assert.deepStrictEqual(r.state().settings.no_ask_agents, ['owner']);
  assert.strictEqual(r.stopped.length, stopped0 + 2); assert.strictEqual(r.pushes.length, 1, 'no new notice: asking stayed on for sam');
  assert.deepStrictEqual(a2.module.agents, ['sam']);
  const sam = a2.module.permissions.agents.find(a => a.name === 'sam'); assert.strictEqual(sam.granted, true); assert.strictEqual(sam.allowed, true); assert.strictEqual(sam.level, 'act');
  // 3. revoke sam
  const a3 = raw(r, { agents: [], permissions: { owner: { level: 'drive', askEachSession: false } } });
  assert.strictEqual(a3.changed, true);
  assert.deepStrictEqual(r.conns.get('levdemo').agents, []);
  assert.deepStrictEqual(r.state().settings.levels, ['owner:drive']); assert.deepStrictEqual(r.state().settings.no_ask_agents, ['owner']);
  assert.strictEqual(r.stopped.length, stopped0 + 3); assert.strictEqual(r.pushes.length, 1);
  assert.strictEqual(a3.module.permissions.agents.find(a => a.name === 'sam').allowed, false);
  assert.deepStrictEqual(r.audit().filter(l => l.state === 'done').map(l => [l.grants, l.revoked]), [[[], []], [['sam'], []], [[], ['sam']]]);
  // 4. a newly granted sam with asking off needs the acknowledgement, which then pushes a notice
  assert.throws(() => raw(r, { agents: ['sam'], permissions: { owner: perm('drive', false), sam: perm('drive', false) } }), (e) => e.needsAck === true && e.agents.join() === 'sam');
  assert.deepStrictEqual(r.conns.get('levdemo').agents, []);
  raw(r, { agents: ['sam'], permissions: { owner: perm('drive', false), sam: perm('drive', false) }, acknowledged: true });
  assert.strictEqual(r.pushes.length, 2); assert.match(r.pushes[1].body, /sam/);
});

test('dedicated save: turning asking off needs the acknowledgement, then warns admins and is logged', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const off = { sam: perm('act', false) };
  assert.throws(() => save(r, ['sam'], off), (e) => e.status === 409 && e.needsAck === true && /sam/.test(e.message));
  assert.throws(() => save(r, ['sam'], off, { acknowledged: false }), (e) => e.needsAck === true);
  assert.strictEqual(r.audit().length, 0); assert.strictEqual(r.pushes.length, 0);
  assert.deepStrictEqual(r.mods.detail('levdemo').permissions.runsWithoutAsking, []);
  const out = save(r, ['sam'], off, { acknowledged: true });
  assert.deepStrictEqual(out.turnedAskingOff, ['sam']);
  assert.deepStrictEqual(r.state().settings.no_ask_agents, ['sam']);
  assert.strictEqual(r.pushes.length, 1);
  assert.match(r.pushes[0].body, /sam/); assert.match(r.pushes[0].body, /without asking/);
  const done = r.audit().filter(l => l.state === 'done');
  assert.deepStrictEqual(done[0].turnedAskingOff, ['sam']);
  assert.deepStrictEqual(done[0].changes.find(c => c.agent === 'sam').to, { level: 'act', askEachSession: false });
  // a look-level agent cannot have asking "off": there is no question at that level, so no dormant no-ask setting is stored
  assert.throws(() => save(r, ['ann'], { ann: perm('look', false) }, { acknowledged: true }), (e) => e.status === 400 && /only asked at act and drive/.test(e.message));
  assert.deepStrictEqual(r.mods.detail('levdemo').permissions.runsWithoutAsking, ['sam']);
  // raising a no-ask agent from act to drive is also a widening that needs the acknowledgement
  assert.throws(() => save(r, ['sam'], { sam: perm('drive', false) }), (e) => e.needsAck === true);
  // an agent given a no-ask level for the first time needs it too
  assert.throws(() => save(r, ['ann'], { ann: perm('act', false) }), (e) => e.needsAck === true);
  save(r, ['ann'], { ann: perm('act', false) }, { acknowledged: true });
  // turning asking back on needs no acknowledgement and no phone notice
  const pushed = r.pushes.length;
  save(r, ['sam'], { sam: perm('act', true) });
  assert.deepStrictEqual(r.state().settings.no_ask_agents, ['ann']);
  assert.strictEqual(r.pushes.length, pushed);
});

test('status: the summary lists allowed agents running without asking, and only those', async (t) => {
  const agents = [...AGENTS];
  const r = rig({ agents }); t.after(r.cleanup);
  await r.finish();
  save(r, ['sam', 'owner'], { sam: perm('drive', false), owner: perm('act', false) }, { acknowledged: true });
  const row = () => r.mods.list().find(x => x.id === 'levdemo');
  assert.deepStrictEqual(row().runsWithoutAsking.slice().sort(), ['owner', 'sam']);
  assert.match(row().note, /Running without asking: (owner, sam|sam, owner)/);
  r.conns.get('levdemo').enabled = false;
  assert.match(row().note, /Running without asking: (owner, sam|sam, owner)/, 'the saved policy stays visible while switched off');
  r.conns.get('levdemo').enabled = true;
  // revoking sam's access ends it: no longer allowed, and its entries are dropped so a later grant starts again at the default
  await r.mods.runStep('levdemo', 'agents', { agents: ['ann'] });
  assert.deepStrictEqual(row().runsWithoutAsking, ['owner']);
  assert.ok(!r.state().settings.no_ask_agents.includes('sam')); assert.ok(!r.state().settings.levels.some(e => e.startsWith('sam:')));
  await r.mods.runStep('levdemo', 'agents', { agents: ['ann', 'sam'] });
  const sam = r.mods.detail('levdemo').permissions.agents.find(a => a.name === 'sam');
  assert.strictEqual(sam.level, 'look'); assert.strictEqual(sam.askEachSession, true);
  // an agent that was deleted, or became a member's, no longer counts even though its entry remains
  const idx = agents.findIndex(a => a.name === 'owner'); agents[idx] = { name: 'owner', lead: true, owner: 'u_member' };
  assert.deepStrictEqual(row().runsWithoutAsking, []);
});

// ── generic writes cannot touch the protected settings ──
test('generic writes refuse any protected key, even with an unchanged value, and never rewrite them', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  save(r, ['sam'], { sam: perm('act', false) }, { acknowledged: true });
  const snap = JSON.stringify([r.state().settings.levels, r.state().settings.no_ask_agents]);
  const same = r.mods.detail('levdemo').settings;
  assert.throws(() => r.mods.saveSettings('levdemo', { levels: same.levels }), /permission editor/);
  assert.throws(() => r.mods.saveSettings('levdemo', { no_ask_agents: same.no_ask_agents }), /permission editor/);
  assert.throws(() => r.mods.saveSettings('levdemo', { note: 'y', no_ask_agents: ['ann'] }), /permission editor/);
  assert.throws(() => r.mods.saveSettings('levdemo', { levels: ['ann:drive'] }), /permission editor/);
  assert.throws(() => r.mods.saveSettings('levdemo', { __x: 1, permissions: {} }), /permission editor/);
  assert.throws(() => r.mods.saveSettings('levdemo', JSON.parse('{"no_ask_agents":["a"]}')), /permission editor/);
  await assert.rejects(r.mods.runStep('levdemo', 'limits', { values: { levels: same.levels } }), /permission editor/);
  await assert.rejects(r.mods.runStep('levdemo', 'limits', { values: { note: 'q', no_ask_agents: ['ann'] } }), /permission editor/);
  assert.strictEqual(r.state().settings.note, 'x', 'a refused save changed nothing');
  // a normal settings save leaves the protected lists exactly as stored
  r.mods.saveSettings('levdemo', { note: 'y' });
  await r.mods.runStep('levdemo', 'limits', { values: { note: 'z' } });
  assert.strictEqual(r.state().settings.note, 'z');
  assert.strictEqual(JSON.stringify([r.state().settings.levels, r.state().settings.no_ask_agents]), snap);
});

test('the grant step accepts no embedded permissions, and granting (the connector_access path) never raises a level or turns asking off', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish();
  const snap = () => JSON.stringify([r.state().settings.levels, r.state().settings.no_ask_agents]);
  const s0 = snap();
  for (const input of [
    { agents: ['sam'], permissions: { sam: perm('drive', false) } },
    { agents: ['sam'], levels: ['sam:drive'] },
    { agents: ['sam'], no_ask_agents: ['sam'] },
    { agents: ['sam'], values: { no_ask_agents: ['sam'] } },
    { agents: ['sam'], extra: { deep: { askEachSession: false } } },
  ]) await assert.rejects(r.mods.runStep('levdemo', 'agents', input), /permission editor/, JSON.stringify(input));
  assert.strictEqual(snap(), s0);
  // setAgents is what connector_access calls: it carries no permission input at all
  r.mods.setAgents('levdemo', ['sam', 'ann'], { by: 'owner' });
  r.mods.setAgents('levdemo', ['sam', 'ann', 'extra-ignored-because-unknown'].slice(0, 2), { by: 'owner' });
  assert.strictEqual(snap(), s0);
  assert.throws(() => r.mods.setAgents('levdemo', ['ghost']), /ghost/);
  // an agent set to drive without asking loses both when removed through the grant path, and starts over when given again
  save(r, ['ann'], { ann: perm('drive', false) }, { acknowledged: true });
  r.mods.setAgents('levdemo', ['sam'], { by: 'owner' });
  r.mods.setAgents('levdemo', ['sam', 'ann'], { by: 'owner' });
  const ann = r.mods.detail('levdemo').permissions.agents.find(a => a.name === 'ann');
  assert.strictEqual(ann.level, 'look'); assert.strictEqual(ann.askEachSession, true);
});

// Plant a saved setting the way an older grant, a deleted-and-recreated agent or a restore could leave it.
const plant = (r, key, list) => { const f = path.join(r.dir, 'modules.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.modules.levdemo.settings = { ...(j.modules.levdemo.settings || {}), [key]: list }; fs.writeFileSync(f, JSON.stringify(j)); };

test('generic grant (connector_access path): a stale level and no-ask entry never reach a newly granted agent, so it is asked at the default level', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.finish(['sam']);
  plant(r, 'levels', ['owner:look', 'ann:act']); plant(r, 'no_ask_agents', ['ann', 'sam']);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk full'); };
  try { assert.throws(() => r.mods.setAgents('levdemo', ['sam', 'ann']), /disk full/); }
  finally { fs.renameSync = rename; }
  assert.deepStrictEqual(r.conns.get('levdemo').agents, ['sam'], 'failed policy cleanup must not publish a new grant');
  r.mods.setAgents('levdemo', ['sam', 'ann'], { by: 'owner' });
  const s = r.state().settings;
  assert.deepStrictEqual(s.no_ask_agents, ['sam'], 'the already-granted agent keeps its entry; the new one has none');
  assert.deepStrictEqual(s.levels, ['owner:look'], 'the new grant loses its stale level too');
  const ann = r.mods.detail('levdemo').permissions.agents.find(a => a.name === 'ann');
  assert.strictEqual(ann.level, 'look'); assert.strictEqual(ann.askEachSession, true); assert.strictEqual(ann.runsWithoutAsking, false);
  assert.ok(!r.mods.detail('levdemo').permissions.runsWithoutAsking.includes('ann'));
});

test('money module, generic grant: a revoked lead loses its level and no-ask entry, and a regrant starts over', async (t) => {
  const m = { ...baseManifest(), risk: 'money', tools: { buy: 'money' } };
  const r = rig({ manifest: m, wallet: (n) => n === 'owner' || n === 'sam' }); t.after(r.cleanup);
  await r.mods.runStep('levdemo', 'install', {});
  r.mods.setAgents('levdemo', ['owner', 'sam'], { by: 'owner' });
  assert.deepStrictEqual(r.conns.get('levdemo').agents, ['owner', 'sam'], 'an eligible money lead is an ordinary grant');
  save(r, ['sam'], { owner: perm('drive', false), sam: perm('act', false) }, { acknowledged: true });
  assert.deepStrictEqual(r.state().settings.no_ask_agents.slice().sort(), ['owner', 'sam']);
  r.mods.setAgents('levdemo', ['sam'], { by: 'owner' });   // the lead is revoked
  assert.deepStrictEqual(r.state().settings.no_ask_agents, ['sam']);
  assert.ok(!r.state().settings.levels.some(e => e.startsWith('owner:')), 'the revoked lead lost its level');
  assert.deepStrictEqual(r.mods.detail('levdemo').permissions.runsWithoutAsking, ['sam']);
  r.mods.setAgents('levdemo', ['owner', 'sam'], { by: 'owner' });   // regranted: default level, asked
  const owner = r.mods.detail('levdemo').permissions.agents.find(a => a.name === 'owner');
  assert.strictEqual(owner.level, 'look'); assert.strictEqual(owner.askEachSession, true);
  // a lead of a non-money module is never revoked, so its entries stay
  const n = rig(); t.after(n.cleanup);
  await n.finish(['sam']);
  save(n, [], { owner: perm('act', false) }, { acknowledged: true });
  n.mods.setAgents('levdemo' , ['ann'], { by: 'owner' });
  assert.ok(n.state().settings.no_ask_agents.includes('owner'));
});

test('generic grant on a level-bearing money module still refuses an ineligible lead and non-wallet agents', async (t) => {
  const m = { ...baseManifest(), risk: 'money', tools: { buy: 'money' } };
  const r = rig({ manifest: m, wallet: (n) => n === 'sam' }); t.after(r.cleanup);
  await r.mods.runStep('levdemo', 'install', {});
  assert.throws(() => r.mods.setAgents('levdemo', ['owner', 'sam']), /owner.*wallet agent/);
  assert.throws(() => r.mods.setAgents('levdemo', ['ann']), /wallet agent/);
  assert.throws(() => r.mods.setAgents('levdemo', ['kid']), /member/);
  assert.throws(() => r.mods.setAgents('levdemo', ['tw-1']), /temporary worker/);
  assert.deepStrictEqual(r.conns.get('levdemo').agents, []);
});

test('legacy: a money module without levels still drops an ineligible lead silently and refuses other bad names', async (t) => {
  const m = { ...baseManifest(), risk: 'money', tools: { buy: 'money' } };
  const r = rig({ manifest: m, withLevels: false, wallet: (n) => n === 'sam' }); t.after(r.cleanup);
  await r.mods.runStep('levdemo', 'install', {});
  assert.deepStrictEqual(r.mods.setAgents('levdemo', ['owner', 'sam']), ['sam']);
  assert.throws(() => r.mods.setAgents('levdemo', ['ann']), /wallet agent/);
  assert.throws(() => r.mods.setAgents('levdemo', ['kid']), /member/);
  assert.deepStrictEqual(r.conns.get('levdemo').agents, ['sam']);
});

// ── backup restore ──
test('backup restore empties no_ask_agents everywhere: neither the backup\'s nor today\'s list survives, levels stay as restored', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-lev-bk-'));
  try {
    fs.mkdirSync(path.join(root, 'levdemo')); fs.writeFileSync(path.join(root, 'levdemo', 'module.json'), JSON.stringify(baseManifest()));
    const { levels, ...plain } = baseManifest(); fs.mkdirSync(path.join(root, 'plain')); fs.writeFileSync(path.join(root, 'plain', 'module.json'), JSON.stringify({ ...plain, id: 'plain' }));
    fs.mkdirSync(path.join(root, 'broken')); fs.writeFileSync(path.join(root, 'broken', 'module.json'), '{nope');
    const staged = () => ({ modules: {
      levdemo: { settings: { levels: ['sam:drive'], no_ask_agents: ['sam', 'ann'], note: 'b' }, steps: {} },
      plain: { settings: { no_ask_agents: ['sam'], note: 'p' } },
      broken: { settings: { no_ask_agents: ['sam'] } },
      nosettings: { steps: {} },
      '../evil': { settings: { no_ask_agents: ['sam'] } },
    } });
    // the backup's list (and any list on this computer today, which is no longer even read) becomes empty
    const s1 = staged();
    assert.strictEqual(manifestLib.holdNoAskSettings(s1, root), true);
    assert.deepStrictEqual(s1.modules.levdemo.settings.no_ask_agents, [], 'the backup\'s list is emptied');
    assert.deepStrictEqual(s1.modules.levdemo.settings.levels, ['sam:drive'], 'restored levels stay exactly as restored');
    assert.strictEqual(s1.modules.levdemo.settings.note, 'b');
    assert.deepStrictEqual(s1.modules.plain.settings.no_ask_agents, [], 'a readable manifest with no declaration: a stray conventional key is still emptied');
    assert.strictEqual(s1.modules.plain.settings.note, 'p');
    assert.deepStrictEqual(s1.modules.broken.settings.no_ask_agents, [], 'unreadable manifest: the default key is emptied');
    assert.deepStrictEqual(s1.modules['../evil'].settings.no_ask_agents, [], 'a bad id never reaches the disk');
    assert.deepStrictEqual(s1.modules.nosettings.steps, {});
    assert.strictEqual(manifestLib.holdNoAskSettings(s1, root), false, 'already empty: nothing to change');
    // malformed or missing values in the backup can never enable asking off
    for (const bad of [undefined, null, 'sam', ['sam'], { sam: true }, 7]) {
      const s = { modules: { levdemo: { settings: bad === undefined ? { levels: ['sam:act'] } : { levels: ['sam:act'], no_ask_agents: bad } } } };
      manifestLib.holdNoAskSettings(s, root);
      assert.deepStrictEqual(s.modules.levdemo.settings.no_ask_agents, [], JSON.stringify(bad));
      assert.deepStrictEqual(s.modules.levdemo.settings.levels, ['sam:act']);
    }
    // a readable manifest with no declaration and no conventional key: nothing is added
    const pl = { modules: { plain: { settings: { note: 'p' } } } };
    assert.strictEqual(manifestLib.holdNoAskSettings(pl, root), false);
    assert.deepStrictEqual(pl.modules.plain.settings, { note: 'p' });
    // a custom declared backing key is emptied, and a stray conventional key beside it too
    const m = baseManifest();
    m.settings = m.settings.map(x => x.key === 'no_ask_agents' ? { ...x, key: 'quiet_agents' } : x);
    m.levels = { ...m.levels, sessionApproval: { ...m.levels.sessionApproval, setting: 'quiet_agents' } };
    assert.deepStrictEqual(manifestLib.validateManifest(m, 'levdemo').problems, []);
    fs.mkdirSync(path.join(root, 'custom')); fs.writeFileSync(path.join(root, 'custom', 'module.json'), JSON.stringify({ ...m, id: 'custom' }));
    const cs = { modules: { custom: { settings: { levels: ['sam:act'], quiet_agents: ['sam'], no_ask_agents: ['ann'] } } } };
    assert.strictEqual(manifestLib.holdNoAskSettings(cs, root), true);
    assert.deepStrictEqual(cs.modules.custom.settings, { levels: ['sam:act'], quiet_agents: [], no_ask_agents: [] });
    // a module with no settings object gets one holding only the empty list
    const ns = { modules: { levdemo: { steps: {} } } };
    manifestLib.holdNoAskSettings(ns, root);
    assert.deepStrictEqual(ns.modules.levdemo.settings, { no_ask_agents: [] });
    for (const bad of [null, undefined, {}, { modules: 'x' }]) assert.strictEqual(manifestLib.holdNoAskSettings(bad, root), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('backup restore code applies the rule (restore prepare and merge-today both call it)', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', 'backup', f), 'utf8');
  assert.match(read('restore.js'), /holdNoAskSettings\(smods, path\.join\(root, 'modules'\)\)/);
  assert.match(read('apply.js'), /holdNoAskSettings\(smods, path\.join\(j\.env\.root, 'modules'\)\)/);
  assert.doesNotMatch(read('restore.js') + read('apply.js'), /holdNoAskSettings\([^)]*modules\.json/, 'today\'s modules.json is not read for the no-ask list');
});
