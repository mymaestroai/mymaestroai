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

test('the prefix is ~/.npm-global; Codex is used for a codex-cli agent, a codex link into the installer\'s Node.js, or a ChatGPT sign-in folder (reported only)', () => {
  const w = world();
  try {
    assert.strictEqual(setup.codexPrefix(w.env), path.join(w.home, '.npm-global'));
    const use = (extra = {}) => setup.codexUse({ env: w.env, dataDir: w.data, binDirs: [w.bin], ...extra });
    assert.deepStrictEqual([use().needed, use().autoInstall], [false, false]);
    fs.writeFileSync(path.join(w.data, 'agents.json'), JSON.stringify([{ name: 'a', model: 'codex-cli/gpt-x' }]));
    assert.deepStrictEqual([use().needed, use().autoInstall, use().agent], [true, true, true], 'an agent on ChatGPT');
    fs.writeFileSync(path.join(w.data, 'agents.json'), JSON.stringify([{ name: 'a', model: 'claude-sdk/x' }]));
    fs.symlinkSync(path.join(w.root, 'elsewhere', 'codex'), path.join(w.bin, 'codex'));
    assert.strictEqual(use().link, false, 'a broken link to somewhere else is the user\'s own');
    fs.unlinkSync(path.join(w.bin, 'codex'));
    fs.symlinkSync(path.join(w.home, '.mymaestroai', 'node', 'bin', 'codex'), path.join(w.bin, 'codex'));
    assert.deepStrictEqual([use().link, use().autoInstall], [true, true], 'a link left by an npm -g in the installer\'s Node.js');
    fs.unlinkSync(path.join(w.bin, 'codex'));
    fs.symlinkSync(path.join(w.root, 'state', 'node', 'bin', 'codex'), path.join(w.bin, 'codex'));
    assert.strictEqual(use({ nodeDirs: [path.join(w.root, 'state', 'node')] }).link, true, 'the Node.js folder from install.json');
    fs.unlinkSync(path.join(w.bin, 'codex'));
    fs.mkdirSync(path.join(w.home, '.codex'));
    assert.deepStrictEqual([use().needed, use().autoInstall, use().signIn], [true, false, true], 'a sign-in folder alone: reported, not installed for');
  } finally { w.done(); }
});

test('only a link left pointing into the installer\'s Node.js is repointed; the user\'s own links, working links, files and a file at any temporary name stay', () => {
  const w = world();
  try {
    const nodeBin = path.join(w.home, '.mymaestroai', 'node', 'bin', 'codex');
    fs.symlinkSync(nodeBin, path.join(w.bin, 'codex'));
    assert.deepStrictEqual(setup.repairLinks({ env: w.env, binDirs: [w.bin] }), [], 'nothing to point at yet');
    const target = placeCodex(w.home);
    fs.writeFileSync(path.join(w.bin, 'codex.mm-new'), 'a file of the user\'s');
    assert.deepStrictEqual(setup.repairLinks({ env: w.env, binDirs: [w.bin] }), [path.join(w.bin, 'codex')]);
    assert.strictEqual(fs.readlinkSync(path.join(w.bin, 'codex')), target);
    assert.strictEqual(fs.readFileSync(path.join(w.bin, 'codex.mm-new'), 'utf8'), 'a file of the user\'s', 'never removed');
    assert.deepStrictEqual(fs.readdirSync(w.bin).sort(), ['codex', 'codex.mm-new'], 'no temporary name left behind');
    // a broken link of the user's own (an unmounted drive), a working link and a real file: untouched
    const own = path.join(w.root, 'own');
    fs.mkdirSync(own);
    fs.symlinkSync('/Volumes/tools/bin/codex', path.join(own, 'codex'));
    const other = path.join(w.root, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'real'), 'x', { mode: 0o755 });
    const ok = path.join(w.root, 'okbin');
    fs.mkdirSync(ok);
    fs.symlinkSync(path.join(other, 'real'), path.join(ok, 'codex'));
    const file = path.join(w.root, 'filebin');
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'codex'), 'mine');
    assert.deepStrictEqual(setup.repairLinks({ env: w.env, binDirs: [own, ok, file] }), []);
    assert.strictEqual(fs.readlinkSync(path.join(own, 'codex')), '/Volumes/tools/bin/codex');
    assert.strictEqual(fs.readlinkSync(path.join(ok, 'codex')), path.join(other, 'real'));
    assert.strictEqual(fs.readFileSync(path.join(file, 'codex'), 'utf8'), 'mine');
  } finally { w.done(); }
});

