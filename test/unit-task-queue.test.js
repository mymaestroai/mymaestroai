'use strict';
// Behavioural unit tests for lib/task-queue.js. The module hard-codes <hub>/data/task-queue.db and POSTs to 127.0.0.1:$PORT, so:
// lib/ is copied into a temp hub (node_modules symlinked for better-sqlite3), sdk-chat/auth are stubbed at the copy's paths,
// and PORT points at a loopback server that stands in for the hub's /api/chat. The 10 s check loop is driven with mock timers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
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
stub('sdk-chat.js', { isAgentActive: (a) => active.has(a) });
stub('auth.js', { SERVICE_HEADER: 'x-hub-service', SERVICE_TOKEN: 'svc-token-123' });

const hub = { status: 200, calls: [] };
let server, tq;
const quiet = { log: console.log, error: console.error };
test.before(async () => {
  console.log = () => {}; console.error = () => {};
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => { hub.calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body) }); res.writeHead(hub.status); res.end(hub.status === 200 ? 'turn done' : 'nope'); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.PORT = String(server.address().port);
  tq = require(path.join(HUB, 'lib', 'task-queue.js'));
});
test.after(() => { try { tq.stopTaskQueue(); } catch {} server.close(); console.log = quiet.log; console.error = quiet.error; fs.rmSync(ROOT, { recursive: true, force: true }); });
test.beforeEach(() => { hub.status = 200; hub.calls.length = 0; active.clear(); });

const mk = (over = {}) => tq.createTask({ creator_agent: 'maestro', target_agent: 'worker', trigger_type: 'delay', trigger_value: '5', action_prompt: 'do it', ...over });
// Direct read of one row by id, independent of listTasks' ordering and limit.
const Database = require(path.join(HUB, 'node_modules', 'better-sqlite3'));
const byId = (id) => { const d = new Database(DB, { readonly: true }); try { return d.prepare('SELECT * FROM tasks WHERE id = ?').get(id); } finally { d.close(); } };
async function until(fn, ms = 3000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); } }
async function runLoop(t, cycles = 1) { t.mock.timers.enable({ apis: ['setInterval'] }); tq.startTaskQueue(); for (let i = 0; i < cycles; i++) { t.mock.timers.tick(10000); await new Promise(r => setTimeout(r, 20)); } }

