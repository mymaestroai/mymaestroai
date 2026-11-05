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

test('removeBundle: a finished bundle goes for good (links inside removed, never followed); one still being put away, or anything else, is refused', async () => {
  const { createAgentArchive } = require('../lib/agent-archive');
  const d = tmp();
  const archive = createAgentArchive({ dataDir: d, log: () => {} });
  const dir = path.join(d, 'archived-agents');
  fs.mkdirSync(path.join(dir, 'rifle-20261102T214939Z', 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'rifle-20261102T214939Z', 'manifest.json'), JSON.stringify({ name: 'rifle' }));
  const outside = path.join(d, 'keep.txt'); fs.writeFileSync(outside, 'not the bundle\'s');
  fs.symlinkSync(outside, path.join(dir, 'rifle-20261102T214939Z', 'workspace', 'link'));
  fs.mkdirSync(path.join(dir, 'old-20261101T000000Z.partial'));
  fs.writeFileSync(path.join(dir, 'old-20261101T000000Z.partial', 'manifest.json'), JSON.stringify({ name: 'old' }));
  await assert.rejects(archive.removeBundle('old-20261101T000000Z.partial'), /still being put away/);
  await assert.rejects(archive.removeBundle('../keep.txt'), /no such folder/);
  await assert.rejects(archive.removeBundle('nothing'), /no such folder/);
  assert.deepStrictEqual(await archive.removeBundle('rifle-20261102T214939Z'), { folder: 'rifle-20261102T214939Z', name: 'rifle' });
  assert.strictEqual(fs.existsSync(path.join(dir, 'rifle-20261102T214939Z')), false);
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'not the bundle\'s', 'what a link pointed to is untouched');
  assert.deepStrictEqual(archive.bundles().map(b => b.folder), ['old-20261101T000000Z.partial']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('removeBundle: the folder must still hold the agent whose name was typed; a delete that stopped part-way is finished at the next start; only folders are bundles', async () => {
  const { createAgentArchive } = require('../lib/agent-archive');
  const d = tmp();
  const archive = createAgentArchive({ dataDir: d, log: () => {} });
  const dir = path.join(d, 'archived-agents');
  fs.mkdirSync(path.join(dir, 'rifle-20261102T214939Z'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'rifle-20261102T214939Z', 'manifest.json'), JSON.stringify({ name: 'rifle' }));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'a file someone put here');
  fs.symlinkSync(d, path.join(dir, 'linked'));
  assert.deepStrictEqual(archive.bundles().map(b => b.folder), ['rifle-20261102T214939Z'], 'a file or a link is not a bundle');
  await assert.rejects(archive.removeBundle('rifle-20261102T214939Z', { expectName: 'scope' }), /now holds rifle, not scope/);
  assert.ok(fs.existsSync(path.join(dir, 'rifle-20261102T214939Z')), 'kept when the name does not match');
  // a removal that stops part-way: what is left is hidden, never listed again, and finished at the next start
  const realRm = fs.promises.rm;
  fs.promises.rm = async () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); };
  try { await assert.rejects(archive.removeBundle('rifle-20261102T214939Z', { expectName: 'rifle' }), /EIO/); } finally { fs.promises.rm = realRm; }
  assert.strictEqual(fs.readdirSync(dir).filter(n => n.startsWith('.deleting-')).length, 1, 'renamed before the removal');
  assert.deepStrictEqual(archive.bundles().map(b => b.folder), [], 'never listed again');
  await archive.finishPending();
  assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.startsWith('.deleting-')), [], 'finished at the next start');
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')) && fs.existsSync(path.join(dir, 'linked')), 'nothing else touched');
  fs.rmSync(d, { recursive: true, force: true });
});

test('removeBundle: a sweep of unfinished deletes that runs meanwhile leaves this removal alone, so it never reports a false failure', async () => {
  const { createAgentArchive } = require('../lib/agent-archive');
  const d = tmp();
  const archive = createAgentArchive({ dataDir: d, log: () => {} });
  const dir = path.join(d, 'archived-agents');
  fs.mkdirSync(path.join(dir, 'rifle-20261102T214939Z', 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'rifle-20261102T214939Z', 'manifest.json'), JSON.stringify({ name: 'rifle' }));
  const realRm = fs.promises.rm;
  let swept = false;
  fs.promises.rm = async (p, o) => { if (!swept) { swept = true; await archive.finishPending(); } return realRm(p, o); };
  try { assert.deepStrictEqual(await archive.removeBundle('rifle-20261102T214939Z', { expectName: 'rifle' }), { folder: 'rifle-20261102T214939Z', name: 'rifle' }); }
  finally { fs.promises.rm = realRm; }
  assert.strictEqual(swept, true);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'gone, nothing left behind');
  fs.rmSync(d, { recursive: true, force: true });
});
