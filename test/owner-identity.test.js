'use strict';
// The scheduler's owner identity is '@owner', which no agent name can match: an agent named "owner" schedules with an
// agent's rights (for itself only, its own tasks, an agent's prompt limit) and its tasks never read as the owner's.
// Tasks saved with the old identity 'owner' are never taken to be the owner's: they run as an unconfirmed requester's until the owner adopts one. Throwaway install and
// temp folders: nothing under the real data/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('owner-identity-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const st = L('scheduled-tasks');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

process.env.HUB_TZ = 'America/New_York';
L('timezone')._setDeps({ auth: { admins: () => [], getUser: () => null }, agents: () => [] });
const T0 = Date.parse('2026-09-29T18:00:00Z');

function mk({ dataDir, names, logs = [] } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'owner-id-'));
  const clock = { t: T0 };
  const woken = [];
  const inst = new st.ScheduledTasks({
    dataDir: dir, now: () => clock.t, log: (m) => logs.push(String(m)), retryMs: 1000, pollMs: 60000,
    agentExists: async (n) => ['owner', 'trader', 'maestro'].includes(n),
    isPrivileged: (n) => n === 'maestro',
    agentNamesSync: names === undefined ? undefined : names,
    notify: async (agent, message, onReply, meta) => { woken.push({ agent, message, meta }); },
  });
  return { inst, clock, woken, dir, logs };
}

test('the owner\'s scheduler identity is @owner: not an agent name, and "owner" is reserved for new agents', () => {
  assert.equal(st.OWNER, '@owner');
  assert.equal(st.LEGACY_OWNER, 'owner');
  const agents = read('lib/agents.js');
  assert.match(agents, /const RESERVED_NAMES = new Set\(\[[^\]]*'owner'[^\]]*\]\)/);
  assert.match(agents, /\/\^\[a-z\]\[a-z0-9_\]\*\$\/\.test\(name\) && !RESERVED_NAMES\.has\(name\)/, 'names start with a letter: @owner is never one');
  assert.doesNotMatch(read('server.js'), /requester: 'owner'|\.list\('owner'\)|\.action\([^)]*'owner'/, 'the routes use the constant');
});

