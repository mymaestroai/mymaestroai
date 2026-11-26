'use strict';
// One "usable client" rule: a client file that exists but is not executable is NOT usable, so installing is allowed, in the page's
// engine and in the CLI's engine alike. Nothing real runs: the installer is a counter, the resolver is a stub, the check is fake.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('claude-signin-usable-iso-', { copy: ['scripts'] });
const S = require(path.join(ISO.inst, 'lib', 'claude-signin'));
const CLI = require(path.join(ISO.inst, 'scripts', 'hub-cli'));

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'claude-signin-usable-'));
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); fs.rmSync(ISO.root, { recursive: true, force: true }); });

const NOEXEC = path.join(TMP, 'claude-noexec');
fs.writeFileSync(NOEXEC, '#!/bin/sh\n', { mode: 0o644 });
const EXEC = path.join(TMP, 'claude-exec');
fs.writeFileSync(EXEC, '#!/bin/sh\n', { mode: 0o755 });
const NOWHERE = { resolveCli: () => null, sdkDir: path.join(TMP, 'no-sdk'), home: path.join(TMP, 'no-home') };

test('existingClient and findClient agree: a non-executable file is not a client, an executable one is', () => {
  const noexec = { resolveCli: () => ({ bin: NOEXEC, source: 'test' }) };
  const exec = { resolveCli: () => ({ bin: EXEC, source: 'test' }) };
  assert.strictEqual(S.existingClient(noexec), null);
  assert.strictEqual(S.findClient({ env: {}, ...NOWHERE, ...noexec }), null);
  assert.strictEqual(S.existingClient(exec).bin, EXEC);
  assert.strictEqual(S.findClient({ env: {}, ...NOWHERE, ...exec }).bin, EXEC);
  assert.strictEqual(S.existingClient({ resolveCli: () => ({ bin: path.join(TMP, 'gone') }) }), null);
});

// The two paths, wired the same way: the same stand-ins for the machine (the loader's resolver, the installer, the check).
function wiredSignin(resolveCli, installs) {
  return {
    ...S,
    findClient: (o) => S.findClient({ ...o, ...NOWHERE, resolveCli }),
    existingClient: () => S.existingClient({ resolveCli }),
    createSignIn: (deps) => S.createSignIn({ ...deps, installClient: async () => { installs.n++; return false; }, resetCli: () => {} }),
  };
}

async function viaPage(resolveCli) {
  const installs = { n: 0 };
  const si = wiredSignin(resolveCli, installs);
  // The page's engine: findClient and existingClient from the same rule (the route builds it through createSignIn).
  const engine = si.createSignIn({ env: () => ({}), findClient: () => si.findClient({ env: {} }), existingClient: () => si.existingClient(), verify: async () => ({ ok: true }), authStatus: async () => ({ loggedIn: true }) });
  await engine.start();
  for (let i = 0; i < 300 && !['failed', 'done'].includes(engine.state().state); i++) await new Promise(r => setTimeout(r, 10));
  return { installs: installs.n, state: engine.state().state, reason: engine.state().reason };
}

async function viaCli(resolveCli) {
  const installs = { n: 0 };
  const cfg = fs.mkdtempSync(path.join(TMP, 'cfg-'));
  const err = [];
  const code = await CLI.connectClaude({
    rootNote: () => null, say() {}, sayErr: (s) => err.push(s), isTTY: true, pollMs: 10,
    hidden: { begin() {}, end() {} }, read: async () => { throw new Error('no code is typed'); },
    env: { PATH: path.join(TMP, 'no-bin'), HOME: cfg, CLAUDE_CONFIG_DIR: cfg },   // no real PATH: a real `claude` there would be found (the guard refuses to run it)
    envFile: path.join(cfg, 'none.env'),
    verify: async () => ({ ok: true }),
    signin: wiredSignin(resolveCli, installs),
  });
  return { installs: installs.n, code, err };
}

test('a client file that exists but is not executable: both the page engine and the CLI path go on to install (and agree)', async () => {
  const resolveCli = () => ({ bin: NOEXEC, source: 'test' });
  const page = await viaPage(resolveCli);
  const cli = await viaCli(resolveCli);
  assert.strictEqual(page.installs, 1, 'the page engine installs');
  assert.strictEqual(cli.installs, 1, 'the CLI engine installs');
  assert.deepStrictEqual([page.state, page.reason], ['failed', 'missing'], 'the stub installer reports failure');
  assert.strictEqual(cli.code, 1);
});

test('an executable client file: neither path installs anything', async () => {
  const resolveCli = () => ({ bin: EXEC, source: 'test' });
  const installs = { n: 0 };
  const si = wiredSignin(resolveCli, installs);
  assert.strictEqual(si.findClient({ env: {} }).bin, EXEC);
  assert.strictEqual(si.existingClient().bin, EXEC);
  assert.strictEqual(installs.n, 0);
});
