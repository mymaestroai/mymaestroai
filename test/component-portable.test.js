'use strict';
// The component watch and the Codex update run on Linux and macOS alike: no /proc, no flock, no systemd, no shell
// commands with GNU-only flags. Everything goes through Node's fs and child_process with fixed programs (npm, codex,
// llama-server, git) and argument lists.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILES = ['lib/component-watch.js', 'lib/codex-cli/update.js', 'lib/codex-cli/update-lock.js', 'lib/claude-offered.js', 'lib/codex-cli/setup.js'];
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('component watch and Codex update: nothing Linux-only', () => {
  for (const f of FILES) {
    const src = read(f);
    for (const [what, re] of [
      ['/proc', /['"`]\/proc\b/],
      ['flock', /\bflock\b/],
      ['systemd', /\bsystemctl\b|\bsystemd-run\b|\bjournalctl\b/],
      ['a shell', /\bexecSync\(|shell:\s*true|['"`](?:\/bin\/)?(?:ba)?sh['"`]\s*,\s*\[\s*['"`]-c/],
      ['GNU-only tools and flags', /['"`](?:readlink|stat|cp|mv|rm|sed|du|timeout)['"`]\s*,\s*\[/],
    ]) assert.doesNotMatch(src, re, `${f}: ${what}`);
  }
});

test('the programs started are fixed ones, with argument lists', () => {
  const programs = new Set();
  for (const f of FILES) {
    const src = read(f);
    for (const m of src.matchAll(/\b(?:execFile|spawnChild|spawn)\(\s*([^,\n]+),/g)) programs.add(m[1].trim());
  }
  assert.ok(programs.size >= 4, `found the starts: ${[...programs].join(', ')}`);
  for (const p of programs) assert.match(p, /^(?:'git'|bin|srv\.path|npm)$/, `unexpected program ${p}`);
});
