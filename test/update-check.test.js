'use strict';
// The daily update check: git-sync's peekUpdate against throw-away repos (the module is copied into each, as in
// unit-git-sync.test.js, so git never sees the real repo or the network), and lib/update-check's state machine with
// a fake clock, a fake peek and a fake notifier.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'lib', 'git-sync.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'update-check-')));
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: TMP,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
});
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const g = (cwd, ...args) => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

const CHANGELOG_1 = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- **First feature.** It works.\n  - **A detail line.** Not an entry.\n';
const pkg = (v) => JSON.stringify({ name: 'x', version: v }, null, 2) + '\n';

let n = 0;
function scenario() {
  const root = path.join(TMP, `s${++n}`);
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work'), other = path.join(root, 'other');
  fs.mkdirSync(work, { recursive: true });
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  g(work, 'init', '-q', '-b', 'main');
  put(work, 'lib/git-sync.js', fs.readFileSync(SRC, 'utf8'));
  put(work, 'package.json', pkg('1.0.0'));
  put(work, 'CHANGELOG.md', CHANGELOG_1);
  g(work, 'add', '.'); g(work, 'commit', '-q', '-m', 'release 1.0.0');
  g(work, 'remote', 'add', 'origin', origin);
  g(work, 'push', '-q', '-u', 'origin', 'main');
  g(root, 'clone', '-q', origin, other);
  const sync = require(path.join(work, 'lib', 'git-sync.js'));
  const publish = (files, msg) => { for (const [rel, text] of Object.entries(files)) put(other, rel, text); g(other, 'add', '.'); g(other, 'commit', '-q', '-m', msg); g(other, 'push', '-q', 'origin', 'main'); };
  return { root, work, other, sync, publish };
}

test('peekUpdate: up to date reports nothing new', async () => {
  const s = scenario();
  const r = await s.sync.peekUpdate();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.behind, 0);
  assert.strictEqual(r.ahead, 0);
  assert.strictEqual(r.currentVersion, '1.0.0');
  assert.deepStrictEqual(r.titles, []);
  assert.strictEqual(r.channel, 'stable');
});

test('peekUpdate: a release shows its version and only the new changelog entries, and moves nothing', async () => {
  const s = scenario();
  const originBefore = g(s.work, 'rev-parse', 'origin/main');
  s.publish({
    'package.json': pkg('1.1.0'),
    'CHANGELOG.md': CHANGELOG_1.replace('## [1.0.0]', '## [1.1.0] - 2026-02-01\n\n- **Security: safer sign-in.** Fixed.\n- **Second feature.** New.\n\n## [1.0.0]'),
  }, 'release 1.1.0');
  const r = await s.sync.peekUpdate();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.behind, 1);
  assert.strictEqual(r.latestVersion, '1.1.0');
  assert.strictEqual(r.currentVersion, '1.0.0');
  assert.deepStrictEqual(r.titles, ['Security: safer sign-in', 'Second feature']);
  assert.strictEqual(r.security, true);
  assert.strictEqual(r.remote, g(s.other, 'rev-parse', 'HEAD'));
  // Read-only: the code, origin/main (what the Update dialog compares with) and FETCH_HEAD stay as they were.
  assert.strictEqual(g(s.work, 'rev-parse', 'HEAD'), r.head);
  assert.strictEqual(g(s.work, 'rev-parse', 'origin/main'), originBefore);
  assert.strictEqual(fs.existsSync(path.join(s.work, '.git', 'FETCH_HEAD')), false);
  assert.strictEqual(g(s.work, 'status', '--porcelain'), '');
});

test('peekUpdate: commits without changelog entries list their subjects; local commits count as ahead', async () => {
  const s = scenario();
  s.publish({ 'a.txt': 'one\n' }, 'Fix the thing');
  put(s.work, 'b.txt', 'local\n'); g(s.work, 'add', 'b.txt'); g(s.work, 'commit', '-q', '-m', 'local work');
  const r = await s.sync.peekUpdate();
  assert.strictEqual(r.behind, 1);
  assert.strictEqual(r.ahead, 1);
  assert.strictEqual(r.latestVersion, '1.0.0');
  assert.deepStrictEqual(r.titles, ['Fix the thing']);
  assert.strictEqual(r.security, false);
  assert.strictEqual(r.dirty, 0);
  put(s.work, 'b.txt', 'changed here\n');   // b.txt is tracked here (a.txt exists only upstream)
  assert.strictEqual((await s.sync.peekUpdate()).dirty, 1, 'uncommitted changes to tracked files are counted');
});

