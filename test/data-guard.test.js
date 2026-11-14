'use strict';
// The suite's data/ guard (test/helpers/data-guard.js, loaded by scripts/run-tests.js into every process): each kind of access
// under a protected data/ folder is refused and fails the process, the rest of the disk is not, links and folders holding
// data/ count, children are covered, the allow-list works, and run-tests.js fails a run on any refusal. The probes run
// against FAKE installs in a temp folder (MM_DATA_GUARD_ROOT, or a copy of the runner and guard); the real one stays protected.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REAL = path.join(__dirname, '..');
const GUARD = path.join(__dirname, 'helpers', 'data-guard.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-guard-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const FAKE = path.join(tmp, 'inst');
fs.mkdirSync(path.join(FAKE, 'data'), { recursive: true });
fs.writeFileSync(path.join(FAKE, 'data', 'x.json'), '{"a":1}');
fs.writeFileSync(path.join(FAKE, 'outside.txt'), 'fine');
fs.symlinkSync(path.join(FAKE, 'data'), path.join(FAKE, 'other-name'));            // a link inside the install
fs.symlinkSync(path.join(FAKE, 'data'), path.join(tmp, 'alias'));                  // a link from outside it
fs.symlinkSync(path.join(FAKE, 'data', 'x.json'), path.join(tmp, 'link-to-x'));
fs.symlinkSync(path.join(FAKE, 'data', 'x.json'), path.join(FAKE, 'data', 'agents.example.json'));   // the allowed name, pointing at another entry
// A second install whose data/ is itself a link to a store elsewhere.
const LINKED = path.join(tmp, 'linked');
fs.mkdirSync(path.join(tmp, 'store'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'store', 's.json'), '{}');
fs.mkdirSync(LINKED, { recursive: true });
fs.symlinkSync(path.join(tmp, 'store'), path.join(LINKED, 'data'));
const SQLITE = path.join(REAL, 'node_modules', 'better-sqlite3');

// Runs `body` (the source of a script) in a child with the guard loaded; -> { code, out (stdout lines), err (guard lines), report }.
function probe(body, { env = {}, cwd = tmp } = {}) {
  const id = Math.random().toString(36).slice(2);
  const file = path.join(tmp, `probe-${id}.js`);
  const report = path.join(tmp, `report-${id}.jsonl`);
  fs.writeFileSync(file, `'use strict';\nconst fs = require('fs'); const path = require('path'); const F = ${JSON.stringify(FAKE)}; const T = ${JSON.stringify(tmp)};\n` +
    `const out = []; const t = (n, f) => { try { const r = f(); out.push(n + ': ok' + (r === undefined ? '' : ' ' + JSON.stringify(r))); } catch (e) { out.push(n + ': ' + e.code); } };\n` +
    `${body}\n`);
  const r = spawnSync(process.execPath, [file], { cwd, encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: `--require ${JSON.stringify(GUARD)}`, MM_DATA_GUARD_ROOT: FAKE, MM_DATA_GUARD_TEST: 'test/probe.test.js', MM_DATA_GUARD_REPORT: report, ...env } });
  let lines = [];
  try { lines = fs.readFileSync(report, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { /* none */ }
  return { code: r.status, out: r.stdout.trim().split('\n').filter(Boolean), err: r.stderr.split('\n').filter(l => l.startsWith('data-guard:')), report: lines };
}
const results = (r) => Object.fromEntries(r.out.map(l => { const i = l.indexOf(': '); return [l.slice(0, i), l.slice(i + 2)]; }));

test('every kind of access under data/ is refused, and a refusal the code caught still fails the process', () => {
  const r = probe(`
t('readFileSync', () => fs.readFileSync(path.join(F, 'data', 'x.json'), 'utf8'));
t('writeFileSync', () => fs.writeFileSync(path.join(F, 'data', 'new.json'), '{}'));
t('existsSync', () => fs.existsSync(path.join(F, 'data', 'x.json')));
t('statSync of the folder', () => fs.statSync(path.join(F, 'data')).isDirectory());
t('readdirSync', () => fs.readdirSync(path.join(F, 'data')));
t('relative mkdir', () => { process.chdir(F); fs.mkdirSync('data/sub', { recursive: true }); });
t('rename into data', () => fs.renameSync(path.join(F, 'outside.txt'), path.join(F, 'data', 'moved.txt')));
t('copy out of data', () => fs.copyFileSync(path.join(F, 'data', 'x.json'), path.join(F, 'copy.json')));
t('better-sqlite3', () => { const D = require(${JSON.stringify(SQLITE)}); new D(path.join(F, 'data', 'a.db')); });
t('outside data/', () => fs.readFileSync(path.join(F, 'outside.txt'), 'utf8'));
t('sqlite outside data/', () => { const D = require(${JSON.stringify(SQLITE)}); const d = new D(path.join(F, 'ok.db')); d.close(); return d instanceof D; });
t('a file descriptor', () => typeof fs.fstatSync(0).size);
let cb = 'none';
try { fs.readFile(path.join(F, 'data', 'x.json'), () => {}); } catch (e) { cb = e.code; }
out.push('callback: ' + cb);
fs.promises.readFile(path.join(F, 'data', 'x.json')).then(() => 'ok', e => e.code).then(p => { out.push('promise: ' + p); console.log(out.join('\\n')); process.exit(0); });
`);
  const got = results(r);
  for (const k of ['readFileSync', 'writeFileSync', 'statSync of the folder', 'readdirSync', 'relative mkdir', 'rename into data', 'copy out of data', 'better-sqlite3', 'callback', 'promise']) assert.strictEqual(got[k], 'EACCES', `${k} is refused`);
  assert.strictEqual(got.existsSync, 'ok false', 'existsSync answers false (it never throws) and still counts');
  assert.strictEqual(got['outside data/'], 'ok "fine"');
  assert.strictEqual(got['sqlite outside data/'], 'ok true', 'a guarded better-sqlite3 still makes real instances');
  assert.strictEqual(got['a file descriptor'], 'ok "number"');
  assert.strictEqual(r.code, 1, 'process.exit(0) after a refusal still exits 1');
  assert.ok(!fs.existsSync(path.join(FAKE, 'data', 'new.json')) && !fs.existsSync(path.join(FAKE, 'data', 'sub')) && !fs.existsSync(path.join(FAKE, 'data', 'a.db')), 'nothing was written');
  assert.ok(fs.existsSync(path.join(FAKE, 'outside.txt')), 'the rename never ran');
  assert.ok(r.err.some(l => l.startsWith('data-guard: test/probe.test.js read data/x.json (fs.readFileSync)')), r.err.join('\n'));
  assert.ok(r.err.some(l => l.includes('wrote data/a.db (better-sqlite3)')), r.err.join('\n'));
  assert.ok(r.report.some(e => e.test === 'test/probe.test.js' && e.path === 'data/x.json' && e.how === 'fs.readFileSync'), 'each refusal is written to the report file');
});

test('links count both ways: into data/ from anywhere, and a data/ that is itself a link', () => {
  const r = probe(`
t('link inside the install', () => fs.readFileSync(path.join(F, 'other-name', 'x.json'), 'utf8'));
t('link from outside', () => fs.readFileSync(path.join(T, 'alias', 'x.json'), 'utf8'));
t('file link from outside', () => fs.readFileSync(path.join(T, 'link-to-x'), 'utf8'));
t('allowed name pointing elsewhere in data/', () => fs.readFileSync(path.join(F, 'data', 'agents.example.json'), 'utf8'));
t('the linked store by its own path', () => fs.readFileSync(path.join(T, 'store', 's.json'), 'utf8'));
t('removing a link that points into data/', () => { fs.symlinkSync(path.join(F, 'data', 'x.json'), path.join(T, 'tmp-link')); fs.unlinkSync(path.join(T, 'tmp-link')); });
console.log(out.join('\\n'));`, { env: { MM_DATA_GUARD_ROOT: '' } });
  // With MM_DATA_GUARD_ROOT empty only the real install is protected: the fake one is then plain disk.
  assert.strictEqual(results(r)['link from outside'], 'ok "{\\"a\\":1}"');
  const g = probe(`
t('link inside the install', () => fs.readFileSync(path.join(F, 'other-name', 'x.json'), 'utf8'));
t('link from outside', () => fs.readFileSync(path.join(T, 'alias', 'x.json'), 'utf8'));
t('file link from outside', () => fs.readFileSync(path.join(T, 'link-to-x'), 'utf8'));
t('allowed name pointing elsewhere in data/', () => fs.readFileSync(path.join(F, 'data', 'agents.example.json'), 'utf8'));
t('removing a link that points into data/', () => { fs.symlinkSync(path.join(F, 'data', 'x.json'), path.join(T, 'tmp-link')); fs.unlinkSync(path.join(T, 'tmp-link')); });
console.log(out.join('\\n'));`);
  const got = results(g);
  for (const k of ['link inside the install', 'link from outside', 'file link from outside', 'allowed name pointing elsewhere in data/']) assert.strictEqual(got[k], 'EACCES', k);
  assert.strictEqual(got['removing a link that points into data/'], 'ok', 'a link is removed, never what it points to');
  assert.ok(fs.existsSync(path.join(FAKE, 'data', 'x.json')));
  const linked = probe(`t('the linked store by its own path', () => fs.readFileSync(path.join(T, 'store', 's.json'), 'utf8')); console.log(out.join('\\n'));`, { env: { MM_DATA_GUARD_ROOT: LINKED } });
  assert.deepStrictEqual(results(linked), { 'the linked store by its own path': 'EACCES' });
});

test('removing, renaming or copying a folder that holds data/ is refused before anything moves', () => {
  const r = probe(`
t('rm of the install', () => fs.rmSync(F, { recursive: true, force: true }));
t('rm of its parent', () => fs.rmSync(T, { recursive: true, force: true }));
t('rename of the install', () => fs.renameSync(F, path.join(T, 'moved')));
t('cp of the install', () => fs.cpSync(F, path.join(T, 'copy'), { recursive: true }));
t('recursive readdir of the install', () => fs.readdirSync(F, { recursive: true }));
t('plain readdir of the install', () => fs.readdirSync(F).includes('data'));
t('sqlite backup into data/', () => { const D = require(${JSON.stringify(SQLITE)}); const d = new D(':memory:'); return d.backup(path.join(F, 'data', 'b.db')); });
Promise.resolve().then(() => console.log(out.join('\\n')));`);
  const got = results(r);
  for (const k of ['rm of the install', 'rm of its parent', 'rename of the install', 'cp of the install', 'recursive readdir of the install']) assert.strictEqual(got[k], 'EACCES', k);
  assert.strictEqual(got['plain readdir of the install'], 'ok true', 'listing the install itself is fine');
  assert.ok(fs.existsSync(path.join(FAKE, 'data', 'x.json')) && !fs.existsSync(path.join(tmp, 'moved')) && !fs.existsSync(path.join(tmp, 'copy')));
  assert.strictEqual(r.code, 1);
  assert.ok(r.report.some(e => e.how === 'better-sqlite3 backup' && e.path === 'data/b.db'), JSON.stringify(r.report));
});

test('a process that keeps out of data/ is untouched and exits 0', () => {
  const r = probe(`t('read', () => fs.readFileSync(path.join(F, 'outside.txt'), 'utf8')); console.log(out.join('\\n'));`);
  assert.deepStrictEqual([r.code, r.out, r.err, r.report], [0, ['read: ok "fine"'], [], []]);
});

test('a child the test starts is covered and reported under the test file', () => {
  const r = probe(`
const { spawnSync } = require('child_process');
const c = spawnSync(process.execPath, ['-e', "require('fs').readFileSync(process.argv[1])", path.join(F, 'data', 'x.json')], { encoding: 'utf8' });
console.log('child ' + c.status); process.stderr.write(c.stderr);`);
  assert.deepStrictEqual(r.out, ['child 1']);
  assert.strictEqual(r.code, 0, 'the parent itself touched nothing');
  assert.ok(r.err.some(l => l.startsWith('data-guard: test/probe.test.js read data/x.json')), r.err.join('\n'));
  assert.ok(r.report.some(e => e.test === 'test/probe.test.js' && e.path === 'data/x.json' && e.pid !== undefined), 'the child wrote its refusal to the report the runner reads');
});

test('the allow-list lets one test file read one entry, and nothing more', () => {
  const r = probe(`
require(${JSON.stringify(GUARD)}).ALLOW.push({ file: 'test/probe.test.js', path: 'x.json', access: 'read', reason: 'probe' });
t('allowed read', () => fs.readFileSync(path.join(F, 'data', 'x.json'), 'utf8'));
t('write to it', () => fs.writeFileSync(path.join(F, 'data', 'x.json'), '{}'));
console.log(out.join('\\n'));`);
  assert.deepStrictEqual(r.out, ['allowed read: ok "{\\"a\\":1}"', 'write to it: EACCES']);
  assert.strictEqual(r.code, 1);
  const other = probe(`require(${JSON.stringify(GUARD)}).ALLOW.push({ file: 'test/probe.test.js', path: 'x.json', access: 'read', reason: 'probe' });
t('read', () => fs.readFileSync(path.join(F, 'data', 'x.json'), 'utf8')); console.log(out.join('\\n'));`, { env: { MM_DATA_GUARD_TEST: 'test/other.test.js' } });
  assert.deepStrictEqual([other.out, other.code], [['read: EACCES'], 1], 'the entry is for one test file only');
});

test('the real install stays protected while a fake one is added', () => {
  const r = probe(`t('real settings', () => fs.existsSync(path.join(${JSON.stringify(REAL)}, 'data', 'settings.json'))); console.log(out.join('\\n'));`);
  assert.deepStrictEqual([r.out, r.code], [['real settings: ok false'], 1]);
  assert.ok(r.err.some(l => l.includes('read data/settings.json (fs.existsSync)')), r.err.join('\n'));
});

test('every allow-list entry names its test file, its path, its access and why', () => {
  const { ALLOW } = require('./helpers/data-guard');
  for (const a of ALLOW) {
    assert.ok(a.file === '*' || /^test\/.+\.test\.js$/.test(a.file), JSON.stringify(a));
    assert.ok(typeof a.path === 'string' && a.path && !a.path.startsWith('/') && !a.path.includes('..'), JSON.stringify(a));
    assert.ok(a.access === 'read' || a.access === 'any', JSON.stringify(a));
    assert.ok(typeof a.reason === 'string' && a.reason.length > 20, JSON.stringify(a));
  }
});

// npm test end to end, on a fake install holding this runner and this guard: a passing test whose child touched data/ fails the run.
function fakeRun(name, tests) {
  const inst = path.join(tmp, name);
  fs.mkdirSync(path.join(inst, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(inst, 'test', 'helpers'), { recursive: true });
  fs.mkdirSync(path.join(inst, 'data'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'data', 'x.json'), '{}');
  fs.copyFileSync(path.join(REAL, 'scripts', 'run-tests.js'), path.join(inst, 'scripts', 'run-tests.js'));
  fs.copyFileSync(GUARD, path.join(inst, 'test', 'helpers', 'data-guard.js'));
  for (const [f, src] of Object.entries(tests)) fs.writeFileSync(path.join(inst, 'test', f), `'use strict';\nconst { test } = require('node:test');\nconst path = require('path');\n${src}\n`);
  return spawnSync(process.execPath, [path.join(inst, 'scripts', 'run-tests.js')], { cwd: inst, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
}

test('npm test fails the run when a child touched data/, even if its test ignored the child', () => {
  const r = fakeRun('run-bad', {
    'a.test.js': `test('starts a child and ignores how it ended', () => { require('child_process').spawnSync(process.execPath, ['-e', "require('fs').readFileSync('data/x.json')"], { cwd: path.join(__dirname, '..'), stdio: 'ignore' }); });`,
    'b.test.js': `test('fine', () => {});`,
  });
  assert.match(r.stdout, /# pass 2/, 'both tests themselves pass');
  assert.strictEqual(r.status, 1, r.stdout.slice(-400) + r.stderr.slice(-400));
  assert.match(r.stderr, /run-tests: FAILED, tests touched the install's own data\/ \(1 refused\):\n {2}test\/a\.test\.js: data\/x\.json \(fs\.readFileSync\)/);
  const ok = fakeRun('run-good', { 'b.test.js': `test('fine', () => {});` });
  assert.strictEqual(ok.status, 0, ok.stdout.slice(-400) + ok.stderr.slice(-400));
  assert.doesNotMatch(ok.stderr, /data-guard|FAILED/);
});
