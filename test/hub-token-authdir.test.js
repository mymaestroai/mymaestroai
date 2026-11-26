'use strict';
// scripts/hub-token.js: without --data-dir it works on the absolute HUB_AUTH_DIR when set, else the install's data/.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'hub-token.js');
const run = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env }, encoding: 'utf8' });

test('tokens created without --data-dir go to the absolute HUB_AUTH_DIR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-token-auth-'));
  try {
    const r = run(['create', '--name', 'authdir-test', '--scopes', 'status'], { HUB_AUTH_DIR: dir });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.ok(fs.readdirSync(dir).length > 0, 'the moved account folder holds the files');
    const l = run(['list'], { HUB_AUTH_DIR: dir });
    assert.match(l.stdout, /authdir-test/);
    // --data-dir still wins
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-token-other-'));
    try {
      const l2 = run(['list', '--data-dir', other], { HUB_AUTH_DIR: dir });
      assert.match(l2.stdout, /No tokens/);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a relative HUB_AUTH_DIR is resolved against the current folder, as lib/auth does (the one resolver)', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /path\.isAbsolute\(a\)/);
  assert.match(src, /resolveAuthDir/);
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-token-rel-'));
  try {
    const env = { PATH: process.env.PATH, HOME: os.tmpdir(), HUB_AUTH_DIR: 'acct' };
    const r = spawnSync(process.execPath, [SCRIPT, 'create', '--name', 'rel-test', '--scopes', 'status'], { cwd: base, env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.ok(fs.existsSync(path.join(base, 'acct', 'auth.db')), 'the tokens went to <current folder>/acct');
    const l = spawnSync(process.execPath, [SCRIPT, 'list'], { cwd: base, env, encoding: 'utf8' });
    assert.match(l.stdout, /rel-test/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
