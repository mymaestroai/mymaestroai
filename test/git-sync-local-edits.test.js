'use strict';
// Local edits to the code are never carried across an update: nothing that moves the code (update, channel switch,
// checkout, rewrite update, the CLI) runs while tracked files have changes. The person puts them aside (git stash,
// never applied again by My Maestro) or cancels. Real temporary git repos; lib/git-sync.js is copied into each
// clone (its REPO_DIR is its own folder's parent), so git never sees the real repo, the user's config or the network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'lib', 'git-sync.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gs-local-edits-')));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
Object.assign(process.env, {
  HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: TMP,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
});
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const g = (cwd, ...args) => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const commit = (dir, rel, text, msg) => { put(dir, rel, text); g(dir, 'add', rel); g(dir, 'commit', '-q', '-m', msg); };

let n = 0;
// work = the install (tracks origin/main), other = a second clone that publishes upstream commits (on main and on dev).
function scenario() {
  const root = path.join(TMP, `s${++n}`);
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work'), other = path.join(root, 'other');
  fs.mkdirSync(work, { recursive: true });
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  g(work, 'init', '-q', '-b', 'main');
  g(work, 'config', 'user.name', 't'); g(work, 'config', 'user.email', 't@example.invalid');
  fs.mkdirSync(path.join(work, 'lib'));
  fs.copyFileSync(SRC, path.join(work, 'lib', 'git-sync.js'));
  put(work, 'package.json', JSON.stringify({ name: 'demo', version: '1.2.3' }) + '\n');   // no dependencies: no npm call
  g(work, 'add', 'lib', 'package.json');
  commit(work, 'a.txt', 'one\n', 'init');
  commit(work, 'b.txt', 'bee\n', 'second file');
  g(work, 'remote', 'add', 'origin', origin);
  g(work, 'push', '-q', '-u', 'origin', 'main');
  g(root, 'clone', '-q', origin, other);
  g(other, 'config', 'user.name', 't'); g(other, 'config', 'user.email', 't@example.invalid');
  const sync = require(path.join(work, 'lib', 'git-sync.js'));
  const publish = (rel, text, msg) => { commit(other, rel, text, msg); g(other, 'push', '-q', 'origin', 'main'); };
  const publishDev = (rel, text, msg) => {
    g(other, 'checkout', '-q', '-B', 'dev', 'origin/main');
    commit(other, rel, text, msg); g(other, 'push', '-q', 'origin', 'dev'); g(other, 'checkout', '-q', 'main');
  };
  return { root, work, other, sync, publish, publishDev };
}
const head = (s) => g(s.work, 'rev-parse', 'HEAD');
const branch = (s) => g(s.work, 'rev-parse', '--abbrev-ref', 'HEAD');
const read = (s, rel) => fs.readFileSync(path.join(s.work, rel), 'utf8');

test('runUpdate with a changed tracked file refuses with the list and the plain message; nothing moves', async () => {
  const s = scenario();
  s.publish('a.txt', 'two\n', 'upstream');
  put(s.work, 'a.txt', 'my edit\n');
  const before = head(s);
  const r = await s.sync.runUpdate();
  assert.strictEqual(r.success, false);
  assert.deepStrictEqual(r.localChanges, ['a.txt']);
  assert.match(r.error, /^Your Maestro's own files were changed on this computer, so it won't update over them: a\.txt\. Put the changes aside and update, or cancel\.$/);
  assert.strictEqual(head(s), before);
  assert.strictEqual(read(s, 'a.txt'), 'my edit\n');
});

