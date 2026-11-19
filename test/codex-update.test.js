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