test('changelogTitles: top-level bold leads only, final stop dropped, no duplicates', () => {
  const { changelogTitles } = require(SRC);
  assert.deepStrictEqual(changelogTitles('- **One.** a\n  - **Nested.** b\n- **Two:** c\n- **One.** again\ntext **Not.**'), ['One', 'Two']);
});

// ── lib/update-check ────────────────────────────────────────────────────────
const { createUpdateCheck, headline, LATER_MS } = require('../lib/update-check');

function harness(over = {}) {
  let clock = Date.parse('2026-10-21T12:00:00Z');
  const dir = fs.mkdtempSync(path.join(TMP, 'uc-'));
  const calls = { peek: 0, notify: [] };
  const h = {
    result: { ok: true, branch: 'main', channel: 'stable', head: 'h1', remote: 'r1', behind: 2, ahead: 0, dirty: 0, currentVersion: '1.0.0', latestVersion: '1.1.0', titles: ['A', 'B', 'C'], more: 1, security: false },
    headValue: 'h1', devices: { d1: true }, settings: {}, running: false,
  };
  const uc = createUpdateCheck({
    stateFile: path.join(dir, 'update-check.json'),
    peek: async () => { calls.peek++; return typeof h.result === 'function' ? h.result() : h.result; },
    headNow: async () => h.headValue,
    updateRunning: () => h.running,
    // Admin devices: id -> whether delivery succeeds. skip(id) leaves out the ones that already have it.
    notifyEach: async (payload, opts) => {
      const ids = Object.keys(h.devices).filter(id => !opts.skip(id));
      if (ids.length) calls.notify.push({ payload, opts, ids });
      return { results: ids.map(id => ({ id, ok: h.devices[id] })) };
    },
    settings: () => h.settings,
    env: {}, now: () => clock, log: () => {},
    ...over,
  });
  return { uc, h, calls, dir, tick: (ms) => { clock += ms; } };
}
const admin = { id: 'u-admin', role: 'admin' };
const admin2 = { id: 'u-admin2', role: 'admin' };

test('one push per new version, to admins, opening the phone prompt', async () => {
  const { uc, h, calls } = harness();
  await uc.check();
  assert.strictEqual(calls.notify.length, 1);
  assert.strictEqual(calls.notify[0].payload.title, 'My Maestro AI 1.1.0 is ready');
  assert.strictEqual(calls.notify[0].payload.url, '/mobile?update=1');
  assert.match(calls.notify[0].payload.body, /^A · B · and more\. Tap to update now or later\.$/);
  assert.strictEqual(calls.notify[0].opts.adminsOnly, true);
  assert.strictEqual(calls.notify[0].opts.urgency, 'normal');
  await uc.check();
  assert.strictEqual(calls.notify.length, 1, 'the same version is announced once');
  h.result = { ...h.result, remote: 'r2', latestVersion: '1.2.0', security: true };
  await uc.check();
  assert.strictEqual(calls.notify.length, 2);
  assert.strictEqual(calls.notify[1].opts.urgency, 'high', 'a security fix is urgent');
});

test('per device: one that failed is tried again, the others are not; a device added later gets it too', async () => {
  const { uc, h, calls } = harness();
  h.devices = { d1: true, d2: false };
  await uc.check();
  assert.deepStrictEqual(calls.notify[0].ids, ['d1', 'd2']);
  await uc.check();
  assert.deepStrictEqual(calls.notify[1].ids, ['d2'], 'only the device that missed it');
  h.devices = { d1: true, d2: true, d3: true };
  await uc.check();
  assert.deepStrictEqual(calls.notify[2].ids, ['d2', 'd3'], 'the retry and the new phone');
  await uc.check();
  assert.strictEqual(calls.notify.length, 3, 'everyone has it now');
  h.result = { ...h.result, remote: 'r2' };
  await uc.check();
  assert.deepStrictEqual(calls.notify[3].ids, ['d1', 'd2', 'd3'], 'a newer version goes to every device again');
});

test('status: available with the headline and notes; Later hides it for that admin, that version, one day', async () => {
  const { uc, h, tick } = harness();
  await uc.check();
  let s = await uc.status(admin);
  assert.strictEqual(s.available, true);
  assert.strictEqual(s.headline, 'My Maestro AI 1.1.0 is ready');
  assert.deepStrictEqual(s.titles, ['A', 'B', 'C']);
  assert.strictEqual(s.snoozed, false);
  assert.strictEqual((await uc.later(admin)).snoozed, false, 'Later must name the version it hides');
  s = await uc.later(admin, 'r1');
  assert.strictEqual(s.snoozed, true);
  assert.strictEqual((await uc.status(admin2)).snoozed, false, 'another admin still sees it');
  tick(LATER_MS - 1000);
  assert.strictEqual((await uc.status(admin)).snoozed, true);
  tick(2000);
  assert.strictEqual((await uc.status(admin)).snoozed, false, 'back after a day');
  await uc.later(admin, 'r1');
  h.result = { ...h.result, remote: 'r2', latestVersion: '1.2.0' };
  await uc.check();
  assert.strictEqual((await uc.status(admin)).snoozed, false, 'a newer version shows at once');
  assert.strictEqual((await uc.later(admin, 'r1')).snoozed, false, 'Later for the card of an older version does not hide the newer one');
  assert.strictEqual((await uc.later(admin, 'r2')).snoozed, true);
});

