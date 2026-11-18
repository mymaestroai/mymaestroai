'use strict';
// Codex (the ChatGPT client) lives in ~/.npm-global, outside the Node.js folder the installer replaces: one place to
// install it, find it, repoint a link left pointing into a replaced Node.js, and say plainly when it is missing.
// Everything runs in a temporary home; ~/.codex (Codex's own sign-in) is never read or changed.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const setup = require('../lib/codex-cli/setup');
const codex = require('../lib/codex-cli');

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-setup-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const env = { HOME: home, PATH: '/usr/bin:/bin' };
  return { root, home, data, bin, env, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
// A computer where some codex outside the temporary home is found anyway can't show "missing": those checks are skipped.
const clean = (env) => !codex.resolveBinary(codex.withNode(env));
function placeCodex(home) {
  const dir = path.join(home, '.npm-global', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'codex');
  fs.writeFileSync(f, '#!/bin/sh\necho codex-test\n', { mode: 0o755 });
  return f;
}

test('the prefix is ~/.npm-global; Codex is needed for a codex-cli agent, a codex link (even broken) or a ChatGPT sign-in folder', () => {
  const w = world();
  try {
    assert.strictEqual(setup.codexPrefix(w.env), path.join(w.home, '.npm-global'));
    assert.strictEqual(setup.codexNeeded({ env: w.env, dataDir: w.data, binDirs: [w.bin] }), false);
    fs.writeFileSync(path.join(w.data, 'agents.json'), JSON.stringify([{ name: 'a', model: 'codex-cli/gpt-x' }]));
    assert.strictEqual(setup.codexNeeded({ env: w.env, dataDir: w.data }), true, 'an agent on ChatGPT');
    fs.writeFileSync(path.join(w.data, 'agents.json'), JSON.stringify([{ name: 'a', model: 'claude-sdk/x' }]));
    assert.strictEqual(setup.codexNeeded({ env: w.env, dataDir: w.data }), false);
    fs.symlinkSync(path.join(w.root, 'gone', 'codex'), path.join(w.bin, 'codex'));
    assert.strictEqual(setup.codexNeeded({ env: w.env, dataDir: w.data, binDirs: [w.bin] }), true, 'a codex link left behind');
    fs.unlinkSync(path.join(w.bin, 'codex'));
    fs.mkdirSync(path.join(w.home, '.codex'));
    assert.strictEqual(setup.codexNeeded({ env: w.env, dataDir: w.data }), true, 'a ChatGPT sign-in folder');
  } finally { w.done(); }
});

test('a link left pointing into a replaced Node.js is repointed at ~/.npm-global/bin/codex; a working link or a file is left alone', () => {
  const w = world();
  try {
    const gone = path.join(w.root, 'state', 'node', 'bin', 'codex');
    fs.symlinkSync(gone, path.join(w.bin, 'codex'));
    assert.deepStrictEqual(setup.repairLinks({ env: w.env, binDirs: [w.bin] }), [], 'nothing to point at yet');
    const target = placeCodex(w.home);
    assert.deepStrictEqual(setup.repairLinks({ env: w.env, binDirs: [w.bin] }), [path.join(w.bin, 'codex')]);
    assert.strictEqual(fs.readlinkSync(path.join(w.bin, 'codex')), target);
    // a working link and a real file stay as they are
    const other = path.join(w.root, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'real'), 'x', { mode: 0o755 });
    const ok = path.join(w.root, 'okbin');
    fs.mkdirSync(ok);
    fs.symlinkSync(path.join(other, 'real'), path.join(ok, 'codex'));
    const file = path.join(w.root, 'filebin');
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'codex'), 'mine');
    assert.deepStrictEqual(setup.repairLinks({ env: w.env, binDirs: [ok, file] }), []);
    assert.strictEqual(fs.readlinkSync(path.join(ok, 'codex')), path.join(other, 'real'));
    assert.strictEqual(fs.readFileSync(path.join(file, 'codex'), 'utf8'), 'mine');
  } finally { w.done(); }
});

