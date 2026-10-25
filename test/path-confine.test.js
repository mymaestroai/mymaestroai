'use strict';
// lib/path-confine: resolveLanding() answers "where does this path really land?", following symlinks on every
// component (including dangling and nested-through-another-symlink), so the boxed file tools and the Records
// loader can refuse a path that escapes the mounts even when the target does not exist yet.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveLanding, underAny } = require('../lib/path-confine');

function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-test-')); test.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

test('resolveLanding follows symlinks on every component, dangling and nested', () => {
  const d = tmp();
  const ws = path.join(d, 'ws'); fs.mkdirSync(ws, { recursive: true });
  const host = path.join(d, 'host'); fs.mkdirSync(host, { recursive: true });
  fs.symlinkSync(host, path.join(ws, 'out'));                                   // out -> /host (exists)
  fs.symlinkSync(path.join(ws, 'out', 'new.md'), path.join(ws, 'nested.md'));   // nested.md -> ws/out/new.md (new.md absent)
  fs.symlinkSync(path.join(host, 'notyet.txt'), path.join(ws, 'dangling.txt')); // dangling.txt -> /host/notyet.txt (absent)
  fs.writeFileSync(path.join(ws, 'real.txt'), 'x');
  fs.symlinkSync(path.join(ws, 'real.txt'), path.join(ws, 'alias.txt'));        // alias -> ws/real.txt (inside)
  const roots = [fs.realpathSync.native(ws)];
  const inside = (p) => underAny(resolveLanding(p), roots);

  assert.strictEqual(inside(path.join(ws, 'nested.md')), false, 'a record linked through a symlinked dir to a not-yet-created host file escapes -> refused');
  assert.strictEqual(inside(path.join(ws, 'out', 'x.md')), false, 'a new file under a symlinked-out directory -> refused');
  assert.strictEqual(inside(path.join(ws, 'dangling.txt')), false, 'a dangling symlink to outside -> refused');
  // `..` in a symlink target must be applied AFTER following preceding symlinks (kernel semantics), not
  // collapsed lexically: jump -> /host, record -> jump/../secret must resolve to /host/secret, not ws/secret.
  fs.mkdirSync(path.join(host, 'subdir'), { recursive: true });
  fs.symlinkSync(path.join(host, 'subdir'), path.join(ws, 'jump'));
  fs.symlinkSync('jump/../secret.txt', path.join(ws, 'viajump.md'));
  assert.strictEqual(inside(path.join(ws, 'viajump.md')), false, 'a ".." in a symlink target cannot escape by lexical collapse');
  // A literal backslash is a legal POSIX filename character, not a separator: a symlink NAMED with one must
  // be followed as a single component, not split.
  if (process.platform !== 'win32') {
    fs.symlinkSync(host, path.join(ws, 'a\\b'));                 // a file literally named a\b -> /host
    fs.symlinkSync('a\\b/secret.txt', path.join(ws, 'viabs.md')); // record -> a\b/secret.txt
    assert.strictEqual(inside(path.join(ws, 'viabs.md')), false, 'a backslash in a symlink target is not a separator');
  }
  assert.strictEqual(inside(path.join(ws, 'alias.txt')), true, 'a symlink that stays inside -> allowed');
  assert.strictEqual(inside(path.join(ws, 'brand-new.md')), true, 'a brand-new name in the mount -> allowed');
  assert.strictEqual(inside(path.join(ws, 'sub', 'deep.md')), true, 'a new file in a not-yet-created subdir of the mount -> allowed');
});

test('resolveLanding fails closed on a symlink cycle (under no root)', () => {
  const d = tmp();
  const ws = path.join(d, 'ws'); fs.mkdirSync(ws, { recursive: true });
  fs.symlinkSync(path.join(ws, 'b'), path.join(ws, 'a'));
  fs.symlinkSync(path.join(ws, 'a'), path.join(ws, 'b'));   // a <-> b cycle
  assert.strictEqual(underAny(resolveLanding(path.join(ws, 'a')), [fs.realpathSync.native(ws)]), false, 'a cycle is under no root');
});
