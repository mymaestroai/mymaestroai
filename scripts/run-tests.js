#!/usr/bin/env node
'use strict';
// The project's test command (npm test, and the GitHub Actions workflow): every *.test.js under test/, at any depth,
// except the files below, run with `node --test`. No shell in between: an empty selection is an error (never Node's own
// discovery), file names are passed as arguments, and the exit status is passed on.
const fs = require('fs');
const os = require('os');
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
// loaded into every Node process of the run, test files and what they start, and refuses a read or write there
// (test/helpers/data-guard.js; tests use a throwaway install, test/helpers/isolated-install.js). Every refusal is also written
// to this run's report file, and any line in it fails the run, also one from a child whose exit code its test ignored.
const GUARD = path.join(ROOT, 'test', 'helpers', 'data-guard.js');
env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : ''}--require ${JSON.stringify(GUARD)}`;
const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-guard-run-'));
env.MM_DATA_GUARD_REPORT = path.join(reportDir, 'refused.jsonl');
fs.writeFileSync(env.MM_DATA_GUARD_REPORT, '', { mode: 0o600 });   // made before the run: a report that cannot be read back fails it
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: ROOT, stdio: 'inherit', env });
let refused = [];
try { refused = fs.readFileSync(env.MM_DATA_GUARD_REPORT, 'utf8').split('\n').filter(Boolean); }
catch (e) { refused = [JSON.stringify({ test: 'run-tests', path: `the guard's report could not be read (${e.code || e.message})`, how: 'report' })]; }
try { fs.rmSync(reportDir, { recursive: true, force: true }); } catch { /* best effort */ }
if (refused.length) {
  const seen = new Set();
  console.error(`\nrun-tests: FAILED, tests touched the install's own data/ (${refused.length} refused):`);
  for (const line of refused) {
    let e; try { e = JSON.parse(line); } catch { e = { test: '?', path: line, how: '?' }; }
    const k = `${e.test} ${e.path}`;
    if (!seen.has(k)) { seen.add(k); console.error(`  ${e.test}: ${e.path} (${e.how})`); }
  }
}
if (r.error) { console.error(`run-tests: ${r.error.message}`); process.exit(1); }
process.exit(refused.length ? 1 : r.status === null ? 1 : r.status);
