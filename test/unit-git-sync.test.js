'use strict';
// Behavioural tests for lib/git-sync.js. The module is copied into throw-away git repos under a temp
// dir (REPO_DIR is derived from __dirname), so git never sees the real repo, the user's git config or the network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'lib', 'git-sync.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unit-gitsync-')));
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: TMP,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
});
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const g = (cwd, ...args) => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const commit = (dir, rel, text, msg) => { put(dir, rel, text); g(dir, 'add', rel); g(dir, 'commit', '-q', '-m', msg); };

let n = 0;
// work = hub install (tracks origin/main), other = a second clone used to publish upstream commits.
function scenario() {
  const root = path.join(TMP, `s${++n}`);
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work'), other = path.join(root, 'other');
  fs.mkdirSync(work, { recursive: true });
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  g(work, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(work, 'lib'));
  fs.copyFileSync(SRC, path.join(work, 'lib', 'git-sync.js'));
  g(work, 'add', 'lib');
  commit(work, 'a.txt', 'one\n', 'init');
  g(work, 'remote', 'add', 'origin', origin);
  g(work, 'push', '-q', '-u', 'origin', 'main');
  g(root, 'clone', '-q', origin, other);
  const sync = require(path.join(work, 'lib', 'git-sync.js'));
  const publish = (rel, text, msg) => { commit(other, rel, text, msg); g(other, 'push', '-q', 'origin', 'main'); };
  return { root, origin, work, other, sync, publish };
}

test('not a git checkout -> clone-hint error', async () => {
  const dir = path.join(TMP, 'norepo'); fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.copyFileSync(SRC, path.join(dir, 'lib', 'git-sync.js'));
  const r = await require(path.join(dir, 'lib', 'git-sync.js')).getSyncStatus();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not made with `git clone`/);
});

test('no origin remote, and detached HEAD, are reported', async () => {
  const s = scenario();
  g(s.work, 'checkout', '-q', '--detach');
  const d = await s.sync.getSyncStatus();
  assert.strictEqual(d.ok, false);
  assert.match(d.error, /HEAD is detached/);
  g(s.work, 'checkout', '-q', 'main');
  g(s.work, 'remote', 'remove', 'origin');
  const r = await s.sync.getSyncStatus();
  assert.deepStrictEqual(r, { ok: false, error: 'No "origin" remote configured.' });
});

test('up to date: behind 0, ahead 0, nothing to do', async () => {
  const s = scenario();
  const r = await s.sync.getSyncStatus();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.branch, 'main');
  assert.deepStrictEqual([r.behind, r.ahead, r.upToDate, r.canUpdate, r.canForce, r.needsInstall], [0, 0, true, false, false, false]);
  assert.deepStrictEqual([r.commits, r.files, r.dirty, r.blockers], [[], [], [], []]);
});

test('behind: commits newest-first, changed files, canUpdate, needsInstall only for package files', async () => {
  const s = scenario();
  s.publish('a.txt', 'two\n', 'second');
  s.publish('b.txt', 'b\n', 'third');
  let r = await s.sync.getSyncStatus();
  assert.strictEqual(r.behind, 2);
  assert.strictEqual(r.ahead, 0);
  assert.strictEqual(r.commits.length, 2);
  assert.match(r.commits[0], /^[0-9a-f]+ third$/);
  assert.match(r.commits[1], /^[0-9a-f]+ second$/);
  assert.deepStrictEqual(r.files.sort(), ['a.txt', 'b.txt']);
  assert.strictEqual(r.canUpdate, true);
  assert.strictEqual(r.needsInstall, false);
  s.publish('package-lock.json', '{}\n', 'deps');
  r = await s.sync.getSyncStatus();
  assert.strictEqual(r.needsInstall, true);
});

test('ahead / diverged: local commit blocks update and force', async () => {
  const s = scenario();
  commit(s.work, 'local.txt', 'x\n', 'local');
  let r = await s.sync.getSyncStatus();
  assert.deepStrictEqual([r.ahead, r.behind, r.upToDate], [1, 0, true]);
  s.publish('a.txt', 'two\n', 'upstream');
  r = await s.sync.getSyncStatus();
  assert.deepStrictEqual([r.ahead, r.behind], [1, 1]);
  assert.strictEqual(r.canUpdate, false);
  assert.strictEqual(r.canForce, false);
  assert.match(r.blockers[0], /^1 local commit not pushed/);
});

