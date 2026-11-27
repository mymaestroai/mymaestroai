#!/usr/bin/env node
'use strict';
// The project's test command (npm test, and the GitHub Actions workflow): every *.test.js under test/, at any depth,
// except the files below, run with `node --test`. No shell in between: an empty selection is an error (never Node's own
// discovery), file names are passed as arguments, and the exit status is passed on.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// Leftover processes (scripts/stray-processes.js); without the module (a copy of this file alone) the check is skipped.
let strayMod = null;
try { strayMod = require(path.join(__dirname, 'stray-processes.js')); } catch { /* no check */ }
// This process's own start time (clock ticks since boot): anything a test starts begins after it.
const RUN_START = strayMod && process.platform === 'linux' ? strayMod.startTime('/proc', process.pid) : null;
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
// npm test -- [options] [test files]: options start with '-'; a test file is named relative to the project (test/x.test.js).
function splitArgs(argv) {
  const options = [], chosen = [];
  for (const a of argv) {
    if (a.startsWith('-')) { options.push(a); continue; }
    const rel = path.relative(ROOT, path.resolve(ROOT, a)).split(path.sep).join('/');
    chosen.push(rel);
  }
  return { options, chosen };
}
if (!files.length) { console.error('run-tests: no test files found under test/'); process.exit(1); }
const { options, chosen } = splitArgs(process.argv.slice(2));
const inventory = new Set(files);
for (const file of chosen) {
  if (!inventory.has(file)) {
    console.error(`run-tests: unknown or excluded test file: ${file}`);
    process.exit(1);
  }
}
const run = chosen.length ? [...new Set(chosen)] : files;
// No test reaches this computer's real Docker (its agent boxes): DOCKER_HOST points nowhere unless a run opts in.
const RUN_ID = crypto.randomBytes(8).toString('hex');
const env = { ...process.env, HUB_TEST_RUN: RUN_ID, DOCKER_HOST: process.env.MM_TEST_REAL_DOCKER === '1' ? (process.env.DOCKER_HOST || '') : 'unix:///nonexistent/docker-for-tests.sock' };
// No test reaches this computer's real Claude folder, npm folders or npm's update check: they point at fresh folders under a temp root
// made for this run. Only the policy-test batch below retains the operator’s HOME.
const sealRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tests-'));
env.MM_TEST_NO_REAL_CLAUDE = '1';
env.CLAUDE_CONFIG_DIR = path.join(sealRoot, 'claude-config');
env.npm_config_prefix = path.join(sealRoot, 'npm-global');
env.npm_config_cache = path.join(sealRoot, 'npm-cache');
env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
for (const d of [env.CLAUDE_CONFIG_DIR, env.npm_config_prefix, env.npm_config_cache]) fs.mkdirSync(d, { recursive: true });
// No test touches this install's own data/ (in the live install: the owner's accounts, memory and transcripts). The guard is
// loaded into every Node process of the run, test files and what they start, and refuses a read or write there
// (test/helpers/data-guard.js; tests use a throwaway install, test/helpers/isolated-install.js). Every refusal is also written
// to this run's report file, and any line in it fails the run, also one from a child whose exit code its test ignored.
const GUARD = path.join(ROOT, 'test', 'helpers', 'data-guard.js');
env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : ''}--require ${JSON.stringify(GUARD)}`;
const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-guard-run-'));
env.MM_DATA_GUARD_REPORT = path.join(reportDir, 'refused.jsonl');
fs.writeFileSync(env.MM_DATA_GUARD_REPORT, '', { mode: 0o600 });   // made before the run: a report that cannot be read back fails it
// Only these policy tests need the operator's home pathname.
const homePolicy = new Set(['test/lockbox-wire.test.js', 'test/tool-policy.test.js',
  'test/tool-policy-heredoc.test.js']);
const privateHome = path.join(sealRoot, 'home');
fs.mkdirSync(privateHome, { mode: 0o700 });
// Arguments: options (starting with '-', given as --name=value) go to both batches; anything else names test files,
// which replace the full list and are sorted into their batch, so a chosen file runs once, with the right HOME.
let r = { status: 0 };
for (const [selected, home] of [
  [run.filter(file => !homePolicy.has(file)), privateHome],
  [run.filter(file => homePolicy.has(file)), env.HOME || os.homedir()]
]) {
  if (!selected.length) continue;
  const result = spawnSync(process.execPath, ['--test', ...options, ...selected],
    { cwd: ROOT, stdio: 'inherit', env: { ...env, HOME: home } });
  if (result.error || result.status !== 0) r = result;
}
// Every process of this run carries HUB_TEST_RUN=<id>; one still running after the tests ended is named and stopped (scanning
// again after each pass, since a stray can start another as it stops). It never changes the exit code. Returns the number of
// marked processes still running at the end.
function stopStrays() {
  if (!strayMod || process.platform !== 'linux' || !fs.existsSync('/proc/self/stat')) return 0;
  const { found, stopped, survivors } = strayMod.stopMarked(RUN_ID);
  for (const p of found) console.error(`run-tests: a test left process ${p.pid} (${p.name}) running`);
  if (stopped > 0) console.error(`run-tests: ${stopped} stray process(es) stopped`);
  for (const p of survivors) console.error(`run-tests: process ${p.pid} (${p.name}) is still running after the stop`);
  // A leftover started with an environment of its own carries no marker: name those still in this run's cgroup (never stopped).
  for (const p of strayMod.findInCgroup(RUN_START, { exclude: found.map((s) => s.pid) })) {
    console.error(`run-tests: a process started during the tests is still running (not stopped): ${p.pid} (${p.name})`);
  }
  return survivors.length;
}
// Strays first: one still running could touch data/ (and be reported by the guard) or use the private folders until it stops.
let survivors = 0;
try { survivors = stopStrays(); } catch { /* best effort: never changes the result */ }
let refused = [];
try { refused = fs.readFileSync(env.MM_DATA_GUARD_REPORT, 'utf8').split('\n').filter(Boolean); }
catch (e) { refused = [JSON.stringify({ test: 'run-tests', path: `the guard's report could not be read (${e.code || e.message})`, how: 'report' })]; }
if (survivors > 0) {
  // something of the run still runs: keep its private folders rather than pull them from under it
  console.error(`run-tests: kept ${sealRoot} and ${reportDir} because ${survivors} process(es) of the run are still running`);
} else {
  try { fs.rmSync(reportDir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(sealRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}
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