test('the message lists up to 10 files, then "and N more"', () => {
  const s = scenario();
  const dirty = Array.from({ length: 13 }, (_, i) => ({ status: 'M', file: `f${i}.js` }));
  const msg = s.sync.changesError(dirty, 'update');
  assert.ok(msg.includes('f9.js') && !msg.includes('f10.js'));
  assert.ok(msg.includes('(and 3 more)'));
  assert.match(s.sync.changesError(dirty.slice(0, 1), 'switch channel'), /won't switch channel over them: f0\.js\. Put the changes aside and switch, or cancel\./);
});

test('localChanges: modified, staged and renamed files (the new name in file, the whole text in raw); untracked ignored', async () => {
  const s = scenario();
  put(s.work, 'a.txt', 'edit\n');
  put(s.work, 'untracked.txt', 'u\n');
  g(s.work, 'mv', 'b.txt', 'c.txt');
  const list = await s.sync.localChanges();
  assert.deepStrictEqual(list.map(x => x.file).sort(), ['a.txt', 'c.txt']);
  const ren = list.find(x => x.file === 'c.txt');
  assert.strictEqual(ren.raw, 'R  b.txt -> c.txt');
  assert.strictEqual(ren.status, 'R');
});

test('a channel switch (runUpdate with a channel) and switchChannel refuse up front with the list; the branch stays', async () => {
  const s = scenario();
  s.publishDev('d.txt', 'dev\n', 'dev work');
  put(s.work, 'a.txt', 'my edit\n');
  const before = head(s);
  const r = await s.sync.runUpdate({ channel: 'experimental' });
  assert.strictEqual(r.success, false);
  assert.deepStrictEqual(r.localChanges, ['a.txt']);
  assert.match(r.error, /won't switch channel over them: a\.txt/);
  assert.strictEqual(branch(s), 'main');
  assert.strictEqual(head(s), before);
  const w = await s.sync.switchChannel('experimental');
  assert.strictEqual(w.success, false);
  assert.deepStrictEqual(w.localChanges, ['a.txt']);
  assert.match(w.error, /Put the changes aside and switch, or cancel/);
  assert.strictEqual(branch(s), 'main');
  assert.strictEqual(read(s, 'a.txt'), 'my edit\n');
});

test('checkoutPlanned called directly with a dirty tree throws; the branch stays', async () => {
  const s = scenario();
  s.publishDev('d.txt', 'dev\n', 'dev work');
  const plan = await s.sync.planSwitch('experimental');   // planned while the tree was clean
  assert.strictEqual(plan.ok, true);
  put(s.work, 'a.txt', 'my edit\n');
  await assert.rejects(() => s.sync.checkoutPlanned('experimental', plan), (e) => {
    assert.deepStrictEqual(e.localChanges, ['a.txt']);
    assert.match(e.message, /won't switch channel over them/);
    return true;
  });
  assert.strictEqual(branch(s), 'main');
  assert.strictEqual(read(s, 'a.txt'), 'my edit\n');
});

test('runPutAsideUpdate: the edit is in git stash list, the tree is at the new commit with upstream content, nothing is re-applied', async () => {
  const s = scenario();
  s.publish('a.txt', 'two\n', 'upstream');
  put(s.work, 'a.txt', 'my edit\n');
  const r = await s.sync.runPutAsideUpdate();
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(head(s), g(s.other, 'rev-parse', 'HEAD'));
  assert.strictEqual(read(s, 'a.txt'), 'two\n');   // upstream content: the edit is NOT re-applied
  assert.strictEqual(g(s.work, 'status', '--porcelain', '--untracked-files=no'), '');
  const list = g(s.work, 'stash', 'list');
  assert.match(list, /local edits before 1\.2\.3 \([0-9a-f]{7,}\), \d{4}-\d\d-\d\d \d\d:\d\d/);
  assert.ok(/my edit/.test(g(s.work, 'stash', 'show', '-p', 'stash@{0}')));
  const rec = JSON.parse(fs.readFileSync(path.join(s.work, 'data', 'put-aside.json'), 'utf8'));
  assert.strictEqual(rec.length, 1);
  assert.deepStrictEqual(rec[0].files, ['a.txt']);
  assert.strictEqual(rec[0].ref, g(s.work, 'rev-parse', 'stash@{0}'));
  assert.match(rec[0].name, /^local edits before /);
  assert.ok(rec[0].at && 'reason' in rec[0]);
  assert.match(r.steps[0], /^Put 1 changed file aside as "local edits before .*"; they are not put back automatically\. To see them: git stash list$/);
  assert.ok(r.steps.some(x => /^Updated to 1 new commit/.test(x)));
});

test('runPutAsideUpdate with a channel switches to it; local commits are refused as before; up to date is refused without a channel', async () => {
  const s = scenario();
  assert.strictEqual((await s.sync.runPutAsideUpdate()).error, 'Already up to date.');
  s.publishDev('d.txt', 'dev\n', 'dev work');
  put(s.work, 'a.txt', 'my edit\n');
  const r = await s.sync.runPutAsideUpdate({ channel: 'experimental' });
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(branch(s), 'dev');
  assert.strictEqual(read(s, 'a.txt'), 'one\n');
  assert.match(g(s.work, 'stash', 'list'), /local edits before/);
  // local commits: refused, nothing put aside
  const t = scenario();
  commit(t.work, 'l.txt', 'l\n', 'local');
  t.publish('z.txt', 'z\n', 'more');
  put(t.work, 'a.txt', 'edit\n');
  const r2 = await t.sync.runPutAsideUpdate();
  assert.strictEqual(r2.success, false);
  assert.match(r2.error, /local commits/);
  assert.strictEqual(g(t.work, 'stash', 'list'), '');
});

test('putAsideOnly: the stash is made, HEAD is unchanged, the tree is clean', async () => {
  const s = scenario();
  put(s.work, 'a.txt', 'my edit\n');
  const before = head(s);
  const r = await s.sync.putAsideOnly();
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.files, ['a.txt']);
  assert.strictEqual(r.ref, g(s.work, 'rev-parse', 'stash@{0}'));
  assert.strictEqual(head(s), before);
  assert.strictEqual(read(s, 'a.txt'), 'one\n');
  assert.match(g(s.work, 'stash', 'list'), /local edits before/);
  assert.match(r.steps[0], /^Put 1 changed file aside as /);
});

test('getSyncStatus: localChanges, canPutAside and the old canForce', async () => {
  const s = scenario();
  s.publish('c.txt', 'c\n', 'upstream');
  put(s.work, 'a.txt', 'edit\n');
  let st = await s.sync.getSyncStatus();
  assert.deepStrictEqual(st.localChanges, ['a.txt']);
  assert.strictEqual(st.canPutAside, true);
  assert.strictEqual(st.canForce, true);
  commit(s.work, 'l.txt', 'l\n', 'local');   // a local commit: not offered
  st = await s.sync.getSyncStatus();
  assert.strictEqual(st.canPutAside, false);
  assert.strictEqual(st.canForce, false);
});

test('runRewriteUpdate: a changed file the new history keeps blocks it, with the list', async () => {
  const s = scenario();
  // GitHub's history is rewritten: the same commit under a new id (a changed message), plus a new commit.
  g(s.other, 'reset', '-q', '--hard', 'HEAD~1');
  g(s.other, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
  commit(s.other, 'x.txt', 'x\n', 'more');
  g(s.other, 'push', '-q', '-f', 'origin', 'main');
  put(s.work, 'a.txt', 'my edit\n');
  const before = head(s);
  const r = await s.sync.runRewriteUpdate();
  assert.strictEqual(r.success, false);
  assert.deepStrictEqual(r.localChanges, ['a.txt']);
  assert.match(r.error, /^Your Maestro's own files were changed on this computer/);
  assert.strictEqual(head(s), before);
  assert.strictEqual(read(s, 'a.txt'), 'my edit\n');
});

test('source: git-sync never applies a stash again and never discards with checkout -- .', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(!/stash pop/.test(src), 'no "stash pop"');
  assert.ok(!/stash apply/.test(src), 'no "stash apply"');
  assert.ok(!/'pop'/.test(src) && !/'apply'/.test(src), 'no pop/apply argument');
  assert.ok(!/checkout', '--', '\.'/.test(src), "no checkout -- . discard");
  assert.ok(/runForceUpdate: oneAtATime\(runPutAsideUpdate\)/.test(src), 'the old name is an alias');
});

test('source: the CLI --put-aside calls runPutAsideUpdate and the refusal prints the files', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'hub-cli.js'), 'utf8');
  assert.match(cli, /flag\('--put-aside'\)/);
  assert.match(cli, /gs\.runPutAsideUpdate\(\{ channel \}\)/);
  assert.match(cli, /r\.localChanges\.slice\(0, 20\)/);
  assert.match(cli, /Run `mymaestro update --put-aside` to put them aside and update\./);
  assert.match(cli.split('\n').find(l => /mymaestro update \[/.test(l)), /--put-aside/, 'the usage line');
});

test('source: the server routes and both pages', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /\/api\/git-sync\/force-update[\s\S]*?runPutAsideUpdate\(\{ channel:/);
  assert.match(server, /pathname === '\/api\/git-sync\/put-aside' && req\.method === 'POST'[\s\S]*?putAsideOnly\(\)/);
  for (const file of ['app.js', 'mobile.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/Discard Changes/i.test(src.replace(/"Discard changes\?"|'Discard changes\?'/g, '')), `${file}: no "Discard changes" button for the updater`);
    assert.ok(!/they can be discarded|Safe to discard/.test(src), `${file}: no "can be discarded" text`);
    assert.ok(src.includes('Put my changes aside'), `${file}: Put my changes aside`);
    assert.ok(src.includes("Your Maestro's own files were changed on this computer"), `${file}: the box title`);
    assert.ok(src.includes('An update would stop on them, or they may break after one.'), `${file}: the meaning`);
    assert.ok(/Your Maestro won't put them back; you can find them with git stash list\./.test(src), `${file}: the confirm`);
  }
});
