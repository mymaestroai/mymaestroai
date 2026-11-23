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
  assert.match(src, /\[files\.filter\(file => !homePolicy\.has\(file\)\), privateHome\]/, 'the main batch gets the private HOME');
  assert.match(src, /\[files\.filter\(file => homePolicy\.has\(file\)\), env\.HOME \|\| os\.homedir\(\)\]/, 'the policy batch gets the real HOME');
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
