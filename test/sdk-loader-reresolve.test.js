'use strict';
// The client the loader resolved can vanish (an installer moved or removed it): the next call must not hand the SDK a path that
// is gone. Isolated: the pin and the npm prefix point at temp folders, never at a real install.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const L = require('../lib/sdk-loader');

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sdk-reresolve-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// A fake @anthropic-ai/claude-code package folder with a bin/claude.exe.
function fakeClient(name, version = '2.1.999') {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: L.CLI_PKG, version, bin: { claude: 'bin/claude.exe' } }));
  fs.writeFileSync(path.join(dir, 'bin', 'claude.exe'), '#!/bin/sh\n');
  return { dir, bin: path.join(dir, 'bin', 'claude.exe') };
}

// No npm lookup (no `npm root -g`): an empty prefix of our own; no pin unless the test sets one.
function isolate(t) {
  const saved = { prefix: process.env.npm_config_prefix, pin: process.env.CLAUDE_CLI_PATH, log: console.log };
  const lines = [];
  process.env.npm_config_prefix = path.join(ROOT, 'empty-prefix');
  delete process.env.CLAUDE_CLI_PATH;
  console.log = (...a) => lines.push(a.join(' '));
  L.resetCli();
  t.after(() => {
    console.log = saved.log;
    if (saved.prefix === undefined) delete process.env.npm_config_prefix; else process.env.npm_config_prefix = saved.prefix;
    if (saved.pin === undefined) delete process.env.CLAUDE_CLI_PATH; else process.env.CLAUDE_CLI_PATH = saved.pin;
    L.resetCli();
  });
  return lines;
}

test('a resolved client that is deleted: cliOptions() no longer returns its path and falls back to the SDK\'s own client ({})', (t) => {
  const lines = isolate(t);
  const a = fakeClient('pinned-a');
  process.env.CLAUDE_CLI_PATH = a.bin;
  assert.deepStrictEqual(L.cliOptions(), { pathToClaudeCodeExecutable: a.bin });
  assert.strictEqual(L.resolveCli().bin, a.bin);
  fs.rmSync(a.dir, { recursive: true, force: true });
  delete process.env.CLAUDE_CLI_PATH;
  assert.deepStrictEqual(L.cliOptions(), {});
  assert.strictEqual(L.resolveCli(), null);
  assert.strictEqual(lines.filter(l => l.includes('is gone')).length, 1, 'one line for the change: ' + lines.join(' | '));
  assert.ok(lines.some(l => l.includes(a.bin) && /using the SDK's own/.test(l)));
  // stable afterwards: no second line, still the SDK's own
  assert.deepStrictEqual(L.cliOptions(), {});
  assert.strictEqual(lines.filter(l => l.includes('is gone')).length, 1);
});

test('a resolved client that is deleted: the next candidate in the same order is used', (t) => {
  const lines = isolate(t);
  // The sealed guard makes the npm prefix invisible to the loader; this test is about the npm-global candidate, so the loader's own
  // check is answered true here (only the loader reads it; the prefix is a temp folder, so npm is never asked).
  const guard = require('../lib/claude-signin-guard');
  const savedReal = guard.realAllowed;
  guard.realAllowed = () => true;
  t.after(() => { guard.realAllowed = savedReal; });
  const pinned = fakeClient('pinned-b');
  const npm = path.join(ROOT, 'empty-prefix', 'lib', 'node_modules', L.CLI_PKG);
  fs.mkdirSync(path.join(npm, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(npm, 'package.json'), JSON.stringify({ name: L.CLI_PKG, version: '2.1.999', bin: { claude: 'bin/claude.exe' } }));
  fs.writeFileSync(path.join(npm, 'bin', 'claude.exe'), '#!/bin/sh\n');
  process.env.CLAUDE_CLI_PATH = pinned.bin;
  assert.strictEqual(L.cliOptions().pathToClaudeCodeExecutable, pinned.bin);
  fs.rmSync(pinned.dir, { recursive: true, force: true });
  assert.strictEqual(L.cliOptions().pathToClaudeCodeExecutable, path.join(npm, 'bin', 'claude.exe'));
  assert.ok(lines.some(l => l.includes('is gone') && l.includes(pinned.bin) && l.includes(path.join(npm, 'bin', 'claude.exe'))), lines.join(' | '));
  fs.rmSync(npm, { recursive: true, force: true });
});

test('resetCli() drops the cache: a client that appears after it is found', (t) => {
  isolate(t);
  assert.deepStrictEqual(L.cliOptions(), {}, 'nothing external: the SDK\'s own');
  const c = fakeClient('pinned-c');
  process.env.CLAUDE_CLI_PATH = c.bin;
  assert.deepStrictEqual(L.cliOptions(), {}, 'the empty answer is cached');
  L.resetCli();
  assert.deepStrictEqual(L.cliOptions(), { pathToClaudeCodeExecutable: c.bin });
});
