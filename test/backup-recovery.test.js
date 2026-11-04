'use strict';
// Recovery mode (lib/backup/recovery.js): after a restore, work pending in the backup is held and agents wait for
// Resume; repeating schedules continue from now with no catch-up. And the gates that honour it are in place.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const recovery = require('../lib/backup/recovery');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-recovery-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const w = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };
const NOW = Date.parse('2026-10-29T14:00:00Z');

test('entering recovery mode holds pending work, moves repeating schedules on, interrupts running jobs', () => {
  const root = path.join(TMP, 'r1');
  const D = (...p) => path.join(root, 'data', ...p);
  w(D('scheduled-tasks.json'), { tasks: [
    { id: 'st-due', agent: 'degen', status: 'active', label: 'move $300', schedule: { type: 'once', at: '2026-10-28T01:00:00Z' }, nextRunAt: '2026-10-28T01:00:00Z' },
    { id: 'st-later', agent: 'foreman', status: 'active', schedule: { type: 'once', at: '2026-11-01T14:00:00Z' }, nextRunAt: '2026-11-01T14:00:00Z' },
    { id: 'st-daily', agent: 'doc', status: 'active', schedule: { type: 'recurring', cron: '0 9 * * *', tz: 'America/New_York' }, nextRunAt: '2026-10-27T13:00:00Z' },
    { id: 'st-gone', agent: 'doc', status: 'cancelled', nextRunAt: '2026-10-27T13:00:00Z' },
  ], pending: [{ taskId: 'st-later', agent: 'foreman', dueAt: '2026-10-29T13:00:00Z' }] });
  const db = new Database(D('task-queue.db'));
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, creator_agent TEXT NOT NULL, target_agent TEXT NOT NULL, trigger_type TEXT NOT NULL, trigger_value TEXT, action_prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT, execute_at TEXT, executed_at TEXT, result TEXT, error TEXT)");
  db.prepare("INSERT INTO tasks (creator_agent, target_agent, trigger_type, action_prompt, status) VALUES ('a','b','time','send the email','pending'), ('a','c','time','pay invoice','running'), ('a','d','time','old','completed')").run();
  db.close();
  w(D('consult-queue.json'), { jobs: [{ id: 'c1', agent: 'gi', prompt: 'look at labs' }], mailbox: {} });
  w(D('pending-interjections.json'), { doc: [{ text: 'hi' }, { text: 'again' }] });
  w(D('jobs', 'index.json'), { jobs: [{ id: 'j1', status: 'running', startedAt: '2026-10-28T00:00:00Z' }, { id: 'j2', status: 'done' }] });

  const rec = recovery.enter(root, { kind: 'restore', backup: { created: '2026-10-27T07:30:00Z' } }, () => NOW);
  assert.deepStrictEqual(rec.held.map(h => h.id).sort(), ['consult:c1', 'delivery:st-later:2026-10-29T13:00:00Z', 'schedule:st-due', 'task:1', 'task:2']);
  const st = JSON.parse(fs.readFileSync(D('scheduled-tasks.json'), 'utf8'));
  const t = (id) => st.tasks.find(x => x.id === id);
  assert.strictEqual(t('st-due').status, 'held', 'a one-off that came due is held');
  assert.strictEqual(t('st-later').status, 'active', 'a future one stays');
  assert.strictEqual(t('st-daily').status, 'active');
  assert.ok(Date.parse(t('st-daily').nextRunAt) > NOW, 'a repeating one moves to its next time after now: no catch-up');
  assert.strictEqual(t('st-daily').nextRunAt, '2026-10-30T13:00:00.000Z');
  assert.deepStrictEqual(st.pending, []);
  const db2 = new Database(D('task-queue.db'), { readonly: true });
  assert.deepStrictEqual(db2.prepare('SELECT status FROM tasks ORDER BY id').all().map(r => r.status), ['held', 'held', 'completed']);
  db2.close();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(D('consult-queue.json'), 'utf8')).jobs, []);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(D('pending-interjections.json'), 'utf8')), {});
  assert.strictEqual(rec.dropped.interjections, 2);
  assert.deepStrictEqual(rec.interrupted, ['j1']);
  assert.strictEqual(JSON.parse(fs.readFileSync(D('jobs', 'index.json'), 'utf8')).jobs[0].status, 'interrupted');
  assert.strictEqual(rec.restoredFrom, '2026-10-27T07:30:00Z');
  // Resume lets new work start; held items stay held until decided
  assert.strictEqual(recovery.active(root), true);
  assert.ok(recovery.resume(root));
  assert.strictEqual(recovery.active(root), false);
  assert.strictEqual(recovery.state(root).held.length, 5);
  assert.strictEqual(recovery.resume(root), false, 'only once');
});

