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
  assert.strictEqual(r.skipped.find(e => e.role === 'scout').error, 'boom');
  assert.deepStrictEqual(Object.keys(st.readLedger(LEDGER).roles), ['challenger', 'researcher']);
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
  st.markSkipped({ ledgerFile: LEDGER, now: () => new Date('2026-01-02T03:04:05Z') });
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

// Review (own): a ledger that is there but unreadable stops every create (an empty-looking ledger could bring back a
// starter the owner deleted); a ledger that can't be saved after a create reports the agent as created, with a warning.
test('an unreadable ledger creates nothing; an unsavable ledger still reports the created agent', async (t) => {
  fs.writeFileSync(LEDGER, '{ not json');
  const r = await st.createTeam({ available: AVAILABLE, lead: 'claude-sdk/default', deps: { ledgerFile: LEDGER, templatesDir: TEMPLATES } });
  assert.strictEqual(r.created.length, 0);
  assert.ok(r.skipped.every(e => e.reason === 'failed' && /can't be read/.test(e.error)), JSON.stringify(r.skipped));
  if (process.getuid && process.getuid() === 0) { t.skip('root writes into a read-only folder'); return; }
  const ro = path.join(INST, 'data', 'readonly-ledger');
  fs.mkdirSync(ro, { recursive: true });
  fs.chmodSync(ro, 0o555);   // the ledger reads as missing and can't be written
  try {
    const deps = { ledgerFile: path.join(ro, 'team.json'), templatesDir: TEMPLATES,
      getAgents: async () => [], createAgent: async (name) => ({ success: true, name }) };
    const r2 = await st.createTeam({ available: AVAILABLE, lead: 'claude-sdk/default', deps });
    assert.strictEqual(r2.created.length, 4);
    assert.ok(r2.created.every(e => /could not be saved/.test(e.warning)));
  } finally { fs.chmodSync(ro, 0o755); }
});
