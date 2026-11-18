'use strict';
// The scheduler's owner identity is '@owner', which no agent name can match: an agent named "owner" schedules with an
// agent's rights (for itself only, its own tasks, an agent's prompt limit) and its tasks never read as the owner's.
// Tasks saved with the old identity 'owner' become the owner's only when no agent has that name. Throwaway install and
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

function mk({ dataDir, names, archived = () => [], logs = [] } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'owner-id-'));
  const clock = { t: T0 };
  const woken = [];
  const inst = new st.ScheduledTasks({
    dataDir: dir, now: () => clock.t, log: (m) => logs.push(String(m)), retryMs: 1000, pollMs: 60000,
    agentExists: async (n) => ['owner', 'trader', 'maestro'].includes(n),
    isPrivileged: (n) => n === 'maestro',
    agentNamesSync: names === undefined ? undefined : names,
    archivedNamesSync: archived === null ? undefined : archived,   // null: not given
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

test('tasks saved as the old "owner": the owner\'s when no agent has that name (saved as @owner); kept as an agent\'s while one does, or when the names can\'t be read', () => {
  // no agent named owner: migrated and saved
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-id-m-'));
  saved(dir, [oldTask('st-a', 'owner'), oldTask('st-b', 'trader')]);
  let r = mk({ dataDir: dir, names: () => ['trader', 'maestro'] });
  assert.equal(r.inst.tasks.get('st-a').createdBy, '@owner');
  assert.equal(r.inst.tasks.get('st-b').createdBy, 'trader');
  assert.equal(JSON.parse(fs.readFileSync(r.inst.file, 'utf8')).tasks.find(t => t.id === 'st-a').createdBy, '@owner', 'written back');
  assert.ok(r.logs.some(l => /moved to the owner's new identity/.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
  // an agent named owner exists: kept, logged
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-id-m-'));
  saved(dir, [oldTask('st-a', 'owner')]);
  r = mk({ dataDir: dir, names: () => ['owner', 'trader'] });
  assert.equal(r.inst.tasks.get('st-a').createdBy, 'owner');
  assert.ok(r.logs.some(l => /kept as the agent "owner"'s/.test(l)));
  assert.throws(() => r.inst.action('st-a', 'trader', 'cancel'), /only "owner" \(who created it\) or the owner can/);
  fs.rmSync(dir, { recursive: true, force: true });
  // a deleted agent was named owner (its bundle): kept, logged
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-id-m-'));
  saved(dir, [oldTask('st-a', 'owner')]);
  r = mk({ dataDir: dir, names: () => ['trader'], archived: () => ['scout', 'owner'] });
  assert.equal(r.inst.tasks.get('st-a').createdBy, 'owner');
  assert.ok(r.logs.some(l => /kept as an agent's: a deleted agent had that name/.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
  // either list unreadable or not given: kept
  for (const [names, archived] of [[() => { throw new Error('x'); }, () => []], [undefined, () => []], [() => [], () => { throw new Error('x'); }], [() => [], null]]) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-id-m-'));
    saved(dir, [oldTask('st-a', 'owner')]);
    r = mk({ dataDir: dir, names, archived });
    assert.equal(r.inst.tasks.get('st-a').createdBy, 'owner');
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('wiring: the hub gives the scheduler the agents\' names and the deleted agents\' names; the panel shows the owner\'s and the hub\'s tasks in words; deleting an agent deletes its tasks as the owner', () => {
  const sdk = read('lib/sdk-chat.js');
  assert.match(sdk, /agentNamesSync: \(\) => require\('\.\/agents'\)\.getAgentsSync\(\)\.map\(a => a && a\.name\)\.filter\(Boolean\),/);
  assert.match(sdk, /archivedNamesSync: \(\) => archivedAgentNames\(path\.join\(HUB_DIR, 'data', 'archived-agents'\)\),/);
  // archivedAgentNames, run on its own source: bundle names, no folder = none, any other error throws
  const i = sdk.indexOf('function archivedAgentNames(dir) {');
  const fn = new Function('fs', sdk.slice(i, sdk.indexOf('\n}\n', i) + 2) + '\nreturn archivedAgentNames;')(fs);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-id-arch-'));
  for (const n of ['owner-20261105T163000Z', 'scout_2-20261101T010203Z-2', 'rename-me-20261102T000000Z.partial', 'stray']) fs.mkdirSync(path.join(d, n));
  assert.deepEqual(fn(d).sort(), ['owner', 'rename-me', 'scout_2']);
  assert.deepEqual(fn(path.join(d, 'none')), []);
  fs.writeFileSync(path.join(d, 'file'), 'x');
  assert.throws(() => fn(path.join(d, 'file')));
  fs.rmSync(d, { recursive: true, force: true });
  assert.match(read('lib/agent-archive.js'), /for \(const t of mine\) st\.action\(t\.id, require\('\.\/scheduled-tasks'\)\.OWNER, 'delete'\);/);
  assert.doesNotMatch(read('lib/agent-archive.js'), /action\([^)]*'owner'/);
  assert.match(read('app.js'), /by \$\{esc\(t\.createdBy === '@owner' \? 'you' : t\.createdBy === '@hub' \? 'the hub' : t\.createdBy\)\}/);
});
