'use strict';
// Health items for changed code ('code') and for a self-check whose agents couldn't run ('selfcheck'), plus the queued
// run the self-check asks for, the real-git codeChangesIn, and the self-check's afterRun call. Injected deps, fake clock,
// temporary folders (all removed).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createSystemHealth } = require('../lib/system-health');
const { createSelfCheck } = require('../lib/selfcheck');
const { codeChangesIn } = require('../lib/system-health/wire');

const HOUR = 3600000;
const T0 = Date.parse('2026-11-17T12:00:00Z');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'health-code-')));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let seq = 0;

function make(over = {}) {
  const dir = path.join(TMP, `h${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const h = { clock: { now: T0 }, notices: [], code: { ok: true, files: [] }, sc: null, calls: 0 };
  h.sh = createSystemHealth({
    probes: {}, stateFile: path.join(dir, 'system-health.json'), now: () => h.clock.now, zone: () => 'America/New_York',
    settings: () => h.settings, limitMs: 1000,
    codeChanges: async () => { h.calls++; if (h.code instanceof Error) throw h.code; return h.code; },
    selfCheckState: () => h.sc,
    notify: async (payload, opts) => { h.notices.push({ payload, opts }); return { sent: 1 }; },
    ...over,
  });
  return h;
}
const item = (v, id) => v.items.find(i => i.id === id);
const quick = (h) => h.sh.run({ trigger: 'manual', full: false });
const classes = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? { status: v, note: '', actions: {} } : v]));
const errRun = (at = T0) => ({ id: 'sc-1', finishedAt: new Date(at).toISOString(), classes: classes({ lead: { status: 'error', note: "Couldn't run: model unreachable", actions: {} }, host: 'pass' }) });
const passRun = (at = T0) => ({ id: 'sc-2', finishedAt: new Date(at).toISOString(), classes: classes({ lead: 'pass', host: 'pass' }) });

// ── 'code' ──
test('code: changed files are a warning with the first 3 files and "and N more"', async () => {
  const h = make();
  h.code = { ok: true, files: ['a.js', 'lib/b.js', 'c.js', 'd.js', 'e.js'] };
  const it = item(await quick(h), 'health-code');
  assert.strictEqual(it.level, 'warn');
  assert.strictEqual(it.check, 'code');
  assert.strictEqual(it.title, "Your Maestro's own files were changed on this computer: a.js, lib/b.js, c.js (and 2 more)");
  assert.match(it.detail, /^Changed: a\.js, lib\/b\.js, c\.js, d\.js, e\.js\. The next update will stop until they are put aside, and a change like this can break after an update\.$/);
  assert.match(it.fix, /Settings → Update → Put my changes aside \(it is kept in git's stash, not deleted\)/);
});

test('code: three files or fewer have no "and N more"; detail lists at most 10', async () => {
  const h = make();
  h.code = { ok: true, files: ['a.js', 'b.js'] };
  assert.strictEqual(item(await quick(h), 'health-code').title, "Your Maestro's own files were changed on this computer: a.js, b.js");
  h.code = { ok: true, files: Array.from({ length: 13 }, (_, i) => `f${i}.js`) };
  const it = item(await quick(h), 'health-code');
  assert.ok(it.title.endsWith('f0.js, f1.js, f2.js (and 10 more)'));
  assert.ok(it.detail.includes('f9.js') && !it.detail.includes('f10.js'), 'only the first 10 are named');
});

test('code: none is ok, a folder that is not a git checkout is info, a throwing probe is unknown', async () => {
  const h = make();
  let it = item(await quick(h), 'health-code');
  assert.deepStrictEqual([it.level, it.title], ['ok', "Your Maestro's own files are as shipped"]);
  h.code = { ok: true, files: [], notGit: true };
  it = item(await quick(h), 'health-code');
  assert.deepStrictEqual([it.level, it.title], ['info', "This install isn't a git checkout, so changed files can't be checked"]);
  h.code = new Error('git is missing');
  it = item(await quick(h), 'health-code');
  assert.strictEqual(it.level, 'unknown');
  assert.strictEqual(it.title, "Your Maestro's own files couldn't be checked");
  assert.match(it.detail, /git is missing/);
});

test('code: quick runs and full runs both include it', async () => {
  const h = make();
  h.code = { ok: true, files: ['x.js'] };
  await h.sh.run({ trigger: 'manual', full: false });
  assert.strictEqual(h.calls, 1);
  await h.sh.run({ trigger: 'manual', full: true });
  assert.strictEqual(h.calls, 2);
  assert.strictEqual(item(h.sh.view(), 'health-code').level, 'warn');
});

test('code: a warning is pushed only with notify "warnings" after warnNights; a probe failure keeps a known warning', async () => {
  const h = make();
  h.code = { ok: true, files: ['x.js'] };
  await quick(h); await quick(h);
  assert.deepStrictEqual(h.notices, [], 'not with the default (critical only)');
  const w = make();
  w.settings = { notify: 'warnings', warnNights: 2 };
  w.code = { ok: true, files: ['x.js'] };
  await w.sh.run({ trigger: 'nightly', full: true });
  assert.strictEqual(w.notices.length, 0, 'one night is not enough');
  w.clock.now += 24 * HOUR;
  await w.sh.run({ trigger: 'nightly', full: true });
  assert.strictEqual(w.notices.length, 1);
  assert.match(w.notices[0].payload.title, /^Health: Your Maestro's own files were changed/);
  w.code = new Error('timed out');
  w.clock.now += HOUR;
  await quick(w);
  assert.strictEqual(w.notices.length, 1, 'unknown is not "fixed"');
});

// ── 'selfcheck' ──
test('selfcheck: an error class is critical and pushed once; a passing run is ok and "fixed" after the quiet window', async () => {
  const h = make();
  h.sc = errRun();
  let it = item(await quick(h), 'health-selfcheck');
  assert.strictEqual(it.level, 'critical');
  assert.strictEqual(it.title, "Agents couldn't run in the self-check: model unreachable");
  assert.match(it.detail, /^lead agents: model unreachable\. Checked .*\.$/);
  assert.match(it.fix, /^Your agents may not be answering\. Open Settings → Status → Self-check; if a recent change/);
  assert.strictEqual(h.notices.length, 1);
  assert.strictEqual(h.notices[0].payload.title, "Health: Agents couldn't run in the self-check: model unreachable");
  assert.strictEqual(h.notices[0].opts.urgency, 'high');
  await quick(h);
  assert.strictEqual(h.notices.length, 1, 'the same state is not told twice');

  h.sc = passRun();
  h.clock.now += HOUR;
  it = item(await quick(h), 'health-selfcheck');
  assert.deepStrictEqual([it.level, it.title], ['ok', 'The last self-check ran']);
  assert.strictEqual(h.notices.length, 1, 'inside the 6-hour quiet rule: no "fixed" yet');
  h.clock.now += 6 * HOUR;
  await quick(h);
  assert.strictEqual(h.notices.length, 2);
  assert.strictEqual(h.notices[1].payload.title, 'Health: fixed');
  assert.match(h.notices[1].payload.body, /Agents couldn't run in the self-check/);
});

test('selfcheck: names up to 3 classes and falls back to the class key', async () => {
  const h = make();
  const e = (n) => ({ status: 'error', note: `Couldn't run: ${n}`, actions: {} });
  h.sc = { finishedAt: new Date(T0).toISOString(), classes: { lead: e('one'), host: e('two'), weird: e('three'), shared: e('four') } };
  const it = item(await quick(h), 'health-selfcheck');
  assert.ok(it.title.endsWith(': one'));
  assert.ok(it.detail.startsWith('lead agents: one; ordinary agents on this computer: two; weird: three.'));
  assert.ok(!it.detail.includes('four'));
});

