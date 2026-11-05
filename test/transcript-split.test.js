'use strict';
// One conversation archive per agent (data/transcripts/<agent>.db), and the one-time split of the combined file
// earlier versions kept (data/transcript.db), keeping every row's id.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { createTranscript, splitCombined, safeName } = require('../lib/transcript');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-split-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const place = () => { const d = path.join(tmp, `case-${++n}`); fs.mkdirSync(d); return { file: path.join(d, 'transcript.db'), dir: path.join(d, 'transcripts') }; };
const quiet = () => {};

// A combined archive as earlier versions wrote it: every agent's rows in one file, ids interleaved. The files are
// copied while the writer is still open, as a hub that stopped without closing leaves them (rows still in the WAL).
function combined(file, rows) {
  const staging = `${file}.staging`;
  const d = new Database(staging);
  d.pragma('journal_mode = WAL');
  d.exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, agent TEXT NOT NULL, owner TEXT,
    turn_id TEXT, origin TEXT, kind TEXT NOT NULL, tool TEXT, text TEXT NOT NULL, meta TEXT, hash TEXT NOT NULL);
    CREATE UNIQUE INDEX entries_dedupe ON entries(agent, day, hash);
    CREATE VIRTUAL TABLE entries_fts USING fts5(text, content='entries', content_rowid='id', tokenize='unicode61');
    CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN INSERT INTO entries_fts(rowid, text) VALUES (new.id, new.text); END;`);
  const ins = d.prepare('INSERT INTO entries (ts, day, agent, kind, text, hash) VALUES (?,?,?,?,?,?)');
  rows.forEach(([agent, text], i) => ins.run(`2026-10-0${1 + (i % 9)}T10:00:00.000Z`, `2026-10-0${1 + (i % 9)}`, agent, 'assistant', text, `h-${text}`));   // the hash follows the text, as the archive's does
  const ids = d.prepare('SELECT id, agent, text FROM entries ORDER BY id').all();
  for (const ext of ['', '-wal', '-shm']) { if (fs.existsSync(staging + ext)) fs.copyFileSync(staging + ext, file + ext); }
  d.close();
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(staging + ext); } catch {} }
  return ids;
}
const rowsOf = (f) => { const d = new Database(f, { readonly: true }); try { return d.prepare('SELECT id, agent, text FROM entries ORDER BY id').all(); } finally { d.close(); } };

test('each agent has its own file; a search, a look-up or a count for an agent with no history never makes one', () => {
  const { file, dir } = place();
  const tr = createTranscript({ file, dir, log: quiet });
  tr.record({ agent: 'doc', kind: 'user', text: 'the infusion schedule' });
  tr.record({ agent: 'watchman', kind: 'assistant', text: 'a car at the gate' });
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort(), ['doc.db', 'watchman.db']);
  assert.strictEqual(tr.search('doc', 'gate').length, 0, 'doc does not see what watchman saw');
  assert.strictEqual(tr.search('watchman', 'gate').length, 1);
  assert.deepStrictEqual(tr.search('nobody', 'gate'), []);
  assert.deepStrictEqual(tr.stats('nobody'), { agent: 'nobody', entries: 0, first: null, last: null, bytes: 0, byKind: {} });
  assert.deepStrictEqual(tr.context(1, { agents: ['nobody'] }), []);
  assert.strictEqual(fs.existsSync(tr.fileFor('nobody')), false, 'no file made for an agent with no history');
  const hit = tr.search('doc', 'infusion')[0];
  assert.strictEqual(tr.context(hit.id, { agents: ['doc'] })[0].text, 'the infusion schedule');
  assert.deepStrictEqual(tr.context(hit.id, {}), [], 'without the agent there is no look-up (ids are per agent)');
  tr.close();
});

test('file names: plain lowercase names as they are, anything else encoded (case-blind file systems, odd characters)', () => {
  assert.strictEqual(safeName('watchman'), 'watchman');
  assert.strictEqual(safeName('member_sam'), 'member_sam');
  assert.notStrictEqual(safeName('Doc'), safeName('doc'), 'Doc and doc never share a file on a case-blind disk');
  assert.match(safeName('../x'), /^~[0-9a-f]+$/);
  assert.match(safeName('é'), /^~[0-9a-f]+$/);
});

test('an archive that exists but cannot be opened is "could not be opened", never "nothing there"', { skip: process.getuid && process.getuid() === 0 }, () => {
  const { file, dir } = place();
  const tr = createTranscript({ file, dir, log: quiet });
  tr.record({ agent: 'counsel', kind: 'user', text: 'the deed' });
  tr.close();
  fs.chmodSync(tr.fileFor('counsel'), 0o000);
  const err = console.error; console.error = () => {};
  try { assert.strictEqual(createTranscript({ file, dir, log: quiet }).stats('counsel'), null); }
  finally { console.error = err; fs.chmodSync(tr.fileFor('counsel'), 0o600); }
});

test('many agents with few open files: the least recently used is closed and opened again when needed', () => {
  const { file, dir } = place();
  const tr = createTranscript({ file, dir, log: quiet, maxOpen: 2 });
  for (const a of ['a1', 'a2', 'a3', 'a4']) tr.record({ agent: a, kind: 'user', text: `hello from ${a}` });
  for (const a of ['a1', 'a2', 'a3', 'a4']) assert.strictEqual(tr.search(a, 'hello').length, 1, a);
  tr.close();
});

test('the split keeps every row under its own id, in its agent\'s file, searchable; the old file is kept beside it', () => {
  const { file, dir } = place();
  const before = combined(file, [['doc', 'first visit'], ['watchman', 'gate opened'], ['doc', 'second visit'], ['counsel', 'the will'], ['watchman', 'gate closed']]);
  assert.ok(fs.existsSync(`${file}-wal`), 'the WAL is there, as on a running hub');
  const r = splitCombined({ file, dir, log: quiet });
  assert.deepStrictEqual([r.split, r.agents, r.rows], [true, 3, 5]);
  for (const agent of ['doc', 'watchman', 'counsel']) {
    assert.deepStrictEqual(rowsOf(path.join(dir, `${agent}.db`)), before.filter(x => x.agent === agent), `${agent}: same rows, same ids`);
  }
  assert.strictEqual(fs.existsSync(file), false);
  assert.ok(fs.existsSync(`${file}.pre-split`), 'the old file is kept');
  const tr = createTranscript({ file, dir, log: quiet });
  assert.strictEqual(tr.search('watchman', 'gate').length, 2, 'the moved rows are searchable');
  const hit = tr.search('doc', 'second')[0];
  assert.strictEqual(hit.id, before.find(x => x.text === 'second visit').id, 'a "#id" from before the split still finds its row');
  const id = tr.record({ agent: 'doc', kind: 'user', text: 'a new message' });
  assert.ok(id > Math.max(...before.map(x => x.id)), 'new rows number above every old id');
  assert.deepStrictEqual(splitCombined({ file, dir, log: quiet }), { split: false }, 'nothing to split a second time');
  tr.close();
});

test('before the split, every agent\'s rows stay in the combined file, also from the new code; none is half in one file and half in another', () => {
  const { file, dir } = place();
  const before = combined(file, [['doc', 'old one'], ['doc', 'old two'], ['tester', 'old three']]);
  const tr = createTranscript({ file, dir, log: quiet });
  const early = tr.record({ agent: 'doc', kind: 'user', text: 'written by the new code first' });
  assert.strictEqual(fs.existsSync(dir), false, 'no per-agent file while the combined file is there');
  assert.strictEqual(tr.search('doc', 'old').length, 2, 'searches read the combined file meanwhile');
  assert.strictEqual(tr.stats('doc').entries, 3, 'and so does the leftover check (a deleted agent\'s history counts)');
  tr.close();
  splitCombined({ file, dir, log: quiet });
  const rows = rowsOf(path.join(dir, 'doc.db'));
  assert.deepStrictEqual(rows.map(x => x.text), ['old one', 'old two', 'written by the new code first']);
  assert.deepStrictEqual(rows.map(x => x.id), [...before.filter(x => x.agent === 'doc').map(x => x.id), early]);
});

test('a split that stops part-way leaves the old file in place; the next start finishes it without doubling or losing a row', () => {
  const { file, dir } = place();
  const before = combined(file, [['alpha', 'a1'], ['bravo', 'b1'], ['alpha', 'a2'], ['bravo', 'b2']]);
  fs.mkdirSync(path.join(dir, 'bravo.db'), { recursive: true });   // bravo's file can't be made: the split stops there
  assert.throws(() => splitCombined({ file, dir, log: quiet }));
  assert.ok(fs.existsSync(file), 'the old file stays until every agent is done');
  // the hub runs on meanwhile: a new row for an agent the split already did, and for the one it did not
  const tr = createTranscript({ file, dir, log: quiet });
  tr.record({ agent: 'alpha', kind: 'user', text: 'after the failed split' });   // the hub runs on, on the combined file
  assert.strictEqual(tr.search('alpha', 'failed').length, 1);
  tr.close();
  fs.rmdirSync(path.join(dir, 'bravo.db'));
  const r = splitCombined({ file, dir, log: quiet });
  assert.strictEqual(r.split, true);
  assert.deepStrictEqual(rowsOf(path.join(dir, 'alpha.db')).map(x => x.text), ['a1', 'a2', 'after the failed split']);
  assert.deepStrictEqual(rowsOf(path.join(dir, 'bravo.db')), before.filter(x => x.agent === 'bravo'));
});

test('migrate() on the hub\'s archive splits once, and the server calls it first thing once it holds its port', () => {
  const { file, dir } = place();
  combined(file, [['doc', 'xray'], ['doc', 'yankee']]);
  const tr = createTranscript({ file, dir, log: quiet });
  assert.strictEqual(tr.migrate().split, true);
  assert.strictEqual(tr.migrate().split, false);
  assert.strictEqual(tr.search('doc', 'yankee').length, 1);
  tr.close();
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const listen = src.indexOf('server.listen(PORT, HOST, () => {');
  const at = src.indexOf('getTranscript().migrate()');
  assert.ok(listen > 0 && at > listen, 'the split runs once this process holds the port (no older hub on it still writing)');
  assert.ok(!/\S/.test(src.slice(listen + 'server.listen(PORT, HOST, () => {'.length, at).replace(/\/\/[^\n]*/g, '').replace('try { require(\'./lib/transcript\').', '')), 'and first in the callback, before anything can start a turn');
});

test('after a rollback an older version numbers from 1 again: the next split keeps those rows under new numbers, and the first old copy', () => {
  const { file, dir } = place();
  const first = combined(file, [['doc', 'before the update'], ['doc', 'also before']]);
  splitCombined({ file, dir, log: quiet });
  const firstCopy = fs.readFileSync(`${file}.pre-split`);
  // an older version runs: no combined file, so it makes a fresh one, ids from 1 again
  const again = combined(file, [['doc', 'written while rolled back'], ['watchman', 'gate at noon']]);
  assert.deepStrictEqual(again.map(x => x.id), first.map(x => x.id), 'the same ids as rows already split');
  const r = splitCombined({ file, dir, log: quiet });
  assert.deepStrictEqual([r.split, r.renumbered], [true, 1]);
  assert.deepStrictEqual(rowsOf(path.join(dir, 'doc.db')).map(x => x.text).sort(), ['also before', 'before the update', 'written while rolled back'], 'nothing dropped');
  assert.deepStrictEqual(rowsOf(path.join(dir, 'watchman.db')).map(x => x.text), ['gate at noon']);
  assert.ok(fs.readFileSync(`${file}.pre-split`).equals(firstCopy), 'the first old copy is kept as it was');
  assert.ok(fs.readdirSync(path.dirname(file)).some(n => /^transcript\.db\.pre-split-\d{8}-\d{6}$/.test(n)), 'the second one beside it, dated');
});

test('the split waits while another process has a transaction open on the combined file, and an unreadable one stays put', () => {
  const { file, dir } = place();
  combined(file, [['doc', 'x1']]);
  const other = new Database(file);   // an older hub still running on it
  other.prepare('BEGIN').run(); other.prepare('SELECT COUNT(*) FROM entries').get();
  try {
    const r = splitCombined({ file, dir, log: quiet });
    assert.deepStrictEqual(r, { split: false, busy: true });
    assert.ok(fs.existsSync(file), 'left in use as it is');
  } finally { other.prepare('COMMIT').run(); other.close(); }
  // a combined file that isn't a readable archive stays where it is: its history must never look like none
  const bad = place();
  fs.writeFileSync(bad.file, 'this is not a database');
  assert.throws(() => splitCombined({ file: bad.file, dir: bad.dir, log: quiet }));
  const tr = createTranscript({ file: bad.file, dir: bad.dir, log: quiet });
  const err = console.error; console.error = () => {};
  try {
    assert.strictEqual(tr.migrate().split, false);
    assert.ok(fs.existsSync(bad.file), 'left in place for an admin to decide');
    assert.strictEqual(tr.stats('olddoc'), null, 'the leftover check stays closed (could not be opened, not "nothing there")');
    assert.strictEqual(fs.existsSync(bad.dir), false, 'and nothing was written per agent');
  } finally { console.error = err; tr.close(); }
});

test('after a rollback, the same words on another day under a taken id are kept too (the archive keeps one row per text per day)', () => {
  const { file, dir } = place();
  combined(file, [['doc', 'Hello']]);                 // Monday's "Hello", id 1
  splitCombined({ file, dir, log: quiet });
  const d = new Database(file);   // an older version: a fresh combined file, id 1 again, the same words on Tuesday
  d.exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, agent TEXT NOT NULL, owner TEXT,
    turn_id TEXT, origin TEXT, kind TEXT NOT NULL, tool TEXT, text TEXT NOT NULL, meta TEXT, hash TEXT NOT NULL);`);
  d.prepare('INSERT INTO entries (ts, day, agent, kind, text, hash) VALUES (?,?,?,?,?,?)').run('2026-10-02T09:00:00.000Z', '2026-10-02', 'doc', 'assistant', 'Hello', 'h-Hello');
  d.close();
  const r = splitCombined({ file, dir, log: quiet });
  assert.deepStrictEqual([r.split, r.renumbered], [true, 1]);
  assert.deepStrictEqual(rowsOf(path.join(dir, 'doc.db')).map(x => x.text), ['Hello', 'Hello'], 'Monday and Tuesday both');
});