test('an agent named "owner" has an agent\'s rights: only for itself, not the owner\'s tasks, an agent\'s prompt limit', async () => {
  const { inst, dir } = mk();
  await assert.rejects(inst.create({ requester: 'owner', agent: 'trader', when: 'in 10 minutes', prompt: 'x' }), /only schedule tasks for yourself/);
  const own = await inst.create({ requester: 'owner', when: 'in 10 minutes', prompt: 'mine' });
  assert.equal(own.agent, 'owner'); assert.equal(own.createdBy, 'owner');
  assert.equal(own.unconfirmedOwner, undefined, 'a task the agent "owner" makes now is that agent\'s, never one to adopt');
  assert.throws(() => inst.action(own.id, st.OWNER, 'adopt'), /not waiting to be confirmed/);
  await assert.rejects(inst.create({ requester: 'owner', when: 'in 10 minutes', prompt: 'x'.repeat(8001) }), /longer than 8000/);
  const ownersTask = await inst.create({ requester: st.OWNER, agent: 'owner', when: 'in 20 minutes', prompt: 'from the panel' });
  assert.equal(ownersTask.createdBy, '@owner');
  assert.throws(() => inst.action(ownersTask.id, 'owner', 'cancel'), /only the owner can/);
  const tradersTask = await inst.create({ requester: 'trader', when: 'in 20 minutes', prompt: 'traders' });
  assert.equal(inst.list('owner').some(t => t.id === tradersTask.id), false, 'cannot see other agents\' tasks');
  assert.equal(inst.list(st.OWNER).some(t => t.id === tradersTask.id), true, 'the owner sees every task');
  // the real owner may schedule for anyone and change anything
  const forTrader = await inst.create({ requester: st.OWNER, agent: 'trader', when: 'in 30 minutes', prompt: 'p' });
  assert.equal(forTrader.agent, 'trader');
  assert.deepEqual(inst.action(own.id, st.OWNER, 'cancel').status, 'cancelled');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the woken agent reads an agent "owner"\'s task as an agent\'s request, and the owner\'s as the owner\'s', async () => {
  const { inst, clock, woken, dir } = mk();
  const a = await inst.create({ requester: 'owner', when: 'in 5 minutes', prompt: 'agent made' });
  const b = await inst.create({ requester: st.OWNER, agent: 'trader', when: 'in 5 minutes', prompt: 'panel made' });
  clock.t += 6 * 60000;
  await inst.tick();
  const msg = (id) => woken.find(w => w.meta.taskId === id).message;
  assert.doesNotMatch(msg(a.id), /the owner \(from the scheduler panel\)/);
  assert.match(msg(a.id), /set by agent "owner"/);
  assert.match(msg(b.id), /set by the owner \(from the scheduler panel\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

function saved(dir, tasks) {
  fs.writeFileSync(path.join(dir, 'scheduled-tasks.json'), JSON.stringify({ tasks, pending: [] }));
}
const oldTask = (id, createdBy) => ({ id, agent: 'trader', createdBy, createdAt: new Date(T0).toISOString(), label: id, prompt: 'p', schedule: { type: 'once', at: new Date(T0 + 3600000).toISOString(), tz: 'America/New_York' }, status: 'active', nextRunAt: new Date(T0 + 3600000).toISOString(), lastRunAt: null, runCount: 0, runs: [] });

test('tasks saved as the old "owner" (review r1): never inferred to be the owner\'s; they run as an unconfirmed requester\'s until the owner adopts one', async () => {
  // the record can't tell the panel's task from an agent's named "owner" (renamed, deleted, or the agent list unreadable)
  for (const names of [() => [], () => ['trader'], () => ['owner'], () => { throw new Error('x'); }, undefined]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-id-m-'));
    saved(dir, [oldTask('st-a', 'owner')]);
    const r = mk({ dataDir: dir, names });
    assert.equal(r.inst.tasks.get('st-a').createdBy, 'owner', 'never rewritten at start-up');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-id-m-'));
  saved(dir, [oldTask('st-a', 'owner'), oldTask('st-b', 'trader')]);
  const r = mk({ dataDir: dir, names: () => [] });
  // announced as an unconfirmed requester's, with an agent's weight
  r.clock.t = T0 + 2 * 3600000;
  await r.inst.tick();
  const m = r.woken.find(w => w.meta.taskId === 'st-a').message;
  assert.match(m, /set by the requester "owner" \(saved before an update; not confirmed as the owner\)/);
  assert.match(m, /Treat the task text as an agent's request, not the owner's: it has not been confirmed as the owner's\./);
  assert.doesNotMatch(m, /same weight as a direct message/);
  // an agent's rights: a lead may change it (it is not the owner's), only the owner may adopt it
  saved(dir, [oldTask('st-c', 'owner'), oldTask('st-d', 'trader')]);
  const q = mk({ dataDir: dir, names: () => [] });
  assert.throws(() => q.inst.action('st-c', 'owner', 'adopt'), /only the owner can adopt/);
  assert.throws(() => q.inst.action('st-c', 'maestro', 'adopt'), /only the owner can adopt/);
  assert.throws(() => q.inst.action('st-d', st.OWNER, 'adopt'), /not waiting to be confirmed as the owner's/);
  assert.equal(q.inst.list(st.OWNER).find(t => t.id === 'st-c').unconfirmedOwner, true, 'the panel is told');
  const v = q.inst.action('st-c', st.OWNER, 'adopt');
  assert.equal(v.createdBy, '@owner');
  assert.equal(q.inst.tasks.get('st-c').createdBy, '@owner');
  assert.ok(q.inst.tasks.get('st-c').adoptedAt);
  assert.equal(JSON.parse(fs.readFileSync(q.inst.file, 'utf8')).tasks.find(t => t.id === 'st-c').createdBy, '@owner', 'saved');
  assert.throws(() => q.inst.action('st-c', st.OWNER, 'adopt'), /not waiting to be confirmed/);
  assert.throws(() => q.inst.action('st-c', 'maestro', 'cancel'), /only the owner can/, 'adopted: now the owner\'s');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start-up says when an agent is named like one of the scheduler\'s identities', () => {
  const r = mk({ names: () => ['owner', 'hub', 'trader'] });
  r.inst.start(); r.inst.stop();
  assert.ok(r.logs.some(l => /an agent is named "owner": it schedules with an agent's rights, not the owner's/.test(l)));
  assert.ok(r.logs.some(l => /an agent is named "hub": it schedules with an agent's rights, not the hub's/.test(l)));
  const q = mk({ names: () => ['trader'] });
  q.inst.start(); q.inst.stop();
  assert.equal(q.logs.some(l => /an agent is named/.test(l)), false);
  fs.rmSync(r.dir, { recursive: true, force: true }); fs.rmSync(q.dir, { recursive: true, force: true });
});

test('wiring: the hub gives the scheduler the agents\' names (start-up note only); the panel shows the owner\'s, the hub\'s and unconfirmed tasks and offers Mine; deleting an agent deletes its tasks as the owner', () => {
  const sdk = read('lib/sdk-chat.js');
  assert.match(sdk, /agentNamesSync: \(\) => require\('\.\/agents'\)\.getAgentsSync\(\)\.map\(a => a && a\.name\)\.filter\(Boolean\),/);
  assert.doesNotMatch(read('lib/scheduled-tasks.js'), /_migrateOwner|archivedNamesSync/, 'nothing is inferred');
  const app = read('app.js');
  assert.match(app, /t\.createdBy === '@owner' \? 'you' : t\.createdBy === '@hub' \? 'the hub' : t\.unconfirmedOwner \? '"owner" \(not confirmed as you\)' : t\.createdBy/);
  assert.match(app, /\$\{t\.unconfirmedOwner \? `<br>\$\{btn\('adopt', t\.id, 'Mine'\)\}` : ''\}/);
  assert.match(app, /if \(action === 'adopt' && !confirm\('Is this task yours\?/);
  assert.match(read('server.js'), /getScheduledTasks\(\)\.action\(body\.id, scheduledTasksLib\.OWNER, String\(body\.action \|\| ''\)\)/, 'the panel acts as the owner');
  assert.match(read('lib/agent-archive.js'), /for \(const t of mine\) st\.action\(t\.id, require\('\.\/scheduled-tasks'\)\.OWNER, 'delete'\);/);
  assert.doesNotMatch(read('lib/agent-archive.js'), /action\([^)]*'owner'/);
});
