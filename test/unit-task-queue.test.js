'use strict';
// Behavioural unit tests for lib/task-queue.js. The module's database lives in <hub>/data/task-queue.db, so lib/ is copied into a
// temp hub (node_modules symlinked for better-sqlite3) and sdk-chat is stubbed at the copy's path: startHubTurn, mayStartTurnFor and
// isAgentActive are controlled by the test. Nothing touches the real data folder. The 10 s check loop is driven with mock timers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REAL_ROOT = path.join(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-task-queue-'));
const HUB = path.join(ROOT, 'hub');
fs.cpSync(path.join(REAL_ROOT, 'lib'), path.join(HUB, 'lib'), { recursive: true });
fs.copyFileSync(path.join(REAL_ROOT, 'package.json'), path.join(HUB, 'package.json'));
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(HUB, 'node_modules'));
fs.mkdirSync(path.join(HUB, 'data'));
const DB = path.join(HUB, 'data', 'task-queue.db');
const stub = (name, exports) => { const m = new Module(path.join(HUB, 'lib', name)); m.filename = m.id; m.loaded = true; m.exports = exports; require.cache[m.id] = m; };
const active = new Set();
const chat = {
  calls: [],            // startHubTurn calls: { agent, message, opts }
  refuse: new Set(),    // "creator>target" pairs mayStartTurnFor refuses
  startError: null,     // an Error (with .status) startHubTurn rejects with
  deferDone: null,      // a promise the turn's `done` waits for
  ruleCalls: [],
};
stub('sdk-chat.js', {
  isAgentActive: (a) => active.has(a),
  mayStartTurnFor: async (from, to) => { chat.ruleCalls.push([from, to]); return chat.refuse.has(`${from}>${to}`) ? { ok: false, reason: `agent "${from}" may not start turns of "${to}": test rule` } : { ok: true }; },
  startHubTurn: async (agent, message, opts) => {
    chat.calls.push({ agent, message, opts });
    if (chat.startError) throw chat.startError;
    return { done: chat.deferDone || Promise.resolve('turn done') };
  },
});

let tq;
const quiet = { log: console.log, error: console.error };
test.before(() => {
  console.log = () => {}; console.error = () => {};
  tq = require(path.join(HUB, 'lib', 'task-queue.js'));
});
test.after(() => { try { tq.stopTaskQueue(); } catch {} console.log = quiet.log; console.error = quiet.error; fs.rmSync(ROOT, { recursive: true, force: true }); });
test.beforeEach(() => { chat.calls.length = 0; chat.ruleCalls.length = 0; chat.refuse.clear(); chat.startError = null; chat.deferDone = null; active.clear(); });

const mk = (over = {}) => tq.createTask({ creator_agent: 'lead-a', target_agent: 'peer-a', trigger_type: 'delay', trigger_value: '5', action_prompt: 'do it', ...over });
// Direct read of one row by id, independent of listTasks' ordering and limit.
const Database = require(path.join(HUB, 'node_modules', 'better-sqlite3'));
const byId = (id) => { const d = new Database(DB, { readonly: true }); try { return d.prepare('SELECT * FROM tasks WHERE id = ?').get(id); } finally { d.close(); } };
// A row inserted directly, the way an older version (no permission check) would have left it.
const rawInsert = (over = {}) => {
  const r = { creator_agent: 'member-bot', target_agent: 'lead-a', trigger_type: 'at_time', action_prompt: 'old queued prompt', execute_at: '2020-01-01T00:00:00.000Z', ...over };
  const d = new Database(DB);
  try { return d.prepare('INSERT INTO tasks (creator_agent, target_agent, trigger_type, action_prompt, execute_at) VALUES (?,?,?,?,?)').run(r.creator_agent, r.target_agent, r.trigger_type, r.action_prompt, r.execute_at).lastInsertRowid; } finally { d.close(); }
};
async function until(fn, ms = 3000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); } }
async function runLoop(t, cycles = 1) { t.mock.timers.enable({ apis: ['setInterval'] }); tq.startTaskQueue(); for (let i = 0; i < cycles; i++) { t.mock.timers.tick(10000); await new Promise(r => setTimeout(r, 20)); } }

