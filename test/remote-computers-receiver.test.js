'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadModule } = require('../lib/modules/manifest');

test('the installer link answers during setup: receiver.setupPaths lists installer', () => {
  const m = loadModule(path.join(__dirname, '..', 'modules', 'remote-computers'));
  assert.deepStrictEqual(m.problems, []);
  assert.deepStrictEqual(m.manifest.receiver.paths, ['installer']);
  assert.deepStrictEqual(m.manifest.receiver.setupPaths, ['installer']);
});