test('the check: a missing Codex is reinstalled (a release at least a day old) only for an agent or a link left behind; a sign-in folder alone is reported; ~/.codex untouched', (t) => {
  const w = world();
  try {
    if (!clean(w.env)) { t.skip('a codex outside the temporary home is found on this computer'); return; }
    fs.writeFileSync(path.join(w.data, 'agents.json'), JSON.stringify([{ name: 'a', model: 'codex-cli/gpt-x' }]));
    fs.symlinkSync(path.join(w.home, '.mymaestroai', 'node', 'bin', 'codex'), path.join(w.bin, 'codex'));
    fs.mkdirSync(path.join(w.home, '.codex'));
    fs.writeFileSync(path.join(w.home, '.codex', 'auth.json'), 'sign-in stand-in');
    const before = fs.statSync(path.join(w.home, '.codex', 'auth.json')).mtimeMs;
    const calls = [];
    const install = (o) => { calls.push(o); const f = placeCodex(o.env.HOME); return { ok: true, bin: f }; };
    const now = Date.parse('2026-11-17T12:00:00Z');
    const plain = setup.checkCodex({ env: w.env, dataDir: w.data, binDirs: [w.bin], install, now });
    assert.deepStrictEqual([plain.needed, plain.bin, plain.installed, plain.fix, calls.length], [true, null, false, 'mymaestro connect chatgpt', 0], 'no repair: the one command');
    const r = setup.checkCodex({ env: w.env, dataDir: w.data, binDirs: [w.bin], repair: true, install, now });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].before.toISOString(), '2026-11-16T12:00:00.000Z', 'a release at least a day old');
    assert.deepStrictEqual([r.installed, !!r.bin, r.fix, r.inUse], [true, true, null, true]);
    assert.deepStrictEqual(r.relinked, [path.join(w.bin, 'codex')]);
    assert.strictEqual(fs.readFileSync(path.join(w.home, '.codex', 'auth.json'), 'utf8'), 'sign-in stand-in', '~/.codex untouched');
    assert.strictEqual(fs.statSync(path.join(w.home, '.codex', 'auth.json')).mtimeMs, before);
    // a sign-in folder alone (the desktop app, an editor extension): reported, nothing installed
    const w2 = world();
    try {
      fs.mkdirSync(path.join(w2.home, '.codex'));
      let n = 0;
      const r2 = setup.checkCodex({ env: w2.env, dataDir: w2.data, binDirs: [w2.bin], repair: true, install: () => { n++; return { ok: false }; } });
      assert.deepStrictEqual([r2.needed, r2.inUse, r2.fix, n], [true, false, 'mymaestro connect chatgpt', 0], 'a hint, not a fault');
    } finally { w2.done(); }
    // npm's own link left dangling in ~/.npm-global/bin is cleared first (it would make npm fail with EEXIST)
    const w3 = world();
    try {
      fs.writeFileSync(path.join(w3.data, 'agents.json'), JSON.stringify([{ name: 'a', model: 'codex-cli/gpt-x' }]));
      fs.mkdirSync(path.join(w3.home, '.npm-global', 'bin'), { recursive: true });
      fs.symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', path.join(w3.home, '.npm-global', 'bin', 'codex'));
      let sawLink = null;
      setup.checkCodex({ env: w3.env, dataDir: w3.data, repair: true, install: () => { try { fs.lstatSync(path.join(w3.home, '.npm-global', 'bin', 'codex')); sawLink = true; } catch { sawLink = false; } return { ok: false }; } });
      assert.strictEqual(sawLink, false);
    } finally { w3.done(); }
  } finally { w.done(); }
});