test('the archive folder follows the archive file\'s name, and a reserved or very long agent name gets its own safe file', () => {
  const t1 = createTranscript({ file: path.join(tmp, 'archive.sqlite'), log: quiet });
  assert.strictEqual(t1.dir, path.join(tmp, 'archives'));
  assert.match(safeName('con'), /^~/, 'a Windows device name is encoded');
  const long1 = 'a'.repeat(70) + 'x', long2 = 'a'.repeat(70) + 'y';
  assert.notStrictEqual(safeName(long1), safeName(long2), 'two long names never share a file');
  assert.ok(safeName('é'.repeat(200)).length < 140);
});

test('health: entries, size of the agent\'s own file, rows added since a date, from the index; null when the archive can\'t be read', { skip: process.getuid && process.getuid() === 0 }, () => {
  const { file, dir } = place();
  let t = Date.parse('2026-10-01T00:00:00Z');
  const tr = createTranscript({ file, dir, log: quiet, now: () => (t += 3600 * 1000) });
  for (let i = 0; i < 5; i++) tr.record({ agent: 'foreman', kind: 'user', text: `delivery ${i} ${'x'.repeat(100)}` });
  const since = t + 1000;   // after the fifth row, before the next
  for (let i = 0; i < 3; i++) tr.record({ agent: 'foreman', kind: 'assistant', text: `reply ${i}` });
  const h = tr.health('foreman', { since });
  assert.deepStrictEqual([h.entries, h.recent], [8, 3]);
  assert.ok(h.fileBytes >= fs.statSync(tr.fileFor('foreman')).size && h.fileBytes > 0, 'its own file (and write-ahead log)');
  assert.ok(h.first < h.last);
  assert.deepStrictEqual(tr.health('nobody', { since }), { agent: 'nobody', entries: 0, first: null, last: null, fileBytes: 0, recent: 0 });
  assert.strictEqual(fs.existsSync(tr.fileFor('nobody')), false, 'no file made');
  tr.close();
  fs.chmodSync(tr.fileFor('foreman'), 0o000);
  const err = console.error; console.error = () => {};
  try { assert.strictEqual(createTranscript({ file, dir, log: quiet }).health('foreman', { since }), null); }
  finally { console.error = err; fs.chmodSync(tr.fileFor('foreman'), 0o600); }
});