test('entering recovery mode is idempotent for a restore: interrupted halfway, it finishes and keeps what it held', () => {
  const root = path.join(TMP, 'r3');
  const D = (...p) => path.join(root, 'data', ...p);
  w(D('scheduled-tasks.json'), { tasks: [{ id: 'st-a', agent: 'degen', status: 'held', label: 'held already', nextRunAt: '2026-10-28T01:00:00Z' }], pending: [] });
  w(D('consult-queue.json'), { jobs: [], mailbox: {} });
  // the record a crash left behind: paused, one delivery on record (its queue already emptied)
  w(recovery.fileOf(root), { kind: 'restore', journalId: 'j1', phase: 'holding', since: '2026-10-29T13:00:00Z', held: [{ id: 'delivery:st-b:2026-10-29T12:00:00Z', kind: 'delivery', taskId: 'st-b' }], interrupted: [], dropped: { interjections: 0 }, resumedAt: null });
  assert.strictEqual(recovery.active(root), true, 'paused while it was interrupted');
  const rec = recovery.enterOnce(root, { id: 'j1', kind: 'restore' }, () => NOW);
  assert.strictEqual(rec.phase, 'done');
  assert.deepStrictEqual(rec.held.map(h => h.id).sort(), ['delivery:st-b:2026-10-29T12:00:00Z', 'schedule:st-a']);
  const again = recovery.enterOnce(root, { id: 'j1', kind: 'restore' }, () => NOW);
  assert.strictEqual(again.held.length, 2, 'done once for this restore');
});

test('without a restore there is no recovery mode, and missing files are fine', () => {
  const root = path.join(TMP, 'r2');
  assert.strictEqual(recovery.active(root), false);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const rec = recovery.enter(root, {}, () => NOW);
  assert.deepStrictEqual(rec.held, []);
  assert.strictEqual(recovery.active(root), true);
});

test('the gates are in place: start-up order, the turn gate, the scheduler, the task queue, healthy after 30 s', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const server = read('server.js');
  const applyAt = server.indexOf("require('./lib/backup/apply').applyAtBoot");
  assert.ok(applyAt > 0 && applyAt < server.indexOf('// Load .env BEFORE any other requires'), 'the restore runs before .env is read');
  assert.ok(applyAt < server.indexOf("require('./lib/agents')"), 'and before any module that reads data/');
  assert.match(server, /catch \(e\) \{ console\.error\(`\[restore\] the restore could not be finished or rolled back[^\n]*process\.exit\(1\); \}/, 'a swap that can neither finish nor roll back stops the start');
  const pause = server.indexOf("require('./lib/backup/recovery').enterOnce(");
  assert.ok(pause > server.indexOf('// Load .env BEFORE any other requires') && pause < server.indexOf("require('./lib/agents')"), 'the pause is set after .env and before any module that queues work');
  assert.match(server.slice(pause, pause + 300), /process\.exit\(1\)/, 'and fails closed');
  // nothing loaded before .env may read the environment when loaded: apply.js must not pull in hub-home (HUB_HOME) or restore.js
  const probe = require('child_process').spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'backup', 'apply.js'))}); console.log(JSON.stringify(Object.keys(require.cache).map(f => require('path').relative(${JSON.stringify(path.join(__dirname, '..'))}, f))))`], { encoding: 'utf8' });
  const loaded = JSON.parse(probe.stdout);
  assert.deepStrictEqual(loaded.filter(f => !f.startsWith('node_modules')).sort(), ['lib/backup/accounts.js', 'lib/backup/apply.js', 'lib/backup/dirs.js'], loaded.join(', '));
  assert.match(server, /markHealthy\(\{ root: __dirname \}\)[\s\S]{0,300}30000\)\.unref\(\)/);
  const chat = read('lib/sdk-chat.js');
  const gate = chat.indexOf("require('./backup/recovery').active(");
  assert.ok(gate > chat.indexOf('async function handleChatStream(') && gate < chat.indexOf('async function handleChatStreamReserved('), 'one gate in front of every turn');
  assert.match(read('lib/scheduled-tasks.js'), /async tick\(\) \{\n    if \(require\('\.\/backup\/recovery'\)\.active\(/);
  assert.match(read('lib/task-queue.js'), /setInterval\(\(\) => \{\n    if \(require\('\.\/backup\/recovery'\)\.active\(/);
});