test('dirty parsing: leading-space status column kept, untracked ignored, staged is its own status', async () => {
  const s = scenario();
  s.publish('c.txt', 'c\n', 'upstream');
  put(s.work, 'a.txt', 'edited\n');              // " M a.txt"
  put(s.work, 'untracked.txt', 'u\n');           // ignored (--untracked-files=no)
  put(s.work, 'new.txt', 'n\n'); g(s.work, 'add', 'new.txt');   // "A  new.txt"
  const r = await s.sync.getSyncStatus();
  assert.deepStrictEqual(r.dirty.sort((a, b) => a.file.localeCompare(b.file)), [{ status: 'M', file: 'a.txt' }, { status: 'A', file: 'new.txt' }]);
  assert.strictEqual(r.blockers[0], '2 uncommitted changes to tracked files');
  assert.strictEqual(r.canUpdate, false);
  assert.strictEqual(r.canForce, true);
});

test('runUpdate: up to date and dirty tree are refused without touching the tree', async () => {
  const s = scenario();
  assert.deepStrictEqual(await s.sync.runUpdate(), { success: false, error: 'Already up to date.' });
  s.publish('a.txt', 'two\n', 'upstream');
  put(s.work, 'a.txt', 'mine\n');
  const r = await s.sync.runUpdate();
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'Cannot update: 1 uncommitted change to tracked files.');
  assert.strictEqual(r.status.canForce, true);
  assert.strictEqual(fs.readFileSync(path.join(s.work, 'a.txt'), 'utf8'), 'mine\n');
});

test('runUpdate fast-forwards, reports HEAD, clears the model cache only when present', async () => {
  const s = scenario();
  s.publish('a.txt', 'two\n', 'second');
  s.publish('b.txt', 'b\n', 'third');
  const cache = path.join(s.work, 'data', 'discovered-models.json');
  put(s.work, 'data/discovered-models.json', '{}');
  const r = await s.sync.runUpdate();
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.installed, false);
  assert.strictEqual(r.head, g(s.work, 'rev-parse', '--short', 'HEAD'));
  assert.strictEqual(g(s.work, 'rev-parse', 'HEAD'), g(s.other, 'rev-parse', 'HEAD'));
  assert.strictEqual(r.steps[0], 'Updated to 2 new commits');
  // The model list is KEPT and marked stale (deleting it left pages with a short probed list until discovery finished).
  assert.match(r.steps[1], /^Model list marked stale/);
  assert.strictEqual(fs.existsSync(cache), true);
  const marked = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.strictEqual(marked.stale, true);
  assert.match(marked.staleReason, /^updated to /);
  assert.ok(!isNaN(Date.parse(marked.staleSince)));
  assert.strictEqual(r.commits.length, 2);
  fs.unlinkSync(cache);   // absent cache: nothing to mark
  s.publish('d.txt', 'd\n', 'fourth');
  const r2 = await s.sync.runUpdate();
  assert.deepStrictEqual(r2.steps, ['Updated to 1 new commit']);   // no cache file -> no second step
});

test('runForceUpdate discards tracked edits then updates; refuses when ahead', async () => {
  const s = scenario();
  assert.strictEqual((await s.sync.runForceUpdate()).error, 'Already up to date.');
  s.publish('a.txt', 'two\n', 'upstream');
  put(s.work, 'a.txt', 'mine\n');
  const r = await s.sync.runForceUpdate();
  assert.strictEqual(r.success, true);
  assert.strictEqual(fs.readFileSync(path.join(s.work, 'a.txt'), 'utf8'), 'two\n');
  commit(s.work, 'l.txt', 'l\n', 'local');
  s.publish('z.txt', 'z\n', 'more');
  const r2 = await s.sync.runForceUpdate();
  assert.strictEqual(r2.success, false);
  assert.match(r2.error, /You have local commits/);
});

