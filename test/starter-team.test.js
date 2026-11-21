'use strict';
// Starter team (lib/starter-team.js): planning, creation from the templates, the ledger, and the two creation-only agent
// fields (teamRole, teamModelBy). Runs on a throwaway install (test/helpers/isolated-install.js); nothing under the real
// data/ or workspaces/ is read or written.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeIsolatedInstall, REAL } = require('./helpers/isolated-install');

const ISO = makeIsolatedInstall('starter-team-');
const INST = ISO.inst;
const AGENTS_FILE = path.join(INST, 'data', 'agents.json');
const LEDGER = path.join(INST, 'data', 'team.json');
const TEMPLATES = path.join(REAL, 'templates', 'starter-team');
const L = (p) => require(path.join(INST, 'lib', p));
const st = L('starter-team');
const agentsLib = L('agents.js');
const tiers = L('model-tiers');

const AVAILABLE = ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-sonnet-5-5', 'claude-sdk/claude-haiku-5-5'];
const LEAD = 'claude-sdk/claude-opus-5-5';
const DEPS = (extra = {}) => ({ ledgerFile: LEDGER, templatesDir: TEMPLATES, ...extra });
const ROLE_NAMES = ['challenger', 'scout', 'builder', 'researcher'];
const onDisk = () => JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
const seed = (agents) => fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
const other = (extra = {}) => ({ name: 'sam', model: 'claude-sdk/default', display: 'Sam', category: 'specialist', ...extra });
const ws = (name) => path.join(INST, 'workspaces', name);

beforeEach(() => {
  seed([]);
  try { fs.unlinkSync(LEDGER); } catch {}
  fs.rmSync(path.join(INST, 'workspaces'), { recursive: true, force: true });
  agentsLib.getAgents(true);
});
after(() => { try { fs.rmSync(path.dirname(ISO.inst), { recursive: true, force: true }); } catch {} });

test('creates all four from the templates with the models pickTeam chooses; the ledger is private', async () => {
  const picks = tiers.pickTeam({ available: AVAILABLE, lead: LEAD });
  const r = await st.createTeam({ available: AVAILABLE, lead: LEAD, deps: DEPS() });
  assert.deepStrictEqual(r.created.map(e => e.role), ROLE_NAMES);
  assert.strictEqual(r.skipped.length, 0);
  const list = onDisk();
  for (const role of st.ROLES) {
    const a = list.find(x => x.name === role.name);
    assert.ok(a, role.name);
    assert.strictEqual(a.model, picks[role.role].model);
    assert.strictEqual(a.category, 'worker');
    assert.strictEqual(a.teamRole, role.teamRole);
    assert.strictEqual(a.teamModelBy, 'hub');
    assert.strictEqual(a.display, role.display);
    assert.strictEqual(a.icon, role.icon);
    for (const f of ['IDENTITY.md', 'SOUL.md', 'USER.md', 'TOOLS.md']) {
      assert.strictEqual(fs.readFileSync(path.join(ws(role.name), f), 'utf8'), fs.readFileSync(path.join(TEMPLATES, role.role, f), 'utf8'), `${role.name}/${f}`);
    }
  }
  const ledger = st.readLedger(LEDGER);
  assert.deepStrictEqual(Object.keys(ledger.roles), ROLE_NAMES);
  assert.strictEqual(ledger.roles.scout.model, picks.scout.model);
  assert.ok(ledger.roles.scout.createdAt);
  assert.strictEqual(fs.statSync(LEDGER).mode & 0o777, 0o600);
  assert.strictEqual(agentsLib.getAgentsSync(true).find(a => a.name === 'scout').teamModelBy, 'hub');
});

test('a second call creates nothing: all four are skipped as created before', async () => {
  await st.createTeam({ available: AVAILABLE, lead: LEAD, deps: DEPS() });
  const r = await st.createTeam({ available: AVAILABLE, lead: LEAD, deps: DEPS() });
  assert.strictEqual(r.created.length, 0);
  assert.deepStrictEqual(r.skipped.map(e => e.reason), Array(4).fill('created before'));
  assert.strictEqual(onDisk().length, 4);
});