test('createTask: validation, execute_at per trigger, stored row shape', () => {
  assert.throws(() => mk({ trigger_type: 'cron' }), /Invalid trigger_type: cron/);
  assert.throws(() => mk({ trigger_value: 'soon' }), /delay trigger_value must be minutes/);
  assert.throws(() => mk({ trigger_value: '0' }), /delay trigger_value must be minutes/);
  const before = Date.now();
  const d = mk({ trigger_value: '5' });
  assert.deepStrictEqual(Object.keys(d), ['id', 'status', 'trigger_type', 'execute_at']);
  assert.strictEqual(d.status, 'pending');
  const at = Date.parse(d.execute_at);
  assert.ok(at >= before + 5 * 60000 && at <= Date.now() + 5 * 60000, 'delay = now + 5 min');
  const a = mk({ trigger_type: 'at_time', trigger_value: '2030-01-01T00:00:00Z' });
  assert.strictEqual(a.execute_at, '2030-01-01T00:00:00.000Z', 'at_time normalized to ISO');
  const local = mk({ trigger_type: 'at_time', trigger_value: '2030-06-01 12:00' });
  assert.strictEqual(local.execute_at, new Date('2030-06-01 12:00').toISOString(), 'non-ISO but parseable values are accepted');
  const w = mk({ trigger_type: 'when_agent_idle', trigger_value: 'trader' });
  assert.strictEqual(w.execute_at, null);
  const row = byId(w.id);
  assert.strictEqual(row.creator_agent, 'maestro'); assert.strictEqual(row.target_agent, 'worker');
  assert.strictEqual(row.trigger_value, 'trader'); assert.strictEqual(row.action_prompt, 'do it');
  assert.strictEqual(row.executed_at, null); assert.strictEqual(row.error, null);
  assert.match(row.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.ok(fs.existsSync(DB), 'db lives in the temp hub');
});

test('listTasks: filters by status and by agent (creator or target); limit option (default 200)', () => {
  mk({ creator_agent: 'alpha', target_agent: 'beta', trigger_value: '9' });
  mk({ creator_agent: 'gamma', target_agent: 'alpha', trigger_value: '9' });
  const alpha = tq.listTasks({ agent: 'alpha' });
  assert.deepStrictEqual(alpha.map(t => [t.creator_agent, t.target_agent]).sort(), [['alpha', 'beta'], ['gamma', 'alpha']]);
  assert.strictEqual(tq.listTasks({ status: 'completed' }).length, 0);
  assert.ok(tq.listTasks({ status: 'pending' }).length >= 5);
  for (let i = 0; i < 60; i++) mk({ creator_agent: 'bulk' });
  const all = tq.listTasks();
  assert.ok(all.length > 60 && all.length <= 200, `default limit 200 returns every row (${all.length})`);
  assert.strictEqual(tq.listTasks({ agent: 'bulk' }).length, 60);
  assert.strictEqual(tq.listTasks({ limit: 50 }).length, 50);
  assert.strictEqual(tq.listTasks({ limit: 1 }).length, 1);
  assert.strictEqual(tq.listTasks({ limit: '3' }).length, 3, 'string limit accepted');
  assert.ok(tq.listTasks({ limit: 'junk' }).length > 60, 'unparseable limit -> default');
  assert.strictEqual(tq.listTasks({ agent: 'alpha', limit: 50 }).length, 2, 'filters apply before the limit');
});

test('listTasks is newest-first even within the same second (id tiebreak on created_at)', () => {
  const ids = [mk({ creator_agent: 'tie' }).id, mk({ creator_agent: 'tie' }).id, mk({ creator_agent: 'tie' }).id];
  const rows = tq.listTasks({ agent: 'tie' });
  assert.deepStrictEqual(rows.map(r => r.id), [...ids].reverse());
  assert.strictEqual(tq.listTasks({ agent: 'tie', limit: 1 })[0].id, ids[2], 'limit keeps the newest rows');
});

test('cancelTask: only pending tasks, once', () => {
  const t = mk();
  assert.strictEqual(tq.cancelTask(t.id), true);
  assert.strictEqual(byId(t.id).status, 'cancelled');
  assert.strictEqual(tq.cancelTask(t.id), false);
  assert.strictEqual(tq.cancelTask(999999), false);
});

test('at_time in the past fires: hub /api/chat is called with the service header and the queued-task prompt; task completed', async (t) => {
  const task = mk({ trigger_type: 'at_time', trigger_value: '2020-01-01T00:00:00Z', action_prompt: 'ping the owner' });
  await runLoop(t);
  await until(() => byId(task.id).status === 'completed');
  const row = byId(task.id);
  assert.match(row.executed_at, /^\d{4}-/); assert.strictEqual(row.error, null);
  const call = hub.calls.find(c => c.body.message.includes('ping the owner'));
  assert.strictEqual(call.url, '/api/chat');
  assert.strictEqual(call.headers['x-hub-service'], 'svc-token-123');
  assert.deepStrictEqual(call.body, { agent: 'worker', message: 'QUEUED TASK (created by agent "maestro"):\n\nping the owner' });
  tq.stopTaskQueue();
});

test('at_time with an unparsable or missing value is rejected at creation; a genuinely future at_time stays pending', async (t) => {
  const countBefore = tq.listTasks().length;
  assert.throws(() => mk({ trigger_type: 'at_time', trigger_value: 'garbage' }), /parseable datetime.*"garbage"/);
  assert.throws(() => mk({ trigger_type: 'at_time', trigger_value: '' }), /parseable datetime/);
  assert.throws(() => mk({ trigger_type: 'at_time', trigger_value: undefined }), /parseable datetime/);
  assert.strictEqual(tq.listTasks().length, countBefore, 'nothing inserted for a rejected at_time');
  const future = mk({ trigger_type: 'at_time', trigger_value: '2999-01-01T00:00:00Z' });
  await runLoop(t, 3);
  assert.strictEqual(byId(future.id).status, 'pending', 'genuinely future task still pending');
  assert.strictEqual(hub.calls.filter(c => c.body.message.includes('do it') && c.body.agent === 'worker').length, 0);
  tq.stopTaskQueue();
});

test('when_agent_idle waits for the watched agent; a busy target is re-queued without a hub call', async (t) => {
  active.add('trader'); active.add('busybot');
  const idle = mk({ trigger_type: 'when_agent_idle', trigger_value: 'trader', target_agent: 'reporter', action_prompt: 'summarise trader' });
  const busyTarget = mk({ trigger_type: 'at_time', trigger_value: '2020-01-01T00:00:00Z', target_agent: 'busybot', action_prompt: 'for busybot' });
  await runLoop(t, 2);
  assert.strictEqual(byId(idle.id).status, 'pending');
  assert.strictEqual(byId(busyTarget.id).status, 'pending', 'target busy -> back to pending');
  assert.strictEqual(hub.calls.length, 0);
  active.delete('trader');
  t.mock.timers.tick(10000);
  await until(() => byId(idle.id).status === 'completed');
  assert.strictEqual(hub.calls[0].body.agent, 'reporter');
  tq.stopTaskQueue();
});

test('hub replies: 409 re-queues, other errors fail the task with the status and body, connection refused fails', async (t) => {
  hub.status = 409;
  const a = mk({ trigger_type: 'at_time', trigger_value: '2020-01-01T00:00:00Z', target_agent: 'h409' });
  await runLoop(t);
  await until(() => hub.calls.some(c => c.body.agent === 'h409'));
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(byId(a.id).status, 'pending');
  tq.cancelTask(a.id);
  hub.status = 500;
  const b = mk({ trigger_type: 'at_time', trigger_value: '2020-01-01T00:00:00Z', target_agent: 'h500' });
  t.mock.timers.tick(10000);
  await until(() => byId(b.id).status === 'failed');
  assert.strictEqual(byId(b.id).error, 'hub refused the turn (500): nope');
  tq.stopTaskQueue();
  await new Promise(r => server.close(r));
  const c = mk({ trigger_type: 'at_time', trigger_value: '2020-01-01T00:00:00Z', target_agent: 'hdown' });
  tq.startTaskQueue(); t.mock.timers.tick(10000);                // timers already mocked in this test
  await until(() => byId(c.id).status === 'failed');
  assert.match(byId(c.id).error, /ECONNREFUSED|socket hang up/);   // transport error recorded, task not retried
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
