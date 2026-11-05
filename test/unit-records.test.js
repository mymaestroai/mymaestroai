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
function load({ budget = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-records-')); roots.push(root);
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(hub, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(REAL, 'lib', 'records.js'), path.join(hub, 'lib', 'records.js'));
  if (budget) for (const f of ['context-budget.js', 'context-window.js']) fs.copyFileSync(path.join(REAL, 'lib', f), path.join(hub, 'lib', f));   // the gateway's prompt budget
  fs.copyFileSync(path.join(REAL, 'lib', 'path-confine.js'), path.join(hub, 'lib', 'path-confine.js'));
  fs.copyFileSync(path.join(REAL, 'lib', 'timezone.js'), path.join(hub, 'lib', 'timezone.js'));   // dates in the person's local time
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

test('the working brief loads first, so it is never the file the cap leaves out; usage counts what the next turn loads', () => {
  const { rec } = load();
  global.__recCap = 4000;
  try {
    rec.write('wb', 'alpha.md', 'a'.repeat(2000));
    rec.write('wb', 'more.md', 'm'.repeat(1500));
    rec.write('wb', 'working-brief.md', 'b'.repeat(600));
    rec.write('wb', 'zeta.md', 'z'.repeat(100));
    assert.deepStrictEqual(rec.list('wb').map(i => i.name), ['working-brief.md', 'alpha.md', 'more.md', 'zeta.md']);
    const ctx = rec.contextSection('wb');
    assert.ok(ctx.indexOf('### working-brief.md') >= 0 && ctx.indexOf('### working-brief.md') < ctx.indexOf('### alpha.md'), 'the brief is in, and first');
    assert.match(ctx, /Not loaded, over the 4 KB records cap: more\.md \(1500 bytes\)\. Condense your Records/);
    assert.deepStrictEqual(rec.usage('wb'), { used: 2700, cap: 4000, pct: 68, files: 3, notLoaded: [{ name: 'more.md', bytes: 1500 }] });
  } finally { global.__recCap = 0; }
});

test('from 75% of the cap the agent is told to condense its Records: in its context, after record_write and in record_list', () => {
  const { rec } = load();
  global.__recCap = 4000;
  try {
    assert.doesNotMatch(rec.write('cz', 'a.md', 'a'.repeat(2600)), /Condense/, '65%: nothing said');
    assert.doesNotMatch(rec.contextSection('cz'), /Condense/);
    assert.match(rec.describe('cz'), /In all 3 KB of their 4 KB cap \(65%\)\./);
    const w = rec.write('cz', 'b.md', 'b'.repeat(600));
    assert.match(w, /Record b\.md written \(600 bytes\)\. It is loaded in full on your next turn\. Your Records use 3 KB of their 4 KB cap \(80%\); a file that would pass the cap is not loaded\. Condense them soon: keep every fact you still need/);
    assert.match(rec.contextSection('cz'), /\(Your Records use 3 KB of their 4 KB cap \(80%\); past it, files stop loading\. Condense them soon/);
    assert.match(rec.describe('cz'), /Your Records use 3 KB of their 4 KB cap \(80%\)/);
  } finally { global.__recCap = 0; }
});

test('a Record that does not fit is never reported as loading: record_write says so, record_list names it', () => {
  const { rec } = load();
  global.__recCap = 4000;
  try {
    const w = rec.write('big', 'huge.md', 'h'.repeat(5000));
    assert.match(w, /^Record huge\.md written \(5000 bytes\), but it doesn't fit in your Records cap, so it will NOT be loaded on your next turn\. Your Records use 0 KB of their 4 KB cap \(0%\); a file that would pass the cap is not loaded\. Not loaded now: huge\.md \(5 KB\)\./);
    assert.match(rec.describe('big'), /Not loaded now: huge\.md \(5 KB\)\./);
    assert.match(rec.write('big', 'small.md', 's'.repeat(100)), /^Record small\.md written \(100 bytes\)\. It is loaded in full on your next turn\. Your Records use 0 KB .* Not loaded now: huge\.md/, 'the others still hear about the one left out');
  } finally { global.__recCap = 0; }
});

test("the cap Records load under: the client routes use the agent's own; other models the prompt budget's share of their window; the last prompt's cap wins", () => {
  const { rec } = load({ budget: true });
  const cb = require(path.join(REAL, 'lib', 'context-budget.js'));
  assert.strictEqual(rec.loadCap('a', { agentRecord: { name: 'a', model: 'claude-sdk/claude-opus-5-5' } }), 256 * 1024);
  assert.strictEqual(rec.loadCap('b', { agentRecord: { name: 'b', model: 'codex-cli/gpt-6-astra', recordsMaxBytes: 100000 } }), 100000);
  const gw = { name: 'c', model: 'someprovider/unknown-model' };   // an unknown model: the default cloud window
  assert.strictEqual(cb.knownWindow(gw.model), cb.DEFAULT_CLOUD);
  const planned = cb.plan(cb.DEFAULT_CLOUD, { recordsCapBytes: 256 * 1024 }).recordsBytes;
  assert.strictEqual(rec.loadCap('c', { agentRecord: gw }), planned);
  assert.ok(planned < 256 * 1024, `its window gives Records less than the default cap (${planned})`);
  assert.strictEqual(rec.loadCap('d', { agentRecord: { name: 'd', model: 'openai/gpt-x', contextWindow: 32000 } }), cb.plan(32000).recordsBytes, 'the agent\'s own window setting');
  rec.write('e', 'notes.md', 'n'.repeat(3000));
  rec.contextSection('e', { agentRecord: { name: 'e', recordsMaxBytes: 2000 } });   // what its last prompt loaded under
  assert.deepStrictEqual([rec.usage('e', { agentRecord: { name: 'e' } }).cap, rec.usage('e', { agentRecord: { name: 'e' } }).notLoaded.map(f => f.name)], [2000, ['notes.md']]);
});

test('usage strict: a records folder that exists but cannot be read is an error, not "no Records"', { skip: process.getuid && process.getuid() === 0 }, () => {
  const { rec } = load();
  rec.write('locked', 'a.md', 'x');
  fs.chmodSync(rec.folderFor('locked'), 0o000);
  try {
    assert.throws(() => rec.usage('locked', { strict: true }), /EACCES/);
    assert.strictEqual(rec.usage('locked').files, 0, 'the lenient path used by replies stays quiet');
    assert.strictEqual(rec.usage('nobody', { strict: true }).files, 0, 'no folder at all is simply none');
  } finally { fs.chmodSync(rec.folderFor('locked'), 0o755); }
});

test('one load plan for the prompt, the replies and the check: a file too big to fit is left out unread; strict names a file it cannot read', { skip: process.getuid && process.getuid() === 0 }, () => {
  const { rec } = load();
  global.__recCap = 4000;
  try {
    rec.write('lp', 'aa.md', 'a'.repeat(1000));
    rec.write('lp', 'huge.md', 'h'.repeat(20000));
    fs.chmodSync(path.join(rec.folderFor('lp'), 'huge.md'), 0o000);   // reading it would fail: it is never read
    const u = rec.usage('lp', { strict: true });
    assert.deepStrictEqual([u.used, u.notLoaded], [1000, [{ name: 'huge.md', bytes: 20000 }]]);
    assert.match(rec.contextSection('lp'), /Not loaded, over the 4 KB records cap: huge\.md \(20000 bytes\)/, 'the prompt leaves out the same file');
    rec.write('lp', 'small.md', 's'.repeat(100));
    fs.chmodSync(path.join(rec.folderFor('lp'), 'small.md'), 0o000);
    assert.throws(() => rec.usage('lp', { strict: true }), /small\.md: EACCES/, 'strict: a Record that exists but cannot be read is named');
    assert.strictEqual(rec.usage('lp').files, 1, 'the lenient path (the agent\'s own replies) stays quiet');
    fs.chmodSync(path.join(rec.folderFor('lp'), 'small.md'), 0o644);
    fs.chmodSync(path.join(rec.folderFor('lp'), 'huge.md'), 0o644);
  } finally { global.__recCap = 0; }
});

test('routeCap works the cap out as the gateway does before a turn; a cap remembered from a prompt counts only for the same model', async () => {
  const { rec } = load({ budget: true });
  const cb = require(path.join(REAL, 'lib', 'context-budget.js'));
  assert.deepStrictEqual(await rec.routeCap('a', { agentRecord: { name: 'a', model: 'claude-sdk/claude-opus-5-5' } }), { cap: 256 * 1024, estimated: false });
  assert.deepStrictEqual(await rec.routeCap('b', { agentRecord: { name: 'b', model: 'someprovider/unknown-model' } }), { cap: cb.plan(cb.DEFAULT_CLOUD).recordsBytes, estimated: false });
  const local = await rec.routeCap('c', { agentRecord: { name: 'c', model: 'lmstudio/some-model' } });
  assert.strictEqual(local.estimated, true, 'LM Studio did not answer: the window, and so the cap, is an estimate');
  assert.deepStrictEqual(await rec.routeCap('d', { agentRecord: { name: 'd', model: 'lmstudio/some-model', contextWindow: 32000 } }), { cap: cb.plan(32000).recordsBytes, estimated: false }, 'the agent\'s own window setting needs no server');
  rec.contextSection('f', { agentRecord: { name: 'f', model: 'someprovider/x', recordsMaxBytes: 2000 } });
  assert.strictEqual(rec.loadCap('f', { agentRecord: { name: 'f', model: 'someprovider/x' } }), 2000, 'the last prompt\'s cap, same model');
  assert.strictEqual(rec.loadCap('f', { agentRecord: { name: 'f', model: 'claude-sdk/claude-opus-5-5' } }), 256 * 1024, 'after a model switch it is worked out again');
});

test('unloadable: Records the prompt never loads and never mentions (a dead link, a link outside the area, a name it can\'t open) are named for the check', () => {
  const { rec } = load();
  rec.write('ul', 'fine.md', 'ok');
  const dir = rec.folderFor('ul');
  fs.symlinkSync(path.join(dir, '..', 'gone.md'), path.join(dir, 'dead.md'));
  fs.symlinkSync('/etc/hostname', path.join(dir, 'outside.md'));
  const long = `${'x'.repeat(130)}.md`;
  fs.writeFileSync(path.join(dir, long), 'never opened');
  fs.symlinkSync(path.join(dir, 'loop-b.md'), path.join(dir, 'loop-a.md'));
  fs.symlinkSync(path.join(dir, 'loop-a.md'), path.join(dir, 'loop-b.md'));
  fs.mkdirSync(path.join(dir, `${'d'.repeat(130)}.md`));   // a folder named like a Record was never one
  assert.deepStrictEqual(rec.list('ul').map(i => i.name), ['fine.md'], 'only fine.md loads');
  assert.deepStrictEqual(rec.unloadable('ul').sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'dead.md', kind: 'link', why: 'a link to a file that no longer exists' },
    { name: 'loop-a.md', kind: 'link', why: 'a link that goes round in a circle' },
    { name: 'loop-b.md', kind: 'link', why: 'a link that goes round in a circle' },
    { name: 'outside.md', kind: 'link', why: 'a link the hub won\'t follow' },
    { name: long, kind: 'name', why: 'its name has characters or a length the hub can\'t open' }]);
  assert.deepStrictEqual(rec.unloadable('nobody'), []);
});
