'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installedCodexVersion, updateCodex } = require('../lib/codex-cli/update');

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-upd-'));
  const dir = path.join(home, '.npm-global', 'lib', 'node_modules', '@openai', 'codex');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.156.1', bin: { codex: 'bin/codex.js' } }));
  fs.writeFileSync(path.join(dir, 'bin', 'codex.js'), '// old');
  return { home, env: { HOME: home, PATH: '' }, dir };
}
const setVersion = (dir, v) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: v }));
const keepOf = (dir) => path.join(path.dirname(dir), '.codex-previous');

test('installedCodexVersion reads the package or gives null', () => {
  const { home, env } = mkHome();
  assert.equal(installedCodexVersion({ env }), '0.156.1');
  assert.equal(installedCodexVersion({ env: { HOME: path.join(home, 'nope') } }), null);
});

test('success keeps the copy and reports from and to', async () => {
  const { env, dir } = mkHome();
  let got;
  const install = (o) => { got = o; setVersion(dir, '0.166.0'); return { ok: true }; };
  const before = new Date('2026-01-01T00:00:00Z');
  const r = await updateCodex({ env, before, install, selfCheck: async () => true });
  assert.deepEqual(r, { ok: true, from: '0.156.1', to: '0.166.0', rolledBack: false, error: null });
  assert.equal(got.before, before);
  assert.equal(got.stdio, 'pipe');
  assert.equal(JSON.parse(fs.readFileSync(path.join(keepOf(dir), 'package.json'), 'utf8')).version, '0.156.1');
});

test('a failing self-check puts the old version back', async () => {
  const { env, dir } = mkHome();
  let checks = 0;
  const install = () => { setVersion(dir, '0.170.0'); fs.writeFileSync(path.join(dir, 'new-file'), 'x'); return { ok: true }; };
  const selfCheck = async () => { checks++; return checks > 1; };   // fails after the install, passes after the rollback
  const r = await updateCodex({ env, install, selfCheck });
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, true);
  assert.equal(r.from, '0.156.1');
  assert.equal(r.to, '0.170.0');
  assert.equal(r.error, 'The new Codex 0.170.0 failed its check, so 0.156.1 was put back.');
  assert.equal(installedCodexVersion({ env }), '0.156.1');
  assert.equal(fs.existsSync(path.join(dir, 'new-file')), false);
  assert.equal(fs.existsSync(keepOf(dir)), false);
  assert.equal(checks, 2);
});

test('an install that throws is rolled back too, and nothing throws', async () => {
  const { env, dir } = mkHome();
  const install = () => { fs.rmSync(dir, { recursive: true, force: true }); throw new Error('npm exploded'); };
  const r = await updateCodex({ env, install, selfCheck: async () => true });
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, true);
  assert.equal(installedCodexVersion({ env }), '0.156.1');
});

test('when the old one does not work after putting it back, rolledBack is false', async () => {
  const { env, dir } = mkHome();
  const install = () => { setVersion(dir, '0.170.0'); return { ok: true }; };
  const r = await updateCodex({ env, install, selfCheck: async () => false });
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, false);
  assert.equal(installedCodexVersion({ env }), '0.156.1');
  assert.match(r.error, /0\.156\.1/);
});

test('putting back failing is reported plainly', async () => {
  const { env, dir } = mkHome();
  const install = () => { setVersion(dir, '0.170.0'); return { ok: true }; };
  const fsImpl = Object.assign(Object.create(fs), {
    readFileSync: fs.readFileSync, rmSync: fs.rmSync, cpSync: fs.cpSync,
    renameSync() { throw new Error('disk gone'); },
  });
  const r = await updateCodex({ env, install, selfCheck: async () => false, fsImpl });
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, false);
  assert.equal(r.error, 'The new Codex 0.170.0 failed its check, and putting 0.156.1 back failed: disk gone');
});