test('an agent with the role name or display keeps its place: that role is skipped, the rest are created', async () => {
  seed([other({ name: 'challenger', display: 'Mine' })]);
  agentsLib.getAgents(true);
  let r = await st.createTeam({ available: AVAILABLE, lead: LEAD, deps: DEPS() });
  assert.strictEqual(r.skipped.find(e => e.role === 'challenger').reason, 'name taken');
  assert.deepStrictEqual(r.created.map(e => e.role), ['scout', 'builder', 'researcher']);
  assert.deepStrictEqual(onDisk().find(a => a.name === 'challenger'), other({ name: 'challenger', display: 'Mine' }));
  assert.strictEqual(st.readLedger(LEDGER).roles.challenger, undefined);

  seed([other({ name: 'sam', display: 'SCOUT' })]);
  try { fs.unlinkSync(LEDGER); } catch {}
  agentsLib.getAgents(true);
  r = await st.createTeam({ available: AVAILABLE, lead: LEAD, deps: DEPS() });
  assert.strictEqual(r.skipped.find(e => e.role === 'scout').reason, 'name taken');
  assert.strictEqual(r.created.length, 3);
});

test('a starter the owner deleted is never created again', async () => {
  await st.createTeam({ available: AVAILABLE, lead: LEAD, deps: DEPS() });
  seed(onDisk().filter(a => a.name !== 'builder'));
  agentsLib.getAgents(true);
  const r = await st.createTeam({ available: AVAILABLE, lead: LEAD, deps: DEPS() });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.skipped.find(e => e.role === 'builder').reason, 'created before');
  assert.ok(!onDisk().some(a => a.name === 'builder'));
});

test('a role with no model is skipped with the note; the challenger is still created', async () => {
  const only = ['claude-sdk/claude-opus-5-5'];
  const r = await st.createTeam({ available: only, lead: 'claude-sdk/claude-opus-5-5', deps: DEPS() });
  assert.deepStrictEqual(r.created.map(e => e.role), ['challenger']);
  for (const e of r.skipped) {
    assert.strictEqual(e.reason, 'no model', e.role);
    assert.ok(e.note, e.role);
  }
  assert.deepStrictEqual(r.skipped.map(e => e.role), ['scout', 'builder', 'researcher']);
});

test('one failing createAgent: that role is failed with the error and has no ledger entry; the others are created', async () => {
  const real = agentsLib.createAgent;
  const createAgent = async (name, ...rest) => {
    if (name === 'builder') return { success: false, error: 'disk is full' };
    if (name === 'scout') throw new Error('boom');
    return real(name, ...rest);
  };
  const r = await st.createTeam({ available: AVAILABLE, lead: LEAD, deps: DEPS({ createAgent }) });
  assert.deepStrictEqual(r.created.map(e => e.role), ['challenger', 'researcher']);
  const b = r.skipped.find(e => e.role === 'builder');
  assert.strictEqual(b.reason, 'failed');
  assert.strictEqual(b.error, 'disk is full');
  // Review r2: a throw with no agent afterwards is an unknown outcome: its reservation stays (never made again).
  assert.match(r.skipped.find(e => e.role === 'scout').error, /^boom; the outcome is unknown/);
  const roles = st.readLedger(LEDGER).roles;
  assert.deepStrictEqual(Object.keys(roles).sort(), ['challenger', 'researcher', 'scout']);
  assert.strictEqual(roles.scout.status, 'reserved');
  assert.ok(!roles.builder, 'a reported failure takes its reservation back');
});

test('only limits which roles are created', async () => {
  const r = await st.createTeam({ available: AVAILABLE, lead: LEAD, only: ['scout'], deps: DEPS() });
  assert.deepStrictEqual(r.created.map(e => e.role), ['scout']);
  assert.deepStrictEqual(onDisk().map(a => a.name), ['scout']);
  assert.deepStrictEqual(Object.keys(st.readLedger(LEDGER).roles), ['scout']);
});

test('two concurrent calls create each agent once', async () => {
  const [a, b] = await Promise.all([
    st.createTeam({ available: AVAILABLE, lead: LEAD, deps: DEPS() }),
    st.createTeam({ available: AVAILABLE, lead: LEAD, deps: DEPS() }),
  ]);
  assert.strictEqual(a.created.length + b.created.length, 4);
  assert.strictEqual(Math.min(a.created.length, b.created.length), 0);
  assert.strictEqual(onDisk().length, 4);
});