test('after an update moved the code, the old result is not shown and a new check follows', async () => {
  const { uc, h, tick } = harness();
  await uc.check();
  h.headValue = 'h2';
  tick(11 * 1000);   // past the 10 s cache of the current commit
  const s = await uc.status(admin);
  assert.strictEqual(s.available, false);
  assert.strictEqual(s.stale, true);
});

test('blocked when this install has its own commits; experimental changes without a version say how many', async () => {
  const { uc, h } = harness();
  h.result = { ...h.result, branch: 'dev', channel: 'experimental', ahead: 3, latestVersion: '1.0.0' };
  await uc.check();
  const s = await uc.status(admin);
  assert.strictEqual(s.available, true);
  assert.strictEqual(s.blocked, true);
  assert.strictEqual(s.headline, '2 new changes on experimental');
  assert.strictEqual(headline({ behind: 1, channel: 'experimental' }), '1 new change on experimental');
  h.result = { ...h.result, ahead: 0, dirty: 2, remote: 'r9' };
  await uc.check();
  const d = await uc.status(admin);
  assert.strictEqual(d.blocked, true, 'uncommitted changes block Update now too');
  assert.strictEqual(d.dirty, 2);
  assert.strictEqual(d.remote, 'r9');
});

test('switched off: no push, no schedule; the Settings "Check now" still looks', async () => {
  const { uc, h, calls } = harness();
  h.settings = { enabled: false };
  assert.strictEqual(uc.start(), false);
  await uc.check();
  assert.strictEqual(calls.peek, 1);
  assert.strictEqual(calls.notify.length, 0);
  assert.strictEqual((await uc.status(admin)).enabled, false);
});

test('stays out of a running update; a failed check keeps the last result and reports the error', async () => {
  const { uc, h, calls } = harness();
  h.running = true;
  await uc.check();
  assert.strictEqual(calls.peek, 0);
  h.running = false;
  await uc.check();
  h.result = { ok: false, error: 'Could not reach GitHub: timeout' };
  await uc.check();
  const s = await uc.status(admin);
  assert.strictEqual(s.available, true);
  assert.strictEqual(s.error, 'Could not reach GitHub: timeout');
  const before = calls.notify.length;
  h.result = { ok: true, branch: 'main', channel: 'stable', head: 'h1', remote: 'r5', behind: 1, ahead: 0, dirty: 0, titles: [], more: 0 };
  h.running = false;
  const realRunning = h.running;
  // An update that starts during the look: nothing is announced.
  let calls2 = 0; const uc2 = harness({ updateRunning: () => (calls2++ > 0) });
  await uc2.uc.check();
  assert.strictEqual(uc2.calls.peek, 1);
  assert.strictEqual(uc2.calls.notify.length, 0, 'no push while an update runs');
  assert.strictEqual(calls.notify.length, before);
  assert.strictEqual(realRunning, false);
});

test('overlapping checks share one look; the state file is private', async () => {
  const { uc, calls, dir } = harness();
  await Promise.all([uc.check(), uc.check(), uc.check()]);
  assert.strictEqual(calls.peek, 1);
  assert.strictEqual(fs.statSync(path.join(dir, 'update-check.json')).mode & 0o777, 0o600);
});

test('schedule: HUB_UPDATE_CHECK_HOURS overrides, 0 turns it off', () => {
  const on = harness({ env: { HUB_UPDATE_CHECK_HOURS: '6' } });
  assert.strictEqual(on.uc.config().hours, 6);
  assert.strictEqual(on.uc.start(), true);
  on.uc.stop();
  const off = harness({ env: { HUB_UPDATE_CHECK_HOURS: '0' } });
  assert.strictEqual(off.uc.start(), false);
  assert.strictEqual(harness().uc.config().hours, 24);
});

test('the update-check routes are admin-only', () => {
  const { classifyRoute } = require('../lib/access');
  for (const p of ['/api/update-check', '/api/update-check/now', '/api/update-check/later', '/api/update-check/settings']) assert.strictEqual(classifyRoute(p, 'GET').kind, 'admin', p);
});
