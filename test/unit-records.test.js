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
  fs.copyFileSync(path.join(REAL, 'lib', 'path-confine.js'), path.join(hub, 'lib', 'path-confine.js'));
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
  // A legitimate record symlink that stays inside the agent's own workspace is written through, link kept.
  const linked = path.join(hub, 'workspaces', 'gp', 'docs', 'garden.md');
  fs.mkdirSync(path.dirname(linked), { recursive: true }); fs.writeFileSync(linked, '# Garden');
  fs.symlinkSync(linked, path.join(hub, 'workspaces', 'gp', 'records', 'garden.md'));
  const l = rec.list('gp');
  assert.deepStrictEqual(l.map(x => [x.name, x.symlink]), [['evil.md', false], ['garden.md', true], ['sam.md', false]]);
  rec.write('gp', 'garden.md', '# Garden\nupdated');
  assert.strictEqual(fs.readFileSync(linked, 'utf8'), '# Garden\nupdated', 'the real file behind the link is updated, link kept');
  assert.ok(fs.lstatSync(path.join(hub, 'workspaces', 'gp', 'records', 'garden.md')).isSymbolicLink());
  assert.match(rec.describe('gp'), /garden\.md: \d+ bytes.*link to/);
  // R1: a record symlink that escapes the workspaces / hub-home tree is refused for read, write and listing.
  const escaped = path.join(root, 'projects', 'secret.md');
  fs.mkdirSync(path.dirname(escaped), { recursive: true }); fs.writeFileSync(escaped, 'SECRET');
  fs.symlinkSync(escaped, path.join(hub, 'workspaces', 'gp', 'records', 'leak.md'));
  assert.strictEqual(rec.read('gp', 'leak.md'), null, 'an escaping symlink is not readable');
  assert.ok(!rec.list('gp').some(x => x.name === 'leak.md'), 'an escaping symlink is not listed or loaded');
  assert.match(rec.write('gp', 'leak.md', 'overwrite'), /outside your records area/, 'writing through an escaping symlink is refused');
  assert.strictEqual(fs.readFileSync(escaped, 'utf8'), 'SECRET', 'the host file behind the escaping link is untouched');
  // A dangling symlink to outside (target not created yet) is refused too, so a write cannot create a host file.
  fs.symlinkSync(path.join(root, 'projects', 'notyet.md'), path.join(hub, 'workspaces', 'gp', 'records', 'dangling.md'));
  assert.match(rec.write('gp', 'dangling.md', 'x'), /outside your records area/, 'writing through a dangling escaping symlink is refused');
  assert.ok(!fs.existsSync(path.join(root, 'projects', 'notyet.md')), 'the dangling target was not created outside');
  // A record linked THROUGH a symlinked directory to a not-yet-created outside file is refused (nested dangling).
  fs.symlinkSync(path.join(root, 'projects'), path.join(hub, 'workspaces', 'gp', 'records', 'outdir'));
  fs.symlinkSync(path.join(hub, 'workspaces', 'gp', 'records', 'outdir', 'new.md'), path.join(hub, 'workspaces', 'gp', 'records', 'nested.md'));
  assert.match(rec.write('gp', 'nested.md', 'x'), /outside your records area/, 'writing through a nested escaping symlink is refused');
  assert.ok(!fs.existsSync(path.join(root, 'projects', 'new.md')), 'the nested dangling target was not created outside');
  assert.strictEqual(rec.remove('gp', 'evil.md'), true);
  assert.strictEqual(rec.remove('gp', 'evil.md'), false);
});

test('a records folder replaced with a symlink cannot land a new record on the host', () => {
  const { rec, hub, root } = load();
  const recDir = path.join(hub, 'workspaces', 'gp2', 'records');
  fs.mkdirSync(path.join(hub, 'workspaces', 'gp2'), { recursive: true });
  const target = path.join(root, 'elsewhere'); fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, recDir);   // workspaces/gp2/records -> root/elsewhere (outside the workspaces tree)
  assert.match(rec.write('gp2', 'x', 'data'), /outside your records area/, 'writing a new record through a symlinked records folder is refused');
  assert.ok(!fs.existsSync(path.join(target, 'x.md')), 'nothing was written outside');
});

test('targetAllowed confines record symlinks to the hub home and workspaces, never secrets or code', () => {
  const rec = require(path.join(REAL, 'lib', 'records.js'));
  const hh = require(path.join(REAL, 'lib', 'hub-home'));
  assert.ok(rec.targetAllowed(path.join(hh.HUB_HOME, 'medical', 'patients', 'patient.md')), 'a link into medical/ is allowed');
  assert.ok(rec.targetAllowed(path.join(REAL, 'workspaces', 'doc', 'records', 'x.md')), 'a link into workspaces/ is allowed');
  assert.ok(!rec.targetAllowed('/etc/passwd'), 'a link to /etc is refused');
  assert.ok(!rec.targetAllowed(path.join(REAL, 'data', 'settings.json')), 'a link to data/ is refused');
  assert.ok(!rec.targetAllowed(path.join(REAL, '.env')), 'a link to .env is refused');
  assert.ok(!rec.targetAllowed(path.join(REAL, 'lib', 'sdk-chat.js')), 'a link to the hub code is refused');
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
