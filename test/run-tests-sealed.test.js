'use strict';
// A source test: scripts/run-tests.js seals the suite from the real machine (it never runs the suite itself here).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8');

test('run-tests.js points the Claude folder and npm folders at fresh folders under a temp root, and turns the update notifier off', () => {
  assert.match(src, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'mm-tests-'\)\)/, 'a temp root made with mkdtempSync under os.tmpdir()');
  for (const k of ['CLAUDE_CONFIG_DIR', 'npm_config_prefix', 'npm_config_cache']) {
    assert.match(src, new RegExp(`env\\.${k} = path\\.join\\(sealRoot, `), `${k} is set under the temp root`);
  }
  assert.match(src, /env\.NPM_CONFIG_UPDATE_NOTIFIER = 'false'/);
  assert.match(src, /DOCKER_HOST/, 'DOCKER_HOST handling stays');
  assert.match(src, /docker-for-tests\.sock/, 'DOCKER_HOST points at a socket that does not exist');
});

test('run-tests.js runs the suite with a private HOME, and only the three home-sensitive policy files with the real one', () => {
  assert.match(src, /const privateHome = path\.join\(sealRoot, 'home'\)/);
  assert.match(src, /\[run\.filter\(file => !homePolicy\.has\(file\)\), privateHome\]/, 'the main batch gets the private HOME');
  assert.match(src, /\[run\.filter\(file => homePolicy\.has\(file\)\), env\.HOME \|\| os\.homedir\(\)\]/, 'the policy batch gets the real HOME');
  const list = src.match(/const homePolicy = new Set\(\[([^\]]*)\]\)/);
  assert.ok(list, 'the policy files are listed');
  assert.deepStrictEqual([...list[1].matchAll(/'([^']+)'/g)].map(m => m[1]),
    ['test/lockbox-wire.test.js', 'test/tool-policy.test.js', 'test/tool-policy-heredoc.test.js']);
  for (const f of ['lockbox-wire', 'tool-policy', 'tool-policy-heredoc']) assert.ok(fs.existsSync(path.join(__dirname, f + '.test.js')), f);
});

test('run-tests.js marks the run as sealed for the Claude guard', () => {
  assert.match(src, /env\.MM_TEST_NO_REAL_CLAUDE = '1'/);
});

test('the keys are set before the node --test child is started', () => {
  const at = src.indexOf('env.NPM_CONFIG_UPDATE_NOTIFIER');
  assert.ok(at > 0 && at < src.indexOf("spawnSync(process.execPath, ['--test'"));
});

test('a test file named on the command line runs once, in the private-HOME batch only (review round 6)', () => {
  const { spawnSync } = require('child_process');
  const env = { ...process.env, MM_RUN_TESTS_PROBE: '1' };
  delete env.NODE_TEST_CONTEXT;   // the runner starts its own node --test, which skips files inside a test context
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'test/run-tests-argv-probe.test.js'],
    { cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 120000 });
  const homes = [...String(r.stdout).matchAll(/PROBE-HOME=(.*)/g)].map(m => m[1].trim());
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(homes.length, 1, 'the chosen file runs exactly once: ' + JSON.stringify(homes));
  assert.match(homes[0], /mm-tests-[^/]+\/home$/, 'with the private HOME the runner made');
  assert.notStrictEqual(homes[0], process.env.HOME);
});

test('selectors must be in the inventory and run only once after normalization', t => {
  const vm = require('node:vm');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-selection-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  function invoke(args) {
    const calls = [], errors = [];
    const stop = new Error('exit');
    let status;
    const mockProcess = {
      argv: ['node', 'run-tests.js', ...args], execPath: 'node', env: { HOME: tmp },
      exit(code) { status = code; throw stop; }
    };
    try {
      vm.runInNewContext(src, {
        __dirname: path.resolve(__dirname, '../scripts'), process: mockProcess,
        console: { error: msg => errors.push(String(msg)) },
        require(name) {
          if (name === 'child_process') return {
            spawnSync(_bin, argv, opts) { calls.push({ argv, home: opts.env.HOME }); return { status: 0 }; }
          };
          if (name === 'os') return { tmpdir: () => tmp, homedir: () => tmp };
          return require(name);
        }
      });
    } catch (err) { if (err !== stop) throw err; }
    return { calls, errors, status };
  }
  const probe = 'test/run-tests-argv-probe.test.js';
  for (const bad of ['test/integration.test.js', 'test/no-such-selector.test.js']) {
    const r = invoke([probe, bad]);
    assert.strictEqual(r.status, 1);
    assert.ok(r.errors.some(msg => msg.includes('unknown or excluded test file: ' + bad)));
    assert.strictEqual(r.calls.length, 0);
  }
  const r = invoke([probe, './' + probe, 'test/tool-policy.test.js']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.calls.length, 2);
  assert.deepStrictEqual(Array.from(r.calls[0].argv), ['--test', probe]);
  assert.notStrictEqual(r.calls[0].home, tmp);
  assert.deepStrictEqual(Array.from(r.calls[1].argv), ['--test', 'test/tool-policy.test.js']);
  assert.strictEqual(r.calls[1].home, tmp);
});
