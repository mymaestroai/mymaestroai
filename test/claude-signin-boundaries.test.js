'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const guard = require('../lib/claude-signin-guard');
const { startGroup } = require('../lib/claude-signin-group');
const { supervise, ownsGroup, MARKER } = require('../lib/claude-signin-supervisor');
const { authStatus } = require('../lib/claude-signin');
const { fixtureDir, writeDummy } = require('./fixtures/fake-claude-client');
const code = fs.readFileSync(require.resolve('../lib/claude-signin-guard'), 'utf8');
function loadGuard(env, marker) {
  return vm.runInNewContext(code, { module: {}, __dirname: '/private/install/lib',
    require: name => name === 'node:fs' ? { existsSync: () => marker } : require(name),
    process: { env } });
}
test('both entry points can request permission but a sealed launch stays sealed', () => {
  for (const [env, marker] of [[{ MM_TEST_NO_REAL_CLAUDE: '1' }, false],
    [{ NODE_TEST_CONTEXT: 'child' }, false], [{}, true]]) {
    const g = loadGuard(env, marker);
    delete env.MM_TEST_NO_REAL_CLAUDE;
    delete env.NODE_TEST_CONTEXT;
    g.allowRealEffects();
    assert.equal(g.realAllowed(), false);
    assert.throws(() => g.guardProgramWith(true, 'bash'));
  }
  const production = loadGuard({}, false);
  production.allowRealEffects();
  assert.equal(production.realAllowed(), true);
});
test('status refuses a bare name with a different child PATH; fake spawn never called', () => {
  let calls = 0;
  assert.throws(() => authStatus({ bin: 'claude', env: { PATH: '/private/bin' },
    spawn: () => { calls++; } }), /refused/);
  assert.equal(calls, 0);
  assert.equal(guard.allowedProgram('/nonexistent/claude'), false);
  assert.equal(guard.allowedProgram(guard.FIXTURE), true);
});
test('direct installer group admission checks the fake marker', () => {
  let calls = 0;
  const spawn = () => { calls++; return Object.assign(new EventEmitter(), { connected: false }); };
  const options = { spawn, installer: true, stdio: ['ignore', 'ignore', 'ignore'] };
  assert.throws(() => startGroup('bash', [], options), /refused/);
  assert.equal(calls, 0);
  spawn.__fakeSpawn = true;
  startGroup('bash', [], options);
  assert.equal(calls, 1);
});
test('supervisor refuses a foreign group before installing any signal handlers', () => {
  const channel = Object.assign(new EventEmitter(), { connected: true });
  let code;
  supervise({ channel, argv: [MARKER], ownsProcessGroup: () => false,
    exit: value => { code = value; }, kill: assert.fail });
  assert.equal(code, 1);
  assert.equal(channel.eventNames().length, 0);
});
test('supervisor validates a forwarding spawn before invoking it', () => {
  let calls = 0;
  const results = [];
  const channel = Object.assign(new EventEmitter(), { connected: true, send: m => results.push(m) });
  supervise({ channel, argv: [MARKER], ownsProcessGroup: () => true,
    spawn: () => { calls++; }, kill: assert.fail, setTimer: assert.fail });
  channel.emit('message', { op: 'start', bin: 'claude', args: [] });
  assert.equal(calls, 0);
  assert.deepEqual(results, [{ op: 'result', code: 1 }]);
});
test('ownership uses the actual PGID on both supported systems', () => {
  for (const pgid of [42, 41]) {
    assert.equal(ownsGroup({ platform: 'linux', pid: 42,
      read: () => '42 (name ) here) S 12 ' + pgid + ' 42' }), pgid === 42);
    assert.equal(ownsGroup({ platform: 'darwin', pid: 42,
      exec: () => '  ' + pgid + '\n' }), pgid === 42);
  }
  assert.equal(ownsGroup({ platform: 'darwin', pid: 42, exec: () => { throw Error(); } }), false);
});
test('fixture refuses a missing or escaping config and replaces a credentials symlink', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-boundary-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'allowed');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'redirect'));
  for (const raw of [undefined, root, outside, path.join(root, 'redirect', 'new')])
    assert.throws(() => fixtureDir(raw, root));
  const dir = fixtureDir(path.join(root, 'new', 'config'), root);
  const sentinel = path.join(outside, 'sentinel');
  fs.writeFileSync(sentinel, 'unchanged');
  fs.symlinkSync(sentinel, path.join(dir, '.credentials.json'));
  writeDummy(dir);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'))).token, 'dummy-token');
});
test('unapproved npm lookup touches neither npmrc nor npm, even without a test env', () => {
  const loader = fs.readFileSync(require.resolve('../lib/sdk-loader'), 'utf8');
  for (const env of [{}, { npm_config_prefix: '/private/npm' }]) {
    const mod = { exports: {} };
    const effects = [];
    const fake = name => name === './claude-signin-guard' ? { realAllowed: () => false }
      : ['fs', 'child_process'].includes(name) ? new Proxy({}, {
        get: (_, key) => () => { effects.push(key); throw Error(); } }) : require(name);
    vm.runInNewContext(loader, { module: mod, require: fake, __dirname: '/private/lib', process: { env } });
    assert.equal(mod.exports.globalNpmRoot(), null);
    assert.deepEqual(effects, []);
  }
});
