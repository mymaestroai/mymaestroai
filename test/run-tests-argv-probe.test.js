'use strict';
// A probe for test/run-tests-sealed.test.js: when the runner is given this file by name, it says which HOME it ran with.
const test = require('node:test');
test('run-tests argv probe', () => {
  if (process.env.MM_RUN_TESTS_PROBE === '1') process.stdout.write(`\nPROBE-HOME=${process.env.HOME}\n`);
});