test('a missing template file fails that role without creating a partial agent', async () => {
  const dir = path.join(path.dirname(ISO.inst), 'templates-partial');
  fs.cpSync(TEMPLATES, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scout', 'SOUL.md'), 'x');
  fs.unlinkSync(path.join(dir, 'scout', 'SOUL.md'));
  const r = await st.createTeam({ available: AVAILABLE, lead: LEAD, deps: DEPS({ templatesDir: dir }) });
  const s = r.skipped.find(e => e.role === 'scout');
  assert.strictEqual(s.reason, 'failed');
  assert.match(s.error, /SOUL\.md/);
  assert.ok(!onDisk().some(a => a.name === 'scout'));
  assert.ok(!fs.existsSync(ws('scout')));
  assert.strictEqual(r.created.length, 3);
});

test('markSkipped records skippedAt and keeps the roles', async () => {
  await st.createTeam({ available: AVAILABLE, lead: LEAD, only: ['scout'], deps: DEPS() });
  await st.markSkipped({ ledgerFile: LEDGER, now: () => new Date('2026-01-02T03:04:05Z') });
  const l = st.readLedger(LEDGER);
  assert.strictEqual(l.skippedAt, '2026-01-02T03:04:05.000Z');
  assert.ok(l.roles.scout);
  assert.deepStrictEqual(st.readLedger(path.join(INST, 'data', 'nope.json')), { roles: {} });
});

test('agentSpec: teamRole and teamModelBy are accepted or refused as specified', async () => {
  const mk = (name, extra) => agentsLib.createAgent(name, 'claude-sdk/default', null, null, 'worker', null, extra);
  let r = await mk('badrole', { teamRole: 'boss' });
  assert.deepStrictEqual(r, { success: false, error: 'teamRole: challenger or worker' });
  r = await mk('badby', { teamModelBy: 'owner' });
  assert.deepStrictEqual(r, { success: false, error: 'teamModelBy: hub' });
  r = await mk('plainone', { display: 'Plain One', teamRole: '', teamModelBy: null });
  assert.strictEqual(r.success, true);
  const plain = onDisk().find(a => a.name === 'plainone');
  assert.ok(!('teamRole' in plain) && !('teamModelBy' in plain));
  r = await mk('goodone', { display: 'Good One', teamRole: 'challenger', teamModelBy: 'hub' });
  assert.strictEqual(r.success, true);
  const good = onDisk().find(a => a.name === 'goodone');
  assert.strictEqual(good.teamRole, 'challenger');
  assert.strictEqual(good.teamModelBy, 'hub');
});

test('the starter templates are never part of automatic workspace seeding', () => {
  // The real shipped templates folder, seeded into a temp workspaces folder: the starters live in templates/starter-team,
  // which seeding never reads, so no starter folder appears.
  const tmpWs = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'starter-seed-'));
  try {
    agentsLib.seedDefaultWorkspaces(path.join(REAL, 'templates', 'workspaces'), tmpWs);
    for (const n of ROLE_NAMES) assert.ok(!fs.existsSync(path.join(tmpWs, n)), n);
    assert.ok(fs.existsSync(path.join(tmpWs, 'maestro')), 'maestro is seeded');
  } finally { fs.rmSync(tmpWs, { recursive: true, force: true }); }
});

