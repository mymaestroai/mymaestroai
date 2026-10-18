'use strict';
// Records: per-agent documents loaded in full every turn (lib/records). The folder is under the hub's
// workspaces/, so the test points the module at a copy of lib/ inside a temp hub.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL = path.resolve(__dirname, '..');
const roots = [];
function load() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-records-')); roots.push(root);
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(hub, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(REAL, 'lib', 'records.js'), path.join(hub, 'lib', 'records.js'));
  fs.writeFileSync(path.join(hub, 'lib', 'settings.js'), 'module.exports = { getSetting: (k, d) => (k === "recordsMaxBytes" ? (global.__recCap || 0) : d) };');
  return { rec: require(path.join(hub, 'lib', 'records.js')), hub, root };
}
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); delete global.__recCap; });

test('write / list / read / describe; names are cleaned; append adds; symlinked records are written through', () => {
  const { rec, hub, root } = load();
  assert.strictEqual(rec.list('gp').length, 0);
  assert.match(rec.describe('gp'), /no Records yet/);
  assert.match(rec.write('gp', 'sam', '# Sam\nTeam blue'), /Record sam\.md written \(\d+ bytes\)/);
  assert.strictEqual(rec.write('gp', '../evil.md', 'x'), 'Bad record name.', 'slashes stripped, then a leading dot is refused');
  assert.match(rec.write('gp', 'ev/il', 'x'), /Record evil\.md written/, 'slashes stripped: stays inside the folder, .md added');
  assert.ok(!fs.existsSync(path.join(hub, 'workspaces', 'gp', 'records', '..evil.md')));
  assert.strictEqual(rec.write('gp', '.hidden', 'x'), 'Bad record name.');
  rec.write('gp', 'sam.md', '\nLane 3', { append: true });
  assert.strictEqual(rec.read('gp', 'sam.md'), '# Sam\nTeam blue\nLane 3');
  const outside = path.join(root, 'projects', 'garden.md');
  fs.mkdirSync(path.dirname(outside), { recursive: true }); fs.writeFileSync(outside, '# Garden');
  fs.symlinkSync(outside, path.join(hub, 'workspaces', 'gp', 'records', 'garden.md'));
  const l = rec.list('gp');
  assert.deepStrictEqual(l.map(x => [x.name, x.symlink]), [['evil.md', false], ['garden.md', true], ['sam.md', false]]);
  rec.write('gp', 'garden.md', '# Garden\nupdated');
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), '# Garden\nupdated', 'the real file behind the link is updated, link kept');
  assert.ok(fs.lstatSync(path.join(hub, 'workspaces', 'gp', 'records', 'garden.md')).isSymbolicLink());
  assert.match(rec.describe('gp'), /garden\.md: \d+ bytes.*link to/);
  assert.strictEqual(rec.remove('gp', 'evil.md'), true);
  assert.strictEqual(rec.remove('gp', 'evil.md'), false);
});

test('contextSection: every record in full, cap by bytes (agent field, settings, default 256 KB), files index appended', () => {
  const { rec } = load();
  assert.strictEqual(rec.contextSection('nobody'), '');
  rec.write('x', 'a.md', 'A'.repeat(1000));
  rec.write('x', 'b.md', 'B'.repeat(1000));
  const full = rec.contextSection('x');
  assert.match(full, /^# Records \(source of truth, loaded in full every turn\)/);
  assert.ok(full.includes('### a.md\n' + 'A'.repeat(1000)) && full.includes('### b.md\n' + 'B'.repeat(1000)));
  assert.match(full, /recall/);
  const capped = rec.contextSection('x', { agentRecord: { recordsMaxBytes: 1500 } });
  assert.ok(capped.includes('### a.md') && !capped.includes('### b.md'));
  assert.match(capped, /Not loaded, over the 1 KB records cap: b\.md \(1000 bytes\)/);
  global.__recCap = 1200;
  assert.ok(!rec.contextSection('x').includes('### b.md'), 'settings cap applies when the agent has none');
  global.__recCap = 0;
  assert.strictEqual(rec.maxBytesFor('x'), rec.DEFAULT_MAX);
  const withIdx = rec.contextSection('x', { filesIndex: '/tmp/files\n- plan.pdf (10 bytes, 2026-10-01)' });
  assert.match(withIdx, /### Files folder index \(maintained by the hub\)\n\/tmp\/files\n- plan\.pdf/);
});

test('filesIndex: recursive, newest first, hidden skipped, capped with a count', () => {
  const { rec, root } = load();
  const d = path.join(root, 'files'); fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(d, 'old.txt'), 'o'); fs.utimesSync(path.join(d, 'old.txt'), new Date('2026-01-01'), new Date('2026-01-01'));
  fs.writeFileSync(path.join(d, 'sub', 'new.pdf'), 'nn'); fs.writeFileSync(path.join(d, '.DS_Store'), 'x');
  const idx = rec.filesIndex(d);
  assert.match(idx, /^\/.*files\n- sub\/new\.pdf \(2 bytes, \d{4}-\d{2}-\d{2}\)\n- old\.txt \(1 bytes, 2026-01-01\)$/);
  assert.match(rec.filesIndex(d, { max: 1 }), /and 1 more$/);
  assert.match(rec.filesIndex(path.join(root, 'nope')), /^\(empty\)/);
});
