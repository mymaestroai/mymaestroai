'use strict';
// Behavioural unit tests for lib/memory-db.js against a temp SQLite file (HUB_MEMORY_DB is read at require time,
// so every test drops the module from the require cache and loads a fresh instance over its own temp dir).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const MOD = require.resolve('../lib/memory-db');
const dirs = [];
const opened = [];
const savedEnv = process.env.HUB_MEMORY_DB;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function load(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-memdb-'));
  dirs.push(dir);
  const file = path.join(dir, 'memory.db');
  if (seed) { const d = new Database(file); d.exec(seed); d.close(); }
  process.env.HUB_MEMORY_DB = file;
  delete require.cache[MOD];
  const m = require(MOD);
  opened.push(m);
  const quiet = (fn) => (...a) => { const l = console.log; console.log = () => {}; try { return fn(...a); } finally { console.log = l; } };
  m.migrateFromFiles = quiet(m.migrateFromFiles);
  m.cleanupOldSessions = quiet(m.cleanupOldSessions);
  return { m, dir, file, db: () => m.getDb() };
}
test.after(() => {
  for (const m of opened) { try { m.getDb().close(); } catch {} }
  if (savedEnv === undefined) delete process.env.HUB_MEMORY_DB; else process.env.HUB_MEMORY_DB = savedEnv;
  delete require.cache[MOD];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('long-term memory: write replaces, append adds a newline, sections are listed in order, agents are isolated', () => {
  const { m } = load();
  assert.strictEqual(m.readLongTermMemory('a'), '(no long-term memory)');
  assert.strictEqual(m.readLongTermMemory('a', 'rules'), null);
  assert.strictEqual(m.writeLongTermMemory('a', 'one'), 'Long-term memory updated.');
  m.appendLongTermMemory('a', 'two');
  assert.strictEqual(m.readLongTermMemory('a', 'general'), 'one\ntwo');
  m.writeLongTermMemory('a', 'fresh');                       // replaces, no duplicate row (unique agent+section)
  assert.strictEqual(m.readLongTermMemory('a', 'general'), 'fresh');
  m.appendLongTermMemory('a', 'r1', 'rules');                // append to a missing section creates it
  m.writeLongTermMemory('a', 'z', 'zeta');
  assert.strictEqual(m.readLongTermMemory('a'), 'fresh\n\n## rules\nr1\n\n## zeta\nz', 'general has no heading; others sorted by name');
  assert.strictEqual(m.readLongTermMemory('b'), '(no long-term memory)');
});

test('session notes: default category and date, ordering by time, empty-day message, specific date', () => {
  const { m, db } = load();
  assert.strictEqual(m.readSessionNotes('a'), `(no session notes for ${today()})`);
  assert.strictEqual(m.writeSessionNote('a', 'hello'), 'Session note saved.');
  m.writeSessionNote('a', 'custom', 'Tool');
  const out = m.readSessionNotes('a');
  assert.match(out, /^## \d\d:\d\d — Chat\nhello\n\n## \d\d:\d\d — Tool\ncustom$/);
  db().prepare('INSERT INTO session_notes (agent,date,time,category,content) VALUES (?,?,?,?,?)').run('a', '2026-01-05', '18:00', 'late', 'L');
  db().prepare('INSERT INTO session_notes (agent,date,time,category,content) VALUES (?,?,?,?,?)').run('a', '2026-01-05', '08:00', 'early', 'E');
  assert.strictEqual(m.readSessionNotes('a', '2026-01-05'), '## 08:00 — early\nE\n\n## 18:00 — late\nL');
  assert.strictEqual(m.readSessionNotes('b', '2026-01-05'), '(no session notes for 2026-01-05)');
});

test('writeAutoSessionNote: ignores short replies, truncates long user/assistant text', () => {
  const { m } = load();
  m.writeAutoSessionNote('a', 'hi', 'too short');
  m.writeAutoSessionNote('a', 'hi', undefined);
  assert.match(m.readSessionNotes('a'), /^\(no session notes/);
  m.writeAutoSessionNote('a', 'u'.repeat(300), 'r'.repeat(600));
  const out = m.readSessionNotes('a');
  assert.ok(out.includes(`**User:** ${'u'.repeat(200)}...\n`));
  assert.ok(out.includes(`**a:** ${'r'.repeat(500)}...`));
  assert.ok(!out.includes('u'.repeat(201)) && !out.includes('r'.repeat(501)));
  m.writeAutoSessionNote('a', 'short question', 'x'.repeat(50));   // exactly 50 is accepted, no ellipsis
  assert.ok(m.readSessionNotes('a').includes(`**a:** ${'x'.repeat(50)}`));
});

test('shared memory: owner column scopes reads; null = admin pool, "u_k" = that member\'s pool', () => {
  const { m, db } = load();
  m.writeSharedMemory('plan', 'admin plan', 'maestro', ['t']);
  m.writeSharedMemory('plan', 'member plan', 'kidagent', [], 'u_k');
  m.writeSharedMemory('only-member', 'secret member note', 'kidagent', [], 'u_k');
  assert.match(m.readSharedMemory('plan'), /admin plan/);
  assert.doesNotMatch(m.readSharedMemory('plan'), /member plan/);
  assert.match(m.readSharedMemory('plan', 'u_k'), /member plan/);
  assert.doesNotMatch(m.readSharedMemory('plan', 'u_k'), /admin plan/);
  assert.strictEqual(m.readSharedMemory('only-member'), '(no shared memory matching "only-member")');
  assert.strictEqual(m.readSharedMemory('plan', 'u_other'), '(no shared memory matching "plan")');
  assert.match(m.readSharedMemory(null, 'u_k'), /only-member.*\n.*plan|plan.*\n.*only-member/);
  assert.doesNotMatch(m.readSharedMemory(), /only-member/);
  assert.strictEqual(m.readSharedMemory(undefined, 'u_empty'), '(shared memory is empty)');
  assert.strictEqual(db().prepare('SELECT COUNT(*) c FROM shared_memory').get().c, 3);
});

test('shared memory: one row per (topic, author, owner); rewrite updates in place, new author adds a row', () => {
  const { m, db } = load();
  m.writeSharedMemory('t', 'v1', 'a');
  m.writeSharedMemory('t', 'v2', 'a', ['x']);
  assert.strictEqual(db().prepare('SELECT COUNT(*) c FROM shared_memory').get().c, 1);
  assert.strictEqual(db().prepare('SELECT content, tags FROM shared_memory').get().content, 'v2');
  assert.strictEqual(db().prepare('SELECT tags FROM shared_memory').get().tags, '["x"]');
  m.writeSharedMemory('t', 'other author', 'b');
  m.writeSharedMemory('t', 'same author, member pool', 'a', [], 'u_k');
  assert.strictEqual(db().prepare('SELECT COUNT(*) c FROM shared_memory').get().c, 3);
  assert.strictEqual(m.writeSharedMemory('t', 'x', 'a'), 'Shared memory "t" saved.');
});

test('searchSharedMemory: matches topic, content and tags inside the pool only', () => {
  const { m } = load();
  m.writeSharedMemory('alpha', 'contains needle here', 'a');
  m.writeSharedMemory('needle-topic', 'plain', 'a');
  m.writeSharedMemory('tagged', 'plain', 'a', ['needle']);
  m.writeSharedMemory('member', 'needle in member pool', 'k', [], 'u_k');
  const admin = m.searchSharedMemory('needle');
  for (const t of ['alpha', 'needle-topic', 'tagged']) assert.ok(admin.includes(`### ${t}\n`), t);
  assert.ok(!admin.includes('member'));
  const mem = m.searchSharedMemory('needle', 'u_k');
  assert.ok(mem.includes('### member') && !mem.includes('### alpha'));
  assert.strictEqual(m.searchSharedMemory('nothing-here'), '(no shared memory matching "nothing-here")');
  assert.strictEqual(m.searchSharedMemory('needle', 'u_none'), '(no shared memory matching "needle")');
  // LIKE wildcards in the query are literal: "%" / "_" do not match every row.
  assert.strictEqual(m.searchSharedMemory('%'), '(no shared memory matching "%")');
  assert.strictEqual(m.searchSharedMemory('_'), '(no shared memory matching "_")');
  m.writeSharedMemory('pct', 'growth was 100% last year, snake_case', 'a');
  assert.ok(m.searchSharedMemory('100%').includes('### pct'));
  assert.ok(m.searchSharedMemory('snake_case').includes('### pct'));
  assert.strictEqual(m.searchSharedMemory('100_ last'), '(no shared memory matching "100_ last")');
  assert.strictEqual((m.searchSharedMemory('%').match(/^### /gm) || []).length, 1);
});

test('legacy shared_memory table without the owner column is migrated on first use; old rows belong to the admin pool', () => {
  const legacy = `CREATE TABLE shared_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, content TEXT NOT NULL, author TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO shared_memory (topic, content, author) VALUES ('old', 'legacy body', 'x');`;
  const { m, db } = load(legacy);
  assert.match(m.readSharedMemory('old'), /legacy body/);
  assert.ok(db().prepare('PRAGMA table_info(shared_memory)').all().some(c => c.name === 'owner'));
  assert.strictEqual(m.readSharedMemory('old', 'u_k'), '(no shared memory matching "old")');
});

test('getMemoryContext: empty agent gives ""; long-term and session notes are included; other agents are not', () => {
  const { m } = load();
  assert.strictEqual(m.getMemoryContext('a'), '');
  m.writeLongTermMemory('a', 'prefers tables');
  m.writeLongTermMemory('a', 'never restart', 'rules');
  m.writeSessionNote('a', 'did a thing');
  m.writeLongTermMemory('b', 'b-only');
  const ctx = m.getMemoryContext('a');
  assert.ok(ctx.startsWith('# Long-Term Memory\n'));
  assert.ok(ctx.includes('prefers tables') && ctx.includes('## rules\nnever restart'), 'general has no heading, other sections do');
  assert.ok(ctx.indexOf('never restart') < ctx.indexOf('prefers tables'), 'smaller sections load first');
  assert.ok(ctx.includes(`# Session Memory (${today()})`) && ctx.includes('did a thing'));
  assert.ok(!ctx.includes('b-only'));
  m.writeSessionNote('a', 'x'); // only two most recent days with notes are loaded; yesterday-and-older rows
  const d = m.getDb();
  for (const n of [1, 2, 3]) d.prepare('INSERT INTO session_notes (agent,date,time,category,content) VALUES (?,?,?,?,?)').run('a', daysAgo(n), '10:00', 'c', `day-${n}`);
  const c2 = m.getMemoryContext('a');
  assert.ok(c2.includes('day-1') && !c2.includes('day-2') && !c2.includes('day-3'), 'today + the next most recent day only');
});

test('getMemoryContext: output is capped near maxBytes and an oversized section keeps its NEWEST lines', () => {
  const { m } = load();
  const lines = Array.from({ length: 2000 }, (_, i) => `entry-${String(i).padStart(4, '0')}`);
  m.writeLongTermMemory('a', lines.join('\n'));
  for (let i = 0; i < 20; i++) m.writeSharedMemory(`topic${i}`, 'S'.repeat(500), 'x');
  for (const cap of [2048, 8192, 32768]) {
    const ctx = m.getMemoryContext('a', cap);
    assert.ok(ctx.length <= cap, `cap ${cap} got ${ctx.length}`);   // the "\n\n---\n\n" joiners count toward maxBytes
    assert.ok(ctx.split('\n\n---\n\n').every(s => s.length <= cap), 'each section alone fits');
    assert.ok(ctx.includes('entry-1999'), 'newest entry survives');
    assert.ok(!ctx.includes('entry-0000'), 'oldest entry is dropped');
    assert.ok(ctx.includes('older entries not shown — read_memory("general")'));
  }
  assert.ok(m.getMemoryContext('a', 2048).length < m.getMemoryContext('a', 32768).length);
});

test('getMemoryContext: Distilled Sessions are trimmed to the newest summaries and are loaded last within long-term memory', () => {
  const { m } = load();
  for (let i = 1; i <= 40; i++) m.saveDistillation('a', `2026-02-${String(i % 28 + 1).padStart(2, '0')}x`.slice(0, 10), 'S'.repeat(300));
  const dates = Array.from({ length: 30 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`);
  m.writeLongTermMemory('b', '');
  for (const d of dates) m.saveDistillation('b', d, `summary of ${d} ${'.'.repeat(300)}`);
  m.writeLongTermMemory('b', 'core rule', 'rules');
  const ctx = m.getMemoryContext('b', 4096);
  assert.ok(ctx.indexOf('core rule') < ctx.indexOf('## Distilled Sessions'));
  assert.ok(ctx.includes('summary of 2026-03-30') && !ctx.includes('summary of 2026-03-01'));
  assert.match(ctx, /_\(\d+ older session summaries archived — use read_memory\("Distilled Sessions"\) to load them\)_/);
});

test('getMemoryContext sharedPool: a member pool never contains admin-side topics, and vice versa', () => {
  const { m } = load();
  m.writeSharedMemory('admin-wallet-plan', 'ADMIN SECRET CONTENT '.repeat(5), 'maestro');
  m.writeSharedMemory('kid-homework', 'MEMBER NOTE CONTENT '.repeat(5), 'kidagent', [], 'u_k');
  m.writeSharedMemory('other-member', 'OTHER MEMBER CONTENT '.repeat(5), 'x', [], 'u_o');
  const admin = m.getMemoryContext('a');
  assert.ok(admin.includes('# Shared Memory Pool') && admin.includes('admin-wallet-plan'));
  assert.ok(!admin.includes('kid-homework') && !admin.includes('other-member'));
  assert.strictEqual(m.getMemoryContext('a', 32768, { sharedPool: null }), admin);
  const mem = m.getMemoryContext('kidagent', 32768, { sharedPool: 'u_k' });
  assert.ok(mem.includes('kid-homework'));
  for (const leak of ['admin-wallet-plan', 'ADMIN SECRET', 'other-member']) assert.ok(!mem.includes(leak), leak);
  assert.strictEqual(m.getMemoryContext('a', 32768, { sharedPool: 'u_nobody' }), '');
});

test('getMemoryContext: duplicate (topic, author) rows are shown once and only 10 entries are included', () => {
  const { m, db } = load();
  for (let i = 0; i < 3; i++) db().prepare("INSERT INTO shared_memory (topic, content, author) VALUES ('dup', ?, 'x')").run(`version-${i} ${'.'.repeat(60)}`);
  for (let i = 0; i < 14; i++) m.writeSharedMemory(`t${String(i).padStart(2, '0')}`, `body ${'.'.repeat(60)}`, 'x');
  const ctx = m.getMemoryContext('a');
  assert.ok((ctx.match(/^## dup$/gm) || []).length <= 1);
  assert.strictEqual((ctx.match(/^## (dup|t\d\d)$/gm) || []).length, 10);
});

test('distillation: undistilled dates exclude today and logged days; saveDistillation feeds long-term memory', () => {
  const { m, db } = load();
  const ins = db().prepare('INSERT INTO session_notes (agent,date,time,category,content) VALUES (?,?,?,?,?)');
  ins.run('a', daysAgo(3), '09:00', 'c', 'old one'); ins.run('a', daysAgo(3), '10:00', 'c', 'old two');
  ins.run('a', daysAgo(2), '09:00', 'c', 'newer'); ins.run('a', today(), '09:00', 'c', 'today'); ins.run('b', daysAgo(5), '09:00', 'c', 'other agent');
  assert.deepStrictEqual(m.getUndistilledDates('a'), [daysAgo(3), daysAgo(2)]);
  assert.strictEqual(m.getSessionNotesForDistillation('a', daysAgo(3)), '[09:00] old one\n\n[10:00] old two');
  m.saveDistillation('a', daysAgo(3), 'sum-1');
  m.saveDistillation('a', daysAgo(3), 'sum-1b');   // INSERT OR REPLACE: log keeps one row, memory keeps both entries
  assert.deepStrictEqual(m.getUndistilledDates('a'), [daysAgo(2)]);
  assert.strictEqual(db().prepare('SELECT COUNT(*) c FROM distillation_log WHERE agent=?').get('a').c, 1);
  assert.ok(m.readLongTermMemory('a', 'Distilled Sessions').includes(`### ${daysAgo(3)}\nsum-1b`));
});

test('cleanupOldSessions drops notes older than 90 days and keeps the rest; getMemoryStats counts per agent', () => {
  const { m, db } = load();
  const ins = db().prepare('INSERT INTO session_notes (agent,date,time,category,content) VALUES (?,?,?,?,?)');
  ins.run('a', daysAgo(120), '09:00', 'c', 'ancient'); ins.run('a', daysAgo(91), '09:00', 'c', 'just too old');
  ins.run('a', daysAgo(89), '09:00', 'c', 'keep'); ins.run('a', today(), '09:00', 'c', 'keep2');
  m.writeLongTermMemory('a', 'x'); m.writeLongTermMemory('a', 'y', 's2'); m.writeSharedMemory('t', 'c', 'a'); m.saveDistillation('a', daysAgo(89), 's');
  m.cleanupOldSessions();
  assert.deepStrictEqual(db().prepare('SELECT content FROM session_notes ORDER BY date').all().map(r => r.content), ['keep', 'keep2']);
  assert.deepStrictEqual(m.getMemoryStats('a'), { longTermSections: 3, sessionNotes: 2, sessionDays: 2, sharedMemories: 1, distilledDays: 1 });   // 3rd section = Distilled Sessions
  assert.deepStrictEqual(m.getMemoryStats('nobody'), { longTermSections: 0, sessionNotes: 0, sessionDays: 0, sharedMemories: 1, distilledDays: 0 });
});

test('migrateFromFiles: MEMORY.md and memory/<date>.md import once; agents that already have data are left alone', () => {
  const { m, dir, db } = load();
  const ws = path.join(dir, 'ws'); fs.mkdirSync(path.join(ws, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'MEMORY.md'), '\n  durable fact  \n');
  fs.writeFileSync(path.join(ws, 'memory', '2026-01-01.md'), '# Log\n\n## 09:30 — Planning\nplan body\n\n## 10:15\nsecond body\n\n## weird header\nthird body\n');
  fs.writeFileSync(path.join(ws, 'memory', 'notes.md'), '## 09:00\nignored: not a date file\n');
  fs.writeFileSync(path.join(ws, 'memory', '2026-01-02.txt'), 'ignored: not .md');
  m.migrateFromFiles('a', ws);
  assert.strictEqual(m.readLongTermMemory('a', 'general'), 'durable fact');
  const rows = db().prepare('SELECT date, time, category, content FROM session_notes WHERE agent=? ORDER BY id').all('a');
  assert.deepStrictEqual(rows, [
    { date: '2026-01-01', time: '09:30', category: 'Planning', content: 'plan body' },
    { date: '2026-01-01', time: '10:15', category: 'Chat', content: 'second body' },
    { date: '2026-01-01', time: '00:00', category: 'Chat', content: 'third body' },
  ]);
  m.migrateFromFiles('a', ws);   // second run is a no-op
  assert.strictEqual(db().prepare('SELECT COUNT(*) c FROM session_notes').get().c, 3);
  m.writeLongTermMemory('c', 'already here');
  m.migrateFromFiles('c', ws);   // has long-term data -> nothing imported
  assert.strictEqual(m.readLongTermMemory('c', 'general'), 'already here');
  assert.strictEqual(db().prepare("SELECT COUNT(*) c FROM session_notes WHERE agent='c'").get().c, 0);
  m.migrateFromFiles('ghost', path.join(dir, 'no-such-workspace'));   // missing workspace is fine
  assert.strictEqual(m.readLongTermMemory('ghost'), '(no long-term memory)');
});

test('migrateFromFiles: a day file that STARTS with a "## HH:MM" header', () => {
  const { m, dir, db } = load();
  const ws = path.join(dir, 'ws'); fs.mkdirSync(path.join(ws, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'memory', '2026-01-03.md'), '## 08:05 — First\nbody one\n\n## 09:10 — Second\nbody two\n');
  m.migrateFromFiles('a', ws);
  const rows = db().prepare('SELECT time, category, content FROM session_notes ORDER BY id').all();
  assert.deepStrictEqual(rows[0], { time: '08:05', category: 'First', content: 'body one' });
  assert.deepStrictEqual(rows[1], { time: '09:10', category: 'Second', content: 'body two' });
});
