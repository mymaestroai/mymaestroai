'use strict';
// Download cards for paths with spaces and for bare file names: lib/ui-file-card.js (candidatesFrom), lib/files.js (findByName)
// and the guidance line in lib/agents.js. The /api/files/resolve route tests are in files-downloads.test.js (they need its server harness).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../lib/ui-file-card.js');
const { createFiles } = require('../lib/files.js');

const code = (text, { pre = false } = {}) => ({ textContent: text, closest: (s) => (pre && s === 'pre' ? {} : null) });
const msg = (anchors = [], codes = []) => ({ querySelectorAll: (s) => (s === 'a[href]' ? anchors : s === 'code' ? codes : []) });
const a = (href) => ({ getAttribute: (n) => (n === 'href' ? href : null), closest: () => null, querySelectorAll: () => [] });
const items = (codes, opts) => H.candidatesFrom(msg([], codes), opts).map((c) => c.item);

test('candidatesFrom: a code span holding a whole absolute path with spaces is an { abs } candidate; prose and bad segments are not', () => {
  assert.deepStrictEqual(items([code('/srv/share/sam/Bench Cut Files/ply 12 part.tap')]), [{ abs: '/srv/share/sam/Bench Cut Files/ply 12 part.tap' }]);
  assert.deepStrictEqual(items([code('  /srv/share/sam/Bench Cut Files/ply 12 part.tap  ')]), [{ abs: '/srv/share/sam/Bench Cut Files/ply 12 part.tap' }]);
  assert.deepStrictEqual(items([code('I saved it to /srv/share/sam/Bench Cut Files/part.tap')]), [], 'a sentence is not a path');
  assert.deepStrictEqual(items([code('/srv/share/a.txt and /srv/share/b.txt')]), [], 'two paths in one span: a segment ends with a space');
  assert.deepStrictEqual(items([code('/a/ b.txt')]), [], 'a segment starting with a space');
  assert.deepStrictEqual(items([code('/a /b.txt')]), [], 'a segment ending with a space');
  assert.deepStrictEqual(items([code('/a//b.txt')]), [], 'no "//"');
  assert.deepStrictEqual(items([code('/a/b\tc.txt')]), [], 'no tab');
  assert.deepStrictEqual(items([code('/a/' + 'x'.repeat(1030) + '.txt')]), [], 'longer than 1024');
  assert.deepStrictEqual(items([code('/srv/Bench Cut Files/part 1.tap', { pre: true })]), [], 'code in a pre block is ignored');
  // a link whose decoded href holds spaces
  const out = H.candidatesFrom(msg([a('/srv/share/Bench%20Cut%20Files/part%201.tap')]));
  assert.deepStrictEqual(out.map((c) => c.item), [{ abs: '/srv/share/Bench Cut Files/part 1.tap' }]);
});

test('candidatesFrom: with opts.agent a code span holding just a file name is { name, agent }; without it, nothing', () => {
  assert.deepStrictEqual(items([code('part 1.tap')], { agent: 'sam' }), [{ name: 'part 1.tap', agent: 'sam' }]);
  assert.deepStrictEqual(items([code(' report.pdf ')], { agent: 'sam' }), [{ name: 'report.pdf', agent: 'sam' }]);
  assert.deepStrictEqual(items([code('part 1.tap')]), [], 'no opts: no request');
  assert.deepStrictEqual(items([code('part 1.tap')], {}), []);
  assert.deepStrictEqual(items([code('part 1.tap')], { agent: '' }), []);
  assert.deepStrictEqual(items([code('part 1.tap')], { agent: null }), []);
  for (const bad of ['notes', '.env', '../x.txt', 'a/b.txt', 'a\\b.txt', 'a.', '.txt', ' .txt', 'x.toolongext1', 'two words', 'a b. c', 'name with trailing .txt ', 'ab', 'a\tb.txt', '. .txt', 'x'.repeat(256) + '.txt']) {
    assert.deepStrictEqual(items([code(bad)], { agent: 'sam' }), [], `not a bare name: ${JSON.stringify(bad)}`);
  }
  assert.deepStrictEqual(items([code('a.b')], { agent: 'sam' }), [{ name: 'a.b', agent: 'sam' }], 'the shortest name: 3 characters');
  assert.deepStrictEqual(items([code('x'.repeat(251) + '.txt')], { agent: 'sam' }).length, 1, '255 characters is fine');
  assert.deepStrictEqual(items([code('report.pdf', { pre: true })], { agent: 'sam' }), [], 'a pre block is ignored');
  assert.strictEqual(H.keyOf({ name: 'part 1.tap', agent: 'sam' }), 'n:sam|part 1.tap');
  assert.notStrictEqual(H.keyOf({ name: 'a.txt', agent: 'sam' }), H.keyOf({ name: 'a.txt', agent: 'sam2' }));
});

test('candidatesFrom: links first, then code spans in order (paths and names together), de-duplicated, capped at 12', () => {
  const out = H.candidatesFrom(msg([a('/api/files/download?agent=sam&path=out.pdf')], [code('b file.txt'), code('/srv/x/c d.txt'), code('b file.txt')]), { agent: 'sam' });
  assert.deepStrictEqual(out.map((c) => c.item), [{ path: 'out.pdf', agent: 'sam' }, { name: 'b file.txt', agent: 'sam' }, { abs: '/srv/x/c d.txt' }]);
  const many = Array.from({ length: 20 }, (_, i) => code(i % 2 ? `/srv/x/f ${i}.txt` : `n ${i}.txt`));
  const capped = H.candidatesFrom(msg([a('/srv/l1.txt')], many), { agent: 'sam' });
  assert.strictEqual(capped.length, 12);
  assert.deepStrictEqual(capped[0].item, { abs: '/srv/l1.txt' });
  assert.deepStrictEqual(capped[1].item, { name: 'n 0.txt', agent: 'sam' });
  assert.deepStrictEqual(capped[2].item, { abs: '/srv/x/f 1.txt' });
});

