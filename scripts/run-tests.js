#!/usr/bin/env node
'use strict';
// The project's test command (npm test, and the GitHub Actions workflow): every *.test.js under test/, at any depth,
// except the files below, run with `node --test`. No shell in between: an empty selection is an error (never Node's own
// discovery), file names are passed as arguments, and the exit status is passed on.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// Left out on purpose: integration.test.js talks to a running hub on localhost:8888; agent-workers.test.js runs real agents.
const EXCLUDE = new Set(['test/integration.test.js', 'test/agent-workers.test.js']);

function find(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...find(rel));
    else if (e.isFile() && e.name.endsWith('.test.js') && !EXCLUDE.has(rel)) out.push(rel);
  }
  return out.sort();
}

const files = find('test');
if (!files.length) { console.error('run-tests: no test files found under test/'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: ROOT, stdio: 'inherit' });
if (r.error) { console.error(`run-tests: ${r.error.message}`); process.exit(1); }
process.exit(r.status === null ? 1 : r.status);
