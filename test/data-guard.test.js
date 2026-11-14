'use strict';
// The suite's data/ guard (test/helpers/data-guard.js, loaded by scripts/run-tests.js into every process): each kind of access
// under a protected data/ folder is refused and fails the process, the rest of the disk is not, children are covered, and the
// allow-list works. The probes run against a FAKE install in a temp folder (MM_DATA_GUARD_ROOT); the real one stays protected.
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
fs.symlinkSync(path.join(FAKE, 'data'), path.join(FAKE, 'other-name'));
const SQLITE = path.join(REAL, 'node_modules', 'better-sqlite3');

// Runs `body` (the source of a script) in a child with the guard loaded; -> { code, out (stdout lines), err (guard lines) }.
function probe(body, { env = {}, cwd = tmp } = {}) {
  const file = path.join(tmp, `probe-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, `'use strict';\nconst fs = require('fs'); const path = require('path'); const F = ${JSON.stringify(FAKE)};\n` +
    `const out = []; const t = (n, f) => { try { const r = f(); out.push(n + ': ok' + (r === undefined ? '' : ' ' + JSON.stringify(r))); } catch (e) { out.push(n + ': ' + e.code); } };\n` +
    `${body}\n`);
  const r = spawnSync(process.execPath, [file], { cwd, encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: `--require ${JSON.stringify(GUARD)}`, MM_DATA_GUARD_ROOT: FAKE, MM_DATA_GUARD_TEST: 'test/probe.test.js', ...env } });
  return { code: r.status, out: r.stdout.trim().split('\n').filter(Boolean), err: r.stderr.split('\n').filter(l => l.startsWith('data-guard:')) };
}

test('every kind of access under data/ is refused, and a refusal the code caught still fails the process', () => {
  const r = probe(`
t('readFileSync', () => fs.readFileSync(path.join(F, 'data', 'x.json'), 'utf8'));
t('writeFileSync', () => fs.writeFileSync(path.join(F, 'data', 'new.json'), '{}'));
t('existsSync', () => fs.existsSync(path.join(F, 'data', 'x.json')));
t('statSync of the folder', () => fs.statSync(path.join(F, 'data')).isDirectory());
t('readdirSync', () => fs.readdirSync(path.join(F, 'data')));
t('relative mkdir', () => { process.chdir(F); fs.mkdirSync('data/sub', { recursive: true }); });
t('through a link', () => fs.readFileSync(path.join(F, 'other-name', 'x.json'), 'utf8'));
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
  const got = Object.fromEntries(r.out.map(l => l.split(': ')));
  for (const k of ['readFileSync', 'writeFileSync', 'statSync of the folder', 'readdirSync', 'relative mkdir', 'through a link', 'rename into data', 'copy out of data', 'better-sqlite3', 'callback', 'promise']) assert.strictEqual(got[k], 'EACCES', `${k} is refused`);
  assert.strictEqual(got.existsSync, 'ok false', 'existsSync answers false (it never throws) and still counts');
  assert.strictEqual(got['outside data/'], 'ok "fine"');
  assert.strictEqual(got['sqlite outside data/'], 'ok true', 'a guarded better-sqlite3 still makes real instances');
  assert.strictEqual(got['a file descriptor'], 'ok "number"');
  assert.strictEqual(r.code, 1, 'process.exit(0) after a refusal still exits 1');
  assert.ok(!fs.existsSync(path.join(FAKE, 'data', 'new.json')) && !fs.existsSync(path.join(FAKE, 'data', 'sub')) && !fs.existsSync(path.join(FAKE, 'data', 'a.db')), 'nothing was written');
  assert.ok(fs.existsSync(path.join(FAKE, 'outside.txt')), 'the rename never ran');
  assert.ok(r.err.some(l => l.startsWith('data-guard: test/probe.test.js read data/x.json (fs.readFileSync)')), r.err.join('\n'));
  assert.ok(r.err.some(l => l.includes('wrote data/a.db (better-sqlite3)')), r.err.join('\n'));
});

test('a process that keeps out of data/ is untouched and exits 0', () => {
  const r = probe(`t('read', () => fs.readFileSync(path.join(F, 'outside.txt'), 'utf8')); console.log(out.join('\\n'));`);
  assert.deepStrictEqual([r.code, r.out, r.err], [0, ['read: ok "fine"'], []]);
});

test('a child the test starts is covered and reported under the test file', () => {
  const r = probe(`
const { spawnSync } = require('child_process');
const c = spawnSync(process.execPath, ['-e', "require('fs').readFileSync(process.argv[1])", path.join(F, 'data', 'x.json')], { encoding: 'utf8' });
console.log('child ' + c.status); process.stderr.write(c.stderr);`);
  assert.deepStrictEqual(r.out, ['child 1']);
  assert.ok(r.err.some(l => l.startsWith('data-guard: test/probe.test.js read data/x.json')), r.err.join('\n'));
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

test('npm test loads the guard into every process of the run', () => {
  const src = fs.readFileSync(path.join(REAL, 'scripts', 'run-tests.js'), 'utf8');
  assert.ok(src.includes("const GUARD = path.join(ROOT, 'test', 'helpers', 'data-guard.js');"));
  assert.ok(src.includes('env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + \' \' : \'\'}--require ${JSON.stringify(GUARD)}`;'));
  assert.ok(/spawnSync\(process\.execPath, \['--test'[^\n]*\{ cwd: ROOT, stdio: 'inherit', env \}\)/.test(src));
});