test('selfcheck: only fail or skipped classes is ok with no push; no lastRun means no item', async () => {
  const h = make();
  h.sc = { finishedAt: new Date(T0).toISOString(), classes: classes({ lead: 'fail', host: 'skipped' }) };
  const it = item(await quick(h), 'health-selfcheck');
  assert.deepStrictEqual([it.level, it.title], ['ok', 'The last self-check ran']);
  assert.deepStrictEqual(h.notices, []);
  const n = make();
  const v = await quick(n);
  assert.strictEqual(item(v, 'health-selfcheck'), undefined);
  assert.deepStrictEqual(n.notices, []);
});

test('selfcheck: no lastRun does not clear a known problem (not resolvable)', async () => {
  const h = make();
  h.sc = errRun();
  await quick(h);
  h.sc = null;
  h.clock.now += 7 * HOUR;
  await quick(h);
  assert.strictEqual(h.notices.length, 1, 'no "fixed" without an answer');
});

// ── run() queue ──
test('run: a selfcheck run requested while one runs is queued once and runs after it, as a quick run', async () => {
  let release, entered = 0;
  const gate = new Promise(r => { release = r; });
  const h = make({ codeChanges: async () => { entered++; if (entered === 1) await gate; return { ok: true, files: [] }; } });
  const first = h.sh.run({ trigger: 'manual', full: true });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(h.sh.isRunning(), true);
  const a = h.sh.run({ trigger: 'selfcheck', full: false }), b = h.sh.run({ trigger: 'selfcheck', full: false });
  assert.strictEqual(a, first, 'the caller gets the running one');
  assert.strictEqual(b, first);
  release();
  await first;
  for (let i = 0; i < 50 && (entered < 2 || h.sh.isRunning()); i++) await new Promise(r => setImmediate(r));
  assert.strictEqual(entered, 2, 'exactly one more run, not two');
  assert.strictEqual(h.sh.view().lastRun.trigger, 'selfcheck');
  assert.strictEqual(h.sh.view().lastRun.full, false);
});