test('searchTimes: each agent\'s real searches are timed (the newest 50, of the last 7 days), none before its first search', () => {
  const { file, dir } = place();
  let t = Date.parse('2026-11-01T00:00:00Z');
  const tr = createTranscript({ file, dir, log: quiet, now: () => t });
  for (let i = 0; i < 60; i++) tr.record({ agent: 'doc', kind: 'user', text: `infusion note ${i}` });
  assert.deepStrictEqual(tr.searchTimes('doc'), { count: 0, maxMs: 0, slow: 0, verySlow: 0, failed: 0, lastAt: null });
  for (let i = 0; i < 55; i++) tr.search('doc', 'infusion');
  const st = tr.searchTimes('doc');
  assert.deepStrictEqual([st.count, st.lastAt], [50, t]);
  assert.ok(st.maxMs > 0 && st.slow <= st.count && st.verySlow <= st.slow);
  assert.strictEqual(tr.searchTimes('watchman').count, 0, 'per agent');
  // a search that fails is not timed, but counted as failed
  new Database(tr.fileFor('doc')).exec('DROP TABLE entries_fts; CREATE TABLE entries_fts (text TEXT)');   // an index that can't be searched
  tr.close();
  const tr2 = createTranscript({ file, dir, log: quiet, now: () => t });
  const err = console.error; console.error = () => {};
  try { assert.deepStrictEqual(tr2.search('doc', 'infusion'), []); } finally { console.error = err; }
  assert.deepStrictEqual([tr2.searchTimes('doc').failed, tr2.searchTimes('doc').count], [1, 0]);
  t += 8 * 86400000;
  assert.strictEqual(tr2.searchTimes('doc').failed, 0, 'older than a week: no longer counted');
  tr2.close();
});