test('diverged histories: runUpdate refuses on the ahead blocker before attempting a merge', async () => {
  const s = scenario();
  commit(s.work, 'l.txt', 'l\n', 'local');
  s.publish('z.txt', 'z\n', 'up');
  const before = g(s.work, 'rev-parse', 'HEAD');
  const r = await s.sync.runUpdate();
  assert.strictEqual(r.error, 'Cannot update: 1 local commit not pushed — update would not fast-forward.');
  assert.strictEqual(g(s.work, 'rev-parse', 'HEAD'), before);
});

test('a local branch that is missing on origin reports "origin/<branch> does not exist on the remote."', async () => {
  const s = scenario();
  g(s.work, 'checkout', '-q', '-b', 'feature');
  assert.deepStrictEqual(await s.sync.getSyncStatus(), { ok: false, error: 'origin/feature does not exist on the remote.' });
  const u = await s.sync.runUpdate();
  assert.deepStrictEqual(u, { success: false, error: 'origin/feature does not exist on the remote.' });
});

test('"does not exist on the remote" is also reported when fetch succeeds without updating the tracking ref', async () => {
  const s = scenario();
  g(s.other, 'checkout', '-q', '-b', 'feature');
  g(s.other, 'push', '-q', 'origin', 'feature');
  g(s.work, 'checkout', '-q', '-b', 'feature');
  g(s.work, 'config', '--unset-all', 'remote.origin.fetch');   // fetch writes FETCH_HEAD only, no origin/feature
  const r = await s.sync.getSyncStatus();
  assert.deepStrictEqual(r, { ok: false, error: 'origin/feature does not exist on the remote.' });
});

test('unreachable origin -> "Fetch failed" (not the credentials message)', async () => {
  const s = scenario();
  g(s.work, 'remote', 'set-url', 'origin', path.join(s.root, 'nowhere.git'));
  const r = await s.sync.getSyncStatus();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /^Fetch failed: /);
});

// ── GitHub history rewritten (e.g. personal details scrubbed with git-filter-repo) ──
// A rewrite keeps author/committer timestamps; that is how the local copies are recognised.
function commitAt(dir, files, msg, t) {
  for (const [rel, text] of Object.entries(files)) { if (text === null) g(dir, 'rm', '-q', rel); else { put(dir, rel, text); g(dir, 'add', rel); } }
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_DATE: `${t} +0000` } });
}
function rewrittenScenario() {
  const s = scenario();
  const base = g(s.work, 'rev-parse', 'HEAD');
  // old history (what the install has): two commits, one tracking a per-install roster file
  commitAt(s.work, { 'b.txt': 'name: Alice\n', 'roster.json': '{"groups":["family"]}\n' }, 'add b by Alice', 1700000000);
  commitAt(s.work, { 'c.txt': 'more\n' }, 'add c', 1700000100);
  g(s.work, 'push', '-q', 'origin', 'main');
  put(s.work, 'data/keep.json', '{"mine":true}\n');   // user data, untracked
  // rewritten history published from the other clone: same timestamps, scrubbed content, roster untracked + ignored
  g(s.other, 'fetch', '-q', 'origin'); g(s.other, 'reset', '-q', '--hard', base);
  commitAt(s.other, { 'b.txt': 'name: someone\n', '.gitignore': 'roster.json\ndata/\n' }, 'add b', 1700000000);
  commitAt(s.other, { 'c.txt': 'more\n' }, 'add c', 1700000100);
  commitAt(s.other, { 'd.txt': 'new\n' }, 'new upstream work', 1700000200);
  g(s.other, 'push', '-q', '-f', 'origin', 'main');
  return s;
}

test('rewritten GitHub history: recognised, not blocked, offered as its own action', async () => {
  const s = rewrittenScenario();
  const st = await s.sync.getSyncStatus();
  assert.strictEqual(st.ahead, 2); assert.strictEqual(st.behind, 3);
  assert.strictEqual(st.rewritten, true);
  assert.strictEqual(st.canRewriteUpdate, true);
  assert.deepStrictEqual(st.blockers, []);
  assert.deepStrictEqual(st.localOnly, []);
  assert.strictEqual(st.canUpdate, false, 'the plain fast-forward update is not offered');
  const ff = await s.sync.runUpdate();
  assert.strictEqual(ff.success, false);
});