test('a copy that cannot be made changes nothing', async () => {
  const { env, dir } = mkHome();
  let installed = false;
  const fsImpl = Object.assign(Object.create(fs), {
    readFileSync: fs.readFileSync, rmSync: fs.rmSync, renameSync: fs.renameSync,
    cpSync() { throw new Error('no space'); },
  });
  const r = await updateCodex({ env, install: () => { installed = true; return { ok: true }; }, selfCheck: async () => true, fsImpl });
  assert.deepEqual(r, { ok: false, from: '0.156.1', to: null, rolledBack: false, error: "Couldn't keep a copy of the current Codex, so nothing changed." });
  assert.equal(installed, false);
  assert.equal(installedCodexVersion({ env }), '0.156.1');
  assert.equal(fs.existsSync(path.join(dir, 'bin', 'codex.js')), true);
});

test('not installed is refused and the installer is not run', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-upd-'));
  let ran = false;
  const r = await updateCodex({ env: { HOME: home }, install: () => { ran = true; return { ok: true }; }, selfCheck: async () => true });
  assert.deepEqual(r, { ok: false, from: null, to: null, rolledBack: false, error: 'Codex is not installed here.' });
  assert.equal(ran, false);
});

test('never throws, even when the self-check throws', async () => {
  const { env, dir } = mkHome();
  const install = () => { setVersion(dir, '0.170.0'); return { ok: true }; };
  const r = await updateCodex({ env, install, selfCheck: async () => { throw new Error('boom'); } });
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');
  assert.equal(installedCodexVersion({ env }), '0.156.1');
});

test('lead: the install runs as a child process the hub waits for, without blocking it (npm takes minutes)', async () => {
  const os = require('os');
  const { installCodexAsync } = require('../lib/codex-cli/update');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxa-'));
  const fakeNpm = path.join(dir, 'npm');
  fs.writeFileSync(fakeNpm, '#!/bin/sh\nsleep 0.4\nexit 3\n', { mode: 0o755 });
  let ticks = 0;
  const t = setInterval(() => { ticks++; }, 50);
  const r = await installCodexAsync({ env: { HOME: dir, PATH: '/usr/bin:/bin' }, npm: fakeNpm });
  clearInterval(t);
  assert.equal(r.ok, false);
  assert.equal(r.status, 3);
  assert.ok(ticks >= 4, `the event loop kept running (${ticks} ticks)`);
  const gone = await installCodexAsync({ env: { HOME: dir, PATH: '/usr/bin:/bin' }, npm: path.join(dir, 'no-such-npm') });
  assert.equal(gone.ok, false);
  const quick = await installCodexAsync({ env: { HOME: dir, PATH: '/usr/bin:/bin' }, npm: fakeNpm, timeoutMs: 100 });
  assert.equal(quick.ok, false, 'a hung npm is stopped at the timeout');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── B1: the update lock ──────────────────────────────────────────────────────
const lock = require('../lib/codex-cli/update-lock');
const { recoverCodex, defaultSelfCheck } = require('../lib/codex-cli/update');

test('B1: update-lock begin / end / active, and a second begin is refused', () => {
  assert.equal(lock.active(), false);
  assert.equal(lock.begin(), true);
  assert.equal(lock.active(), true);
  assert.equal(lock.begin(), false);
  lock.end();
  assert.equal(lock.active(), false);
});

test('B1: waitIdle resolves true when the lock ends, true at once when idle, false at its timeout', async () => {
  assert.equal(await lock.waitIdle(50), true);
  assert.equal(lock.begin(), true);
  const t0 = Date.now();
  const p = lock.waitIdle(5000);
  setTimeout(() => lock.end(), 60);
  assert.equal(await p, true);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(lock.begin(), true);
  assert.equal(await lock.waitIdle(80), false);
  assert.equal(lock.active(), true, 'a timeout does not end the update');
  lock.end();
});

test('B1: updateCodex holds the lock for the whole update and releases it on success, failure, rollback and a throw', async () => {
  const seen = [];
  const mk = () => mkHome();
  // success
  let h = mk();
  let r = await updateCodex({ env: h.env, install: () => { seen.push(lock.active()); setVersion(h.dir, '0.166.0'); return { ok: true }; }, selfCheck: async () => { seen.push(lock.active()); return true; } });
  assert.equal(r.ok, true);
  assert.equal(lock.active(), false, 'released after success');
  // failure that rolls back
  h = mk();
  let n = 0;
  r = await updateCodex({ env: h.env, install: () => { setVersion(h.dir, '0.170.0'); return { ok: true }; }, selfCheck: async () => { seen.push(lock.active()); n++; return n > 1; } });
  assert.equal(r.rolledBack, true);
  assert.equal(lock.active(), false, 'released after a rollback');
  // install failure
  h = mk();
  r = await updateCodex({ env: h.env, install: () => ({ ok: false }), selfCheck: async () => true });
  assert.equal(r.ok, false);
  assert.equal(lock.active(), false, 'released after a failed install');
  // a throwing install and a throwing self-check
  h = mk();
  r = await updateCodex({ env: h.env, install: () => { throw new Error('npm exploded'); }, selfCheck: async () => { throw new Error('boom'); } });
  assert.equal(r.ok, false);
  assert.equal(lock.active(), false, 'released after a throw');
  // not installed
  r = await updateCodex({ env: { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'codex-upd-')) }, install: () => ({ ok: true }) });
  assert.equal(r.ok, false);
  assert.equal(lock.active(), false, 'released when Codex is not installed');
  assert.ok(seen.length >= 3 && seen.every(Boolean), 'the lock was held during the install and the checks');
});