test('the check: needed and missing reinstalls with repair (then repoints the link), reports the fix without; not needed: no install', (t) => {
  const w = world();
  try {
    if (!clean(w.env)) { t.skip('a codex outside the temporary home is found on this computer'); return; }
    fs.writeFileSync(path.join(w.data, 'agents.json'), JSON.stringify([{ name: 'a', model: 'codex-cli/gpt-x' }]));
    fs.symlinkSync(path.join(w.root, 'state', 'node', 'bin', 'codex'), path.join(w.bin, 'codex'));
    fs.mkdirSync(path.join(w.home, '.codex'));
    fs.writeFileSync(path.join(w.home, '.codex', 'auth.json'), 'sign-in stand-in');
    const before = fs.statSync(path.join(w.home, '.codex', 'auth.json')).mtimeMs;
    let calls = 0;
    const install = ({ env }) => { calls++; const f = placeCodex(env.HOME); return { ok: true, bin: f }; };
    const plain = setup.checkCodex({ env: w.env, dataDir: w.data, binDirs: [w.bin], install });
    assert.deepStrictEqual([plain.needed, plain.bin, plain.installed, plain.fix, calls], [true, null, false, 'mymaestro connect chatgpt', 0], 'no repair: the one command');
    const r = setup.checkCodex({ env: w.env, dataDir: w.data, binDirs: [w.bin], repair: true, install });
    assert.strictEqual(calls, 1);
    assert.strictEqual(r.installed, true);
    assert.ok(r.bin);
    assert.strictEqual(r.fix, null);
    assert.deepStrictEqual(r.relinked, [path.join(w.bin, 'codex')]);
    assert.strictEqual(fs.readFileSync(path.join(w.home, '.codex', 'auth.json'), 'utf8'), 'sign-in stand-in', '~/.codex untouched');
    assert.strictEqual(fs.statSync(path.join(w.home, '.codex', 'auth.json')).mtimeMs, before);
    // not needed: nothing installed, nothing to fix
    const w2 = world();
    try {
      let n = 0;
      const r2 = setup.checkCodex({ env: w2.env, dataDir: w2.data, binDirs: [w2.bin], repair: true, install: () => { n++; return { ok: false }; } });
      assert.deepStrictEqual([r2.needed, r2.fix, n], [false, null, 0]);
    } finally { w2.done(); }
  } finally { w.done(); }
});

test('installCodex runs npm with --prefix ~/.npm-global, -g and --ignore-scripts, then finds the program there', () => {
  const w = world();
  try {
    const npm = path.join(w.root, 'npm');
    const log = path.join(w.root, 'npm.log');
    // a stand-in npm: records its arguments and puts a codex program under --prefix
    fs.writeFileSync(npm, `#!/bin/sh\necho "$@" > "${log}"\nwhile [ $# -gt 0 ]; do if [ "$1" = --prefix ]; then p="$2"; fi; shift; done\nmkdir -p "$p/bin" && printf '#!/bin/sh\\necho codex\\n' > "$p/bin/codex" && chmod 755 "$p/bin/codex"\n`, { mode: 0o755 });
    const r = setup.installCodex({ env: w.env, npm, stdio: 'ignore' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.bin, path.join(w.home, '.npm-global', 'bin', 'codex'));
    const args = fs.readFileSync(log, 'utf8').trim().split(' ');
    for (const a of ['install', '-g', '--prefix', path.join(w.home, '.npm-global'), '@openai/codex', '--ignore-scripts']) assert.ok(args.includes(a), a);
    const failing = path.join(w.root, 'npm-fail');
    fs.writeFileSync(failing, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const w2 = world();
    try { assert.strictEqual(setup.installCodex({ env: w2.env, npm: failing, stdio: 'ignore' }).ok, clean(w2.env) ? false : true); } finally { w2.done(); }
  } finally { w.done(); }
});

test('the hint, connect chatgpt and the installer all go through one place and never say "npm i -g"', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const sdk = read('lib/sdk-chat.js');
  assert.doesNotMatch(sdk, /npm i -g @openai\/codex/);
  assert.match(sdk, /Codex, the ChatGPT client, is not installed on this computer\. In a terminal on this computer run `mymaestro connect chatgpt`/);
  const cli = read('scripts/hub-cli.js');
  assert.match(cli, /setup\.installCodex\(\{ env: process\.env \}\)/, 'connect chatgpt installs through lib/codex-cli/setup');
  assert.match(cli, /'codex-check'\(\) \{/);
  assert.match(cli, /codex-check \[--repair\]/, 'listed in the help');
  const sh = read('install/install.sh');
  assert.match(sh, /\n  keep_codex\n  rm -rf "\$NODE_DIR\.new"/, 'Codex is moved before the old Node.js folder goes');
  assert.match(sh, /install_command\n  check_codex\n  start_hub/);
  assert.match(sh, /codex-check --repair --quiet/);
  assert.doesNotMatch(sh, /\.codex\//, 'the installer never names a path inside ~/.codex');
});