test('runRewriteUpdate: moves to GitHub, keeps a backup branch, keeps ignored per-install files and data/', async () => {
  const s = rewrittenScenario();
  const oldHead = g(s.work, 'rev-parse', 'HEAD');
  const r = await s.sync.runRewriteUpdate();
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(g(s.work, 'rev-parse', 'HEAD'), g(s.work, 'rev-parse', 'origin/main'));
  const backup = g(s.work, 'branch', '--list', 'backup/before-rewrite-*').replace(/^[* ]+/, '');
  assert.ok(backup, 'backup branch exists');
  assert.strictEqual(g(s.work, 'rev-parse', backup), oldHead);
  assert.strictEqual(fs.readFileSync(path.join(s.work, 'roster.json'), 'utf8'), '{"groups":["family"]}\n', 'ignored per-install file kept');
  assert.strictEqual(fs.readFileSync(path.join(s.work, 'data', 'keep.json'), 'utf8'), '{"mine":true}\n');
  assert.strictEqual(fs.readFileSync(path.join(s.work, 'b.txt'), 'utf8'), 'name: someone\n');
  assert.ok(r.steps.some(x => /backup\/before-rewrite-/.test(x)));
  assert.ok(fs.readdirSync(path.join(s.work, 'data', 'backups')).some(d => d.startsWith('update-')));
  assert.strictEqual((await s.sync.getSyncStatus()).upToDate, true);
});

test('a local commit with no copy upstream next to rewritten ones: listed, needs confirmation, kept on the backup branch', async () => {
  const s = rewrittenScenario();
  commitAt(s.work, { 'mine.txt': 'my change\n' }, 'my own local fix', 1700000999);
  const st = await s.sync.getSyncStatus();
  assert.strictEqual(st.rewritten, true);
  assert.strictEqual(st.canRewriteUpdate, true);
  assert.strictEqual(st.localOnlyCount, 1);
  assert.match(st.localOnly[0], /my own local fix$/);
  let r = await s.sync.runRewriteUpdate();
  assert.strictEqual(r.success, false);
  assert.match(r.error, /1 local commit\(s\) are not on GitHub in any form \(\S+ my own local fix\)/);
  assert.strictEqual(fs.readFileSync(path.join(s.work, 'mine.txt'), 'utf8'), 'my change\n', 'nothing touched');
  r = await s.sync.runRewriteUpdate({ confirmLocalOnly: 2 });
  assert.strictEqual(r.success, false, 'the confirmation must name the count that was shown');
  const oldHead = g(s.work, 'rev-parse', 'HEAD');
  r = await s.sync.runRewriteUpdate({ confirmLocalOnly: 1 });
  assert.strictEqual(r.success, true, r.error);
  const backup = g(s.work, 'branch', '--list', 'backup/before-rewrite-*').replace(/^[* ]+/, '');
  assert.strictEqual(g(s.work, 'rev-parse', backup), oldHead);
  assert.match(g(s.work, 'log', '-1', '--format=%s', backup), /my own local fix/);
});

test('ordinary local work (no rewrite) stays blocked and is listed', async () => {
  const s = scenario();
  commit(s.work, 'l.txt', 'l\n', 'my local work');
  s.publish('z.txt', 'z\n', 'upstream work');
  const st = await s.sync.getSyncStatus();
  assert.strictEqual(st.rewritten, false);
  assert.strictEqual(st.canRewriteUpdate, false);
  assert.match(st.localOnly[0], /my local work$/);
  const r = await s.sync.runRewriteUpdate({ confirmLocalOnly: 1 });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /local commit not pushed/);
});

test('rewritten history with a modified tracked file: recognised but the file must be dealt with first', async () => {
  const s = rewrittenScenario();
  put(s.work, 'c.txt', 'edited\n');
  const st = await s.sync.getSyncStatus();
  assert.strictEqual(st.rewritten, true);
  assert.strictEqual(st.canRewriteUpdate, false);
  const r = await s.sync.runRewriteUpdate();
  assert.strictEqual(r.success, false);
  assert.strictEqual(fs.readFileSync(path.join(s.work, 'c.txt'), 'utf8'), 'edited\n');
});