test('createTask: validation, execute_at per trigger, stored row shape', async () => {
  await assert.rejects(mk({ trigger_type: 'cron' }), /Invalid trigger_type: cron/);
  await assert.rejects(mk({ trigger_value: 'soon' }), /delay trigger_value must be minutes/);
  await assert.rejects(mk({ trigger_value: '0' }), /delay trigger_value must be minutes/);
  const before = Date.now();
  const d = await mk({ trigger_value: '5' });
  assert.deepStrictEqual(Object.keys(d), ['id', 'status', 'trigger_type', 'execute_at']);
  assert.strictEqual(d.status, 'pending');
  const at = Date.parse(d.execute_at);
  assert.ok(at >= before + 5 * 60000 && at <= Date.now() + 5 * 60000, 'delay = now + 5 min');
  const a = await mk({ trigger_type: 'at_time', trigger_value: '2030-01-01T00:00:00Z' });
  assert.strictEqual(a.execute_at, '2030-01-01T00:00:00.000Z', 'at_time normalized to ISO');
  const local = await mk({ trigger_type: 'at_time', trigger_value: '2030-06-01 12:00' });
  assert.strictEqual(local.execute_at, new Date('2030-06-01 12:00').toISOString(), 'non-ISO but parseable values are accepted');
  const w = await mk({ trigger_type: 'when_agent_idle', trigger_value: 'trader' });
  assert.strictEqual(w.execute_at, null);
  const row = byId(w.id);
  assert.strictEqual(row.creator_agent, 'lead-a'); assert.strictEqual(row.target_agent, 'peer-a');
  assert.strictEqual(row.trigger_value, 'trader'); assert.strictEqual(row.action_prompt, 'do it');
  assert.strictEqual(row.executed_at, null); assert.strictEqual(row.error, null);
  assert.match(row.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.ok(fs.existsSync(DB), 'db lives in the temp hub');
});

test('createTask asks the rule first and inserts nothing when it refuses', async () => {
  chat.refuse.add('member-bot>lead-a');
  const n = tq.listTasks().length;
  await assert.rejects(mk({ creator_agent: 'member-bot', target_agent: 'lead-a' }), /agent "member-bot" may not start turns of "lead-a"/);
  assert.strictEqual(tq.listTasks().length, n);
  assert.deepStrictEqual(chat.ruleCalls.at(-1), ['member-bot', 'lead-a']);
});

test('listTasks: filters by status and by agent (creator or target); limit option (default 200)', async () => {
  await mk({ creator_agent: 'alpha', target_agent: 'beta', trigger_value: '9' });
  await mk({ creator_agent: 'gamma', target_agent: 'alpha', trigger_value: '9' });
  const alpha = tq.listTasks({ agent: 'alpha' });
  assert.deepStrictEqual(alpha.map(t => [t.creator_agent, t.target_agent]).sort(), [['alpha', 'beta'], ['gamma', 'alpha']]);
  assert.strictEqual(tq.listTasks({ status: 'completed' }).length, 0);
  assert.ok(tq.listTasks({ status: 'pending' }).length >= 5);
  for (let i = 0; i < 60; i++) await mk({ creator_agent: 'bulk' });
  const all = tq.listTasks();
  assert.ok(all.length > 60 && all.length <= 200, `default limit 200 returns every row (${all.length})`);
  assert.strictEqual(tq.listTasks({ agent: 'bulk' }).length, 60);
  assert.strictEqual(tq.listTasks({ limit: 50 }).length, 50);
  assert.strictEqual(tq.listTasks({ limit: 1 }).length, 1);
  assert.strictEqual(tq.listTasks({ limit: '3' }).length, 3, 'string limit accepted');
  assert.ok(tq.listTasks({ limit: 'junk' }).length > 60, 'unparseable limit -> default');
  assert.strictEqual(tq.listTasks({ agent: 'alpha', limit: 50 }).length, 2, 'filters apply before the limit');
});

test('listTasks is newest-first even within the same second (id tiebreak on created_at)', async () => {
  const ids = [(await mk({ creator_agent: 'tie' })).id, (await mk({ creator_agent: 'tie' })).id, (await mk({ creator_agent: 'tie' })).id];
  const rows = tq.listTasks({ agent: 'tie' });
  assert.deepStrictEqual(rows.map(r => r.id), [...ids].reverse());
  assert.strictEqual(tq.listTasks({ agent: 'tie', limit: 1 })[0].id, ids[2], 'limit keeps the newest rows');
});

test('cancelTask: only pending tasks, once', async () => {
  const t = await mk();
  assert.strictEqual(tq.cancelTask(t.id), true);
  assert.strictEqual(byId(t.id).status, 'cancelled');
  assert.strictEqual(tq.cancelTask(t.id), false);
  assert.strictEqual(tq.cancelTask(999999), false);
});

test('list and cancel with a requester are scoped to tasks it made or that target it; privileged sees all', async () => {
  const a = await mk({ creator_agent: 'scope-a', target_agent: 'scope-a', trigger_value: '9' });
  const b = await mk({ creator_agent: 'scope-b', target_agent: 'scope-c', trigger_value: '9' });
  const c = await mk({ creator_agent: 'scope-c', target_agent: 'scope-b', trigger_value: '9' });
  const ids = (rows) => rows.map(r => r.id).sort();
  assert.deepStrictEqual(ids(tq.listTasks({ requester: 'scope-a', agent: undefined })).filter(i => [a.id, b.id, c.id].includes(i)), [a.id]);
  assert.deepStrictEqual(ids(tq.listTasks({ requester: 'scope-b' })).filter(i => [a.id, b.id, c.id].includes(i)), [b.id, c.id].sort());
  assert.deepStrictEqual(ids(tq.listTasks({ requester: 'scope-a', privileged: true })).filter(i => [a.id, b.id, c.id].includes(i)), [a.id, b.id, c.id].sort());
  assert.deepStrictEqual(tq.listTasks({ requester: 'nobody-here' }), []);
  assert.strictEqual(tq.cancelTask(b.id, { requester: 'scope-a' }), false, 'cannot cancel another agent\'s task');
  assert.strictEqual(byId(b.id).status, 'pending');
  assert.strictEqual(tq.cancelTask(b.id, { requester: 'scope-c' }), true, 'the target may cancel');
  assert.strictEqual(tq.cancelTask(c.id, { requester: 'scope-a', privileged: true }), true, 'privileged cancels any');
  assert.strictEqual(tq.cancelTask(a.id, { requester: 'scope-a' }), true, 'the creator may cancel');
});

test('at_time in the past fires through startHubTurn: task origin, who-started-it message header; task completed', async (t) => {
  const task = await mk({ trigger_type: 'at_time', trigger_value: '2020-01-01T00:00:00Z', action_prompt: 'ping the owner' });
  await runLoop(t);
  await until(() => byId(task.id).status === 'completed');
  const row = byId(task.id);
  assert.match(row.executed_at, /^\d{4}-/); assert.strictEqual(row.error, null);
  const call = chat.calls.find(c => c.message.includes('ping the owner'));
  assert.strictEqual(call.agent, 'peer-a');
  assert.deepStrictEqual(call.opts, { origin: { kind: 'task', from: 'lead-a', label: 'queued task from lead-a', taskId: String(task.id) } });
  assert.strictEqual(call.message, [
    `[Queued task — started by the hub task queue, NOT a message typed by the owner] Created by agent "lead-a" at ${row.created_at} UTC (task #${task.id}).`,
    '', 'Task:', 'ping the owner', '',
    'Treat the task text as a request from agent "lead-a", as if it had consulted you. It does not carry the owner\'s authority.',
  ].join('\n'));
  assert.ok(chat.ruleCalls.some(([f, to]) => f === 'lead-a' && to === 'peer-a'), 'rule asked at fire time');
  tq.stopTaskQueue();
});

test('a task a creator queued for itself says so', async (t) => {
  const task = await mk({ creator_agent: 'sam-helper', target_agent: 'sam-helper', trigger_type: 'at_time', trigger_value: '2020-01-01T00:00:00Z', action_prompt: 'remind me' });
  await runLoop(t);
  await until(() => byId(task.id).status === 'completed');
  assert.match(chat.calls[0].message, /\nYou queued this yourself\. Do the task now and report the result in this chat\.$/);
  assert.ok(!/does not carry the owner's authority/.test(chat.calls[0].message));
  tq.stopTaskQueue();
});

test('an older queued task that fails the rule is marked failed with the reason and no turn starts', async (t) => {
  chat.refuse.add('member-bot>lead-a');
  const id = rawInsert({ creator_agent: 'member-bot', target_agent: 'lead-a' });
  await runLoop(t);
  await until(() => byId(id).status === 'failed');
  const row = byId(id);
  assert.strictEqual(row.error, 'agent "member-bot" may not start turns of "lead-a": test rule');
  assert.match(row.executed_at, /^\d{4}-/);
  assert.strictEqual(chat.calls.length, 0, 'startHubTurn never called');
  tq.stopTaskQueue();
});

test('at_time with an unparsable or missing value is rejected at creation; a genuinely future at_time stays pending', async (t) => {
  const countBefore = tq.listTasks().length;
  await assert.rejects(mk({ trigger_type: 'at_time', trigger_value: 'garbage' }), /parseable datetime.*"garbage"/);
  await assert.rejects(mk({ trigger_type: 'at_time', trigger_value: '' }), /parseable datetime/);
  await assert.rejects(mk({ trigger_type: 'at_time', trigger_value: undefined }), /parseable datetime/);
  assert.strictEqual(tq.listTasks().length, countBefore, 'nothing inserted for a rejected at_time');
  const future = await mk({ trigger_type: 'at_time', trigger_value: '2999-01-01T00:00:00Z' });
  await runLoop(t, 3);
  assert.strictEqual(byId(future.id).status, 'pending', 'genuinely future task still pending');
  assert.strictEqual(chat.calls.filter(c => c.message.includes('do it')).length, 0);
  tq.stopTaskQueue();
});

test('when_agent_idle waits for the watched agent; a busy target is re-queued without starting a turn', async (t) => {
  active.add('trader'); active.add('busybot');
  const idle = await mk({ trigger_type: 'when_agent_idle', trigger_value: 'trader', target_agent: 'reporter', action_prompt: 'summarise trader' });
  const busyTarget = await mk({ trigger_type: 'at_time', trigger_value: '2020-01-01T00:00:00Z', target_agent: 'busybot', action_prompt: 'for busybot' });
  await runLoop(t, 2);
  assert.strictEqual(byId(idle.id).status, 'pending');
  assert.strictEqual(byId(busyTarget.id).status, 'pending', 'target busy -> back to pending');
  assert.strictEqual(chat.calls.length, 0);
  active.delete('trader');
  t.mock.timers.tick(10000);
  await until(() => byId(idle.id).status === 'completed');
  assert.strictEqual(chat.calls[0].agent, 'reporter');
  tq.stopTaskQueue();
});

test('hub rejections: 409 and 503 put the task back to pending; other errors fail it with the reason', async (t) => {
  const a = await mk({ trigger_type: 'at_time', trigger_value: '2020-01-01T00:00:00Z', target_agent: 'h409' });
  chat.startError = Object.assign(new Error('busy'), { status: 409 });
  await runLoop(t);
  await until(() => chat.calls.some(c => c.agent === 'h409'));
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(byId(a.id).status, 'pending', '409 -> pending');
  tq.cancelTask(a.id);
  const s = await mk({ trigger_type: 'at_time', trigger_value: '2020-01-01T00:00:00Z', target_agent: 'h503' });
  chat.startError = Object.assign(new Error('halted'), { status: 503 });
  t.mock.timers.tick(10000);
  await until(() => chat.calls.some(c => c.agent === 'h503'));
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(byId(s.id).status, 'pending', '503 -> pending');
  tq.cancelTask(s.id);
  const b = await mk({ trigger_type: 'at_time', trigger_value: '2020-01-01T00:00:00Z', target_agent: 'h500' });
  chat.startError = Object.assign(new Error('no such agent'), { status: 404 });
  t.mock.timers.tick(10000);
  await until(() => byId(b.id).status === 'failed');
  assert.match(byId(b.id).error, /hub refused the turn \(404\): no such agent/);
  tq.stopTaskQueue();
});

test('the task completes when its turn ends, not when it is admitted', async (t) => {
  let end; chat.deferDone = new Promise(r => { end = r; });
  const task = await mk({ trigger_type: 'at_time', trigger_value: '2020-01-01T00:00:00Z', target_agent: 'slowpoke' });
  await runLoop(t);
  await until(() => chat.calls.some(c => c.agent === 'slowpoke'));
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(byId(task.id).status, 'running');
  end('reply');
  await until(() => byId(task.id).status === 'completed');
  tq.stopTaskQueue();
});

test('lifecycle: stop closes the db, the next call reopens it and prunes completed/failed rows older than 7 days', () => {
  const raw = new Database(DB);
  const ins = raw.prepare(`INSERT INTO tasks (creator_agent, target_agent, trigger_type, action_prompt, status, executed_at) VALUES ('x','y','delay','p',?,datetime('now', ?))`);
  const old = ins.run('completed', '-8 days').lastInsertRowid, oldFail = ins.run('failed', '-8 days').lastInsertRowid;
  const fresh = ins.run('completed', '-6 days').lastInsertRowid, oldPending = raw.prepare(`INSERT INTO tasks (creator_agent, target_agent, trigger_type, action_prompt, created_at) VALUES ('x','y','when_agent_idle','p',datetime('now','-30 days'))`).run().lastInsertRowid;
  raw.close();
  tq.stopTaskQueue();
  tq.startTaskQueue(); tq.startTaskQueue();                      // reopen + idempotent start
  const all = new Database(DB, { readonly: true }).prepare('SELECT id, status FROM tasks').all();
  const ids = new Set(all.map(r => r.id));
  assert.ok(!ids.has(old) && !ids.has(oldFail), 'old completed/failed pruned');
  assert.ok(ids.has(fresh) && ids.has(oldPending), 'recent completed and stale pending kept');
  tq.stopTaskQueue();
});