test('tidyStep: the search index is merged a bounded step at a time until a step merges nothing; searches still find everything', () => {
  const { file, dir } = place();
  const tr = createTranscript({ file, dir, log: quiet });
  tr.record({ agent: 'doc', kind: 'user', text: 'first visit' });
  // small index pages and no automatic merging, so the index is many segments and each step can do only part of it
  const Database = require('better-sqlite3');
  tr.close();
  const db = new Database(tr.fileFor('doc'));
  db.exec("INSERT INTO entries_fts(entries_fts, rank) VALUES('pgsz', 64); INSERT INTO entries_fts(entries_fts, rank) VALUES('automerge', 0); INSERT INTO entries_fts(entries_fts, rank) VALUES('crisismerge', 2000);");
  db.close();
  for (let i = 0; i < 400; i++) tr.record({ agent: 'doc', kind: 'user', text: `visit ${i} infusion schedule note w${i}x` });
  let steps = 0, r;
  do { r = tr.tidyStep('doc', { pages: 16, first: steps === 0 }); steps++; } while (!r.done && steps < 5000);
  assert.strictEqual(r.done, true);
  assert.ok(steps > 3, `a big index takes several steps (took ${steps}); a step that wrote pages is not the end`);
  const again = tr.tidyStep('doc', { pages: 16, first: true });
  assert.strictEqual(again.done, true, 'once done, even a fresh first step finds nothing left to merge');
  assert.strictEqual(tr.search('doc', 'infusion', { limit: 100 }).length, 100);
  assert.strictEqual(tr.tidyStep('nobody'), null, 'no archive: nothing to tidy, no file made');
  assert.strictEqual(fs.existsSync(tr.fileFor('nobody')), false);
  tr.close();
});

test('tidyStep: before the split every agent shares the combined file, which one agent\'s tidy leaves alone', () => {
  const { file, dir } = place();
  const Database = require('better-sqlite3');
  const tr0 = createTranscript({ file, dir, log: quiet });
  tr0.close();
  const db = new Database(file); db.exec('CREATE TABLE IF NOT EXISTS placeholder (x)'); db.close();   // the combined file exists: combined mode
  const tr = createTranscript({ file, dir, log: quiet });
  tr.record({ agent: 'doc', kind: 'user', text: 'kept in the combined file' });
  assert.deepStrictEqual(tr.tidyStep('doc', { first: true }), { combined: true });
  tr.close();
});
