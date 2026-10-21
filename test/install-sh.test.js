'use strict';
// install/install.sh (the one-line installer) and scripts/tailscale-setup.sh: syntax, a dry run that changes nothing,
// pinned Node checksums, private-preview access, and the safety rules the design asked for.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SH = path.join(__dirname, '..', 'install', 'install.sh');
const src = fs.readFileSync(SH, 'utf8');

test('both scripts parse with bash', () => {
  execFileSync('bash', ['-n', SH]);
  execFileSync('bash', ['-n', path.join(__dirname, '..', 'scripts', 'tailscale-setup.sh')]);
});

test('a dry run prints the plan and the exact downloads, and writes nothing at all', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-dry-'));
  const env = { PATH: process.env.PATH, HOME: path.join(root, 'home'), MM_STATE_DIR: path.join(root, 'state'), MM_BIN_DIR: path.join(root, 'bin'), SHELL: '/bin/bash' };
  fs.mkdirSync(env.HOME);
  const r = spawnSync('bash', [SH, '--dry-run', '--yes', '--no-open', '--dir', path.join(root, 'app'), '--repo', '/nonexistent/repo.git'], { env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /would download https:\/\/nodejs\.org\/dist\/v22\.23\.4\/node-v22\.23\.4-(linux|darwin)-(x64|arm64)\.tar\.gz and check SHA-256 [0-9a-f]{64}/);
  assert.match(r.stdout, /would run: git_cred clone --quiet --branch main \/nonexistent\/repo\.git /);
  assert.match(r.stdout, /Dry run finished: nothing was changed\./);
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['home'], 'no state folder, no bin, no app');
  assert.deepStrictEqual(fs.readdirSync(env.HOME), [], 'nothing in the home folder');
});

test('Node is pinned with a SHA-256 per platform and verified before use; nothing runs as root', () => {
  for (const p of ['darwin_arm64', 'darwin_x64', 'linux_arm64', 'linux_x64']) assert.match(src, new RegExp(`^NODE_SHA_${p}="[0-9a-f]{64}"$`, 'm'), p);
  assert.match(src, /\[ "\$got" = "\$expected" \] \|\| die "The Node\.js download did not match its published checksum/);
  assert.match(src, /if \[ "\$\(id -u\)" = 0 \]; then die "Run the installer as your normal user, not as root or with sudo\."; fi/);
  assert.ok(!/\bsudo [a-z]/.test(src.replace(/(info|say|die|warn)\s+"[^"]*"/g, '').replace(/printf[^\n]*/g, '')), 'the installer never runs sudo itself (it only tells the user)');
});

test('the private preview: public download first, then the user\'s SSH key, then a read-only token kept in a 0600 file, never in the URL', () => {
  assert.match(src, /GIT_TERMINAL_PROMPT=0 git ls-remote "\$REPO_HTTPS" HEAD/);
  assert.match(src, /GIT_SSH_COMMAND="ssh -o BatchMode=yes[^"]*" git ls-remote "\$REPO_SSH" HEAD/);
  assert.match(src, /stty -echo < \/dev\/tty/, 'the token is not echoed');
  assert.match(src, /printf 'https:\/\/x-access-token:%s@github\.com\\n' "\$token" > "\$CRED_FILE"; chmod 600 "\$CRED_FILE"/);
  assert.match(src, /git -C "\$DIR" config credential\.helper "store --file=\$CRED_FILE"/, 'updates keep working');
  assert.ok(!/clone[^\n]*x-access-token/.test(src), 'the token never goes into a clone URL');
});

test('safe defaults: umask 077, data/ 0700, .env 0600, an existing different project refused, local edits refused', () => {
  assert.match(src, /^umask 077$/m);
  assert.match(src, /mkdir -p "\$DIR\/data" && chmod 700 "\$DIR\/data"/);
  assert.match(src, /chmod 600 "\$DIR\/\.env"/);
  assert.match(src, /already holds a different git project/);
  assert.match(src, /has local code changes/);
  assert.match(src, /^main "\$@"$/m, 'a truncated download runs nothing (everything is inside main)');
  assert.match(src, /setup-link --plain/, 'opens the Welcome page with the setup code');
});

test('the Tailscale helper works on Linux and Mac, and restarts through the service', () => {
  const ts = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'tailscale-setup.sh'), 'utf8');
  assert.ok(!ts.includes("sed -i ''"), 'no BSD-only sed');
  assert.match(ts, /curl -fsSL https:\/\/tailscale\.com\/install\.sh \| sh/);
  assert.match(ts, /sudo tailscale set --operator=\$USER/);
  assert.match(ts, /"\$NODE" scripts\/hub-cli\.js restart/);
});

test('the installer says whether Claude Code is here and signed in (the Welcome page then proves it)', () => {
  const src = fs.readFileSync(SH, 'utf8');
  assert.ok(src.includes('security find-generic-password -s "Claude Code-credentials"'), 'the same Keychain entry the hub reads on a Mac');
  const run = (setup) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-claude-'));
    const home = path.join(root, 'home'); fs.mkdirSync(home);
    setup(home);
    const env = { PATH: '/usr/bin:/bin', HOME: home, MM_STATE_DIR: path.join(root, 'state'), MM_BIN_DIR: path.join(root, 'bin'), SHELL: '/bin/bash' };
    const r = spawnSync('bash', [SH, '--dry-run', '--yes', '--no-open', '--dir', path.join(root, 'app'), '--repo', '/nonexistent/repo.git'], { env, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    return r.stdout;
  };
  assert.match(run(() => {}), /Claude: Claude Code is not on this computer\./);
  assert.match(run((h) => { fs.mkdirSync(path.join(h, '.claude')); fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}'); }), /Claude: Claude Code is on this computer and signed in\./);
  assert.match(run((h) => { fs.mkdirSync(path.join(h, '.local', 'bin'), { recursive: true }); fs.writeFileSync(path.join(h, '.local', 'bin', 'claude'), '#!/bin/sh\n'); fs.chmodSync(path.join(h, '.local', 'bin', 'claude'), 0o755); }), /Claude: Claude Code is on this computer but not signed in yet\./);
});