// ── findByName ──
function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'findbyname-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const put = (root, rel, data = 'x') => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };

test('findByName: the one file with that exact name, in a folder with spaces; none or two give null', (t) => {
  const root = tmpRoot(t);
  const files = createFiles({ hubHome: root, dataDir: root });
  put(root, 'Bench Cut Files/part 1.tap');
  put(root, 'Bench Cut Files/other.tap');
  put(root, 'top.txt');
  assert.strictEqual(files.findByName(root, 'part 1.tap'), 'Bench Cut Files/part 1.tap');
  assert.strictEqual(files.findByName(root, 'top.txt'), 'top.txt');
  assert.strictEqual(files.findByName(root, 'missing.txt'), null);
  assert.strictEqual(files.findByName(root, 'Part 1.tap'), null, 'case-sensitive');
  put(root, 'second/part 1.tap');
  assert.strictEqual(files.findByName(root, 'part 1.tap'), null, 'two files with the name: ambiguous');
  assert.strictEqual(files.findByName(root, 'other.tap'), 'Bench Cut Files/other.tap', 'other names are unaffected');
  fs.mkdirSync(path.join(root, 'dir.d'));
  assert.strictEqual(files.findByName(root, 'dir.d'), null, 'a folder is not a file');
});

test('findByName: invalid names, symlinks and dot-folders are never found', (t) => {
  const root = tmpRoot(t);
  const files = createFiles({ hubHome: root, dataDir: root });
  put(root, 'real.txt');
  put(root, '.hidden/secret.txt');
  put(root, '.dotfile.txt');
  fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link.txt'));
  assert.strictEqual(files.findByName(root, 'real.txt'), 'real.txt');
  assert.strictEqual(files.findByName(root, 'link.txt'), null, 'a symlinked file');
  assert.strictEqual(files.findByName(root, 'secret.txt'), null, 'a file in a dot-folder');
  assert.strictEqual(files.findByName(root, '.dotfile.txt'), null, 'a dot-file');
  for (const bad of ['', 'a/real.txt', '../real.txt', 'x\\real.txt', 'real\0.txt', '..', 'a..b.txt', ' real.txt', 'real.txt ', null, 5, undefined]) {
    assert.strictEqual(files.findByName(root, bad), null, `invalid name ${JSON.stringify(bad)}`);
  }
});

test('findByName: a file below maxDepth, or a walk cut by maxEntries, is null (an incomplete walk cannot prove uniqueness)', (t) => {
  const root = tmpRoot(t);
  const files = createFiles({ hubHome: root, dataDir: root });
  put(root, 'a/b/c/deep.txt');
  put(root, 'a/shallow.txt');
  assert.strictEqual(files.findByName(root, 'deep.txt'), 'a/b/c/deep.txt');
  assert.strictEqual(files.findByName(root, 'deep.txt', { maxDepth: 2 }), null, 'the folder tree is deeper than maxDepth');
  assert.strictEqual(files.findByName(root, 'shallow.txt', { maxDepth: 2 }), null, 'a walk that skipped a folder is incomplete even if the match was seen');
  assert.strictEqual(files.findByName(root, 'shallow.txt', { maxDepth: 3 }), 'a/shallow.txt');
  for (let i = 0; i < 10; i++) put(root, `many/f${i}.txt`);
  assert.strictEqual(files.findByName(root, 'shallow.txt', { maxEntries: 3 }), null, 'truncated walk');
});

// ── guidance ──
test('lib/agents.js: the Files folder guidance asks for the full path in a code span', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agents.js'), 'utf8');
  assert.ok(src.includes('give its full path in a code span'));
  assert.ok(src.includes('a bare file name works only when no other file in this folder has the same name'));
  assert.ok(src.includes('Keep deliverables for the owner here. When you tell them'), 'the existing text comes first');
});

test('review: a version or a number in a code span is not a file name (the extension needs a letter)', () => {
  assert.deepStrictEqual(items([code('5.10.0'), code('3.14'), code('v2.0'), code('1.5'), code('part 1.tap'), code('archive.7z'), code('clip.mp4')], { agent: 'sam' }),
    [{ name: 'part 1.tap', agent: 'sam' }, { name: 'archive.7z', agent: 'sam' }, { name: 'clip.mp4', agent: 'sam' }]);
});

test('review: nameIndex walks once and answers every name; findByName with that index agrees; an unreadable folder makes it incomplete', (t) => {
  const root = tmpRoot(t);
  const files = createFiles({ hubHome: root, dataDir: root });
  put(root, 'Bench Cut Files/part 1.tap'); put(root, 'a/dup.txt'); put(root, 'b/dup.txt');
  const idx = files.nameIndex(root);
  assert.strictEqual(idx.complete, true);
  assert.strictEqual(files.findByName(root, 'part 1.tap', { index: idx }), 'Bench Cut Files/part 1.tap');
  assert.strictEqual(files.findByName(root, 'dup.txt', { index: idx }), null, 'ambiguous through the index too');
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {   // root reads anything: the check needs an ordinary user
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked); put(root, 'locked/inner.txt');
    fs.chmodSync(locked, 0o000);
    let idx2;
    try { idx2 = files.nameIndex(root); } finally { fs.chmodSync(locked, 0o700); }   // readable again before the temp folder is removed
    assert.strictEqual(idx2.complete, false, 'a folder it could not read');
    assert.strictEqual(files.findByName(root, 'part 1.tap', { index: idx2 }), null, 'a second file could hide in the folder it could not read');
  }
});