test('B1: a second updateCodex while one runs is refused, and the first is not disturbed', async () => {
  const { env, dir } = mkHome();
  let release;
  const gate = new Promise((res) => { release = res; });
  let installs = 0;
  const first = updateCodex({ env, install: async () => { installs++; await gate; setVersion(dir, '0.166.0'); return { ok: true }; }, selfCheck: async () => true });
  assert.equal(lock.active(), true, 'begin() ran before the first await');
  const second = await updateCodex({ env, install: () => { installs++; return { ok: true }; }, selfCheck: async () => true });
  assert.deepEqual(second, { ok: false, from: null, to: null, rolledBack: false, error: 'A Codex update is already running.' });
  assert.equal(lock.active(), true, 'the refused call did not release the lock');
  release();
  const r = await first;
  assert.equal(r.ok, true);
  assert.equal(installs, 1);
  assert.equal(lock.active(), false);
});

// ── B2: recovery ─────────────────────────────────────────────────────────────
const scopeOf = (dir) => path.dirname(dir);
function withKept(h, version = '0.156.1') {
  const keep = keepOf(h.dir);
  fs.mkdirSync(path.join(keep, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(keep, 'package.json'), JSON.stringify({ name: '@openai/codex', version }));
  fs.writeFileSync(path.join(keep, 'bin', 'codex.js'), '// kept');
  return keep;
}

// The marker of an update in progress is the only sign of an interrupted update (review r4).
const markerOf = (dir) => path.join(path.dirname(dir), '.codex-update-in-progress');
const markInProgress = (h) => fs.writeFileSync(markerOf(h.dir), '{"from":"0.156.1"}\n');

test('r4: with the in-progress marker, an interrupted update puts the kept copy back (missing, half-written or unchecked package)', async () => {
  const missing = mkHome();
  withKept(missing);
  markInProgress(missing);
  fs.rmSync(missing.dir, { recursive: true, force: true });
  assert.deepEqual(await recoverCodex({ env: missing.env }), { recovered: true, error: null });
  assert.equal(installedCodexVersion({ env: missing.env }), '0.156.1');
  assert.equal(fs.existsSync(markerOf(missing.dir)), false, 'the marker is removed');

  const half = mkHome();
  withKept(half);
  markInProgress(half);
  fs.writeFileSync(path.join(half.dir, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
  fs.writeFileSync(path.join(half.dir, 'half-written'), 'x');
  assert.equal((await recoverCodex({ env: half.env })).recovered, true);
  assert.equal(installedCodexVersion({ env: half.env }), '0.156.1');
  assert.equal(fs.existsSync(path.join(half.dir, 'half-written')), false);

  // a new release that installed (and even runs) but was never confirmed: still put back (GPT-5.6, r4)
  const unchecked = mkHome();
  withKept(unchecked, '0.150.0');
  markInProgress(unchecked);
  setVersion(unchecked.dir, '0.170.0');
  assert.equal((await recoverCodex({ env: unchecked.env })).recovered, true);
  assert.equal(installedCodexVersion({ env: unchecked.env }), '0.150.0');
  assert.deepEqual(fs.readdirSync(path.dirname(unchecked.dir)).filter((n) => /^codex\.failed-/.test(n)), [], 'the package moved aside is removed');
});

test('r4: without the marker nothing is touched: a working package, an uninstall, a slow start', async () => {
  const good = mkHome();
  const keep = withKept(good, '0.150.0');   // the copy a successful update leaves behind
  assert.deepEqual(await recoverCodex({ env: good.env }), { recovered: false, error: null });
  assert.equal(installedCodexVersion({ env: good.env }), '0.156.1');
  assert.equal(fs.readFileSync(path.join(keep, 'bin', 'codex.js'), 'utf8'), '// kept');

  const uninstalled = mkHome();
  withKept(uninstalled, '0.150.0');
  fs.rmSync(uninstalled.dir, { recursive: true, force: true });   // the owner removed Codex
  assert.equal((await recoverCodex({ env: uninstalled.env })).recovered, false);
  assert.equal(installedCodexVersion({ env: uninstalled.env }), null, 'it stays uninstalled');

  const noKeep = mkHome();   // a marker without a kept copy: the copy never finished, nothing changed; the marker goes
  markInProgress(noKeep);
  assert.equal((await recoverCodex({ env: noKeep.env })).recovered, false);
  assert.equal(fs.existsSync(markerOf(noKeep.dir)), false);
  assert.equal(installedCodexVersion({ env: noKeep.env }), '0.156.1');
});

test('r4: an update leaves no marker behind, on success and on a rollback; a failed put-back keeps the marker for the next start', async () => {
  const ok = mkHome();
  assert.equal((await updateCodex({ env: ok.env, install: () => { setVersion(ok.dir, '0.166.0'); return { ok: true }; }, selfCheck: async () => true })).ok, true);
  assert.equal(fs.existsSync(markerOf(ok.dir)), false);

  const back = mkHome();
  let seenMarker = false;
  const r = await updateCodex({ env: back.env, install: () => { seenMarker = fs.existsSync(markerOf(back.dir)); setVersion(back.dir, '0.166.0'); return { ok: true }; }, selfCheck: async () => installedCodexVersion({ env: back.env }) === '0.156.1' });
  assert.equal(seenMarker, true, 'the marker is there while npm runs');
  assert.equal(r.rolledBack, true);
  assert.equal(installedCodexVersion({ env: back.env }), '0.156.1');
  assert.equal(fs.existsSync(markerOf(back.dir)), false);

  const stuck = mkHome();
  let calls = 0;
  const fsImpl = Object.assign(Object.create(fs), { renameSync(a, b) { calls++; if (String(a).endsWith('.codex-previous')) throw new Error('disk gone'); return fs.renameSync(a, b); } });
  const r2 = await updateCodex({ env: stuck.env, fsImpl, install: () => { setVersion(stuck.dir, '0.166.0'); return { ok: true }; }, selfCheck: async () => false });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /putting 0\.156\.1 back failed/);
  assert.ok(installedCodexVersion({ env: stuck.env }), 'the package moved aside came back: never no package at all');
  assert.equal(fs.existsSync(markerOf(stuck.dir)), true, 'the marker stays, so the next start tries again');
  assert.ok(calls >= 2);
});

test('B2: recoverCodex never throws', async () => {
  const h = mkHome();
  withKept(h);
  markInProgress(h);
  fs.rmSync(h.dir, { recursive: true, force: true });
  const fsImpl = Object.assign(Object.create(fs), { renameSync() { throw new Error('disk gone'); } });
  const r = await recoverCodex({ env: h.env, fsImpl });
  assert.equal(r.recovered, false);
  assert.equal(r.error, 'disk gone');
  assert.equal((await recoverCodex({ env: null })).recovered, false);
});

test('B2: an update that starts after an interrupted one recovers first and keeps the good copy', async () => {
  const h = mkHome();
  const keep = withKept(h, '0.150.0');   // the good copy
  markInProgress(h);
  fs.writeFileSync(path.join(h.dir, 'package.json'), JSON.stringify({ name: '@openai/codex' }));   // the broken, interrupted package
  fs.writeFileSync(path.join(h.dir, 'broken-marker'), 'x');
  const r = await updateCodex({
    env: h.env,
    install: () => { setVersion(h.dir, '0.166.0'); return { ok: true }; }, selfCheck: async () => true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.from, '0.150.0', 'the update started from the recovered good copy');
  assert.equal(r.to, '0.166.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(keep, 'package.json'), 'utf8')).version, '0.150.0');
  assert.equal(fs.existsSync(path.join(keep, 'broken-marker')), false, 'the broken package was never copied over the good one');
});

test('B2: an update with a working package replaces the old kept copy with the current one', async () => {
  const h = mkHome();
  const keep = withKept(h, '0.100.0');
  const r = await updateCodex({
    env: h.env, recoverCheck: async () => true,
    install: () => { setVersion(h.dir, '0.166.0'); return { ok: true }; }, selfCheck: async () => true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.from, '0.156.1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(keep, 'package.json'), 'utf8')).version, '0.156.1');
  assert.ok(scopeOf(h.dir));
});

// ── F1: a signed-out Codex is not rolled back for being signed out ───────────
function fakeCodexEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-bin-'));
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, '#!/bin/sh\necho 1.2.3\n', { mode: 0o755 });
  return { CODEX_CLI_PATH: bin, HOME: dir, PATH: '/usr/bin:/bin' };
}

test('F1: signed out passes on the version alone; signed in needs at least one model; a broken --version fails', async () => {
  const env = fakeCodexEnv();
  const ok = async () => '1.2.3\n';
  let asked = 0;
  assert.equal(await defaultSelfCheck({ env, run: ok, login: async () => ({ loggedIn: false }), models: async () => { asked++; return []; } }), true);
  assert.equal(asked, 0, 'models are not asked for a signed-out Codex');
  assert.equal(await defaultSelfCheck({ env, run: ok, login: async () => ({ loggedIn: true }), models: async () => [{ id: 'm' }] }), true);
  assert.equal(await defaultSelfCheck({ env, run: ok, login: async () => ({ loggedIn: true }), models: async () => [] }), false);
  assert.equal(await defaultSelfCheck({ env, run: async () => null, login: async () => ({ loggedIn: false }), models: async () => [] }), false);
  assert.equal(await defaultSelfCheck({ env, run: async () => 'garbage', login: async () => ({ loggedIn: false }), models: async () => [] }), false);
  // resolveBinary also looks in the usual system folders: only meaningful on a machine with no codex there
  if (!['/usr/local/bin/codex', '/opt/homebrew/bin/codex'].some((p) => fs.existsSync(p))) {
    assert.equal(await defaultSelfCheck({ env: { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cx-none-')), PATH: '' }, run: ok, login: async () => ({ loggedIn: false }), models: async () => [] }), false, 'no binary: fails');
  }
  // the default run works against a real script
  assert.equal(await defaultSelfCheck({ env, login: async () => ({ loggedIn: false }) }), true);
});

// ── F3: the npm timeout waits for npm to stop ────────────────────────────────
test('F3: a timed-out npm that ignores SIGTERM is killed, and the result comes only after it is gone', async () => {
  const { installCodexAsync } = require('../lib/codex-cli/update');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxa-'));
  const pidFile = path.join(dir, 'pid');
  const fakeNpm = path.join(dir, 'npm');
  fs.writeFileSync(fakeNpm, `#!/bin/sh\necho $$ > "${pidFile}"\ntrap '' TERM\nsleep 30\n`, { mode: 0o755 });
  const t0 = Date.now();
  const r = await installCodexAsync({ env: { HOME: dir, PATH: '/usr/bin:/bin' }, npm: fakeNpm, timeoutMs: 300, termGraceMs: 500, killWaitMs: 2000 });
  const took = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.ok(took >= 750, `resolved after the grace period and the kill, not at the timeout (${took} ms)`);
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(pid > 0);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the npm process is gone when the result comes');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F3: an npm that stops on SIGTERM resolves without waiting for the grace period', async () => {
  const { installCodexAsync } = require('../lib/codex-cli/update');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxa-'));
  const fakeNpm = path.join(dir, 'npm');
  fs.writeFileSync(fakeNpm, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const t0 = Date.now();
  const r = await installCodexAsync({ env: { HOME: dir, PATH: '/usr/bin:/bin' }, npm: fakeNpm, timeoutMs: 200, termGraceMs: 5000, killWaitMs: 2000 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 3000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('r5: a recovery that failed stops the update (the kept copy may be the only good one)', async () => {
  const h = mkHome();
  const keep = withKept(h, '0.150.0');
  markInProgress(h);
  let installed = false;
  const r = await updateCodex({ env: h.env, recover: async () => ({ recovered: false, error: 'disk gone' }), install: () => { installed = true; return { ok: true }; }, selfCheck: async () => true });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be finished \(disk gone\), so nothing changed/);
  assert.equal(installed, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(keep, 'package.json'), 'utf8')).version, '0.150.0', 'the kept copy is untouched');
});

test('r5: when the marker cannot be removed after a good update, the kept copy goes, so no later start undoes it', async () => {
  const h = mkHome();
  const marker = markerOf(h.dir);
  const fsImpl = Object.assign(Object.create(fs), { unlinkSync(p) { if (p === marker) throw new Error('EPERM'); return fs.unlinkSync(p); } });
  const r = await updateCodex({ env: h.env, fsImpl, install: () => { setVersion(h.dir, '0.166.0'); return { ok: true }; }, selfCheck: async () => true });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.existsSync(keepOf(h.dir)), false, 'nothing to put back');
  assert.equal((await recoverCodex({ env: h.env })).recovered, false);
  assert.equal(installedCodexVersion({ env: h.env }), '0.166.0', 'the good update stays');
});

test('r6: the kept copy is moved aside in one step, never half deleted; if even that fails it stays whole', async () => {
  // the removal of the moved-aside copy fails part way: the kept copy name is already gone, so nothing half-deleted is restored
  const h = mkHome();
  const marker = markerOf(h.dir);
  const fsImpl = Object.assign(Object.create(fs), {
    unlinkSync(p) { if (p === marker) throw new Error('EPERM'); return fs.unlinkSync(p); },
    rmSync(p, o) { if (/codex\.failed-/.test(String(p))) throw new Error('EBUSY'); return fs.rmSync(p, o); },
  });
  const r = await updateCodex({ env: h.env, fsImpl, install: () => { setVersion(h.dir, '0.166.0'); return { ok: true }; }, selfCheck: async () => true });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(keepOf(h.dir)), false);
  assert.equal((await recoverCodex({ env: h.env })).recovered, false, 'the marker alone restores nothing');
  assert.equal(installedCodexVersion({ env: h.env }), '0.166.0');
  assert.deepEqual(fs.readdirSync(path.dirname(h.dir)).filter((n) => /^codex\.failed-/.test(n)), [], 'the leftover aside copy is cleared by the recovery');

  // marker and rename both fail (a folder that became read-only): the kept copy is left whole, never a partial one
  const ro = mkHome();
  const marker2 = markerOf(ro.dir);
  let renames = 0;
  const fsRo = Object.assign(Object.create(fs), {
    unlinkSync(p) { if (p === marker2) throw new Error('EROFS'); return fs.unlinkSync(p); },
    renameSync(a, b) { if (String(a).endsWith('.codex-previous') && /codex\.failed-/.test(String(b))) { renames++; throw new Error('EROFS'); } return fs.renameSync(a, b); },
  });
  const r2 = await updateCodex({ env: ro.env, fsImpl: fsRo, install: () => { setVersion(ro.dir, '0.166.0'); return { ok: true }; }, selfCheck: async () => true });
  assert.equal(r2.ok, false, 'not reported as done: the next start would put the old version back (review r7)');
  assert.match(r2.error, /The new Codex 0\.166\.0 works, but the update could not be finished .* puts 0\.156\.1 back\./);
  assert.equal(renames, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(keepOf(ro.dir), 'package.json'), 'utf8')).version, '0.156.1', 'the kept copy is whole');
});
