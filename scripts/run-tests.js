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
    if (e.name.startsWith('.')) continue;   // hidden files, e.g. the ._name copies macOS leaves on other disks
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...find(rel));
    else if (e.isFile() && e.name.endsWith('.test.js') && !EXCLUDE.has(rel)) out.push(rel);
  }
  return out.sort();
}

const files = find('test');
if (!files.length) { console.error('run-tests: no test files found under test/'); process.exit(1); }
// No test reaches this computer's real Docker (its agent boxes): DOCKER_HOST points nowhere unless a run opts in.
const env = { ...process.env, DOCKER_HOST: process.env.MM_TEST_REAL_DOCKER === '1' ? (process.env.DOCKER_HOST || '') : 'unix:///nonexistent/docker-for-tests.sock' };
// No test touches this install's own data/ (in the live install: the owner's accounts, memory and transcripts). The guard is
// loaded into every Node process of the run, test files and what they start, and fails a file that reads or writes there
// (test/helpers/data-guard.js; tests use a throwaway install, test/helpers/isolated-install.js).
const GUARD = path.join(ROOT, 'test', 'helpers', 'data-guard.js');
env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : ''}--require ${JSON.stringify(GUARD)}`;
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: ROOT, stdio: 'inherit', env });
if (r.error) { console.error(`run-tests: ${r.error.message}`); process.exit(1); }
process.exit(r.status === null ? 1 : r.status);