test('rewrite: a modified per-install file the new history drops does not block, and its edited content is kept', async () => {
  const s = rewrittenScenario();
  put(s.work, 'roster.json', '{"groups":["edited at runtime"]}\n');
  const st = await s.sync.getSyncStatus();
  assert.deepStrictEqual(st.dirty.map(d => d.file), ['roster.json']);
  assert.deepStrictEqual(st.blockers, []);
  assert.strictEqual(st.canRewriteUpdate, true);
  const r = await s.sync.runRewriteUpdate();
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(fs.readFileSync(path.join(s.work, 'roster.json'), 'utf8'), '{"groups":["edited at runtime"]}\n');
  assert.strictEqual(g(s.work, 'status', '--porcelain'), '', 'kept file is ignored, tree clean');
});

test('channels: stable (main) and experimental (dev) are listed with what each adds or leaves; switching checks out and fast-forwards; a dirty tree or an unknown channel is refused', async () => {
  const s = scenario();
  // GitHub gets a dev branch with one commit beyond main
  g(s.other, 'checkout', '-q', '-b', 'dev');
  commit(s.other, 'c.txt', 'c\n', 'dev work');
  g(s.other, 'push', '-q', '-u', 'origin', 'dev');
  let ch = await s.sync.getChannels();
  assert.strictEqual(ch.current, 'stable');
  assert.strictEqual(ch.branch, 'main');
  const stable = ch.channels.find(c => c.id === 'stable'), exp = ch.channels.find(c => c.id === 'experimental');
  assert.deepStrictEqual([stable.branch, stable.available, stable.current, stable.adds, stable.drops], ['main', true, true, 0, 0]);
  assert.deepStrictEqual([exp.branch, exp.available, exp.current, exp.adds, exp.drops], ['dev', true, false, 1, 0]);
  const st = await s.sync.getSyncStatus();
  assert.strictEqual(st.channel, 'stable');
  assert.strictEqual(st.channels.channels.length, 2);
  // switch to experimental: branch dev checked out, its commit present
  const r = await s.sync.runUpdate({ channel: 'experimental' });
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.match(r.steps[0], /^Switched from main to the experimental channel \(dev\)/);
  assert.strictEqual(g(s.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'dev');
  assert.ok(fs.existsSync(path.join(s.work, 'c.txt')));
  assert.strictEqual((await s.sync.getChannels()).current, 'experimental');
  // the same channel again is just an ordinary update attempt
  const same = await s.sync.runUpdate({ channel: 'experimental' });
  assert.strictEqual(same.success, false);
  assert.strictEqual(same.error, 'Already up to date.');
  // back to stable: main is checked out (its own commits intact), c.txt gone from the tree
  const back = await s.sync.runUpdate({ channel: 'stable' });
  assert.strictEqual(back.success, true, JSON.stringify(back));
  assert.strictEqual(g(s.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.ok(!fs.existsSync(path.join(s.work, 'c.txt')));
  assert.strictEqual(g(s.work, 'rev-parse', 'dev'), g(s.work, 'rev-parse', 'origin/dev'), 'the branch left behind keeps its commits');
  // refusals
  put(s.work, 'a.txt', 'edited\n');
  const dirty = await s.sync.runUpdate({ channel: 'experimental' });
  assert.strictEqual(dirty.success, false);
  assert.match(dirty.error, /Cannot switch channel: 1 uncommitted change/);
  assert.strictEqual(g(s.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  g(s.work, 'checkout', '-q', '--', 'a.txt');
  const bad = await s.sync.runUpdate({ channel: 'nightly' });
  assert.match(bad.error, /Unknown channel "nightly"/);
  // a channel whose branch is not on GitHub is reported as unavailable, not fatal
  g(s.other, 'push', '-q', 'origin', '--delete', 'dev');
  g(s.work, 'fetch', '-q', '--prune', 'origin');
  ch = await s.sync.getChannels();
  assert.strictEqual(ch.channels.find(c => c.id === 'experimental').available, false);
  const gone = await s.sync.runUpdate({ channel: 'experimental' });
  assert.match(gone.error, /not on GitHub/);
});

// ── Packages: an update that changes them installs them in a side folder (a stand-in npm, no network) ──
const FAKE_NPM = path.join(TMP, 'fake-npm.js');
fs.writeFileSync(FAKE_NPM, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const [cmd, ...rest] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ cmd, rest, cwd: process.cwd(), env: Object.keys(process.env), path0: (process.env.PATH || '').split(path.delimiter)[0] }) + '\\n');
const mode = process.env.FAKE_NPM_MODE || 'ok';
if (cmd === 'ci') {
  if (mode === 'fail') { process.stderr.write('npm error code E404\\nnpm error 404 Not Found - GET https://registry.example.invalid/nope\\n'); process.exit(1); }
  for (const d of Object.keys(JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies || {})) {
    if (mode === 'skip' && d === 'left-pad') continue;
    fs.mkdirSync(path.join('node_modules', d), { recursive: true });
    fs.writeFileSync(path.join('node_modules', d, 'package.json'), JSON.stringify({ name: d, version: '1.0.0' }));
    if (d === 'better-sqlite3') fs.writeFileSync(path.join('node_modules', d, 'index.js'), "module.exports = class { constructor() { if (!require('fs').existsSync(__dirname + '/built')) throw new Error('not built'); } close() {} };");
  }
  fs.writeFileSync(path.join('node_modules', '.marker'), 'new');
}
if (cmd === 'rebuild') fs.writeFileSync(path.join('node_modules', rest[0], 'built'), '1');
`, { mode: 0o755 });
const PKG = JSON.stringify({ name: 'hub', version: '1.0.0', dependencies: { 'better-sqlite3': '^1.0.0', 'left-pad': '^1.0.0' } }) + '\n';
async function withNpm(vars, fn) {
  const saved = Object.keys(vars).map(k => [k, process.env[k]]);
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const npmCalls = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const npmVars = (s, mode, extra = {}) => ({ HUB_NPM: FAKE_NPM, FAKE_NPM_LOG: path.join(s.root, 'npm.log'), FAKE_NPM_MODE: mode, ...extra });

test('packages changed: npm ci --omit=dev --ignore-scripts in a side folder, native module rebuilt and loaded, then swapped in; no keys reach npm; nothing tracked rewritten', async () => {
  const s = scenario();
  put(s.work, 'node_modules/.marker', 'old');
  s.publish('package.json', PKG, 'deps');
  s.publish('package-lock.json', '{}\n', 'lock');
  const r = await withNpm(npmVars(s, 'ok', { ANTHROPIC_API_KEY: 'test-not-real', GH_TOKEN: 'test-not-real' }), () => s.sync.runUpdate());
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(r.installed, true);
  assert.ok(r.steps.includes('Installed the updated packages'), r.steps.join(' | '));
  assert.strictEqual(fs.readFileSync(path.join(s.work, 'node_modules', '.marker'), 'utf8'), 'new', 'the new packages replaced the old');
  assert.ok(fs.existsSync(path.join(s.work, 'node_modules', 'better-sqlite3', 'built')));
  assert.ok(!fs.existsSync(path.join(s.work, '.update-staging')), 'the side folder is gone');
  assert.strictEqual(g(s.work, 'status', '--porcelain', '--untracked-files=no'), '', 'nothing tracked was rewritten');
  const calls = npmCalls(path.join(s.root, 'npm.log'));
  assert.deepStrictEqual(calls.map(c => c.cmd), ['ci', 'rebuild']);
  assert.deepStrictEqual(calls[0].rest.slice(0, 2), ['--omit=dev', '--ignore-scripts']);
  assert.strictEqual(calls[0].cwd, path.join(s.work, '.update-staging'));
  assert.strictEqual(calls[1].rest[0], 'better-sqlite3');
  for (const c of calls) {
    assert.ok(!c.env.includes('ANTHROPIC_API_KEY') && !c.env.includes('GH_TOKEN'), 'keys and tokens are not passed to npm');
    assert.strictEqual(c.path0, path.dirname(process.execPath), "the hub's own Node is first on npm's PATH");
  }
});

test('a failed or incomplete install puts the code back, leaves the working packages alone and reports failure, so nothing restarts', async () => {
  const s = scenario();
  put(s.work, 'node_modules/.marker', 'old');
  const before = g(s.work, 'rev-parse', 'HEAD');
  s.publish('package.json', PKG, 'deps');
  s.publish('package-lock.json', '{}\n', 'lock');
  let r = await withNpm(npmVars(s, 'fail'), () => s.sync.runUpdate());
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.rolledBack, true);
  assert.match(r.error, /^Update stopped: the updated packages could not be installed \(E404: 404 Not Found - GET https:\/\/registry\.example\.invalid\/nope\)\. Nothing changed/);
  assert.match(r.error, new RegExp(`the hub stays on ${before.slice(0, 7)}`));
  assert.strictEqual(g(s.work, 'rev-parse', 'HEAD'), before, 'the code is back where it was');
  assert.ok(!fs.existsSync(path.join(s.work, 'package.json')));
  assert.strictEqual(fs.readFileSync(path.join(s.work, 'node_modules', '.marker'), 'utf8'), 'old', 'the working packages are untouched');
  assert.ok(!fs.existsSync(path.join(s.work, '.update-staging')));
  r = await withNpm(npmVars(s, 'skip'), () => s.sync.runUpdate());
  assert.strictEqual(r.success, false);
  assert.match(r.error, /missing after the install: left-pad/);
  assert.strictEqual(g(s.work, 'rev-parse', 'HEAD'), before);
  r = await withNpm(npmVars(s, 'ok'), () => s.sync.runUpdate());
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(g(s.work, 'rev-parse', 'HEAD'), g(s.other, 'rev-parse', 'HEAD'));
});

test('a channel switch that changes the packages installs them; when that fails the install stays on its channel', async () => {
  const s = scenario();
  g(s.other, 'checkout', '-q', '-b', 'dev');
  commit(s.other, 'package.json', PKG, 'dev deps');
  commit(s.other, 'package-lock.json', '{}\n', 'dev lock');
  g(s.other, 'push', '-q', '-u', 'origin', 'dev');
  let r = await withNpm(npmVars(s, 'fail'), () => s.sync.runUpdate({ channel: 'experimental' }));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.rolledBack, true, r.error);
  assert.strictEqual(g(s.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'back on the channel it was on');
  r = await withNpm(npmVars(s, 'ok'), () => s.sync.runUpdate({ channel: 'experimental' }));
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(r.installed, true);
  assert.strictEqual(g(s.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'dev');
});

test('one update at a time: a second request while one runs is refused', async () => {
  const s = scenario();
  s.publish('a.txt', 'two\n', 'upstream');
  const [a, b] = await Promise.all([s.sync.runUpdate(), s.sync.runUpdate()]);
  assert.strictEqual(a.success, true, a.error);
  assert.deepStrictEqual(b, { success: false, error: 'An update is already running. Wait for it to finish.' });
  assert.strictEqual((await s.sync.runUpdate()).error, 'Already up to date.', 'the lock is released afterwards');
});

test('rewritten history + failed install: back on the old history, with the per-install file as it was', async () => {
  const s = rewrittenScenario();
  commitAt(s.other, { 'package.json': PKG, 'package-lock.json': '{}\n' }, 'deps', 1700000300);
  g(s.other, 'push', '-q', 'origin', 'main');
  put(s.work, 'roster.json', '{"groups":["edited at runtime"]}\n');
  const oldHead = g(s.work, 'rev-parse', 'HEAD');
  const r = await withNpm(npmVars(s, 'fail'), () => s.sync.runRewriteUpdate());
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.rolledBack, true, r.error);
  assert.strictEqual(g(s.work, 'rev-parse', 'HEAD'), oldHead);
  assert.strictEqual(fs.readFileSync(path.join(s.work, 'roster.json'), 'utf8'), '{"groups":["edited at runtime"]}\n');
  assert.strictEqual(fs.readFileSync(path.join(s.work, 'b.txt'), 'utf8'), 'name: Alice\n');
});