// Review r1 (GPT-6 and Sonnet BLOCKs): the ledger must never let a deleted starter come back.
test('r1: an unreadable or malformed ledger creates nothing, and Skip leaves it byte for byte', async () => {
  for (const text of ['{ not json', '{"roles":[]}', '{}', '{"roles":{"scout":{}}}', '[]']) {
    fs.writeFileSync(LEDGER, text);
    const r = await st.createTeam({ available: AVAILABLE, lead: 'claude-sdk/default', deps: { ledgerFile: LEDGER, templatesDir: TEMPLATES } });
    assert.strictEqual(r.created.length, 0, text);
    assert.ok(r.skipped.every(e => e.reason === 'failed' && /can't be read/.test(e.error)), text);
    await assert.rejects(st.markSkipped({ ledgerFile: LEDGER }), /can't be read/, text);
    assert.strictEqual(fs.readFileSync(LEDGER, 'utf8'), text, text);
  }
});
test('r1: a ledger that cannot be saved means no agent at all', async (t) => {
  if (process.getuid && process.getuid() === 0) { t.skip('root writes into a read-only folder'); return; }
  const ro = path.join(INST, 'data', 'readonly-ledger');
  fs.mkdirSync(ro, { recursive: true });
  fs.chmodSync(ro, 0o555);
  const made = [];
  try {
    const deps = { ledgerFile: path.join(ro, 'team.json'), templatesDir: TEMPLATES,
      getAgents: async () => [], createAgent: async (name) => { made.push(name); return { success: true, name }; } };
    const r = await st.createTeam({ available: AVAILABLE, lead: 'claude-sdk/default', deps });
    assert.strictEqual(r.created.length, 0);
    assert.deepStrictEqual(made, [], 'nothing made without a saved reservation');
    assert.ok(r.skipped.every(e => /could not be saved/.test(e.error)));
  } finally { fs.chmodSync(ro, 0o755); }
});
test('r1: a create whose final ledger save fails, then a delete: the starter never comes back', async (t) => {
  if (process.getuid && process.getuid() === 0) { t.skip('root writes into a read-only folder'); return; }
  const dir = path.join(INST, 'data', 'ledger-dir');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'team.json');
  let exists = [];
  const deps = { ledgerFile: file, templatesDir: TEMPLATES, getAgents: async () => exists.map(name => ({ name })),
    createAgent: async (name) => { exists.push(name); fs.chmodSync(dir, 0o555); return { success: true, name }; } };
  try {
    const r = await st.createTeam({ available: AVAILABLE, lead: 'claude-sdk/default', only: ['scout'], deps });
    assert.strictEqual(r.created.length, 1);
    assert.match(r.created[0].warning, /reserved/);
  } finally { fs.chmodSync(dir, 0o755); }
  assert.strictEqual(st.readLedger(file).roles.scout.status, 'reserved');
  exists = [];   // the owner deletes it
  const r2 = await st.createTeam({ available: AVAILABLE, lead: 'claude-sdk/default', only: ['scout'], deps: { ...deps, createAgent: async () => { throw new Error('must not be called'); } } });
  assert.strictEqual(r2.created.length, 0);
  assert.strictEqual(r2.skipped.find(e => e.role === 'scout').reason, 'interrupted');
});
test('r1: a create that made nothing takes its reservation back, so a later run can make it', async () => {
  const calls = [];
  const deps = { ledgerFile: LEDGER, templatesDir: TEMPLATES, getAgents: async () => [],
    createAgent: async (name) => { calls.push(name); return calls.length === 1 ? { success: false, error: 'disk busy' } : { success: true, name }; } };
  const r = await st.createTeam({ available: AVAILABLE, lead: 'claude-sdk/default', only: ['scout'], deps });
  assert.strictEqual(r.skipped.find(e => e.role === 'scout').reason, 'failed');
  assert.ok(!st.readLedger(LEDGER).roles.scout, 'reservation taken back');
  const r2 = await st.createTeam({ available: AVAILABLE, lead: 'claude-sdk/default', only: ['scout'], deps });
  assert.strictEqual(r2.created.length, 1);
  assert.strictEqual(st.readLedger(LEDGER).roles.scout.status, 'created');
});
test('r1: a look-alike display (full-width letters) counts as taken, as createAgent judges it', () => {
  const plan = st.planTeam({ agents: [{ name: 'mine', display: 'Ｓcout' }], available: AVAILABLE, lead: 'claude-sdk/default', ledger: { roles: {} } });
  assert.strictEqual(plan.find(e => e.role === 'scout').reason, 'name taken');
});

// Review r2 (GPT-6 BLOCK): a create that throws with an unknown outcome keeps its reservation.
test('r2: createAgent throws and the agent list cannot be read: the reservation stays, the role is never made again', async () => {
  let reads = 0;
  const deps = { ledgerFile: LEDGER, templatesDir: TEMPLATES,
    getAgents: async () => { reads++; if (reads > 1) throw new Error('list unreadable'); return []; },
    createAgent: async () => { throw new Error('crashed midway'); } };
  const r = await st.createTeam({ available: AVAILABLE, lead: 'claude-sdk/default', only: ['scout'], deps });
  assert.match(r.skipped.find(e => e.role === 'scout').error, /outcome is unknown/);
  assert.strictEqual(st.readLedger(LEDGER).roles.scout.status, 'reserved');
  const r2 = await st.createTeam({ available: AVAILABLE, lead: 'claude-sdk/default', only: ['scout'],
    deps: { ...deps, getAgents: async () => [], createAgent: async () => { throw new Error('must not be called'); } } });
  assert.strictEqual(r2.skipped.find(e => e.role === 'scout').reason, 'interrupted');
});
test('r2: createAgent throws but the agent is there: it counts as created', async () => {
  let made = false;
  const deps = { ledgerFile: LEDGER, templatesDir: TEMPLATES,
    getAgents: async () => (made ? [{ name: 'scout' }] : []),
    createAgent: async () => { made = true; throw new Error('reply lost'); } };
  const r = await st.createTeam({ available: AVAILABLE, lead: 'claude-sdk/default', only: ['scout'], deps });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(st.readLedger(LEDGER).roles.scout.status, 'created');
});
