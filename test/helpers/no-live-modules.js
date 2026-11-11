'use strict';
// Tripwire for backup tests: lib/modules/index.js and lib/connectors.js are replaced by stubs whose every function
// records the call and throws, so a test that forgets a `modulePlaces` stand-in fails instead of building the real
// modules singleton (which reads the real install's data and starts live connectors). Call installTripwire() before
// anything under lib/backup is required. Not a *.test.js file, so the test runner does not run it as a test.
const path = require('path');

const MESSAGE = 'a backup test reached the real modules/connectors: pass a modulePlaces stand-in';
const calls = [];

function stub(label) {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === '__esModule') return undefined;
      return () => { calls.push(`${label}.${String(prop)}`); throw new Error(MESSAGE); };
    },
  });
}

function installTripwire() {
  const lib = path.join(__dirname, '..', '..', 'lib');
  for (const [rel, label] of [['modules', 'modules'], ['connectors', 'connectors']]) {
    const file = require.resolve(path.join(lib, rel));
    require.cache[file] = { id: file, filename: file, loaded: true, children: [], paths: [], exports: stub(label) };
  }
}

const tripped = () => calls.slice();

module.exports = { installTripwire, tripped, MESSAGE };
