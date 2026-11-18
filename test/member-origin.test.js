'use strict';
// A member's turn on an admin's agent (shared with the member), or a turn a member's agent set off, carries the member
// origin into everything it starts: workers, consults (queued too, and their replies), scheduled tasks, jobs, queued
// tasks. Each of those turns then counts as a member's: Max effort, Standard speed, and the members' worker-model rule
// while it is on. lib/ comes from a throwaway install and temp folders: nothing under the real data/ is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('member-origin-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const ROOT = path.join(__dirname, '..');
const SDK = fs.readFileSync(path.join(ROOT, 'lib', 'sdk-chat.js'), 'utf8');
const grab = (start) => { const i = SDK.indexOf(start); assert.ok(i >= 0, start); return SDK.slice(i, SDK.indexOf('\n}\n', i) + 2); };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }

// ── consult queue ──
test('consult queue: a member\'s request is stored as such, a duplicate from a member\'s turn marks the queued one, never the reverse; its reply keeps it', async () => {
  const { ConsultQueue } = L('consult-queue');
  const d = tmp('mo-cq-');
  const q = new ConsultQueue({ file: path.join(d, 'q.json') });
  const a = q.enqueue({ from: 'doc', to: 'counsel', prompt: 'p1', member: true });
  assert.equal(a.job.member, true);
  const b = q.enqueue({ from: 'doc', to: 'counsel', prompt: 'p2' });
  assert.equal(b.job.member, undefined);
  q.enqueue({ from: 'doc', to: 'counsel', prompt: 'p2', member: true });
  assert.equal(q.pendingFor('counsel').find(j => j.prompt === 'p2').member, true, 'upgraded by the member\'s duplicate');
  const c = q.enqueue({ from: 'doc', to: 'scout', prompt: 'p3', member: true });
  q.enqueue({ from: 'doc', to: 'scout', prompt: 'p3' });
  assert.equal(c.job.member, true, 'an ordinary duplicate never clears it');
  assert.equal(q.mailboxHasMember('doc'), false);
  const ran = [];
  await q.drain({ isActive: () => false, exists: async () => true, run: async (job) => { ran.push(job.member === true); return 'answer'; } });
  assert.equal(ran.includes(true), true, 'the drained job carries it to the run');
  assert.equal(q.mailboxHasMember('doc'), true, 'the reply in the caller\'s mailbox keeps it');
  assert.ok(q.takeMailbox('doc').filter(r => r.member === true).length >= 1);
  assert.equal(q.mailboxHasMember('doc'), false);
  // persisted
  const q2 = new ConsultQueue({ file: path.join(d, 'q.json') });
  q2.enqueue({ from: 'x', to: 'y', prompt: 'z', member: true });
  assert.equal(new ConsultQueue({ file: path.join(d, 'q.json') }).pendingFor('y')[0].member, true);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── scheduled tasks ──
test('schedule_task: a task made in a member\'s turn is marked from the hub\'s context (never the tool\'s arguments) and each run says so', async () => {
  const st = L('scheduled-tasks');
  process.env.HUB_TZ = 'America/New_York';
  L('timezone')._setDeps({ auth: { admins: () => [], getUser: () => null }, agents: () => [] });
  const dataDir = tmp('mo-st-');
  const clock = { t: Date.parse('2026-09-29T18:00:00Z') };
  const woken = [];
  const inst = new st.ScheduledTasks({
    dataDir, now: () => clock.t, log: () => {}, retryMs: 1000, pollMs: 60000,
    agentExists: async () => true, isAgentActive: () => false,
    notify: async (agent, message, onReply, meta) => { woken.push({ agent, meta }); },
  });
  const spec = st.TOOL_SPECS.find(s => s.name === 'schedule_task');
  const made = JSON.parse(await st.runTool(inst, spec, 'doc', { when: 'in 5 minutes', prompt: 'check the result' }, { member: true }));
  const plain = JSON.parse(await st.runTool(inst, spec, 'doc', { when: 'in 5 minutes', prompt: 'other', member: true }, { member: false }));
  assert.equal(made.member, true);
  assert.equal(plain.member, undefined, 'an argument named member is ignored');
  clock.t += 6 * 60000;
  await inst.tick();
  const byTask = Object.fromEntries(woken.map(w => [w.meta.taskId, w.meta]));
  assert.equal(byTask[made.id].member, true);
  assert.equal(byTask[plain.id].member, undefined);
  // update cannot change it
  const m2 = JSON.parse(await st.runTool(inst, spec, 'doc', { when: 'every day at 9am', prompt: 'daily' }, { member: true }));
  await inst.update(m2.id, 'doc', { prompt: 'daily, changed', member: false }).catch(() => {});
  assert.equal(inst.list('doc', { includeDone: true }).find(t => t.id === m2.id).member, true);
  inst.stop && inst.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── jobs ──
test('run_job: a job started in a member\'s turn is marked, and its notice says so; others are not', async () => {
  const { JobRunner, TOOL_SPECS, runTool } = L('jobs');
  const dataDir = tmp('mo-jobs-');
  const notes = [];
  const runner = new JobRunner({
    dataDir, spawnMode: 'setsid', pollMs: 100, retryMs: 150, log: () => {},
    notify: async (agent, message, onReply, meta) => { notes.push({ agent, meta }); },
    isAgentActive: () => false, agentExists: async () => true, defaultCwd: async () => dataDir,
  });
  runner.start();
  const spec = TOOL_SPECS.find(s => s.name === 'run_job');
  const m = JSON.parse(await runTool(runner, spec, 'doc', { name: 'm', command: 'true' }, { member: true }));
  const o = JSON.parse(await runTool(runner, spec, 'doc', { name: 'o', command: 'true', member: true }, {}));
  assert.ok(await until(() => notes.length >= 2), 'both notices delivered');
  const meta = Object.fromEntries(notes.map(n => [n.meta.jobId, n.meta]));
  assert.equal(meta[m.id].member, true);
  assert.equal(meta[o.id].member, undefined, 'an argument named member is ignored');
  runner.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── task queue ──
test('create_task: a member\'s task is stored with the flag (an older database gets the column) and its turn says so', async () => {
  const tq = L('task-queue');
  const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  const d = tmp('mo-tq-');
  const dbPath = path.join(d, 'tasks.db');
  // an older database: the table without the member column
  const old = new Database(dbPath);
  old.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, creator_agent TEXT NOT NULL, target_agent TEXT NOT NULL, trigger_type TEXT NOT NULL, trigger_value TEXT, action_prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), execute_at TEXT, executed_at TEXT, result TEXT, error TEXT)`);
  old.close();
  const started = [];
  tq.configureTaskQueue({ dbPath, mayStart: async () => ({ ok: true }), startTurn: async (agent, msg, opts) => { started.push({ agent, origin: opts.origin }); return { done: Promise.resolve('') }; }, isAgentActive: () => false });
  const a = await tq.createTask({ creator_agent: 'doc', target_agent: 'doc', trigger_type: 'delay', trigger_value: '1', action_prompt: 'x', member: true });
  const b = await tq.createTask({ creator_agent: 'doc', target_agent: 'doc', trigger_type: 'delay', trigger_value: '1', action_prompt: 'y' });
  const db = new Database(dbPath);
  const rows = Object.fromEntries(db.prepare('SELECT id, member FROM tasks').all().map(r => [r.id, r.member]));
  db.close();
  assert.equal(rows[a.id], 1); assert.equal(rows[b.id], 0);
  // the queued turn's origin carries it
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'task-queue.js'), 'utf8');
  assert.match(src, /taskId: String\(task\.id\), \.\.\.\(Number\(task\.member\) === 1 \? \{ member: true \} : \{\}\) \}/);
  const pt = fs.readFileSync(path.join(ROOT, 'lib', 'provider-tools.js'), 'utf8');
  assert.match(pt, /member: context\?\.member === true,   \/\/ set by the hub from the calling turn, never from the tool's arguments/);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── the spawn_workers model rule ──
test('spawn_workers: an admin\'s agent in a member\'s turn gets the members\' rule over its own model while the entry is on; off or pending: no limit (caps only)', () => {
  let state = 'on';
  const members = new Set();
  const ctx = {
    require: (p) => {
      if (p === './behaviour-changes') return { stateOf: () => state };
      if (p === './agents') return { getAgentsSync: () => [{ name: 'doc', model: 'a/opus', owner: 'admin1' }, { name: 'maestro', model: 'a/opus' }] };
      if (p === './member-models') return { workerModels: (own) => [own, 'a/sonnet'] };
      throw new Error('unexpected ' + p);
    },
    resolveVirtualAgent: () => null, adminIdSet: () => new Set(['admin1']), temporalWorkers: { isSelfCheck: () => false },
    isMemberTurn: (n) => members.has(n),
  };
  vm.createContext(ctx);
  vm.runInContext(grab('function memberWorkerModels(') + '\nthis.f = memberWorkerModels;', ctx);
  assert.equal(ctx.f('doc'), null, 'the admin\'s own turn: no limit, as before');
  members.add('doc');
  assert.deepEqual([...ctx.f('doc')], ['a/opus', 'a/sonnet'], 'a member\'s turn on it: its own model and the members\' list');
  assert.equal(ctx.f('maestro'), null, 'another agent not in a member\'s turn');
  for (const s of ['off', 'pending', 'missing']) { state = s; assert.equal(ctx.f('doc'), null, `${s}: no model limit (the effort and speed caps still apply)`); }
  state = 'unreadable';
  assert.deepEqual([...ctx.f('doc')], ['a/opus', 'a/sonnet'], 'unreadable: the limit stays');
  assert.deepEqual([...ctx.f('doc', { memberTurn: true })], ['a/opus', 'a/sonnet']);
});

// ── the chat handler and the paths in lib/sdk-chat ──
test('sdk-chat: a member\'s turn (typed by a member, or with origin.member, or set off by a member\'s agent) is recorded while it runs', () => {
  assert.match(SDK, /const memberTurnAgents = new Map\(\);\nfunction isMemberTurn\(agentName\) \{ return !!agentName && \(memberTurnAgents\.get\(agentName\) \|\| 0\) > 0; \}/);
  assert.match(SDK, /const memberOrigin = !!\(turnOrigin && turnOrigin\.member === true\) \|\| originFromMemberAgent\(/);
  assert.match(SDK, /if \(memberTurn \|\| memberOrigin\) \{ memberTurnAgents\.set\(agent, \(memberTurnAgents\.get\(agent\) \|\| 0\) \+ 1\); memberMarked = true; \}/);
  assert.match(SDK, /if \(ownerTurn\) ownerTurnAgents\.delete\(agent\);\n    if \(memberMarked\) \{ const n = \(memberTurnAgents\.get\(agent\) \|\| 1\) - 1; if \(n > 0\) memberTurnAgents\.set\(agent, n\); else memberTurnAgents\.delete\(agent\); \}/);
  // the mark as a counter: two overlapping member turns, one ends, the other is still marked
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(SDK.match(/const memberTurnAgents = new Map\(\);\nfunction isMemberTurn[^\n]*/)[0] + '\nthis.m = memberTurnAgents; this.is = isMemberTurn;', ctx);
  const mark = (a) => ctx.m.set(a, (ctx.m.get(a) || 0) + 1);
  const unmark = (a) => { const n = (ctx.m.get(a) || 1) - 1; if (n > 0) ctx.m.set(a, n); else ctx.m.delete(a); };
  mark('doc'); mark('doc'); unmark('doc');
  assert.equal(ctx.is('doc'), true);
  unmark('doc');
  assert.equal(ctx.is('doc'), false);
  assert.equal(ctx.is(''), false); assert.equal(ctx.is(null), false);
  // origin is a hub-only field: a person's or a program's request cannot set member
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /const HUB_ONLY_CHAT_FIELDS = \[[^\]]*'origin'/);
});

test('sdk-chat: consults and workers, queued consults, their delivery turn, scheduled tasks, jobs and queued tasks all carry it', () => {
  assert.match(SDK, /const consultMember = opts\.member !== undefined \? opts\.member === true : isMemberTurn\(coordinatorName\);/);
  assert.match(SDK, /origin: \{ kind: opts\.temporal \? 'task' : 'consultation', from: coordinatorName \|\| null, \.\.\.\(consultMember \? \{ member: true \} : \{\}\) \}/);
  assert.match(SDK, /enqueue\(\{ from: coordinatorName, to: agentName, prompt, depth, turnId: callerTurn \? callerTurn\.turnId : null, member: consultMember \}\)/);
  assert.match(SDK, /holdConsultForCall\(agentName, prompt, coordinatorName, \{ depth, turnId: callerTurn \? callerTurn\.turnId : null, member: consultMember \}\)/);
  assert.match(SDK, /q\.enqueue\(\{ from: coordinatorName, to: agentName, prompt, depth, turnId, member: member === true \}\)/);
  assert.match(SDK, /queuedRun: true, queuedTurnId: job\.turnId \|\| null, member: job\.member === true \}/);
  assert.match(SDK, /wakeAgent\(owner, DELIVERY_NOTE, null, \{ kind: 'consult_reply', from: 'hub', \.\.\.\(q\.mailboxHasMember\(owner\) \? \{ member: true \} : \{\}\) \}\)/);
  assert.match(SDK, /\.\.\.\(meta\?\.label \? \{ label: meta\.label \} : \{\}\), \.\.\.\(meta\?\.member === true \? \{ member: true \} : \{\}\) \};/);
  assert.equal((SDK.match(/\{ consultedBy, member: isMemberTurn\(agentName\) \}/g) || []).length, 4, 'schedule_task and run_job on both tool paths');
  assert.match(SDK, /return def\.handler\(args, \{ agentName, member: isMemberTurn\(agentName\) \}\);/);
  // the worker model check uses the turn
  assert.match(SDK, /function memberWorkerModels\(agentName, \{ memberTurn = isMemberTurn\(agentName\) \} = \{\}\) \{/);
  assert.match(SDK, /if \(!memberTurn && \(!rec\.owner \|\| adminIdSet\(\)\.has\(String\(rec\.owner\)\)\)\) return null;/);
});

test('sdk-chat: the effort and speed caps come from the same memberOrigin (Codex Ultra to Max, Standard speed)', () => {
  assert.match(SDK, /const turnTier = \(memberTurn \|\| memberOrigin\) \? 'standard' : await agentTier\(agent\);/);
  assert.match(SDK, /if \(codexEffort === 'ultra' && \(options\.memberTurn \|\| options\.simpleTurn \|\| options\.memberOrigin\)\) codexEffort = 'max';/);
  assert.match(SDK, /let codexServiceTier = \(options\.memberTurn \|\| options\.memberOrigin\) \? null :/);
});
