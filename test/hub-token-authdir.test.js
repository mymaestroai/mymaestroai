'use strict';
// scripts/hub-token.js: without --data-dir it works on the hub's account folder from the one resolver (lib/auth resolveAuthDir:
// HUB_AUTH_DIR from the install's .env (it overrides the launch environment, as the server loads it), else the environment, a relative value
// taken against the install folder), else the install's data/. An .env that cannot be read stops the command (settings-authdir.test.js R7-2).
// Runs on a throwaway install copy (test/helpers/isolated-install.js); never the real install, .env or data/.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const inst = makeIsolatedInstall('hub-token-ad-', { copy: ['scripts'] });
const SCRIPT = path.join(inst.inst, 'scripts', 'hub-token.js');
const run = (args, env, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env }, cwd: cwd || inst.root, encoding: 'utf8' });
const tmp = (p) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), p));

test('tokens created without --data-dir go to the absolute HUB_AUTH_DIR', () => {
  const dir = tmp('hub-token-auth-');
  try {
    const r = run(['create', '--name', 'authdir-test', '--scopes', 'status'], { HUB_AUTH_DIR: dir });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.ok(fs.readdirSync(dir).length > 0, 'the moved account folder holds the files');
    const l = run(['list'], { HUB_AUTH_DIR: dir });
    assert.match(l.stdout, /authdir-test/);
    // --data-dir still wins
    const other = tmp('hub-token-other-');
    try {
      const l2 = run(['list', '--data-dir', other], { HUB_AUTH_DIR: dir });
      assert.match(l2.stdout, /No tokens/);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a relative HUB_AUTH_DIR is resolved against the install folder, not the current folder, whatever folder the command starts from', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /resolveAuthDir/);
  const a = path.join(inst.root, 'from-a'), b = path.join(inst.root, 'from-b');
  fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
  const store = path.join(inst.inst, 'acct');
  try {
    const r = run(['create', '--name', 'rel-test', '--scopes', 'status'], { HUB_AUTH_DIR: 'acct' }, a);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.ok(fs.existsSync(path.join(store, 'auth.db')), 'the tokens went to <install>/acct');
    assert.ok(!fs.existsSync(path.join(a, 'acct')), 'not to <current folder>/acct');
    const l = run(['list'], { HUB_AUTH_DIR: 'acct' }, b);
    assert.match(l.stdout, /rel-test/, 'another starting folder sees the same store');
  } finally { fs.rmSync(store, { recursive: true, force: true }); }
});

test('HUB_AUTH_DIR only in the install\'s .env is used by hub-token (the same folder the server-side resolver names)', () => {
  const dir = tmp('hub-token-envfile-');
  const envFile = path.join(inst.inst, '.env');
  fs.writeFileSync(envFile, `HUB_AUTH_DIR=${dir}\n`, { mode: 0o600 });
  try {
    const r = run(['create', '--name', 'dotenv-test', '--scopes', 'status'], {});
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.ok(fs.existsSync(path.join(dir, 'auth.db')), 'the tokens went to the .env folder');
    assert.ok(!fs.existsSync(path.join(inst.data, 'auth.db')), 'not to data/');
    const code = `process.stdout.write(require(${JSON.stringify(path.join(inst.lib, 'auth'))}).resolveAuthDir())`;
    const s = spawnSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH, HOME: os.tmpdir() }, cwd: inst.root, encoding: 'utf8' });
    assert.strictEqual(s.stdout, dir, 'the server-side resolver names the same folder');
  } finally { fs.rmSync(envFile, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R7-1: when .env and the environment name different folders, hub-token uses the .env one (the server\'s order)', () => {
  const fromEnvFile = tmp('hub-token-r71-file-'), fromProc = tmp('hub-token-r71-proc-');
  const envFile = path.join(inst.inst, '.env');
  fs.writeFileSync(envFile, `HUB_AUTH_DIR=${fromEnvFile}\n`, { mode: 0o600 });
  try {
    const r = run(['create', '--name', 'r71-tok', '--scopes', 'status'], { HUB_AUTH_DIR: fromProc });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.ok(fs.existsSync(path.join(fromEnvFile, 'auth.db')), 'the .env folder');
    assert.ok(!fs.existsSync(path.join(fromProc, 'auth.db')), 'not the environment folder');
  } finally { fs.rmSync(envFile, { force: true }); fs.rmSync(fromEnvFile, { recursive: true, force: true }); fs.rmSync(fromProc, { recursive: true, force: true }); }
});

test('hub-token marks its own folder: a link to data/ is the same folder (no account/ label), the moved account folder gets account/', () => {
  const link = path.join(inst.root, 'data-link');
  fs.symlinkSync(inst.data, link);
  const mark = (dir) => {
    const code = `const sj=require(${JSON.stringify(path.join(inst.lib, 'settings-journal'))});sj.startCliMarking({dataDir:${JSON.stringify(dir)}});require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'users.json'))},'{"users":[]}')`;
    const r = spawnSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), HUB_AUTH_DIR: acct }, cwd: inst.root, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  };
  const acct = tmp('hub-token-mark-');
  try {
    const journalFile = path.join(inst.data, 'settings-journal.jsonl');
    const markers = () => (fs.existsSync(journalFile) ? fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.marker).map((l) => l.store) : []);
    mark(link);
    assert.deepStrictEqual(markers(), ['files/users.json'], 'the link to data/ is data/: no label');
    mark(acct);
    assert.ok(markers().includes('files/account/users.json'), 'the moved folder is labelled');
    // and the command itself runs on the linked folder
    const r = run(['create', '--name', 'via-link', '--scopes', 'status', '--data-dir', link], {});
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  } finally { fs.rmSync(link, { force: true }); fs.rmSync(acct, { recursive: true, force: true }); }
});
