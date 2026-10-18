'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveSdk, resolveCli, cliOptions, compareVersions, PKG, CLI_PKG } = require('../lib/sdk-loader');

// A fake global npm prefix holding @anthropic-ai/claude-code at `version`.
function fakeCliPrefix(version) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-prefix-'));
  const pkgDir = path.join(prefix, 'lib', 'node_modules', CLI_PKG);
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: CLI_PKG, version, bin: { claude: 'bin/claude.exe' } }));
  fs.writeFileSync(path.join(pkgDir, 'bin', 'claude.exe'), '#!/bin/sh\n');
  return { prefix, pkgDir, bin: path.join(pkgDir, 'bin', 'claude.exe') };
}

function withCliPrefix(version, fn) {
  const fake = fakeCliPrefix(version);
  const saved = process.env.npm_config_prefix;
  process.env.npm_config_prefix = fake.prefix;
  try {
    return fn(fake);
  } finally {
    if (saved === undefined) delete process.env.npm_config_prefix; else process.env.npm_config_prefix = saved;
    fs.rmSync(fake.prefix, { recursive: true, force: true });
    resolveSdk({ force: true });
    resolveCli({ force: true });
  }
}

function fakeSdk(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sdk-'));
  const pkgDir = path.join(dir, PKG);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PKG, version, main: 'sdk.mjs' }));
  fs.writeFileSync(path.join(pkgDir, 'sdk.mjs'), 'export const query = () => {};\n');
  return { root: dir, dir: pkgDir };
}

describe('SDK loader', () => {
  it('compares semver correctly', () => {
    assert.ok(compareVersions('0.3.270', '0.3.167') > 0);
    assert.ok(compareVersions('0.2.63', '0.3.0') < 0);
    assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
    assert.strictEqual(compareVersions('0.3.270', '0.3.270'), 0);
    assert.ok(compareVersions('1.0.0-beta.1', '1.0.0') < 0, 'pre-release sorts below release');
  });

  it('resolves to the hub-local copy when it is newest', () => {
    delete process.env.CLAUDE_SDK_PATH;
    const r = resolveSdk({ force: true });
    assert.ok(r.version, 'should find some SDK');
    assert.ok(fs.existsSync(r.entry), 'entry file should exist');
    for (const c of r.candidates) {
      assert.ok(compareVersions(r.version, c.version) >= 0, `${r.version} should be >= ${c.source} ${c.version}`);
    }
  });

  it('the hub\'s own copy wins over a newer copy in the npm global root (review F24: a global install must not replace the code agents run through)', () => {
    // globalNpmRoot() reads <prefix>/lib/node_modules when npm_config_prefix is set
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-prefix-'));
    const pkgDir = path.join(prefix, 'lib', 'node_modules', PKG);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PKG, version: '99.0.0', main: 'sdk.mjs' }));
    fs.writeFileSync(path.join(pkgDir, 'sdk.mjs'), 'export const query = () => {};\n');
    const saved = process.env.npm_config_prefix;
    process.env.npm_config_prefix = prefix;
    delete process.env.CLAUDE_SDK_PATH;
    try {
      const r = resolveSdk({ force: true });
      const global = r.candidates.find(c => c.source === 'npm-global');
      assert.ok(global && global.version === '99.0.0' && global.dir === pkgDir, 'the newer global copy is seen as a candidate');
      assert.strictEqual(r.source, 'hub-local');
      assert.notStrictEqual(r.dir, pkgDir);
    } finally {
      if (saved === undefined) delete process.env.npm_config_prefix; else process.env.npm_config_prefix = saved;
      fs.rmSync(prefix, { recursive: true, force: true });
      resolveSdk({ force: true });
    }
  });

  it('CLAUDE_SDK_PATH overrides version ordering', () => {
    const fake = fakeSdk('0.0.1');
    process.env.CLAUDE_SDK_PATH = fake.dir;
    try {
      const r = resolveSdk({ force: true });
      assert.strictEqual(r.version, '0.0.1');
      assert.strictEqual(r.source, 'CLAUDE_SDK_PATH');
    } finally {
      delete process.env.CLAUDE_SDK_PATH;
      fs.rmSync(fake.root, { recursive: true, force: true });
      resolveSdk({ force: true });
    }
  });

  it('ignores an invalid CLAUDE_SDK_PATH and falls back to newest', () => {
    process.env.CLAUDE_SDK_PATH = '/nonexistent/sdk';
    try {
      const r = resolveSdk({ force: true });
      assert.notStrictEqual(r.source, 'CLAUDE_SDK_PATH');
    } finally {
      delete process.env.CLAUDE_SDK_PATH;
      resolveSdk({ force: true });
    }
  });
});

describe('Claude client resolution', () => {
  it('uses the global claude-code binary when it is at least as new as the embedded one', () => {
    delete process.env.CLAUDE_CLI_PATH;
    withCliPrefix('99.0.0', (fake) => {
      const cli = resolveCli({ force: true });
      assert.ok(cli, 'should resolve a client');
      assert.strictEqual(cli.source, 'npm-global');
      assert.strictEqual(cli.bin, fake.bin);
      assert.deepStrictEqual(cliOptions(), { pathToClaudeCodeExecutable: fake.bin });
    });
  });

  it('refuses a global client older than the one embedded in the SDK', () => {
    delete process.env.CLAUDE_CLI_PATH;
    withCliPrefix('2.0.1', () => {
      // The hub-local SDK is 0.3.N, i.e. an embedded client of 2.1.N.
      const sdk = resolveSdk({ force: true });
      if (!/^0\.3\./.test(sdk.version)) return; // mapping unknown — guard is off by design
      assert.strictEqual(resolveCli({ force: true }), null);
      assert.deepStrictEqual(cliOptions(), {}, 'falls back to the SDK-embedded client');
    });
  });

  it('CLAUDE_CLI_PATH pins a client and bypasses the version guard', () => {
    const fake = fakeCliPrefix('0.0.1');
    process.env.CLAUDE_CLI_PATH = fake.bin;   // pointed at the binary, not the package dir
    try {
      const cli = resolveCli({ force: true });
      assert.ok(cli);
      assert.strictEqual(cli.source, 'CLAUDE_CLI_PATH');
      assert.strictEqual(cli.bin, fake.bin);
      assert.strictEqual(cli.version, '0.0.1');
    } finally {
      delete process.env.CLAUDE_CLI_PATH;
      fs.rmSync(fake.prefix, { recursive: true, force: true });
      resolveCli({ force: true });
    }
  });

  it('resolves to null when no external client is installed', () => {
    delete process.env.CLAUDE_CLI_PATH;
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-prefix-'));
    const saved = process.env.npm_config_prefix;
    process.env.npm_config_prefix = empty;
    try {
      // No global install and (in a release tarball) no hub-local one either.
      const cli = resolveCli({ force: true });
      if (cli) assert.strictEqual(cli.source, 'hub-local', 'only a hub-local copy may match here');
      else assert.deepStrictEqual(cliOptions(), {});
    } finally {
      if (saved === undefined) delete process.env.npm_config_prefix; else process.env.npm_config_prefix = saved;
      fs.rmSync(empty, { recursive: true, force: true });
      resolveCli({ force: true });
    }
  });
});