test('run: with nothing requested meanwhile, no extra run starts', async () => {
  const h = make();
  await h.sh.run({ trigger: 'manual', full: true });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(h.calls, 1);
});

// ── codeChangesIn against a real temporary repo ──
test('codeChangesIn: a clean repo, a changed tracked file, an untracked file ignored, a plain folder', async () => {
  const repo = path.join(TMP, 'repo'); fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=Tester', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'with space.txt'), 'one\n');
  git('add', '.'); git('commit', '-q', '-m', 'first');
  assert.deepStrictEqual(await codeChangesIn(repo), { ok: true, files: [] });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'with space.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
  const r = await codeChangesIn(repo);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.files.sort(), ['a.txt', 'with space.txt']);
  const plain = path.join(TMP, 'plain'); fs.mkdirSync(plain);
  const prevCeil = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = TMP;   // so a git repo above the temp folder can't be found
  try { assert.deepStrictEqual(await codeChangesIn(plain), { ok: true, files: [], notGit: true }); }
  finally { if (prevCeil === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = prevCeil; }
  await assert.rejects(codeChangesIn(path.join(TMP, 'missing-folder')));
});

// ── the self-check's afterRun ──
function minimalSelfCheck(over) {
  const root = path.join(TMP, `sc${++seq}`), hubRoot = path.join(root, 'hub'), hubHome = path.join(root, 'home'), dataDir = path.join(hubRoot, 'data');
  for (const d of [path.join(hubRoot, 'workspaces'), hubHome, dataDir]) fs.mkdirSync(d, { recursive: true });
  return createSelfCheck({ hubRoot, hubHome, dataDir, now: () => T0, settings: () => ({ classes: ['lead'] }), models: async () => [], ...over });
}

test('selfcheck doRun: afterRun is called once per run with the lastRun', async () => {
  const got = [];
  const sc = minimalSelfCheck({ afterRun: (lr) => { got.push(lr); } });
  const a = await sc.run({ trigger: 'manual' });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0], a);
  assert.strictEqual(sc.stored().lastRun.id, a.id, 'the run was recorded before afterRun');
  const b = await sc.run({ trigger: 'manual' });
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[1].id, b.id);
});

test('selfcheck doRun: a throwing afterRun (sync or async) does not break the run, and is logged', async () => {
  for (const boom of [() => { throw new Error('sync boom'); }, async () => { throw new Error('async boom'); }]) {
    const logs = [];
    const sc = minimalSelfCheck({ afterRun: boom, log: (l) => logs.push(l) });
    const lr = await sc.run({ trigger: 'manual' });
    assert.ok(lr && lr.id);
    assert.strictEqual(sc.stored().lastRun.id, lr.id);
    assert.ok(logs.some(l => /afterRun failed: (sync|async) boom/.test(l)), logs.join('|'));
  }
});

test('selfcheck doRun: a halted run does not call afterRun', async () => {
  let n = 0;
  const sc = minimalSelfCheck({ afterRun: () => { n++; }, halted: () => 'halted' });
  await sc.run({ trigger: 'manual' });
  assert.strictEqual(n, 0);
});