// Review r3 (GPT-5.6 BLOCK): an installer run that stopped after the move but before linking bin/codex left the
// package in ~/.npm-global with nothing to start it; the check restores the link from the package, offline.
test('the check with repair links ~/.npm-global/bin/codex to a package already there, offline; it never replaces anything at that name', (t) => {
  const w = world();
  try {
    if (!clean(w.env)) { t.skip('a codex outside the temporary home is found on this computer'); return; }
    fs.writeFileSync(path.join(w.data, 'agents.json'), JSON.stringify([{ name: 'a', model: 'codex-cli/gpt-x' }]));
    const pkg = path.join(w.home, '.npm-global', 'lib', 'node_modules', '@openai', 'codex');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
    fs.writeFileSync(path.join(pkg, 'bin', 'codex.js'), '#!/bin/sh\necho codex-saved\n', { mode: 0o755 });
    const link = path.join(w.home, '.npm-global', 'bin', 'codex');
    let n = 0;
    const install = () => { n++; return { ok: false }; };
    const plain = setup.checkCodex({ env: w.env, dataDir: w.data, binDirs: [w.bin], install });
    assert.strictEqual(plain.bin, null, 'no repair: nothing made');
    assert.throws(() => fs.lstatSync(link));
    const r = setup.checkCodex({ env: w.env, dataDir: w.data, binDirs: [w.bin], repair: true, install });
    assert.strictEqual(fs.readlinkSync(link), path.join('..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'linked as npm links it');
    assert.deepStrictEqual([!!r.bin, r.installed, r.fix, n], [true, false, null, 0], 'found without a download');
    assert.strictEqual(setup.ensurePrefixLink(w.env), false, 'a name already there is left alone');
    // a bin entry that leaves the package, or names a missing file: no link
    fs.unlinkSync(link);
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { codex: '../../../../../elsewhere' } }));
    assert.strictEqual(setup.ensurePrefixLink(w.env), false);
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { codex: 'bin/missing.js' } }));
    assert.strictEqual(setup.ensurePrefixLink(w.env), false);
    assert.throws(() => fs.lstatSync(link));
  } finally { w.done(); }
});

test('installCodex runs npm with --prefix ~/.npm-global, -g and --ignore-scripts, then finds the program there', () => {
  const w = world();
  try {
    const npm = path.join(w.root, 'npm');
    const log = path.join(w.root, 'npm.log');
    // a stand-in npm: records its arguments and puts a codex program under --prefix
    fs.writeFileSync(npm, `#!/bin/sh\necho "$@" > "${log}"\nwhile [ $# -gt 0 ]; do if [ "$1" = --prefix ]; then p="$2"; fi; shift; done\nmkdir -p "$p/bin" && printf '#!/bin/sh\\necho codex\\n' > "$p/bin/codex" && chmod 755 "$p/bin/codex"\n`, { mode: 0o755 });
    const r = setup.installCodex({ env: w.env, npm, stdio: 'ignore', before: new Date('2026-11-16T12:00:00Z') });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.bin, path.join(w.home, '.npm-global', 'bin', 'codex'));
    const args = fs.readFileSync(log, 'utf8').trim().split(' ');
    for (const a of ['install', '-g', '--prefix', path.join(w.home, '.npm-global'), '@openai/codex', '--ignore-scripts', '--before=2026-11-16T12:00:00.000Z']) assert.ok(args.includes(a), a);
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
  assert.match(sh, /\n  keep_codex \|\| die "Codex \(the ChatGPT client\) could not be moved[^\n]*\n  rm -rf "\$NODE_DIR\.new"/, 'Codex is moved before the old Node.js folder goes, and a failure stops the swap');
  assert.match(sh, /install_command\n  check_codex\n  start_hub/);
  assert.match(sh, /codex-check --repair --quiet/);
  assert.doesNotMatch(sh, /\.codex\//, 'the installer never names a path inside ~/.codex');
});
