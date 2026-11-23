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

test('run-tests.js leaves HOME alone (12 tool-policy tests judge paths against the real home)', () => {
  assert.doesNotMatch(src, /env\.HOME\s*=/);
  assert.match(src, /HOME is deliberately NOT changed/);
});

test('the keys are set before the node --test child is started', () => {
  const at = src.indexOf('env.NPM_CONFIG_UPDATE_NOTIFIER');
  assert.ok(at > 0 && at < src.indexOf("spawnSync(process.execPath, ['--test'"));
});
