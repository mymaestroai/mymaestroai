'use strict';
// A deleted agent's things moved into its bundle (lib/agent-archive): moves that never replace or lose anything, across
// disks too, and its own conversation archive file leaving with everything its write-ahead log still held.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { moveAside, freeName } = require('../lib/agent-archive');
const { createTranscript } = require('../lib/transcript');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-archive-'));

test('moveAside: renames into the bundle, never over something already there; nothing to move is not an error', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'ws')); fs.writeFileSync(path.join(d, 'ws', 'SOUL.md'), 'one');
  fs.mkdirSync(path.join(d, 'b')); fs.mkdirSync(path.join(d, 'b', 'workspace')); fs.writeFileSync(path.join(d, 'b', 'workspace', 'SOUL.md'), 'kept earlier');
  assert.strictEqual(moveAside(path.join(d, 'ws'), path.join(d, 'b', 'workspace')), true);
  assert.strictEqual(fs.readFileSync(path.join(d, 'b', 'workspace', 'SOUL.md'), 'utf8'), 'kept earlier');
  assert.strictEqual(fs.readFileSync(path.join(d, 'b', 'workspace-2', 'SOUL.md'), 'utf8'), 'one');
  fs.writeFileSync(path.join(d, 'chat.jsonl'), 'x'); fs.writeFileSync(path.join(d, 'b', 'chat.jsonl'), 'y'); fs.writeFileSync(path.join(d, 'b', 'chat-2.jsonl'), 'z');
  moveAside(path.join(d, 'chat.jsonl'), path.join(d, 'b', 'chat.jsonl'));
  assert.strictEqual(fs.readFileSync(path.join(d, 'b', 'chat-3.jsonl'), 'utf8'), 'x');
  assert.strictEqual(freeName(path.join(d, 'b', 'nothing.json')), path.join(d, 'b', 'nothing.json'));
  assert.strictEqual(moveAside(path.join(d, 'missing'), path.join(d, 'b', 'missing')), false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('moveAside: across disks the folder is copied whole under a temporary name first, then the original goes', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'ws', 'records'), { recursive: true }); fs.writeFileSync(path.join(d, 'ws', 'records', 'a.md'), 'facts');
  fs.symlinkSync('/etc/passwd', path.join(d, 'ws', 'link'));
  fs.mkdirSync(path.join(d, 'b'));
  const real = fs.renameSync;
  const seen = [];
  fs.renameSync = (from, to) => { seen.push(path.basename(String(to))); if (String(from) === path.join(d, 'ws')) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); return real(from, to); };
  try { assert.strictEqual(moveAside(path.join(d, 'ws'), path.join(d, 'b', 'workspace')), true); } finally { fs.renameSync = real; }
  assert.deepStrictEqual(seen, ['workspace', 'workspace'], 'the whole copy was renamed into place');
  assert.strictEqual(fs.readFileSync(path.join(d, 'b', 'workspace', 'records', 'a.md'), 'utf8'), 'facts');
  assert.strictEqual(fs.readlinkSync(path.join(d, 'b', 'workspace', 'link')), '/etc/passwd', 'a link is copied as the link, not what it points to');
  assert.ok(!fs.existsSync(path.join(d, 'ws')) && !fs.existsSync(path.join(d, 'b', 'workspace.copying')));
  fs.rmSync(d, { recursive: true, force: true });
});

test('moveOut: an agent\'s own archive file leaves whole (its write-ahead log folded in first); one already in the bundle is never replaced', () => {
  const d = tmp();
  const tr = createTranscript({ file: path.join(d, 'transcript.db'), dir: path.join(d, 'transcripts'), log: () => {} });
  for (let i = 0; i < 30; i++) tr.record({ agent: 'gone', kind: 'user', text: `message number ${i}` });
  tr.record({ agent: 'stay', kind: 'user', text: 'not moved' });
  const f = tr.fileFor('gone');
  assert.ok(fs.existsSync(`${f}-wal`), 'rows still in the log while the archive is open');
  const b = path.join(d, 'bundle'); fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'archive.db'), 'an earlier one');
  assert.deepStrictEqual(tr.moveOut('gone', path.join(b, 'archive.db')), { moved: true, rows: 30 });
  assert.strictEqual(fs.readFileSync(path.join(b, 'archive.db'), 'utf8'), 'an earlier one');
  assert.ok(!fs.existsSync(f) && !fs.existsSync(`${f}-wal`) && !fs.existsSync(`${f}-shm`));
  assert.ok(!fs.existsSync(path.join(b, 'archive-2.db-wal')), 'nothing left in a separate log');
  const Database = require('better-sqlite3');
  const db = new Database(path.join(b, 'archive-2.db'), { readonly: true });
  try { assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM entries').get().n, 30); } finally { db.close(); }
  assert.deepStrictEqual(tr.stats('gone').entries, 0, 'the hub sees nothing for that name now');
  assert.deepStrictEqual(tr.stats('stay').entries, 1);
  assert.deepStrictEqual(tr.moveOut('gone', path.join(b, 'archive.db')), { moved: false, rows: 0 }, 'again: nothing left');
  tr.close();
  fs.rmSync(d, { recursive: true, force: true });
});
